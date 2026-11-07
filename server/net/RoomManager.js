// 联机「服务器源」：房间注册表 + 违规封禁 + URL 协议解析。
// 需求 3：房间号 + Token 校验匹配才能加入，否则 500；同一用户同时开多个房间视为人机攻击，
// 连续违规 3 次 → 该服务器源对该用户 ID 密钥返回 500（封禁）。
// 本模块只做内存态管理（进程内），不落盘：服务器源重启等同于清空，符合「临时联机」的产品预期。

import { ERR } from '../../shared/constants.js';

export const MAX_ROOMS_PER_USER = 1;
export const STRIKE_LIMIT = 3;
export const BAN_MS = 24 * 60 * 60 * 1000;
export const INVCODE_LEN = 8;

const randCode = (len) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
};

export const makeRoomId = () => String(Math.floor(100000 + Math.random() * 900000));
export const makeToken = () => randCode(INVCODE_LEN);

/**
 * URL 模板（需求 3）：
 * https://xxxxxxx.ts.net?token={token}&id={ID密钥}&type={create|join}&roomid={房间号}&invcode={邀请码}&username={用户名}
 */
export function parseRoomUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return { ok: false, code: ERR.BADMSG, message: '服务器源地址不是合法 URL' };
  }
  const q = u.searchParams;
  const out = {
    origin: `${u.protocol}//${u.host}`,
    token: q.get('token') ?? '',
    idKey: q.get('id') ?? '',
    type: q.get('type') ?? '',
    roomId: q.get('roomid') ?? '',
    invCode: q.get('invcode') ?? '',
    username: q.get('username') ?? '',
  };
  if (!out.token) return { ok: false, code: ERR.BADMSG, message: '缺少 token' };
  if (!out.idKey) return { ok: false, code: ERR.BADMSG, message: '缺少 id（ID 密钥）' };
  if (out.type !== 'create' && out.type !== 'join') return { ok: false, code: ERR.BADMSG, message: 'type 必须是 create 或 join' };
  if (out.type === 'join' && !out.roomId) return { ok: false, code: ERR.BADMSG, message: '加入房间必须带 roomid' };
  return { ok: true, url: out };
}

export function buildRoomUrl(origin, { token, idKey, type, roomId = '', invCode = '', username = '' }) {
  const q = new URLSearchParams({ token, id: idKey, type, roomid: roomId, invcode: invCode, username });
  return `${origin}/?token=${q.get('token')}&id=${q.get('id')}&type=${q.get('type')}&roomid=${q.get('roomid')}&invcode=${q.get('invcode')}&username=${q.get('username')}`;
}

export class RoomManager {
  constructor({ logger = console, now = () => Date.now(), banMs = BAN_MS, strikeLimit = STRIKE_LIMIT } = {}) {
    this.log = logger;
    this.now = now;
    this.banMs = banMs;
    this.strikeLimit = strikeLimit;
    this.rooms = new Map(); // roomId → { id, ownerId, token, invCode, username, members:Set, createdAt }
    this.strikes = new Map(); // idKey → { count, bannedUntil, lastAt }
  }

  /** 违规计数：连续 3 次 → 封禁。 */
  strike(idKey, why) {
    const rec = this.strikes.get(idKey) ?? { count: 0, bannedUntil: 0, lastAt: 0 };
    rec.count += 1;
    rec.lastAt = this.now();
    if (rec.count >= this.strikeLimit) {
      rec.bannedUntil = this.now() + this.banMs;
      rec.count = 0;
      this.log.warn?.(`[room] ID 密钥 ${idKey.slice(0, 12)}… 连续违规，已封禁（${why}）`);
    }
    this.strikes.set(idKey, rec);
    return rec;
  }

  isBanned(idKey) {
    const rec = this.strikes.get(idKey);
    if (!rec?.bannedUntil) return false;
    if (rec.bannedUntil <= this.now()) {
      rec.bannedUntil = 0;
      return false;
    }
    return true;
  }

  strikeCount(idKey) {
    return this.strikes.get(idKey)?.count ?? 0;
  }

  /** 结清一次违规（成功行为清零）。 */
  forgive(idKey) {
    this.strikes.delete(idKey);
  }

  byUser(idKey) {
    return [...this.rooms.values()].filter((r) => r.ownerId === idKey);
  }

  /**
   * 建房。reused=true 表示「这个人本来就开着同一个房间」（同一 idKey + 同一 username + 同一 token），
   * 直接复用而不累计违规 —— 刷新页面/重连都会走这里。
   * 注意「同一 ID 只能一间房」由调用方（LobbyHttp 的 /api/net/room）用 byUser().length 判，
   * 这里保留 MAX_ROOMS_PER_USER 兜底。
   */
  create({ idKey, username, token = makeToken(), invCode = makeToken() }) {
    if (this.isBanned(idKey)) return { ok: false, code: ERR.FORBIDDEN, message: '该 ID 密钥已被本服务器源封禁', status: 500 };
    const mine = this.byUser(idKey);
    let room = mine.find((r) => r.username === username && r.token === token);
    if (room) return { ok: true, room, reused: true };
    if (mine.length >= MAX_ROOMS_PER_USER) {
      // 同一用户同时开多个房间 → 判定为人机攻击，累计违规
      const rec = this.strike(idKey, '同一用户重复创建房间');
      return { ok: false, code: ERR.FORBIDDEN, message: `同一用户只能开一个房间（违规 ${rec.count}/${this.strikeLimit}），连续 ${this.strikeLimit} 次将被封禁`, status: 500 };
    }
    let id = makeRoomId();
    while (this.rooms.has(id)) id = makeRoomId();
    room = {
      id,
      ownerId: idKey,
      token,
      invCode,
      username,
      members: new Set([username]),
      createdAt: this.now(),
      // 开局状态位（v0.8）：房主点「开始游戏」后置 true，此后不再接受新成员。
      started: false,
      // 被房主拒绝/踢出的人（用户名）。join 时先查它 —— 被踢的人不该能靠重新排队回来。
      kicked: new Set(),
      // 入房申请队列：{ idKey, username, at }。join 不再直接成为成员，要房主审批。
      pending: [],
      // 座位表（v0.9）：username → characterId。联机窗口不再走「选角色」流程，
      // 玩家进来先选一个座位（= 一个角色），房主也能替成员指派/清空。
      // 房主的座位就是 ownerSeat，同时也是 LobbyGateway.characters 里的那条（两处保持一致）。
      seats: new Map(),
      // 房主设的游戏参数（v0.9）：只覆盖 lobbyInfo 里那几个数值，null/undefined 的键表示「用默认」。
      // 开局时作为 overrides 传给 controller.startRound，不写任何全局配置。
      settings: { durationMs: null, targetScore: null },
    };
    // idKey → 用户名：房主是第一个登记的。之后 approve 进来的成员、以及 join 时
    // 已通过 token + 邀请码校验的人，都会在这里留下一条。
    room.ids = new Map([[String(idKey), String(username)]]);
    this.rooms.set(id, room);
    this.log.info?.(`[room] 房间 ${id} 已创建（${username}），邀请码 ${invCode}`);
    return { ok: true, room, created: true };
  }

  /**
   * 加入房间。v0.8 起不再「进来就是成员」，而是**排队等房主审批**：
   * 鉴权通过后把人放进 room.pending，房主 approve 才进 members。
   *
   * 拒绝优先级（顺序有意义）：封禁 → 房间不存在 → 已被移出（KICKED）→ 已开局（ROOM_STARTED）
   * → token → 邀请码。被踢的人先于「已开局」判，是因为他的语义是「你被请出去了」而不是
   * 「这局已经开始了」，前端提示完全不同。
   */
  join({ idKey, username, roomId, token, invCode }) {
    if (this.isBanned(idKey)) return { ok: false, code: ERR.FORBIDDEN, message: '该 ID 密钥已被本服务器源封禁', status: 500 };
    const room = this.rooms.get(String(roomId));
    // 房间被房主清除了也是这条：404 ROOM_NOT_FOUND，不能报 500 E_STATE ——
    // 「房间没了」是用户点「清除房间」的正常结果，前端按 code 分支跳回大厅，不该当成服务端故障。
    if (!room) return { ok: false, code: 'ROOM_NOT_FOUND', message: '房间不存在或已关闭', status: 404 };
    if (this.isKicked(room, username)) return { ok: false, code: 'KICKED', message: '你已被房主移出房间', status: 403 };
    if (room.started) return { ok: false, code: 'ROOM_STARTED', message: '房主已开始游戏，不再接受新成员', status: 403 };
    // 房间号 + Token 校验匹配才允许加入
    if (room.token !== token) return { ok: false, code: ERR.FORBIDDEN, message: '房间 Token 不匹配', status: 500 };
    if (room.invCode !== invCode) return { ok: false, code: ERR.FORBIDDEN, message: '邀请码不匹配', status: 500 };
    // 走到这里 token 与邀请码都已校验通过，可以信任「这个 idKey 就叫这个名」。
    this.bindIdentity(room, idKey, username);
    // 房主自己（同名）进来不算申请，直接就是成员
    if (username === room.username) {
      room.members.add(username);
      this.forgive(idKey);
      return { ok: true, room, pending: false };
    }
    // 已经在房里的人重复 join 不算新申请（幂等：不动队列长度）
    if (room.members.has(username)) {
      this.forgive(idKey);
      return { ok: true, room, pending: false };
    }
    this.addPending(room, { idKey, username });
    this.forgive(idKey);
    return { ok: true, room, pending: true };
  }

  /**
   * 记下「某个 idKey 在这间房里叫什么」。HTTP 的 seat 路由只带 idKey，
   * 要判断「他动的是自己那一行还是别人的」就必须知道这个 idKey 对应的用户名。
   * 只在 token / 邀请码已经校验通过的路径上调用（create / join），
   * 所以这里写进去的身份是可以信的 —— 别人没法拿自己的 idKey 冒充一个名字。
   */
  bindIdentity(room, idKey, username) {
    const key = String(idKey ?? '').trim();
    const name = String(username ?? '').trim();
    if (!room || !key || !name) return;
    if (!(room.ids instanceof Map)) room.ids = new Map();
    room.ids.set(key, name);
  }

  /** 某个 idKey 在这间房里登记的用户名（没登记过返回 null）。 */
  identityOf(room, idKey) {
    const key = String(idKey ?? '').trim();
    if (!room || !key || !(room.ids instanceof Map)) return null;
    return room.ids.get(key) ?? null;
  }

  /**
   * 这个名字在这间房里已经被哪个 idKey 认领了（没人认领返回 null）。
   * 用来自查「ws 直连补绑身份」时别把别人的名字抢过来：邀请链接里 username 是前端自己填的，
   * 没有这张排他表，任何一个拿得到链接的人都能把自己的 idKey 绑到房主/别人的名字上。
   */
  identityOwner(room, username) {
    const name = String(username ?? '').trim();
    if (!room || !name || !(room.ids instanceof Map)) return null;
    for (const [key, bound] of room.ids) {
      if (bound === name) return key;
    }
    return null;
  }

  /** 是否被这个房间移出过（按用户名判：观战者没有可比对的 idKey）。 */
  isKicked(room, username) {
    if (!room || !(room.kicked instanceof Set)) return false;
    return room.kicked.has(String(username ?? ''));
  }

  /**
   * 幂等地把人放进申请队列：同一个用户名只留一条，重复申请只刷新时间戳。
   * 为什么按 username 去重而不是 idKey：观战者进房只需要用户名，idKey 可能为空串。
   */
  addPending(room, { idKey, username, at = this.now() }) {
    const name = String(username ?? '');
    if (!name || !Array.isArray(room.pending)) return null;
    const hit = room.pending.find((p) => p.username === name);
    if (hit) {
      hit.at = at;
      hit.idKey = String(idKey ?? '') || hit.idKey;
      return hit;
    }
    const item = { idKey: String(idKey ?? ''), username: name, at };
    room.pending.push(item);
    return item;
  }

  /**
   * 房主开局：置 started=true。
   * 只有房主能开局（ownerId 必须是操作者），否则前端一个观战窗口就能把房间锁死。
   */
  start(roomId, operatorIdKey) {
    const room = this.rooms.get(String(roomId));
    if (!room) return { ok: false, code: ERR.STATE, message: '房间不存在或已关闭', status: 500 };
    if (String(room.ownerId) !== String(operatorIdKey ?? '')) return { ok: false, code: 'NOT_OWNER', message: '只有房主可以开始游戏', status: 403 };
    room.started = true;
    return { ok: true, room };
  }

  /**
   * 房主踢人（或拒绝申请后踢出）。
   * 三个副作用：进 kicked 黑名单、从 members 删掉、从 pending 队列删掉。
   * 不能踢房主自己 —— 否则房间会留下一个 ownerId 指向不存在成员的空壳。
   */
  kick(roomId, operatorIdKey, username) {
    const room = this.rooms.get(String(roomId));
    if (!room) return { ok: false, code: ERR.STATE, message: '房间不存在或已关闭', status: 500 };
    if (String(room.ownerId) !== String(operatorIdKey ?? '')) return { ok: false, code: 'NOT_OWNER', message: '只有房主可以踢人', status: 403 };
    const name = String(username ?? '').trim();
    if (!name) return { ok: false, code: ERR.BADMSG, message: '缺少 username', status: 400 };
    if (name === room.username) return { ok: false, code: 'CANNOT_KICK_OWNER', message: '不能把房主自己移出房间', status: 400 };
    if (!(room.kicked instanceof Set)) room.kicked = new Set();
    room.kicked.add(name);
    room.members.delete(name);
    if (Array.isArray(room.pending)) room.pending = room.pending.filter((p) => p.username !== name);
    return { ok: true, room };
  }

  /** 房主同意一条入房申请：从 pending 移到 members（已被踢的人不许借审批回来）。 */
  approve(roomId, operatorIdKey, username) {
    const room = this.rooms.get(String(roomId));
    if (!room) return { ok: false, code: ERR.STATE, message: '房间不存在或已关闭', status: 500 };
    if (String(room.ownerId) !== String(operatorIdKey ?? '')) return { ok: false, code: 'NOT_OWNER', message: '只有房主可以审批入房申请', status: 403 };
    const name = String(username ?? '').trim();
    if (!name) return { ok: false, code: ERR.BADMSG, message: '缺少 username', status: 400 };
    if (this.isKicked(room, name)) return { ok: false, code: 'KICKED', message: '该玩家已被移出房间，请先让其重新申请', status: 403 };
    const idx = Array.isArray(room.pending) ? room.pending.findIndex((p) => p.username === name) : -1;
    if (idx < 0) return { ok: false, code: 'NO_PENDING', message: '没有这条入房申请', status: 404 };
    room.pending.splice(idx, 1);
    room.members.add(name);
    return { ok: true, room };
  }

  /** 房主拒绝一条入房申请：从 pending 删掉并拉黑（同 kick，但对方本来就不在房里）。 */
  reject(roomId, operatorIdKey, username) {
    const room = this.rooms.get(String(roomId));
    if (!room) return { ok: false, code: ERR.STATE, message: '房间不存在或已关闭', status: 500 };
    if (String(room.ownerId) !== String(operatorIdKey ?? '')) return { ok: false, code: 'NOT_OWNER', message: '只有房主可以审批入房申请', status: 403 };
    const name = String(username ?? '').trim();
    if (!name) return { ok: false, code: ERR.BADMSG, message: '缺少 username', status: 400 };
    if (name === room.username) return { ok: false, code: 'CANNOT_KICK_OWNER', message: '不能把房主自己移出房间', status: 400 };
    if (Array.isArray(room.pending)) room.pending = room.pending.filter((p) => p.username !== name);
    if (!(room.kicked instanceof Set)) room.kicked = new Set();
    room.kicked.add(name);
    return { ok: true, room };
  }

  /**
   * 占座位（v0.9）。座位 = 房间里的一个角色（characterId）。
   *
   * 规则：
   * - 操作者必须是这个房间的成员（房主或已审批通过的观战者），否则 NOT_MEMBER；
   * - 房主可以替别人指派座位（operator 是 ownerId 时，username 可以是任何成员）；
   * - 同一个座位不能被两个人同时坐（SEAT_TAKEN）—— 除非是这个人自己的；
   * - characterId 传空 = 让出座位（release）。
   *
   * 返回 { ok, room, seat } 或 { ok:false, status, code, message }。
   */
  claimSeat(roomId, operatorIdKey, username, characterId, selfNameIn = null) {
    const room = this.rooms.get(String(roomId));
    if (!room) return { ok: false, code: ERR.STATE, message: '房间不存在或已关闭', status: 500 };
    if (!(room.seats instanceof Map)) room.seats = new Map();
    const name = String(username ?? '').trim();
    if (!name) return { ok: false, code: ERR.BADMSG, message: '缺少 username', status: 400 };

    // 谁有权替谁安排座位（服务端强判：除了 HTTP 路由，ws 的 JOIN 路径也会直接调到这里）。
    //
    // 本函数只看得到 username 与 operatorIdKey，看不到「这个 idKey 是哪个用户名的」——
    // 那张翻译表在 LobbyGateway 里。所以只做能证明的判定：
    // - operatorIdKey === room.ownerId（房主本人）：可以替任何成员指派 / 清空座位；
    // - 其余情况：必须由调用方用 selfName 显式证明「name 就是操作者本人」，否则视为替别人安排，拒。
    //   正常链路是 LobbyGateway.claimSeat 先解析出操作者自己的用户名再传进来，绕不过去。
    // - operator 为空：老调用方（v0.8 之前的测试 / 单机路径）不传 idKey，视为「就是本人」，保留老行为。
    const operator = String(operatorIdKey ?? '').trim();
    const operatorName = String(selfNameIn ?? '').trim();
    let isOwner = true;
    if (operator) {
      isOwner = String(room.ownerId ?? '') === operator;
      if (!isOwner && (!operatorName || name !== operatorName)) {
        return { ok: false, code: 'FORBIDDEN', message: '只有房主可以替别人安排座位', status: 403 };
      }
    }

    // 进房间的门槛：房主本人，或已审批通过的成员。不在房间里的人根本没资格选座位。
    // 放在权限判定之后，是为了让「替别人安排」这种越权先报出 FORBIDDEN 而不是 NOT_MEMBER
    // （否则没被审批的人改别人的座位会得到「你还在门外」，完全误导）。
    // 房主替不在房里的人指派不在这里拦 —— 那是房主的自由，前端也允许给空位预留人。
    if (!isOwner && name !== room.username && !room.members.has(name)) {
      return { ok: false, code: 'NOT_MEMBER', message: '你还在门外：房主同意后才能选座位', status: 403 };
    }
    if (room.started) return { ok: false, code: 'ROOM_STARTED', message: '已开始游戏，座位锁定', status: 403 };
    const id = characterId == null ? '' : String(characterId);
    if (id) {
      for (const [who, seatId] of room.seats) {
        if (seatId === id && who !== name) return { ok: false, code: 'SEAT_TAKEN', message: `这个座位已经被 ${who} 坐了`, status: 409 };
      }
      room.seats.set(name, id);
    } else {
      room.seats.delete(name);
    }
    return { ok: true, room, seat: id || null };
  }

  /** 某人此刻坐的座位（characterId），没坐返回 null。 */
  seatOf(room, username) {
    if (!room || !(room.seats instanceof Map)) return null;
    return room.seats.get(String(username ?? '')) ?? null;
  }

  /** 座位表反查：这个角色被谁坐着（没人坐返回 null）。开局时用它把 characterId 翻译回玩家。 */
  seatOwner(room, characterId) {
    if (!room || !(room.seats instanceof Map) || !characterId) return null;
    const id = String(characterId);
    for (const [who, seatId] of room.seats) if (seatId === id) return who;
    return null;
  }

  /** 已占用的座位表（username → characterId）的快照副本。 */
  seatsOf(room) {
    if (!room || !(room.seats instanceof Map)) return {};
    return Object.fromEntries(room.seats);
  }

  /**
   * 房主改游戏参数（v0.9）：只接受 durationMs（≥30s）与 targetScore（≥0，0 = 不限）。
   * 传 null/undefined 的键 = 该项回默认。房间开局后不许再改。
   */
  setSettings(roomId, operatorIdKey, patch = {}) {
    const room = this.rooms.get(String(roomId));
    if (!room) return { ok: false, code: ERR.STATE, message: '房间不存在或已关闭', status: 500 };
    if (String(room.ownerId ?? '') !== String(operatorIdKey ?? '')) return { ok: false, code: 'NOT_OWNER', message: '只有房主可以设置游戏参数', status: 403 };
    if (room.started) return { ok: false, code: 'ROOM_STARTED', message: '已开始游戏，参数锁定', status: 403 };
    if (!room.settings || typeof room.settings !== 'object') room.settings = { durationMs: null, targetScore: null };
    if ('durationMs' in patch) {
      const v = patch.durationMs == null ? null : Math.round(Number(patch.durationMs));
      if (v !== null && (!Number.isFinite(v) || v < 30_000 || v > 4 * 60 * 60 * 1000)) {
        return { ok: false, code: ERR.BADMSG, message: '单局时长必须在 30 秒到 4 小时之间', status: 400 };
      }
      room.settings.durationMs = v;
    }
    if ('targetScore' in patch) {
      const v = patch.targetScore == null ? null : Math.round(Number(patch.targetScore));
      if (v !== null && (!Number.isFinite(v) || v < 0 || v > 1_000_000)) {
        return { ok: false, code: ERR.BADMSG, message: '目标分必须在 0 到 1000000 之间', status: 400 };
      }
      room.settings.targetScore = v;
    }
    return { ok: true, room, settings: { ...room.settings } };
  }

  /**
   * 清除房间（v0.11）：房主主动「停止当前房间并删除」。
   *
   * 和 leave 的区别：leave 是「一个人走了，房间空了才顺手删」，close 是房主拍板
   * 「这局不要了」——不管房里还剩几个人，直接把这个 id 从表里摘掉，之后任何
   * /api/net/join、/lobby 握手都会走正常的「房间不存在（ROOM_NOT_FOUND）」分支，
   * 不需要在别处再补一堆「已关闭」判断。鉴权只有一条：操作者必须是 ownerId。
   *
   * @returns {{ok:true, room:object, closed:true} | {ok:false, status:number, code:string, message:string}}
   */
  close(roomId, operatorIdKey) {
    const id = String(roomId ?? '').trim();
    const key = String(operatorIdKey ?? '').trim();
    const room = this.rooms.get(id);
    if (!room) return { ok: false, status: 404, code: 'ROOM_NOT_FOUND', message: '房间不存在或已关闭' };
    // 与 startRoom 同一条判据：operator 可能是 idKey（HTTP 路由）也可能是房主用户名（内部调用）。
    const isOwner = key && (String(room.ownerId ?? '') === key || String(room.username ?? '') === key);
    if (!isOwner) {
      return { ok: false, status: 403, code: 'NOT_OWNER', message: '只有房主可以清除房间' };
    }
    const snapshot = room;
    this.rooms.delete(id);
    return { ok: true, room: snapshot, closed: true };
  }

  leave(roomId, username) {
    const room = this.rooms.get(String(roomId));
    if (!room) return false;
    room.members.delete(username);
    if (!room.members.size) {
      this.rooms.delete(room.id);
      return true;
    }
    return false;
  }

  /**
   * 房间视图（HTTP 响应里直接用，字段名是前后端约定的）。
   * v0.8 追加两个只读状态位，**不改原有字段** —— 老客户端拿到的还是同样的 id/token/invCode/owner/members/createdAt。
   */
  view(room) {
    return {
      id: room.id,
      token: room.token,
      invCode: room.invCode,
      owner: room.username,
      members: [...room.members],
      createdAt: room.createdAt,
      started: Boolean(room.started),
      pendingCount: Array.isArray(room.pending) ? room.pending.length : 0,
      // v0.9：座位表（username → characterId）与房主设的游戏参数。
      // 都是新增只读字段，老客户端拿到的原有字段一个没动。
      seats: room.seats instanceof Map ? Object.fromEntries(room.seats) : {},
      settings: { durationMs: room.settings?.durationMs ?? null, targetScore: room.settings?.targetScore ?? null },
    };
  }
}
