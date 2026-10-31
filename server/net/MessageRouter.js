// 消息分发：把校验后的上行消息转给 GameController。只做会话/阶段层面的拒绝，不做规则判定。

import { ERR, MSG, PHASE } from '../../shared/constants.js';

export class MessageRouter {
  constructor({ controller, logger = console }) {
    this.controller = controller;
    this.log = logger;
  }

  /** @param {object} conn WsServer 的连接对象；send/error 由 WsServer 提供 */
  async handle(conn, msg) {
    const c = this.controller;
    const { type, payload, seq } = msg;
    if (type === MSG.PING) return conn.send(MSG.PONG, { t: payload.t ?? null, serverTime: Date.now() });
    if (type === MSG.RESYNC) {
      for (const [t, p] of c.initialMessages(null)) conn.send(t, p);
      return;
    }
    if (conn.role !== 'controller') return conn.error(ERR.SPECTATOR, '当前是观战连接，无法操作（已有其他窗口在控制游戏）', seq);
    const phase = c.phase;
    const playerId = c.viewerId;
    switch (type) {
      case MSG.JOIN: {
        if (phase === PHASE.PLAYING || phase === PHASE.PAUSED) return conn.error(ERR.STATE, '对局进行中，请先结束本局', seq);
        try {
          if (payload.resume) await c.resumeSave();
          else {
            const entry = c.roster.find((r) => r.id === payload.characterId);
            if (!entry) return conn.error(ERR.BADMSG, '请选择一个有效的角色', seq);
            if (payload.role && payload.role !== entry.role) return conn.error(ERR.BADMSG, '角色身份与所选角色不符', seq);
            c.startRound({ characterId: entry.id, seed: payload.seed ?? null });
          }
        } catch (err) {
          return conn.error(ERR.STATE, err.message, seq);
        }
        return;
      }
      case MSG.LEAVE:
        if (phase !== PHASE.PLAYING && phase !== PHASE.PAUSED) return conn.error(ERR.STATE, '当前没有进行中的对局', seq);
        return c.quit();
      case MSG.LOBBY:
        if (phase === PHASE.PLAYING || phase === PHASE.PAUSED) return conn.error(ERR.STATE, '对局进行中，请先结束本局', seq);
        return c.toLobby();
      case MSG.PAUSE:
        if (!c.pause(payload.on, 'player')) return conn.error(ERR.STATE, payload.on ? '当前无法暂停' : '当前没有暂停', seq);
        return;
      case MSG.ITEM_BUY:
        if (!playerId) return conn.error(ERR.NOTJOINED, '尚未加入对局', seq);
        if (phase !== PHASE.PLAYING) return conn.error(ERR.STATE, '对局未在进行', seq);
        if (!c.enqueue(playerId, 'item.buy', payload, seq)) conn.error(ERR.STATE, '指令队列已满，请稍后', seq);
        return;
      case MSG.ITEM_UPGRADE:
        if (!playerId) return conn.error(ERR.NOTJOINED, '尚未加入对局', seq);
        if (phase !== PHASE.PLAYING) return conn.error(ERR.STATE, '对局未在进行', seq);
        if (!c.enqueue(playerId, 'item.upgrade', payload, seq)) conn.error(ERR.STATE, '指令队列已满，请稍后', seq);
        return;
      case MSG.ITEM_USE:
        if (!playerId) return conn.error(ERR.NOTJOINED, '尚未加入对局', seq);
        if (phase !== PHASE.PLAYING) return conn.error(ERR.STATE, '对局未在进行', seq);
        if (!c.enqueue(playerId, 'item.use', payload, seq)) conn.error(ERR.STATE, '指令队列已满，请稍后', seq);
        return;
      case MSG.SET_SPEED:
        if (!c.setSpeed(payload.mult)) return conn.error(ERR.BADMSG, '不支持的倍速', seq);
        return;
      case MSG.MOVE:
      case MSG.ACTION:
      case MSG.JC_COMMIT: {
        if (!playerId) return conn.error(ERR.NOTJOINED, '尚未加入对局', seq);
        if (phase !== PHASE.PLAYING) {
          if (type === MSG.MOVE) return; // 暂停时静默丢弃移动
          return conn.error(ERR.STATE, phase === PHASE.PAUSED ? '游戏已暂停' : '对局未在进行', seq);
        }
        const kind = type === MSG.MOVE ? 'move' : type === MSG.ACTION ? 'action' : 'jc.commit';
        if (!c.enqueue(playerId, kind, payload, seq)) conn.error(ERR.STATE, '指令队列已满，请稍后', seq);
        return;
      }
      default:
        return conn.error(ERR.BADMSG, '不支持的消息', seq);
    }
  }
}
