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

export async function startServer({ rootDir = ROOT, port = null, host = null, logger = console, watch = true, llm = true, saveDir = null } = {}) {
  const config = loadConfig(rootDir, { logger });
  if (!llm) config.llm.enabled = false;
  const bindHost = host ?? config.app.server.host;
  const map = new GameMap(config.mapData, { radius: config.balance.move.radius, gridSize: config.balance.nav.gridSize, lowCoverDepth: config.balance.vision.lowCoverDepth });
  const gateway = new LlmGateway(config.llm, { logger });
  await gateway.init();
  const saves = new SaveManager({ dir: saveDir ?? resolve(rootDir, config.app.save.dir), keepRounds: config.app.save.keepRounds, logger });
  const controller = new GameController({ config, map, saveManager: saves, gateway, logger });
  const stopWatch = watch ? watchBalance(rootDir, (b) => controller.setBalance(b), { logger }) : () => {};

  const http = createServer();
  const actualPort = await listenWithFallback(http, bindHost, port ?? config.app.server.port, config.app.server.portFallbackRange, logger);
  http.on('request', createHttpHandler({ rootDir, controller, map, host: bindHost, debug: config.app.debug?.endpoints, logger }));
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
  return { url, port: actualPort, controller, gateway, config, close };
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
  const out = { open: false, port: null, host: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--open') out.open = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const logger = {
    info: (...m) => console.log(...m),
    warn: (...m) => console.warn(...m),
    error: (...m) => console.error(...m),
  };
  try {
    const srv = await startServer({ port: args.port, host: args.host, logger });
    console.log('');
    console.log('  机惨模拟器已启动');
    console.log(`  → 在浏览器打开 ${srv.url}`);
    console.log(`  AI 增强：${srv.gateway.status().mode === 'llm' ? '已启用' : `未启用（${srv.gateway.status().reason}）`}`);
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
