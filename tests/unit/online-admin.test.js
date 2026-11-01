// 设置页「联机」后端自测：纯逻辑（三选一分类 / 漂移检测 / token 打码 / 命令回滚）
// + 管理接口的来源校验。全部不依赖本机真的装了 tailscale（运行函数可注入）。
// 注意：「非本机来源」用 node:http 手工发请求来构造（fetch 会把 Host 头改写成目标地址，
// 造不出 DNS 重绑定那种 Host）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import {
  classifyMode,
  diffConfig,
  DRIFT_LABELS,
  funnelCaps,
  isLocalManageHost,
  isLocalManageRequest,
  isLoopbackAddress,
  localPortOf,
  maskToken,
  normalizeMode,
  parseServeStatus,
  readServeConfig,
  serverUrlFor,
} from '../../server/net/OnlineAdmin.js';
import { setExposeMode } from '../../server/net/TailScale.js';
import { createLobbyRouter } from '../../server/net/LobbyHttp.js';
import { RoomManager, buildRoomUrl } from '../../server/net/RoomManager.js';
import { computeIdKey } from '../../server/net/IdKey.js';
import { quiet } from '../helpers.js';

/** 1.104 上 serve status --json 的真实形状（AllowFunnel=false = 仅 tailnet 可见）。 */
const SERVE_TAILNET = {
  TCP: { 443: { HTTPS: true } },
  Web: { 'gavin.taile47ede.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5173' } } } },
  AllowFunnel: { 'gavin.taile47ede.ts.net:443': false },
};
const SERVE_FUNNEL = { ...SERVE_TAILNET, AllowFunnel: { 'gavin.taile47ede.ts.net:443': true } };
const SERVE_OFF = {};
const SERVE_OTHER_PORT = {
  TCP: { 443: { HTTPS: true } },
  Web: { 'gavin.taile47ede.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } },
  AllowFunnel: {},
};

const makeKey = (n) => computeIdKey({ timezone: 'Asia/Shanghai', mac: 'aabbcc0000' + n, os: 'win-x64', lang: 'zh_CN', username: 'u' + n, appCount: n, rand: String(n).repeat(64).slice(0, 64) });

// ---------------------------------------------------------------- 解析与三选一

test('parseServeStatus：1.104 真实形状解析出本机端口 / 主机名 / 对外端口，字段缺失不抛', () => {
  const f = parseServeStatus(SERVE_TAILNET);
  assert.equal(f.ok, true);
  assert.equal(f.port, 5173);
  assert.deepEqual(f.localPorts, [5173]);
  assert.deepEqual(f.tcpPorts, [443]);
  assert.deepEqual(f.hostPorts, [443]);
  assert.deepEqual(f.funnelPorts, []);
  assert.equal(f.dnsName, 'gavin.taile47ede.ts.net');
  assert.equal(f.hostname, 'gavin.taile47ede.ts.net');
  assert.equal(parseServeStatus({}).ok, true);
  assert.equal(parseServeStatus({}).port, null);
  assert.equal(parseServeStatus('').ok, false);
  assert.equal(parseServeStatus('not json').ok, false);
  assert.equal(parseServeStatus(null).ok, false);
  assert.equal(parseServeStatus({ Web: null, TCP: 5, AllowFunnel: 'x' }).ok, true, '类型错的字段按缺失处理');
});

test('classifyMode：tailnet / funnel / off 三选一', () => {
  const a = classifyMode(parseServeStatus(SERVE_TAILNET));
  assert.deepEqual(a, { mode: 'tailnet', port: 5173, tailnetAvailable: true, funnelEnabled: false, localPorts: [5173] });
  const b = classifyMode(parseServeStatus(SERVE_FUNNEL));
  assert.equal(b.mode, 'funnel');
  assert.equal(b.funnelEnabled, true);
  const c = classifyMode(parseServeStatus(SERVE_OFF));
  assert.equal(c.mode, 'off');
  assert.equal(c.tailnetAvailable, false);
  assert.equal(c.port, null);
  assert.equal(classifyMode(null).mode, 'off');
  assert.equal(classifyMode({}).mode, 'off');
  assert.equal(classifyMode(parseServeStatus(SERVE_OTHER_PORT)).mode, 'tailnet');
});

test('localPortOf：只认本机回环目标的端口', () => {
  assert.equal(localPortOf('http://127.0.0.1:5173'), 5173);
  assert.equal(localPortOf('http://localhost:8080'), 8080);
  assert.equal(localPortOf('https://127.0.0.1'), 443);
  assert.equal(localPortOf('http://10.0.0.2:5173'), null, '非回环目标不算本机端口');
  assert.equal(localPortOf(''), null);
  assert.equal(localPortOf('garbage'), null);
});

test('funnelCaps：从能力表读出 funnel 能力与允许端口（本机实测 443,8443,10000）', () => {
  const caps = funnelCaps({ Self: { Capabilities: ['https', 'funnel', 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000'] } });
  assert.equal(caps.funnelCapable, true);
  assert.deepEqual(caps.funnelPorts, [443, 8443, 10000]);
  assert.equal(funnelCaps({ Self: { CapMap: { funnel: null } } }).funnelCapable, true);
  const no = funnelCaps({ Self: { Capabilities: ['https'] } });
  assert.equal(no.funnelCapable, false);
  assert.ok(no.reason.length > 0);
  assert.equal(funnelCaps(null).funnelCapable, false);
  assert.equal(funnelCaps('坏 json').funnelCapable, false);
});

test('normalizeMode：旧值 serve 当 tailnet，非法值返回 null', () => {
  assert.equal(normalizeMode('serve'), 'tailnet');
  assert.equal(normalizeMode('tailnet'), 'tailnet');
  assert.equal(normalizeMode('FUNNEL'), 'funnel');
  assert.equal(normalizeMode('off'), 'off');
  assert.equal(normalizeMode('disabled'), 'off');
  assert.equal(normalizeMode('whatever'), null);
  assert.equal(normalizeMode(''), null);
  assert.equal(serverUrlFor('gavin.taile47ede.ts.net', 'funnel'), 'https://gavin.taile47ede.ts.net');
  assert.equal(serverUrlFor('gavin.taile47ede.ts.net.', 'tailnet'), 'https://gavin.taile47ede.ts.net');
  assert.equal(serverUrlFor('gavin.taile47ede.ts.net', 'off'), '');
  assert.equal(serverUrlFor('', 'tailnet'), '');
});

// ---------------------------------------------------------------- token 打码

test('maskToken：只给前后缀，绝不出现完整 token', () => {
  const token = 'a'.repeat(128);
  const m = maskToken(token);
  assert.equal(m.present, true);
  assert.equal(m.length, 128);
  assert.equal(m.masked, 'aaaaaaaa…aaaa（共 128 位）');
  assert.ok(!m.masked.includes(token), '打码串里不能有完整 token');
  const short = maskToken('abc');
  assert.equal(short.masked, 'abc（共 3 位）');
  assert.equal(short.length, 3);
  assert.deepEqual(maskToken(''), { masked: '', present: false, length: 0 });
  assert.deepEqual(maskToken(null), { masked: '', present: false, length: 0 });
});

// ---------------------------------------------------------------- 漂移检测

const TS_OK = { installed: true, running: true, backendState: 'Running', loggedIn: true, funnelCapable: true, funnelPorts: [443, 8443, 10000], dnsName: 'gavin.taile47ede.ts.net' };

test('diffConfig：配置与机器一致 → 单机 off / tailnet ok / funnel ok / 老值 serve', () => {
  const off = diffConfig({ expose: { enabled: false, mode: 'off' }, tailscale: TS_OK }, parseServeStatus(SERVE_OFF));
  assert.equal(off.state, 'off');
  assert.deepEqual(off.drift, []);

  const tn = diffConfig({ expose: { enabled: true, mode: 'tailnet', port: 5173, actualPort: 5173 }, tailscale: TS_OK }, parseServeStatus(SERVE_TAILNET));
  assert.equal(tn.state, 'ok');
  assert.equal(tn.actualMode, 'tailnet');
  assert.deepEqual(tn.drift, []);

  const fn = diffConfig({ expose: { enabled: true, mode: 'funnel', port: 5173, actualPort: 5173 }, tailscale: TS_OK }, parseServeStatus(SERVE_FUNNEL));
  assert.equal(fn.state, 'ok');
  assert.equal(fn.actualMode, 'funnel');

  const legacy = diffConfig({ expose: { enabled: true, mode: 'serve', port: 5173 }, tailscale: TS_OK }, parseServeStatus(SERVE_TAILNET));
  assert.equal(legacy.configMode, 'tailnet');
  assert.equal(legacy.state, 'ok');
});

test('diffConfig：每条漂移都带中文 label 与非空 detail', () => {
  const cases = [
    { code: 'tailscale-not-installed', expose: { enabled: true, mode: 'tailnet' }, ts: { installed: false, running: false }, serve: parseServeStatus(SERVE_TAILNET) },
    { code: 'tailscale-not-running', expose: { enabled: true, mode: 'tailnet' }, ts: { installed: true, running: false, backendState: 'Stopped' }, serve: parseServeStatus(SERVE_TAILNET) },
    { code: 'serve-read-failed', expose: { enabled: true, mode: 'tailnet' }, ts: TS_OK, serve: { ok: false, error: 'cli 超时' } },
    { code: 'online-enabled-but-off', expose: { enabled: true, mode: 'tailnet' }, ts: TS_OK, serve: parseServeStatus(SERVE_OFF) },
    { code: 'online-disabled-but-serve', expose: { enabled: false, mode: 'off' }, ts: TS_OK, serve: parseServeStatus(SERVE_TAILNET) },
    { code: 'funnel-cap-missing', expose: { enabled: true, mode: 'funnel' }, ts: { ...TS_OK, funnelCapable: false }, serve: parseServeStatus(SERVE_TAILNET) },
    { code: 'funnel-cap-allowed-but-off', expose: { enabled: true, mode: 'funnel' }, ts: TS_OK, serve: parseServeStatus(SERVE_TAILNET) },
    { code: 'funnel-but-config-tailnet', expose: { enabled: true, mode: 'tailnet' }, ts: TS_OK, serve: parseServeStatus(SERVE_FUNNEL) },
    { code: 'port-mismatch', expose: { enabled: true, mode: 'tailnet', port: 5173 }, ts: TS_OK, serve: parseServeStatus(SERVE_OTHER_PORT) },
    { code: 'serve-port-mismatch', expose: { enabled: true, mode: 'tailnet', port: 5173, actualPort: 5174 }, ts: TS_OK, serve: parseServeStatus(SERVE_TAILNET) },
  ];
  for (const c of cases) {
    const out = diffConfig({ expose: c.expose, tailscale: c.ts }, c.serve);
    const hit = out.drift.find((d) => d.code === c.code);
    assert.ok(hit, '应该报出漂移 ' + c.code + '，实际 ' + JSON.stringify(out.drift.map((d) => d.code)));
    assert.ok(hit.label && hit.label.length > 1, c.code + ' 要有中文 label');
    assert.ok(hit.detail.length > 0, c.code + ' 要有 detail');
    assert.equal(out.state === 'drift' || out.state === 'unknown', true);
  }
});

test('diffConfig：fatal 标记与 unknown 语义', () => {
  const noTs = diffConfig({ expose: { enabled: true, mode: 'tailnet' }, tailscale: { installed: false, running: false } }, parseServeStatus(SERVE_TAILNET));
  assert.equal(noTs.drift.find((d) => d.code === 'tailscale-not-installed').fatal, true, '没装 TailScale 属于致命漂移');
  const portDrift = diffConfig({ expose: { enabled: true, mode: 'tailnet', actualPort: 5174 }, tailscale: TS_OK }, parseServeStatus(SERVE_TAILNET));
  assert.equal(portDrift.drift.find((d) => d.code === 'serve-port-mismatch').fatal, true);
  const unknown = diffConfig({ expose: { enabled: true, mode: 'tailnet' }, tailscale: TS_OK }, parseServeStatus('坏'));
  assert.equal(unknown.state, 'unknown');
  assert.equal(diffConfig({ expose: { enabled: true, mode: 'tailnet' }, tailscale: TS_OK }, null).state, 'unknown');
  for (const code of Object.keys(DRIFT_LABELS)) assert.ok(DRIFT_LABELS[code].length > 1);
});

test('diffConfig：残留规则（指向别的对外端口）会被点名', () => {
  const facts = parseServeStatus({ TCP: { 8443: { HTTPS: true } }, Web: { 'gavin.taile47ede.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5173' } } } }, AllowFunnel: {} });
  assert.ok(facts.leftoverPorts.includes(8443), '8443 是残留的对外端口');
  const out = diffConfig({ expose: { enabled: true, mode: 'tailnet', actualPort: 5173 }, tailscale: TS_OK }, facts);
  assert.ok(out.drift.some((d) => d.code === 'leftover-serve-rules'));
});

// ---------------------------------------------------------------- readServeConfig 注入式

test('readServeConfig：serve 失败自动退回 funnel status；两条都失败给 ok:false + error', async () => {
  const calls = [];
  const run = async (bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'serve') return { ok: false, code: 1, stdout: '', stderr: 'no serve config' };
    return { ok: true, stdout: JSON.stringify(SERVE_TAILNET) };
  };
  const f = await readServeConfig('fake-tailscale', { run });
  assert.deepEqual(calls, ['serve status --json', 'funnel status --json']);
  assert.equal(f.ok, true);
  assert.equal(f.port, 5173);
  assert.equal(f.source, 'funnel');

  const bad = await readServeConfig('fake-tailscale', { run: async () => ({ ok: false, code: 1, stdout: '', stderr: 'boom' }) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /boom/);
  const none = await readServeConfig(null);
  assert.equal(none.ok, false);
});

// ---------------------------------------------------------------- setExposeMode 回滚

/** 记录每条命令并返回预设结果的假 runTailscale。 */
function fakeRun(table) {
  const calls = [];
  const run = async (bin, args) => {
    const cmd = args.join(' ');
    calls.push(cmd);
    const hit = table[cmd];
    if (typeof hit === 'function') return hit(cmd);
    return hit ?? { ok: true, code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}
const STATUS_OK = { ok: true, stdout: JSON.stringify({ BackendState: 'Running', Self: { ID: 'x', DNSName: 'gavin.taile47ede.ts.net.' }, TailscaleIPs: ['100.1.2.3'] }) };

test('setExposeMode：tailnet = 先撤 funnel（静默）再 serve --bg', async () => {
  const { run, calls } = fakeRun({ 'status --json': STATUS_OK });
  let statusCalls = 0;
  const statusFn = async () => {
    statusCalls += 1;
    return { ok: true, url: 'https://gavin.taile47ede.ts.net', dnsName: 'gavin.taile47ede.ts.net' };
  };
  const out = await setExposeMode('ts', { port: 5173, mode: 'tailnet' }, { run, statusFn, logger: quiet });
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'tailnet');
  assert.deepEqual(calls.slice(0, 2), ['funnel reset', 'serve --bg 5173'], '顺序必须是先撤 funnel 再 serve');
  assert.equal(statusCalls, 1, '节点状态只读一次（用于回填 URL）');
  assert.equal(out.url, 'https://gavin.taile47ede.ts.net');
});

test('setExposeMode：funnel = serve 先生效，再 funnel --bg', async () => {
  const { run, calls } = fakeRun({ 'status --json': STATUS_OK });
  const out = await setExposeMode('ts', { port: 5173, mode: 'funnel' }, { run, logger: quiet });
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'funnel');
  assert.deepEqual(calls.slice(0, 2), ['serve --bg 5173', 'funnel --bg 5173']);
});

test('setExposeMode：funnel 失败 → ok:false code=funnel-unavailable，且 serve 保持生效（不回滚成关闭）', async () => {
  const { run, calls } = fakeRun({
    'funnel --bg 5173': { ok: false, code: 1, stdout: '', stderr: 'Funnel not available; enable it in the admin console' },
    'status --json': STATUS_OK,
  });
  const out = await setExposeMode('ts', { port: 5173, mode: 'funnel' }, { run, logger: quiet });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'funnel-unavailable');
  assert.equal(out.mode, 'tailnet', '失败时退化为 tailnet，serve 仍在');
  assert.match(out.message, /serve 仍生效/);
  assert.ok(calls.includes('serve --bg 5173'), 'serve 已经跑过');
  assert.ok(!calls.some((c) => c.includes('serve reset')), '不能把 serve 也撤掉');
});

test('setExposeMode：serve 本身失败 → serve-failed，不再碰 funnel', async () => {
  const { run, calls } = fakeRun({ 'serve --bg 5173': { ok: false, code: 1, stdout: '', stderr: 'permission denied' } });
  const out = await setExposeMode('ts', { port: 5173, mode: 'funnel' }, { run, logger: quiet });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'serve-failed');
  assert.ok(!calls.includes('funnel --bg 5173'));
});

test('setExposeMode：off = serve reset + funnel reset；两步都失败才 ok:false', async () => {
  const ok = fakeRun({});
  const a = await setExposeMode('ts', { port: 5173, mode: 'off' }, { run: ok.run, logger: quiet });
  assert.equal(a.ok, true);
  assert.deepEqual(ok.calls.slice(0, 2), ['serve reset', 'funnel reset']);

  const both = fakeRun({
    'serve reset': { ok: false, code: 1, stdout: '', stderr: 'x' },
    'funnel reset': { ok: false, code: 1, stdout: '', stderr: 'y' },
  });
  const b = await setExposeMode('ts', { port: 5173, mode: 'off' }, { run: both.run, logger: quiet });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'reset-failed');
  const partial = fakeRun({ 'serve reset': { ok: false, code: 1, stdout: '', stderr: 'x' } });
  assert.equal((await setExposeMode('ts', { port: 5173, mode: 'off' }, { run: partial.run, logger: quiet })).ok, true);
});

test('setExposeMode：非法 mode / 非法端口 / 没有二进制 / run 抛异常都不抛，返回结构化错误', async () => {
  const { run } = fakeRun({});
  assert.equal((await setExposeMode('ts', { port: 5173, mode: 'xxx' }, { run, logger: quiet })).code, 'bad-mode');
  assert.equal((await setExposeMode('ts', { port: 0, mode: 'tailnet' }, { run, logger: quiet })).code, 'bad-port');
  const boom = async () => { throw new Error('boom'); };
  const r = await setExposeMode('ts', { port: 5173, mode: 'tailnet' }, { run: boom, logger: quiet });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'serve-failed');
});

// ---------------------------------------------------------------- 来源校验

test('来源校验：只认回环地址 + 本机 Host 头', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('100.64.1.2'), false);
  assert.equal(isLoopbackAddress('192.168.1.9'), false);
  assert.equal(isLoopbackAddress(null), false);

  assert.equal(isLocalManageHost('127.0.0.1:5173'), true);
  assert.equal(isLocalManageHost('localhost:5173'), true);
  assert.equal(isLocalManageHost('[::1]:5173'), true);
  assert.equal(isLocalManageHost('gavin.taile47ede.ts.net'), false);
  assert.equal(isLocalManageHost('evil.example.com'), false);
  assert.equal(isLocalManageHost(''), false);

  const req = (addr, host) => ({ socket: { remoteAddress: addr }, headers: { host } });
  assert.equal(isLocalManageRequest(req('127.0.0.1', '127.0.0.1:5173')), true);
  assert.equal(isLocalManageRequest(req('::1', 'localhost:5173')), true);
  assert.equal(isLocalManageRequest(req('100.64.1.2', '127.0.0.1:5173')), false, 'TailScale 网段来的不放行');
  assert.equal(isLocalManageRequest(req('127.0.0.1', 'gavin.taile47ede.ts.net')), false, 'DNS 重绑定不放行');
  assert.equal(isLocalManageRequest(null), false);
});

/** 发一个真的 HTTP 请求，Host 头由我们说了算（fetch 会改写 Host，这里必须用 node:http）。 */
function rawRequest(port, { method = 'GET', path = '/', host = '127.0.0.1', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...headers }, setHost: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (host) req.setHeader('host', host);
    if (body) req.write(body);
    req.end();
  });
}

async function withLobby(fn, opts = {}) {
  const rooms = new RoomManager({ logger: quiet });
  const idKey = makeKey(30);
  const calls = [];
  const route = createLobbyRouter({
    rooms,
    idKey,
    serverName: '测试源',
    logger: quiet,
    online: { enabled: true, mode: 'tailnet', serverUrl: 'https://gavin.taile47ede.ts.net', token: 'a'.repeat(128), port: 5173 },
    switchMode: async (mode) => {
      calls.push(mode);
      if (mode === 'funnel' && opts.funnelBroken) return { ok: false, code: 'funnel-unavailable', message: 'funnel 起不来' };
      return { ok: true, url: mode === 'off' ? '' : 'https://gavin.taile47ede.ts.net', mode };
    },
    adminInfo: opts.noAdmin
      ? null
      : async () => ({
        app: { name: 'jican-simulator', version: '0.2.0' },
        port: 5173,
        idKey: { hint: idKey.slice(0, 8) + '…', full: idKey },
        online: { enabled: true, mode: 'tailnet', serverUrl: 'https://gavin.taile47ede.ts.net', port: 5173, hasToken: true, token: 'a'.repeat(128), tokenMasked: '' },
        rooms: { count: 0, list: [] },
        drift: { state: 'ok', drift: [] },
        leaky: idKey,
      }),
    tailscaleFacts: async () => ({ installed: true, running: true, backendState: 'Running', funnelCapable: true, funnelPorts: [443], serve: parseServeStatus(SERVE_TAILNET), classify: classifyMode(parseServeStatus(SERVE_TAILNET)), dnsName: 'gavin.taile47ede.ts.net', url: 'https://gavin.taile47ede.ts.net' }),
    // 设置页「显示完整 Token」/「重新生成」（v0.5）
    readToken: opts.noToken ? null : () => ({ token: 'b'.repeat(256) }),
    regenerateToken: opts.noToken
      ? null
      : async () => {
        calls.push('regen-token');
        return { token: 'c'.repeat(256), masked: 'cccccccc…（共 256 位）', length: 256, ok: true };
      },
    ...(opts.router || {}),
  });
  const server = createServer((req, res) => {
    if (!route(req, res)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"ok":false}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn({ port, origin: 'http://127.0.0.1:' + port, rooms, idKey, calls });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('GET /api/net/admin：200 且绝不出现完整 token / 完整 idKey', async () => {
  await withLobby(async ({ origin, idKey }) => {
    const res = await fetch(origin + '/api/net/admin');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text.includes(idKey), false, '响应里不能有完整 idKey');
    assert.equal(text.includes('a'.repeat(128)), false, '响应里不能有完整 token');
    assert.equal(/[0-9a-f]{256}/.test(text), false, '响应里不能出现 256 位 hex 串');
    const body = JSON.parse(text);
    assert.equal(body.ok, true);
    assert.equal(body.idKey.full, undefined, 'idKey.full 必须被剥掉');
    assert.equal(body.online.token, undefined, 'online.token 必须被剥掉');
    assert.equal(body.app.version, '0.2.0');
    assert.match(body.leaky, /…/, '即使上游漏了完整 idKey，也会被打码');
  });
});

test('GET /api/net/admin：非本机 Host 头 → 403；没有 adminInfo → 404；POST → 405', async () => {
  await withLobby(async ({ port }) => {
    const res = await rawRequest(port, { path: '/api/net/admin', host: 'gavin.taile47ede.ts.net' });
    assert.equal(res.status, 403);
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /只允许本机/);
  });
  await withLobby(async ({ port }) => {
    // 顺手确认：正常 Host 头能过（对照组）
    assert.equal((await rawRequest(port, { path: '/api/net/admin', host: '127.0.0.1:1' })).status, 200);
  });
  await withLobby(async ({ origin }) => {
    const res = await fetch(origin + '/api/net/admin');
    assert.equal(res.status, 404);
  }, { noAdmin: true });
  await withLobby(async ({ origin }) => {
    const res = await fetch(origin + '/api/net/admin', { method: 'POST', body: '{}' });
    assert.equal(res.status, 405);
  });
});

test('POST /api/net/online/mode：新值 tailnet/funnel/off 与旧值 serve 都走 switchMode', async () => {
  await withLobby(async ({ origin, calls }) => {
    const post = (mode) => fetch(origin + '/api/net/online/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
    const a = await post('funnel');
    assert.equal(a.status, 200);
    let body = await a.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'funnel');
    assert.equal(body.serverUrl, 'https://gavin.taile47ede.ts.net');

    const b = await post('serve'); // 旧值
    assert.equal(b.status, 200);
    body = await b.json();
    assert.equal(body.mode, 'tailnet', '旧值 serve 当 tailnet');
    assert.equal(body.requestedMode, 'tailnet');

    const c = await post('off');
    assert.equal(c.status, 200);
    body = await c.json();
    assert.equal(body.ok, true);
    assert.equal(body.serverUrl, '');
    assert.deepEqual(calls, ['funnel', 'tailnet', 'off']);
  });
});

test('POST /api/net/online/mode：非法 mode → 400；非本机来源 → 403；坏 JSON → 400', async () => {
  await withLobby(async ({ port, calls }) => {
    const bad = await rawRequest(port, { method: 'POST', path: '/api/net/online/mode', host: 'evil.example.com', body: '{"mode":"funnel"}' });
    assert.equal(bad.status, 403);
    assert.equal(bad.json.error, '只允许本机设置页修改联机配置');
    assert.deepEqual(calls, [], '被拒的请求不能真的去改 TailScale');
    // 回环 + 本机 Host 才继续往下校验
    const wrong = await rawRequest(port, { method: 'POST', path: '/api/net/online/mode', host: '127.0.0.1:5173', body: '{"mode":"xxx"}' });
    assert.equal(wrong.status, 400);
    const notJson = await rawRequest(port, { method: 'POST', path: '/api/net/online/mode', host: '127.0.0.1:5173', body: 'not json' });
    assert.equal(notJson.status, 400);
  });
});

test('POST /api/net/online/mode：未启用 TailScale 集成 → 501', async () => {
  await withLobby(async ({ origin }) => {
    const res = await fetch(origin + '/api/net/online/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"tailnet"}' });
    assert.equal(res.status, 501);
  }, { router: { switchMode: null } });
});

test('POST /api/net/online/mode：funnel 不可用时 500 + code + 中文说明', async () => {
  await withLobby(async ({ origin }) => {
    const res = await fetch(origin + '/api/net/online/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"funnel"}' });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'funnel-unavailable');
    assert.match(body.message, /tailnet/);
  }, { funnelBroken: true });
});

test('GET /api/net/online：保留老五字段，并补 tailscale / drift', async () => {
  await withLobby(async ({ origin }) => {
    const res = await fetch(origin + '/api/net/online');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    for (const k of ['enabled', 'mode', 'serverUrl', 'port', 'hasToken']) assert.ok(k in body.online, '老字段 ' + k + ' 必须在');
    assert.equal(body.online.enabled, true);
    assert.equal(body.online.hasToken, true);
    assert.equal(body.online.token, undefined, '绝不能下发完整 token');
    assert.ok(body.online.tokenMasked.length > 0);
    assert.equal(body.online.tokenLength, 128);
    assert.equal(body.tailscale.installed, true);
    assert.equal(body.tailscale.funnelCapable, true);
    assert.equal(body.tailscale.mode, 'tailnet');
    assert.equal(body.tailscale.serveStatus.port, 5173);
    assert.equal(typeof body.drift.state, 'string');
    assert.ok(Array.isArray(body.drift.drift));
    assert.equal(JSON.stringify(body).includes('a'.repeat(128)), false);
  });
});

test('GET /api/net/admin/token：本机可取完整 token，来源不是本机 → 403', async () => {
  await withLobby(async ({ origin, port }) => {
    const res = await fetch(origin + '/api/net/admin/token');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.token, 'b'.repeat(256));
    assert.equal(body.length, 256);
    assert.equal(body.hasToken, true);
    assert.match(body.masked, /…/, '顺手回一个掩码，前端可以拿它更新显示');
    const bad = await rawRequest(port, { path: '/api/net/admin/token', host: 'gavin.taile47ede.ts.net' });
    assert.equal(bad.status, 403);
    assert.match(bad.json.error, /只允许本机/);
  });
});

test('GET /api/net/admin/token：POST → 405；未注入 → 501（前端据此提示「版本不支持」）', async () => {
  await withLobby(async ({ origin }) => {
    const res = await fetch(origin + '/api/net/admin/token', { method: 'POST', body: '{}' });
    assert.equal(res.status, 405);
  });
  await withLobby(async ({ origin }) => {
    const res = await fetch(origin + '/api/net/admin/token');
    assert.equal(res.status, 501);
  }, { noToken: true });
});

test('POST /api/net/token/regenerate：只回掩码不回全文；非本机来源 → 403 且不真的生成', async () => {
  await withLobby(async ({ origin, port, calls }) => {
    const res = await fetch(origin + '/api/net/token/regenerate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text.includes('c'.repeat(256)), false, '重新生成接口不能把新 token 全文发出去');
    const body = JSON.parse(text);
    assert.equal(body.ok, true);
    assert.equal(body.tokenLength, 256);
    assert.match(body.tokenMasked, /…/);
    assert.deepEqual(calls, ['regen-token']);

    calls.length = 0;
    const bad = await rawRequest(port, { method: 'POST', path: '/api/net/token/regenerate', host: 'evil.example.com', body: '{}' });
    assert.equal(bad.status, 403);
    assert.deepEqual(calls, [], '被拒的请求不能真的把 token 换掉');
  });
});

test('大厅既有接口不受影响：/api/net/info 仍下发完整 idKey（联机身份需要）', async () => {
  await withLobby(async ({ origin, idKey }) => {
    const res = await fetch(origin + '/api/net/info');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.idKey, idKey);
    assert.equal(buildRoomUrl('https://x.ts.net', { token: 'T', idKey, type: 'create', username: 'u' }).includes(idKey), true);
  });
});
