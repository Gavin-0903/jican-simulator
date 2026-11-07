// 联机（需求 3）：与「服务器源」的 HTTP 接口打交道。
// 全部是 GET：/api/net/info、/api/net/join、/api/net/room，跨域由服务端放行（access-control-allow-origin: *）。
// 本模块只做请求与结果整理，不做 UI；房号/邀请码/成员一律以服务端返回为准。

const IDKEY_RE = /^[0-9a-fA-F]{256}$/;

/** 服务器源地址规范化：用户可能只填 https://xxxxx.ts.net 或带尾斜杠。 */
export function normalizeOrigin(raw) {
  const text = String(raw ?? '').trim();
  if (!text || /^(null|undefined|file:)/i.test(text)) return '';
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const u = new URL(withScheme);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

export function isValidIdKey(key) {
  return IDKEY_RE.test(String(key ?? '').trim());
}

/** Token（房间口令）校验：提示写的是 256 位十六进制，实际服务端用 ID 密钥做格式校验。 */
export function checkToken(raw) {
  const token = String(raw ?? '').trim();
  if (!token) return { ok: false, message: '请填写 Token' };
  if (!IDKEY_RE.test(token)) return { ok: false, message: '应为 256 位十六进制' };
  return { ok: true, value: token.toLowerCase() };
}

/** 把任意 HTTP 响应体里的错误原样取出来展示。 */
function errorText(body, status) {
  if (body && typeof body === 'object' && body.error) return String(body.error);
  if (typeof body === 'string' && body) return body;
  return `请求失败（HTTP ${status}）`;
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { method: 'GET', cache: 'no-store', mode: 'cors' });
  } catch (err) {
    return { ok: false, error: `连不上服务器源：${err?.message ?? err}`, code: 'NET' };
  }
  let body = null;
  const text = await res.text().catch(() => '');
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) return { ok: false, status: res.status, error: errorText(body, res.status), code: body?.code ?? null, body };
  if (!body || typeof body !== 'object' || body.ok !== true) {
    return { ok: false, status: res.status, error: errorText(body, res.status), code: body?.code ?? null, body };
  }
  return { ok: true, data: body };
}

/** 本机 ID 密钥（身份标识）：GET /api/local/id。取不到就返回空串，由 UI 提示「联机需要 ID 密钥」。 */
export async function fetchLocalId() {
  try {
    const res = await fetch('/api/local/id', { cache: 'no-store' });
    if (!res.ok) return { ok: false, idKey: '', serverSource: false };
    const body = await res.json();
    return { ok: body?.ok === true && !!body.idKey, idKey: String(body?.idKey ?? ''), serverSource: body?.serverSource === true };
  } catch {
    return { ok: false, idKey: '', serverSource: false };
  }
}

/**
 * 探测某个地址上是否跑着「服务器源」。
 * 该接口现在所有实例都返回 200，所以必须看 body.serverSource === true 才算服务器源；
 * 老服务端只在服务器源挂这个接口，客户端会拿 404，同样按「不是服务器源」处理。
 */
export async function probeNetInfo(origin) {
  const base = normalizeOrigin(origin);
  if (!base) return { ok: false, error: '请填写服务器源地址（形如 https://xxxxx.ts.net）' };
  const out = await getJson(`${base}/api/net/info`);
  if (!out.ok) return { ok: false, error: out.error, serverSource: false };
  if (out.data.serverSource !== true) return { ok: false, serverSource: false, error: '该地址是联机客户端，不是服务器源' };
  return { ok: true, serverSource: true, origin: base, name: String(out.data.name ?? '服务器源'), rooms: Number(out.data.rooms) || 0, idKeyHint: String(out.data.idKeyHint ?? '') };
}

export class RoomClient {
  constructor(store) {
    this.store = store;
    this.room = null; // 最近一次成功创建/加入的房间 { id, token, invCode, owner, members }
    this.wsPath = ''; // 服务端给的 ws 路径（本版本仍连当前页面 host，暂不使用）
    // 最近一次 #join 的细节（P2-B 新增，不影响 create/joinRoom 的返回结构）：
    // 除了上面那份「整理过的结果」，这里额外留下 HTTP 状态码、完整请求 URL 与服务端原始 body，
    // 联机面板失败时要原样显示「404 房间不存在」这种状态码 + 中文原因，不能只给一句话。
    this.lastStatus = 0;
    this.lastUrl = '';
    this.lastBody = null;
  }

  /** 创建房间。params: { origin, token, idKey, username } */
  create({ origin, token, idKey, username }) {
    return this.#join({ origin, token, idKey, username, type: 'create' });
  }

  /** 加入房间。params: { origin, token, idKey, username, roomId, invCode } */
  joinRoom({ origin, token, idKey, username, roomId, invCode }) {
    return this.#join({ origin, token, idKey, username, type: 'join', roomId, invCode });
  }

  /** 按契约拼 /api/net/join 并取出房间信息。 */
  async #join({ origin, token, idKey, username, type, roomId = '', invCode = '' }) {
    const base = normalizeOrigin(origin);
    if (!base) return { ok: false, error: '请填写服务器源地址（形如 https://xxxxx.ts.net）' };
    if (!token) return { ok: false, error: '请填写 Token' };
    if (type === 'join' && !roomId) return { ok: false, error: '请填写要加入的房间号' };
    const q = new URLSearchParams({ token, id: idKey, type, roomid: roomId, invcode: invCode, username: username || '匿名' });
    const url = `${base}/api/net/join?${q.toString()}`;
    const out = await getJson(url);
    // 失败时把 HTTP 状态码留在实例上（getJson 已经按 res.status 填好了），联机面板据此显示
    // 「404 房间不存在」这种「状态码 + 服务端中文原因」的组合；返回结构保持原样不变。
    this.lastStatus = out.ok ? 0 : Number(out.status) || 0;
    this.lastUrl = url;
    this.lastBody = out.ok ? out.data : (out.body ?? null);
    if (!out.ok) return { ok: false, error: out.error, code: out.code, url, status: Number(out.status) || 0 };
    const room = out.data.room ?? null;
    if (!room) return { ok: false, error: '服务端没有返回房间信息', url };
    this.room = room;
    this.wsPath = String(out.data.wsPath ?? '');
    return {
      ok: true,
      url,
      room,
      created: out.data.created === true,
      wsPath: this.wsPath,
      // 邀请链接：同一接口，type=join + 房号 + 邀请码，别人点开即可加入
      inviteUrl: `${base}/api/net/join?${new URLSearchParams({ token, id: idKey, type: 'join', roomid: String(room.id), invcode: String(room.invCode), username: username || '匿名' }).toString()}`,
    };
  }

  /** 只读一次房间信息、不改实例状态（失败带回 HTTP 状态码，便于「404 房间不存在」式提示）。 */
  async readRoom(origin, roomId) {
    const base = normalizeOrigin(origin);
    if (!base || !roomId) return { ok: false, error: '缺少服务器源地址或房间号', status: 0 };
    const out = await getJson(`${base}/api/net/room?roomid=${encodeURIComponent(roomId)}`);
    if (!out.ok) return { ok: false, error: out.error, status: Number(out.status) || 0 };
    return { ok: true, room: out.data.room ?? null };
  }

  /** 刷新房间信息（成员变化）：GET /api/net/room?roomid=xxxx */
  async refresh(origin, roomId) {
    const base = normalizeOrigin(origin);
    if (!base || !roomId) return { ok: false, error: '缺少服务器源地址或房间号' };
    const out = await getJson(`${base}/api/net/room?roomid=${encodeURIComponent(roomId)}`);
    if (!out.ok) return { ok: false, error: out.error, status: Number(out.status) || 0 };
    this.room = out.data.room ?? this.room;
    return { ok: true, room: this.room };
  }

  /**
   * 读取服务器源的房间列表（大厅玩家列表的数据源之一）。
   * 走 GET /api/net/admin 的 rooms.list：只有本机的设置页才允许访问，所以跨机器时一定失败——
   * 失败不抛错，返回 { ok:false, error, status }，由调用方决定退回哪一份数据。
   */
  async listRooms(origin) {
    const base = normalizeOrigin(origin);
    if (!base) return { ok: false, error: '缺少服务器源地址', status: 0, rooms: [] };
    const out = await getJson(`${base}/api/net/admin`);
    if (!out.ok) return { ok: false, error: out.error, status: Number(out.status) || 0, rooms: [] };
    const list = Array.isArray(out.data?.rooms?.list) ? out.data.rooms.list : [];
    return { ok: true, rooms: list, count: Number(out.data?.rooms?.count) || list.length };
  }

  /**
   * 大厅在线玩家（需求 3）：GET /api/lobby/players → { ok, players:[{idKeyHint,username,characterId,online,role}] }。
   * 该接口由后端 P1 提供；尚未落地时（404 / 非 JSON / 网络错）返回 ok:false，
   * 调用方**必须**退回 listRooms() 的 members 汇总，不能因此把大厅弄崩。
   */
  async listPlayers(origin) {
    const base = normalizeOrigin(origin);
    if (!base) return { ok: false, error: '缺少服务器源地址', status: 0, players: [] };
    const out = await getJson(`${base}/api/lobby/players`);
    if (!out.ok) return { ok: false, error: out.error, status: Number(out.status) || 0, players: [] };
    const players = Array.isArray(out.data?.players) ? out.data.players : [];
    return { ok: true, players };
  }

  /**
   * 服务端生成的邀请（页面）链接：GET /api/net/room/{id}/invite?username= → { ok, url }。
   * P1 尚未落地时同样返回 ok:false，调用方退回本地 buildInviteUrl()。
   */
  async inviteUrlFor(origin, roomId, username = '') {
    const base = normalizeOrigin(origin);
    if (!base || !roomId) return { ok: false, error: '缺少服务器源地址或房间号', status: 0, url: '' };
    const q = new URLSearchParams();
    if (username) q.set('username', username);
    const suffix = q.toString() ? `?${q.toString()}` : '';
    const out = await getJson(`${base}/api/net/room/${encodeURIComponent(roomId)}/invite${suffix}`);
    if (!out.ok) return { ok: false, error: out.error, status: Number(out.status) || 0, url: '' };
    return { ok: true, url: String(out.data?.url ?? '') };
  }
}
