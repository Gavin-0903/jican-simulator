// 联机进房（v0.3）：把"地址栏里的房间参数"翻译成"该连哪条 WebSocket"，并负责把地址栏擦干净。
//
// 为什么要单独一个文件：这段逻辑全是纯字符串/纯函数，既能被 main.js 直接调用，也能被
// tests/unit/room-url.test.js 在 Node 里跑（不碰 DOM、不碰 location）。房间里的事一旦写死在
// main.js 里就只能靠"开着浏览器点一遍"来验证，改一次链接就回归一次，这里把判定抽干净。
//
// 三条硬规则（对应任务书的 1 / 2 / 6）：
//   ① 通道选择：URL 里凑齐了 type(=create|join) + token + id 就走 /lobby（鉴权入口），
//      否则走老的 /ws（本机单机 / 测试）。原 query 一个字符都不改地透传，服务端只认服务端给的那串。
//   ② 地址栏擦除：进房成功（收到 welcome.room）后只留 ?room=<6位房间号>，
//      token / id / invcode 全部从地址栏撤走（截图、复制链接、浏览器历史里都不再泄露密钥），
//      同时写进 sessionStorage，刷新页面时没有 query 也能靠它接回同一个房间。
//   ③ 独立窗口立刻走 /lobby：新窗口带着完整 query 打开，不需要用户再点一次任何按钮。

/** 房间凭据在 sessionStorage 里的键（和 NetClient 的 'jican.session' 同级）。 */
export const ROOM_KEY = 'jican.room';

/** 允许的进房方式（服务端 LobbyGateway.resolve 只认这两个）。 */
export const ROOM_TYPES = Object.freeze(['create', 'join']);

/** 房间号形状：6 位数字（RoomManager.makeRoomId 生成的就是这个）。 */
const ROOM_ID_RE = /^\d{6}$/;

/** 擦除地址栏后留下的 query 参数名。 */
export const ROOM_PARAM = 'room';

/** 凭据里必须留着的那几个键（其余键只在 URL 里用到，不落盘）。 */
const KEEP = ['type', 'token', 'id', 'roomid', 'invcode', 'username'];

/** 把任意入参规整成去空白的字符串（null/undefined → ''）。 */
function str(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * 解析一段 query（可带前导 '?'，也可以是完整 URL，也接受 URLSearchParams / 普通对象）。
 * 返回普通对象，只含 KEEP 里列出的键，值已 trim，空值不落键。
 */
export function parseRoomQuery(input) {
  let q = null;
  if (input instanceof URLSearchParams) q = input;
  else if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return {};
    if (s.startsWith('?')) q = new URLSearchParams(s.slice(1));
    else if (s.includes('?')) q = new URLSearchParams(s.slice(s.indexOf('?') + 1).split('#')[0]);
    else q = new URLSearchParams(s);
  } else if (input && typeof input === 'object') {
    // 普通对象：直接按键取（main.js 把 location.search 塞进来，也允许直接传对象）
    q = new URLSearchParams();
    for (const [k, v] of Object.entries(input)) if (v != null) q.append(k, String(v));
  } else {
    return {};
  }
  const out = {};
  for (const k of KEEP) {
    const v = str(q.get(k));
    if (v) out[k] = v;
  }
  return out;
}

/** 这条 query 是不是"一条完整的进房参数"（缺一个都不算，宁可退回 /ws 也别拿半条参数去撞 404）。 */
export function isRoomJoinQuery(input) {
  const q = parseRoomQuery(input);
  return ROOM_TYPES.includes(q.type) && Boolean(q.token) && Boolean(q.id);
}

/**
 * 选通道并拼出要连的 URL。返回：
 *   { channel:'lobby', path:'/lobby?...', room:true }
 *   { channel:'ws',    path:'/ws',        room:false }
 *
 * origin 只接受 http/https（http → ws、https → wss）；给不出 origin 时按 lobby 处理并只回 path。
 * 为什么 lobby 分支要原样透传 query：服务端 LobbyGateway.resolve 认的就是自己发出去的那串，
 * 前端重排 key 或重新编码会在中文用户名上产生 UA 差异，索性一个字节都不动。
 */
/** 纯网页版：查询串里的 src= 是用户填的服务器源（http(s) 地址），只在本页用，不发给服务端。 */
function remoteWsOrigin(search) {
  let raw = '';
  try {
    const q = new URLSearchParams(str(search).replace(/^\?/, ''));
    raw = str(q.get('src'));
  } catch { raw = ''; }
  if (!raw) {
    try {
      if (typeof localStorage !== 'undefined') raw = str(localStorage.getItem('jican.web.source'));
    } catch { raw = ''; }
  }
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const u = new URL(raw);
    return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`;
  } catch { return ''; }
}

/** 把纯网页版专用的 src= 从 query 里摘掉；没有 src 时原样返回，保证服务端参数一个字节都不变。 */
function stripWebSource(raw) {
  if (raw.indexOf('src=') < 0) return raw;
  try {
    const q = new URLSearchParams(raw);
    q.delete('src');
    return q.toString();
  } catch { return raw; }
}

export function buildConnectionUrl({ search = '', origin = '', protocol = '', host = '' } = {}) {
  const q = str(search);
  const base = str(origin).replace(/\/+$/, '');
  // file://（纯网页版双击打开）没有可用的 origin，new URL('null') 会抛异常：
  // 拿不到 origin 就当"没有 wsOrigin"，退回相对路径，由页面自己决定怎么连。
  let parsedOrigin = null;
  try { parsedOrigin = base && base !== 'null' ? new URL(base) : null; } catch { parsedOrigin = null; }
  const originProtocol = protocol || (parsedOrigin ? parsedOrigin.protocol : '') || 'http:';
  const originHost = str(host) || (parsedOrigin ? parsedOrigin.host : '');
  let wsOrigin = originHost ? `${originProtocol === 'https:' ? 'wss' : 'ws'}://${originHost}` : '';
  // 纯网页版：没有本机 origin，但有用户填的服务器源 → 用服务器源的 ws(s) 地址。
  if (!wsOrigin) wsOrigin = remoteWsOrigin(q);
  if (!isRoomJoinQuery(q)) {
    return { channel: 'ws', path: '/ws', url: wsOrigin ? `${wsOrigin}/ws` : '/ws', room: false };
  }
  const raw = q.startsWith('?') ? q.slice(1) : q.includes('?') ? q.slice(q.indexOf('?') + 1) : q;
  const cleaned = stripWebSource(raw);
  const path = cleaned ? `/lobby?${cleaned}` : '/lobby';
  return { channel: 'lobby', path, url: wsOrigin ? `${wsOrigin}${path}` : path, room: true };
}

/**
 * 决定"这次刷新该带哪条 query"：地址栏没有完整进房参数时，回退到 sessionStorage 里存的那份。
 * 返回 { search, source:'url'|'session'|'none' }。
 * 只回 search 字符串（带前导 '?'），方便调用方直接塞进 useState 之类的状态里。
 */
export function resolveSearch({ search = '', stored = null } = {}) {
  if (isRoomJoinQuery(search)) return { search: str(search), source: 'url' };
  const s = stored && typeof stored === 'object' ? stored : null;
  if (!s) return { search: '', source: 'none' };
  if (!(ROOM_TYPES.includes(str(s.type)) && s.token && (s.id || s.roomid))) return { search: '', source: 'none' };
  const q = new URLSearchParams();
  for (const k of KEEP) {
    const v = str(s[k]);
    if (v) q.set(k, v);
  }
  const qs = q.toString();
  return qs ? { search: `?${qs}`, source: 'session' } : { search: '', source: 'none' };
}

/**
 * 从 welcome 里抽出"值得记下来的房间凭据"。
 * welcome.room 只带 { id, username, role, seat }，token/id/invcode 地址栏里本来就有，
 * 所以这里把两边的信息合起来，token 等字段一律以原始 query 为准（服务端的 room 视图不吐 token）。
 * 没有房间信息时返回 null —— 单机 /ws 连接不会写 sessionStorage。
 */
export function roomCredentialFrom(welcome, search = '') {
  const room = welcome && typeof welcome === 'object' ? welcome.room : null;
  if (!room) return null;
  const q = parseRoomQuery(search);
  const out = { type: q.type || 'create', token: q.token || '', id: q.id || '', invcode: q.invcode || '', username: q.username || str(room.username) };
  const id = str(room.id) || q.roomid;
  if (!ROOM_ID_RE.test(id)) return null;
  out.roomid = id;
  return out;
}

/**
 * 擦除后的 query：只留 ?room=<房间号>。没有房间号时返回 ''（地址栏回到干净的 /）。
 * 为什么只留房间号：房间号本身不含秘密（邀请码和 token 才是钥匙），
 * 但它能让人一眼看出"我现在在 123456 这间房"，也让刷新/复制页面链接时方向不丢。
 */
export function scrubbedQuery(roomId) {
  const id = str(roomId);
  if (!ROOM_ID_RE.test(id)) return '';
  const q = new URLSearchParams();
  q.set(ROOM_PARAM, id);
  return `?${q.toString()}`;
}

/** 从"擦除后的地址栏"里读房间号（刷新时用于 UI 先显示，不等 welcome）。 */
export function readScrubbedRoomId(search = '') {
  const q = parseRoomQueryish(search);
  const v = q.get(ROOM_PARAM) ?? q.get('roomid') ?? '';
  return ROOM_ID_RE.test(v) ? v : '';
}

/* 内部：拿一个 URLSearchParams（parseRoomQuery 只保留白名单键，这里连 room 也要，所以单独来一份）。 */
function parseRoomQueryish(input) {
  const s = str(input);
  try {
    if (!s) return new URLSearchParams();
    if (s.startsWith('?')) return new URLSearchParams(s.slice(1).split('#')[0]);
    if (s.includes('?')) return new URLSearchParams(s.slice(s.indexOf('?') + 1).split('#')[0]);
    return new URLSearchParams(s);
  } catch {
    return new URLSearchParams();
  }
}

/**
 * 服务端 code → 一句人话。
 * key 与服务端 /api/net/room/check 与 /lobby 握手回复体里的 code 完全同名（backend-gateway 契约）：
 *   BAD_REQUEST(400) / ROOM_NOT_FOUND(404) / TOKEN_MISMATCH(404) / INVCODE_MISMATCH(404)
 *   / LOBBY_DISABLED(501) / RATE_LIMIT(429) / INTERNAL(500)
 * 前端自己只额外造一个 NETWORK（fetch 抛异常时用）。
 */
export const LOBBY_CODE_TEXT = Object.freeze({
  BAD_REQUEST: '进房参数不合法（缺少 token / ID 密钥，或 type 写错）',
  ROOM_NOT_FOUND: '房间不存在或已关闭',
  TOKEN_MISMATCH: '房间 Token 不匹配（链接被改过或已过期）',
  INVCODE_MISMATCH: '邀请码不匹配（这是另一个房间的邀请码）',
  LOBBY_DISABLED: '这台服务器没有启用联机大厅',
  RATE_LIMIT: '请求太频繁，等几秒再进',
  INTERNAL: '服务器内部错误，稍后再试',
  NETWORK: '连不上服务器',
});

/**
 * 这些 code 说明"参数本身不对"，重连一万次也一样 —— 前端应当停下来让用户改链接/回大厅。
 * 其余（RATE_LIMIT / INTERNAL / NETWORK）是临时状况，退避重连还有救。
 */
export const LOBBY_FATAL_CODES = Object.freeze(['BAD_REQUEST', 'ROOM_NOT_FOUND', 'TOKEN_MISMATCH', 'INVCODE_MISMATCH', 'LOBBY_DISABLED']);

/** 这些 code 是不是"改链接才能好"。 */
export function isFatalLobbyCode(code) {
  return LOBBY_FATAL_CODES.includes(str(code).toUpperCase());
}

/**
 * 把"连不上 / 握手被拒"翻译成给人看的一句话。纯函数，不碰网络。
 *
 * @param {number} status  HTTP 状态码；浏览器 WS 握手被拒时只给 close(1006)，拿不到状态码 —— 传 0。
 * @param {string} code    服务端 body 里的 code（'ROOM_NOT_FOUND' 等）
 * @param {object} [extra] { roomId, httpStatus } 用于兜底文案里的房间号
 * @returns {string}
 *
 * 分工（与服务端契约一致）：
 *   400 → 地址粘错了，让用户改链接；404 → 房间/钥匙不对，让用户回大厅重新要链接；
 *   1006 + 房间号仍在 → 房间可能不存在或 Token 不匹配（浏览器不给状态码，只能这么猜）。
 */
export function describeLobbyError(status, code, extra = {}) {
  const s = Number(status) || 0;
  const c = str(code).toUpperCase();
  const roomId = str(extra.roomId);
  const where = roomId ? `房间 ${roomId} ` : '';
  if (c && LOBBY_CODE_TEXT[c]) return `${where}${LOBBY_CODE_TEXT[c]}`.trim();
  if (s === 400) return `${where}进房参数不合法（缺少 token / ID密钥，或 type 写错）`.trim();
  if (s === 404) return `${where}鉴权失败（房间不存在或 Token 不匹配）`.trim();
  if (s === 429) return '请求太频繁，等几秒再进';
  if (s === 501) return '这台服务器没有启用联机大厅';
  if (s === 500) return `${where}服务器内部错误，稍后再试`.trim();
  if (s === 0) {
    return where
      ? `${where}鉴权失败（可能房间不存在或 Token 不匹配）`
      : '房间鉴权失败（可能房间不存在或 Token 不匹配）';
  }
  return `${where}进房失败（HTTP ${s}）`.trim();
}

/** 玩家列表的三种角色，以及它们在列表里的显示顺序（越小越靠前）。 */
export const ROLE_RANK = Object.freeze({ owner: 0, spectator: 1, pending: 2 });

/**
 * 玩家列表归一化：服务端 players 数组的字段是约定死的（idKey/username/characterId/online/role/roomId），
 * 这里只做三件事——过滤掉别的房间的人、补默认值、按"房主 → 观战者 → 待审批"排好序。
 * 输入不合法时一律回 []（宁可显示"0 人在线"也不要抛异常把整个 HUD 拖死）。
 */
export function normalizeLobbyPlayers(players, roomId = '') {
  if (!Array.isArray(players)) return [];
  const rid = str(roomId);
  const out = [];
  for (const p of players) {
    if (!p || typeof p !== 'object') continue;
    if (rid && str(p.roomId) && str(p.roomId) !== rid) continue;
    // role 三态：owner（房主）/ spectator（在房里的观战者）/ pending（还在门口等审批）。
    // 旧实现只认 owner，把 pending 一并吞成 spectator —— 房主的「入房申请区」会永远空着，
    // 申请人明明在等，房主却看成"房间里多了一个观战者"。
    const role = p.role === 'owner' ? 'owner' : p.role === 'pending' ? 'pending' : 'spectator';
    out.push({
      idKey: str(p.idKey),
      username: str(p.username) || '（未命名）',
      characterId: p.characterId == null ? null : str(p.characterId),
      online: p.online !== false,
      role,
      roomId: str(p.roomId),
    });
  }
  // 排序：房主 → 观战者 → 待审批。待审批的人排在最后，因为他们"还没进来"，
  // 混在成员里会让人误以为房间里有这个人。
  out.sort((a, b) => {
    const rank = ROLE_RANK[a.role] ?? ROLE_RANK.spectator;
    const rankB = ROLE_RANK[b.role] ?? ROLE_RANK.spectator;
    if (rank !== rankB) return rank - rankB;
    return a.username.localeCompare(b.username, 'zh-Hans-CN');
  });
  return out;
}

/** 在线人数（玩家列表里 online !== false 的人）。 */
export function countOnline(players) {
  if (!Array.isArray(players)) return 0;
  let n = 0;
  for (const p of players) if (p && p.online !== false) n += 1;
  return n;
}

/**
 * HUD 徽章文案：「房间 123456 · 在线 n」。
 * - 没有任何房间信息（单机）→ 返回 ''，调用方据此把徽章整块藏起来；
 * - 玩家列表还没到 → 只显示「房间 123456」，不要显示"在线 0"骗人；
 * - isSpectator 时补一个「观战中」，这是观战者唯一能看到的身份提示。
 */
export function roomBadgeText({ roomId, players = null, isSpectator = false } = {}) {
  const id = str(roomId);
  if (!ROOM_ID_RE.test(id)) return '';
  const parts = [`房间 ${id}`];
  if (Array.isArray(players)) parts.push(`在线 ${countOnline(players)}`);
  if (isSpectator) parts.push('观战中');
  return parts.join(' · ');
}

/** 把"一排人"拆成房主 / 观战者 / 待审批三组（给房间视图用，房主和观战者看到的是同一个列表）。 */
export function splitLobbyPlayers(players) {
  const out = { owner: null, spectators: [], pending: [] };
  for (const p of Array.isArray(players) ? players : []) {
    if (!p || typeof p !== 'object') continue;
    if (p.role === 'owner') {
      if (!out.owner) out.owner = p;
      continue;
    }
    if (p.role === 'pending') out.pending.push(p);
    else out.spectators.push(p);
  }
  return out;
}

/**
 * 房间支持的操作（与服务端 /api/lobby/room/<action> 的路由一一对应）。
 * 前四条是房主专属（v0.4），后两条是座位制（v0.9）：
 *   seat     —— 任何房间成员都能调，但非房主只能改自己那一行（用户名由 LobbyHttp 固定成自己）；
 *   settings —— 只有房主能调（单局时长 / 目标分）。
 */
export const ROOM_ACTIONS = Object.freeze(['start', 'kick', 'approve', 'reject', 'seat', 'settings']);

/** 房主专属操作（其余成员点了也只会被服务端 403，前端不该给按钮）。 */
export const OWNER_ROOM_ACTIONS = Object.freeze(['start', 'kick', 'approve', 'reject', 'settings']);

/**
 * 房间视图里「同意 / 踢出」这类行内按钮该不该出现。
 * 只有房主（seat === true）能看能点，观战者一个按钮都没有 —— 观战者点了也只会被服务端 403，
 * 白给他一个"看起来能操作"的按钮是最容易让人误以为自己是房主的坑。
 */
export function canModerateRoom(view, action = 'kick') {
  const { seat, started } = view && typeof view === 'object' ? view : {};
  if (seat !== true) return false;
  const act = str(action);
  if (!ROOM_ACTIONS.includes(act)) return false;
  // 已经开局之后房间锁了：不再接受新成员，也不该再有人被"同意进来"
  // 座位制（v0.9）：白名单只认房主专属那几条 —— seat 是"任何成员都能坐自己"，但它挂在同一批路由上，
  // 一旦被 canModerateRoom 放行，观战者的行里就会冒出房主专属按钮。所以非白名单一律 false。
  if (!OWNER_ROOM_ACTIONS.includes(act)) return false;
  // 已开局 = 房间锁死：不能再开始，也不能再改参数；但已进来的人仍可被踢（锁的是入房与新参数，不是清场）
  if (started === true) return act !== 'start' && act !== 'settings';
  return true;
}

/**
 * 座位表的纯函数：把「谁坐哪个座位」的判定从 DOM 里抽出来。
 *
 * 输入：
 *   players —— normalizeLobbyPlayers() 的产物（[{username, characterId, online, role}]）；
 *   seats   —— 房间视图里的 seats（{username: characterId}，服务端 Map 序列化来的普通对象）；
 *   roster  —— lobby.roster（[{id, name, role:'student'|'teacher', classId, username}]）。
 * 输出：每个成员一行，字段名就是渲染层直接用的：
 *   { username, online, role, isOwner, characterId, charName, charRole, seatLabel,
 *     isMe, canPick, canAssign }
 *
 * 三条判据（服务端 RoomManager.claimSeat 的同款规则，前端只做"提前说清楚"，不做权限拦）：
 *   ① 座位 = characterId。players 里的 characterId 是「这个人实际在用哪个角色」（只有控制位那台机器才有），
 *      房主给别人指派的座位只在 seats 里 —— 所以 seats 优先，没有座位的人才退回看 players.characterId；
 *   ② 已开局的房间座位锁死：谁都不能再改（isLocked）；
 *   ③ payload 里的 seat 一样：「自己的座位」永远是第一条（房主 = 房主自己那行）。
 */
export function seatRows(players, seats = null, roster = null) {
  const seen = new Set();
  const chars = new Map();
  for (const r of Array.isArray(roster) ? roster : []) {
    if (!r || typeof r !== 'object' || !r.id) continue;
    chars.set(str(r.id), r);
  }
  const table = seats && typeof seats === 'object' ? seats : {};
  const rows = [];
  for (const p of Array.isArray(players) ? players : []) {
    if (!p || typeof p !== 'object') continue;
    const username = str(p.username);
    if (!username) continue;
    // 待审批的人还没进房，不给他在座位表里占一行（否则房主会以为门口的人在房间里）
    if (p.role === 'pending') continue;
    // 同一个用户名只留一条（服务端列表理论上不会重复，重复了也别让座位表出现两行同名）
    if (seen.has(username)) continue;
    seen.add(username);
    const assigned = str(table[username]);
    const characterId = assigned || str(p.characterId) || '';
    const entry = characterId ? chars.get(characterId) : null;
    rows.push({
      username,
      online: p.online !== false,
      role: p.role === 'owner' ? 'owner' : 'spectator',
      isOwner: p.role === 'owner',
      characterId: characterId || null,
      charName: entry ? str(entry.name) || characterId : characterId || '',
      charRole: entry ? str(entry.role) : '',
      seatLabel: characterId ? `${entry ? str(entry.name) || characterId : characterId}` : '',
      isMe: false,
      canPick: true,
      canAssign: false,
    });
  }
  return rows;
}

/**
 * 给 seatRows 的结果补上「这一行是不是我」「我能不能点」。
 * 单独一个函数是为了让"谁是 me"这个每次都要变的参数不污染 seatRows 的纯判定（测试里也能分开钉）。
 */
export function markSeatRows(rows, me, view = {}) {
  const myName = str(me);
  const isOwner = view && typeof view === 'object' && view.seat === true;
  const locked = view && typeof view === 'object' && view.started === true;
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    ...r,
    isMe: Boolean(myName) && r.username === myName,
    canPick: !locked && (isOwner || (Boolean(myName) && r.username === myName)),
    canAssign: isOwner && !locked,
  }));
}

/**
 * 当前已经"选好座位"的人数 / 还没选的人。房主开局前一秒要能一眼看出还差谁。
 * 返回 { seated, unseated:[username...], total }。
 */
export function seatSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const unseated = [];
  let seated = 0;
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    if (r.characterId) seated += 1;
    else unseated.push(str(r.username));
  }
  return { seated, unseated, total: list.length };
}

/**
 * 角色选择网格的分组（大厅去掉选人 UI 之后，选座弹窗 / 大厅身份卡共用这一份）。
 * 返回 [{title, chars:[{id,name,role,username,classId,classLabel}]}]，学生在前、老师在后。
 * 已开局的房间锁座：locked=true 时每个角色再带 takenBy（被别人坐了的人名），渲染层据此置灰。
 */
export function rosterGrid(roster, { locked = false, seats = null, me = '' } = {}) {
  const myName = str(me);
  const table = seats && typeof seats === 'object' ? seats : {};
  const takenBy = new Map();
  for (const [who, id] of Object.entries(table)) {
    const cid = str(id);
    if (cid) takenBy.set(cid, str(who));
  }
  const groups = { student: [], teacher: [] };
  for (const r of Array.isArray(roster) ? roster : []) {
    if (!r || typeof r !== 'object' || !r.id) continue;
    const role = r.role === 'teacher' ? 'teacher' : 'student';
    const who = takenBy.get(str(r.id)) ?? '';
    groups[role].push({
      id: str(r.id),
      name: str(r.name) || str(r.id),
      role,
      username: str(r.username),
      classId: Number(r.classId) || 0,
      classLabel: role === 'teacher' ? '老师' : `${Number(r.classId) || 1} 班`,
      // 别人坐着 = 置灰；自己坐着 = 可以点（点了还是自己，不算抢）
      takenBy: who && who !== myName ? who : '',
      isMine: Boolean(myName) && who === myName,
      disabled: locked || Boolean(who && who !== myName),
    });
  }
  const sortFn = (a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN');
  const out = [];
  if (groups.student.length) out.push({ key: 'student', title: '学生', chars: groups.student.sort(sortFn) });
  if (groups.teacher.length) out.push({ key: 'teacher', title: '老师', chars: groups.teacher.sort(sortFn) });
  return out;
}

/** 房间参数里的两个数字（单局分钟 / 目标分）→ 可读文案。null = 用默认值。 */
export function settingsLabel(settings = null, fallback = null) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const dur = Number(s.durationMs);
  const target = Number(s.targetScore);
  const defDur = Number(fallback && typeof fallback === 'object' ? fallback.durationMs : NaN);
  const defTarget = Number(fallback && typeof fallback === 'object' ? fallback.targetScore : NaN);
  const minutes = Number.isFinite(dur) && dur > 0 ? Math.round(dur / 60000) : Number.isFinite(defDur) && defDur > 0 ? Math.round(defDur / 60000) : null;
  const score = Number.isFinite(target) && target > 0 ? Math.round(target) : Number.isFinite(defTarget) && defTarget > 0 ? Math.round(defTarget) : 0;
  const parts = [];
  if (minutes !== null) parts.push(`单局 ${minutes} 分钟`);
  parts.push(score ? `目标 ${score} 分` : '不限时结束（看积分）');
  return parts.join(' · ');
}

/**
 * 房间参数 → POST /api/lobby/room/settings 的 body（只带改了的键；两者都空 = 清空回默认）。
 * 校验与 RoomManager.setSettings 对齐：时长 30s–4h，目标分 0–1000000（0 = 不限）。
 * 返回 { ok, body } 或 { ok:false, error }：前端先把话说清楚，别等服务器 400。
 */
export function settingsPatch({ minutes = '', targetScore = '' } = {}) {
  const body = {};
  const mRaw = str(minutes);
  if (mRaw) {
    const m = Number(mRaw);
    if (!Number.isFinite(m) || m < 0.5 || m > 240) return { ok: false, error: '单局时长要在 0.5 到 240 分钟之间' };
    body.durationMs = Math.round(m * 60000);
  }
  const tRaw = str(targetScore);
  if (tRaw) {
    const t = Number(tRaw);
    if (!Number.isFinite(t) || t < 0 || t > 1_000_000) return { ok: false, error: '目标分要在 0 到 1000000 之间' };
    body.targetScore = Math.round(t);
  }
  return { ok: true, body };
}

/**
 * 单机模式该用哪个角色开局（大厅不再让人选人之后，这是唯一的兜底）。
 *
 * 规则：
 *   ① lastChar 合法（roster 里真有这个 id）就用它 —— 玩家上次玩谁就还是谁；
 *   ② 否则取 roster 里第一个学生（按 id 排序，s1-01 在最前）；
 *   ③ 一个学生都没有（配置被改坏）才退到第一个老师；roster 为空返回 null。
 * 返回 roster 里那一条（渲染层要 name/role），不是裸 id。
 */
export function defaultSoloCharacter(roster, lastChar = '') {
  const list = (Array.isArray(roster) ? roster : []).filter((r) => r && typeof r === 'object' && r.id);
  if (!list.length) return null;
  const want = str(lastChar);
  if (want) {
    const hit = list.find((r) => str(r.id) === want);
    if (hit) return hit;
  }
  const sorted = [...list].sort((a, b) => str(a.id).localeCompare(str(b.id), 'zh-Hans-CN'));
  return sorted.find((r) => r.role !== 'teacher') ?? sorted[0];
}

/**
 * 房主那条「开始游戏」按钮的文案与可点状态。
 * 判据只有两条：是不是房主座位、房间是不是已经开局了。
 * 注意「有没有选角色」不在这里判 —— 那只在服务端 startRoom 里才知道（400 NO_CHARACTER），
 * 前端不去猜（一猜就会和 Lobby.js 的选择角色状态漂移）。
 */
export function startButtonState(view, busy = false) {
  const { seat, started } = view && typeof view === 'object' ? view : {};
  if (started === true) return { text: '已开始', disabled: true, locked: true };
  if (seat !== true) return { text: '等待房主开始', disabled: true, locked: false };
  if (busy) return { text: '正在开始…', disabled: true, locked: false };
  return { text: '开始游戏', disabled: false, locked: false };
}

/** 房间锁定时给所有人看的那一行提示（没开局时返回 ''，调用方据此不渲染）。 */
export function roomLockNote(started, pendingCount = 0) {
  if (started !== true) return '';
  const n = Number(pendingCount);
  return n > 0
    ? `房间已锁定，不再接受新成员（还有 ${n} 条申请没处理）`
    : '房间已锁定，不再接受新成员';
}

/**
 * 观战者能做什么：只有"看"和"回大厅看"。
 * 服务端 MessageRouter 会把这些指令一律回 E_SPECTATOR，但前端不该靠"发出去被拒"来当权限检查——
 * 那会在观战者屏幕上刷一路红字。所以 main.js 在发送前先用这里问一句。
 */
export const SPECTATOR_BLOCKED = new Set([
  'join', 'start', 'leave', 'pause', 'set.speed', 'item.buy', 'item.upgrade', 'item.use', 'input.action', 'jc.commit',
]);

/** 这条上行指令观战者能不能发。move 也拦：观战者不该推自己的坐标。 */
export function canSendAsRole(role, type) {
  if (role !== 'spectator') return true;
  const t = str(type);
  // move 不挂在 ACTION 上，是单独的消息类型：观战者不该把自己的坐标推给服务端
  if (t === 'input.move') return false;
  return !SPECTATOR_BLOCKED.has(t);
}

/**
 * 观战者能发的**连接层**指令白名单（心跳 / 重同步）。
 * 除它之外的任何上行一律拦掉：白名单而不是黑名单，是因为黑名单漏一条就等于
 * 观战者能对着服务端发那条指令，靠 E_SPECTATOR 兜底会刷一屏红字。
 * 热路径（每帧的 input.move）必须先走 canSendAsRole 的精确判定，再落到这里，
 * 免得字符串 Set 查找变成新开销。
 */
export const SPECTATOR_ALLOWED = new Set(['ping', 'resync']);

/** 观战者这条上行是否直接放行（连接层保活用）。 */
export function canSendAsRoleStrict(role, type) {
  if (role !== 'spectator') return true;
  return SPECTATOR_ALLOWED.has(str(type));
}

/** 只有房主座位（welcome.room.seat === true）能开始游戏；其余人来了也只能看。 */
export function canStartGame(welcome) {
  return Boolean(welcome && welcome.room && welcome.room.seat === true);
}

export default {
  ROOM_KEY,
  ROOM_PARAM,
  ROOM_TYPES,
  parseRoomQuery,
  isRoomJoinQuery,
  buildConnectionUrl,
  resolveSearch,
  roomCredentialFrom,
  scrubbedQuery,
  readScrubbedRoomId,
  describeLobbyError,
  normalizeLobbyPlayers,
  countOnline,
  roomBadgeText,
  canSendAsRole,
  canSendAsRoleStrict,
  canStartGame,
  SPECTATOR_BLOCKED,
  SPECTATOR_ALLOWED,
  LOBBY_CODE_TEXT,
  LOBBY_FATAL_CODES,
  isFatalLobbyCode,
  ROLE_RANK,
  splitLobbyPlayers,
  ROOM_ACTIONS,
  OWNER_ROOM_ACTIONS,
  canModerateRoom,
  startButtonState,
  roomLockNote,
  seatRows,
  markSeatRows,
  seatSummary,
  rosterGrid,
  settingsLabel,
  settingsPatch,
  defaultSoloCharacter,
};