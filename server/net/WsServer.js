// WebSocket 服务：同源校验、握手（hello → welcome）、单控制会话 + 观战连接、心跳、限流、重连补发。

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { CLIENT_VERSION, ERR, MSG, PROTOCOL_VERSION } from '../../shared/constants.js';
import { encode, parseMessage } from './Protocol.js';
import { MessageRouter } from './MessageRouter.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 状态码 → HTTP 状态行的原因短语。只用来拼那一行，不影响 ws 逻辑。 */
const STATUS_TEXT = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error' };
const httpText = (status) => STATUS_TEXT[status] ?? 'Error';

/**
 * 拒绝一次 upgrade：按状态码写一行响应再断开。不能吞掉必须显式写，否则浏览器只看到「连接被重置」。
 * 响应体带结构化 JSON：浏览器的 WebSocket API 只会给 close(1006)，拿不到状态码与 reason，
 * 但 curl / fetch 探测能直接看到 400/404 与 code（用户要求的「错误返回 400/404/500」）。
 */
function reject(socket, status, text, body = null) {
  const payload = body ? JSON.stringify(body) : '';
  try {
    if (payload) {
      const bytes = Buffer.byteLength(payload);
      socket.write(
        `HTTP/1.1 ${status} ${text}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: application/json; charset=utf-8\r\n' +
        `Content-Length: ${bytes}\r\n\r\n` +
        payload,
      );
    } else {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    }
  } catch {
    // 对端已经跑了：写不进去也无所谓，下面照样 destroy
  }
  socket.destroy();
}

/** 鉴权失败时给客户端的标准错误体（字段与 LobbyGateway.resolve 的失败结果对齐）。 */
export function lobbyErrorBody(status, code, error) {
  return { ok: false, status, code: code || 'BAD_REQUEST', error: error || httpText(status) };
}

export function isLoopbackHost(host) {
  return LOOPBACK.has(String(host).toLowerCase());
}

/** 浏览器 Origin 校验：必须是本机回环地址且端口一致（防止其他网页劫持本地游戏）。 */
export function originAllowed(origin, port, bindHost) {
  if (!origin || origin === 'null') return true; // 非浏览器客户端（测试脚本等）；file:// 纯网页版发的是 Origin: null
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (String(u.port || (u.protocol === 'https:' ? 443 : 80)) !== String(port)) return false;
    return isLoopbackHost(u.hostname) || (!isLoopbackHost(bindHost) && u.hostname === bindHost);
  } catch {
    return false;
  }
}

export class WsServer {
  /**
   * @param {object} opt
   * @param {object} [opt.lobby] 联机网关（LobbyGateway）。不传时 /lobby 一律 404，/ws 行为完全不变。
   */
  constructor({ httpServer, controller, app, port, host, logger = console, lobby = null }) {
    this.controller = controller;
    this.app = app;
    this.port = port;
    this.host = host;
    this.log = logger;
    // 联机网关（v0.3）：/ws 是本机单机/测试的老入口，/lobby 是「带房间参数的联机入口」。
    // 两条路共用同一个 WebSocketServer，只是身份判定不同。
    this.lobby = lobby;
    this.router = new MessageRouter({ controller, logger, lobby });
    this.conns = new Set();
    this.session = { id: null, conn: null };
    // 多座位（v0.9）：viewerKey → conn。每个坐了座位的联机连接自己就是一个 viewer，
    // GameController 用它作为 key 维护独立的 Snapshot，包也按这个 key 精确投递。
    this.viewerConns = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: app.net.maxMessageBytes });

    httpServer.on('upgrade', (req, socket, head) => {
      let parsed;
      try {
        parsed = new URL(req.url, 'http://x');
      } catch {
        return reject(socket, 400, 'Bad Request');
      }
      const path = parsed.pathname;
      if (path !== '/ws' && path !== '/lobby') return reject(socket, 403, 'Forbidden');
      if (!originAllowed(req.headers.origin, this.port, this.host)) return reject(socket, 403, 'Forbidden');
      // /lobby：先鉴权，再升级。鉴权失败连 ws 握手都不做 —— 陌生人拿不到任何一帧游戏状态。
      let lobbyInfo = null;
      if (path === '/lobby') {
        if (!this.lobby) {
          return reject(socket, 404, httpText(404), lobbyErrorBody(404, 'LOBBY_DISABLED', '本实例未启用联机网关'));
        }
        const out = this.lobby.resolve(parsed.search);
        if (!out.ok) {
          this.log.info?.(`[ws] 房间鉴权失败（${out.status} ${out.code}）：${out.message}`);
          return reject(socket, out.status, httpText(out.status), lobbyErrorBody(out.status, out.code, out.message));
        }
        lobbyInfo = out;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, lobbyInfo));
    });

    this.onPacket = (type, payload) => {
      for (const conn of this.conns) if (conn.ready) conn.send(type, payload);
    };
    this.onPrivate = (type, payload) => {
      if (this.session.conn?.ready) this.session.conn.send(type, payload);
    };
    // 多座位（v0.9）：controller 为每个 viewer 生成的私有包，按 viewerKey 精确送到那一条连接。
    // 单机 /ws 走 session.conn 的老路径（上面 onPrivate），两条路径互不干扰。
    this.onPrivateTo = (viewerKey, type, payload) => {
      const conn = this.viewerConns.get(String(viewerKey));
      if (conn && conn.ready) conn.send(type, payload);
    };
    controller.on('packet', this.onPacket);
    controller.on('private', this.onPrivate);
    controller.on('privateTo', this.onPrivateTo);

    this.heartbeat = setInterval(() => this.checkHeartbeats(), 5000);
    this.heartbeat.unref?.();
  }

  onConnection(ws, lobbyInfo = null) {
    const conn = {
      ws,
      // lobbyInfo 非空 = 这条连接带着房间参数且已通过鉴权。座位（房主）直接当 controller，
      // 其余人一律 spectator：一个房间只有一个能操作的玩家（需求「全员一个房间」）。
      lobby: lobbyInfo && lobbyInfo.room ? lobbyInfo : null,
      role: 'pending',
      ready: false,
      lastSeen: Date.now(),
      seq: 0,
      rate: { start: Date.now(), count: 0, warned: false },
      send: (type, payload) => {
        if (ws.readyState === ws.OPEN) ws.send(encode(type, payload, ++conn.seq));
      },
      error: (code, message, refSeq = null) => conn.send(MSG.ERROR, { code, message, refSeq }),
    };
    this.conns.add(conn);
    const helloTimer = setTimeout(() => {
      if (!conn.ready) ws.close(4000, 'hello timeout');
    }, 5000);

    ws.on('message', async (data, isBinary) => {
      conn.lastSeen = Date.now();
      if (isBinary) return conn.error(ERR.BADMSG, '只接受文本消息');
      if (!this.allowRate(conn)) return;
      const parsed = parseMessage(data, this.app.net.maxMessageBytes);
      if (!parsed.ok) return conn.error(parsed.code, parsed.message, parsed.seq ?? null);
      const { msg } = parsed;
      if (!conn.ready) {
        if (msg.type !== MSG.HELLO) return conn.error(ERR.PROTO, '请先发送 hello');
        clearTimeout(helloTimer);
        return this.onHello(conn, msg.payload);
      }
      if (msg.type === MSG.HELLO) return conn.error(ERR.PROTO, '重复的 hello');
      try {
        await this.router.handle(conn, msg);
      } catch (err) {
        this.log.error?.(`[ws] 处理消息出错：${err.stack || err.message}`);
        conn.error(ERR.STATE, '服务器处理出错', msg.seq);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.conns.delete(conn);
      // 从房间的在线表里注销（幂等，没登记过就是 no-op）
      if (typeof conn.lobbyUntrack === 'function') conn.lobbyUntrack();
      // 联机连接断开也要刷新玩家列表，否则别人面板上永远挂着一个已经走了的人
      if (conn.lobby && conn.ready) setImmediate(() => this.broadcastPlayers());
      // 多座位：注销这个 viewer（controller 侧删掉它那份 Snapshot，不再为死连接算包）
      if (conn.viewerKey) {
        this.viewerConns.delete(String(conn.viewerKey));
        this.controller.detachViewer?.(conn.viewerKey);
        this.controller.detachSpectator?.(conn.viewerKey);
        conn.viewerKey = null;
      }
      if (this.session.conn === conn) {
        this.session.conn = null;
        this.controller.onConnectionLost();
        this.log.info?.('[ws] 控制连接断开，游戏已自动暂停，等待重连');
      }
    });
    ws.on('error', () => {});
  }

  allowRate(conn) {
    const now = Date.now();
    if (now - conn.rate.start >= 1000) conn.rate = { start: now, count: 0, warned: false };
    conn.rate.count += 1;
    if (conn.rate.count <= this.app.net.rateLimitPerSec) return true;
    if (!conn.rate.warned) {
      conn.rate.warned = true;
      conn.error(ERR.RATE, '消息过于频繁，已丢弃部分指令');
    }
    return false;
  }

  onHello(conn, payload) {
    // 联机连接（/lobby）：角色在 upgrade 时就已经由房间座位定死了，
    // 不走「首个连接=控制端」的老规则 —— 否则观战者先连就能夺权。
    if (conn.lobby) return this.onLobbyHello(conn, payload);
    const s = this.session;
    let resumed = false;
    if (payload.sessionId && s.id && payload.sessionId === s.id) {
      // 同一会话重连（刷新页面 / 网络抖动）：接管控制权
      if (s.conn && s.conn !== conn) {
        s.conn.role = 'spectator';
        s.conn.error(ERR.SPECTATOR, '同一会话在另一处重新连接，此窗口转为观战');
      }
      s.conn = conn;
      conn.role = 'controller';
      resumed = true;
    } else if (!s.conn) {
      s.id = randomUUID();
      s.conn = conn;
      conn.role = 'controller';
    } else {
      conn.role = 'spectator';
    }
    conn.ready = true;
    const c = this.controller;
    conn.send(MSG.WELCOME, {
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: CLIENT_VERSION,
      tickRate: this.app.tickRate,
      mapId: c.map.id,
      serverTime: Date.now(),
      sessionId: conn.role === 'controller' ? s.id : null,
      role: conn.role,
      resumed,
      lobby: c.lobbyInfo(),
    });
    for (const [type, p] of c.initialMessages(resumed ? payload.lastSeq ?? null : null)) conn.send(type, p);
    if (conn.role === 'controller') c.onConnectionRestored();
  }

  /**
   * 联机连接的 hello（v0.9 座位制）：角色来自房间座位表，welcome 额外带房间信息与玩家列表。
   *
   * 与 v0.8 的区别：以前「房间里只能有一个 controller」，第二个座位玩家会被降级成观战。
   * 现在每个选好角色的成员都有自己的视图，**互不踢**：
   * - 已经选了角色 → role='controller'（= 玩家连接），在 controller 里登记独立 viewer
   *   （key = viewerKey），收到的 snapshot 里 me 就是他自己；
   * - 没选角色（刚进房间 / 纯观战）→ role='spectator'，只收公共视图（me=null）。
   *   选完角色后走 MessageRouter 的 JOIN（MSG.SEAT/… 同一条路），会用 attachViewer 升级成玩家。
   * session.conn 的单会话策略只保留给单机 /ws 路径，联机路径完全不走它。
   */
  onLobbyHello(conn, payload) {
    const info = conn.lobby;
    // 这个人在房间座位表里的角色（没选座位时是 null）
    const seatCharId = this.seatCharOf(info);
    const isSeat = Boolean(info.seat) && Boolean(seatCharId);
    const c = this.controller;
    let resumed = false;
    if (isSeat) {
      conn.role = 'controller';
      // viewerKey 用连接自己的唯一 id：每次连接一条，房间里的两个座位不会因为「同一个 idKey
      // 先当观众再坐下」而撞到同一条 viewerConns 记录（撞了就会互抢私有包，一方永远收不到 me）。
      conn.viewerKey = `c:${randomUUID()}`;
      this.viewerConns.set(String(conn.viewerKey), conn);
      // 座位角色必须现在就登记，否则 initialMessages 拿不到 me（玩家开局前就能看到自己的面板）
      if (seatCharId) c.attachViewer?.(conn.viewerKey, seatCharId);
      resumed = Boolean(payload.sessionId);
    } else {
      conn.role = 'spectator';
      // 观战者也有自己的公共视图：没有 viewerKey 的话，他进场后收不到任何增量，
      // 画面会永远停在进场那一帧。给一条只收公共视图的通道（me 恒 null、不能操作）。
      conn.viewerKey = conn.viewerKey || (info.idKey ? `s:${info.idKey}` : `s:${randomUUID()}`);
      this.viewerConns.set(String(conn.viewerKey), conn);
      c.attachSpectator?.(conn.viewerKey);
    }
    conn.ready = true;
    // 真实在线登记：playerList 里「在不在线」必须来自真的连上来的连接，
    // 否则房主在另一台机器上时本地窗口会被误判成「房主已在线」。
    // 用 setImmediate 注销而不是在 close 里直接删：ws 的 close 事件与 onConnection 的注册顺序
    // 由 EventEmitter 决定，晚一个 tick 更稳。
    if (info.idKey || info.username) conn.lobbyUntrack = this.lobby.trackConnection({ idKey: info.idKey, username: info.username });
    conn.send(MSG.WELCOME, this.welcomePayload(conn, { isSeat, resumed, seatCharId }));
    // 座位玩家的初始包要按他自己的角色生成（key 传进去），观战玩家给公共视图
    const msgs = conn.viewerKey ? c.initialMessages(resumed ? payload.lastSeq ?? null : null, conn.viewerKey) : c.initialMessages(null);
    for (const [type, p] of msgs) conn.send(type, p);
    if (conn.role === 'controller') c.onConnectionRestored();
    // 有人进/出房间 → 玩家列表立刻变化，通知所有人（前端 NetPanel 靠这个刷新，不用轮询）
    this.broadcastPlayers();
  }

  /** 这条联机连接此刻坐的座位角色（没有座位/没选角色返回 null）。 */
  seatCharOf(info) {
    if (!info || !info.room) return null;
    const name = String(info.username || info.room.username || '');
    const seats = info.room?.seats;
    if (seats && typeof seats === 'object' && name && seats[name]) return seats[name];
    try {
      const id = this.lobby?.rooms?.seatOf?.(info.room, name) ?? null;
      if (id) return id;
    } catch {
      /* 房间表拿不到就算了，退化成「有座位但还没选角色」 */
    }
    return null;
  }

  /** welcome 的共同部分 + 联机字段（room / players）。单机路径不带这两个键，保持老协议不变。 */
  welcomePayload(conn, { isSeat, resumed, seatCharId = null }) {
    const c = this.controller;
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: CLIENT_VERSION,
      tickRate: this.app.tickRate,
      mapId: c.map.id,
      serverTime: Date.now(),
      sessionId: conn.role === 'controller' ? this.session.id : null,
      role: conn.role,
      resumed,
      lobby: c.lobbyInfo(),
    };
    const info = conn.lobby;
    if (!info) return base;
    return {
      ...base,
      room: {
        id: info.room.id,
        username: info.username || info.room.username || '',
        role: isSeat ? 'owner' : 'spectator',
        seat: isSeat,
        // v0.9 新增（老字段一个没动）：我坐的角色 + 全房间座位表，前端据此画座位面板
        characterId: seatCharId ?? null,
        isOwner: String(info.room.ownerId ?? '') === String(info.idKey ?? ''),
        // 座位表以房间表为准（info.room 是握手那一刻的快照，可能已经过期）
        seats: (() => {
          try {
            return this.lobby?.rooms?.seatsOf?.(info.room) ?? {};
          } catch {
            return {};
          }
        })(),
        settings: info.room?.settings ? { ...info.room.settings } : { durationMs: null, targetScore: null },
      },
      players: this.playerList(),
    };
  }

  /** 玩家列表：直接问网关（它持有房间表与角色选择）。没有网关时返回空数组而不是抛。 */
  playerList() {
    if (!this.lobby || typeof this.lobby.playerList !== 'function') return [];
    try {
      return this.lobby.playerList();
    } catch (err) {
      this.log.warn?.('[ws] 玩家列表生成失败：' + String(err && err.message ? err.message : err));
      return [];
    }
  }

  /** 向所有已就绪连接广播玩家列表（MSG.LOBBY 的 payload 换成 players 数组，不新增常量）。 */
  broadcastPlayers() {
    const players = this.playerList();
    for (const conn of this.conns) if (conn.ready) conn.send(MSG.LOBBY, { players });
    return players;
  }

  /** 全场结束（房主点了 LEAVE / 时间到）：向所有连接广播 GAMEOVER。返回收到的人数。 */
  broadcastGameover(payload = null) {
    const data = payload ?? this.controller.gameover ?? null;
    let n = 0;
    for (const conn of this.conns) {
      if (!conn.ready) continue;
      conn.send(MSG.GAMEOVER, data);
      n += 1;
    }
    return n;
  }

  checkHeartbeats() {
    const limit = this.app.net.heartbeatTimeoutMs;
    const now = Date.now();
    for (const conn of this.conns) {
      if (now - conn.lastSeen > limit) {
        this.log.info?.('[ws] 心跳超时，断开连接');
        conn.ws.terminate();
      }
    }
  }

  close() {
    clearInterval(this.heartbeat);
    this.controller.off('packet', this.onPacket);
    this.controller.off('private', this.onPrivate);
    this.controller.off('privateTo', this.onPrivateTo);
    this.viewerConns.clear();
    for (const conn of this.conns) conn.ws.terminate();
    this.wss.close();
  }
}
