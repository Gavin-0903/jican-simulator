#!/usr/bin/env node
// 入口：加载配置 → 地图 → LLM 网关（可选）→ 游戏控制器 → HTTP + WebSocket（同端口）。
// 用法：node server/index.js [--port 5173] [--host 127.0.0.1] [--open]

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, watchBalance } from './persistence/ConfigLoader.js';
import { SaveManager } from './persistence/SaveManager.js';
import { GameMap } from './world/GameMap.js';
import { LlmGateway } from './llm/LlmGateway.js';
import { GameController } from './core/GameController.js';
import { createHttpHandler } from './net/HttpServer.js';
import { WsServer } from './net/WsServer.js';
import { loadOrCreateIdKey } from './net/IdKey.js';
import { RoomManager } from './net/RoomManager.js';
import { createLobbyRouter } from './net/LobbyHttp.js';
import { LobbyGateway } from './net/LobbyGateway.js';
import { createConfigAdmin } from './net/ConfigAdmin.js';
import { applySetup, readSettings, writeSettings } from './persistence/AppSettings.js';
import { enableServerSource, readOnlineConfig, writeOnlineConfig } from './persistence/OnlineConfig.js';
import { dataDir } from './persistence/paths.js';
import { findTailscale, makeOnlineToken, resetExpose, runTailscale, setExposeMode, setupTailscale, tailscaleInstalled, tailscaleStatus, tailscaleVersion } from './net/TailScale.js';
import { classifyMode, diffConfig, funnelCaps, funnelPortNote, maskToken, readServeConfig } from './net/OnlineAdmin.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function listen(server, host, port) {
  return new Promise((ok, fail) => {
    const onError = (err) => {
      server.off('listening', onListening);
      fail(err);
    };
    const onListening = () => {
      server.off('error', onError);
      ok(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * 把配置里的 mode 归一成设置页的三选一：'tailnet' | 'funnel' | 'off'。
 * 旧配置里的 'serve' 就是「仅 tailnet 可见」，历史数据要能平滑读进来。
 */
function toExposeMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'funnel') return 'funnel';
  if (m === 'off' || m === 'none' || m === 'disabled') return 'off';
  if (m === 'tailnet' || m === 'serve' || m === 'tsnet') return 'tailnet';
  return null;
}

/** 端口被占用时依次尝试后续端口。 */
async function listenWithFallback(server, host, port, range, logger) {
  for (let i = 0; i <= range; i++) {
    try {
      return await listen(server, host, port === 0 ? 0 : port + i);
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || port === 0) throw err;
      logger.warn?.(`[server] 端口 ${port + i} 已被占用，尝试 ${port + i + 1}`);
    }
  }
  throw new Error(`端口 ${port}–${port + range} 均被占用`);
}

export async function startServer(opts = {}) {
  const { rootDir = ROOT, port = null, host = null, logger = console, watch = true, llm = true, saveDir = null } = opts;
  const config = loadConfig(rootDir, { logger });
  if (!llm) config.llm.enabled = false;
  const bindHost = host ?? config.app.server.host;
  const map = new GameMap(config.mapData, { radius: config.balance.move.radius, gridSize: config.balance.nav.gridSize, lowCoverDepth: config.balance.vision.lowCoverDepth });
  const gateway = new LlmGateway(config.llm, { logger });
  await gateway.init();
  // 存档目录：默认配置里写的是相对路径（data/saves），必须挂到真正的可写数据目录下，
  // 否则装进 Program Files 后存档全部 EPERM。绝对路径（--save-dir / saveDir 参数）原样使用。
  const saves = new SaveManager({ dir: saveDir ?? (isAbsolute(config.app.save.dir) ? config.app.save.dir : join(dataDir(), config.app.save.dir)), keepRounds: config.app.save.keepRounds, logger });
  const controller = new GameController({ config, map, saveManager: saves, gateway, logger });

  // 联机（需求 3）：本机 ID 密钥 + 房间表；只有「服务器源」实例才挂载大厅路由。
  const idKey = loadOrCreateIdKey(rootDir, { logger });
  const rooms = new RoomManager({ logger });
  // 联机网关（v0.3）：房间鉴权 + 座位判定（房主=玩家、其余观战）+ 玩家列表。
  // WsServer 在 upgrade 阶段用它把 /lobby?roomid=&token=… 翻译成角色；HTTP 侧用它渲染玩家列表。
  // wsRef 先占位：ws 实例在 http 监听之后才建，而 gateway 的 broadcast 需要它（所以要一层间接）。
  const wsRef = { value: null };
  const lobby = new LobbyGateway({
    rooms,
    controller,
    logger,
    // 广播玩家列表：房间成员变化时推到所有已连上的窗口（ws 此刻还没建，用 wsRef 间接引用）
    broadcast: () => wsRef.value?.broadcastPlayers(),
  });
  const settings = readSettings(rootDir);
  // 联机（v0.3）：data/config.json 的 online 段由安装期/启动期自动写入；交给 startServer 后
  // 这里是唯一的事实来源（settings.isServerSource 只作为兜底）。
  const online = opts.online ?? readOnlineConfig(rootDir);
  const isServerSource = Boolean(opts.isServerSource ?? (online.enabled || settings.isServerSource));
  // 配置里可能还是老值 'serve'（= 仅 tailnet 可见），对外统一说成 'tailnet'。
  const initialMode = toExposeMode(online.mode) || 'tailnet';
  if (isServerSource && config.app.server.host === '127.0.0.1' && !host) config.app.server.host = '0.0.0.0';
  // 大厅路由总是挂载：非服务器源实例也提供 /api/net/info & /api/net/join 作为「联机客户端」，
  // 由请求里的服务器源 URL 决定真正打到哪台机器（跨域已放开）。isServerSource 只影响是否对外监听。
  const onlineState = { enabled: Boolean(online.enabled), mode: initialMode, serverUrl: online.serverUrl ?? '', token: online.token ?? '', port: online.port ?? null };
  const actualPortRef = { value: null };
  const bin = findTailscale();
  // tailscale 探测结果的 1.5s 内存缓存：设置页一打开会连着问 admin + online，没必要跑两遍 CLI。
  let tailscaleCache = null;
  /**
   * 设置页三选一切换（tailnet / funnel / off）。
   * 成功才落盘：off 时 enabled=false、地址清空；tailnet/funnel 时 enabled=true 并回填 https 地址。
   * funnel 起不来时 setExposeMode 已把规则保持为 serve（仅 tailnet），这里只回报失败原因，不改配置。
   */
  const switchMode = async (mode) => {
    const want = toExposeMode(mode);
    if (!want) return { ok: false, code: 'bad-mode', message: 'mode 只能是 tailnet、funnel 或 off' };
    const port = actualPortRef.value ?? config.app.server.port;
    if (!bin) return { ok: false, code: 'no-binary', message: '本机没有安装 TailScale' };
    const r = await setExposeMode(bin, { port, mode: want }, { logger });
    if (!r.ok) return { ok: false, code: r.code ?? 'switch-failed', message: r.message ?? '切换失败', url: r.url ?? '', mode: onlineState.mode };
    if (want === 'off') {
      onlineState.enabled = false;
      onlineState.mode = 'off';
      onlineState.serverUrl = '';
      writeOnlineConfig(rootDir, { enabled: false, mode: 'off', serverUrl: '' });
      tailscaleCache = null;
      return { ok: true, url: '', mode: 'off' };
    }
    const url = r.url || onlineState.serverUrl || '';
    onlineState.enabled = true;
    onlineState.mode = want;
    onlineState.serverUrl = url;
    onlineState.port = port;
    writeOnlineConfig(rootDir, { enabled: true, mode: want, serverUrl: url, port });
    tailscaleCache = null;
    return { ok: true, url, mode: want };
  };
  const refreshTailscaleFacts = async ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && tailscaleCache && now - tailscaleCache.at < 1500) return tailscaleCache.value;
    const version = bin ? (await tailscaleVersion(bin)) : { ok: false, stdout: '' };
    const st = bin ? await tailscaleStatus(bin) : { ok: false, backendState: '', hostname: '', dnsName: '', url: '', loggedIn: false };
    const rawStatus = bin ? await runTailscale(bin, ['status', '--json'], { timeoutMs: 10000 }) : { ok: false, stdout: '' };
    const caps = funnelCaps(rawStatus.ok ? rawStatus.stdout : null);
    const serve = await readServeConfig(bin);
    const cls = classifyMode(serve);
    const value = {
      installed: Boolean(bin),
      bin: bin || '',
      version: version.ok ? String(version.stdout || '').split('\n')[0].trim() : '',
      running: Boolean(st.ok),
      loggedIn: Boolean(st.loggedIn),
      backendState: st.backendState ?? '',
      hostname: st.hostname ?? '',
      dnsName: st.dnsName ?? serve.dnsName ?? '',
      url: st.url ?? '',
      ips: Array.isArray(st.ips) ? st.ips : [],
      funnelCapable: caps.funnelCapable,
      funnelPorts: caps.funnelPorts,
      funnelReason: caps.reason,
      funnelNote: funnelPortNote(),
      serve,
      classify: cls,
      portFile: join(dataDir(), 'config.json'),
    };
    tailscaleCache = { at: now, value };
    return value;
  };
  // 桌面宿主（v0.4）关停通道：托盘「退出」→ POST /api/app/quit → 这里登记的钩子。
  let requestShutdown = null;
  /** 设置页 GET /api/net/admin 的整包事实（只给脱敏数据：token 只给 mask，idKey 只给 hint）。 */
  const adminInfo = async () => {
    const facts = await refreshTailscaleFacts();
    const port = actualPortRef.value ?? config.app.server.port;
    const expose = { enabled: Boolean(onlineState.enabled), mode: onlineState.mode, port, actualPort: port, serverUrl: onlineState.serverUrl };
    const drift = diffConfig({ expose, isServerSource, tailscale: facts, actualPort: port }, facts.serve);
    const mt = maskToken(onlineState.token);
    const roomList = [...rooms.rooms.values()].map((r) => {
      const v = rooms.view(r);
      return { id: v.id, owner: v.owner, members: v.members, memberCount: v.members.length, createdAt: v.createdAt };
    });
    return {
      app: { name: config.app?.name ?? 'jican-simulator', version: config.app?.version ?? '', pid: process.pid },
      dataDir: dataDir(),
      portFile: join(dataDir(), 'config.json'),
      port,
      idKey: { hint: `${String(idKey.key).slice(0, 8)}…`, length: String(idKey.key).length, file: idKey.file ?? '' },
      online: { enabled: Boolean(onlineState.enabled), mode: onlineState.mode, serverUrl: onlineState.serverUrl, port: onlineState.port, hasToken: mt.present, tokenMasked: mt.masked, tokenLength: mt.length },
      tailscale: {
        installed: facts.installed,
        version: facts.version,
        running: facts.running,
        backendState: facts.backendState,
        hostname: facts.hostname,
        dnsName: facts.dnsName,
        url: facts.url,
        funnelCapable: facts.funnelCapable,
        funnelPorts: facts.funnelPorts,
        funnelNote: facts.funnelNote,
        mode: facts.classify.mode,
        tailnetAvailable: facts.classify.tailnetAvailable,
        servePort: facts.classify.port,
        serveStatus: facts.serve,
      },
      rooms: { count: roomList.length, list: roomList },
      settings,
      isServerSource,
      drift,
    };
  };
  // 服务端配置读写（v0.6）：写盘成功后立刻把新 balance 推给 controller（下一 tick 生效），
  // 这样设置页改完不用重启就能看到手感变化；app 段里要重启才生效的键由 needRestart 提示。
  const configAdmin = createConfigAdmin({
    rootDir,
    onApply: () => {
      // 先再装载一次（以磁盘为准，避免两次点击之间被手改），成功后整套热替换：
      // balance 推给 controller 保下一 tick 生效，app/llm 原地覆盖以保住引用（别处已持有 config 对象）。
      const next = loadConfig(rootDir, { logger });
      controller.setBalance(next.balance);
      Object.assign(config.app, next.app);
      Object.assign(config.llm, next.llm);
      // online 段（v0.7）：设置页改完默认服务器源地址/token 要立刻反映到联机状态，
      // 否则 adminInfo 仍报旧值、用户以为没保存成功。就地覆盖以保住 adminInfo/lobbyRouter 持有的引用。
      const onlineNext = readOnlineConfig(rootDir);
      Object.assign(onlineState, onlineNext);
      // config.balance 也被别的模块持有（落盘、ws 下行），就地覆盖而不是换引用
      if (config.balance && typeof config.balance === 'object') for (const k of Object.keys(config.balance)) delete config.balance[k];
      if (config.balance && typeof config.balance === 'object') Object.assign(config.balance, next.balance);
    },
  });
  const lobbyRouter = createLobbyRouter({
    rooms,
    idKey: idKey.key,
    serverName: config.app.server.name ?? '服务器源',
    logger,
    isServerSource,
    online: onlineState,
    switchMode,
    adminInfo,
    tailscaleFacts: refreshTailscaleFacts,
    // 设置页「显示完整 Token」/「重新生成 Token」（v0.5）。
    // 两处都只在本机回环 + Host 校验通过后才会被 LobbyHttp 调用。
    readToken: () => ({ token: String(onlineState.token || '') }),
    regenerateToken: async () => {
      const token = makeOnlineToken();
      onlineState.token = token;
      // 落盘：config.json 的 online.token，重启后仍是同一个 token
      writeOnlineConfig(rootDir, { token });
      // 旧 token 立刻失效：服务器源上已建房间都绑着旧 token，直接清空让玩家重新加入
      if (rooms && rooms.rooms && typeof rooms.rooms.clear === 'function') rooms.rooms.clear();
      const mt = maskToken(token);
      logger.info?.('[net] 联机 Token 已重新生成（旧 Token 立即失效）');
      return { token, masked: mt.masked, length: mt.length, ok: true };
    },
    // 桌面宿主（v0.4）：/api/app/ping 回显版本与端口，/api/app/quit 交给下面的 shutdown 通道。
    appInfo: () => ({ version: config.app?.version ?? '', uptime: Math.round(process.uptime()) }),
    requestQuit: () => requestShutdown?.('launcher'),
    configAdmin,
    lobby,
    broadcastPlayers: () => wsRef.value?.broadcastPlayers(),
  });
  const stopWatch = watch ? watchBalance(rootDir, (b) => controller.setBalance(b), { logger }) : () => {};

  const http = createServer();
  const actualPort = await listenWithFallback(http, bindHost, port ?? config.app.server.port, config.app.server.portFallbackRange, logger);
  actualPortRef.value = actualPort;
  http.on('request', createHttpHandler({ rootDir, controller, map, host: bindHost, debug: config.app.debug?.endpoints, logger, lobbyRouter, idKey: idKey.key, isServerSource }));
  const ws = new WsServer({ httpServer: http, controller, app: config.app, port: actualPort, host: bindHost, logger, lobby });
  wsRef.value = ws;
  const shownHost = bindHost === '0.0.0.0' || bindHost === '::' ? 'localhost' : bindHost;
  const url = `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${actualPort}`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    stopWatch();
    // 退出时不重置 serve/funnel：规则是常驻的，用户可能还想用同一地址分享给别人。
    ws.close();
    gateway.close();
    await controller.close();
    await new Promise((ok) => http.close(() => ok()));
  };
  // 联机自启：只有「服务器源」实例才把本机端口通过 TailScale 暴露出去（默认 serve，可切 funnel）。
  // 失败不影响单机游玩，只记日志并在返回值里说明原因。
  let tailscale = null;
  // mode='off'（用户在设置页关掉了联机）时不再自启暴露；tailnet/funnel 才走 setupTailscale。
  if (opts.tailscale !== false && isServerSource && online.enabled && onlineState.mode !== 'off') {
    // setupTailscale 只认 'serve'|'funnel'（语义未变），所以这里把 tailnet 折回 'serve'。
    tailscale = await setupTailscale({ port: actualPort, expose: onlineState.mode === 'funnel' ? 'funnel' : 'serve', logger });
    if (tailscale.ok) {
      onlineState.serverUrl = tailscale.url;
      onlineState.port = actualPort;
      writeOnlineConfig(rootDir, { serverUrl: tailscale.url, port: actualPort, enabled: true, mode: onlineState.mode });
    }
  }
  tailscaleCache = null; // 暴露规则刚变过，缓存作废
  // shutdownHooks：让宿主/CLI 能优雅停服（关存档、关 ws、关 http）。幂等。
  const shutdownHooks = [];
  requestShutdown = (reason) => {
    logger.info?.('[server] 收到关停请求：' + reason);
    for (const fn of shutdownHooks) {
      try {
        fn(reason);
      } catch (err) {
        logger.warn?.('[server] 关停钩子失败：' + err.message);
      }
    }
  };
  return { url, port: actualPort, controller, gateway, config, close, idKey: idKey.key, idKeyCreated: idKey.created, rooms, lobby, ws, isServerSource, settings, online: onlineState, tailscale, adminInfo, refreshTailscaleFacts, readToken: () => ({ token: String(onlineState.token || '') }), shutdownHooks, shutdown: (reason) => requestShutdown(reason ?? 'api') };
}

/** 优先以 960×600 的应用窗口打开（Chrome/Edge），失败则交给系统默认浏览器。 */
export function openBrowser(url) {
  const tryRun = (cmd, args) =>
    new Promise((ok) => {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: process.platform !== 'win32' });
      p.on('error', () => ok(false));
      p.on('exit', (code) => ok(code === 0));
      p.unref();
    });
  const appArgs = [`--app=${url}`, '--window-size=960,600'];
  (async () => {
    if (process.platform === 'darwin') {
      if (await tryRun('open', ['-na', 'Google Chrome', '--args', ...appArgs])) return;
      if (await tryRun('open', ['-na', 'Microsoft Edge', '--args', ...appArgs])) return;
      await tryRun('open', [url]);
    } else if (process.platform === 'win32') {
      if (await tryRun('cmd', ['/c', 'start', '', 'msedge', ...appArgs])) return;
      await tryRun('cmd', ['/c', 'start', '', url]);
    } else {
      await tryRun('xdg-open', [url]);
    }
  })();
}

function parseArgs(argv) {
  const out = { open: false, port: null, host: null, setup: false, serverSource: null, keepOpen: false, expose: null, noTailscale: false, serve: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--open') out.open = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--setup') out.setup = true;
    else if (a === '--server-source') out.serverSource = true;
    else if (a === '--client') out.serverSource = false;
    else if (a === '--keep-open') out.keepOpen = true;
    else if (a === '--expose') out.expose = argv[++i] === 'funnel' ? 'funnel' : 'serve';
    else if (a === '--no-tailscale') out.noTailscale = true;
    // 桌面宿主（v0.4）用它告诉内核「只起服务，别开浏览器」：窗口由宿主自己的 WebView2 提供。
    else if (a === '--serve' || a === '--spawn-only') out.serve = true;
  }
  return out;
}

/**
 * 安装包首次运行时调用（Inno [Run] 以 --setup runhidden waituntilterminated 执行）：
 *   1) 强制检测环境里的 TailScale（tailscale -v；找不到再看常见安装路径）；
 *   2) 有 → 创建 data/ 目录、修改 config.json 开启联机、写入本机服务器源地址与默认 token、
 *      把端口通过 tailscale serve（默认；可用 --expose funnel 改成公网）暴露出去；
 *   3) 没有 → 返回 no-tailscale 码，由安装器（ISCC 的 Check + MsgBox）询问用户是否安装。
 * 不启动游戏服务本身，处理完即退出。
 */
async function runSetup(mode, opts = {}) {
  // 数据目录不再是 <安装目录>/data（装到 Program Files 时那儿不可写），而是用户目录下的 JicanSimulator/
  const dataDirPath = dataDir();
  mkdirSync(dataDirPath, { recursive: true });
  const wantServer = mode === 'server';

  // ---- 1) 强制检测 TailScale
  const bin = findTailscale();
  const vres = bin ? await tailscaleVersion(bin) : { ok: false, stdout: '' };
  const version = vres.ok ? String(vres.stdout).split('\n')[0].trim() : '';
  const detected = Boolean(bin) && vres.ok;
  console.log('');
  console.log('  [1/3] 检测 TailScale：' + (detected ? `已安装（${version}）→ ${bin}` : '未检测到（tailscale -v 失败或不存在）'));

  if (!detected) {
    // 没装：关掉联机，把结论交回安装器
    applySetup(ROOT, { isServerSource: false });
    writeOnlineConfig(ROOT, { enabled: false, mode: 'serve', serverUrl: '', token: '' });
    console.log('  [2/3] 未安装 TailScale：已按单机模式写入设置');
    console.log('  [3/3] 安装包会询问是否自动下载安装 TailScale');
    console.log('SETUP_RESULT={"tailscale":false,"online":false,"reason":"no-tailscale"}');
    return { tailscale: false, online: false, reason: 'no-tailscale' };
  }

  if (!wantServer || opts.noTailscale) {
    applySetup(ROOT, { isServerSource: false });
    writeOnlineConfig(ROOT, { enabled: false });
    console.log('  [2/3] 选择单机/客户端模式：已关闭联机');
    console.log('SETUP_RESULT={"tailscale":true,"online":false,"reason":"client"}');
    return { tailscale: true, online: false, reason: 'client' };
  }

  // ---- 2) 打开联机 + 生成默认 token + 写 config.json
  const expose = opts.expose === 'funnel' ? 'funnel' : 'serve';
  const port = Number(globalThis.__JICAN_PORT__) || 5173;
  const token = makeOnlineToken();
  const cfg = enableServerSource({ rootDir: ROOT, url: '', token, port, mode: expose });
  applySetup(ROOT, { isServerSource: true });
  console.log('  [2/3] 已开启联机：data/config.json online.enabled=true，token 已生成（' + token.slice(0, 16) + '…）');

  // ---- 3) 启动 TailScale 服务并把本机端口暴露出去
  const r = await setupTailscale({ port, expose, logger: console });
  if (!r.ok) {
    console.log('  [3/3] TailScale 就绪失败：' + (r.message ?? r.code) + '（已保留联机配置，登录后启动游戏会自动重试）');
    console.log('SETUP_RESULT=' + JSON.stringify({ tailscale: true, online: true, expose, url: '', token, reason: r.code ?? 'expose-failed', config: cfg.enabled }));
    return { tailscale: true, online: true, expose, url: '', token, reason: r.code ?? 'expose-failed' };
  }
  enableServerSource({ rootDir: ROOT, url: r.url, token, port, mode: expose });
  const how = expose === 'funnel' ? 'Funnel（公网可访问，需在 TailScale 后台开启 Funnel 能力）' : 'Serve（仅你自己的 tailnet 内可访问）';
  console.log('  [3/3] TailScale 已就绪，本机已是服务器源：' + r.url);
  console.log('        暴露方式：' + how + '（可在软件设置页随时切换）');
  console.log('        默认 Token：' + token);
  console.log('SETUP_RESULT=' + JSON.stringify({ tailscale: true, online: true, expose, url: r.url, token }));
  return { tailscale: true, online: true, expose, url: r.url, token };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli(parseArgs(process.argv.slice(2)));
}

export { ROOT };

/**
 * CLI 主流程。SEA 单文件入口（packaging/sea-entry.cjs）会先展开资源、再 import 本模块，
 * 此时 process.argv[1] 是 exe 路径而不是本文件，isMain 判定不成立，
 * 所以入口文件显式调用本函数，保证「内嵌 exe」与「node server/index.js」两条路径行为一致
 * （尤其是安装包的 --setup：不显式调用就会悄悄退化成普通启动，跳过 TailScale 检测）。
 */
export async function runCli(args) {
  if (args.setup) {
    // Inno Setup 安装完成后调用：jican-simulator.exe --setup --server-source|--client
    await runSetup(args.serverSource ? 'server' : 'client', { expose: args.expose, noTailscale: args.noTailscale });
    if (args.keepOpen) await new Promise((ok) => setTimeout(ok, 2000));
    process.exit(0);
  }
  const logger = {
    info: (...m) => console.log(...m),
    warn: (...m) => console.warn(...m),
    error: (...m) => console.error(...m),
  };
  try {
    const srv = await startServer({ port: args.port, host: args.host, logger, isServerSource: args.serverSource ?? undefined, tailscale: !args.noTailscale });
    console.log('');
    console.log('  机惨模拟器已启动');
    console.log(`  → 在浏览器打开 ${srv.url}`);
    console.log(`  AI 增强：${srv.gateway.status().mode === 'llm' ? '已启用' : `未启用（${srv.gateway.status().reason}）`}`);
    console.log(`  联机模式：${srv.isServerSource ? '本机是服务器源（等待其他玩家加入）' : '本机是客户端'}`);
    if (srv.online?.enabled) {
      const ts = srv.tailscale;
      if (ts?.ok) console.log(`  联机地址：${ts.url}（${srv.online.mode === 'funnel' ? 'Funnel 公网' : 'Serve，仅 tailnet 内'}）`);
      else console.log(`  联机地址：尚未就绪（${ts?.message ?? 'TailScale 未启用'}）`);
    }
    console.log(`  ID 密钥：${srv.idKey.slice(0, 16)}…（首次运行生成，存于 data/id.key）`);
    console.log('  按 Ctrl+C 停止服务（会自动保存进行中的对局）');
    console.log('');
    if (args.open) openBrowser(srv.url);
    const stop = async () => {
      console.log('\n[server] 正在保存并退出…');
      await srv.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // 桌面宿主（v0.4）：宿主不靠 stdout 猜状态，统一从数据目录的 server.port 读端口；
    // 托盘「退出」走 POST /api/app/quit，这里挂上同样的优雅关停路径。
    try {
      const { writeFileSync, rmSync } = await import('node:fs');
      writeFileSync(join(dataDir(), 'server.port'), String(srv.port), 'utf8');
      srv.shutdownHooks.push(() => {
        // 先删端口文件，宿主据此判断「服务已停」，避免它去连一个已经死掉的端口
        try { rmSync(join(dataDir(), 'server.port'), { force: true }); } catch { /* 忽略 */ }
        stop();
      });
    } catch (err) {
      logger.warn?.('[server] 写 server.port 失败：' + err.message);
    }
  } catch (err) {
    console.error(`[server] 启动失败：${err.message}`);
    process.exit(1);
  }
}