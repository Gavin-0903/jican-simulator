// 大厅顶部的「单机 / 联机」切换与联机面板（需求 3，P2-B 改造）。
//
// 产品形态（用户原话）：「点击进入房间/创建房间成功就会弹出一个新的窗口（用 WebView 等方式显示网页到窗口上）」。
// 所以大厅里不再是那张长表单，而只有两个入口：
//   ① 「创建房间」/「加入房间」→ 调 /api/net/join（跨域 GET，服务器源负责真正建房/进房）；
//   ② 成功后立刻 window.open 服务端 URL 契约拼出来的**页面链接**，新窗口里就是「联机中的游戏」。
//      桌面宿主 packaging/win/Launch.cs 的 NewWindowRequested 会把它变成一个独立的 WebView2 房间窗口；
//      普通浏览器里就是一个新标签页。被拦截时绝不静默失败：给一条可点的链接 + 房间信息卡片。
//
// 三个数据源各自的角色：
//   · GET /api/net/info      → 本机是「服务器源」还是「客户端」（判定只看 body.serverSource）；
//   · GET /api/lobby/players → 大厅在线玩家（P1 新接口，可能还没落地 → 退回 rooms.list 的 members 汇总）；
//   · GET /api/net/room?roomid= → 房间当前成员（进房后每 3 秒刷一次「在线成员」）。
// 延迟徽章：每 5 秒 GET /api/app/ping 打一次往返（performance.now() 差值），≤100ms 绿色 ✓，超了橙色并注明目标。
//
// 对外接口保持不变（client/js/ui/Lobby.js 依赖）：new NetPanel(store) / mount(root) / refresh()。

import { h, icon } from '../util/dom.js';
import { forceEnglishInput } from '../util/ime.js';
import { RoomClient } from '../net/RoomClient.js';
import { buildInviteUrl, randomToken, isInviteToken, normalizeOrigin } from '../net/invite.js';
import { parseRoomQuery } from '../net/roomUrl.js';

/** 延迟目标（需求原话「延迟控制在 100ms 内」）。 */
const LATENCY_TARGET_MS = 100;
/** 延迟探测周期与超时。 */
const PING_EVERY_MS = 5000;
const PING_TIMEOUT_MS = 3000;
/** 进房后房间成员刷新周期。 */
const ROOM_REFRESH_MS = 3000;
/** 大厅玩家列表刷新周期。 */
const PLAYERS_REFRESH_MS = 8000;

/** 兜底用户名：抽到 3 位数字，避免两个未填名字的人撞成同一个成员名。 */
function defaultName() {
  return `玩家${Math.floor(Math.random() * 900 + 100)}`;
}

/** 令牌打码（只留前 8 位），房间卡片里默认显示这个，点「复制」才拿到全文。 */
function maskToken(token) {
  const t = String(token ?? '');
  if (!t) return '—';
  return `${t.slice(0, 8)}…（共 ${t.length} 位）`;
}

/** 完整 token 的唯一判据：256 位十六进制。复制提示语前必须过这一关，绝不复制半截。 */
const FULL_TOKEN = /^[0-9a-fA-F]{256}$/;

/** 上一次用 window.open 打开的房间窗口地址（sessionStorage）：大厅窗口刷新后还能「打开房间窗口」。 */
export const ROOM_WINDOW_KEY = 'jican.roomWindow';

/**
 * 拼「复制房间提示语」的 6 行文本（房主发给同学的入房说明）。
 *
 * 模板来自用户原话（m00599）：「大家好我是{Name}，我创建了一个房间：服务器源：… / 服务器token: …
 * / 房间号：… / 邀请码：…」——名字由房主名兜底，服务器源由调用方换成本机可被访问的地址。
 *
 * 两个硬约束：
 *   · token 必须是**完整明文**（房主把整串贴给同学，同学粘进「高级」区的 Token 框）；
 *     不合法就返回空串，绝不产出带半截 token 的文案；
 *   · **绝不包含 ID 密钥**（别人拿到能冒充房主身份）：这个函数的参数里根本没有 idKey。
 */
export function roomNoticeText({ name, roomId, token, invCode, origin }) {
  const who = String(name ?? '').trim();
  const rid = String(roomId ?? '').trim();
  const tk = String(token ?? '').trim();
  const iv = String(invCode ?? '').trim();
  const src = String(origin ?? '').trim().replace(/\/+$/, '');
  if (!FULL_TOKEN.test(tk)) return '';
  return [
    who ? `大家好我是${who}，我创建了一个房间：` : '大家好，我创建了一个房间：',
    `服务器源：${src || '（未配置，进联机页「高级」查看）'}`,
    `服务器token: ${tk}`,
    `房间号：${rid}`,
    `邀请码：${iv || '（无）'}`,
    '加入方式：打开联机页 →「高级」里填服务器源和 Token → 再用房间号与邀请码进房。',
  ].join('\n');
}

/**
 * 把服务端返回拼成「状态码 + 中文原因」的一行字。
 * 需求要求原样展示（例：「404 房间不存在」「500 房间 Token 不匹配」），不要吞掉状态码。
 */
function describeError(status, message) {
  const code = Number(status) || 0;
  const text = String(message ?? '').trim() || '请求失败';
  return code ? `${code} ${text}` : text;
}

export class NetPanel {
  constructor(store, { roomPage = false } = {}) {
    this.store = store;
    this.client = new RoomClient(store);
    // 房间页（地址栏带 token/id/type，或被擦成 ?room= 后刷新）没有"单机"可选：
    // 那一页的 NetClient 已经挂在 /lobby 上，房主/玩家都在房间里，切回单机只会得到一具空壳。
    // 所以这一页不画分段控件，mode 固定为 'net'（否则 #netBody 不渲染，用户进来看到一片空白）。
    this.roomPage = Boolean(roomPage);
    this.mode = this.roomPage ? 'net' : 'solo'; // 'solo' | 'net'
    this.origin = ''; // 服务器源地址
    this.token = ''; // 服务器源 Token（本机是服务器源时自动生成一个）
    this.idKey = '';
    this.username = '';
    this.roomId = '';
    this.invCode = '';
    this.busy = ''; // '' | 'probe' | 'create' | 'join'
    this.error = ''; // 原样展示的错误文本（含状态码）
    this.info = null; // { ok, origin, name, rooms, idKeyHint } | { ok:false, error }
    this.joined = null; // 最近一次成功进入的房间快照 { roomId, token, invCode, role, landed, blocked, openUrl, inviteUrl, members }
    // 房间页「开始游戏」与大厅底部「打开房间窗口」的接线：房间状态归 main.js 的 roomState，
    // NetPanel 只负责画按钮/转发点击，避免两处各自维护一份「是不是房主、开局没有」。
    this.startInfo = null; // () => ({ isOwner, started, busy })
    this.onStartGame = null; // () => void
    this.onRoomChange = null; // (joined|null) => void：进/离房时让大厅重画底部按钮
    this.onModeChange = null; // (mode) => void：单机/联机切换时让大厅重画
    this.players = []; // 大厅在线玩家
    this.playersFallback = false; // true = /api/lobby/players 未落地，数据来自 rooms.list 汇总
    this.playersLoaded = false;
    this.showJoin = false; // 「加入房间」展开态
    this.showAdvanced = false; // 「高级」折叠区展开态
    this.latency = null; // 最近一次往返延迟（ms）；null = 还没测出来
    this.latencyTarget = LATENCY_TARGET_MS;
    this.notice = ''; // 面板内的一次性提示（复制成功 / 离开房间）
    this.probed = false;
    this.mounted = false; // 大厅重渲染时会被挪到新容器，期间不能重复探测
    this.autoFilled = false;
    this.autoFilledHint = false;
    // 自动填入的三个来源分别打标：用于在高级区给「这是默认值，可改」的说明，
    // 也用于避免用户手填之后又被默认值覆盖。
    this.originDefaulted = false;
    this.tokenDefaulted = false;
    this.usernameDefaulted = false;
    this.copySeq = 0; // 复制老失败的兜底提示用
    this.tailscaleUrl = ''; // 本机 TailScale 公开地址（https://xxx.ts.net）；分享文案里换掉 127.0.0.1 用
    void this.refresh(); // refresh 内部会先取 ID 密钥，再探测、自动填入
  }

  /** 大厅每次重渲染时把新容器交给面板。 */
  mount(root) {
    this.root = root;
    this.mounted = true;
    this.render();
    this.#startTimers();
  }

  get probing() {
    return this.busy === 'probe';
  }

  async refresh() {
    // ID 密钥要先取：高级区「ID 密钥」一行显示的是 this.idKey，取晚了会先渲染成「未读到」再闪一下。
    this.idKey = (await this.#loadIdKey()) || this.idKey;
    await this.#probe();
    this.tailscaleUrl = (await this.#loadTailscaleUrl()) || this.tailscaleUrl;
    await this.#autofillFromConfig();
    await this.#loadPlayers();
    void this.#measureLatency();
    if (this.mounted) this.#startTimers();
  }

  // ────────────────────────────────────────────────────────────── 定时器
  // 面板在「单机」页或被大厅替换时不该继续打网络：所有 tick 都先看 this.mounted && mode === 'net'。
  #startTimers() {
    this.#stopTimers();
    this.pingTimer = setInterval(() => {
      if (!this.mounted || this.mode !== 'net') return;
      void this.#measureLatency();
    }, PING_EVERY_MS);
    this.playersTimer = setInterval(() => {
      if (!this.mounted || this.mode !== 'net') return;
      void this.#loadPlayers();
    }, PLAYERS_REFRESH_MS);
    this.roomTimer = setInterval(() => {
      if (!this.mounted || this.mode !== 'net' || !this.joined) return;
      void this.#refreshRoom();
    }, ROOM_REFRESH_MS);
  }

  #stopTimers() {
    for (const key of ['pingTimer', 'playersTimer', 'roomTimer']) {
      if (this[key]) clearInterval(this[key]);
      this[key] = null;
    }
  }

  // ────────────────────────────────────────────────────────────── 延迟徽章
  /**
   * 往返延迟：GET /api/app/ping 是宿主/服务端自带的轻量回显（不经过游戏逻辑），
   * 用 performance.now() 前后差值算本机到本机服务的往返，和「进游戏后的操作延迟」口径一致。
   */
  async #measureLatency() {
    if (typeof fetch !== 'function') return;
    const t0 = performance.now();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS) : null;
    try {
      const res = await fetch(`/api/app/ping?_=${Date.now()}`, { cache: 'no-store', signal: ctrl?.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json().catch(() => null);
      const ms = Math.max(0, Math.round(performance.now() - t0));
      this.latency = ms;
      this.latencyAt = Date.now();
      this.latencyError = '';
    } catch (err) {
      this.latency = null;
      this.latencyError = err?.name === 'AbortError' ? '延迟探测超时' : '延迟探测失败';
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.render();
  }

  /** 延迟徽章：绿（≤100ms ✓）/ 橙（>100ms，注明「超过 100ms 目标」）/ 灰（未测出）。 */
  #latencyBadge() {
    const ms = this.latency;
    if (ms === null || ms === undefined) {
      return h('span.latency-badge.unknown', { title: this.latencyError || '正在测量本机往返延迟' },
        icon('signal', 'sm'), h('span', { text: this.latencyError || '本机延迟 —' }));
    }
    const over = ms > LATENCY_TARGET_MS;
    return h('span.latency-badge.' + (over ? 'over' : 'ok'), {
      title: over ? `本机往返延迟 ${ms}ms，超过 100ms 目标` : `本机往返延迟 ${ms}ms，在 100ms 目标内`,
    },
    icon('signal', 'sm'),
    h('span', { text: `本机延迟 ${ms}ms` }),
    h('span.latency-tail', { text: over ? '超过 100ms 目标' : '✓' }));
  }

  // ────────────────────────────────────────────────────────────── 自动填入 / 探测
  /**
   * 用配置面板里保存的「默认服务器源」自动填入高级区（v0.7 语义，原样保留）：
   *   1. 只在输入框还空着时填；2. 已有值绝不覆盖；3. 本机是服务器源时不填（那时 origin 固定是 location.origin）。
   * Token 在 /api/config 里是脱敏的，所以必须走 GET /api/net/admin/token 取全文。
   * 任何一步失败都静默跳过：这是锦上添花的便利功能，不能影响联机页主流程。
   */
  async #autofillFromConfig() {
    if (this.autoFilled) return;
    this.autoFilled = true;
    // v0.8 修正：原来这里有一句 `if (this.info?.ok) return;`——本机是服务器源时直接
    // 跳过自动填，结果 Token / 用户名永远空着（用户实测：展开「高级」只有两个空框）。
    // 服务器源时 origin 确实恒为 location.origin 不用填，但 Token 和用户名一样得填上：
    // 服务器源上「本机就是服务器」，Token 取服务端已落盘的那一条（/api/net/admin/token），
    // 用户名照样抽一个「玩家NNN」。所以这里只在服务器源时跳过 origin，不跳过整段。
    // 标记「这次填的值是自动来的」：用户手改输入框时 Lobby/NetPanel 的 input 处理器会清掉，
    // 之后任何重渲染都不会再覆盖他手填的内容。
    let filled = false;
    // ① 服务器源地址：配置里的优先，没有就退到本机 origin ——
    //    「本机是客户端」时用户的实际场景是「先在本机起服务，再连自己或别人的地址」，
    //    留一个空输入框逼他手打一长串 https://xxx.ts.net 没意义（用户原话：
    //    「如果token, url等空着直接自动填写默认参数」）。
    // 本机是服务器源时 origin 就是 location.origin，输入框那一行是只读展示，不用填也不用打标。
    if (!this.info?.ok && !this.origin.trim()) {
      let url = '';
      try {
        const res = await fetch('/api/config', { cache: 'no-store' });
        if (res.ok) {
          const body = await res.json().catch(() => null);
          const configured = body?.effective?.online?.serverUrl;
          if (typeof configured === 'string' && configured.trim()) url = configured.trim();
        }
      } catch {
        // 配置接口不可用：继续走下面的默认值
      }
      if (!url) url = normalizeOrigin(location.origin);
      if (url) {
        this.origin = url;
        this.originDefaulted = true; // 标记「这是自动填的」，输入框旁给一行提示
        filled = true;
      }
    }
    // ② Token：服务端已经发过就复用，没发过就用 randomToken() 现生成一条 256 位十六进制。
    //    注意不能再调 /api/net/admin/token 之外的东西——那条接口在没建房时回空。
    if (!this.token.trim()) {
      let token = '';
      try {
        const res = await fetch('/api/net/admin/token', { cache: 'no-store' });
        if (res.ok) {
          const body = await res.json().catch(() => null);
          const got = body?.ok !== false ? body?.token : '';
          if (typeof got === 'string' && got.trim()) token = got.trim();
        }
      } catch {
        // 同上
      }
      if (!token) token = randomToken();
      this.token = token;
      this.tokenDefaulted = true;
      filled = true;
    }
    // ③ 用户名：空着就抽一个「玩家NNN」，省得本地校验拦在第一步。
    if (!this.username.trim()) {
      this.username = defaultName();
      this.usernameDefaulted = true;
      filled = true;
    }
    if (filled) {
      this.autoFilledHint = true;
      // 重建输入框必须带「这次是自动填的」标记：render() 会把整个 .net2-panel 用
      // replaceChildren 换掉，输入框的 value 只来自 this[key]，所以只改 state 不 render
      // 是看不到的——这也正是之前「自动填了但用户看不见」的另一半原因。
      this.render();
    }
  }

  /**
   * 探测本机是否就是服务器源。GET /api/net/info 所有实例都回 200，判定只看 body.serverSource：
   * true → 本机是服务器源；false 或 404（老服务端）→ 客户端，需要手填服务器源。
   */
  async #probe() {
    if (this.busy === 'probe') return;
    this.busy = 'probe';
    this.render();
    let info;
    try {
      const res = await fetch('/api/net/info', { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        const isSource = body?.ok === true && body?.serverSource === true;
        info = isSource
          ? { ok: true, origin: location.origin, name: String(body.name ?? '服务器源'), rooms: Number(body.rooms) || 0, idKeyHint: String(body.idKeyHint ?? '') }
          : { ok: false, error: '本机是客户端（serverSource: false）——请填写服务器源的地址与 Token' };
      } else if (res.status === 404) {
        info = { ok: false, error: '本机是客户端（服务器源没有 /api/net/info）——请填写服务器源的地址与 Token' };
      } else {
        info = { ok: false, error: `探测失败（HTTP ${res.status}），请手填服务器源地址与 Token` };
      }
    } catch (err) {
      info = { ok: false, error: `探测失败：${err?.message ?? err}` };
    }
    this.info = info;
    this.probed = true;
    this.busy = '';
    if (info.ok && !this.origin) this.origin = info.origin;
    this.render();
  }

  /** 本机 ID 密钥（联机身份标识）；读不到就返回空串，由 submit 提示。 */
  async #loadIdKey() {
    try {
      const res = await fetch('/api/local/id', { cache: 'no-store' });
      if (!res.ok) return '';
      const body = await res.json();
      if (body?.ok !== true) return '';
      if (!this.probed && body.serverSource === true && !this.info?.ok) {
        this.info = { ok: true, origin: location.origin, name: '服务器源', rooms: 0, idKeyHint: '' };
        if (!this.origin) this.origin = location.origin;
      }
      return String(body.idKey ?? '');
    } catch {
      return '';
    }
  }

  /** 现在生效的服务器源地址（服务器源模式恒为 location.origin）。 */
  get activeOrigin() {
    const raw = this.info?.ok ? this.origin || this.info.origin : this.origin;
    return String(raw ?? '').trim().replace(/\/+$/, '');
  }

  /**
   * 本机 TailScale 的公开地址（https://xxx.ts.net）。
   * 只在本机是服务器源时有意义：/api/net/admin 在跨机器访问时是 403，失败一律静默返回空串。
   * 优先 tailscale.url（服务端已拼好 https://dnsName），退一步用 dnsName 自己拼。
   */
  async #loadTailscaleUrl() {
    try {
      const res = await fetch('/api/net/admin', { cache: 'no-store' });
      if (!res.ok) return '';
      const body = await res.json().catch(() => null);
      const ts = body?.tailscale || {};
      let url = String(ts.url || '').trim();
      if (!url && ts.dnsName) url = 'https://' + String(ts.dnsName).trim();
      if (!/^https:\/\//i.test(url)) return '';
      return url.replace(/\/+$/, '');
    } catch {
      return '';
    }
  }

  /**
   * 分享文案里的服务器源：本机地址（127.0.0.1 / localhost / [::1]）同学根本连不上，
   * 所以本机当服务器源时自动换成 TailScale 的 https://xxx.ts.net；拿不到就原样返回。
   * 客户端模式连的是别人的公网/局域网地址，不动。
   */
  #shareOrigin() {
    const raw = this.activeOrigin;
    if (!raw) return '';
    let host = '';
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      return raw;
    }
    const local = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host === '0.0.0.0';
    return local && this.tailscaleUrl ? this.tailscaleUrl : raw;
  }

  // ────────────────────────────────────────────────────────────── 大厅玩家列表
  /**
   * 「在线玩家（n）」的数据源三级降级：
   *   1. GET /api/lobby/players（P1 新接口）→ players[];
   *   2. 没有这个接口 → GET /api/net/admin 的 rooms.list 把 members 摊平成玩家；
   *   3. 两个都不行（跨机器访问 admin 一定 403）→ 至少把「本房间里的人」/「自己」显示出来，绝不报错崩掉。
   */
  async #loadPlayers() {
    const origin = this.activeOrigin;
    if (!origin) {
      this.players = this.#selfEntry();
      this.playersFallback = true;
      this.playersLoaded = true;
      this.render();
      return;
    }
    const direct = await this.client.listPlayers(origin);
    if (direct.ok) {
      this.players = direct.players.map((p) => ({
        name: String(p?.username ?? p?.name ?? '匿名'),
        role: String(p?.role ?? '') || (p?.characterId ? '玩家' : '玩家'),
        online: p?.online !== false,
        hint: String(p?.idKeyHint ?? ''),
        characterId: String(p?.characterId ?? ''),
      }));
      this.playersFallback = false;
      this.playersLoaded = true;
      this.playersSource = '/api/lobby/players';
      this.render();
      return;
    }
    this.playersSource = '/api/lobby/players → 404，已退回 rooms.list';
    const rooms = await this.client.listRooms(origin);
    if (rooms.ok) {
      const seen = new Set();
      const acc = [];
      for (const room of rooms.rooms) {
        const owner = String(room?.owner ?? '—');
        for (const m of Array.isArray(room?.members) ? room.members : []) {
          const name = String(m ?? '');
          if (!name || seen.has(name)) continue;
          seen.add(name);
          acc.push({ name, role: name === owner ? '房主' : '玩家', online: true, hint: '', characterId: '' });
        }
      }
      for (const extra of this.#selfEntry()) if (!seen.has(extra.name)) acc.push(extra);
      this.players = acc;
      this.playersFallback = true;
      this.playersLoaded = true;
      this.render();
      return;
    }
    this.players = this.#selfEntry();
    this.playersFallback = true;
    this.playersLoaded = true;
    this.render();
  }

  /** 兜底条目：自己 + 本房间成员（不依赖任何新接口）。 */
  #selfEntry() {
    const name = (this.joined?.username || this.username.trim() || '（本机玩家）').slice(0, 24);
    const acc = [{ name, role: this.joined ? (this.joined.role ?? '房主') : '本机', online: true, hint: '', characterId: '' }];
    for (const m of this.joined?.members ?? []) {
      const n = String(m ?? '');
      if (n && n !== name) acc.push({ name: n, role: '玩家', online: true, hint: '', characterId: '' });
    }
    return acc;
  }

  // ────────────────────────────────────────────────────────────── 进房 / 建房
  /** 取 ID 密钥 → 调 /api/net/join → 成功就 window.open 新窗口；失败把状态码 + 原因原样显示。 */
  async submit(type) {
    if (this.busy) return;
    this.error = '';
    this.notice = '';
    // 本机是服务器源且没填 Token 时自动生成一个 256 位十六进制口令
    if (this.info?.ok && !this.token.trim()) this.token = randomToken();
    if (!this.info?.ok && !this.origin.trim()) {
      this.error = '请先填写服务器源地址';
      return this.render();
    }
    if (!this.token.trim()) {
      this.error = '请填写服务器源 Token';
      return this.render();
    }
    if (!isInviteToken(this.token)) {
      this.error = 'Token 应为 256 位十六进制';
      return this.render();
    }
    if (type === 'join' && !this.roomId.trim()) {
      this.error = '请填写要加入的房间号';
      return this.render();
    }
    this.busy = type;
    this.render();
    if (!this.idKey) this.idKey = await this.#loadIdKey();
    if (!this.idKey) {
      this.busy = '';
      this.error = '联机需要 ID 密钥：本机没有可用的 /api/local/id';
      return this.render();
    }
    const origin = this.activeOrigin;
    const username = this.username.trim() || defaultName();
    this.username = username;
    const params = { origin, token: this.token.trim(), idKey: this.idKey, username };
    const out = type === 'create'
      ? await this.client.create(params)
      : await this.client.joinRoom({ ...params, roomId: this.roomId.trim(), invCode: this.invCode.trim() });
    this.busy = '';
    if (!out.ok) {
      // 服务端一律 500 + {ok:false,error:'房间不存在'|'房间 Token 不匹配'|…}：原样展示，带上状态码
      const status = Number(out.status ?? this.client.lastStatus) || 0;
      const rawDetail = String(out.error ?? '').trim() || '请求失败';
      // getJson 拿不到 JSON body 时会兜一句「请求失败（HTTP 500）」——那种情况只用状态码 + 兜底原因
      const detail = /^请求失败（HTTP \d+）$/.test(rawDetail) ? '服务器源返回了非 JSON 内容' : rawDetail;
      const reason = /^\d{3}\b/.test(detail) ? detail : (status ? `${status} ${detail}` : detail);
      this.error = type === 'join' ? `加入房间失败：${reason}` : `创建房间失败：${reason}`;
      this.render();
      return;
    }
    this.origin = origin;
    this.token = this.token.trim();
    this.#enterRoom(out, type === 'create');
  }

  /**
   * 建房/进房成功后：拼服务端 URL 契约的**页面链接**并立刻 window.open 到新窗口。
   * URL 契约见 server/net/RoomManager.js:24-49：
   *   ${origin}/?token={token}&id={ID密钥}&type={create|join}&roomid={房间号}&invcode={邀请码}&username={用户名}
   * window.open 必须与用户点击同一个调用栈（有用户手势才不被拦），所以这里先 open 再渲染。
   */
  #enterRoom(out, created) {
    const room = out.room ?? {};
    const origin = this.activeOrigin;
    const roomId = String(room.id ?? '');
    const invCode = String(room.invCode ?? '');
    const type = created ? 'create' : 'join';
    const q = new URLSearchParams({
      token: this.token,
      id: this.idKey,
      type,
      roomid: roomId,
      invcode: invCode,
      username: this.username,
    });
    // 纯网页版：房间窗口还是这个网页（file:// 下的本页），带上 src= 服务器源，由页面自己连远端 /lobby。
    const webShell = globalThis.__JICAN_WEB__;
    if (webShell && typeof webShell.saveSetting === 'function') {
      webShell.saveSetting('source', origin);
      webShell.saveSetting('token', this.token);
    }
    const openUrl = (webShell && typeof webShell.roomUrl === 'function')
      ? webShell.roomUrl(origin, q)
      : `${origin}/?${q.toString()}`;
    // 邀请链接是「页面链接」（点开就是联机页），不是 /api/net/join 的 JSON 链接
    let inviteUrl = buildInviteUrl({ origin, token: this.token, idKey: this.idKey, username: '' });
    if (!inviteUrl) inviteUrl = `${origin}/?token=${encodeURIComponent(this.token)}&id=${encodeURIComponent(this.idKey)}&type=join`;
    // 先落 marker 再 window.open：新窗口连上服务器的速度可能快过 window.open 返回，
    // 之前放后面会让大厅窗口在这几毫秒里被当成普通大厅页，收到 spectator 横幅后再也不消失。
    try {
      sessionStorage.setItem(ROOM_WINDOW_KEY, openUrl);
    } catch {
      /* 隐私模式：忽略 */
    }
    let landed = false;
    try {
      const win = window.open(openUrl, '_blank', 'width=1200,height=760');
      landed = Boolean(win);
    } catch {
      landed = false;
    }
    this.joined = {
      roomId,
      token: this.token,
      invCode,
      username: this.username,
      type,
      role: created ? '房主' : (Array.isArray(room.members) && room.members.includes(this.username) ? '玩家' : '观战'),
      owner: String(room.owner ?? this.username),
      members: Array.isArray(room.members) ? room.members.slice() : [this.username],
      createdAt: room.createdAt ?? null,
      openUrl,
      inviteUrl,
      wsPath: out.wsPath ?? '',
      landed,
      blocked: !landed,
    };
    this.error = '';
    this.notice = landed
      ? '已在新的游戏窗口里打开房间'
      : '新窗口被浏览器拦截了：点下面的链接手动打开';
    this.render();
    void this.#refreshRoom();
    void this.#loadPlayers();
    this.onRoomChange?.(this.joined);
  }

  /** 进房后定时刷新成员（GET /api/net/room?roomid=）。房间没了就提示原样错误，不清状态。 */
  async #refreshRoom() {
    if (!this.joined) return;
    const origin = this.activeOrigin;
    const out = await this.client.readRoom(origin, this.joined.roomId);
    if (!out.ok) {
      this.roomError = describeError(out.status, out.error);
      this.render();
      return;
    }
    this.roomError = '';
    if (out.room) {
      this.joined.members = Array.isArray(out.room.members) ? out.room.members.slice() : this.joined.members;
      this.joined.owner = String(out.room.owner ?? this.joined.owner);
      this.joined.invCode = String(out.room.invCode ?? this.joined.invCode);
      this.render();
    }
  }

  /** 离开房间：服务端没有 leave 路由，直接本地清状态（新窗口关掉即离开）。 */
  leaveRoom() {
    this.joined = null;
    this.roomError = '';
    this.notice = '已离开房间：关掉那个游戏窗口就彻底退出了';
    try {
      sessionStorage.removeItem(ROOM_WINDOW_KEY);
    } catch {
      /* 隐私模式：忽略 */
    }
    this.render();
    void this.#loadPlayers();
    this.onRoomChange?.(null);
  }

  // ────────────────────────────────────────────────────────────── 渲染
  render() {
    const root = this.root;
    if (!root) return;
    const isSolo = this.mode === 'solo';
    // 切换控件在房间页上整块不画（用户原话：「新的联机窗口去掉单机/联机按钮，因为那是联机窗口肯定是联机」）。
    // 用「不调用 h()」而不是 hidden：留一个 display:none 的按钮，读屏与 tab 键序里它还在。
    const seg = this.roomPage ? null : h('div.segmented.net-mode', { role: 'group', 'aria-label': '游戏模式' },
      h('button', { 'aria-pressed': String(isSolo), onclick: () => { this.mode = 'solo'; this.render(); this.onModeChange?.('solo'); } }, icon('user', 'sm'), '单机'),
      h('button', {
        'aria-pressed': String(!isSolo),
        onclick: () => {
          this.mode = 'net';
          this.playersLoaded = false;
          this.render();
          // 大厅底部的主按钮要跟着切成「打开房间窗口」，所以模式变化必须通知大厅重画。
          this.onModeChange?.('net');
          // 每次切到联机都重探一次（本机角色可能刚变），自动填入只做一次
          void this.refresh();
        },
      }, icon('signal', 'sm'), '联机'));
    // 单机模式下 #netBody() 不渲染 —— 但 replaceChildren 是原生方法，不会像 h() 那样跳过 null，
    // 传进去的 null 会被当成字符串「null」插进 DOM（大厅顶部那枚孤零零的 "null" 就是它）。
    // 所以这里必须用 ...[] 展开来做条件子节点。
    // 房间页连顶栏也不再画：那里原本只有「单机/联机」和延迟徽章，而延迟徽章在房间头里已有一枚，
    // 画两遍只会让窗口顶部多一条空空的绿条。
    root.replaceChildren(
      ...(this.roomPage ? [] : [h('div.net2-bar', {},
        ...(seg ? [seg] : []),
        h('span.spacer'),
        this.#latencyBadge())]),
      ...(isSolo ? [] : [this.#netBody()]));
  }

  /** 一行文字输入（统一加英文键入约束）。 */
  #textInput(label, key, opts = {}) {
    // 用户手填过就撤掉「已自动填入」标记：之后再重渲染也不会被默认值盖掉，
    // 而且标记撤掉后 hint 文案同步消失，用户能确认「这是我自己的值」。
    const defaultedKey = `${key}Defaulted`;
    const badge = this[defaultedKey]; // 渲染时定值：手改后下一次渲染徽标自然消失
    const input = h('input.input' + (opts.mono ? '.net-mono' : ''), {
      type: 'text',
      placeholder: opts.placeholder ?? '',
      value: this[key] ?? '',
      'aria-label': label,
      ...(this[defaultedKey] ? { 'data-defaulted': '1' } : {}),
      ...(opts.readonly ? { readonly: true } : {}),
      // 不整块重渲染（会丢焦点、光标跳到开头），只就地撤掉这个输入框的「默认值」外观，
      // 并把对应的徽标元素一并藏掉——state 里的 Defaulted 标记也清掉，下次重渲染就不会再出现。
      oninput: (e) => {
        this[key] = e.target.value;
        try {
          const webShell = globalThis.__JICAN_WEB__;
          if (webShell && typeof webShell.saveSetting === 'function') {
            webShell.saveSetting(key === 'origin' ? 'source' : key, e.target.value);
          }
        } catch { /* 纯网页版以外的环境没有这个钩子 */ }
        if (this[defaultedKey] && String(e.target.value).trim() !== '') {
          this[defaultedKey] = false;
          e.target.removeAttribute('data-defaulted');
          const label = e.target.closest('.net2-field')?.querySelector('.net2-defaulted');
          if (label) label.remove();
        }
      },
    });
    forceEnglishInput(input);
    // 「自动填入」徽标贴在标签右边，用户一眼能看出这个值是系统填的、可以改。
    const badgeEl = badge
      ? h('span.net2-defaulted', { text: '已自动填入', title: '系统按默认参数自动填的，直接改就行' })
      : null;
    return {
      input,
      row: h('label.net2-field', {}, h('span.net2-field-label', {}, h('span', { text: label }), badgeEl), input),
    };
  }

  /**
   * 房间页（独立游戏窗口）只画「这间房的数据」。
   *
   * 用户原话：「去掉弹出窗口中的创建房间和加入房间标签页，只显示下面的数据」——
   * 这个窗口是点「创建 / 加入」之后弹出来的，再摆一遍那两个按钮既多余又容易误点
   * （点「创建」会在已有房间上再开一间）。所以这里只留房间号、在线玩家和一个选座入口，
   * 「高级（服务器源 / Token / ID 密钥）」也不再画：凭据已经在地址栏/sessionStorage 里了。
   */
  #roomPageBody() {
    // 房间页地址栏最后只剩 ?room=<id>（进房后 token 被擦掉存进 sessionStorage），
    // welcome 之前也要能说清"这是哪间房"，所以三个来源依次取。
    const q = new URLSearchParams(location.search);
    const roomId = this.joined?.roomId || this.roomId || q.get('room') || q.get('roomid') || '';
    return h('div.net2-panel.card.net2-roompage',
      h('div.net2-head', {},
        icon('door', 'sm'),
        h('div.net2-role', {}, h('span', { text: roomId ? `房间 ${roomId} · 已进入` : '联机房间' })),
        h('span.spacer'),
        this.#latencyBadge()),
      this.error ? h('div.net2-notice.err', { text: this.error }) : null,
      this.notice ? h('div.net2-notice', {}, icon('check', 'sm'), h('span', { text: this.notice })) : null,
      this.onPickSeat
        ? h('div.net2-roompage-ops', {},
          h('button.btn.primary.sm', {
            type: 'button',
            onclick: () => this.onPickSeat(),
          }, icon('user', 'sm'), '选座 / 换座位'),
          h('span.net2-hint.quiet', { text: '自己的座位随时能换；已被别人坐的格子会显示是谁、且不能点。' }))
        : null,
      this.#startBlock(),
      this.#playersList());
  }

  /**
   * 房间页的「开始游戏」：房主可点，成员/观战者永远禁用（等房主开局）。
   *
   * 状态不在这里存：main.js 把 roomState 的 isOwner/started/busy 通过 startInfo 注进来，
   * 点击再回 main.js 的 doStartGame（走 POST /api/lobby/room/start），不另开第二条开局链路。
   * 房间页之前把开局按钮藏在大厅 overlay 下面的房间面板里，用户在这个窗口里根本点不到。
   */
  #startBlock() {
    if (typeof this.startInfo !== 'function') return null;
    const st = this.startInfo() || {};
    const owner = st.isOwner === true;
    const started = st.started === true;
    const busy = st.busy === true;
    const canStart = owner && !started && !busy;
    const label = started ? '游戏已开始' : busy ? '正在开始…' : '开始游戏';
    const hint = started
      ? '这一局已经开始，房间已锁定，等这局结束。'
      : owner
        ? '只有你能点：按当前座位和参数开始这一局，已选座位的人会一起进游戏。'
        : '只有房主能开始游戏；你可以先选/换座位，等房主开始。';
    return h('div.net2-roompage-start', {},
      h('button.btn.primary', {
        type: 'button',
        disabled: !canStart,
        title: started ? '这一局已经开始' : owner ? '开始这一局' : '只有房主可以开始游戏',
        onclick: () => { if (canStart) void this.onStartGame?.(); },
      }, icon('play', 'sm'), label),
      h('div.net2-hint.quiet', { text: hint }));
  }

  #netBody() {
    if (this.roomPage) return this.#roomPageBody();
    const info = this.info;
    const isSource = !!info?.ok;
    const roleText = this.busy === 'probe'
      ? '正在探测本机角色…'
      : isSource
        ? `本机是服务器源（${info.name}，当前 ${info.rooms} 间房）`
        : '本机是客户端：需要填写服务器源地址与 Token（在「高级」里）';

    return h('div.net2-panel.card',
      // 头部：一行状态。只放角色文字 + 延迟，不再重复「在线玩家（N）」——
      // 那是下面 .net2-playershead 的职责，重复两遍反而像两个不同的计数。
      h('div.net2-head', {},
        h('span.net2-dot' + (isSource ? '.on' : '.warn')),
        h('div.net2-role', {}, h('span', { text: roleText })),
        h('span.spacer'),
        this.#latencyBadge()),

      // 两个入口：创建 / 加入。加入展开后是一行「房间号 + 邀请码」。
      h('div.net2-cta', {},
        h('button.btn.primary.net2-big', { disabled: !!this.busy, onclick: () => this.submit('create') },
          icon('door', 'sm'), this.busy === 'create' ? '正在创建房间…' : '创建房间'),
        h('button.btn.net2-big', {
          'aria-pressed': String(this.showJoin),
          disabled: !!this.busy,
          onclick: () => { this.showJoin = !this.showJoin; this.render(); },
        }, icon('signal', 'sm'), '加入房间')),

      this.showJoin ? this.#joinRow() : null,

      this.error ? h('div.net2-notice.err', { text: this.error }) : null,
      this.notice ? h('div.net2-notice', {}, icon('check', 'sm'), h('span', { text: this.notice })) : null,

      this.joined ? this.#roomCard() : null,
      this.#reopenFallback(),
      this.#playersList(),
      this.#advanced(),

      this.autoFilledHint
        ? h('div.net2-hint', {
          text: isSource
            ? '已自动填入默认参数（本机 Token / 用户名）——直接点「创建房间」即可；在「高级」里可以改。'
            : '已自动填入默认参数（服务器源 URL / 256 位 Token / 用户名）——直接点「创建房间」或「加入房间」即可；'
              + '你手填后不会再被覆盖，想改也可以展开「高级」改。',
        })
        : null);
  }

  /**
   * 「再次打开游戏窗口」被拦截时的兜底链接。
   * #roomCard 的 .net2-blocked 只在 this.joined 存在时才画，而"重开"也可能发生在一个
   * 只从地址栏捡到凭据的页面（joined 为 null）；那种场合用户更需要一条能点的链接，
   * 否则只能看到一句"被浏览器拦截了"却无从下手。
   */
  #reopenFallback() {
    const url = this.reopenBlockedUrl || '';
    if (!url || this.joined) return null;
    return h('div.net2-blocked', {},
      icon('warn', 'sm'),
      h('div', {},
        h('div', { text: '新窗口被浏览器拦截了，点这里手动打开：' }),
        h('a.net2-openlink', { href: url, target: '_blank', rel: 'noopener', text: '打开游戏窗口' })));
  }

  /** 加入房间：一行房间号 + 邀请码 + 「加入」。 */
  #joinRow() {
    const room = this.#textInput('房间号', 'roomId', { placeholder: '6 位数字', mono: true });
    const inv = this.#textInput('邀请码', 'invCode', { placeholder: '8 位邀请码', mono: true });
    return h('div.net2-join', {},
      room.row,
      inv.row,
      h('button.btn.primary.sm', { disabled: !!this.busy, onclick: () => this.submit('join') },
        this.busy === 'join' ? '正在加入…' : '加入',
        icon('door', 'sm')),
      h('div.net2-hint.quiet', { text: '房间号与邀请码向房主要；也可以直接点房主发的邀请链接。' }));
  }

  /** 进房成功后的卡片：房间号 / 角色 / 在线成员 / 弹出链接 / 邀请链接 + 复制 + 离开。 */
  #roomCard() {
    const j = this.joined;
    const copy = (text, label) => {
      const done = () => { this.notice = `已复制${label}`; this.render(); };
      const fail = () => { this.notice = `复制失败：请手动选中下面的文本复制${label}`; this.render(); };
      try {
        const p = navigator.clipboard?.writeText?.(text);
        if (p && typeof p.then === 'function') p.then(done, fail);
        else if (navigator.clipboard?.writeText) done();
        else fail();
      } catch {
        fail();
      }
      this.copySeq += 1;
    };
    const kv = (label, value, mono = true) => h('div.net2-kv', {},
      h('span.net2-kv-label', { text: label }),
      h('code' + (mono ? '.net2-mono' : ''), { text: String(value ?? '—') }),
      h('button.btn.icon.sm', { title: '复制', onclick: () => copy(String(value ?? ''), label) }, icon('book', 'sm')));

    const members = Array.isArray(j.members) ? j.members : [];
    return h('div.net2-room',
      h('div.net2-room-head', {},
        icon('door', 'sm'),
        h('span', { text: j.type === 'create' ? '房间已创建' : '已进入房间' }),
        h('span.tag.ok', { text: j.role }),
        h('span.spacer'),
        h('button.btn.sm', { onclick: () => this.leaveRoom() }, icon('exit', 'sm'), '离开房间')),

      j.blocked
        ? h('div.net2-blocked', {},
          icon('warn', 'sm'),
          h('div', {},
            h('div', { text: '新窗口被浏览器拦截了，点这里手动打开：' }),
            h('a.net2-openlink', { href: j.openUrl, target: '_blank', rel: 'noopener', text: '打开游戏窗口' })))
        : h('div.net2-openline', {}, icon('check', 'sm'),
          h('span', { text: '游戏已经在新窗口里打开了；关掉那个窗口即退出房间。' }),
          h('a.net2-openlink.small', { href: j.openUrl, target: '_blank', rel: 'noopener', text: '再打开一次' })),

      h('div.net2-kvs', {},
        kv('房间号', j.roomId),
        kv('Token', maskToken(j.token)),
        kv('邀请码', j.invCode),
        kv('房主', j.owner)),

      this.#noticeCopy(j),

      h('div.net2-members', {},
        icon('user', 'sm'),
        h('span', { text: `在线成员（${members.length}）：${members.join('、') || '—'}` }),
        this.roomError ? h('span.net2-room-err', { text: `（刷新失败：${this.roomError}）` }) : null),

      this.#inviteRow(j),

      h('div.net2-hint.quiet', { text: '把邀请链接发给同学：对方点开就是联机页，进去后能看到同一间房里所有玩家。' }));
  }

  /**
   * 复制到剪贴板 + 反馈一行 notice（#roomCard 里的 copy() 是这个的简化版，两者共用同一套兜底逻辑）。
   * 没有 navigator.clipboard（http 非安全上下文、旧 WebView2）时也能走 execCommand 兜底，
   * 实在不行就提示手动选中——绝不假装复制成功。
   */
  copyText(text, label) {
    const ok = () => { this.notice = `已复制${label}`; this.render(); };
    const fail = () => { this.notice = `复制失败：请手动选中下面的文本复制${label}`; this.render(); };
    const legacy = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const done = typeof document.execCommand === 'function' && document.execCommand('copy');
        document.body.removeChild(ta);
        if (done) ok();
        else fail();
      } catch {
        fail();
      }
    };
    try {
      // undefined 也算「没有 API」（http 非安全上下文里 navigator.clipboard 整个是 undefined），
      // 所以这里用 ?. 取，拿不到就直接走 execCommand 兜底，别把 undefined 当成功。
      const p = navigator.clipboard?.writeText?.(text);
      if (p && typeof p.then === 'function') p.then(ok, legacy);
      else legacy();
    } catch {
      legacy();
    }
    this.copySeq += 1;
  }

  /**
   * 「复制房间提示语」：把房号 / **完整 256 位 token** / 邀请码拼成 6 行文案，一键复制给同学。
   *
   * 为什么不复用 kv() 里那行 maskToken：那行是给屏幕看的打码版（只留 8 位），
   * 而这里要的是**可以真的拿去用**的明文——同学把整串粘进「高级」区的 Token 框就能进房。
   * token 不合法时直接拦下并提示去高级区重新读取，绝不把半截 token 复制出去。
   */
  #noticeCopy(j) {
    const tokenOk = FULL_TOKEN.test(String(j.token ?? ''));
    // 名字用房主名（= 创建者），服务器源自动从 127.0.0.1 换成 TailScale 地址；不含 ID 密钥。
    const noticeArgs = (room) => ({
      name: room.owner || this.username,
      roomId: room.roomId,
      token: room.token,
      invCode: room.invCode,
      origin: this.#shareOrigin(),
    });
    const text = roomNoticeText(noticeArgs(j));
    return h('div.net2-copy',
      h('div.net2-copyrow', {},
        h('button.btn.sm', {
          onclick: () => {
            // 以 this.joined 为准再取一次明文（j 与 this.joined 是同一个对象，这里只是显式表达意图）
            const tk = String(this.joined?.token ?? '');
            if (!FULL_TOKEN.test(tk)) {
              this.error = 'Token 不是完整的 256 位，请到高级区重新读取';
              this.render();
              return;
            }
            // .trim()：去掉尾部空白，保证行数/长度判定干净
            const body = roomNoticeText(noticeArgs(this.joined)).trim();
            if (!body) {
              this.error = 'Token 不是完整的 256 位，请到高级区重新读取';
              this.render();
              return;
            }
            this.error = '';
            this.copyText(body, '房间提示语');
          },
        }, icon('book', 'sm'), '复制房间提示语'),
        h('span.net2-hint.quiet', { text: tokenOk ? '含完整 256 位 token 与服务器源，不含 ID 密钥' : 'Token 不完整，请到高级区重新读取' })),
      // 注意：dom.js 的 h() 对字符串 props 一律走 setAttribute，而 textarea 的内容不在文本节点里
      // （写在子节点里根本不显示），所以这里把文案当**子节点文本**传进去，不用 text prop。
      h('textarea.input.net2-copytext', {
        readonly: true,
        rows: '6',
        'aria-label': '房间提示语（可手动选中复制）',
        onclick: (e) => e.currentTarget.select(),
      }, text || '（Token 不完整，暂时无法生成提示语）'));
  }

  /** 「在线玩家（n）」横向标签：用户名 + 角色 + 在线状态点。 */
  #playersList() {
    const list = Array.isArray(this.players) ? this.players : [];
    const listCount = list.length;
    const body = list.length
      ? h('div.net2-players', {}, ...list.slice(0, 60).map((p) =>
        h('span.net2-player' + (p.online ? '.online' : ''),
          h('span.net2-dot', { 'aria-hidden': 'true' }),
          h('span.net2-player-name', { text: p.name }),
          p.role ? h('span.net2-player-role', { text: p.role }) : null)))
      : h('div.net2-hint.quiet', { text: '还没有其他玩家，把邀请链接发给同学吧' });
    return h('div.net2-playersbox', {},
      h('div.net2-playershead', {},
        icon('user', 'sm'),
        h('span', { text: `在线玩家（${listCount}）` }),
        h('span.spacer'),
        h('button.btn.icon.sm', { title: '刷新玩家列表', onclick: () => { void this.#loadPlayers(); } }, icon('refresh', 'sm'))),
      body,
      this.playersFallback && this.playersSource
        ? h('div.net2-hint.quiet', { text: `玩家列表来自房间汇总（${this.playersSource}）` })
        : null);
  }

  /**
   * 邀请链接一行：优先本地 buildInviteUrl 拼出来的**页面链接**（立即可用、不需要再等接口）；
   * 服务器源若已实现 GET /api/net/room/{id}/invite 就用它返回的 url（带房号，点开直接进这间房）。
   * 拿不到就退回本地链接，绝不显示一条空白的废链接。
   */
  #inviteRow(j) {
    const copy = (text, label) => {
      try {
        const p = navigator.clipboard?.writeText?.(text);
        if (p && typeof p.then === 'function') p.then(() => { this.notice = `已复制${label}`; this.render(); }, () => { this.notice = `复制失败：请手动选中文本复制${label}`; this.render(); });
        else if (navigator.clipboard?.writeText) { this.notice = `已复制${label}`; this.render(); }
        else { this.notice = `复制失败：请手动选中文本复制${label}`; this.render(); }
      } catch {
        this.notice = `复制失败：请手动选中文本复制${label}`;
        this.render();
      }
    };
    if (!j.serverInviteAsked) {
      j.serverInviteAsked = true;
      void this.client.inviteUrlFor(this.activeOrigin, j.roomId, this.username).then((out) => {
        if (out.ok && out.url && this.joined === j) {
          j.serverInviteUrl = out.url;
          this.render();
        }
      });
    }
    const shown = j.serverInviteUrl || j.inviteUrl;
    const input = h('input.input.net2-link', { value: shown, readonly: true, 'aria-label': '邀请链接' });
    forceEnglishInput(input);
    return h('div.net2-linkrow', {},
      input,
      h('button.btn.sm', { onclick: () => copy(shown, '邀请链接') }, icon('book', 'sm'), '复制邀请链接'));
  }

  /**
   * 「再次打开游戏窗口」用的地址：优先进房时留下的 joined.openUrl（它和第一次 window.open 的那条一模一样），
   * 其次拿地址栏现有的 token/id/type/roomid/invcode/username 重拼 —— 场景是"游戏窗口被关了，回来再点一次"，
   * 而进房成功后地址栏会被擦成只剩 ?room=，所以这一步必须能从 query 里把凭据捡回来。
   * 拼不齐（缺 token 或 id）就返回 ''：宁可不给按钮，也不打开一个必然鉴权失败的页面。
   */
  #reopenUrl() {
    const joined = this.joined;
    if (joined?.openUrl) return String(joined.openUrl);
    // 大厅窗口刷新后 joined 没了，但上次打开过的窗口地址还在 sessionStorage 里。
    let saved = '';
    try {
      saved = sessionStorage.getItem(ROOM_WINDOW_KEY) || '';
    } catch {
      /* 隐私模式：忽略 */
    }
    const cred = parseRoomQuery(location.search);
    // 必须真的有一间房：这个按钮是「回到那间房」，不是「用当前身份开个新窗口」。
    // 没有 roomid 时 this.token / this.idKey 也可能有默认值，不能拿来当「进过房间」的证据。
    const roomId = cred.roomid || joined?.roomId || this.roomId || '';
    if (!roomId) return saved;
    const token = cred.token || joined?.token || this.token || '';
    const id = cred.id || this.idKey || '';
    if (!token || !id) return saved;
    const q = new URLSearchParams();
    q.set('token', token);
    q.set('id', id);
    q.set('type', cred.type || joined?.type || 'join');
    const invCode = cred.invcode || joined?.invCode || this.invCode || '';
    const username = cred.username || joined?.username || this.username || '';
    if (roomId) q.set('roomid', roomId);
    if (invCode) q.set('invcode', invCode);
    if (username) q.set('username', username);
    const webShell = globalThis.__JICAN_WEB__;
    return (webShell && typeof webShell.roomUrl === 'function')
      ? webShell.roomUrl(this.activeOrigin, q)
      : `${this.activeOrigin}/?${q.toString()}`;
  }

  /** 高级区那一行：按钮 + 一句说明（说明随能不能拼出地址变化，别让按钮凭空消失却没解释）。 */
  #reopenRow() {
    const url = this.#reopenUrl();
    const btn = h('button.btn.sm', {
      type: 'button',
      disabled: !url,
      title: url ? '按当前房间参数再用新窗口打开一次游戏' : '缺 token / id：先创建或加入一次房间再重开',
      onclick: () => this.reopenGameWindow(),
    }, icon('door', 'sm'), '再次打开游戏窗口');
    return h('div.net2-reopen', {},
      btn,
      h('span.net2-hint.quiet', {
        text: url
          ? '游戏窗口被关掉时，用这里按当前房间参数再开一次。'
          : '还没进过房间：先创建或加入一次房间，这里才能重开游戏窗口。',
      }));
  }

  /**
   * 「再次打开游戏窗口」：和 #enterRoom 里那一发 window.open 同一条路，
   * 连被拦截时的处理也照抄 —— landed 为假就把 openUrl 摊在面板上让用户手点。
   * 不重连、不重建房间：房间本来就还在，这里只是把浏览器窗口再开一个。
   */
  reopenGameWindow() {
    const url = this.#reopenUrl();
    if (!url) {
      this.notice = '';
      this.error = '还没进过房间：先创建或加入一次房间，才能重开游戏窗口';
      this.render();
      return;
    }
    let landed = false;
    try {
      const win = window.open(url, '_blank', 'width=1200,height=760');
      landed = Boolean(win);
    } catch {
      landed = false;
    }
    if (this.joined) {
      this.joined.openUrl = url;
      this.joined.landed = landed;
      this.joined.blocked = !landed;
    }
    this.error = '';
    this.notice = landed
      ? '已再次打开游戏窗口'
      : '新窗口被浏览器拦截了：点下面的链接手动打开';
    // 拦截时要在面板里露出那条可点的链接：#roomCard 只在 joined 存在时画，
    // 所以没 joined 的场合补一个只含链接的小条（复用 .net2-blocked 的外观）。
    this.reopenBlockedUrl = landed ? '' : url;
    this.render();
  }

  /** 大厅底部「打开房间窗口」是否可用：必须有一间房（joined / 地址栏 roomid / 上次打开的窗口地址）。 */
  canReopen() {
    return Boolean(this.#reopenUrl());
  }

  /** 「高级」折叠区：服务器源地址 / Token / ID 密钥 / 用户名。默认收起。 */
  #advanced() {
    const isSource = !!this.info?.ok;
    const head = h('button.net2-advhead', {
      'aria-expanded': String(this.showAdvanced),
      onclick: () => { this.showAdvanced = !this.showAdvanced; this.render(); },
    }, icon('settings', 'sm'), h('span', { text: '高级（服务器源 / Token / ID 密钥）' }),
    h('span.spacer'),
    // 箭头由 .net2-caret 用 CSS 三角画（展开=下指、收起=右指），旁边只留动作名。
    h('span.net2-advlabel', { text: this.showAdvanced ? '收起' : '展开' }),
    h('span.net2-caret'));

    if (!this.showAdvanced) return h('div.net2-adv', {}, head);

    const originRow = isSource
      ? h('div.net2-field', {}, h('span.net2-field-label', { text: '服务器源' }), h('span.net-kv-inline', { text: this.info.origin }))
      : this.#textInput('服务器源 URL', 'origin', { placeholder: 'https://xxxxx.ts.net' }).row;
    const tokenRow = this.#textInput('Token', 'token', { placeholder: '256 位十六进制房间口令', mono: true });
    const nameRow = this.#textInput('用户名', 'username', { placeholder: '显示给同房间的其他玩家' });
    const idKeyText = this.idKey ? `${this.idKey.slice(0, 8)}…（共 ${this.idKey.length} 位）` : '（未读到 /api/local/id）';

    // 「已自动填入」的整体说明：只在自动填过时出现，放在折叠区最前面，用户展开就看到。
    const autoNote = (this.autoFilledHint && !isSource)
      ? h('div.net2-hint.quiet', { text: '下面带「已自动填入」标记的值是系统按默认参数填的，可以直接用，也可以改。' })
      : null;
    return h('div.net2-adv.open', {},
      head,
      h('div.net2-advbody', {},
        autoNote,
        this.#reopenRow(),
        originRow,
        tokenRow.row,
        nameRow.row,
        h('div.net2-field', {},
          h('span.net2-field-label', { text: 'ID 密钥（身份标识，自动读取）' }),
          h('code.net2-mono', { text: idKeyText })),
        h('div.net2-hint.quiet', {
          text: isSource
            ? '上面的 Token 是本机服务端已保存的那一条，已自动填好；加入方必须填同一个 Token。'
            : '本机是服务器源时 Token 可留空，点「创建房间」会自动生成一个；加入方必须填同一个 Token。',
        })));
  }
}

// 保留旧导出名：老代码 import { randomToken } from './ui/NetPanel.js' 的写法不至于炸掉
export { randomToken, buildInviteUrl };
export default NetPanel;
