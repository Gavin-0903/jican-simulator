// 内核启动脚本（**开发期/命令行**用；v0.4 桌面宿主已不再走这条路）。
//
// 注意：桌面宿主 launch.exe 现在直接执行 jican-simulator.exe --serve --data-dir <目录>。
// 原因见 packaging/win/Launch.cs 的注释：node-runtime.exe 是 SEA 单文件，它的 argv[1] 只会
// 被当成业务参数，**脚本路径不会被当脚本执行**，于是「node-runtime.exe launcher.cjs」实际
// 是把 launcher.cjs 当参数丢进内核——进程活着、服务也起着，但这个脚本一行都没跑。
// 保留本文件的作用：命令行手动起服务、以及老版本升级期兼容。
//   node launcher.cjs --spawn-only   ← 只起服务，不开任何窗口
//   node launcher.cjs --debug        ← 调试：继承控制台，日志直接可见
//
// 分工（v0.4 起）：
//   launch.exe（C# WinForms 宿主，GUI 子系统）= 无黑框外壳 + 释放运行时 + 内嵌 WebView2 窗口 + 系统托盘；
//   本脚本 = 业务侧内核：找主程序、防重复启动、起服务、写 server.port、把错误写进日志。
//   **窗口/浏览器一律由宿主负责**，这里绝不再 cmd start，否则会出现「宿主窗口 + 又一个浏览器窗口」双开。
//
// 参数：
//   --spawn-only  只起服务（宿主用；不再打开任何浏览器）
//   --debug       调试模式（主程序保留控制台并打详细日志）
//   --restart     已有实例先结束再重启（升级后用）
//   其它参数（--port / --client 等）原样透传给主程序。

const { spawn, execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');

const argv = process.argv.slice(2);
const debug = argv.includes('--debug') || argv.includes('-debug') || argv.includes('-d');
const restart = argv.includes('--restart');
const spawnOnly = argv.includes('--spawn-only');
const passArgs = argv.filter((a) => a !== '--debug' && a !== '-debug' && a !== '-d' && a !== '--restart' && a !== '--spawn-only');

/** 读 launcher.cfg 里的一个键（宿主写进来的 main= / data=）。 */
function cfgValue(key) {
  try {
    const cfg = readFileSync(join(__dirname, 'launcher.cfg'), 'utf8');
    const m = new RegExp('^' + key + '=(.+)$', 'm').exec(cfg);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * 数据目录（与 server/persistence/paths.js 保持一致）。
 * 优先级：JICAN_DATA_DIR 环境变量 > launcher.cfg 的 data= > %LOCALAPPDATA%\JicanSimulator。
 * 为什么要读 cfg：宿主的 CreateProcess 不能传自定义环境块（ERROR_INVALID_PARAMETER），
 * 所以「宿主用的是哪个数据目录」只能经这个文件同步过来；否则会出现服务端写 <exe目录>/data、
 * 宿主却去 %LOCALAPPDATA% 读 server.port 的分叉，表现为「服务启动超时」。
 */
function dataDir() {
  if (process.env.JICAN_DATA_DIR) return process.env.JICAN_DATA_DIR;
  const fromCfg = cfgValue('data');
  if (fromCfg) return fromCfg;
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'JicanSimulator');
  if (process.env.APPDATA) return join(process.env.APPDATA, 'JicanSimulator');
  return join(homedir(), '.jican-simulator');
}

/**
 * 主程序位置。宿主会写 launcher.cfg（main=<exe 路径>）告诉我们，
 * 同时兜住「直接 node launcher.cjs」的开发期情形（脚本在仓库 packaging/ 下）。
 */
function findMain() {
  const cands = [];
  if (process.env.JICAN_MAIN_EXE) cands.push(process.env.JICAN_MAIN_EXE);
  const here = __dirname;
  const fromCfg = cfgValue('main');
  if (fromCfg) cands.push(fromCfg);
  cands.push(join(here, 'jican-simulator.exe'));
  cands.push(join(here, '..', '..', 'jican-simulator.exe')); // runtime/rt-xxx/ → 往上两级
  cands.push(join(here, '..', 'dist', 'win10-full', 'jican-simulator.exe'));
  for (const c of cands) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* 忽略 */
    }
  }
  return cands[cands.length - 1];
}

const DATA = dataDir();
const MAIN = findMain();
const PORT_FILE = join(DATA, 'server.port');
const LOCK_FILE = join(DATA, 'server.lock');
const LOG_FILE = join(DATA, 'logs', 'server.log');

/** 正常模式下 stdout/stderr 都被丢弃，所以错误必须落盘；宿主会把日志尾巴放进错误弹窗。 */
function bail(text, code = 1) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    writeFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + text + '\n', 'utf8');
  } catch {
    /* 忽略 */
  }
  try {
    process.stderr.write(text + '\n');
  } catch {
    /* 忽略 */
  }
  process.exit(code);
}

/** 只在「没有宿主」的开发期用（宿主存在时 --spawn-only 会跳过所有开窗逻辑）。 */
function openBrowser(url) {
  if (spawnOnly) return;
  try {
    const p = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true, detached: true });
    p.unref();
  } catch {
    /* 打不开就算了，日志里有地址 */
  }
}

/**
 * 判断锁文件里的 PID 是否还是「我们自己」的进程。
 * 注意不能用 tasklist：PID 会被系统复用，锁文件留在盘上几小时后，某个毫不相干的进程
 * 正好拿到同一个 PID，这里就会误判「已有实例在运行」→ 直接 exit(0) → 服务永远起不来，
 * 宿主只能干等到超时（表现为「服务启动超时」但日志一片空白，极难查）。
 * 改成问系统这个 PID 的可执行文件名是否就是主程序（不依赖额外命令行工具）。
 */
function alive(pid) {
  if (!pid) return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    // CSV 形如 "jican-simulator.exe","1234","Console","1","88,000 K"
    const m = /^"([^"]+)"/.exec(out.trim());
    if (!m) return false;
    return /jican-simulator/i.test(m[1]);
  } catch {
    return false;
  }
}

function readPort() {
  try {
    const n = Number(readFileSync(PORT_FILE, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

if (!existsSync(MAIN)) bail('找不到主程序：\n' + MAIN + '\n\n请重新安装，或把 jican-simulator-launcher.exe 与 jican-simulator.exe 放在同一目录。');

// ---- 已有实例：宿主已经在起服务，这里直接退出；--restart 才杀掉重来
try {
  const prev = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
  if (prev && alive(prev.pid)) {
    if (!restart) {
      if (debug) process.stderr.write('[launcher] 已有实例在运行（PID ' + prev.pid + '，端口 ' + readPort() + '）\n');
      process.exit(0);
    }
    try {
      execFileSync('taskkill', ['/PID', String(prev.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      /* 杀不掉就继续 */
    }
    try {
      rmSync(LOCK_FILE, { force: true });
    } catch {
      /* 忽略 */
    }
  }
} catch {
  /* 没有锁文件 = 没在跑 */
}

// ---- 拉起主程序。--serve：启动服务端；--debug：主程序保留控制台并打详细日志。
const childArgs = ['--serve', ...(debug ? ['--debug'] : []), ...passArgs];
const child = spawn(MAIN, childArgs, {
  cwd: dirname(MAIN),
  env: { ...process.env, JICAN_DATA_DIR: DATA },
  stdio: debug ? 'inherit' : 'ignore',
  windowsHide: !debug,
});

try {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: child.pid, at: Date.now(), debug }), 'utf8');
} catch {
  /* 忽略 */
}

child.on('error', (err) => bail('启动失败：' + err.message + (err.code ? '（' + err.code + '）' : '')));

// 宿主模式下 stdout/stderr 全被丢弃，看不到任何东西。所以每一步都落盘，出问题才有据可查。
try {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  writeFileSync(LOG_FILE, '[' + new Date().toISOString() + '] 已拉起主程序 PID ' + child.pid
    + '  main=' + MAIN + '  data=' + DATA + '  args=' + childArgs.join(' ') + '\n', { encoding: 'utf8', flag: 'a' });
} catch {
  /* 忽略 */
}

child.on('exit', (code, signal) => {
  if (debug) process.stderr.write('[launcher] 主程序退出 code=' + code + ' signal=' + signal + '\n');
  try {
    rmSync(LOCK_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
  try {
    rmSync(PORT_FILE, { force: true });
  } catch {
    /* 忽略 */
  }
  if (code && code !== 0) {
    let tail = '';
    try {
      tail = readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).slice(-15).join('\n');
    } catch {
      /* 没有日志 */
    }
    bail('主程序异常退出（代码 ' + code + '）。日志：' + LOG_FILE + '\n\n' + tail, code);
  }
  process.exit(0);
});

// 开发期兜底：没有宿主时（直接 node launcher.cjs）等服务起来后开一次浏览器。
// 宿主模式下 --spawn-only 已经让 openBrowser 变成空操作，不会出现双开。
if (!debug && !spawnOnly) {
  const started = Date.now();
  const timer = setInterval(() => {
    const port = readPort();
    if (port) {
      clearInterval(timer);
      if (!process.env.JICAN_NO_BROWSER) openBrowser('http://127.0.0.1:' + port + '/');
    } else if (Date.now() - started > 20000) {
      clearInterval(timer);
    }
  }, 300);
  if (timer.unref) timer.unref();
}
