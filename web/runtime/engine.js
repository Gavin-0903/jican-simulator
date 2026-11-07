// 纯网页版引擎：在浏览器里跑服务端权威游戏（GameController + MessageRouter），
// 再把它包装成本地 WebSocket 连接。联机（/lobby）没有实现，见 boot.js。
import { GameController } from '../../server/core/GameController.js';
import { GameMap } from '../../server/world/GameMap.js';
import { MessageRouter } from '../../server/net/MessageRouter.js';
import { MSG, PROTOCOL_VERSION } from '../../shared/constants.js';

export function createEngine({ app, balance, llm, mapData, serverVersion, saveManager = null }) {
  const map = new GameMap(mapData);
  const controller = new GameController({
    config: { app, balance, llm, mapData },
    map,
    saveManager: saveManager,
    gateway: null,
    logger: console,
  });
  const router = new MessageRouter({ controller, logger: console });
  const conns = new Set();

  controller.on('packet', (type, payload) => {
    for (const conn of conns) if (conn.ready) conn.send(type, payload);
  });
  controller.on('private', (type, payload) => {
    for (const conn of conns) if (conn.ready && conn.role === 'controller') conn.send(type, payload);
  });
  controller.on('privateTo', (viewerKey, type, payload) => {
    for (const conn of conns) if (conn.ready && String(conn.viewerKey) === String(viewerKey)) conn.send(type, payload);
  });

  function attach(ws) {
    const conn = {
      ready: false,
      role: 'controller',
      viewerKey: 'web:local',
      wss: ws,
      seq: 0,
      send(type, payload) {
        this.seq += 1;
        ws._deliver(JSON.stringify({ v: PROTOCOL_VERSION, type, seq: this.seq, ts: Date.now(), payload }));
      },
      error(code, message, refSeq) {
        this.send(MSG.ERROR, { code, message, refSeq: refSeq == null ? null : refSeq });
      },
      close() {
        conns.delete(conn);
      },
    };
    conns.add(conn);
    ws._conn = conn;

    conn.ready = true;
    conn.send(MSG.WELCOME, {
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: serverVersion || 'web',
      tickRate: app.tickRate,
      mapId: map.id,
      serverTime: Date.now(),
      sessionId: 'local-web',
      role: 'controller',
      resumed: false,
      lobby: controller.lobbyInfo(),
    });
    for (const msg of controller.initialMessages(null, conn.viewerKey)) {
      conn.send(msg[0], msg[1]);
    }
    controller.onConnectionRestored();
    return conn;
  }

  function receive(ws, raw) {
    const conn = ws._conn;
    if (!conn || !conn.ready) return;
    let env;
    try {
      env = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch (e) {
      return conn.error('E_BADMSG', '不是合法的 JSON');
    }
    if (!env || env.v !== PROTOCOL_VERSION) return conn.error('E_PROTO', '协议版本不符');
    if (!env.type || typeof env.type !== 'string') return conn.error('E_BADMSG', '缺少消息类型');
    const payload = env.payload && typeof env.payload === 'object' ? env.payload : {};
    // 真实服务端在 WsServer 层就吃掉了 hello 握手（不进 MessageRouter）：纯网页版同样直接忽略，
    // 否则 router 会回一句「不支持的消息」，玩家大厅里会莫名多一条红字。
    if (env.type === MSG.HELLO) return;
    try {
      const out = router.handle(conn, { type: env.type, payload: payload, seq: env.seq == null ? null : env.seq });
      if (out && typeof out.catch === 'function') out.catch((err) => {
        console.error('[web] 消息处理出错', err);
        conn.error('E_STATE', '处理出错：' + (err && err.message ? err.message : err));
      });
    } catch (err) {
      console.error('[web] 消息处理出错', err);
      conn.error('E_STATE', '处理出错：' + (err && err.message ? err.message : err));
    }
  }

  return { controller: controller, router: router, attach: attach, receive: receive, map: map };
}