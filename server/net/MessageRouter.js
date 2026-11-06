// 消息分发：把校验后的上行消息转给 GameController。只做会话/阶段层面的拒绝，不做规则判定。

import { ERR, MSG, PHASE } from '../../shared/constants.js';

export class MessageRouter {
  /**
   * @param {object} opt
   * @param {object} opt.controller 游戏主体（GameController）
   * @param {Console} [opt.logger]
   * @param {object} [opt.lobby] 联机网关（LobbyGateway）。传了就在开局时记下「这个 idKey 选了哪个角色」，
   *   否则房主点「开始游戏」（POST /api/lobby/room/start）会因为 characters 表里没有他而恒回 NO_CHARACTER。
   */
  constructor({ controller, logger = console, lobby = null }) {
    this.controller = controller;
    this.log = logger;
    this.lobby = lobby;
  }

  /** @param {object} conn WsServer 的连接对象；send/error 由 WsServer 提供 */
  async handle(conn, msg) {
    const c = this.controller;
    const { type, payload, seq } = msg;
    if (type === MSG.PING) return conn.send(MSG.PONG, { t: payload.t ?? null, serverTime: Date.now() });
    if (type === MSG.RESYNC) {
      // 座位玩家要按自己的 viewer 重发（否则断线重连拿到的 me 是别人的 / null）
      const msgs = conn.viewerKey ? c.initialMessages(null, conn.viewerKey) : c.initialMessages(null);
      for (const [t, p] of msgs) conn.send(t, p);
      return;
    }
    // v0.9 座位制：座位玩家（role='controller'）各自操作自己的角色，不再是「全场只有一个控制端」。
    // 谁算玩家、谁算观战由 WsServer 根据房间座位表定（坐好座位且选了角色 = controller）。
    // 这里只拦住真正没有操作权的连接；判定放在阶段判断之前，否则观战者会先收到
    // 「对局未在进行」而不是 E_SPECTATOR，前端就没法提示「你只是观战」。
    // 选座位走 HTTP POST /api/lobby/room/seat（之后重连/hello 就带座位了），所以 JOIN 不需要对观战放行。
    // 例外：联机大厅里「坐下来」本身就是一条合法的观战者操作 —— 他此刻还没座位，
    // 所以 role 必然是 spectator。拦住的话新玩家永远选不上座位（先有鸡还是先有蛋）。
    // 座位是否可用由 claimSeatFor 判定（SEAT_TAKEN / ROOM_STARTED / NOT_MEMBER）。
    const lobbyJoining = type === MSG.JOIN && Boolean(conn.lobby?.idKey);
    if (conn.role !== 'controller' && !lobbyJoining) {
      return conn.error(ERR.SPECTATOR, '当前是观战连接，无法操作（先在房间里选一个角色）', seq);
    }
    const phase = c.phase;
    // 玩家自己的角色：座位玩家用自己 viewer 的角色，单机/老路径仍用 playerCharId
    const playerId = this.playerCharOf(conn) ?? c.viewerId;
    switch (type) {
      case MSG.JOIN: {
        if (phase === PHASE.PLAYING || phase === PHASE.PAUSED) return conn.error(ERR.STATE, '对局进行中，请先结束本局', seq);
        try {
          if (payload.resume) await c.resumeSave();
          else {
            const entry = c.roster.find((r) => r.id === payload.characterId);
            if (!entry) return conn.error(ERR.BADMSG, '请选择一个有效的角色', seq);
            if (payload.role && payload.role !== entry.role) return conn.error(ERR.BADMSG, '角色身份与所选角色不符', seq);
            const lobbyIdKey = conn.lobby?.idKey;
            if (lobbyIdKey) {
              // 座位制（v0.9）：联机时 JOIN = 「我要坐这个角色」，只是落座，不开局。
              // 开局统一由房主点「开始游戏」（HTTP /api/lobby/room/start）触发，全座位一起开。
              // 座位冲突 / 房间已开局必须回 error，不能静默吞掉 —— 否则玩家以为坐上了，
              // 开局却发现自己没角色。落座成功后把这条连接升级成玩家视图，补一份属于他的快照。
              const seatOut = this.claimSeatFor(conn, entry.id);
              if (seatOut && !seatOut.ok) return conn.error(ERR.STATE, seatOut.message ?? '座位不可用', seq);
              this.attachSeat(conn, entry.id);
              conn.send(MSG.PONG, { t: payload.t ?? null, serverTime: Date.now(), seated: entry.id });
            } else {
              // 单机 / 老协议：没有房间参数，JOIN 就是直接开一局单人局
              c.startRound({ characterId: entry.id, seed: payload.seed ?? null });
            }
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

  /** 这条连接的座位角色（联机座位玩家）。没有返回 null。 */
  playerCharOf(conn) {
    if (!conn?.viewerKey) return null;
    const id = this.controller.viewerCharOf?.(conn.viewerKey) ?? null;
    return id || null;
  }

  /** 选角色 = 占座位。返回 RoomManager.claimSeat 的结果；单机/无网关时返回 null（无需占座）。 */
  claimSeatFor(conn, characterId) {
    const info = conn.lobby;
    if (!info || !this.lobby) return null;
    const roomId = info.room?.id;
    if (!roomId) return null;
    const username = info.username || info.room?.username || '';
    // 先落座位表（这是唯一事实源），再记 idKey → 角色
    const out = typeof this.lobby.claimSeat === 'function'
      ? this.lobby.claimSeat(roomId, info.idKey, username, characterId)
      : this.lobby.rooms.claimSeat(roomId, info.idKey, username, characterId);
    if (out?.ok && typeof this.lobby.setCharacter === 'function') this.lobby.setCharacter(info.idKey, characterId, username);
    return out;
  }

  /** 让这条连接升级成玩家视图：controller 侧登记 viewer，welcome 里的座位信息由前端自己刷新。 */
  attachSeat(conn, characterId) {
    const c = this.controller;
    if (!conn.viewerKey) conn.viewerKey = `c:${Math.random().toString(16).slice(2)}`;
    // 先摘掉「观众通道」：同一条连接不能既登记成 viewer 又登记成 spectator，
    // 否则公共视图（me=null）会追着自己的玩家视图发，把 me 覆盖成 null。
    c.detachSpectator?.(conn.viewerKey);
    c.attachViewer?.(conn.viewerKey, characterId);
    conn.role = 'controller';
    conn.seat = true;
    // 立刻补一份属于他自己角色的全量快照（大厅状态下也要能画出「我」）
    const msgs = c.initialMessages?.(null, conn.viewerKey) ?? [];
    for (const [type, p] of msgs) conn.send(type, p);
  }
}
