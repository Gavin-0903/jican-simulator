// 服务端配置面板：把 config/*.json 整棵树搬进弹窗，左边导航选文件、中间「定值:变值」逐行、点一下就能改。
//
// 用户原话（m00002）：「帮我修改设置页面，直接把几个json放上去，json前边的是定值，后面的是变值，
//   然后有缩进去除大括号变成折叠，然后用户能修改所有的配置。」
//
// 版面（从左到右）：
//   div.cfg-nav   四个入口：config/default.json / config/llm.json / config/balance.json / 联机连接
//   div.cfg-pane  当前入口的内容：
//     · 文件条目 → div.cfg-row 一行一个键：缩进（depth×18px）+ 折叠箭头 + 点分键（定值）+ 冒号 + 输入框（变值）
//       容器（object/array）不画大括号，只显示「｛…｝」「［…］」当折叠点 —— 这就是「去除大括号变成折叠」。
//     · 联机条目 → 服务器源 / 邀请链接 / 房间信息 / 本机 ID 密钥 / 本机 Token（只读 + 复制）
//
// 数据流：
//   GET  /api/config/json       → { ok, tree:[{path,value,type,depth,hasChildren}], files, warnings }
//                                 没有 files 字段（P1 未落地）或 tree 为空 → 退化成 GET /api/config/json/raw 自己 JSON.parse 建树
//   POST /api/config/json       → body { path, value }（value=null 表示删除该键）；成功 { ok, path, file }
//   GET  /api/config            → 只用来判断「有哪些路径被改过」（override 徽章 / 撤销），失败不影响编辑
//   POST /api/config/reset      → body { section? }，本面板只用「全部恢复默认」
//
// 性能约束：一次 build 成 DocumentFragment，一次性 append；折叠只改行的 hidden，不重建整棵树
//（只有切文件 / 搜索 / 写入成功后才重建）。config/balance.json 展开后有 400+ 行。
//
// CSP 严格：只在 h() 里建 DOM，没有 innerHTML / 内联脚本 / eval。

import { h, icon } from '../util/dom.js';
import { forceEnglishInput } from '../util/ime.js';
import { buildInviteUrl, isInviteToken } from '../net/invite.js';

const TIMEOUT_MS = 8000;
const JSON_TIMEOUT_MS = 15000; // 整棵 JSON 树比单段配置大得多
const INDENT_PX = 18; // 每层缩进
const PAD_LEFT_PX = 10; // 行首基础内边距

/** 左侧导航的四个入口；前三项是 config/ 下的三个文件，最后一项是联机。 */
const ENTRIES = [
  { key: 'default', file: 'config/default.json', short: 'default.json', label: 'config/default.json', iconName: 'settings' },
  { key: 'llm', file: 'config/llm.json', short: 'llm.json', label: 'config/llm.json', iconName: 'sparkle' },
  { key: 'balance', file: 'config/balance.json', short: 'balance.json', label: 'config/balance.json', iconName: 'speed' },
  { key: 'online', file: '', short: '联机连接', label: '联机连接', iconName: 'signal' },
];

/**
 * 首段 → 文件 key。服务端 buildJsonTree 给节点统一带段前缀：
 * default.json → app.*、llm.json → llm.*、balance.json → balance.*
 *（见 server/net/ConfigAdmin.js:415 的注释与 jsonFileKey 的约定）。
 * 早期版本不带 app. 前缀，这里两种都认，免得后端回滚时面板整段消失。
 */
function entryKeyOfPath(path) {
  const head = String(path).split('.')[0];
  if (head === 'llm') return 'llm';
  if (head === 'balance') return 'balance';
  return 'default';
}

/** 树里的 path 带 app. 前缀，但「定值」一栏要显示 default.json 里真实的键（去掉那层包装）。 */
function displayKeyOf(path) {
  const p = String(path);
  return p === 'app' ? 'app' : p.startsWith('app.') ? p.slice(4) : p;
}

/** default.json 的键没有文件名前缀（它就是 app 配置项本身），walk 时用空前缀。 */
const DEFAULT_FILE_ROOT = '';

/** 兜底：没有 tree 时（P1 未落地）把 raw 的 parsed 自己摊平，形状与服务端 jsonTree 完全一致。 */
const RAW_FILE_TO_KEY = {
  'config/default.json': ['default', ''],
  'config/llm.json': ['llm', 'llm'],
  'config/balance.json': ['balance', 'balance'],
};

/** 点路径 → config/*.json 的文件 key（与后端 jsonFileKey 同一套约定）。 */
function jsonFileKeyOf(path) {
  const p = String(path ?? '');
  if (p === 'llm' || p.startsWith('llm.')) return 'llm';
  if (p === 'balance' || p.startsWith('balance.')) return 'balance';
  return 'default';
}

/** 把 /api/config/json 的 files 清单收敛成导航要的形状：[{key, file, label}]。 */
function normalizeFileEntries(files) {
  const out = [];
  for (const f of files) {
    if (typeof f === 'string') {
      const m = String(f).match(/([^/]+)\.json$/);
      out.push({ key: (m ? m[1] : f), file: f, label: f });
      continue;
    }
    if (!f || typeof f !== 'object') continue;
    const file = String(f.file || '');
    const key = String(f.key || (file.match(/([^/]+)\.json$/) || [])[1] || '');
    if (!key) continue;
    out.push({ key, file, label: String(f.label || file || ('config/' + key + '.json')) });
  }
  return out;
}

function jsonTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return t === 'object' ? 'object' : t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : 'string';
}

function walkNode(value, path, depth, out) {
  if (!path) return out; // 顶层就是文件本身，不产出节点（它没有可写的点路径）
  const type = jsonTypeOf(value);
  out.push({
    path,
    value: type === 'object' || type === 'array' ? '' : String(value === null ? 'null' : value),
    type,
    depth,
    hasChildren: type === 'object' || type === 'array',
  });
  if (type === 'object') for (const [k, v] of Object.entries(value)) walkNode(v, path + '.' + k, depth + 1, out);
  else if (type === 'array') value.forEach((v, i) => walkNode(v, path + '.' + i, depth + 1, out));
  return out;
}

/** 带超时的 fetch：任何失败都收敛成 { ok, status, json, error }，绝不抛。 */
async function req(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), timeoutMs);
  try {
    const r = await fetch(url, { cache: 'no-store', ...opts, ...(ctl ? { signal: ctl.signal } : {}) });
    let body = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { ok: r.ok, status: r.status, json: body };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return { ok: false, status: 0, json: null, error: aborted ? '请求超时' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

const OFFLINE_TEXT = '无法连接服务端，请稍后重试';

/** 复制到剪贴板：项目全局拦了 Ctrl+C/V，所以只走按钮点击 + 这个兜底。 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = h('textarea', { value: text, readonly: true });
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const done = document.execCommand('copy');
      ta.remove();
      return Boolean(done);
    } catch {
      return false;
    }
  }
}

function getPath(root, path) {
  let cur = root;
  for (const k of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 把 override 对象摊平成点路径数组。 */
function flattenPaths(obj, prefix = '', out = []) {
  if (obj === null || typeof obj !== 'object') {
    if (prefix) out.push(prefix);
    return out;
  }
  const isArr = Array.isArray(obj);
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? prefix + '.' + k : k;
    if (v !== null && typeof v === 'object' && (isArr || Object.keys(v).length)) flattenPaths(v, p, out);
    else out.push(p);
  }
  return out;
}

/** 容器行的占位符：不画大括号结构，就是「这儿能折」。 */
function containerLabel(type) {
  return type === 'array' ? '［…］' : '｛…｝';
}

export class ConfigPanel {
  constructor(modals, opts = {}) {
    this.modals = modals;
    this.onClose = opts.onClose || null;
    this.onSaved = opts.onSaved || null;

    // ---- 数据 -----------------------------------------------------------------
    this.tree = []; // [{ path, value, type, depth, hasChildren }]，按文件顺序摊平
    this.byFile = { default: [], llm: [], balance: [] }; // key → 该文件的节点（保持顺序）
    this.entryOf = new Map(); // path → 'default' | 'llm' | 'balance'
    this.sampleDirs = [];
    this.sampleDir = '';
    this.warnings = [];
    this.overrides = {}; // section → 覆盖对象（GET /api/config 的 override，失败就是空）
    this.diffPaths = new Set(); // 生效值 ≠ 默认值的点路径（树里带 app. 前缀的那套）
    this.fileEntries = []; // 服务端下发的 files:[{key,file,label}]；空则用内置 ENTRIES
    this.state = 'idle'; // idle | loading | ok | unsupported | fail
    this.error = '';

    // ---- 视图状态 -------------------------------------------------------------
    this.entry = 'default'; // 当前导航项
    this.collapsed = new Set(); // 被折叠的容器 path（默认全展开，只记收起）
    this.query = ''; // 搜索：按点分路径过滤
    this.flash = ''; // 最近一次提示
    this.flashTone = 'ok'; // ok | danger | info
    this.flashTimer = null;
    this.busyPath = ''; // 正在提交的 path（禁用那一行的输入框）
    this.invalid = new Set(); // 类型不合法的 path（红框 + 保留输入）

    // ---- 联机面板 -------------------------------------------------------------
    this.netState = 'idle'; // idle | loading | ok | fail
    this.netError = '';
    this.netInfo = null; // { ok, name, serverSource, idKey, rooms }
    this.netAdmin = null; // GET /api/net/admin（只读事实）
    this.idKeyFull = ''; // 完整 ID 密钥
    this.tokenFull = ''; // 完整 Token（唯一会下发明文的接口）
    this.idKeyPending = false;
    this.tokenPending = false;
    this.copied = ''; // 最近一次复制的键（1.5s 后清空）
    this.copyTimer = null;
    this.inviteUsername = ''; // 「复制邀请链接」用的名字（留空用匿名名）

    // ---- DOM 引用（折叠时只改这些节点的 hidden，不重建） ----------------------
    this.rowsByFile = { default: [], llm: [], balance: [] }; // key → [{node, path, depth, hasChildren, arrow}]
    this.paneHost = null;
    this.navHost = null;
  }

  // ================================================================ 对外入口

  /** 弹窗参数（show 与「恢复默认」重开时共用同一份，保证两次长得一模一样）。 */
  openOpts() {
    return {
      title: '服务端配置',
      sub: '三个 config/*.json 的实时内容：左侧定值（点分键）、右侧变值（可直接编辑），点行首箭头折叠、点取值立刻改',
      icon: 'settings',
      wide: true,
      body: this.buildBody(),
      foot: this.buildFoot(),
      onDismiss: () => this.onClose?.(),
    };
  }

  /** main.js 只调这一个（另加构造函数的 { onSaved }）。签名与老版保持一致。 */
  show(onClose) {
    this.onClose = onClose || this.onClose;
    this.state = this.tree.length ? 'ok' : 'loading';
    this.modals.open('config', this.openOpts());
    // 弹窗默认宽度留给别的设置页用，这里单独加宽（不改 .modal.wide 的全局规则）
    this.modals.current?.card?.classList.add('cfg-modal');
    this.captureHosts();
    this.renderNav();
    this.renderPane();
    void this.reload();
  }

  /** 关掉弹窗（不走 onClose 回调：配置面板在大厅里用，没有「暂停态」要还原）。 */
  close() {
    clearTimeout(this.flashTimer);
    this.modals.close();
  }

  /** 记住当前弹窗里的导航 / 内容容器（每次 setBody 之后都要重新取）。 */
  captureHosts() {
    const card = this.modals.current?.card;
    this.navHost = card?.querySelector('.cfg-nav') || null;
    this.paneHost = card?.querySelector('.cfg-pane') || null;
  }

  // ================================================================ 数据

  /** 重新拉整棵树 + override 徽章数据，然后整块重建右侧。 */
  async reload() {
    if (this.modals.kind !== 'config') return;
    if (!this.paneHost) this.captureHosts(); // setBody 之后 DOM 是新的一批，容器引用要先接上
    this.state = this.tree.length ? 'ok' : 'loading';
    this.error = '';
    this.renderNav();
    if (this.state === 'loading') this.renderPane();

    const [treeRes, cfgRes] = await Promise.all([req('/api/config/json', {}, JSON_TIMEOUT_MS), req('/api/config')]);
    if (this.modals.kind !== 'config') return; // 面板已关：别往别人的弹窗里塞内容
    if (!this.paneHost) this.captureHosts();

    // override 徽章只是锦上添花：拿不到就全都不标「已改」
    this.overrides = cfgRes.ok && cfgRes.json && cfgRes.json.override && typeof cfgRes.json.override === 'object'
      ? cfgRes.json.override
      : {};
    // 面板写的是 config/*.json 本体，override.json 里看不到；「已改」只能靠 differences
    // （生效值 ≠ 样例默认值）来认。differences 的 path 不带段前缀，和树里的 app.xxx 对不上，
    // 所以这里两套都存：完整树 path 与「section.path」。
    this.diffPaths = new Set();
    const diffs = cfgRes.ok && cfgRes.json && Array.isArray(cfgRes.json.differences) ? cfgRes.json.differences : [];
    for (const d of diffs) {
      if (!d || typeof d.path !== 'string') continue;
      const sec = d.section === 'online' ? 'app.online' : d.section === 'app' ? 'app' : d.section;
      if (typeof sec !== 'string') continue;
      const p = sec + '.' + d.path;
      this.diffPaths.add(p);
      this.diffPaths.add(d.section + '.' + d.path);
    }

    let nodes = null;
    if (treeRes.status === 404 || treeRes.status === 501) {
      this.state = 'unsupported';
      this.error = '当前服务端版本不支持读取 config JSON（缺少 /api/config/json）';
    } else if (!treeRes.ok || !treeRes.json || treeRes.json.ok === false) {
      this.state = 'fail';
      this.error = treeRes.status === 0
        ? OFFLINE_TEXT
        : ((treeRes.json && (treeRes.json.error || treeRes.json.message)) || treeRes.error || ('读取失败（HTTP ' + treeRes.status + '）'));
    } else {
      const j = treeRes.json;
      this.sampleDirs = Array.isArray(j.sampleDirs) ? j.sampleDirs.slice() : [];
      this.sampleDir = typeof j.sampleDir === 'string' ? j.sampleDir : '';
      this.warnings = Array.isArray(j.warnings) ? j.warnings.slice() : [];
      if (Array.isArray(j.tree) && j.tree.length) nodes = j.tree;
      // 服务端已经下发 files:[{key,file,label}] 时，导航直接照它生成——后端以后加文件，面板自动跟上
      if (Array.isArray(j.files) && j.files.length) this.fileEntries = normalizeFileEntries(j.files);
    }

    // 退化路径：服务端没给 tree（或 tree 为空）→ 自己拿原文解析出同一形状的树
    if (!nodes) {
      const raw = await req('/api/config/json/raw', {}, JSON_TIMEOUT_MS);
      if (this.modals.kind !== 'config') return;
      if (raw.ok && raw.json && raw.json.ok !== false && raw.json.files) {
        const built = [];
        for (const [rel, info] of Object.entries(raw.json.files)) {
          const map = RAW_FILE_TO_KEY[rel];
          if (!map) continue;
          if (info && info.error) {
            this.warnings.push(rel + '：' + info.error);
            continue;
          }
          const parsed = info && typeof info.parsed === 'object' ? info.parsed : null;
          if (!parsed) continue;
          walkNode(parsed, map[1], 0, built);
        }
        if (built.length) {
          nodes = built;
          this.state = 'ok';
          this.error = '';
          if (!this.sampleDirs.length && typeof raw.json.sampleDir === 'string') this.sampleDirs = [raw.json.sampleDir];
          if (!this.sampleDir) this.sampleDir = String(raw.json.sampleDir || '');
        }
      } else if (this.state === 'ok') {
        this.state = 'fail';
        this.error = raw.status === 0 ? OFFLINE_TEXT : '读取 config JSON 失败（树与原文都不可用）';
      }
    }

    this.tree = nodes || [];
    // 服务端只给了 llm/balance 时，default 段自己从 raw 补一份（否则左侧 default.json 永远空着）
    if (this.tree.length && !this.tree.some((n) => entryKeyOfPath(n.path) === 'default')) {
      await this.ensureDefaultSection();
      if (this.modals.kind !== 'config') return;
    }
    this.reindex();
    // 树拿到了就一定是 ok：上面各分支只在「真的没数据」时才标 error
    if (this.tree.length) {
      this.state = 'ok';
      this.error = '';
    }
    if (this.state === 'ok') this.clearMissingCollapses();
    this.renderNav();
    this.renderPane();
    this.renderFoot();
    if (this.entry === 'online') void this.loadNet();
  }

  /** 建 path → 文件 的索引，并把三个文件的节点各自分好（顺序保持服务端给的顺序）。 */
  reindex() {
    this.byFile = { default: [], llm: [], balance: [] };
    this.entryOf = new Map();
    for (const node of this.tree) {
      const key = entryKeyOfPath(node.path);
      this.entryOf.set(node.path, key);
      (this.byFile[key] || this.byFile.default).push(node);
    }
  }

  /**
   * 兜底：tree 里一个 default 段节点都没有（服务端只给 llm/balance 时），
   * 用 /api/config/json/raw 的 config/default.json 原文自己 walk 一份补上。
   */
  async ensureDefaultSection() {
    const hasDefault = () => this.tree.some((n) => entryKeyOfPath(n.path) === 'default');
    if (hasDefault()) return false;
    const raw = await req('/api/config/json/raw', {}, JSON_TIMEOUT_MS);
    if (!raw.ok || !raw.json || raw.json.ok === false || !raw.json.files) return false;
    const info = raw.json.files['config/default.json'];
    const parsed = info && typeof info.parsed === 'object' ? info.parsed : null;
    if (!parsed) return false;
    // 与后端 buildJsonTree 同形状：整份 default.json 挂在 'app' 这一个容器下，
    // 子键就是 app.server.port / app.tickRate（写入时服务端会替我们剥掉 app. 前缀）。
    const built = [];
    walkNode(parsed, 'app', 0, built);
    if (!built.length) return false;
    // default 段插到最前面（导航里 default 是第一项，顺序要对得上）
    this.tree = built.concat(this.tree.filter((n) => entryKeyOfPath(n.path) !== 'default'));
    return true;
  }

  /** 折叠集合里残留的 path（上一轮 tree 有、这一轮没有）直接清掉。 */
  clearMissingCollapses() {
    if (!this.collapsed.size) return;
    const alive = new Set(this.tree.map((n) => n.path));
    for (const p of [...this.collapsed]) if (!alive.has(p)) this.collapsed.delete(p);
  }

  // ================================================================ 覆盖 / 撤销

  /**
   * path → { sec, rest }。GET /api/config 的 override 段名与配置首段并不一一对应：
   * llm.* / balance.* 各自就是一段，其余全部落在 app 段（且 app 段里保留完整点路径，
   * 因为 default.json 的键就是 app 配置项本身，比如 server.port）。
   */
  sectionOf(path) {
    const p = String(path);
    if (p === 'llm' || p.startsWith('llm.')) return { sec: 'llm', rest: p.slice(4) };
    if (p === 'balance' || p.startsWith('balance.')) return { sec: 'balance', rest: p.slice(8) };
    // default.json 的 online.* 是「嵌在 app 文件里的独立段」，规则与覆盖值都记在 online 段
    if (p === 'app.online' || p.startsWith('app.online.')) return { sec: 'online', rest: p.slice(11) };
    if (p === 'app') return { sec: 'app', rest: '' };
    if (p.startsWith('app.')) return { sec: 'app', rest: p.slice(4) };
    if (p === 'online' || p.startsWith('online.')) return { sec: 'online', rest: p.slice(7) };
    return { sec: 'app', rest: p };
  }

  /**
   * 该 path 是否被 override 改过。
   * 注意：面板写盘走的是 POST /api/config/json → 直接写回 config/*.json 本体，
   * 不经过 override.json，所以 GET /api/config 的 override.app/llm/balance 永远是空对象。
   * 真正能反映「这一项被改过」的是 differences（生效值 ≠ 样例默认值）与 override.online。
   */
  isOverridden(path) {
    const { sec, rest } = this.sectionOf(path);
    if (!rest) return false;
    const ov = this.overrides && this.overrides[sec];
    if (ov !== undefined && getPath(ov, rest) !== undefined) return true;
    const p = String(path);
    if (this.diffPaths instanceof Set && this.diffPaths.has(p)) return true;
    // 兜底：default.json 的节点在树里带 app. 前缀，diffPaths 里两种写法都收，这里再试一次带前缀的
    return this.diffPaths instanceof Set && sec === 'app' && this.diffPaths.has('app.' + p);
  }

  /** 撤销后本地先摘掉徽章（紧接着会整棵重拉，这里只是让点击立刻有反馈）。 */
  clearOverrideLocal(path) {
    const { sec, rest } = this.sectionOf(path);
    const ov = this.overrides && this.overrides[sec];
    if (!ov || typeof ov !== 'object' || !rest) return;
    const keys = String(rest).split('.');
    let cur = ov;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!cur || typeof cur[k] !== 'object') return;
      cur = cur[k];
    }
    if (cur && typeof cur === 'object') delete cur[keys[keys.length - 1]];
  }

  // ================================================================ 提交

  /** 把输入框里的文本按原类型转成 JSON 值；不合法返回 { ok:false, message }。 */
  parseValue(node, text) {
    const t = node.type;
    const raw = String(text);
    if (t === 'number') {
      const s = raw.trim();
      const n = Number(s);
      if (!s || Number.isNaN(n)) return { ok: false, message: '需要一个数字' };
      return { ok: true, value: n };
    }
    if (t === 'boolean') {
      const s = raw.trim().toLowerCase();
      if (s === 'true') return { ok: true, value: true };
      if (s === 'false') return { ok: true, value: false };
      return { ok: false, message: '只能是 true 或 false' };
    }
    if (t === 'null') {
      const s = raw.trim();
      if (s === 'null' || s === '') return { ok: true, value: null };
      return { ok: false, message: '这一项原值是 null；要记点什么就填字符串吧' };
    }
    return { ok: true, value: raw }; // 字符串：空串就是空串
  }

  /**
   * 写一个路径。value === null 表示删除该键（= 撤销 override 回到默认值）。
   * 成功后重拉整棵树（新键可能落在别的文件里），并闪一行绿色提示。
   */
  async commit(node, text, inputEl) {
    if (this.busyPath) return;
    const parsed = this.parseValue(node, text);
    if (!parsed.ok) {
      this.invalid.add(node.path);
      if (inputEl) {
        inputEl.classList.add('cfg-invalid');
        inputEl.title = parsed.message;
      }
      this.setFlash(node.path + '：' + parsed.message, 'danger');
      return;
    }
    // 值没变就不打扰服务端（否则每次失焦都写一遍盘）
    if (String(parsed.value) === String(node.value) && !this.isOverridden(node.path)) {
      this.invalid.delete(node.path);
      inputEl?.classList.remove('cfg-invalid');
      inputEl?.removeAttribute('title');
      return;
    }
    this.busyPath = node.path;
    if (inputEl) inputEl.disabled = true;
    const r = await req('/api/config/json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: node.path, value: parsed.value }),
    }, JSON_TIMEOUT_MS);
    this.busyPath = '';
    if (inputEl && inputEl.isConnected) inputEl.disabled = false;
    if (!r.ok || !r.json || r.json.ok === false) {
      const msg = (r.json && (r.json.message || r.json.error))
        || (Array.isArray(r.json?.errors) && r.json.errors[0]?.message)
        || r.error
        || (r.status ? '写入失败（HTTP ' + r.status + '）' : OFFLINE_TEXT);
      this.setFlash(msg, 'danger');
      if (inputEl) {
        inputEl.classList.add('cfg-invalid');
        inputEl.title = msg;
      }
      return;
    }
    this.invalid.delete(node.path);
    // 服务端返回的 file 就是真实落盘文件（如 'config/default.json'），原样展示，别自己拼
    const file = r.json.file ? String(r.json.file).replace(/\\/g, '/') : '';
    const shown = file || ('config/' + (jsonFileKeyOf(node.path)) + '.json');
    this.setFlash('已写入 ' + shown + '（立即生效）', 'ok');
    this.onSaved?.();
    const path = node.path;
    await this.reload();
    this.flashRow(path);
  }

  /** 撤销覆盖：删除这个键（value=null），服务端随之回落到默认值。 */
  async undo(node) {
    if (this.busyPath) return;
    this.busyPath = node.path;
    this.setFlash('正在撤销 ' + node.path + ' …', 'info');
    const r = await req('/api/config/json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: node.path, value: null }),
    }, JSON_TIMEOUT_MS);
    this.busyPath = '';
    if (!r.ok || !r.json || r.json.ok === false) {
      this.setFlash((r.json && (r.json.message || r.json.error)) || '撤销失败', 'danger');
      return;
    }
    this.clearOverrideLocal(node.path);
    this.setFlash('已撤销 ' + node.path + ' 的改动，恢复默认值', 'ok');
    const path = node.path;
    await this.reload();
    this.flashRow(path);
  }

  setFlash(text, tone = 'ok') {
    this.flash = text;
    this.flashTone = tone;
    clearTimeout(this.flashTimer);
    this.renderFlash();
    this.flashTimer = setTimeout(() => {
      this.flash = '';
      this.renderFlash();
    }, 4000);
  }

  /** 刚刚写成功的那一行闪一下，让用户确认改的确切位置。 */
  flashRow(path) {
    const row = this.paneHost?.querySelector('.cfg-row[data-path="' + cssEscape(path) + '"]');
    if (!row) return;
    row.classList.add('cfg-flash');
    setTimeout(() => row.classList.remove('cfg-flash'), 1200);
  }

  // ================================================================ 渲染：骨架

  buildBody() {
    const nav = h('div.cfg-nav', { role: 'tablist', 'aria-label': '配置文件' });
    const pane = h('div.cfg-pane');
    return [
      h('div.cfg-flashbar', { 'aria-live': 'polite', hidden: true }),
      h('div.cfg-shell', {}, nav, pane),
    ];
  }

  buildFoot() {
    const loading = this.state === 'loading';
    return [
      h('button.btn.ghost', { type: 'button', onclick: () => void this.resetAll(), disabled: this.state !== 'ok' },
        icon('refresh', 'sm'), '全部恢复默认'),
      h('span.spacer'),
      h('button.btn', { type: 'button', onclick: () => void this.reload(), disabled: loading },
        icon('refresh', 'sm'), loading ? '读取中…' : '刷新'),
      h('button.btn.primary', { type: 'button', onclick: () => this.close() }, '关闭'),
    ];
  }

  /** 只替换 body（不碰 head / foot），然后重新抓住新区里的容器。 */
  renderBody() {
    if (this.modals.kind !== 'config') return false;
    const ok = this.modals.setBody('config', this.buildBody());
    if (ok) this.captureHosts();
    return ok;
  }

  renderFlash() {
    const host = this.modals.current?.card?.querySelector('.cfg-flashbar');
    if (!host) return;
    host.replaceChildren();
    if (!this.flash) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.append(h('div.cfg-flash.' + (this.flashTone === 'danger' ? 'danger' : this.flashTone === 'info' ? 'info' : 'ok'), {},
      icon(this.flashTone === 'danger' ? 'warn' : this.flashTone === 'info' ? 'refresh' : 'check', 'sm'),
      h('span', { text: this.flash })));
  }

  renderFoot() {
    const footHost = this.modals.current?.card?.querySelector('.modal-foot');
    if (footHost) footHost.replaceChildren(...this.buildFoot());
  }

  // ================================================================ 渲染：左侧导航

  renderNav() {
    const host = this.navHost || this.modals.current?.card?.querySelector('.cfg-nav');
    if (!host) return;
    this.navHost = host;
    host.replaceChildren(...this.navEntries().map((e) => {
      const active = e.key === this.entry;
      const count = e.key === 'online' ? 0 : this.overrideCountOf(e.key);
      return h('button.cfg-nav-item' + (active ? '.active' : ''), {
        type: 'button',
        role: 'tab',
        'aria-selected': String(active),
        title: e.label,
        onclick: () => this.selectEntry(e.key),
      },
      icon(e.iconName, 'sm'),
      h('span.cfg-nav-name', { text: e.short }),
      count ? h('span.cfg-nav-badge', { text: String(count), title: count + ' 项被改过' }) : null);
    }));
  }

  /**
   * 导航项：服务端下发了 files:[{key,file,label}] 就用它（后端加文件面板自动跟上），
   * 否则退回内置的四个入口（三个文件 + 联机）。
   */
  navEntries() {
    const files = Array.isArray(this.fileEntries) && this.fileEntries.length ? this.fileEntries : null;
    const out = files
      ? files.map((f) => ({
        key: f.key,
        file: f.file,
        short: (String(f.label).match(/([^/]+)$/) || [])[1] || f.label,
        label: f.label,
        iconName: (ENTRIES.find((e) => e.key === f.key) || {}).iconName || 'book',
      }))
      : ENTRIES.filter((e) => e.key !== 'online').map((e) => ({ ...e }));
    out.push(ENTRIES[ENTRIES.length - 1]); // 联机连接永远最后一项
    return out;
  }

  /** 该文件被改过的条数（只数「有改过的标量叶子」，容器不算）。 */
  overrideCountOf(key) {
    const nodes = this.byFile[key] || [];
    if (!nodes.length) return 0;
    let n = 0;
    for (const node of nodes) if (!node.hasChildren && this.isOverridden(node.path)) n++;
    return n;
  }

  selectEntry(key) {
    if (!ENTRIES.some((e) => e.key === key)) return;
    this.entry = key;
    this.query = '';
    this.invalid.clear();
    this.renderNav();
    this.renderPane();
    if (key === 'online') void this.loadNet();
  }

  // ================================================================ 渲染：右侧主区

  /** 整块重建右侧（切文件 / 搜索 / 刷新后走这里）。 */
  renderPane() {
    const host = this.paneHost || this.modals.current?.card?.querySelector('.cfg-pane');
    if (!host) return;
    this.paneHost = host;
    if (this.entry === 'online') {
      host.replaceChildren(...this.buildNetPane());
      return;
    }
    if (this.state === 'loading') {
      host.replaceChildren(h('div.cfg-state', {}, icon('refresh', 'sm'), '正在读取 config/*.json …'));
      return;
    }
    if (this.state !== 'ok') {
      host.replaceChildren(h('div.cfg-state.fail', {},
        icon('warn', 'sm'),
        h('span', { text: this.error || '读取配置失败' }),
        h('button.btn.sm', { type: 'button', onclick: () => void this.reload() }, icon('refresh', 'sm'), '重试')));
      return;
    }
    host.replaceChildren(...this.buildFilePane(this.entry));
  }

  /** 工具栏（文件名 / 可改项数 / 搜索 / 全部折叠 / 全部展开）。 */
  buildToolbar(nodes) {
    const meta = ENTRIES.find((e) => e.key === this.entry) || ENTRIES[0];
    const search = h('input.input.cfg-search', {
      type: 'search',
      placeholder: '按点分键搜索，如 server.port 或 teacher',
      value: this.query,
      'aria-label': '按点分键搜索',
    });
    forceEnglishInput(search);
    search.addEventListener('input', (e) => {
      this.query = String(e.target.value || '').trim();
      this.renderPane();
      // 重建后焦点会丢，这里补回去（否则打第二个字就得重新点）
      const next = this.paneHost?.querySelector('.cfg-search');
      if (next) {
        next.focus();
        try {
          next.setSelectionRange(next.value.length, next.value.length);
        } catch { /* 不支持 setSelectionRange 时忽略 */ }
      }
    });
    const primary = this.primaryContainer(nodes);
    return h('div.cfg-toolbar', {},
      h('div.cfg-toolbar-title', {},
        icon(meta.iconName, 'sm'),
        h('span', { text: meta.label }),
        h('span.cfg-count', { text: nodes.filter((n) => !n.hasChildren).length + ' 个可改项' })),
      h('div.cfg-toolbar-actions', {},
        search,
        h('button.btn.sm', {
          type: 'button',
          title: primary ? '折叠 ' + primary : '没有可折叠的分组',
          disabled: !primary,
          onclick: () => this.collapseAll(nodes),
        }, icon('book', 'sm'), '全部折叠'),
        h('button.btn.sm', {
          type: 'button',
          disabled: !primary,
          onclick: () => this.expandAll(),
        }, icon('check', 'sm'), '全部展开')));
  }

  /** 当前文件里最上层的容器（「全部折叠」只折顶层，点开就能逐层展开）。 */
  primaryContainer(nodes) {
    const top = nodes.find((n) => n.hasChildren && n.depth === 0);
    if (top) return top.path;
    const any = nodes.find((n) => n.hasChildren);
    return any ? any.path : '';
  }

  collapseAll(nodes) {
    const p = this.primaryContainer(nodes);
    if (!p) return;
    this.collapsed.add(p);
    this.applyCollapseState();
  }

  expandAll() {
    this.collapsed.clear();
    this.applyCollapseState();
  }

  /**
   * 折叠只改 DOM 的 hidden：不重建整棵树（400+ 行时重建会让滚动位置乱跳）。
   * 一趟线性扫描，用 hiddenDepth 记住「当前在哪个被折叠容器里」，不用每行往上找祖先。
   */
  applyCollapseState() {
    const rows = this.rowsByFile[this.entry] || [];
    let hiddenDepth = null;
    for (const row of rows) {
      if (hiddenDepth !== null && row.depth > hiddenDepth) {
        row.node.hidden = true;
        continue;
      }
      hiddenDepth = null;
      row.node.hidden = false;
      if (!row.hasChildren) continue;
      const open = !this.collapsed.has(row.path);
      row.node.classList.toggle('cfg-collapsed', !open);
      row.arrow?.setAttribute('data-open', open ? '1' : '0');
      row.arrow?.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) hiddenDepth = row.depth;
    }
  }

  /** 单个容器行 toggle：改状态后整体重算一趟（仍是 O(n)，且不重建 DOM）。 */
  toggleCollapse(path) {
    if (this.collapsed.has(path)) this.collapsed.delete(path);
    else this.collapsed.add(path);
    this.applyCollapseState();
  }

  /** 一个文件的完整面板：工具栏 + 行列表（DocumentFragment 一次 append）。 */
  buildFilePane(key) {
    const out = [];
    const all = this.byFile[key] || [];
    const q = this.query.toLowerCase();
    let nodes = all;
    if (q) {
      // 搜索：命中行 + 它的所有祖先链（祖先必须留着，否则命中行藏在折叠里看不见）
      const keep = new Set();
      for (const n of all) {
        if (!n.path.toLowerCase().includes(q)) continue;
        keep.add(n.path);
        const segs = n.path.split('.');
        for (let i = 1; i < segs.length; i++) keep.add(segs.slice(0, i).join('.'));
      }
      nodes = all.filter((n) => keep.has(n.path));
      if (!nodes.length) {
        out.push(this.buildToolbar(all),
          h('div.cfg-state', {}, icon('question', 'sm'), h('span', { text: '没有匹配「' + this.query + '」的键' })));
        return out;
      }
    }
    out.push(this.buildToolbar(all));
    if (this.warnings.length && key === 'default') {
      out.push(h('div.cfg-warn', {}, icon('warn', 'sm'), h('span', { text: this.warnings.join('；') })));
    }
    const frag = document.createDocumentFragment();
    const rows = [];
    for (const node of nodes) {
      const built = this.buildRow(node);
      rows.push(built);
      frag.append(built.node);
    }
    this.rowsByFile[key] = rows;
    const scroller = h('div.cfg-rows', { role: 'tree', 'aria-label': ENTRIES.find((e) => e.key === key)?.label || key });
    scroller.append(frag);
    out.push(scroller);
    this.entry = key;
    // 搜索命中时全部展开（否则命中行藏在折叠里，用户一脸问号）
    if (q) this.collapsed.clear();
    this.applyCollapseState();
    return out;
  }

  /**
   * 一行：缩进 + 折叠箭头 + 定值（点分键）+ 冒号 + 变值（输入框 / 容器占位）+ 类型 + 徽章 + 撤销。
   * 注意 h(tag, props, ...children)：传子元素时第二参必须是 props 对象（漏了就是「整块不渲染」）。
   */
  buildRow(node) {
    const overridden = this.isOverridden(node.path);
    // 缩进用 CSS 变量而不是直接写 paddingLeft：`.cfg-row` 的 grid 第一列是箭头列，
    // padding 从行首算起，箭头永远稳在缩进位置上（直接把 paddingLeft 加在 grid 容器上
    // 会让第一列和箭头一起右移，深层行看着像「箭头飘了」）。
    const row = h('div.cfg-row' + (node.hasChildren ? '.cfg-group' : '') + (overridden ? '.cfg-override' : ''), {
      'data-path': node.path,
      role: 'treeitem',
      style: { '--cfg-indent': (node.depth * INDENT_PX) + 'px' },
    });

    // 折叠箭头：只有容器行有真按钮；叶子行留等宽占位，保证冒号竖向对齐
    let arrow = null;
    if (node.hasChildren) {
      arrow = h('button.cfg-arrow', {
        type: 'button',
        'data-open': '1',
        'aria-expanded': 'true',
        'aria-label': '折叠 / 展开 ' + node.path,
        title: '折叠 / 展开',
        onclick: (e) => {
          e.preventDefault();
          this.toggleCollapse(node.path);
        },
      });
    } else {
      arrow = h('span.cfg-arrow-spacer');
    }

    // 定值：点分路径（深层行给完整点分路径，title 再放一次完整 path）。
    // default.json 的节点在树里带 app. 前缀（服务端约定），显示时剥掉才和文件里看到的一致。
    const shown = displayKeyOf(node.path);
    const keyEl = h('code.cfg-key', { text: shown, title: shown });

    // 变值
    let valueEl;
    if (node.hasChildren) {
      valueEl = h('span.cfg-val.cfg-val-container', { text: containerLabel(node.type) });
    } else {
      const input = h('input.cfg-val.cfg-typed-' + node.type, {
        type: 'text',
        value: node.value,
        spellcheck: 'false',
        'data-type': node.type,
        'aria-label': node.path,
      });
      forceEnglishInput(input);
      const commit = () => {
        if (this.busyPath === node.path) return;
        void this.commit(node, input.value, input);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          input.blur();
        } else if (e.key === 'Escape') {
          // 放弃这次编辑：还原成服务端现在的值
          e.preventDefault();
          input.value = node.value;
          input.classList.remove('cfg-invalid');
          input.removeAttribute('title');
          this.invalid.delete(node.path);
        }
      });
      input.addEventListener('blur', () => {
        if (input.value !== node.value) commit();
      });
      valueEl = input;
    }

    const tail = h('div.cfg-tail', {},
      h('span.cfg-type', { text: node.type }),
      overridden ? h('span.cfg-badge', { title: '这一项被改过（写进了 config.json）' }, '已改') : null,
      overridden
        ? h('button.cfg-undo', {
            type: 'button',
            title: '撤销这一项的改动，恢复默认值',
            onclick: (e) => {
              e.preventDefault();
              void this.undo(node);
            },
          }, '撤销')
        : null);

    row.append(arrow, keyEl, h('span.cfg-colon', { text: ':' }), valueEl, tail);
    return { node: row, path: node.path, depth: node.depth, hasChildren: node.hasChildren, arrow };
  }

  // ================================================================ 渲染：联机

  async loadNet() {
    this.netState = 'loading';
    this.netError = '';
    this.renderPane();
    const [info, admin] = await Promise.all([req('/api/net/info'), req('/api/net/admin')]);
    if (this.modals.kind !== 'config' || this.entry !== 'online') return;
    if (info.ok && info.json && info.json.ok !== false) {
      this.netInfo = info.json;
    } else {
      this.netInfo = null;
      this.netError = info.status === 0 ? OFFLINE_TEXT : ((info.json && info.json.error) || '读取联机信息失败');
    }
    this.netAdmin = admin.ok && admin.json && admin.json.ok !== false ? admin.json : null;
    if (!this.idKeyFull && this.netInfo && typeof this.netInfo.idKey === 'string') this.idKeyFull = this.netInfo.idKey;
    this.netState = this.netInfo ? 'ok' : 'fail';
    this.renderPane();
  }

  /** 「联机连接」面板：全部只读 + 复制按钮（配置项同样用「定值:变值」行展示）。 */
  buildNetPane() {
    const info = this.netInfo || {};
    const admin = this.netAdmin || {};
    const adminOnline = admin.online || {};
    const isSource = info.serverSource === true || admin.isServerSource === true;
    const here = typeof location !== 'undefined' ? location.origin : '';
    const origin = isSource ? here : String(adminOnline.serverUrl || '');
    const rooms = admin.rooms && typeof admin.rooms === 'object' ? admin.rooms : { count: Number(info.rooms) || 0, list: [] };
    const roomList = Array.isArray(rooms.list) ? rooms.list : [];

    const copyBtn = (label, key, getter) => h('button.btn.sm', {
      type: 'button',
      onclick: async () => {
        const text = await getter();
        if (!text) {
          this.setFlash('没有可复制的内容', 'danger');
          this.renderPane();
          return;
        }
        const ok = await copyText(String(text));
        clearTimeout(this.copyTimer);
        this.copied = ok ? key : '';
        this.copyTimer = setTimeout(() => {
          this.copied = '';
          if (this.modals.kind === 'config' && this.entry === 'online') this.renderPane();
        }, 1500);
        this.setFlash(ok ? '已复制' + label : '复制失败：浏览器拒绝了剪贴板权限', ok ? 'ok' : 'danger');
        this.renderPane();
      },
    }, icon(this.copied === key ? 'check' : 'book', 'sm'), this.copied === key ? '已复制' : '复制');

    /** 只读的「定值:变值」行，和 JSON 区同一套视觉。 */
    const kv = (label, value, opts = {}) => {
      const shown = value === '' || value === null || value === undefined ? '—' : String(value);
      return h('div.cfg-row.cfg-kv', { 'data-path': label, role: 'treeitem' },
        h('span.cfg-arrow-spacer'),
        h('code.cfg-key', { text: label, title: label }),
        h('span.cfg-colon', { text: ':' }),
        h('span.cfg-val.cfg-ro' + (opts.mono ? '.cfg-mono' : ''), { text: shown, title: shown }),
        opts.tail ? h('div.cfg-tail', {}, ...opts.tail) : null);
    };

    const out = [];
    if (this.netState === 'loading' && !this.netInfo) {
      out.push(h('div.cfg-state', {}, icon('refresh', 'sm'), h('span', { text: '正在读取联机信息…' })));
      return out;
    }
    out.push(h('div.cfg-toolbar', {},
      h('div.cfg-toolbar-title', {},
        icon('signal', 'sm'),
        h('span', { text: '联机连接' }),
        h('span.cfg-count', { text: isSource ? '本机是服务器源' : '本机是客户端' })),
      h('div.cfg-toolbar-actions', {},
        h('button.btn.sm', { type: 'button', onclick: () => void this.loadNet() }, icon('refresh', 'sm'), '刷新'))));

    if (this.netError) out.push(h('div.cfg-warn', {}, icon('warn', 'sm'), h('span', { text: this.netError })));

    const frag = document.createDocumentFragment();
    // ── 服务器源 ───────────────────────────────────────────────────────────────
    frag.append(h('div.cfg-sec-title', { text: '服务器源' }));
    frag.append(kv('server.name', info.name || admin.app?.name || '—'));
    frag.append(kv('server.source', origin || '（未配置服务器源地址）', {
      mono: true,
      tail: origin ? [copyBtn('服务器源地址', 'origin', () => origin)] : [],
    }));
    frag.append(kv('server.role', isSource ? '服务器源（本机）' : '客户端（连别人的服务器源）'));
    frag.append(kv('server.rooms', String(rooms.count ?? 0) + ' 间房'));

    // ── 邀请链接 ───────────────────────────────────────────────────────────────
    frag.append(h('div.cfg-sec-title', { text: '邀请链接' }));
    const nameInput = h('input.input.cfg-invite-name', {
      type: 'text',
      placeholder: '邀请链接里的名字（留空则匿名）',
      value: this.inviteUsername,
      'aria-label': '邀请链接里的名字',
    });
    forceEnglishInput(nameInput);
    nameInput.addEventListener('input', (e) => {
      this.inviteUsername = e.target.value;
      const preview = this.paneHost?.querySelector('.cfg-invite-preview');
      if (preview) preview.textContent = this.invitePreviewText(origin);
    });
    frag.append(h('div.cfg-invite', {},
      nameInput,
      h('button.btn.sm.primary', {
        type: 'button',
        disabled: !origin || !isSource,
        title: isSource ? '复制一条可直接打开的加入链接' : '本机不是服务器源，没有可分享的房间口令',
        onclick: async () => {
          const url = await this.buildInvite(origin);
          if (!url) {
            this.setFlash('生成邀请链接失败：没有可用的 Token（先在本机创建一间房）', 'danger');
            return;
          }
          const ok = await copyText(url);
          this.setFlash(ok ? '邀请链接已复制（含 256 位 Token）' : '复制失败：请手动选中下面的链接', ok ? 'ok' : 'danger');
        },
      }, icon('book', 'sm'), '复制邀请链接')));
    frag.append(h('code.cfg-invite-preview', { text: this.invitePreviewText(origin) }));
    frag.append(h('div.cfg-hint', { text: '邀请链接 = 服务器源地址 + 256 位 Token + 本机 ID 密钥（type=join，对方点开就是联机页）。' }));

    // ── 房间信息 ───────────────────────────────────────────────────────────────
    frag.append(h('div.cfg-sec-title', { text: '房间信息' }));
    if (!roomList.length) {
      frag.append(h('div.cfg-hint', { text: '当前没有房间。在联机页「创建房间」之后再回来看。' }));
    } else {
      for (const room of roomList) {
        frag.append(kv('room.' + room.id, '房主 ' + (room.owner || '—') + ' · 在线 ' + (room.memberCount ?? 0) + ' 人'));
      }
    }

    // ── 本机身份 ───────────────────────────────────────────────────────────────
    frag.append(h('div.cfg-sec-title', { text: '本机身份' }));
    frag.append(kv('local.idKey', this.idKeyFull || info.idKey || '（尚未读取）', {
      mono: true,
      tail: [copyBtn(' ID 密钥', 'idkey', () => this.fetchIdKey())],
    }));
    frag.append(kv('local.token', this.tokenFull || adminOnline.tokenMasked || '（尚未读取）', {
      mono: true,
      tail: [copyBtn(' Token', 'token', () => this.fetchToken())],
    }));
    frag.append(kv('local.idKeyHint', info.idKeyHint || admin.idKey?.hint || '—', { mono: true }));

    // ── 延迟目标（只读，不做编辑 UI） ──────────────────────────────────────────
    frag.append(h('div.cfg-sec-title', { text: '延迟目标（只读）' }));
    frag.append(kv('target.latencyMs', '小于 100ms', { tail: [h('span.cfg-type', { text: '只读' })] }));
    const values = this.treeValue();
    frag.append(kv('net.heartbeatTimeoutMs', values.net?.heartbeatTimeoutMs ?? '—'));

    const scroller = h('div.cfg-rows');
    scroller.append(frag);
    out.push(scroller);
    return out;
  }

  /** 从已加载的树里捞结构（联机面板的只读展示用，拿不到就是 —）。 */
  treeValue() {
    const out = {};
    for (const node of this.tree) {
      if (node.hasChildren) continue;
      const keys = node.path.split('.');
      let cur = out;
      for (let i = 0; i < keys.length - 1; i++) {
        if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
        cur = cur[keys[i]];
      }
      cur[keys[keys.length - 1]] = node.value;
    }
    return out;
  }

  invitePreviewText(origin) {
    if (!origin) return '（没有服务器源地址，无法生成邀请链接）';
    return buildInviteUrl({ origin, token: '<256 位 Token>', idKey: '<本机 ID 密钥>', username: this.inviteUsername.trim() })
      || '（缺少 origin / token，无法生成邀请链接）';
  }

  /** 完整 ID 密钥：/api/net/info 一般已带；没有再走 /api/local/id。 */
  async fetchIdKey() {
    if (this.idKeyFull) return this.idKeyFull;
    if (this.idKeyPending) return '';
    this.idKeyPending = true;
    const r = await req('/api/local/id');
    this.idKeyPending = false;
    const j = r.ok && r.json && r.json.ok !== false ? r.json : null;
    if (j && typeof j.idKey === 'string') this.idKeyFull = j.idKey;
    if (this.modals.kind === 'config' && this.entry === 'online' && this.idKeyFull) this.renderPane();
    return this.idKeyFull;
  }

  /** 完整 Token：唯一会下发 256 位明文的管理接口（仅本机回环）。 */
  async fetchToken() {
    if (this.tokenFull) return this.tokenFull;
    if (this.tokenPending) return '';
    this.tokenPending = true;
    const r = await req('/api/net/admin/token');
    this.tokenPending = false;
    const j = r.ok && r.json && r.json.ok !== false ? r.json : null;
    if (j && typeof j.token === 'string') this.tokenFull = j.token;
    if (this.modals.kind === 'config' && this.entry === 'online' && this.tokenFull) this.renderPane();
    return this.tokenFull;
  }

  /**
   * 邀请链接：优先用 P3 的 GET /api/net/room/{id}/invite?username=（返回 { ok, url }），
   * 拿不到就自己拼（buildInviteUrl）。Token 永远从 /api/net/admin/token 取明文。
   */
  async buildInvite(origin) {
    const username = this.inviteUsername.trim();
    const roomId = this.firstRoomId();
    if (roomId) {
      const qs = username ? '?username=' + encodeURIComponent(username) : '';
      const r = await req('/api/net/room/' + encodeURIComponent(roomId) + '/invite' + qs);
      if (r.ok && r.json && r.json.ok !== false && typeof r.json.url === 'string' && r.json.url.trim()) {
        return r.json.url.trim();
      }
    }
    const token = await this.fetchToken();
    const idKey = this.idKeyFull || (this.netInfo && this.netInfo.idKey) || '';
    if (!isInviteToken(token)) return '';
    return buildInviteUrl({ origin, token, idKey, username });
  }

  firstRoomId() {
    const list = this.netAdmin?.rooms?.list;
    if (!Array.isArray(list) || !list.length) return '';
    const room = list[0];
    return room && room.id ? String(room.id) : '';
  }

  // ================================================================ 重置

  async resetAll() {
    // 记住「再开一次」需要的参数：ModalHost.confirm() 会先 close 当前弹窗，
    // 确认完如果不重开，用户点「全部恢复默认」就变成凭空关窗了。
    const reopen = () => {
      this.modals.open('config', this.openOpts());
      this.modals.current?.card?.classList.add('cfg-modal');
      this.captureHosts();
    };
    const ok = await this.modals.confirm({
      title: '全部恢复默认',
      text: '会把 data/config.json 里所有改过的项清空，全部回落到 config/*.json 里的默认值（三个 config 文件本身不动）。确定吗？',
      ok: '恢复默认',
      tone: 'warn',
      iconName: 'warn',
    });
    reopen();
    this.renderNav();
    this.renderPane();
    this.renderFoot();
    if (!ok) return; // 取消了：把面板原样摆回来
    const r = await req('/api/config/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (this.modals.kind !== 'config') return;
    if (!r.ok || !r.json || r.json.ok === false) {
      this.setFlash((r.json && (r.json.error || r.json.errors?.[0]?.message)) || '恢复默认失败', 'danger');
      this.renderNav();
      this.renderPane();
      return;
    }
    this.setFlash('已恢复默认（清掉 ' + (r.json.clearedCount ?? 0) + ' 项改动）', 'ok');
    await this.reload();
  }
}

/** CSS.escape 的兜底（老内核 / 单测环境没有它时手写转义）。 */
function cssEscape(s) {
  const str = String(s);
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(str);
  return str.replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, (c) => '\\' + c);
}

export default ConfigPanel;
