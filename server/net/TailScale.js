// TailScale 集成（需求：安装后检测 tailscale，自动把本机做成服务器源并配置 serve/funnel）。
//
// 设计要点：
//  - 只依赖本机 tailscale CLI（Windows 默认 C:\\Program Files\\Tailscale\\tailscale.exe），
//    不依赖任何第三方 npm 包；找不到就返回 ok:false 让上层降级成普通单机。
//  - 所有命令都带超时，失败不抛异常，只返回 { ok, code, stdout, stderr }。
//  - 幂等：started/expose 重复调用不会叠加规则；resetExpose() 只清理本应用用过的那一条。
//  - serve 只在 tailnet 内可见；funnel 对公网开放。默认 serve，可在设置页改成 funnel。

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const WIN_CANDIDATES = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
];
const UNIX_CANDIDATES = ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

/** 找出 tailscale 可执行文件；找不到返回 null。 */
export function findTailscale() {
  const env = process.env.JICAN_TAILSCALE || process.env.TAILSCALE_PATH;
  if (env && existsSync(env)) return env;
  const list = process.platform === 'win32' ? WIN_CANDIDATES : UNIX_CANDIDATES;
  for (const p of list) if (existsSync(p)) return p;
  return process.platform === 'win32' ? null : 'tailscale';
}

/** 跑一条 tailscale 命令，永不 reject。 */
export function runTailscale(bin, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!bin) return resolve({ ok: false, code: 'no-binary', stdout: '', stderr: '未找到 tailscale' });
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child;
    try {
      child = execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20 }, (e, stdout, stderr) => {
        const out = stdout || '';
        const err = stderr || '';
        if (e) return finish({ ok: false, code: e.code ?? 'error', stdout: out, stderr: err || e.message, timedOut: Boolean(e.killed) });
        finish({ ok: true, code: 0, stdout: out, stderr: err });
      });
    } catch (e) {
      return finish({ ok: false, code: 'spawn', stdout: '', stderr: e.message });
    }
    child.on('error', (e) => finish({ ok: false, code: 'spawn', stdout: '', stderr: e.message }));
  });
}

/** 解析 tailscale status --json，抽出 DNSName / IPv4 / 是否已登录。 */
export function parseStatus(json) {
  const out = { ok: false, dnsName: '', url: '', ips: [], backendState: '', loggedIn: false, hostname: '' };
  let s = null;
  try {
    s = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return out;
  }
  if (!s || typeof s !== 'object') return out;
  out.backendState = s.BackendState ?? '';
  out.ips = Array.isArray(s.TailscaleIPs) ? s.TailscaleIPs.filter((x) => typeof x === 'string' && !x.includes(':')) : [];
  const self = s.Self ?? {};
  out.hostname = self.HostName ?? '';
  const dns = String(self.DNSName ?? '').replace(/\.$/, '');
  out.dnsName = dns;
  if (dns) out.url = 'https://' + dns;
  out.loggedIn = out.backendState === 'Running' && Boolean(self.ID);
  out.ok = out.loggedIn && Boolean(dns);
  return out;
}

/** 本机是否装了 tailscale（同步，供 setup 阶段做「要不要装」的判断）。 */
export function tailscaleInstalled() {
  const bin = findTailscale();
  if (!bin) return false;
  return process.platform === 'win32' ? existsSync(bin) : true;
}

export function tailscaleVersion(bin) {
  return runTailscale(bin, ['version'], { timeoutMs: 6000 });
}

/** 查当前节点状态（DNSName / 是否登录）。 */
export async function tailscaleStatus(bin) {
  const b = bin || findTailscale();
  if (!b) return { ok: false, code: 'no-binary' };
  const r = await runTailscale(b, ['status', '--json'], { timeoutMs: 10000 });
  if (!r.ok) return { ok: false, code: r.code, stderr: r.stderr, bin: b };
  const st = parseStatus(r.stdout);
  return { ok: st.ok, ...st, bin: b };
}

/** 尝试把 tailscale 拉起来（Windows 上通常是系统服务，未运行才需要）。 */
export async function ensureTailscaleRunning(bin) {
  const st = await tailscaleStatus(bin);
  if (st.ok) return { ok: true, started: false, status: st };
  const up = await runTailscale(st.bin || findTailscale(), ['up', '--accept-dns=false'], { timeoutMs: 15000 });
  const st2 = await tailscaleStatus(bin);
  return { ok: st2.ok, started: true, status: st2, upResult: up };
}

/** 用 serve 或 funnel 把本地端口暴露出去。 */
export async function exposePort(bin, port, expose = 'serve', { bg = true } = {}) {
  const b = bin || findTailscale();
  if (!b) return { ok: false, code: 'no-binary' };
  const sub = expose === 'funnel' ? 'funnel' : 'serve';
  const args = bg ? [sub, '--bg', String(port)] : [sub, String(port)];
  const r = await runTailscale(b, args, { timeoutMs: 20000 });
  const st = await tailscaleStatus(b);
  return { ok: r.ok, expose: sub, code: r.code, url: st.url ?? '', dnsName: st.dnsName ?? '', stderr: r.stderr, stdout: r.stdout };
}

/** 撤销本应用加过的 serve/funnel 规则。 */
export async function resetExpose(bin, expose = 'serve') {
  const b = bin || findTailscale();
  if (!b) return { ok: false, code: 'no-binary' };
  const sub = expose === 'funnel' ? 'funnel' : 'serve';
  const r = await runTailscale(b, [sub, 'reset'], { timeoutMs: 10000 });
  return { ok: r.ok, code: r.code, stderr: r.stderr };
}

/** 一步到位：确保在运行 → 暴露端口 → 回填 URL。setup 阶段与首次启动都会用到。 */
export async function setupTailscale({ port, expose = 'serve', logger = console } = {}) {
  const bin = findTailscale();
  if (!bin) return { ok: false, code: 'no-binary', message: '未安装 TailScale' };
  const running = await ensureTailscaleRunning(bin);
  if (!running.ok) {
    return { ok: false, code: 'not-running', message: 'TailScale 已安装但未登录/未运行', bin, status: running.status };
  }
  const exposed = await exposePort(bin, port, expose);
  if (!exposed.ok) {
    const first = String(exposed.stderr || '').split('\n')[0];
    logger.warn?.('[tailscale] 暴露端口 ' + port + ' 失败（' + expose + '）：' + first);
    return { ok: false, code: 'expose-failed', message: 'TailScale 端口暴露失败', bin, url: running.status?.url ?? '', status: running.status, exposed };
  }
  const url = running.status?.url || exposed.url;
  logger.info?.('[tailscale] 已通过 ' + expose + ' 暴露 http://127.0.0.1:' + port + ' → ' + url);
  return { ok: true, bin, url, dnsName: running.status?.dnsName ?? '', expose, status: running.status, exposed };
}

/**
 * 设置页三选一切换暴露方式：'tailnet' | 'funnel' | 'off'。
 * 与 setupTailscale/exposePort 的区别：这里要「先把不想要的规则撤掉再建新的」，
 * 并且每一步失败都只返回结构化结果、绝不抛；funnel 失败时保留 serve 生效（降级成 tailnet 而不是全关）。
 *
 * 返回 { ok, mode, url, dnsName, code?, message?, steps:[{cmd, ok, code, message}] }
 */
export async function setExposeMode(bin, { port, mode } = {}, { run = runTailscale, logger = console, statusFn = tailscaleStatus } = {}) {
  const b = bin || findTailscale();
  const m = mode === 'funnel' ? 'funnel' : mode === 'off' ? 'off' : mode === 'tailnet' || mode === 'serve' ? 'tailnet' : null;
  if (!m) return { ok: false, mode: String(mode ?? ''), code: 'bad-mode', message: 'mode 只能是 tailnet / funnel / off', steps: [] };
  if (!b) return { ok: false, mode: m, code: 'no-binary', message: '未安装 TailScale', steps: [] };

  const steps = [];
  const step = async (args, { timeoutMs = 20000, quiet = false } = {}) => {
    let r;
    try {
      r = await run(b, args, { timeoutMs });
    } catch (err) {
      r = { ok: false, code: 'throw', stdout: '', stderr: String(err && err.message ? err.message : err) };
    }
    const entry = { cmd: 'tailscale ' + args.join(' '), ok: Boolean(r && r.ok), code: (r && r.code) || null, message: (r && r.stderr ? String(r.stderr).split('\n').filter(Boolean)[0] : '') || '' };
    steps.push(entry);
    if (!entry.ok && !quiet) logger.warn?.('[tailscale] ' + entry.cmd + ' 失败：' + (entry.message || entry.code));
    return entry;
  };
  // 只读一次节点状态给 URL 回填用（判定是否可用仍以 serve/funnel 命令本身为准，
  // 这样即使 status 读不到也不影响「刷新后能打开」的功能）。绝不抛。
  let statusCache = null;
  const status = async () => {
    if (statusCache) return statusCache;
    try {
      const st = await statusFn(b);
      statusCache = { ok: Boolean(st && st.ok), url: (st && st.url) || '', dnsName: (st && st.dnsName) || '' };
    } catch {
      statusCache = { ok: false, url: '', dnsName: '' };
    }
    return statusCache;
  };
  const finish = async (extra = {}) => {
    const st = await status();
    return { url: st.url || '', dnsName: st.dnsName || '', steps, ...extra };
  };

  // 1) 全关：serve reset + funnel reset（任何一步失败都继续，尽量把状态清干净）
  if (m === 'off') {
    const a = await step(['serve', 'reset'], { timeoutMs: 10000, quiet: true });
    const c = await step(['funnel', 'reset'], { timeoutMs: 10000, quiet: true });
    const out = await finish({ ok: true, mode: 'off' });
    if (!a.ok && !c.ok) {
      return { ...out, ok: false, code: 'reset-failed', message: '撤销 serve/funnel 规则失败（可能本来就没配置）' };
    }
    return out;
  }

  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) return { ok: false, mode: m, code: 'bad-port', message: '端口不合法：' + String(port), steps };

  // 2) 仅 tailnet：先撤 funnel（静默失败），再 serve --bg <port>
  if (m === 'tailnet') {
    await step(['funnel', 'reset'], { timeoutMs: 10000, quiet: true });
    const s = await step(['serve', '--bg', String(p)]);
    if (!s.ok) {
      return { ...(await finish()), ok: false, mode: m, code: 'serve-failed', message: 'tailscale serve 失败：' + (s.message || s.code) };
    }
    return { ...(await finish()), ok: true, mode: 'tailnet' };
  }

  // 3) funnel：先 serve 生效，再 funnel 开公网；funnel 失败保留 serve（降级成 tailnet）
  const s = await step(['serve', '--bg', String(p)]);
  if (!s.ok) {
    return { ...(await finish()), ok: false, mode: m, code: 'serve-failed', message: 'tailscale serve 失败，未改动 funnel：' + (s.message || s.code) };
  }
  const f = await step(['funnel', '--bg', String(p)]);
  if (!f.ok) {
    return {
      ...(await finish()),
      ok: false,
      mode: 'tailnet',
      code: 'funnel-unavailable',
      message: 'funnel 未开起来（' + (f.message || f.code) + '）；已回滚为仅 tailnet 可见（serve 仍生效）',
    };
  }
  return { ...(await finish()), ok: true, mode: 'funnel' };
}

/** 生成联机 Token（256 位 hex）。 */
export function makeOnlineToken() {
  const bytes = new Uint8Array(128);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
