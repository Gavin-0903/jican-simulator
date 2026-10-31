// WebSocket 客户端：握手、心跳、指数退避重连、序号校验（缺包请求全量）。

import { CLIENT_VERSION, ERR, MSG, PROTOCOL_VERSION } from '/shared/constants.js';

const BACKOFF = [500, 1000, 2000, 4000, 8000];
const SESSION_KEY = 'jican.session';

const session = {
  get() {
    try {
      return sessionStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  },
  set(v) {
    try {
      sessionStorage.setItem(SESSION_KEY, v);
    } catch {
      /* ignore */
    }
  },
};

export class NetClient extends EventTarget {
  constructor(store) {
    super();
    this.store = store;
    this.ws = null;
    this.seq = 0;
    this.attempt = 0;
    this.connected = false;
    this.lastRecv = 0;
    this.latency = null;
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.welcomed = false; // 本次连接是否已收到 welcome（hello 发出到 welcome 之间是「握手中」）
    this.role = null; // 服务端给的会话角色：'controller' | 'spectator'
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.welcomed = false;
      this.lastRecv = performance.now();
      this.rawSend(MSG.HELLO, { clientVersion: CLIENT_VERSION, sessionId: session.get(), lastSeq: this.store.lastSeq || null });
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.tick(), 5000);
    });
    ws.addEventListener('message', (ev) => {
      this.lastRecv = performance.now();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handle(msg);
    });
    ws.addEventListener('close', () => {
      clearInterval(this.heartbeat);
      if (this.ws !== ws) return;
      this.welcomed = false;
      this.role = null;
      this.setConnected(false);
      const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
      this.attempt += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
    ws.addEventListener('error', () => {});
  }

  tick() {
    if (performance.now() - this.lastRecv > 15000) {
      this.ws?.close(); // 心跳超时：主动断开并重连
      return;
    }
    this.rawSend(MSG.PING, { t: performance.now() });
  }

  setConnected(on) {
    if (this.connected === on) return;
    this.connected = on;
    this.emit('connection', { connected: on });
  }

  rawSend(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type, seq: ++this.seq, ts: Date.now(), payload }));
    return true;
  }

  send(type, payload = {}) {
    if (!this.connected) return false;
    return this.rawSend(type, payload);
  }

  action(kind, extra = {}) {
    return this.send(MSG.ACTION, { kind, ...extra });
  }

  handle(msg) {
    const p = msg.payload;
    switch (msg.type) {
      case MSG.WELCOME:
        if (p.sessionId) session.set(p.sessionId);
        this.welcomed = true;
        this.role = p.role ?? null;
        this.store.welcome(p);
        this.setConnected(true);
        // 同一会话在别处重连时，服务端会把自己的连接降级为观战：这不等于断线，但要明确告知玩家
        this.emit('welcome', p);
        if (this.role === 'spectator') this.emit('spectator', { reason: 'occupied', message: '本窗口已转为观战：游戏正在另一个窗口里进行' });
        break;
      case MSG.PHASE:
        this.store.setPhase(p);
        break;
      case MSG.SNAPSHOT:
        this.store.applySnapshot(p);
        break;
      case MSG.DELTA:
        if (!this.store.applyDelta(p)) this.rawSend(MSG.RESYNC, {});
        break;
      case MSG.DIALOG:
        this.emit('dialog', p);
        break;
      case MSG.ERROR:
        // E_SPECTATOR 是「这条上行指令没权限」，不是连接断了：单独派发，别让上层当致命错误
        if (p.code === ERR.SPECTATOR) {
          this.role = 'spectator';
          this.emit('spectator', { reason: 'rejected', message: p.message || '当前是观战连接，无法操作' });
        } else {
          this.emit('server-error', p);
        }
        break;
      case MSG.GAMEOVER:
        this.store.setGameover(p);
        break;
      case MSG.PONG:
        if (typeof p.t === 'number') this.latency = Math.round(performance.now() - p.t);
        break;
      default:
        break;
    }
  }
}
