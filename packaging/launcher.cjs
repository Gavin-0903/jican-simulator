// launch.exe 启动脚本（打包后由内嵌的 node 运行时执行：
//   node-runtime.exe launcher.cjs --debug     ← 调试：继承控制台，日志直接可见
//   node-runtime.exe launcher.cjs             ← 正常：无窗口启动 jican-simulator.exe --serve
// ）
//
// 分工：
//   launch.exe（C#，GUI 子系统）只负责「不弹黑框」+ 释放运行时；
//   本脚本负责业务侧：找主程序、防重复启动、等端口、开浏览器、把错误写进日志。
//
// 参数：
//   --debug     调试模式（配合 jican-simulator.exe：黑窗口 + 详细日志）
//   --restart   已有实例先结束再重启（升级后用；普通双击是「已在跑就只开网页」）
//   其它参数（--port / --client 等）原样透传给主程序。

const { spawn, execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');

const argv = process.argv.slice(2);
const debug = argv.includes('--debug') || argv.includes('-debug') || argv.includes('-d');
const restart = argv.includes('--restart');
const passArgs = argv.filter((a) => a !== '--debug' && a !== '-debug' && a !== '-d' && a !== '--restart');

/** 数据目录（与 server/persistence/paths.js 保持一致）。 */
function dataDir() {
  if (process.env.JICAN_DATA_DIR) return process.env.JICAN_DATA_DIR;
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'JicanSimulator');
  if (process.env.APPDATA) return join(process.env.APPDATA, 'JicanSimulator');
  return join(homedir(), '.jican-simulator');
}

/**
 * 主程序位置。launch.exe 会用 JICAN_MAIN_EXE 告诉我们，
 * 它也兜住「直接 node launcher.cjs」的开发期情形（脚本在仓库 packaging/ 下）。
 */
function findMain() {
  const cands = [];
  if (process.env.JICAN_MAIN_EXE) cands.push(process.env.JICAN_MAIN_EXE);
  const here = __dirname;
  // launch.exe 释放运行时顺手写了 launcher.cfg（main=<exe 路径>），比环境变量可靠
  try {
    const cfg = readFileSync(join(here, 'launcher.cfg'), 'utf8');
    const m = /^main=(.+)$/m.exec(cfg);
    if (m) cands.push(m[1].trim());
  } catch {
    /* 没有 cfg 就靠下面的候选 */
  }
  cands.push(join(here, 'jican-simulator.exe'));
  cands.push(join(here, '..', '..', 'jican-simulator.exe'));   // runtime/rt-xxx/ → 往上两级
  cands.push(join(here, '..', 'dist', 'win10-full', 'jican-simulator.exe'));
  for (const c of cands) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* 忽略 */
    }
  }
  return cands[1];
}

const DATA = dataDir();
const MAIN = findMain();
const PORT_FILE = join(DATA, 'server.port');
const LOCK_FILE = join(DATA, 'server.lock');
const LOG_FILE = join(DATA, 'logs', 'server.log');

/** 正常模式下 stdout/stderr 都被丢弃，所以错误必须落盘；launch.exe 会把日志尾巴弹窗。 */
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

function openBrowser(url) {
  try {
    const p = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true, detached: true });
    p.unref();
  } catch {
    /* 打不开就算了，日志里有地址 */
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    return execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'], { windowsHide: true, encoding: 'utf8' }).includes(String(pid));
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

if (!existsSync(MAIN)) bail('找不到主程序：\n' + MAIN + '\n\n请重新安装，或把 launch.exe 与 jican-simulator.exe 放在同一目录。');

// ---- 已有实例：默认只打开网页（不重复起服务），--restart 才杀掉重来
try {
  const prev = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
  if (prev && alive(prev.pid)) {
    if (!restart) {
      const port = readPort() ?? 5173;
      if (!debug) {
        openBrowser('http://127.0.0.1:' + port + '/');
        process.exit(0);
      }
      process.stderr.write('[launcher] 已有实例在运行（PID ' + prev.pid + '，端口 ' + port + '）\n');
    } else {
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
  }
} catch {
  /* 没有锁文件 = 没在跑 */
}

// ---- 拉起主程序。--serve：启动服务端并自动开浏览器；--debug：主程序保留控制台并打详细日志。
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

child.on('error', (err) => bail('启动失败：' + err.message));

child.on('exit', (code) => {
  try {
    rmSync(LOCK_FILE, { force: true });
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

// 主程序自己会开浏览器；这里等到端口文件出现后兜底补开一次（20 秒内没起来就放弃）。
if (!debug) {
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
