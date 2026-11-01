// 服务端配置面板：把 config.json 的全部叶子键渲染成可编辑表单（app / balance / llm 三段）。
//
// 数据流：GET /api/config → { defaults, override, effective, sections }
//   · 每行显示「生效值」，与 defaults 不同即视为被 override 覆盖（高亮 + 恢复默认）
//   · 编辑只改本地草稿；「保存修改」对每个改动路径串行 POST /api/config { section, path, value }
//   · value=null 表示删除该覆盖（= 恢复默认）
// 接口不存在（404/501）时降级成「当前服务端版本不支持配置编辑」，不报错落地。
// CSP 严格：只用 h()/icon() 建 DOM，不用 innerHTML / eval / new Function。

import { h, icon } from '../util/dom.js';
import { forceEnglishInput } from '../util/ime.js';

const TIMEOUT_MS = 5000;
const MAX_STRING = 200;

/** 三段配置的展示名。顺序即标签顺序：平衡 → 运行 → AI 与 LLM。 */
const SECTIONS = [
  { key: 'balance', label: '平衡', iconName: 'target', hint: '对局数值：移动、视野、积分、工资、道具等' },
  { key: 'app', label: '运行', iconName: 'settings', hint: '服务器与客户端运行参数（改完多半要重启）' },
  { key: 'llm', label: 'AI 与 LLM', iconName: 'sparkle', hint: '本地模型接入、超时与降级策略' },
];

/** 已知的一级分组中文名；没登记的键直接显示原键名。 */
const GROUP_LABELS = {
  server: '服务器',
  client: '客户端',
  round: '回合',
  loop: '主循环',
  save: '存档',
  watch: '数值热载',
  move: '移动',
  nav: '寻路',
  interact: '交互',
  pc: '电脑',
  student: '学生',
  teacher: '老师',
  vision: '视野',
  jc: 'JC 分享',
  ask: '提问',
  flatter: '讨好',
  toilet: '厕所',
  chatroom: '聊天室',
  speech: '台词',
  ai: 'AI 行为',
  items: '道具',
  provider: '服务商',
  model: '模型',
  circuit: '熔断',
  queue: '排队',
  temperature: '采样参数',
  enabled: '开关',
  timeout: '超时',
};

const GROUP_ICONS = {
  server: 'pc', client: 'pc', round: 'clock', loop: 'refresh', save: 'book', watch: 'eye',
  move: 'speed', nav: 'target', interact: 'hand', pc: 'pc', student: 'user', teacher: 'teacher',
  vision: 'eye', jc: 'coin', ask: 'question', flatter: 'heart', toilet: 'toilet', chatroom: 'chat',
  speech: 'book', ai: 'sparkle', items: 'bolt', provider: 'signal', model: 'sparkle',
  circuit: 'shield', queue: 'clock', temperature: 'sparkle',
};

/** 带超时的 fetch，任何失败都收敛成 { ok, status, json, error }，绝不抛。 */
async function req(url, opts = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), TIMEOUT_MS);
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

/** 连不上服务端（fetch 直接失败 / 超时）时的统一文案。 */
const OFFLINE_TEXT = '无法连接服务端，请稍后重试';

/**
 * 脱敏值的长相（server/net/ConfigAdmin.js maskSecret）：前 4 位原文 + 最多 8 个 * + 「（共 N 位）」。
 *
 * 注意：**不再用这个正则判断「哪一行是密钥」**——服务端已经在 GET /api/config 顶层下发
 * secrets: ['llm.openaiCompat.apiKeyEnv', ...]（点路径，带段名前缀），那才是权威来源。
 * 这里只保留一个形状检查，作提交前的最后一道兜底（服务端也会 400，双保险而已）。
 */
const REDACTED_RE = /^[\s\S]{4}\*{1,8}（共 \d+ 位）$/;

function looksRedacted(v) {
  return typeof v === 'string' && REDACTED_RE.test(v);
}

/** 把某段的 override 摊平成点路径数组（用来数「这次重置会清掉几项」）。 */
function affectedPaths(data, section) {
  const ov = ((data && data.override) || {})[section];
  if (!isPlainObject(ov)) return [];
  const out = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? prefix + '.' + k : k;
      if (isPlainObject(v)) walk(v, p);
      else out.push(section + '.' + p);
    }
  };
  walk(ov, '');
  return out;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 值 → 单行展示文本。 */
function preview(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const t = JSON.stringify(v);
    return t.length > 80 ? t.slice(0, 80) + '…' : t;
  } catch {
    return String(v);
  }
}

/** 判断控件类型：number / boolean / string / json（数组或嵌套对象）。 */
function kindOf(v) {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'string';
  return 'json';
}

function getPath(root, path) {
  let cur = root;
  for (const k of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}

export class ConfigPanel {
  constructor(modals, opts = {}) {
    this.modals = modals;
    this.onClose = opts.onClose || null;
    this.onSaved = opts.onSaved || null;
    this.section = 'balance';
    this.data = null; // { defaults, override, effective, sections }
    this.state = 'idle'; // idle | loading | ok | unsupported | fail
    this.error = '';
    this.query = '';
    this.draft = new Map(); // 'section.path' → value（用户改过、还没保存的值）
    this.invalid = new Set(); // 非法草稿的 key
    this.openGroups = new Set(); // 折叠状态：默认全部展开，收起时记录
    this.closedGroups = new Set();
    this.editingJson = new Set();
    this.flash = ''; // 保存/重置后的提示
    this.flashTone = 'ok';
    this.errors = [];
    this.needRestart = false;
    this.restartKeys = [];
    this.busy = false;
    this.copied = '';
    this.revealed = new Set(); // 'section.path'：脱敏行被点了「显示」，临时切成明文框
    this.pendingRestore = new Map(); // 'section.path' → 期望恢复后就不再显示 override
    this.lastOverridePaths = []; // 重置前快照：服务端 reset 不回 cleared，只能自己数
  }

  // ---------------------------------------------------------------- 数据

  async load() {
    this.state = 'loading';
    this.error = '';
    this.render();
    if (this.modals.kind !== 'config') return; // 面板已关闭：不要再往别人的弹窗里塞内容
    const r = await req('/api/config');
    if (r.status === 404 || r.status === 501) {
      this.state = 'unsupported';
      this.data = null;
      return this.render();
    }
    if (!r.ok || !r.json || r.json.ok === false) {
      this.state = 'fail';
      // status === 0 表示 fetch 都没发出去（连接被拒 / 超时 / 断网），不是服务端返回的错误
      this.error = r.status === 0
        ? OFFLINE_TEXT
        : ((r.json && (r.json.error || r.json.message)) || r.error || ('读取失败（HTTP ' + r.status + '）'));
      return this.render();
    }
    this.data = {
      defaults: r.json.defaults || {},
      override: r.json.override || {},
      effective: r.json.effective || {},
      sections: r.json.sections || {},
      // 服务端下发的敏感路径白名单（点路径，已带段名前缀）。老服务端没有这个字段 → 空数组，
      // 此时退化成「靠掩码形状识别」，面板仍然可用但会把非标量打码误判，属于已知降级。
      secrets: Array.isArray(r.json.secrets) ? r.json.secrets.slice() : [],
    };
    this.state = 'ok';
    this.draft.clear();
    this.invalid.clear();
    this.render();
  }

  /** 某个叶子键当前应显示的值：草稿优先，其次生效值。 */
  valueOf(section, path) {
    const k = section + '.' + path;
    if (this.draft.has(k)) return this.draft.get(k);
    return getPath((this.data.effective || {})[section], path);
  }

  /**
   * 这一行是不是敏感项（服务端 secrets 列表里有它）。
   * 为什么不看值的长相：maskSecret 的产物可能恰好和真值撞形（如 format 是 '{Lv} * 50'），
   * 而 secrets 是服务端用同一套 isSecretEntry 判出来的，绝不会漂移。
   */
  isSecret(section, path) {
    const list = (this.data && this.data.secrets) || [];
    return list.indexOf(section + '.' + path) !== -1;
  }

  /** 是否被 override 改过（生效值与默认值不同）。 */
  isOverride(section, path) {
    const ov = (this.data.override || {})[section];
    return isPlainObject(ov) && getPath(ov, path) !== undefined;
  }

  defaultOf(section, path) {
    return getPath((this.data.defaults || {})[section], path);
  }

  /** 是否在 sections.meta.overridePaths 里（服务端声明的可覆盖路径，仅供参考）。 */
  metaOf() {
    const meta = (this.data && this.data.sections && this.data.sections.meta) || {};
    return {
      restartKeys: Array.isArray(meta.restartKeys) ? meta.restartKeys : [],
      overridePaths: Array.isArray(meta.overridePaths) ? meta.overridePaths : [],
    };
  }

  dirtyCount() {
    let n = 0;
    for (const k of this.draft.keys()) if (!this.invalid.has(k)) n += 1;
    return n;
  }

  // ---------------------------------------------------------------- 交互

  setDraft(section, path, value, valid = true) {
    const k = section + '.' + path;
    this.draft.set(k, value);
    if (valid) this.invalid.delete(k);
    else this.invalid.add(k);
    this.updateDirtyBadge();
  }

  updateDirtyBadge() {
    const badge = document.getElementById('config-dirty');
    if (!badge) return;
    const n = this.dirtyCount();
    badge.textContent = n ? n + ' 项未保存' : '';
    badge.hidden = n === 0;
  }

  async save() {
    if (this.busy || this.state !== 'ok') return;
    if (this.invalid.size) {
      this.flash = '有 ' + this.invalid.size + ' 项格式不对（红色行），先改好再保存。';
      this.flashTone = 'danger';
      return this.render();
    }
    // 兜底闸：脱敏串不能当新值写回。服务端 validatePatch 现在也会 400 拦，
    // 这里先拦一道省一次往返，也避免 UI 上的「假成功」观感。
    const entries = [];
    let skippedRedacted = 0;
    for (const [k, value] of this.draft.entries()) {
      if (looksRedacted(value)) {
        skippedRedacted += 1;
        console.warn('[config] 跳过疑似脱敏值，未提交：' + k);
        continue;
      }
      entries.push([k, value]);
    }
    if (!entries.length) {
      this.flash = skippedRedacted
        ? '有 ' + skippedRedacted + ' 项是脱敏后的显示值，不能作为配置写入；请填入真实值。'
        : '没有改动需要保存。';
      this.flashTone = skippedRedacted ? 'danger' : 'info';
      return this.render();
    }
    this.busy = true;
    this.errors = [];
    this.render();
    const failed = [];
    for (const [k, value] of entries) {
      const dot = k.indexOf('.');
      const section = k.slice(0, dot);
      const path = k.slice(dot + 1);
      const r = await req('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ section, path, value }),
      });
      if (!r.ok || !r.json || r.json.ok === false) {
        const offline = r.status === 0;
        failed.push({ path: k, message: offline ? OFFLINE_TEXT : ((r.json && (r.json.errors?.[0]?.message || r.json.error)) || r.error || ('HTTP ' + r.status)) });
        if (offline) {
          // 服务端彻底不可达：别把其余条目也挨个打一遍（每个都要等超时）
          failed.push({ path: '其余 ' + Math.max(0, entries.length - failed.length - 1) + ' 项', message: '已跳过（服务端不可达）' });
          break;
        }
        continue;
      }
      if (Array.isArray(r.json.errors)) {
        for (const e of r.json.errors) failed.push({ path: e.path || k, message: e.message || '校验失败' });
      }
      if (r.json.needRestart) this.needRestart = true;
      if (Array.isArray(r.json.applied)) {
        for (const a of r.json.applied) {
          if (typeof a === 'string' && /^[a-z]+\./.test(a)) this.restartKeys.push(a.split('.').slice(1).join('.'));
        }
      }
    }
    this.busy = false;
    this.errors = failed;
    if (!failed.length) {
      this.draft.clear();
      this.flash = '已保存 ' + entries.length + ' 项配置。' + (skippedRedacted ? '（' + skippedRedacted + ' 项脱敏值已跳过）' : '');
      this.flashTone = 'ok';
      this.onSaved?.();
    } else {
      this.flash = failed.length + ' 项保存失败。';
      this.flashTone = 'danger';
    }
    await this.load();
  }

  async resetSection() {
    await this.doReset(this.section, '把「' + this.labelOf(this.section) + '」段的所有改动恢复成默认值？');
  }

  async resetAll() {
    await this.doReset(null, '把三段的全部改动都恢复成默认值？这个操作不可撤销。');
  }

  async doReset(section, question) {
    if (this.busy) return;
    const ok = await this.confirmWith(question);
    if (!ok) return;
    // 服务端 reset 只回 { ok, needRestart }，没有 cleared：重置前自己数一遍要清掉多少项
    const before = section === null
      ? [...new Set([...affectedPaths(this.data, 'app'), ...affectedPaths(this.data, 'llm'), ...affectedPaths(this.data, 'balance')])].length
      : affectedPaths(this.data, section).length;
    this.busy = true;
    this.render();
    const r = await req('/api/config/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(section ? { section } : {}),
    });
    this.busy = false;
    if (!r.ok || !r.json || r.json.ok === false) {
      this.errors = [{ path: section || '全部', message: r.status === 0 ? OFFLINE_TEXT : ((r.json && (r.json.error || r.json.message)) || r.error || ('HTTP ' + r.status)) }];
      this.flash = '重置失败。';
      this.flashTone = 'danger';
    } else {
      this.draft.clear();
      this.revealed.clear();
      // 新服务端回 cleared / clearedCount；老服务端没有该字段时退回本地估算值
      const n = typeof r.json.clearedCount === 'number'
        ? r.json.clearedCount
        : Array.isArray(r.json.cleared) ? r.json.cleared.length : before;
      this.flash = n
        ? '已清除 ' + n + ' 项覆盖，恢复默认值。'
        : '已经是默认值，没有需要清除的覆盖。';
      this.flashTone = 'ok';
      this.restartKeys = this.metaOf().restartKeys.slice();
      this.needRestart = Boolean(r.json.needRestart);
      this.onSaved?.();
    }
    await this.load();
  }

  /** 恢复单个叶子键的默认值：POST value=null。 */
  async restoreDefault(section, path) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    const r = await req('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section, path, value: null }),
    });
    this.busy = false;
    if (!r.ok || !r.json || r.json.ok === false) {
      this.errors = [{ path: section + '.' + path, message: r.status === 0 ? OFFLINE_TEXT : ((r.json && (r.json.error || r.json.message)) || r.error || ('HTTP ' + r.status)) }];
      this.flash = '恢复默认失败。';
      this.flashTone = 'danger';
      return this.render();
    }
    this.draft.delete(section + '.' + path);
    this.revealed.delete(section + '.' + path);
    this.flash = '已恢复默认：' + path;
    this.flashTone = 'ok';
    if (r.json && r.json.needRestart) {
      this.needRestart = true;
      this.restartKeys.push(path);
    }
    this.onSaved?.();
    await this.load();
  }

  /**
   * 把一整组叶子键恢复默认。
   * 逐个 POST { section, path, value: null }（= 删掉该键的覆盖），而不是调 /api/config/reset：
   * reset 是按段清的，粒度太粗，会把本组之外的改动一起清掉。
   */
  async restoreGroup(section, gkey) {
    if (this.busy || this.state !== 'ok') return;
    const leaves = this.leavesOf(section, gkey);
    const hit = leaves.filter((p) => this.isOverride(section, p));
    if (!hit.length) {
      this.flash = '「' + (GROUP_LABELS[gkey] || gkey) + '」这组没有需要恢复的改动。';
      this.flashTone = 'info';
      return this.render();
    }
    this.busy = true;
    this.errors = [];
    this.render();
    const failed = [];
    let done = 0;
    for (const path of hit) {
      const r = await req('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ section, path, value: null }),
      });
      if (!r.ok || !r.json || r.json.ok === false) {
        failed.push({ path: section + '.' + path, message: r.status === 0 ? OFFLINE_TEXT : ((r.json && (r.json.errors?.[0]?.message || r.json.error)) || r.error || ('HTTP ' + r.status)) });
        if (r.status === 0) {
          failed.push({ path: '其余 ' + (hit.length - done - 1) + ' 项', message: '已跳过（服务端不可达）' });
          break;
        }
        continue;
      }
      done += 1;
      if (r.json && r.json.needRestart) {
        this.needRestart = true;
        this.restartKeys.push(path);
      }
      this.draft.delete(section + '.' + path);
      this.revealed.delete(section + '.' + path);
    }
    this.busy = false;
    this.errors = failed;
    if (!failed.length) {
      this.flash = '「' + (GROUP_LABELS[gkey] || gkey) + '」已恢复默认，共 ' + done + ' 项。';
      this.flashTone = 'ok';
      this.onSaved?.();
    } else {
      this.flash = '「' + (GROUP_LABELS[gkey] || gkey) + '」有 ' + failed.length + ' 项恢复失败。';
      this.flashTone = 'danger';
    }
    await this.load();
  }

  /** 某个一级分组下所有叶子键的路径（不用组件的 DOM，纯靠数据）。 */
  leavesOf(section, gkey) {
    const eff = ((this.data && this.data.effective) || {})[section];
    const gval = isPlainObject(eff) ? eff[gkey] : undefined;
    if (isPlainObject(gval)) return Object.keys(gval).map((k) => gkey + '.' + k);
    return [gkey];
  }

  /** 复用 ModalHost.confirm，但确认后要把配置面板重新打开（confirm 会顶掉当前弹窗）。 */
  async confirmWith(text) {
    const ok = await this.modals.confirm({ title: '确认', text, ok: '确定', tone: 'warn', iconName: 'warn' });
    if (this.modals.kind !== 'config') this.show(this.onClose);
    return ok;
  }

  labelOf(section) {
    return SECTIONS.find((s) => s.key === section)?.label || section;
  }

  // ---------------------------------------------------------------- 渲染

  render() {
    if (this.modals.kind !== 'config') return; // 面板没开着就别改 DOM
    this.modals.setBody('config', this.buildBody());
    const footHost = this.modals.current?.card?.querySelector('.modal-foot');
    if (footHost) footHost.replaceChildren(...this.buildFoot());
  }

  buildFoot() {
    const unsupported = this.state === 'unsupported';
    const disabled = this.busy || this.state !== 'ok';
    return [
      h('button.btn.ghost', { onclick: () => this.resetSection(), disabled: disabled || unsupported }, icon('refresh', 'sm'), '重置本段'),
      h('button.btn.ghost', { onclick: () => this.resetAll(), disabled: disabled || unsupported }, icon('refresh', 'sm'), '全部重置'),
      h('span.spacer'),
      h('button.btn.primary', { onclick: () => this.save(), disabled: disabled || unsupported }, icon('check', 'sm'), this.busy ? '保存中…' : '保存修改'),
      h('button.btn', { onclick: () => this.close() }, '关闭'),
    ];
  }

  /** 只关面板、不走「完成」回调（完成回调会还原暂停状态，配置面板在大厅用不到）。 */
  close() {
    this.modals.close();
  }

  buildBody() {
    const out = [this.tabBar()];
    if (this.state === 'loading') {
      out.push(h('div.config-state', {}, icon('refresh', 'sm'), '正在读取配置…'));
      return out;
    }
    if (this.state === 'unsupported') {
      out.push(h('div.config-state.config-state-warn', {},
        icon('warn', 'sm'),
        h('div', {},
          h('div', { text: '当前服务端版本不支持配置编辑' }),
          h('div.fine', { text: '接口 GET /api/config 不可用（404/501）。升级服务端后这里会自动出现三段配置。' }))));
      return out;
    }
    if (this.state === 'fail') {
      out.push(h('div.config-state.config-state-warn', {},
        icon('warn', 'sm'),
        h('div', {},
          h('div', { text: this.error === OFFLINE_TEXT ? OFFLINE_TEXT : '读取配置失败' }),
          h('div.fine', { text: this.error === OFFLINE_TEXT ? '服务端进程没有响应（连接被拒绝或超时）。确认后端已启动后点重试。' : this.error })),
        h('button.btn.sm', { onclick: () => this.load(), disabled: this.busy }, icon('refresh', 'sm'), '重试')));
      return out;
    }
    out.push(this.toolbar());
    if (this.flash) out.push(h('div.config-flash.' + (this.flashTone === 'danger' ? 'danger' : this.flashTone === 'info' ? 'info' : 'ok'), { text: this.flash }));
    if (this.errors.length) {
      out.push(h('div.config-errors', {}, ...this.errors.map((e) => h('div.config-error-row', {},
        icon('warn', 'sm'),
        h('code.config-mono', { text: e.path }),
        h('span', { text: e.message })))));
    }
    if (this.needRestart) {
      const keys = [...new Set(this.restartKeys.length ? this.restartKeys : this.metaOf().restartKeys)];
      out.push(h('div.config-flash.warn', {},
        icon('clock', 'sm'),
        h('span', { text: '部分配置需要重启游戏才生效' + (keys.length ? '：' + keys.join('、') : '') })));
    }
    out.push(this.formFor(this.section));
    return out;
  }

  tabBar() {
    return h('div.segmented.config-tabs', { role: 'group', 'aria-label': '配置分类' },
      ...SECTIONS.map((s) => h('button', {
        'aria-pressed': String(this.section === s.key),
        onclick: () => {
          if (this.section === s.key) return;
          this.section = s.key;
          this.query = '';
          this.render();
        },
      }, icon(s.iconName, 'sm'), s.label)),
      h('span.spacer'),
      h('span.badge.config-dirty', { id: 'config-dirty', hidden: true, text: '' }));
  }

  toolbar() {
    const q = h('input.input.config-search', {
      type: 'search',
      placeholder: '搜索键名（如 move.baseSpeed）',
      'aria-label': '搜索键名',
      value: this.query,
      oninput: (e) => {
        this.query = e.target.value.trim();
        this.renderSearchResults();
      },
    });
    forceEnglishInput(q);
    const hint = SECTIONS.find((s) => s.key === this.section)?.hint || '';
    return h('div.config-toolbar', {},
      h('div.config-toolbar-left', {}, icon('book', 'sm'), h('span.fine', { text: hint })),
      q);
  }

  /** 搜索时只替换结果区，不重建输入框（避免丢焦点）。 */
  renderSearchResults() {
    const host = document.getElementById('config-list');
    if (!host) return this.render();
    host.replaceChildren(...this.groupsFor(this.section));
  }

  groupsFor(section) {
    const eff = (this.data.effective || {})[section];
    if (!isPlainObject(eff)) {
      return [h('div.config-state', {}, icon('warn', 'sm'), '服务端没有下发 ' + section + ' 段，可能是空配置。')];
    }
    const needle = this.query.toLowerCase();
    const groups = [];
    for (const [gkey, gval] of Object.entries(eff)) {
      // meta 是服务端塞进来的元数据（restartKeys / overridePaths），不是用户能改的配置项
      if (gkey === 'meta') continue;
      const leaves = [];
      if (isPlainObject(gval)) {
        for (const [k, v] of Object.entries(gval)) leaves.push({ path: gkey + '.' + k, value: v });
      } else {
        leaves.push({ path: gkey, value: gval });
      }
      const visible = needle ? leaves.filter((l) => l.path.toLowerCase().includes(needle)) : leaves;
      if (!visible.length) continue;
      groups.push(this.groupBlock(section, gkey, visible, leaves.length));
    }
    if (!groups.length) {
      return [h('div.config-state', {}, icon('question', 'sm'), this.query ? '没有匹配「' + this.query + '」的键' : '这一段没有可编辑的键。')];
    }
    return groups;
  }

  formFor(section) {
    return h('div.config-list', { id: 'config-list' }, ...this.groupsFor(section));
  }

  groupBlock(section, gkey, leaves, total) {
    const id = 'config-group-' + section + '-' + gkey;
    const closed = this.closedGroups.has(section + '.' + gkey) && !this.query;
    const ovCount = leaves.filter((l) => this.isOverride(section, l.path)).length;
    const title = GROUP_LABELS[gkey] || gkey;
    // head 用 div 而不是 button：里面还要放「恢复默认」按钮，button 不能嵌 button
    const toggle = () => {
      const k = section + '.' + gkey;
      if (this.closedGroups.has(k)) this.closedGroups.delete(k);
      else this.closedGroups.add(k);
      this.render();
    };
    const paths = leaves.map((l) => l.path);
    return h('div.config-group' + (closed ? '.closed' : ''), { id },
      h('div.config-group-head', { role: 'group' },
        h('button.config-group-toggle', {
          type: 'button',
          'aria-expanded': String(!closed),
          'aria-controls': id + '-body',
          title: closed ? '展开' : '收起',
          onclick: toggle,
        },
        icon(GROUP_ICONS[gkey] || 'settings', 'sm'),
        h('span.config-group-title', { text: title }),
        h('code.config-group-key', { text: gkey })),
        h('span.spacer'),
        ovCount ? h('span.badge.config-ov-badge', { text: ovCount + ' 项覆盖' }) : null,
        h('button.btn.ghost.sm.config-group-reset', {
          type: 'button',
          disabled: this.busy || this.state !== 'ok',
          title: '把这组的 ' + paths.length + ' 个键全部恢复成默认值',
          onclick: (e) => {
            e.stopPropagation();
            this.restoreGroup(section, gkey);
          },
        }, icon('refresh', 'sm'), '恢复默认'),
        h('span.fine', { text: closed ? total + ' 项' : '' })),
      closed
        ? null
        : h('div.config-group-body', { id: id + '-body' },
          ...leaves.map((l) => this.rowFor(section, l.path, l.value))));
  }

  rowFor(section, path, effectiveValue) {
    const key = section + '.' + path;
    const overridden = this.isOverride(section, path);
    const def = this.defaultOf(section, path);
    const drafted = this.draft.has(key);
    const bad = this.invalid.has(key);
    const value = this.valueOf(section, path);
    const control = this.controlFor(section, path, value, effectiveValue);
    return h('div.config-row' + (overridden ? '.override' : '') + (drafted ? '.dirty' : '') + (bad ? '.invalid' : ''), {},
      h('code.config-path', { text: path, title: key }),
      h('div.config-control', {}, control),
      h('div.config-meta', {},
        h('span.config-default', {
          text: this.isSecret(section, path) ? '默认（已脱敏）' : '默认 ' + preview(def),
        }),
        overridden || drafted
          ? h('button.btn.ghost.sm.config-restore', {
              disabled: this.busy,
              title: '删除这项覆盖，回到默认值',
              onclick: () => this.restoreDefault(section, path),
            }, icon('refresh', 'sm'), '恢复默认')
          : null));
  }

  controlFor(section, path, value, effectiveValue) {
    const key = section + '.' + path;
    // 敏感项优先：服务端 secrets 列表点名了它，就用密码框显示、可点「显示」
    if (this.isSecret(section, path)) return this.secretControl(section, path, key);
    const kind = kindOf(effectiveValue === undefined ? value : effectiveValue);
    if (kind === 'boolean') {
      const box = h('input.config-check', {
        type: 'checkbox',
        checked: Boolean(value),
        'aria-label': key,
        onchange: (e) => this.setDraft(section, path, Boolean(e.target.checked)),
      });
      return h('label.config-bool', {}, box, h('span', { text: value ? '开' : '关' }));
    }
    if (kind === 'number') {
      const input = h('input.input.config-input', {
        type: 'number',
        step: 'any',
        value: value === undefined || value === null ? '' : String(value),
        'aria-label': key,
        oninput: (e) => {
          const raw = e.target.value.trim();
          if (raw === '') return this.setDraft(section, path, null, false);
          const n = Number(raw);
          if (!Number.isFinite(n)) return this.setDraft(section, path, raw, false);
          this.setDraft(section, path, n);
        },
      });
      forceEnglishInput(input);
      return input;
    }
    if (kind === 'string') {
      const input = h('input.input.config-input', {
        type: 'text',
        maxlength: String(MAX_STRING),
        value: value == null ? '' : String(value),
        'aria-label': key,
        oninput: (e) => {
          const v = e.target.value;
          if (v.length > MAX_STRING) e.target.value = v.slice(0, MAX_STRING);
          this.setDraft(section, path, e.target.value);
        },
      });
      forceEnglishInput(input);
      return input;
    }
    // 数组 / 嵌套对象：默认只读 JSON + 「编辑」，点开变 textarea 改 JSON
    if (!this.editingJson.has(key)) {
      return h('div.config-json', {},
        h('code.config-json-view', { text: preview(value) }),
        h('button.btn.ghost.sm', {
          onclick: () => {
            this.editingJson.add(key);
            this.render();
          },
        }, icon('book', 'sm'), '编辑 JSON'));
    }
    const ta = h('textarea.input.config-json-edit', {
      rows: '3',
      spellcheck: 'false',
      'aria-label': key,
      value: JSON.stringify(value ?? null, null, 0),
      oninput: (e) => {
        const raw = e.target.value;
        try {
          const parsed = JSON.parse(raw);
          this.setDraft(section, path, parsed, true);
        } catch {
          this.setDraft(section, path, raw, false);
        }
      },
    });
    forceEnglishInput(ta);
    return h('div.config-json', {}, ta,
      h('button.btn.ghost.sm', {
        onclick: () => {
          this.editingJson.delete(key);
          this.render();
        },
      }, '收起'));
  }

  /**
   * 脱敏行 (llm.apiKeyEnv 这一类)：服务端只下发 abcd********（共 N 位），拿不到真值。
   *
   * 关键约定——**未重新输入就绝不提交**：
   *   这一行的 input 值只做展示，不写进 draft；只有用户真的敲了键盘才 setDraft。
   *   所以「打开面板 → 点保存」不会把打码串当新值写回去（save() 里还有第二道闸）。
   */
  secretControl(section, path, key) {
    const shown = String(getPath((this.data.effective || {})[section], path) ?? '');
    const drafted = this.draft.has(key);
    const revealed = this.revealed.has(key);

    const input = h('input.input.config-input.config-secret', {
      type: revealed ? 'text' : 'password',
      value: drafted ? String(this.draft.get(key) ?? '') : shown,
      placeholder: '重新输入才会修改',
      'aria-label': key,
      autocomplete: 'new-password',
      spellcheck: 'false',
      oninput: (e) => {
        // 第一次真正输入时，把打码串整个替换掉，别让用户从 abcd**** 里删星号
        this.setDraft(section, path, e.target.value);
        this.syncSecretHint(e.target, key);
      },
    });
    forceEnglishInput(input);

    const eye = h('button.btn.ghost.sm.config-eye', {
      type: 'button',
      title: revealed ? '隐藏' : '显示',
      'aria-pressed': String(revealed),
      onclick: () => {
        if (this.revealed.has(key)) this.revealed.delete(key);
        else this.revealed.add(key);
        this.render();
      },
    }, icon('eye', 'sm'), revealed ? '隐藏' : '显示');

    return h('div.config-secret-wrap', { 'data-secret-key': key },
      h('div.config-secret-line', {}, input, eye),
      h('div.fine.config-secret-note', {
        text: drafted
          ? '已改为新值，保存后写入 override.json。'
          : '当前显示为脱敏值，重新输入才会修改。',
      }));
  }

  /** 输入时刷新那行小字提示，不用整块重渲染（否则会丢焦点）。 */
  syncSecretHint(input, key) {
    const wrap = input.closest('.config-secret-wrap');
    const note = wrap && wrap.querySelector('.config-secret-note');
    if (!note) return;
    if (this.draft.has(key)) note.textContent = '已改为新值，保存后写入 override.json。';
  }

  show(onClose) {
    this.onClose = onClose || this.onClose;
    // 必须先 open 再 load：load() 里 render() 依赖 modals.kind === 'config'
    // 才会写 DOM，顺序反了就会永远停在「正在读取配置…」。
    this.state = 'loading';
    this.modals.open('config', {
      title: '服务端配置',
      sub: '直接编辑 config.json 的全部配置项；保存写入 override.json 并立即生效',
      icon: 'settings',
      wide: true,
      body: this.buildBody(),
      foot: this.buildFoot(),
      onDismiss: () => this.onClose?.(),
    });
    void this.load();
  }
}
