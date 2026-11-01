#!/usr/bin/env node
// 单文件打包：把 node.exe + server/client/shared/config 一起塞进一个可执行文件（Node SEA），
// 产物 dist/<flavor>/机惨模拟器-<变体>-v<版本>-setup-<日期>.exe，双击即启动自带服务并打开窗口。
//
// 用法：
//   node packaging/build.mjs --flavor win10-full --variant 10 --version 0.2beta
//   node packaging/build.mjs --flavor win7-compat --variant 7  --version 0.1dev
//
// 设计取舍：
//  - 玩家机器不一定有 Node.js，所以运行时必须内嵌（SEA），不能再依赖 npm install。
//  - 资源（server/client/shared/config）以 base64 内嵌进 blob，运行期由 app/seaAssets.js
//    首次启动时展开到 <exe目录>/data/unpacked/ 再按普通文件托管；不写注册表、不需要管理员。
//  - 注入用 postject：npm i -D postject 后可用；没有装就跳过注入并提示。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const flavor = arg('flavor', 'win10-full');
const isWin7 = flavor === 'win7-compat';
const variant = arg('variant', isWin7 ? '7' : '10');
const version = arg('version', isWin7 ? '0.1dev' : '0.2beta');
const stamp = arg('stamp', isWin7 ? '1031' : '1031');
const productName = isWin7 ? '机惨模拟器-Win7兼容' : '机惨模拟器-Win10满血';
// 可执行文件统一叫 jican-simulator.exe（用户要求）；变体名只体现在安装包文件名与安装目录上，
// 这样两个 flavor 的 exe 名称一致，快捷方式/任务管理器里看到的名字也一致。
const EXE_BASENAME = 'jican-simulator';
const exeName = EXE_BASENAME;
const appId = isWin7 ? '{{7A5B2C10-3E44-4B7E-9F11-91C0DA7A1007}}' : '{{7A5B2C10-3E44-4B7E-9F11-91C0DA7A1010}}';

const JSON_OUT = arg('out', join(ROOT, 'dist', flavor));
rmSync(JSON_OUT, { recursive: true, force: true });
mkdirSync(JSON_OUT, { recursive: true });

/** 需要内嵌的目录（相对仓库根）。data/ 是运行期产物，不打包。 */
const INCLUDE_DIRS = ['server', 'client', 'shared', 'config', 'app'];
/** 运行期必装的第三方包（唯一生产依赖 ws）：SEA 没有 npm install，必须把包体一起内嵌。 */
const INCLUDE_PKGS = ['ws'];
const INCLUDE_FILES = ['package.json', 'LICENSE', 'README.md'];
const SKIP_TOP = new Set(['node_modules', 'data', '.git', 'dist', 'build', 'packaging', 'tests']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_TOP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}

function walkPkg(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkPkg(full, out);
    else out.push(relative(ROOT, full).split(sep).join('/'));
  }
  // ws 的可选原生依赖（bufferutil / utf-8-validate）存在时一并带上，运行时按需加载。
  const nested = join(dir, 'node_modules');
  if (existsSync(nested)) walkPkg(nested, out);
}

const files = [];
for (const d of INCLUDE_DIRS) if (existsSync(join(ROOT, d))) walk(join(ROOT, d), files);
for (const f of INCLUDE_FILES) if (existsSync(join(ROOT, f))) files.push(f);
// node_modules 下的生产依赖：只挑 INCLUDE_PKGS 及传递依赖，避免整个 node_modules 进产物。
for (const pkg of INCLUDE_PKGS) {
  const base = join(ROOT, 'node_modules', pkg);
  if (!existsSync(base)) {
    console.warn('[build] 缺少依赖 node_modules/' + pkg + '（先 npm install），打包会失败');
    continue;
  }
  walkPkg(base, files);
}

const assets = {};
// bundleStamp：全部资源内容的 sha256 前 16 位。SEA 展开目录用它做版本后缀，
// 否则「已存在就跳过」会让升级后的新 exe 继续跑上次展开的旧代码（v0.4 的真实事故）。
const bundleHash = createHash('sha256');
for (const rel of files) {
  const bytes = readFileSync(join(ROOT, rel));
  bundleHash.update(rel);
  bundleHash.update(bytes);
  assets[rel] = bytes.toString('base64');
}
const bundleStamp = bundleHash.digest('hex').slice(0, 16);
// manifest 里显式写明安装包名，供 .iss 生成时的 [Run]/快捷方式引用
const setupName = `${productName}-v${version}-setup-${stamp}`;
const manifest = { flavor, variant, version, exeName, setupName, productName, appId, builtAt: new Date().toISOString(), files: files.length, bundleStamp };
writeFileSync(join(JSON_OUT, 'assets.json'), JSON.stringify({ manifest, assets }));
console.log(`[build] 收集 ${files.length} 个文件 → ${join('dist', flavor, 'assets.json')}`);

// Node SEA：assets 里放 manifest + 一个 JSON 索引（blob 里的 assets 必须是小文件，主体走外部索引）
writeFileSync(join(JSON_OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(join(JSON_OUT, 'bundle.b64'), Buffer.from(JSON.stringify({ manifest, assets }), 'utf8').toString('base64'));
const seaConfig = join(JSON_OUT, 'sea-config.json');
writeFileSync(seaConfig, JSON.stringify({
  main: join(ROOT, 'packaging', 'sea-entry.cjs'),
  output: join(JSON_OUT, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  // SEA 的 assets 只能是「文件」；资源主体（server/client/... 共 100+ 个文件）
  // 全部序列化成一个 base64 JSON，作为单个 asset 塞进来，启动时由 sea-entry.cjs 展开。
  assets: {
    'app/manifest.json': join(JSON_OUT, 'manifest.json'),
    'app/bundle.b64': join(JSON_OUT, 'bundle.b64'),
  },
}, null, 2));

console.log('[build] 生成 SEA blob…');
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit', cwd: ROOT });

const exePath = join(JSON_OUT, `${exeName}.exe`);
copyFileSync(process.execPath, exePath);
const postject = join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
if (existsSync(postject)) {
  console.log('[build] postject 注入 SEA blob…');
  execFileSync(process.execPath, [postject, exePath, 'NODE_SEA_BLOB', join(JSON_OUT, 'sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit' });
  console.log(`[build] 注入完成：${exePath} (${(statSync(exePath).size / 1048576).toFixed(1)} MB)`);
} else {
  console.warn('[build] 未安装 postject，跳过注入（npm i -D postject 后重跑）');
}

// 图标与版本信息：postject 只改 blob 段，图标/版本要单独写入资源节。
// IconRes.exe 由本脚本按需从 packaging/win/IconRes.cs 编译（.NET Framework 自带的 csc）。
const iconSrc = join(ROOT, 'packaging', 'win', 'IconRes.cs');
const iconExe = join(ROOT, 'packaging', 'win', 'bin', 'IconRes.exe');
const iconIco = join(ROOT, 'packaging', 'icons', 'jican-simulator.ico');
const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
function ensureIconTool() {
  if (!existsSync(iconSrc) || !existsSync(iconIco)) {
    console.warn('[build] 缺少图标源文件，跳过图标注入');
    return false;
  }
  const needCompile = !existsSync(iconExe) || statSync(iconSrc).mtimeMs > statSync(iconExe).mtimeMs;
  if (needCompile) {
    if (!existsSync(csc)) {
      console.warn('[build] 找不到 csc.exe，跳过图标注入');
      return false;
    }
    mkdirSync(dirname(iconExe), { recursive: true });
    console.log('[build] 编译图标注入器 IconRes.exe…');
    execFileSync(csc, ['/nologo', '/target:exe', `/out:${iconExe}`, iconSrc], { stdio: 'inherit' });
  }
  return true;
}
if (existsSync(exePath) && ensureIconTool()) {
  // VS 数值版本取 semver 数值前缀（0.2beta → 0.2.0.0），字符串版本保留原样
  const verText = version.replace(/[^0-9.]/g, '') || '0.0.0';
  execFileSync(iconExe, [exePath, iconIco, verText], { stdio: 'inherit' });
  console.log(`[build] 图标与版本信息已写入（${verText}）`);
}
if (existsSync(exePath)) {
  console.log(`[build] 产物：${exePath} (${(statSync(exePath).size / 1048576).toFixed(1)} MB)`);
}

// ---- launch.exe：无黑框启动外壳（GUI 子系统的 C# 外壳 + 内嵌 node 运行时 + launcher.cjs）
// 玩家双击的是 launch.exe；jican-simulator.exe 是它拉起来的真正服务端（控制台程序，正常模式下隐藏窗口）。
// 为什么要这一层：Node SEA 产物必然是控制台程序，双击必弹黑框，关掉黑框服务就停；
// Windows 不允许一个进程既是 GUI 又是控制台，所以拆成「GUI 外壳 + 无窗口子进程」。
const launchSrc = join(ROOT, 'packaging', 'win', 'Launch.cs');
const launchGenSrc = join(ROOT, 'packaging', 'win', 'LaunchGen.cs');
const binDir = join(ROOT, 'packaging', 'win', 'bin');
const launchStub = join(binDir, 'Launch.exe');
const launchGen = join(binDir, 'LaunchGen.exe');
const launcherJs = join(ROOT, 'packaging', 'launcher.cjs');
const launchExe = join(JSON_OUT, EXE_BASENAME + '-launcher.exe');

function ensureLaunchTools() {
  if (!existsSync(launchSrc) || !existsSync(launchGenSrc) || !existsSync(launcherJs)) {
    console.warn('[build] 缺少启动器源码，跳过 launch.exe 生成');
    return false;
  }
  if (!existsSync(csc)) {
    console.warn('[build] 找不到 csc.exe，跳过 launch.exe 生成');
    return false;
  }
  mkdirSync(binDir, { recursive: true });
  // 外壳依赖：压缩库（解 RCDATA/2 的 zip）+ WinForms/System.Drawing（窗口与托盘）+ WebView2 托管程序集。
  const refs = ['/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll'];
  // WebView2 托管 DLL 随仓库分发（packaging/win/lib），缺了会 CS0234，必须显式引用。
  const wv2Core = join(ROOT, 'packaging', 'win', 'lib', 'Microsoft.Web.WebView2.Core.dll');
  const wv2Forms = join(ROOT, 'packaging', 'win', 'lib', 'Microsoft.Web.WebView2.WinForms.dll');
  const winRefs = [
    '/reference:' + wv2Core,
    '/reference:' + wv2Forms,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Net.dll',
  ];
  const stale = (src, out) => !existsSync(out) || statSync(src).mtimeMs > statSync(out).mtimeMs;
  ensureIconTool(); // LaunchGen 引用 IconRes.exe，必须先编译出来
  // WebView2 托管 dll 必须与 Launch.exe 同目录：csc 只把程序集引用写进元数据，
  // 运行期由 CLR 按「应用基目录 + PATH」去找文件。少了这两个 dll，双击直接
  // FileNotFoundException: Microsoft.Web.WebView2.Core。所以编译完就把它们拷到外壳旁边。
  const stageWv2 = (destDir) => {
    mkdirSync(destDir, { recursive: true });
    for (const f of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll']) {
      const src = join(ROOT, 'packaging', 'win', 'lib', f);
      if (existsSync(src)) copyFileSync(src, join(destDir, f));
    }
    // 原生加载器：Launch.cs 先找 runtimes\win-x64\native\，找不到再找 exe 同级。
    const nativeSrc = join(ROOT, 'packaging', 'win', 'lib', 'runtimes', 'win-x64', 'native', 'WebView2Loader.dll');
    if (existsSync(nativeSrc)) {
      const nd = join(destDir, 'runtimes', 'win-x64', 'native');
      mkdirSync(nd, { recursive: true });
      copyFileSync(nativeSrc, join(nd, 'WebView2Loader.dll'));
      copyFileSync(nativeSrc, join(destDir, 'WebView2Loader.dll'));
    }
  };
  if (stale(launchSrc, launchStub) || stale(wv2Core, launchStub)) {
    console.log('[build] 编译 GUI 外壳 Launch.exe…');
    // 必须 /target:winexe（Subsystem=2），否则双击仍然弹黑框
    execFileSync(csc, ['/nologo', '/target:winexe', '/out:' + launchStub, ...refs, ...winRefs, launchSrc], { stdio: 'inherit' });
  }
  stageWv2(binDir);
  stageWv2(JSON_OUT);
  if (stale(launchGenSrc, launchGen) || stale(launchSrc, launchGen)) {
    console.log('[build] 编译外壳生成器 LaunchGen.exe…');
    execFileSync(csc, ['/nologo', '/target:exe', '/out:' + launchGen, '/reference:' + iconExe, ...refs, launchGenSrc], { stdio: 'inherit' });
  }
  return true;
}

let launcherExe = null;
if (existsSync(exePath) && ensureLaunchTools()) {
  console.log('[build] 生成 launch.exe（内嵌运行时 + 启动脚本）…');
  const lver = version.replace(/[^0-9.]/g, '') || '0.0.0';
  execFileSync(launchGen, [launchExe, exePath, launcherJs, iconIco, lver], { stdio: 'inherit' });
  if (existsSync(launchExe)) {
    launcherExe = launchExe;
    console.log('[build] 启动器：' + launchExe + ' (' + (statSync(launchExe).size / 1048576).toFixed(1) + ' MB)');
  }
}
writeFileSync(join(JSON_OUT, 'build-info.json'), JSON.stringify({ ...manifest, exe: exePath, launcher: launcherExe, setupName, stamp }, null, 2));
