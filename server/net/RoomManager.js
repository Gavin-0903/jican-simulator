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
    room = { id, ownerId: idKey, token, invCode, username, members: new Set([username]), createdAt: this.now() };
    this.rooms.set(id, room);
    this.log.info?.(`[room] 房间 ${id} 已创建（${username}），邀请码 ${invCode}`);
    return { ok: true, room, created: true };
  }

  join({ idKey, username, roomId, token, invCode }) {
    if (this.isBanned(idKey)) return { ok: false, code: ERR.FORBIDDEN, message: '该 ID 密钥已被本服务器源封禁', status: 500 };
    const room = this.rooms.get(String(roomId));
    if (!room) return { ok: false, code: ERR.STATE, message: '房间不存在或已关闭', status: 500 };
    // 房间号 + Token 校验匹配才允许加入
    if (room.token !== token) return { ok: false, code: ERR.FORBIDDEN, message: '房间 Token 不匹配', status: 500 };
    if (room.invCode !== invCode) return { ok: false, code: ERR.FORBIDDEN, message: '邀请码不匹配', status: 500 };
    room.members.add(username);
    this.forgive(idKey);
    return { ok: true, room };
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

  view(room) {
    return { id: room.id, token: room.token, invCode: room.invCode, owner: room.username, members: [...room.members], createdAt: room.createdAt };
  }
}
