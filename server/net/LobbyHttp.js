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
import { buildRoomUrl, parseRoomUrl } from './RoomManager.js';

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

const send = (res, status, body) => {
  res.writeHead(status, HEADERS);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/**
 * POST/Q 进房（v0.10）：给「房间已开局」那一关开一扇门 —— 已经在这间房里的身份重连要放行。
 *
 * 用户报的现象：「两个窗口互相只能观战，开不了战斗」。根因是开局之后**同一个身份**再连一次
 * （浏览器开第二个窗口 / 关掉游戏窗口再打开 / 刷新）会撞上 rooms.join 的 ROOM_STARTED，
 * 于是那条连接被 403 打断、前端无限重连，界面停在最后一帧，用户看到的就是"只能观战"。
 *
 * 判据必须是「这个 idKey 已经是这间房的人」，不能让真新人借开局后的连接混进来：
 *   ① idKey === room.ownerId（房主本人）；
 *   ② 房间级身份表（rooms.identityOf）里这个 idKey 绑的就是这个名字，或者 name 已在 members 里；
 * 只满足①或②才走「已经进来过」的返回（不新增成员、不重排申请），其余一律照旧拒绝。
 */
function joinOrReturn(rooms, u, username) {
  const room = rooms.rooms.get(String(u.roomId ?? ''));
  if (room && room.started) {
    // 被踢的人不在这里放行：他的语义是「你被请出去了」，必须照旧 KICKED（rooms.join 会判）
    if (typeof rooms.isKicked === 'function' && rooms.isKicked(room, username)) {
      return rooms.join({ idKey: u.idKey, username, roomId: u.roomId, token: u.token, invCode: u.invCode });
    }
    const key = String(u.idKey ?? '');
    const bound = typeof rooms.identityOf === 'function' ? rooms.identityOf(room, key) : null;
    // members.has 这一条要看**这个 idKey 绑的名字**，不能看请求里自报的 username ——
    // 否则谁都能拿一次"路人甲"的名字去 JOIN，只要撞上房里某个成员名就被放进来。
    const known = Boolean(key) && (String(room.ownerId ?? '') === key
      || Boolean(bound) && (!username || String(bound) === username));
    if (known) {
      // 认亲成功：补一条房间级身份绑定（HTTP 进房本来就不经过 LobbyGateway.resolve，
      // 不写这一条的话，ws 握手时 LobbyGateway.isSeat 翻不到他的名字，会被判成观战）。
      if (typeof rooms.bindIdentity === 'function') rooms.bindIdentity(room, key, username);
      return { ok: true, room, pending: false, rejoined: true };
    }
  }
  return rooms.join({ idKey: u.idKey, username, roomId: u.roomId, token: u.token, invCode: u.invCode });
}

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
  // 服务端配置读写（v0.6）：configAdmin 由 server/index.js 组装（校验 + 落盘 + 热生效 + 推送 balance），
  // 本模块只负责路由与错误码映射。接口形状：describe() → GET 响应体，apply(body)/reset(body) → { ok, ... }。
  configAdmin = null,
  // 联机网关（v0.3）：玩家列表与邀请链接要读房间表 + 角色选择，交给 LobbyGateway 统一算，
  // 免得 HTTP 这边再写一套「谁是房主/谁在观战」的判定（两套判定必然漂移）。
  lobby = null,
  // 广播函数：房间成员变化后让所有 ws 连接收到新的玩家列表。不注入就不广播（测试里常见）。
  broadcastPlayers = null,
}) {
  const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  const MANAGE_DENIED = '只允许本机设置页修改联机配置';

  // 预探测限流（v0.3）：/api/net/room/check 是**不需要登录**的 GET，放在公网（TailScale Funnel）上
  // 谁都能刷。前端正常用法是「进面板问一次、点连接问一次」，1 分钟 120 次远远够用；
  // 超过就说明不是人在点。用内存 Map 而不是引依赖：这里只需要一个粗粒度的闸门，
  // 进程重启清零也可以接受（限流是防刷，不是配额记账）。
  const CHECK_WINDOW_MS = 60_000;
  const CHECK_MAX_PER_WINDOW = 120;
  /** ip → { count, resetAt } */
  const checkHits = new Map();
  /** 惰性清理：只在有请求进来时顺手扫一遍过期条目，不搞定时器（定时器会让进程无法自然退出/测试挂住）。 */
  const sweepCheckHits = (now) => {
    if (checkHits.size < 512) return;
    for (const [ip, hit] of checkHits) if (hit.resetAt <= now) checkHits.delete(ip);
  };
  /** 记一次预探测；返回 false 表示这个 IP 本轮已超限。 */
  const allowCheckHit = (ip, now = Date.now()) => {
    sweepCheckHits(now);
    const key = ip || 'unknown';
    const hit = checkHits.get(key);
    if (!hit || hit.resetAt <= now) {
      checkHits.set(key, { count: 1, resetAt: now + CHECK_WINDOW_MS });
      return true;
    }
    hit.count += 1;
    return hit.count <= CHECK_MAX_PER_WINDOW;
  };
  /** 取客户端地址：TailScale Funnel 会在前面加一层代理，x-forwarded-for 的第一个才是真实来源。 */
  const clientIp = (req) => {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    const raw = fwd || String(req.socket?.remoteAddress ?? '');
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  };
  /** 测试用：清空限流窗口（生产路径不调用）。 */
  const resetCheckRateLimit = () => checkHits.clear();

  /**
   * 读 JSON 请求体（带体积上限）：超限直接掐连接，避免有人拿超大 body 把设置页进程撑爆。
   * 为什么单独抽出来：配置接口有 GET/POST/reset 三处都要读体，而现有接口各自内联一份读体代码。
   */
  const readJsonBody = (req, limit, onDone) => {
    let body = '';
    let aborted = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) {
        aborted = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) return;
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        return onDone({ ok: false, error: 'bad json' });
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return onDone({ ok: false, error: '请求体必须是 JSON 对象' });
      onDone({ ok: true, body: parsed });
    });
    req.on('error', () => { aborted = true; });
  };

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
    // 玩家列表（v0.3）：NetPanel 的首屏数据 + 房间成员变化后重新拉一次。
    // 不给 token、不给完整 idKey —— 列表是给别人看的，只给够区分的前 8 位提示。
    if (path === '/api/lobby/players') {
      if (!lobby) {
        send(res, 501, { ok: false, error: '本实例未启用联机网关' });
        return true;
      }
      const q = new URL(req.url, 'http://x').searchParams;
      const roomId = String(q.get('roomid') ?? '');
      let players = lobby.playerList();
      // 带 roomid 时只回这个房间的人（前端「本房间」视图用）；不带就是全服务器源
      if (roomId) players = players.filter((p) => String(p.roomId) === roomId);
      send(res, 200, { ok: true, count: players.length, players });
      return true;
    }
    // 连接预探测（v0.3）：前端在连 /lobby 之前先问一句「这组参数到底行不行」。
    // 为什么要它：浏览器 WebSocket API 在握手被拒时只给 close(1006)，页面拿不到 400/404 与 code。
    // 这里复用 LobbyGateway.resolve 的同一套判定（probe=true：只校验、不建房间、不占座、不加成员），
    // 失败时回**真实 HTTP 状态码** + {ok:false,status,code,error}，前端直接显示到连接横幅上。
    if (path === '/api/net/room/check') {
      crossOriginOk(res);
      // 先限流再干活：这是个无鉴权的公网 GET，被脚本刷起来会白烧 CPU 与日志
      if (!allowCheckHit(clientIp(req))) {
        send(res, 429, { ok: false, status: 429, code: 'RATE_LIMIT', error: '请求过于频繁' });
        return true;
      }
      if (!lobby) {
        send(res, 501, { ok: false, status: 501, code: 'LOBBY_DISABLED', error: '本实例未启用联机网关' });
        return true;
      }
      const qs = new URL(req.url, 'http://x').search;
      let out;
      try {
        out = lobby.resolve(qs, { probe: true });
      } catch (err) {
        logger.warn?.('[net] 房间预探测异常：' + String(err && err.message ? err.message : err));
        send(res, 500, { ok: false, status: 500, code: 'INTERNAL', error: '服务器内部错误' });
        return true;
      }
      if (!out.ok) {
        send(res, out.status ?? 400, { ok: false, status: out.status ?? 400, code: out.code ?? 'BAD_REQUEST', error: out.message ?? '参数不合法' });
        return true;
      }
      const view = out.room ? rooms.view(out.room) : null;
      send(res, 200, {
        ok: true,
        room: view ? { id: view.id, owner: view.owner, memberCount: Array.isArray(view.members) ? view.members.length : 0 } : null,
        seat: !!out.seat,
        role: out.role,
      });
      return true;
    }
    // 邀请链接（v0.3）：房主点「复制邀请」时生成。别名叫 /api/net/room/:id/invite，
    // 用 username 指定「这是给谁的」（写进链接，对方打开就是这个名字）。
    {
      const m = /^\/api\/net\/room\/([^/]+)\/invite$/.exec(path);
      if (m) {
        const q = new URL(req.url, 'http://x').searchParams;
        const roomId = decodeURIComponent(m[1]);
        const room = rooms.rooms.get(roomId);
        if (!room) {
          send(res, 404, { ok: false, error: '房间不存在或已关闭', code: 'ROOM_NOT_FOUND' });
          return true;
        }
        const view = rooms.view(room);
        const username = String(q.get('username') ?? '').trim() || '玩家';
        // 邀请链接指向「本服务器源的公开地址」：直连时用请求的 Host，走 tailnet 时用 online.serverUrl
        const host = String(req.headers.host ?? '');
        const origin = String(online?.serverUrl || '').replace(/\/+$/, '') || `http://${host || '127.0.0.1'}`;
        const url = buildRoomUrl(origin, {
          token: view.token,
          idKey: String(idKey ?? ''),
          type: 'join',
          roomId: view.id,
          invCode: view.invCode,
          username,
        });
        send(res, 200, { ok: true, roomId: view.id, username, invcode: view.invCode, url, wsPath: `/lobby?type=join&roomid=${view.id}&token=${view.token}&invcode=${view.invCode}&id=${encodeURIComponent(String(idKey ?? ''))}&username=${encodeURIComponent(username)}` });
        return true;
      }
    }
    // ── 房主控制（v0.8）：开始游戏 / 踢人 / 审批入房申请 ────────────────────────
    // 四条路由的 body 形状统一是 { roomid, id }（+ 审批/踢人再加 username），id 是操作者的 ID 密钥。
    // 鉴权就一条：id 必须是这间房的 ownerId。**不走 isLocalManageRequest**：房主可能正通过
    // TailScale 从另一台机器（手机/朋友家）点「开始」，把它锁死在本机会让联机完全没法用。
    // 房主身份由 ownerId 兜住——不知道房主的 256 位 ID 密钥就没法冒充。
    if (path.startsWith('/api/lobby/room/')) {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, status: 405, code: 'BAD_REQUEST', error: '只接受 POST' });
        return true;
      }
      if (!lobby) {
        send(res, 501, { ok: false, status: 501, code: 'LOBBY_DISABLED', error: '本实例未启用联机网关' });
        return true;
      }
      const action = path.slice('/api/lobby/room/'.length);
      // 'seat' / 'settings' 是 v0.9 座位制新增：前者占座（房主可替他人指派），后者改单局参数。
      // 'close' 是 v0.11 新增：房主清除房间（停止并删除）。删掉之后那个 id 立刻失效。
      if (!['start', 'kick', 'approve', 'reject', 'seat', 'settings', 'close'].includes(action)) {
        send(res, 404, { ok: false, status: 404, code: 'NOT_FOUND', error: '未知的房间操作：' + action });
        return true;
      }
      readJsonBody(req, 8 * 1024, (parsed) => {
        if (!parsed.ok) return send(res, 400, { ok: false, status: 400, code: 'BAD_REQUEST', error: parsed.error });
        const b = parsed.body ?? {};
        const roomId = String(b.roomid ?? b.roomId ?? '').trim();
        const operator = String(b.id ?? b.idKey ?? '').trim();
        const username = String(b.username ?? '').trim();
        if (!roomId) return send(res, 400, { ok: false, status: 400, code: 'BAD_REQUEST', error: '缺少 roomid' });
        if (!operator) return send(res, 400, { ok: false, status: 400, code: 'BAD_REQUEST', error: '缺少 id（房主的 ID 密钥）' });
        // settings 是房主一个人说了算，不需要 username；seat 的 username 可省略（= 给自己占座）
        if (action !== 'start' && action !== 'settings' && action !== 'seat' && action !== 'close' && !username) {
          return send(res, 400, { ok: false, status: 400, code: 'BAD_REQUEST', error: '缺少 username' });
        }
        let out;
        try {
          if (action === 'start') out = lobby.startRoom(roomId, operator);
          else if (action === 'close') {
            // 清除房间（v0.11）：把房间从表里摘掉，再让这一局的 controller 退回大厅。
            // rooms.close 里已经校验了「只有 ownerId 能删」，房主之外的请求会拿到 403 NOT_OWNER。
            out = rooms.close(roomId, operator);
            if (out.ok && typeof lobby.closeRoom === 'function') {
              try {
                // 把被删房间的快照一起传进去：里面带着这间房的 idKey→用户名 绑定，收尾时一起清。
                lobby.closeRoom(roomId, out.room ?? null);
              } catch (err) {
                logger.warn?.('[net] 清除房间时停止对局失败：' + String(err && err.message ? err.message : err));
              }
            }
          }
          else if (action === 'kick') out = rooms.kick(roomId, operator, username);
          else if (action === 'approve') out = rooms.approve(roomId, operator, username);
          else if (action === 'reject') out = rooms.reject(roomId, operator, username);
          else if (action === 'seat') {
            // 座位制：{ roomid, id, username?, characterId }
            // - username 省略 = 给自己占座
            // - 房主传 username = 替那位成员指定角色（RoomManager.claimSeat 里校验）
            // target = 要落座的人：body 里的 username（房主替人指派），否则就是操作者本人。
            // 必须把 room 传给 usernameOf —— idKey→username 的映射是**房间级**的
            // （同一个人在不同房间可以是不同名字），漏了 room 就翻不出来。
            const seatRoom = rooms.rooms.get(roomId) ?? null;
            const target = username || (typeof lobby.usernameOf === 'function' ? lobby.usernameOf(operator, seatRoom) : '');
            const characterId = b.characterId == null ? '' : String(b.characterId).trim();
            out = typeof lobby.claimSeat === 'function'
              ? lobby.claimSeat(roomId, operator, target, characterId)
              : rooms.claimSeat(roomId, operator, target, characterId);
          } else {
            // 游戏参数：{ roomid, id, durationMs?, targetScore? } —— 只有房主能改（setSettings 里判）。
            // 只把**请求里真的带了的键**传给 setSettings：不带 = 保持不变，
            // 显式 null = 该项回默认。写成 {durationMs: b.durationMs, targetScore: b.targetScore}
            // 会把没带的键也当成 null 送进去，改一项就顺手清空另一项（真踩过）。
            const patch = {};
            if (Object.prototype.hasOwnProperty.call(b, 'durationMs')) patch.durationMs = b.durationMs;
            if (Object.prototype.hasOwnProperty.call(b, 'targetScore')) patch.targetScore = b.targetScore;
            out = rooms.setSettings(roomId, operator, patch);
          }
        } catch (err) {
          logger.warn?.('[net] 房间操作异常：' + String(err && err.message ? err.message : err));
          return send(res, 500, { ok: false, status: 500, code: 'INTERNAL', error: '服务器内部错误' });
        }
        if (!out.ok) {
          const status = out.status ?? 400;
          return send(res, status, { ok: false, status, code: out.code ?? 'BAD_REQUEST', error: out.message ?? '操作失败' });
        }
        // 每次成功的状态变化都要让所有窗口重画玩家列表（谁在申请、谁被踢、是否已开局）
        if (typeof broadcastPlayers === 'function') {
          try {
            broadcastPlayers();
          } catch (err) {
            logger.warn?.('[net] 玩家列表广播失败：' + String(err && err.message ? err.message : err));
          }
        }
        if (action === 'close') {
          // 房间已经删了，不能再 rooms.view()（那会重建一份假视图）。
          send(res, 200, { ok: true, action, closed: true, roomId });
          return;
        }
        const view = rooms.view(out.room);
        if (action === 'start') {
          send(res, 200, { ok: true, started: true, characterId: out.characterId ?? null, room: view });
          return;
        }
        if (action === 'seat') {
          send(res, 200, { ok: true, action, username: out.username ?? username, seat: out.seat ?? null, seats: view.seats, room: view });
          return;
        }
        if (action === 'settings') {
          send(res, 200, { ok: true, action, settings: out.settings ?? view.settings, room: view });
          return;
        }
        send(res, 200, { ok: true, action, username, room: view });
      });
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
        : joinOrReturn(rooms, u, username);
      if (!out.ok) {
        send(res, out.status ?? 500, { ok: false, error: out.message, code: out.code });
        return true;
      }
      const view = rooms.view(out.room);
      // 排队制（v0.8）：type=join 现在只是「提交了一条入房申请」，不是「已经在房里」。
      // pending=true 让前端显示「等待房主同意」而不是「已加入」；created 保持老语义
      //（只有建房才可能是 true）。鉴权失败（含 ROOM_STARTED / KICKED）走上面的 !out.ok 分支。
      const pending = Boolean(out.pending);
      // rejoined（v0.10）：房间已开局、这个身份是"老熟人"回来重连（关窗口再开 / 刷新）。
      // 前端据此显示「已接回正在进行的对局」，而不是「已提交入房申请」。
      const rejoined = Boolean(out.rejoined);
      // 建房/进房后玩家列表变了：通知所有已连上的窗口刷新（不用前端轮询）
      if (typeof broadcastPlayers === 'function') {
        try {
          broadcastPlayers();
        } catch (err) {
          logger.warn?.('[net] 玩家列表广播失败：' + String(err && err.message ? err.message : err));
        }
      }
      // wsPath 保持老形状（/ws?...）不破坏已有客户端；联机专用入口是 /lobby（带鉴权）：
      // /ws 只认本机单机会话，从 tailnet 地址进来的玩家必须走 /lobby 才能拿到自己的座位。
      send(res, 200, {
        ok: true,
        room: view,
        pending,
        rejoined,
        created: Boolean(out.created),
        wsPath: `/ws?roomid=${view.id}&token=${view.token}`,
        lobbyPath: `/lobby?type=${u.type}&roomid=${view.id}&token=${view.token}&invcode=${encodeURIComponent(view.invCode ?? '')}&id=${encodeURIComponent(u.idKey)}&username=${encodeURIComponent(username)}`,
      });
      return true;
    }
    // ── 服务端配置读写（v0.6 设置页「服务端配置」）──────────────────────────────
    // 读写 config/*.json 与 data/override.json。全部只对本机开放：这些接口能改内存与磁盘上的玩法参数，
    // 暴露到局域网等于把服务器交给别人调参。未注入 configAdmin 时统一 501（前端据此禁用整块 UI）。
    if (path === '/api/config' || path.startsWith('/api/config/')) {
      if (!isLocalManageRequest(req)) {
        send(res, 403, { ok: false, error: MANAGE_DENIED });
        return true;
      }
      if (!configAdmin) {
        send(res, 501, { ok: false, error: '本实例未启用配置读写接口' });
        return true;
      }
      if (path === '/api/config' && (req.method === 'GET' || req.method === 'HEAD')) {
        send(res, 200, configAdmin.describe());
        return true;
      }
      if (path === '/api/config' && req.method === 'POST') {
        readJsonBody(req, 64 * 1024, (parsed) => {
          if (!parsed.ok) return send(res, 400, { ok: false, errors: [{ path: '', message: parsed.error }] });
          let out;
          try {
            out = configAdmin.apply(parsed.body);
          } catch (err) {
            return send(res, 500, { ok: false, errors: [{ path: '', message: String(err && err.message ? err.message : err) }] });
          }
          send(res, out.ok ? 200 : 400, out);
        });
        return true;
      }
      // ── 整棵 JSON 树视图（v0.7）────────────────────────────────────────────
      // 用户原话：「直接把 JSON 搬进来，冒号前面的变成定值，冒号后面的是可修改值」。
      // 所以这里给的是摊平后的节点数组（每行一个可编辑值）+ 一份不脱敏的原文视图。
      // raw 视图**故意不脱敏**：它是本机回环只读的「看原文」入口，脱敏了就失去了意义。
      if (path === '/api/config/json' && (req.method === 'GET' || req.method === 'HEAD')) {
        const q = new URL(req.url, 'http://x').searchParams;
        let out;
        try {
          out = configAdmin.jsonTree({ sample: q.get('sample') });
        } catch (err) {
          send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
          return true;
        }
        send(res, 200, out);
        return true;
      }
      if (path === '/api/config/json/raw' && (req.method === 'GET' || req.method === 'HEAD')) {
        const q = new URL(req.url, 'http://x').searchParams;
        let out;
        try {
          out = configAdmin.jsonRaw({ sample: q.get('sample') });
        } catch (err) {
          send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
          return true;
        }
        send(res, 200, out);
        return true;
      }
      if (path === '/api/config/json' && req.method === 'POST') {
        readJsonBody(req, 256 * 1024, (parsed) => {
          if (!parsed.ok) return send(res, 400, { ok: false, message: parsed.error });
          let out;
          try {
            out = configAdmin.writeJson(parsed.body ?? {});
          } catch (err) {
            return send(res, 500, { ok: false, message: String(err && err.message ? err.message : err) });
          }
          // 业务层拒绝（路径穿越/掩码串/写盘失败）一律 400，前端只看 message
          send(res, out.ok ? 200 : 400, out);
        });
        return true;
      }
      if (path === '/api/config/reset' && req.method === 'POST') {
        readJsonBody(req, 4096, (parsed) => {
          if (!parsed.ok) return send(res, 400, { ok: false, errors: [{ path: '', message: parsed.error }] });
          let out;
          try {
            out = configAdmin.reset(parsed.body ?? {});
          } catch (err) {
            return send(res, 500, { ok: false, errors: [{ path: '', message: String(err && err.message ? err.message : err) }] });
          }
          send(res, out.ok ? 200 : 400, out);
        });
        return true;
      }
      send(res, 405, { ok: false, error: '只接受 GET/POST /api/config、POST /api/config/reset、GET/POST /api/config/json、GET /api/config/json/raw' });
      return true;
    }
    return false;
  };
  // 对外入口：同步返回布尔值（true = 本模块已接管），所以不能写成 async 函数。
  // 认得的路径才算「归我管」，未注册的路径一律 false 交回上层（主机壳要靠这个挂 /api/local/*）。
  const handler = (req, res) => {
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
  // 只给测试用的口子：清空预探测限流窗口，免得同一个进程里的用例互相把对方顶到 429。
  handler.resetCheckRateLimit = resetCheckRateLimit;
  return handler;
}
