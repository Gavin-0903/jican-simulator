#!/usr/bin/env node
// 入口：加载配置 → 地图 → LLM 网关（可选）→ 游戏控制器 → HTTP + WebSocket（同端口）。
// 用法：node server/index.js [--port 5173] [--host 127.0.0.1] [--open]

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
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
import { applySetup, readSettings, writeSettings } from './persistence/AppSettings.js';

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
  const saves = new SaveManager({ dir: saveDir ?? resolve(rootDir, config.app.save.dir), keepRounds: config.app.save.keepRounds, logger });
  const controller = new GameController({ config, map, saveManager: saves, gateway, logger });

  // 联机（需求 3）：本机 ID 密钥 + 房间表；只有「服务器源」实例才挂载大厅路由。
  const idKey = loadOrCreateIdKey(rootDir, { logger });
  const rooms = new RoomManager({ logger });
  const settings = readSettings(rootDir);
  const isServerSource = Boolean(opts.isServerSource ?? settings.isServerSource);
  if (isServerSource && config.app.server.host === '127.0.0.1' && !host) config.app.server.host = '0.0.0.0';
  // 大厅路由总是挂载：非服务器源实例也提供 /api/net/info & /api/net/join 作为「联机客户端」，
  // 由请求里的服务器源 URL 决定真正打到哪台机器（跨域已放开）。isServerSource 只影响是否对外监听。
  const lobbyRouter = createLobbyRouter({ rooms, idKey: idKey.key, serverName: config.app.server.name ?? '服务器源', logger, isServerSource });
  const stopWatch = watch ? watchBalance(rootDir, (b) => controller.setBalance(b), { logger }) : () => {};

  const http = createServer();
  const actualPort = await listenWithFallback(http, bindHost, port ?? config.app.server.port, config.app.server.portFallbackRange, logger);
  http.on('request', createHttpHandler({ rootDir, controller, map, host: bindHost, debug: config.app.debug?.endpoints, logger, lobbyRouter, idKey: idKey.key, isServerSource }));
  const ws = new WsServer({ httpServer: http, controller, app: config.app, port: actualPort, host: bindHost, logger });
  const shownHost = bindHost === '0.0.0.0' || bindHost === '::' ? 'localhost' : bindHost;
  const url = `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${actualPort}`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    stopWatch();
    ws.close();
    gateway.close();
    await controller.close();
    await new Promise((ok) => http.close(() => ok()));
  };
  return { url, port: actualPort, controller, gateway, config, close, idKey: idKey.key, idKeyCreated: idKey.created, rooms, isServerSource, settings };
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
  const out = { open: false, port: null, host: null, setup: false, serverSource: null, keepOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--open') out.open = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--setup') out.setup = true;
    else if (a === '--server-source') out.serverSource = true;
    else if (a === '--client') out.serverSource = false;
    else if (a === '--keep-open') out.keepOpen = true;
  }
  return out;
}

/** 安装包首次运行时调用：写入安装标记与「是否设为服务器源」，不启动服务。 */
async function runSetup(mode) {
  const settings = applySetup(ROOT, { isServerSource: mode === 'server' });
  console.log('');
  console.log(settings.isServerSource ? '  已设为联机服务器源：其他玩家可以通过 TailScale Funnel 地址加入你的房间。' : '  已设为联机客户端：联机时请填写服务器源地址与 Token。');
  console.log(`  设置已写入 ${resolve(ROOT, 'data', 'settings.json')}`);
  console.log('');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.setup) {
    // Inno Setup 安装完成后调用：机器惨模拟器-setup.exe --setup --server-source|--client
    await runSetup(args.serverSource ? 'server' : 'client');
    if (args.keepOpen) await new Promise((ok) => setTimeout(ok, 2000));
    process.exit(0);
  }
  const logger = {
    info: (...m) => console.log(...m),
    warn: (...m) => console.warn(...m),
    error: (...m) => console.error(...m),
  };
  try {
    const srv = await startServer({ port: args.port, host: args.host, logger, isServerSource: args.serverSource ?? readSettings(ROOT).isServerSource });
    console.log('');
    console.log('  机惨模拟器已启动');
    console.log(`  → 在浏览器打开 ${srv.url}`);
    console.log(`  AI 增强：${srv.gateway.status().mode === 'llm' ? '已启用' : `未启用（${srv.gateway.status().reason}）`}`);
    console.log(`  联机模式：${srv.isServerSource ? '本机是服务器源（等待其他玩家加入）' : '本机是客户端'}`);
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
  } catch (err) {
    console.error(`[server] 启动失败：${err.message}`);
    process.exit(1);
  }
}

export { ROOT };