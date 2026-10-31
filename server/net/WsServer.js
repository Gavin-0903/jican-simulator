// WebSocket 服务：同源校验、握手（hello → welcome）、单控制会话 + 观战连接、心跳、限流、重连补发。

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { CLIENT_VERSION, ERR, MSG, PROTOCOL_VERSION } from '../../shared/constants.js';
import { encode, parseMessage } from './Protocol.js';
import { MessageRouter } from './MessageRouter.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHost(host) {
  return LOOPBACK.has(String(host).toLowerCase());
}

/** 浏览器 Origin 校验：必须是本机回环地址且端口一致（防止其他网页劫持本地游戏）。 */
export function originAllowed(origin, port, bindHost) {
  if (!origin) return true; // 非浏览器客户端（测试脚本等）
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
  constructor({ httpServer, controller, app, port, host, logger = console }) {
    this.controller = controller;
    this.app = app;
    this.port = port;
    this.host = host;
    this.log = logger;
    this.router = new MessageRouter({ controller, logger });
    this.conns = new Set();
    this.session = { id: null, conn: null };
    this.wss = new WebSocketServer({ noServer: true, maxPayload: app.net.maxMessageBytes });

    httpServer.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url, 'http://x').pathname;
      if (path !== '/ws' || !originAllowed(req.headers.origin, this.port, this.host)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });

    this.onPacket = (type, payload) => {
      for (const conn of this.conns) if (conn.ready) conn.send(type, payload);
    };
    this.onPrivate = (type, payload) => {
      if (this.session.conn?.ready) this.session.conn.send(type, payload);
    };
    controller.on('packet', this.onPacket);
    controller.on('private', this.onPrivate);

    this.heartbeat = setInterval(() => this.checkHeartbeats(), 5000);
    this.heartbeat.unref?.();
  }

  onConnection(ws) {
    const conn = {
      ws,
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
    for (const conn of this.conns) conn.ws.terminate();
    this.wss.close();
  }
}
