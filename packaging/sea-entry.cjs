// 单文件应用入口（SEA main，CommonJS）。
// SEA 的三条限制决定了本文件的形态：
//  1) main 按 CJS 加载 —— 不能写顶层 import/await；
//  2) 运行期没有「文件系统里的模块」—— require('./x.cjs') 会报 ERR_UNKNOWN_BUILTIN_MODULE，
//     所以资源读取逻辑必须内联在本文件（app/seaAssets.js 只是同构的 ESM 版本，供开发期引用）；
//  3) 内嵌资源 = 打包时生成的一个 base64 JSON（app/bundle.b64），Key 是资源相对路径。
//     启动时一次性展开到 <exe目录>/data/unpacked/，之后服务端按普通文件读，逻辑与开发期完全一致。

const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

let sea = null;
try {
  sea = require('node:sea');
} catch {
  sea = null;
}
const bundled = Boolean(sea && typeof sea.isSea === 'function' && sea.isSea() && typeof sea.getAsset === 'function');

/** 读一个内嵌资源（字符串）；不存在返回 null。 */
function asset(key) {
  if (!bundled) return null;
  try {
    // 不给 encoding 时 getAsset 返回 ArrayBuffer，必须显式转成 utf8 字符串
    return Buffer.from(sea.getAsset(String(key).replace(/^\/+/, ''))).toString('utf8');
  } catch {
    return null;
  }
}

function bundleManifest() {
  const raw = asset('app/manifest.json');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 资源版本号：优先用 bundle 自带的内容哈希，没有再退回「文件数 + 大小」。
 * 展开目录名必须带上它——旧版按「已存在就跳过」的逻辑会在升级后继续复用旧代码，
 * 结果是服务端跑着上一个版本、宿主却在等新端点（v0.4 踩过的真实事故）。
 */
function bundleTag(payload) {
  try {
    const m = payload && payload.manifest;
    if (m && typeof m.bundleStamp === 'string' && m.bundleStamp) return m.bundleStamp.slice(0, 16);
  } catch {
    /* 忽略 */
  }
  const keys = Object.keys((payload && payload.assets) || {});
  return 'n' + keys.length;
}

/** 把 app/bundle.b64 里的 base64 载荷全部写盘。目录已存在则跳过（版本号已隔离新旧内容）。 */
function unpackTo(dir) {
  if (!bundled) return { dir, files: 0, tag: null };
  const raw = asset('app/bundle.b64');
  console.log('[启动] bundle.b64 长度=' + (raw ? raw.length : 'null'));
  if (!raw) return { dir, files: 0, tag: null };
  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return { dir, files: 0, tag: null };
  }
  const tag = bundleTag(payload);
  const versioned = dir + '-' + tag;
  let files = 0;
  for (const [rel, b64] of Object.entries(payload.assets || {})) {
    const target = join(versioned, rel);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(b64, 'base64'));
    files += 1;
  }
  return { dir: versioned, files, tag };
}

// ---------------------------------------------------------------- 启动
// 自动更新：构建清单里带 version/flavor/setupName。服务端（ESM）读不到 node:sea，
// 这里把清单挂到 globalThis 并落到解包根目录，server/net/Updater.js 直接按普通文件读。
const manifest = bundleManifest();
if (manifest) globalThis.__JICAN_APP_MANIFEST__ = manifest;
const exeDir = dirname(process.execPath);
const devRoot = resolve(__dirname, '..');
let rootDir = devRoot;
if (bundled) {
  const unpacked = join(exeDir, 'data', 'unpacked');
  const res = unpackTo(unpacked);
  console.log('[启动] isSea=' + bundled + ' 展开 ' + res.files + ' 个资源文件到 ' + res.dir);
  rootDir = res.dir;
  if (manifest) {
    try {
      writeFileSync(join(rootDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    } catch {
      /* 只影响自动更新的版本号来源，不阻塞启动 */
    }
  }
}
// 运行期数据（config.json / settings.json / id.key / 存档）。
// 优先级：环境变量 JICAN_DATA_DIR > <exe目录>/data。
// 为什么先看环境变量：桌面宿主（launch.exe）把数据目录定在 %LOCALAPPDATA%\JicanSimulator，
// 经 launcher.cfg 交给 launcher.cjs、再经子进程环境变量传到这里；如果这里无条件覆盖成
// <exe目录>/data，宿主去 %LOCALAPPDATA% 读 server.port 就永远读不到，表现为「服务启动超时」。
// 不设环境变量时（命令行直接双击 exe）仍然退回 <exe目录>/data，保持便携版语义。
// 宿主（launch.exe）用 --data-dir 显式传数据目录：CreateProcess 不能传自定义环境块，
// 环境变量这条路在桌面宿主下根本走不通（子进程只看到自己继承的那份 env）。
function argDataDir(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--data-dir') return argv[i + 1] || '';
    if (argv[i].startsWith('--data-dir=')) return argv[i].slice('--data-dir='.length);
  }
  return '';
}
const rawArgv = process.argv.slice(2);
globalThis.__JICAN_DATA_DIR__ = argDataDir(rawArgv) || process.env.JICAN_DATA_DIR || join(exeDir, 'data');
mkdirSync(globalThis.__JICAN_DATA_DIR__, { recursive: true });
console.log('[启动] 数据目录=' + globalThis.__JICAN_DATA_DIR__);

const args = rawArgv;
const setupMode = args.includes('--setup');

/**
 * 把 exe 的命令行转成 server/index.js 的 runCli 参数。
 * SEA 里 process.argv[1] 是 exe 路径，server/index.js 自己的 isMain 判定不成立，
 * 所以这里必须显式把命令行交给 runCli，否则 --setup / --port 之类的参数会被静默忽略。
 */
function cliArgs(argv) {
  const out = { open: false, port: null, host: null, setup: false, serverSource: null, keepOpen: false, expose: null, noTailscale: false, serve: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--open') out.open = true;
    else if (a === '--port') out.port = Number(argv[(i += 1)]);
    else if (a === '--host') out.host = argv[(i += 1)];
    else if (a === '--setup') out.setup = true;
    else if (a === '--server-source') out.serverSource = true;
    else if (a === '--client') out.serverSource = false;
    else if (a === '--keep-open') out.keepOpen = true;
    else if (a === '--expose') out.expose = argv[(i += 1)] === 'funnel' ? 'funnel' : 'serve';
    else if (a === '--no-tailscale') out.noTailscale = true;
    else if (a === '--serve' || a === '--spawn-only') out.serve = true;
    else if (a === '--data-dir') i += 1;
  }
  return out;
}

async function main() {
  const entry = join(rootDir, 'server', 'index.js');
  if (!existsSync(entry)) {
    console.error('找不到游戏资源：' + entry);
    console.error('请重新安装，或把本程序放回安装目录后运行。');
    process.exitCode = 1;
    return;
  }
  const mod = await import(pathToFileURL(entry).href);
  const { startServer, openBrowser, runCli } = mod;
  if (typeof runCli === 'function') {
    // 安装包首次运行：--setup 由 runCli 处理（TailScale 检测 + 写 config.json + 暴露端口），处理完即退出
    await runCli(cliArgs(args));
    return;
  }
  const srv = await startServer({ rootDir, llm: true, logger: console });
  const manifest = globalThis.__JICAN_APP_MANIFEST__ || bundleManifest();
  console.log('');
  console.log('  ' + (manifest ? manifest.productName : '机惨模拟器') + ' v' + (manifest ? manifest.version : ''));
  console.log('  → 在浏览器打开 ' + srv.url);
  console.log('  关闭本窗口即停止游戏');
  console.log('');
  if (!setupMode) openBrowser(srv.url);
  const stop = () => {
    Promise.resolve(srv.close()).finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (setupMode) stop();
}

main().catch((err) => {
  console.error('启动失败：' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
