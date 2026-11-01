// 联机大厅的 HTTP 入口：服务器源地址（TailScale Funnel）上的 /join 接口。
// 需求 3：URL 带 token/id/type/roomid/invcode/username；
//   create → 建房（同一用户只能一间，违规累计 3 次封禁）；
//   join   → 房间号 + Token 校验匹配才允许进入，否则一律 500；
//   ID 密钥格式不符（被篡改）→ 500。
// 只有被设置为「服务器源」的实例会挂载这些路由。

import { isValidIdKey } from './IdKey.js';
import {
  classifyMode,
  diffConfig,
  emptyServeFacts,
  funnelCaps,
  isLocalManageRequest,
  maskToken,
  normalizeMode,
  readServeConfig,
} from './OnlineAdmin.js';
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
  // 设置页（v0.5）：adminInfo() 组装 GET /api/net/admin 的整包数据（含 rooms/settings/漂移检测结果）；
  // tailscaleFacts() 是带缓存的 tailscale 事实（安装/运行/能力/serve 状态），null 时本模块自己兜底读。
  // 两者都必须只给「脱敏后」的数据：本模块发出去之前还会再过一遍脱敏与护栏函数。
  adminInfo = null,
  tailscaleFacts = null,
  // 设置页「显示完整 Token」/「重新生成 Token」（v0.5）：两个都只对本机开放。
  //   readToken()        → 返回 { token }（完整 256 字符 hex）
  //   regenerateToken()  → 返回 { token, masked, length } 并已落盘
  // 不注入时对应接口返回 501，前端按「当前服务端版本不支持」处理。
  readToken = null,
  regenerateToken = null,
  // 桌面宿主（v0.4）：内嵌 WebView2 窗口需要知道「这个端口上是不是我们的服务」，并能在托盘「退出」时关停它。
  // 只实现这两个控制端点，别的什么都不暴露；quit 还要求请求来自回环地址 + launcher 标记头。
  appInfo = null,
  requestQuit = null,
}) {
  const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  const MANAGE_DENIED = '只允许本机设置页修改联机配置';

  /** 事实源：优先用注入的 tailscaleFacts()（index.js 里带 1.5s 缓存），没有就现场读一遍。 */
  const factsSource = async () => {
    if (typeof tailscaleFacts === 'function') {
      try {
        const f = await tailscaleFacts();
        if (f && typeof f === 'object') return f;
      } catch {
        /* 落到下面的兜底 */
      }
    }
    const serve = await readServeConfig(null);
    const st = classifyMode(serve);
    return { installed: false, running: false, backendState: '', hostname: '', dnsName: serve.dnsName || '', url: '', funnelCapable: false, funnelPorts: [], serve, classify: st };
  };

  /** 256 位 hex 视作 idKey/密钥，一律打码（宁可错杀，也不把完整密钥发出去）。 */
  const SECRET_HEX = /^[0-9a-f]{256}$/i;

  /**
   * 脱敏 + 结构护栏：adminInfo() 是外部注入的，这里再兜一遍底——
   * 完整 token / 完整 idKey（256 位 hex）一律不许出现在新接口的响应里，
   * 哪怕上游忘了打码，也不可能从这里漏出去。
   */
  const sanitizeAdmin = (raw) => {
    const out = raw && typeof raw === 'object' ? { ...raw } : {};
    const scrubStr = (v) => {
      const s = String(v == null ? '' : v);
      if (SECRET_HEX.test(s)) return { masked: s.slice(0, 8) + '…（共 ' + s.length + ' 位）', present: true, length: s.length };
      return null;
    };
    if (out.idKey && typeof out.idKey === 'object') {
      const next = { ...out.idKey };
      delete next.full;
      delete next.key;
      delete next.value;
      if (typeof out.idKey.hint !== 'string' || !out.idKey.hint) next.hint = String(idKey || '').slice(0, 8) + '…';
      out.idKey = next;
    }
    if (out.online && typeof out.online === 'object') {
      const next = { ...out.online };
      delete next.token;
      delete next.idKey;
      if (typeof next.hasToken !== 'boolean') next.hasToken = Boolean(online && online.token);
      const mt = maskToken(online && online.token ? online.token : '');
      if (typeof next.tokenMasked !== 'string' || !next.tokenMasked) next.tokenMasked = mt.masked;
      if (typeof next.tokenLength !== 'number') next.tokenLength = mt.length;
      out.online = next;
    }
    // 递归清掉任何 256 位 hex 字符串字段（idKey 泄漏的最后一道闸）
    const walk = (node, depth) => {
      if (depth > 4 || !node || typeof node !== 'object') return node;
      if (Array.isArray(node)) {
        const acc = [];
        for (const v of node) {
          if (typeof v === 'string') {
            const hit = SECRET_HEX.test(v) ? v.slice(0, 8) + '…（共 ' + v.length + ' 位）' : v;
            acc.push(hit);
          } else acc.push(walk(v, depth + 1));
        }
        return acc;
      }
      const acc = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === 'raw') continue; // serve status 的原始输出没必要下发
        if (typeof v === 'string') {
          const hit = scrubStr(v);
          acc[k] = hit ? hit.masked : v;
        } else {
          acc[k] = walk(v, depth + 1);
        }
      }
      return acc;
    };
    return walk(out, 0);
  };

  const route = (req, res, path) => {
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
    // 联机状态：客户端设置页用它判断「本机是否已经是服务器源」并回显地址/模式。
    // v0.5 给设置页补了三段事实：online 的端口/token 打码、tailscale 探测结果、配置漂移。
    // 原有的 enabled/mode/serverUrl/port/hasToken 五个字段保持原样，老客户端不会炸。
    if (path === '/api/net/online' && req.method !== 'POST') {
      const mt = maskToken(online && online.token ? online.token : '');
      const base = online
        ? { enabled: Boolean(online.enabled), mode: online.mode ?? 'serve', serverUrl: online.serverUrl ?? '', port: online.port ?? null, hasToken: Boolean(online.token) }
        : { enabled: false, mode: 'serve', serverUrl: '', port: null, hasToken: false };
      Promise.resolve()
        .then(() => factsSource())
        .catch(() => null)
        .then((facts) => {
      const serve = facts && facts.serve ? facts.serve : emptyServeFacts('');
      const cls = facts && facts.classify ? facts.classify : classifyMode(serve);
      const drift = diffConfig({ expose: { enabled: base.enabled, mode: base.mode || online?.mode, port: online?.port ?? null, actualPort: online?.port ?? null }, isServerSource, tailscale: facts || {} }, serve);
      send(res, 200, {
        ok: true,
        online: {
          ...base,
          mode: normalizeMode(base.mode) ?? base.mode,
          tokenMasked: mt.masked,
          tokenLength: mt.length,
          portFile: (facts && facts.portFile) || '',
        },
        tailscale: {
          installed: Boolean(facts && facts.installed),
          version: (facts && facts.version) || '',
          running: Boolean(facts && facts.running),
          backendState: (facts && facts.backendState) || '',
          hostname: (facts && facts.hostname) || '',
          dnsName: (facts && (facts.dnsName || serve.dnsName)) || '',
          url: (facts && facts.url) || '',
          funnelCapable: Boolean(facts && facts.funnelCapable),
          funnelPorts: (facts && Array.isArray(facts.funnelPorts) ? facts.funnelPorts : []).slice(),
          mode: cls.mode,
          tailnetAvailable: Boolean(cls.tailnetAvailable),
          servePort: cls.port,
          serveStatus: serve,
        },
        drift,
      });
        })
        .catch((err) => {
          try {
            send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
          } catch { /* 已发出 */ }
        });
      return true;
    }
    // 设置页切换 tailnet ↔ funnel ↔ off（会真的调用 tailscale serve/funnel --bg <port> 或 reset）。
    // 管理写操作只对本机开放：回环来源 + Host 头指向本机，否则 403。
    if (path === '/api/net/online/mode' && req.method === 'POST') {
      if (!isLocalManageRequest(req)) {
        send(res, 403, { ok: false, error: MANAGE_DENIED });
        return true;
      }
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 4096) req.destroy();
      });
      req.on('end', async () => {
        let rawMode = '';
        try {
          rawMode = String(JSON.parse(body || '{}').mode ?? '');
        } catch {
          return send(res, 400, { ok: false, error: 'bad json' });
        }
        // 兼容：新值 tailnet/funnel/off，旧值 serve（当 tailnet）/funnel
        const mode = normalizeMode(rawMode);
        if (!mode) return send(res, 400, { ok: false, error: 'mode 只能是 tailnet、funnel 或 off' });
        if (typeof switchMode !== 'function') return send(res, 501, { ok: false, error: '本实例未启用 TailScale 集成' });
        let out;
        try {
          out = await switchMode(mode);
        } catch (err) {
          out = { ok: false, message: String(err && err.message ? err.message : err) };
        }
        const messages = {
          'funnel-unavailable': '本机 TailScale 没能开启 Funnel（当前节点没有 funnel 能力或端口不被允许），已保持仅 tailnet 可见',
          'no-binary': '本机没有安装 TailScale',
        };
        send(res, out && out.ok ? 200 : 500, {
          ok: Boolean(out && out.ok),
          mode: (out && out.mode) || mode,
          requestedMode: mode,
          serverUrl: (out && out.url) || '',
          code: (out && out.code) || undefined,
          message: out && out.ok ? undefined : messages[(out && out.code)] || (out && out.message) || '切换失败',
          error: out && out.ok ? undefined : messages[(out && out.code)] || (out && out.message) || '切换失败',
        });
      });
      return true;
    }
    // 设置页整包事实（GET，仅回环）：应用/数据目录/端口/房号摘要/设置/TailScale/漂移。
    // 绝不包含完整 token 与完整 idKey：token 只给 tokenMasked，idKey 只给 idKeyHint。
    if (path === '/api/net/admin') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { ok: false, error: '只接受 GET' });
        return true;
      }
      if (!isLocalManageRequest(req)) {
        send(res, 403, { ok: false, error: MANAGE_DENIED });
        return true;
      }
      if (typeof adminInfo !== 'function') {
        send(res, 404, { ok: false, error: '本实例未启用联机管理接口' });
        return true;
      }
      Promise.resolve()
        .then(() => adminInfo())
        .then((info) => {
          if (!info || typeof info !== 'object') {
            send(res, 404, { ok: false, error: '本实例未启用联机管理接口' });
            return;
          }
          send(res, 200, { ok: true, ...sanitizeAdmin(info) });
        })
        .catch((err) => send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) }));
      return true;
    }
    // 设置页「显示完整 Token」：只对本机开放，且必须是 GET。
    // 这是唯一会把完整 token 发出去的接口——脱敏层只作用于 /api/net/admin。
    if (path === '/api/net/admin/token') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { ok: false, error: '只接受 GET' });
        return true;
      }
      if (!isLocalManageRequest(req)) {
        send(res, 403, { ok: false, error: MANAGE_DENIED });
        return true;
      }
      if (typeof readToken !== 'function') {
        send(res, 501, { ok: false, error: '本实例未启用联机管理接口' });
        return true;
      }
      Promise.resolve()
        .then(() => readToken())
        .then((out) => {
          const token = String((out && out.token) || '');
          if (!token) {
            send(res, 200, { ok: true, token: '', length: 0, hasToken: false });
            return;
          }
          send(res, 200, {
            ok: true,
            token,
            length: token.length,
            hasToken: true,
            masked: maskToken(token).masked,
          });
        })
        .catch((err) => send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) }));
      return true;
    }
    // 设置页「重新生成 Token」：只对本机开放，POST，生成后立即落盘并让已有房间失效由上层处理。
    if (path === '/api/net/token/regenerate' && req.method === 'POST') {
      if (!isLocalManageRequest(req)) {
        send(res, 403, { ok: false, error: MANAGE_DENIED });
        return true;
      }
      if (typeof regenerateToken !== 'function') {
        send(res, 501, { ok: false, error: '本实例未启用联机管理接口' });
        return true;
      }
      // 吞掉请求体，避免 keep-alive 下残留数据污染下一个请求
      req.on('data', () => {});
      req.on('end', () => {
        Promise.resolve()
          .then(() => regenerateToken())
          .then((out) => {
            const token = String((out && out.token) || '');
            const mt = maskToken(token);
            // 注意：这里不回完整 token，只回掩码；要看全文请再调 /api/net/admin/token
            send(res, 200, {
              ok: true,
              tokenMasked: (out && out.masked) || mt.masked,
              tokenLength: typeof (out && out.length) === 'number' ? out.length : mt.length,
              hasToken: Boolean(token) || Boolean(out && out.ok),
            });
          })
          .catch((err) => send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) }));
      });
      return true;
    }
    // ---- 桌面宿主控制端点（v0.4）
    // 宿主（launch.exe）启动内核后靠 ping 确认端口上跑的是本游戏，而不是别的软件占着同一端口。
    if (path === '/api/app/ping') {
      let extra = {};
      try {
        extra = (typeof appInfo === 'function' ? appInfo() : appInfo) ?? {};
      } catch {
        extra = {};
      }
      send(res, 200, { ok: true, app: 'jican-simulator', pid: process.pid, ...extra });
      return true;
    }
    // 托盘菜单「退出」→ 宿主调用这里优雅关停；必须是本机 + 带 launcher 标记头。
    // （网页里的第三方脚本既跨不过 CSP connect-src 'self'，也拿不到这个头，双重保险。）
    if (path === '/api/app/quit') {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: '只接受 POST' });
        return true;
      }
      if (!isLoopback(req.socket?.remoteAddress)) {
        send(res, 403, { ok: false, error: '只允许本机调用' });
        return true;
      }
      if (String(req.headers['x-jican-client'] ?? '') !== 'launcher') {
        send(res, 403, { ok: false, error: '缺少启动器标记' });
        return true;
      }
      if (typeof requestQuit !== 'function') {
        send(res, 501, { ok: false, error: '本实例未启用宿主控制' });
        return true;
      }
      send(res, 200, { ok: true });
      // 先把响应发出去再关停，否则宿主侧会看到连接被重置
      setTimeout(() => { try { requestQuit(); } catch { /* 忽略 */ } }, 30);
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

  // 对外入口：同步返回布尔值（true = 本模块已接管），所以不能写成 async 函数。
  // 认得的路径才算「归我管」，未注册的路径一律 false 交回上层（主机壳要靠这个挂 /api/local/*）。
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
    try {
      return route(req, res, path);
    } catch (err) {
      logger.warn?.('[net] 大厅接口异常：' + (err && err.message ? err.message : err));
      try {
        send(res, 500, { ok: false, error: 'internal' });
      } catch { /* 响应已发出 */ }
      return true;
    }
  };
}
