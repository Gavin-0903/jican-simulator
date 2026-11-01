// 设置页「联机」后端的纯逻辑层。
//
// 这里只放与游戏域无关、可以脱离 tailscale 单测的函数：
//   - readServeConfig    : 跑 tailscale serve status --json（失败退回 funnel status --json），解析成事实结构；
//   - classifyMode       : 把这份事实折成 tailnet / funnel / off 三选一；
//   - funnelCaps         : 从 tailscale status --json 的 Self.Capabilities/CapMap 里读 funnel 能力与允许端口；
//   - diffConfig         : 纯函数，比对「配置的意图」与「机器的真实状态」，产出漂移清单；
//   - maskToken          : token 打码（任何响应都绝不能带完整 token）；
//   - isLoopbackAddress / isLocalManageRequest : 管理写操作的来源校验。
//
// 约定：本文件里所有函数都不抛异常，只返回结构化结果（字段缺失按默认值处理）。
// 1.104 的 serve status --json 形如：
//   { "TCP": { "443": { "HTTPS": true } },
//     "Web": { "gavin.xxx.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:5173" } } } },
//     "AllowFunnel": { "gavin.xxx.ts.net:443": false } }
// 但字段缺失、空对象、老版本格式都必须容忍，所以下面全是「读不到就当没有」。

import { runTailscale as defaultRun } from './TailScale.js';

/** 回环地址判定（与 LobbyHttp 里 /api/app/quit 的口径一致，另加 IPv4-mapped）。 */
export function isLoopbackAddress(addr) {
  const a = String(addr ?? '').toLowerCase();
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** Host 头里只认这些名字为「本机」；带端口也算（127.0.0.1:5173 / [::1]:5173）。 */
export function isLocalManageHost(hostHeader) {
  const raw = String(hostHeader ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === 'localhost' || raw === '127.0.0.1' || raw === '[::1]' || raw === '::1') return true;
  return /^(127\.0\.0\.1|localhost|\[::1\]|::1):\d{1,5}$/.test(raw);
}

/**
 * 是不是「本机设置页发出的管理请求」：回环来源 + Host 头指向本机。
 * 两条都满足才算；只满足其一是别的机器或者被 DNS 重绑定劫持的页面。
 */
export function isLocalManageRequest(req) {
  if (!req) return false;
  const addr = req.socket?.remoteAddress ?? req.socket?.address?.();
  if (!isLoopbackAddress(addr)) return false;
  return isLocalManageHost(req.headers?.host);
}

/** 把 mode 归一成 tailnet | funnel | off。旧值 serve 一律当 tailnet。 */
export function normalizeMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'funnel') return 'funnel';
  if (m === 'off' || m === 'none' || m === 'disabled' || m === 'false' || m === 'local') return 'off';
  if (m === 'tailnet' || m === 'serve' || m === 'tsnet') return 'tailnet';
  return null;
}

/** 服务器源地址：funnel 时对外是同一个 https 地址，tailnet 时只有 tailnet 内可见。off 时为空。 */
export function serverUrlFor(dnsName, mode) {
  const dns = String(dnsName ?? '').replace(/\.$/, '');
  if (!dns) return '';
  if (normalizeMode(mode) === 'off') return '';
  return 'https://' + dns;
}

/** 从字符串里抽出 host:port 形式里的端口号；抽不到返回 null。 */
function portOf(text) {
  const m = /:(\d{2,5})(?:\/|$|\s|,)/.exec(String(text ?? '') + ' ');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/** tailscale 的 proxy 目标里抽出本机端口：http://127.0.0.1:5173 -> 5173。 */
export function localPortOf(proxyTarget) {
  const t = String(proxyTarget ?? '').trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    const host = u.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') return null;
    const p = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** 空/失败事实的稳定形状（UI 直接读，不用判空）。 */
export function emptyServeFacts(error = '') {
  return { ok: false, error, port: null, localPorts: [], tcpPorts: [], funnelPorts: [], hostname: '', dnsName: '', hostPorts: [], leftoverPorts: [], raw: null };
}

/**
 * 解析 serve/funnel status --json（字段缺失一律当没有，不抛）。
 * @returns {{ok:boolean, raw:any, error:string, port:number|null, localPorts:number[],
 *            tcpPorts:number[], funnelPorts:number[], hostname:string, dnsName:string,
 *            hostPorts:number[], leftoverPorts:number[]}}
 */
export function parseServeStatus(json) {
  const out = emptyServeFacts();
  out.ok = true;
  let data = json;
  if (typeof json === 'string') {
    const text = json.trim();
    if (!text) {
      out.ok = false;
      out.error = 'serve status 输出为空';
      return out;
    }
    try {
      data = JSON.parse(text);
    } catch {
      out.ok = false;
      out.error = 'serve status 输出不是合法 JSON';
      return out;
    }
  }
  if (!data || typeof data !== 'object') {
    out.ok = false;
    out.error = 'serve status 输出为空对象';
    return out;
  }
  out.raw = data;

  // 1) TCP 上暴露的端口（HTTPS/TLS 一类的 tcp 监听）
  const tcp = data.TCP && typeof data.TCP === 'object' ? data.TCP : {};
  for (const k of Object.keys(tcp)) {
    const n = Number(k);
    if (Number.isInteger(n) && n > 0) out.tcpPorts.push(n);
  }
  // 2) 显式的 Funnel 端口表（个别版本会单独给）
  const funnel = data.Funnel && typeof data.Funnel === 'object' ? data.Funnel : {};
  for (const k of Object.keys(funnel)) {
    const n = Number(k);
    if (Number.isInteger(n) && n > 0) out.funnelPorts.push(n);
  }
  // 3) Web: { "host:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } } } }
  const web = data.Web && typeof data.Web === 'object' ? data.Web : {};
  for (const [hostKey, entry] of Object.entries(web)) {
    const p = portOf(hostKey);
    if (p) out.hostPorts.push(p);
    const host = String(hostKey).replace(/:\d+$/, '');
    if (!out.hostname && host) out.hostname = host;
    if (!out.dnsName && host) out.dnsName = host;
    const handlers = entry && typeof entry === 'object' && entry.Handlers && typeof entry.Handlers === 'object' ? entry.Handlers : {};
    for (const h of Object.values(handlers)) {
      const target = h && typeof h === 'object' ? h.Proxy ?? h.proxy ?? '' : '';
      const lp = localPortOf(target);
      if (lp) {
        if (!out.localPorts.includes(lp)) out.localPorts.push(lp);
        if (out.port === null) out.port = lp;
      }
    }
  }
  // 4) AllowFunnel: { "host:443": true|false } —— 只有明确 true 才算开了 funnel
  const allow = data.AllowFunnel && typeof data.AllowFunnel === 'object' ? data.AllowFunnel : {};
  for (const [hostKey, v] of Object.entries(allow)) {
    if (v === true) {
      const p = portOf(hostKey);
      if (p && !out.funnelPorts.includes(p)) out.funnelPorts.push(p);
    }
  }
  // 5) 残留规则：对外端口挂着，但没有指向本机端口（有指向时，443 这类对外映射不算残留）
  const serving = new Set([...out.tcpPorts, ...out.hostPorts]);
  for (const p of serving) {
    if (p === 443) continue;
    if (!out.localPorts.length) continue;
    out.leftoverPorts.push(p);
  }
  out.localPorts.sort((a, b) => a - b);
  out.hostPorts.sort((a, b) => a - b);
  out.funnelPorts.sort((a, b) => a - b);
  out.leftoverPorts.sort((a, b) => a - b);
  return out;
}

/**
 * 跑 tailscale serve status --json，失败退回 tailscale funnel status --json。
 * @param {string} bin tailscale 可执行文件
 * @param {{run?:Function, timeoutMs?:number}} [deps] run 可注入，便于无 tailscale 环境单测
 */
export async function readServeConfig(bin, { run = defaultRun, timeoutMs = 8000 } = {}) {
  if (!bin) return emptyServeFacts('未找到 tailscale');
  const attempts = [];
  for (const args of [['serve', 'status', '--json'], ['funnel', 'status', '--json']]) {
    let r;
    try {
      r = await run(bin, args, { timeoutMs });
    } catch (err) {
      r = { ok: false, code: 'throw', stdout: '', stderr: String(err && err.message ? err.message : err) };
    }
    attempts.push({ cmd: args.join(' '), ok: Boolean(r && r.ok), code: (r && r.code) || null, stderr: String((r && r.stderr) || '').slice(0, 400) });
    if (r && r.ok) {
      const parsed = parseServeStatus(r.stdout || '');
      parsed.attempts = attempts;
      parsed.source = args[0];
      return parsed;
    }
  }
  const summary = attempts.map((a) => a.cmd + ': ' + (a.code || '失败') + (a.stderr ? ' ' + firstLine(a.stderr) : '')).join('; ');
  const facts = emptyServeFacts(summary || 'serve/funnel status 均失败');
  facts.attempts = attempts;
  return facts;
}

/**
 * 三选一：tailnet / funnel / off。
 *   funnel  : 规则指向本机端口 且 AllowFunnel 为 true（或有 funnel 端口）
 *   tailnet : 规则指向本机端口，但没开 funnel
 *   off     : 没有任何规则指向本机端口
 * tailnetAvailable：只要 serve status 能读到本机端口规则就算可用。
 */
export function classifyMode(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const localPorts = Array.isArray(f.localPorts) ? f.localPorts : [];
  const funnelPorts = Array.isArray(f.funnelPorts) ? f.funnelPorts : [];
  const port = localPorts.length ? (f.port || localPorts[0]) : null;
  if (!port) return { mode: 'off', port: null, tailnetAvailable: false, funnelEnabled: false, localPorts: [] };
  const funnelEnabled = funnelPorts.length > 0;
  return {
    mode: funnelEnabled ? 'funnel' : 'tailnet',
    port,
    tailnetAvailable: true,
    funnelEnabled,
    localPorts: localPorts.slice(),
  };
}

/** funnel 对外端口：本机服务端口 h 统一映射到对外 443（443 并不是本机监听端口）。 */
export const FUNNEL_PUBLIC_PORT = 443;

/** funnel 能力说明文案（设置页直接显示）。 */
export function funnelPortNote() {
  return 'TailScale 的 Funnel 只允许 443 / 8443 / 10000 三个对外端口；本机服务端口 h 经 serve 后统一映射成对外 https://主机名（443），所以只要 443 在允许集合里就能开 funnel。';
}

/**
 * 从 tailscale status --json 读 funnel 能力与允许端口。
 * Self.Capabilities 是字符串数组；Self.CapMap 是 { cap: value|null }。两处都看。
 */
export function funnelCaps(status) {
  const out = { funnelCapable: false, funnelPorts: [], caps: [], reason: '' };
  let s = status;
  if (typeof status === 'string') {
    try {
      s = JSON.parse(status);
    } catch {
      out.reason = 'status --json 不是合法 JSON';
      return out;
    }
  }
  if (!s || typeof s !== 'object') {
    out.reason = '没有 tailscale status';
    return out;
  }
  const self = s.Self && typeof s.Self === 'object' ? s.Self : {};
  const caps = [];
  if (Array.isArray(self.Capabilities)) {
    for (const c of self.Capabilities) if (typeof c === 'string') caps.push(c);
  }
  if (self.CapMap && typeof self.CapMap === 'object') {
    for (const c of Object.keys(self.CapMap)) if (!caps.includes(c)) caps.push(c);
  }
  out.caps = caps;
  const lower = caps.map((c) => c.toLowerCase());
  out.funnelCapable = lower.includes('funnel') || lower.some((c) => c.startsWith('https://tailscale.com/cap/funnel-ports'));
  const ports = new Set();
  for (const c of caps) {
    const m = /funnel-ports\?ports=([0-9,\s]+)/i.exec(c);
    if (!m) continue;
    for (const part of m[1].split(',')) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n > 0 && n < 65536) ports.add(n);
    }
  }
  out.funnelPorts = Array.from(ports).sort((a, b) => a - b);
  if (!out.funnelCapable) out.reason = '当前节点没有 funnel 能力（未开启 Funnel 或不是 admin/owner）';
  return out;
}

/** token 打码：只给「前 8 位…后 4 位（共 N 位）」，绝不返回完整 token。 */
export function maskToken(token) {
  const t = typeof token === 'string' ? token : token == null ? '' : String(token);
  const length = t.length;
  if (!length) return { masked: '', present: false, length: 0 };
  const head = t.slice(0, Math.min(8, length));
  const tail = length > 12 ? t.slice(-4) : '';
  return { masked: tail ? head + '…' + tail + '（共 ' + length + ' 位）' : head + '（共 ' + length + ' 位）', present: true, length };
}

/** 漂移 code -> 中文短标签（UI 直接渲染 label，code 供前端做分支）。 */
export const DRIFT_LABELS = Object.freeze({
  'tailscale-not-installed': '本机没有安装 TailScale',
  'tailscale-not-running': 'TailScale 已安装但没在运行/没登录',
  'serve-read-failed': '读不到 TailScale 的 serve 状态',
  'online-enabled-but-off': '配置说已联机，但 TailScale 里没有任何暴露规则',
  'online-enabled-but-no-serve': '配置说已联机，但 serve 规则没有指向本机端口',
  'online-disabled-but-serve': '配置说联机已关，但 TailScale 里还留着暴露规则（别的机器仍能连进来）',
  'funnel-cap-missing': '配置要开 funnel，但当前节点没有 funnel 能力',
  'funnel-cap-allowed-but-off': '配置要开 funnel，节点也支持，但实际 AllowFunnel=false',
  'funnel-but-config-tailnet': '实际开的是 funnel（公网可见），但配置写的是仅 tailnet',
  'tailnet-but-config-funnel': '实际只对 tailnet 可见，但配置写的是 funnel（公网打不开）',
  'port-mismatch': '配置里的端口和实际监听端口不一致',
  'serve-port-mismatch': 'TailScale 规则指向的端口和本机监听端口不一致',
  'leftover-serve-rules': 'TailScale 里还留着指向别的端口的残留规则',
  'tailnet-port-not-443': 'serve 的对外端口不是 443，共享出去的链接可能打不开',
});

/** 取一段命令输出的第一行非空文本（报错摘要用）。 */
export function firstLine(text) {
  const lines = String(text == null ? '' : text).split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines[0] : '';
}

/**
 * 配置漂移检测（纯函数）。
 * @param {{expose?:object, isServerSource?:boolean, tailscale?:object, actualPort?:number}} input
 *   expose        : 配置里的 online 段 { enabled, mode, port, serverUrl }
 *   isServerSource: settings.isServerSource（expose.enabled 缺失时才用）
 *   tailscale     : { installed, running, backendState, loggedIn, funnelCapable, funnelPorts, dnsName }
 *   actualPort    : 本进程真正监听的端口
 * @param {object} serveFacts readServeConfig 的结果
 * @returns {{state:'ok'|'drift'|'off'|'unknown', mode:string, configMode:string, actualMode:string, drift:Array, port:number|null}}
 */
export function diffConfig(input = {}, serveFacts = null) {
  const src = input && typeof input === 'object' ? input : {};
  const expose = src.expose && typeof src.expose === 'object' ? src.expose : {};
  const ts = src.tailscale && typeof src.tailscale === 'object' ? src.tailscale : {};
  const facts = serveFacts && typeof serveFacts === 'object' ? serveFacts : null;
  const actual = classifyMode(facts || {});
  const configMode = normalizeMode(expose.mode) || 'tailnet';
  const enabled = typeof expose.enabled === 'boolean' ? expose.enabled : Boolean(src.isServerSource);
  // 本进程监听端口既可以放在顶层，也可以跟着 expose 段一起传
  const actualPortRaw = src.actualPort != null ? src.actualPort : expose.actualPort;
  const actualPort = Number.isFinite(Number(actualPortRaw)) && Number(actualPortRaw) > 0 ? Number(actualPortRaw) : null;
  const drift = [];
  const push = (code, detail, fatal = false) => drift.push({ code, label: DRIFT_LABELS[code] || code, detail: String(detail == null ? '' : detail), fatal: Boolean(fatal) });
  const base = () => ({ mode: actual.mode, configMode, actualMode: actual.mode, drift, port: actual.port });

  const installed = ts.installed !== false;
  const running = ts.running !== undefined ? Boolean(ts.running) : Boolean(ts.loggedIn);

  // 环境层面的问题：只有「配置说打开了联机」时才报成漂移
  if (enabled && !installed) push('tailscale-not-installed', '配置 online.enabled=true，但 findTailscale() 没找到可执行文件', true);
  else if (enabled && !running) push('tailscale-not-running', '配置 online.enabled=true，但 tailscale status 显示未运行/未登录（BackendState=' + String(ts.backendState == null ? '' : ts.backendState) + '）', true);

  // 都关了：一致
  if (!enabled && actual.mode === 'off') return { state: 'off', ...base() };
  if (!enabled && actual.mode !== 'off') {
    push('online-disabled-but-serve', '配置 online.enabled=false，但 TailScale 规则仍指向本机端口 ' + actual.port + '（tailnet 内/公网仍可访问）', false);
    return { state: 'drift', ...base() };
  }

  // 配置说开着：没拿到的事实/读失败都只能报 unknown
  if (!facts) return { state: 'unknown', ...base() };
  if (facts.ok === false) {
    push('serve-read-failed', facts.error || 'serve status 读不到', false);
    return { state: 'unknown', ...base() };
  }
  if (actual.mode === 'off') {
    push('online-enabled-but-off', '配置 online.enabled=true / mode=' + configMode + '，但 serve 里没有任何指向本机端口的规则', true);
    return { state: 'drift', ...base() };
  }

  // mode 一致性
  if (configMode === 'funnel' && actual.mode !== 'funnel') {
    if (ts.funnelCapable === false) push('funnel-cap-missing', '配置 mode=funnel，但节点 Capabilities 里没有 funnel / funnel-ports', false);
    else push('funnel-cap-allowed-but-off', '配置 mode=funnel，节点支持 funnel，但实际 AllowFunnel=false（当前只对 tailnet 可见）', false);
  }
  if (configMode === 'tailnet' && actual.mode === 'funnel') {
    push('funnel-but-config-tailnet', '实际 AllowFunnel=true（公网可见），但配置写的是 mode=' + configMode, false);
  }
  if (configMode !== 'tailnet' && actual.mode !== 'funnel' && configMode !== 'funnel') {
    push('tailnet-but-config-funnel', '未知配置模式 ' + configMode + '，实际只对 tailnet 可见', false);
  }
  // 端口一致性
  const cfgPort = Number(expose.port);
  if (Number.isInteger(cfgPort) && cfgPort > 0 && actual.port && cfgPort !== actual.port) {
    push('port-mismatch', '配置 online.port=' + cfgPort + '，serve 指向本机端口 ' + actual.port, false);
  }
  if (actualPort && actualPort !== actual.port) {
    push('serve-port-mismatch', '本进程实际监听 ' + actualPort + '，serve 指向 ' + actual.port + '（共享出去的链接会打到别的端口）', true);
  }
  // 残留规则 + 对外端口不是 443
  const leftover = Array.isArray(facts.leftoverPorts) ? facts.leftoverPorts.filter((p) => p !== actual.port) : [];
  if (leftover.length) push('leftover-serve-rules', 'serve/funnel 上还有这些对外端口没有指向本机服务：' + leftover.join(', '), false);
  const hosts = Array.isArray(facts.hostPorts) ? facts.hostPorts : [];
  if (hosts.length && !hosts.includes(FUNNEL_PUBLIC_PORT)) push('tailnet-port-not-443', 'serve 对外端口是 ' + hosts.join(', ') + '，不是 443', false);

  return { state: drift.length ? 'drift' : 'ok', ...base() };
}
