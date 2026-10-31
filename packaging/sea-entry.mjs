// 单文件应用的入口（SEA main）。打包后的 exe 双击运行到这里：
// 1) 把内嵌资源展开到 exe 同级的 data/unpacked/（只写一次，之后复用）；
// 2) 以该目录作为 rootDir 启动服务端，并打开浏览器应用窗口。

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isBundled, unpackTo, bundleManifest } from '../app/seaAssets.js';

const exeDir = dirname(process.execPath);
const rootDir = isBundled() ? unpackTo(join(exeDir, 'data', 'unpacked')) : resolve(dirname(new URL(import.meta.url).pathname), '..');

const args = process.argv.slice(2);
const keepOpen = args.includes('--keep-open');

async function main() {
  const { startServer, openBrowser } = await import(join(rootDir, 'server', 'index.js'));
  const manifest = bundleManifest();
  const srv = await startServer({ rootDir, llm: true, logger: console });
  console.log('');
  console.log(`  ${manifest?.productName ?? '机惨模拟器'} v${manifest?.version ?? ''}`);
  console.log(`  → 在浏览器打开 ${srv.url}`);
  console.log('  关闭本窗口即停止游戏');
  console.log('');
  openBrowser(srv.url);
  const stop = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (keepOpen) return;
}

main().catch((err) => {
  console.error(`启动失败：${err.message}`);
  if (!existsSync(join(exeDir, 'data'))) console.error('提示：请把 exe 放在可写目录下（不要放在 Program Files 根目录）。');
  process.exitCode = 1;
});
