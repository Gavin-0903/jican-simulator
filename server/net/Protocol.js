// 协议：消息信封 {v, type, seq, ts, payload} 的解析与结构校验（白名单），以及下行消息编码。
// 只做结构校验，不做任何规则判定。

import { ACTION, ERR, MSG, PROTOCOL_VERSION, SPEEDS } from '../../shared/constants.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const optional = (check) => (v) => v === undefined || check(v);
const nullable = (check) => (v) => v === null || check(v);

const ACTION_KINDS = new Set(Object.values(ACTION));

/** 每种上行消息的 payload 校验：字段名 → 校验函数。未声明的字段一律拒绝。 */
const SCHEMAS = {
  [MSG.HELLO]: {
    clientVersion: optional((v) => isStr(v, 20)),
    sessionId: optional(nullable((v) => isStr(v, 64))),
    lastSeq: optional(nullable((v) => isInt(v, 0, Number.MAX_SAFE_INTEGER))),
  },
  [MSG.JOIN]: {
    characterId: optional((v) => isStr(v, 16)),
    role: optional((v) => v === 'student' || v === 'teacher'),
    classId: optional(nullable((v) => isInt(v, 1, 99))),
    seed: optional(nullable((v) => isInt(v, 0, 0xffffffff))),
    resume: optional((v) => typeof v === 'boolean'),
  },
  [MSG.LEAVE]: {},
  [MSG.LOBBY]: {},
  [MSG.PING]: { t: optional(isNum) },
  [MSG.RESYNC]: {},
  [MSG.MOVE]: {
    dir: (v) => isObj(v) && isNum(v.x) && isNum(v.y) && Object.keys(v).length === 2 && Math.abs(v.x) <= 1.01 && Math.abs(v.y) <= 1.01,
    face: optional(isNum),
  },
  [MSG.ACTION]: {
    kind: (v) => ACTION_KINDS.has(v),
    pcId: optional((v) => isStr(v, 24)),
    targetId: optional((v) => isStr(v, 16)),
  },
  [MSG.JC_COMMIT]: {
    selfUsername: (v) => isStr(v, 32),
    amount: (v) => v === null || isNum(v),
  },
  [MSG.SET_SPEED]: { mult: (v) => SPEEDS.includes(v) },
  [MSG.PAUSE]: { on: (v) => typeof v === 'boolean' },
};

export const C2S_TYPES = new Set(Object.keys(SCHEMAS));

/**
 * @returns {{ok:true, msg:{type:string, seq:number|null, payload:object}} | {ok:false, code:string, message:string, seq?:number}}
 */
export function parseMessage(raw, maxBytes = 4096) {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
  if (size > maxBytes) return { ok: false, code: ERR.BADMSG, message: '消息过大' };
  let env;
  try {
    env = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return { ok: false, code: ERR.BADMSG, message: '不是合法的 JSON' };
  }
  if (!isObj(env)) return { ok: false, code: ERR.BADMSG, message: '消息信封必须是对象' };
  const seq = isInt(env.seq, 0, Number.MAX_SAFE_INTEGER) ? env.seq : null;
  if (env.v !== PROTOCOL_VERSION) return { ok: false, code: ERR.PROTO, message: `协议版本不符（需要 v${PROTOCOL_VERSION}）`, seq };
  if (!C2S_TYPES.has(env.type)) return { ok: false, code: ERR.BADMSG, message: `未知消息类型：${String(env.type).slice(0, 32)}`, seq };
  const payload = env.payload === undefined ? {} : env.payload;
  if (!isObj(payload)) return { ok: false, code: ERR.BADMSG, message: 'payload 必须是对象', seq };
  const schema = SCHEMAS[env.type];
  for (const key of Object.keys(payload)) {
    if (!(key in schema)) return { ok: false, code: ERR.BADMSG, message: `未知字段：${key.slice(0, 32)}`, seq };
  }
  for (const [key, check] of Object.entries(schema)) {
    if (!check(payload[key])) return { ok: false, code: ERR.BADMSG, message: `字段非法：${key}`, seq };
  }
  return { ok: true, msg: { type: env.type, seq, payload } };
}

export function encode(type, payload, seq = null) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, seq, ts: Date.now(), payload });
}
