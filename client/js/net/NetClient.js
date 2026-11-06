// WebSocket 客户端：握手、心跳、指数退避重连、序号校验（缺包请求全量）。
//
// 联机（v0.3）：本文件同时负责「连哪条通道」。地址栏里带齐了 type+token+id 就走 /lobby（鉴权入口），
// 否则走老的 /ws（本机单机/测试）。判定与拼 URL 全在 net/roomUrl.js 的纯函数里，这里只管用。

import { CLIENT_VERSION, ERR, MSG, PROTOCOL_VERSION } from '/shared/constants.js';
import { ROOM_KEY, buildConnectionUrl, canSendAsRole, canSendAsRoleStrict, resolveSearch } from './roomUrl.js';

const BACKOFF = [500, 1000, 2000, 4000, 8000];
const SESSION_KEY = 'jican.session';
/** 房间凭据（token / id / invcode）在 sessionStorage 里的键，与 jican.session 同级。 */
const ROOM_STORAGE_KEY = ROOM_KEY;

/** sessionStorage 的统一封装：隐私模式 / 禁用 storage 时不抛，只当没有。 */
const storage = {
  get(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, v) {
    try {
      sessionStorage.setItem(key, v);
    } catch {
      /* ignore */
    }
  },
  remove(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
  /** 读房间凭据；坏数据一律当没有（绝不把半条参数拿去撞 404）。 */
  getRoom() {
    try {
      const raw = sessionStorage.getItem(ROOM_STORAGE_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  },
  setRoom(v) {
    try {
      if (!v) sessionStorage.removeItem(ROOM_STORAGE_KEY);
      else sessionStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};

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
    // ---- 联机（v0.3）：房间参数、通道、玩家列表 ----
    // search：本次要连的 query（'?token=…&id=…&type=…'）。默认取地址栏，地址栏被擦过则取 sessionStorage。
    this.search = resolveSearch({ search: typeof location !== 'undefined' ? location.search : '', stored: storage.getRoom() }).search;
    this.channel = 'ws'; // 实际连上的通道：'lobby' | 'ws'
    this.room = null; // welcome.room：{ id, username, role:'owner'|'spectator', seat:boolean }
    this.players = []; // welcome.players / MSG.LOBBY 推来的玩家列表（形状见 roomUrl.js 注释）
    this.lastCloseCode = null; // 上次 close 的 code（1006 = 握手被拒，服务端连状态行都没发出来）
    this.closeReason = ''; // 上次 close 的 reason（服务端鉴权失败时是 'Not Found' 之类）
    this.pushLobby = false; // 服务端可能把 MSG.LOBBY 当"推送"用（payload 里带 players 才算）
    this.retryIn = null; // 下一次自动重连的等待毫秒数（null = 不重连）
    this.lastLobbyBody = null; // /api/net/room/check 最近一次诊断结果（{ok:false,status,code,error}）
  }

  /** 当前是不是联机房间里的观战者（自己不能操作，只能看）。 */
  get isSpectator() {
    return this.role === 'spectator';
  }

  /** 房间号（6 位数字字符串）；单机时为 ''。 */
  get roomId() {
    return this.room?.id ? String(this.room.id) : '';
  }

  /** 写入/清空房间凭据（供 main.js 在欢迎消息与"回大厅"时调用）。 */
  setRoomCredential(cred) {
    storage.setRoom(cred);
  }

  /** 恢复成单机通道（回大厅 / 退出房间时用）：清掉房间凭据，下次 connect() 走 /ws。 */
  leaveRoomChannel() {
    storage.setRoom(null);
    this.search = '';
    this.room = null;
    this.players = [];
    this.pushLobby = false;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * 建立连接。
   * 地址栏（或 sessionStorage 里存下的那份）带齐了进房参数就走 /lobby，否则走 /ws。
   * 通道选择完全交给 roomUrl.js 的纯函数，这里只管把结果用起来。
   */
  connect() {
    clearTimeout(this.reconnectTimer);
    const picked = buildConnectionUrl({ search: this.search, origin: location.origin, protocol: location.protocol, host: location.host });
    this.channel = picked.channel;
    this.retryIn = null;
    const ws = new WebSocket(picked.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.welcomed = false;
      this.lastCloseCode = null;
      this.closeReason = '';
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
    ws.addEventListener('close', (ev) => {
      clearInterval(this.heartbeat);
      if (this.ws !== ws) return;
      this.welcomed = false;
      const wasRole = this.role;
      this.role = null;
      this.lastCloseCode = ev?.code ?? null;
      this.closeReason = ev?.reason ?? '';
      this.lastLobbyBody = null; // 上一条诊断结果只对那次失败有效
      this.setConnected(false);
      // 联机鉴权失败：服务端在 upgrade 阶段就回了 4xx（浏览器只让我们看到 1006 + 状态行的文本），
      // 这种情况重连一万次也是同样的拒绝 —— 停下来，把原因交给上层显示（getFatalClose）。
      const fatal = this.getFatalClose();
      if (fatal) {
        this.retryIn = null;
        this.emit('lobby-rejected', fatal);
        this.emit('connection', { connected: false, fatal });
        return;
      }
      const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
      this.attempt += 1;
      this.retryIn = delay;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      if (wasRole === 'spectator') this.emit('reconnecting', { delay, fatal: null });
    });
    ws.addEventListener('error', () => {});
  }

  /**
   * 这次断开是不是"再来一次也没用"的鉴权失败。
   * 浏览器 WebSocket 在握手被拒时固定给 1006（不给状态行），但会把状态行的文本塞进 reason
   * （'Not Found' / 'Bad Request' …），所以 reason 非空 + 联机通道 ≈ 服务端拒绝了这组房间参数。
   * 返回 { code, reason, message } 或 null。
   */
  getFatalClose() {
    if (this.channel !== 'lobby') return null;
    const code = this.lastCloseCode;
    const reason = String(this.closeReason || '');
    const rejected = this.welcomed === false && (reason !== '' || code === 4003 || code === 4401 || code === 4403 || code === 4404);
    if (!rejected) return null;
    return { code, reason, message: reason || '房间鉴权失败' };
  }

  /**
   * 用 /api/net/room/check 把"为什么连不上"问清楚（只校验、不建房、无副作用）。
   * WebSocket 握手被拒时浏览器只给 close(1006)，状态码和 code 全被抹掉；这条 HTTP 接口
   * 能拿到服务端的真实 400/404/501 与 {ok:false,status,code,error}，是唯一能把原因说准的路子。
   *
   * - 200 {ok:true} → 参数没问题（大概是网络/限流）：回 { ok:true }，让上层别乱改提示
   * - 4xx/5xx {ok:false,code} → 回 { ok:false, status, code, error }
   * - fetch 抛异常 / 接口不存在(非 JSON) → 回 null，交给上层的 close(1006) 兜底文案
   */
  async checkRoom(search = this.search) {
    const q = String(search || '');
    if (!q) return null;
    try {
      const r = await fetch(`/api/net/room/check${q}`, { headers: { 'x-jican-client': 'web' } });
      const body = await r.json().catch(() => null);
      if (!body) return null;
      if (r.ok && body.ok) return { ok: true, status: r.status, room: body.room ?? null, seat: body.seat, role: body.role };
      if (body.code) return { ok: false, status: body.status ?? r.status, code: body.code, error: body.error ?? '' };
      return null;
    } catch {
      return null;
    }
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
    // 观战者不发操作类指令：服务端本来就会回 E_SPECTATOR，但在前端拦住可以不刷一屏红字。
    // 两段判定：热路径（每帧 input.move）走 roomUrl.canSendAsRole 的精确黑名单，
    // 其余上行落到 SPECTATOR_ALLOWED 白名单（只有 ping/resync），
    // 这样将来新加的上行指令默认对观战者关闭，不需要回来补黑名单。
    const allowed = type === MSG.MOVE ? canSendAsRole(this.role, type) : canSendAsRoleStrict(this.role, type);
    if (!allowed) {
      this.emit('spectator-blocked', { type });
      return false;
    }
    // 服务端把 MSG.LOBBY 当"玩家列表推送"用（见 WsServer.broadcastPlayers），但它也是 C→S 的
    // "回大厅"指令。联机连接里这条上行会被服务端回一句 E_STATE 红字，直接吞掉更干净。
    if (type === MSG.LOBBY && this.channel === 'lobby') {
      this.emit('spectator-blocked', { type });
      return false;
    }
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
        // 联机 welcome 额外带 room / players（单机路径没有这两个键，保持老协议不变）
        this.room = p.room ?? null;
        if (Array.isArray(p.players)) this.players = p.players.slice();
        this.store.welcome(p);
        this.setConnected(true);
        // 同一会话在别处重连时，服务端会把自己的连接降级为观战：这不等于断线，但要明确告知玩家
        this.emit('welcome', p);
        // 只有**单机通道**的观战才是「被另一个窗口抢走了控制权」。
        // 联机房间（welcome 里带 room）里 spectator 是房间里的正常身份（还没选座位 / 这局已开局只能看），
        // 那是房间座位表说的，不是"别的窗口抢了你的电脑"，别用那句红条去吓人 —— 房间页由座位表自己说明。
        if (this.role === 'spectator' && !p.room) {
          this.emit('spectator', { reason: 'occupied', message: '本窗口已转为观战：游戏正在另一个窗口里进行' });
        }
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
      case MSG.LOBBY:
        // 这里收到的 lobby 是服务端推来的**玩家列表**（WsServer.broadcastPlayers 用的是同一个常量）。
        // 上行那条同名消息在 send() 里已经被拦掉了，所以"收到 players 就更新列表"不会有歧义。
        if (Array.isArray(p?.players)) {
          this.pushLobby = true;
          this.players = p.players.slice();
          this.emit('players', this.players);
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
