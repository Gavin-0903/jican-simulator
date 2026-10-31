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

/** 把 app/bundle.b64 里的 base64 载荷全部写盘（已存在则跳过）。 */
function unpackTo(dir) {
  if (!bundled) return { dir, files: 0 };
  const raw = asset('app/bundle.b64');
  console.log('[启动] bundle.b64 长度=' + (raw ? raw.length : 'null'));
  if (!raw) return { dir, files: 0 };
  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return { dir, files: 0 };
  }
  let files = 0;
  for (const [rel, b64] of Object.entries(payload.assets || {})) {
    const target = join(dir, rel);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(b64, 'base64'));
    files += 1;
  }
  return { dir, files };
}

// ---------------------------------------------------------------- 启动
const exeDir = dirname(process.execPath);
const devRoot = resolve(__dirname, '..');
let rootDir = devRoot;
if (bundled) {
  const unpacked = join(exeDir, 'data', 'unpacked');
  const { files } = unpackTo(unpacked);
  console.log('[启动] isSea=' + bundled + ' 展开 ' + files + ' 个资源文件到 ' + unpacked);
  rootDir = unpacked;
}

const args = process.argv.slice(2);
const setupMode = args.includes('--setup');

async function main() {
  const entry = join(rootDir, 'server', 'index.js');
  if (!existsSync(entry)) {
    console.error('找不到游戏资源：' + entry);
    console.error('请重新安装，或把本程序放回安装目录后运行。');
    process.exitCode = 1;
    return;
  }
  const { startServer, openBrowser } = await import(pathToFileURL(entry).href);
  // --setup 交给 server/index.js 自己处理（询问是否设为服务器源），处理完即退出
  const srv = await startServer({ rootDir, llm: true, logger: console });
  const manifest = bundleManifest();
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
