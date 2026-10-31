// 联机大厅的 HTTP 入口：服务器源地址（TailScale Funnel）上的 /join 接口。
// 需求 3：URL 带 token/id/type/roomid/invcode/username；
//   create → 建房（同一用户只能一间，违规累计 3 次封禁）；
//   join   → 房间号 + Token 校验匹配才允许进入，否则一律 500；
//   ID 密钥格式不符（被篡改）→ 500。
// 只有被设置为「服务器源」的实例会挂载这些路由。

import { isValidIdKey } from './IdKey.js';
import { parseRoomUrl } from './RoomManager.js';

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

const send = (res, status, body) => {
  res.writeHead(status, HEADERS);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/** TailScale Funnel 会带 x-forwarded-* 头，联机模式允许任意来源。 */
export function crossOriginOk(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

/**
 * @returns {(req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse)=>boolean}
 *          返回 true 表示已经处理（呼吸完毕），false 表示不归本模块管。
 */
export function createLobbyRouter({
  rooms,
  idKey,
  serverName = '服务器源',
  logger = console,
  isServerSource = true,
  // 联机（v0.3）：online 是一个可变对象 { enabled, mode, serverUrl, token, port }，
  // 由 server/index.js 在 TailScale 就绪后回填；switchMode 用于设置页切换 serve/funnel。
  online = null,
  switchMode = null,
}) {
  return (req, res) => {
    crossOriginOk(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      send(res, 400, { ok: false, error: 'bad url' });
      return true;
    }
    if (path === '/api/net/info') {
      send(res, 200, {
        ok: true,
        name: serverName,
        serverSource: isServerSource,
        idKeyHint: `${idKey.slice(0, 8)}…`,
        idKey,
        rooms: [...rooms.rooms.values()].length,
      });
      return true;
    }
    // 联机状态：客户端设置页用它判断「本机是否已经是服务器源」并回显地址/模式
    if (path === '/api/net/online' && req.method !== 'POST') {
      send(res, 200, {
        ok: true,
        online: online
          ? { enabled: Boolean(online.enabled), mode: online.mode ?? 'serve', serverUrl: online.serverUrl ?? '', port: online.port ?? null, hasToken: Boolean(online.token) }
          : { enabled: false, mode: 'serve', serverUrl: '', port: null, hasToken: false },
      });
      return true;
    }
    // 设置页切换 serve ↔ funnel（会真的调用 tailscale serve/funnel --bg <port>）
    if (path === '/api/net/online/mode' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 4096) req.destroy();
      });
      req.on('end', async () => {
        let mode = '';
        try {
          mode = String(JSON.parse(body || '{}').mode ?? '');
        } catch {
          return send(res, 400, { ok: false, error: 'bad json' });
        }
        if (mode !== 'serve' && mode !== 'funnel') return send(res, 400, { ok: false, error: 'mode 只能是 serve 或 funnel' });
        if (typeof switchMode !== 'function') return send(res, 501, { ok: false, error: '本实例未启用 TailScale 集成' });
        const out = await switchMode(mode);
        send(res, out.ok ? 200 : 500, { ok: Boolean(out.ok), mode, serverUrl: out.url ?? '', error: out.ok ? undefined : out.message ?? '切换失败' });
      });
      return true;
    }
    if (path === '/api/net/room') {
      const q = new URL(req.url, 'http://x').searchParams;
      const room = rooms.rooms.get(String(q.get('roomid') ?? ''));
      send(res, room ? 200 : 500, room ? { ok: true, room: rooms.view(room) } : { ok: false, error: '房间不存在' });
      return true;
    }
    if (path === '/api/net/join') {
      const parsed = parseRoomUrl(`http://x${req.url}`);
      if (!parsed.ok) {
        send(res, 500, { ok: false, error: parsed.message });
        return true;
      }
      const u = parsed.url;
      if (!isValidIdKey(u.idKey)) {
        logger.warn?.('[net] ID 密钥格式非法，拒绝');
        send(res, 500, { ok: false, error: 'ID 密钥格式非法' });
        return true;
      }
      const username = u.username || '匿名';
      const out = u.type === 'create'
        ? rooms.create({ idKey: u.idKey, username, token: u.token })
        : rooms.join({ idKey: u.idKey, username, roomId: u.roomId, token: u.token, invCode: u.invCode });
      if (!out.ok) {
        send(res, out.status ?? 500, { ok: false, error: out.message, code: out.code });
        return true;
      }
      const view = rooms.view(out.room);
      send(res, 200, { ok: true, room: view, created: Boolean(out.created), wsPath: `/ws?roomid=${view.id}&token=${view.token}` });
      return true;
    }
    return false;
  };
}
