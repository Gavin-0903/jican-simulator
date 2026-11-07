// 自动更新（v1.2）：开局检查官方 version.json，发现线上版本更高才询问用户；
// 用户同意后后台下载安装包，启动安装程序，然后退出游戏本体让用户完成安装。
//
// 设计边界（都是踩过的坑）：
//  1) 只在「打包后的 exe」里启用：开发期版本号（package.json 的 0.2.0）和线上版本号天然不同，
//     不设闸门的话每次 npm start 都弹更新框。用 JICAN_UPDATE_DEV=1 可以强制在开发期验证流程。
//  2) 只在「线上版本更高」时才提示更新（v1.2.2 修正）：早先的实现是"版本不同就更新"，
//     结果 v1.2.1beta 的用户被 v1.2dev（Win7 客户端的开发版）反复弹窗——dev/beta 是并列渠道，
//     不比大小就会互相"覆盖"。现在按 数字段 → 预发布标签(dev<alpha<beta<rc<正式) → 尾号 比较，
//     线上更低或相同都算「已是最新」。回滚场景改由人工装旧包，不再自动降级。
//  3) 下载/安装全部只对本机开放（LobbyHttp 里校验回环地址），网页里的第三方脚本碰不到。
//  4) 安装包从官方 download.json 的下载直链取；匹配不到就报错，绝不猜 URL。
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

export const UPDATE_FEED_URL =
  'https://gavin-bitwing.pages.dev/JC%E6%A8%A1%E6%8B%9F%E5%99%A8/DownLoad/version.json';
export const UPDATE_DOWNLOAD_MAP_URL =
  'https://gavin-bitwing.pages.dev/JC%E6%A8%A1%E6%8B%9F%E5%99%A8/DownLoad/download.json';

/** 去掉版本号前缀 v/V 与空白：线上写 v1.2.1beta，打包清单写 1.2.1beta。 */
export function normalizeVersion(v) {
  return String(v ?? '')
    .trim()
    .replace(/^v/i, '')
    .replace(/\s+/g, '');
}

/**
 * 版本号是否相同（大小写不敏感）。只用来显示/去重，更新判定一律走 isNewerVersion：
 * 「不同就更新」会把 v1.2dev 这类并列渠道当成新版本推给 v1.2.1beta 的用户。
 */
export function versionsEqual(a, b) {
  const x = normalizeVersion(a).toLowerCase();
  const y = normalizeVersion(b).toLowerCase();
  return Boolean(x) && Boolean(y) && x === y;
}

/** 预发布标签的先后：dev < alpha < beta < preview/rc < 正式版；未知标签排在 rc 之后、正式版之前。 */
const PRERELEASE_RANK = new Map([
  ['dev', 0],
  ['snapshot', 0],
  ['alpha', 1],
  ['a', 1],
  ['beta', 2],
  ['b', 2],
  ['preview', 3],
  ['rc', 3],
  ['final', 9],
  ['release', 9],
  ['stable', 9],
]);
const RELEASE_RANK = 9;
const UNKNOWN_RANK = 4;

/**
 * 拆版本号：'v1.2.1beta' → { nums: [1,2,1], tag: 'beta', build: null }。
 * 支持 1.2 / 1.2.1 / 1.2.1beta / 1.2.1-beta2 / 1.2.1rc1 这类写法；解析不了返回 null。
 */
export function parseVersion(v) {
  const s = normalizeVersion(v).toLowerCase();
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)*)(?:[.\-_ ]*([a-z]+)(?:[.\-_]?(\d+))?)?$/.exec(s);
  if (!m) return null;
  return {
    nums: m[1].split('.').map((n) => Number(n) || 0),
    tag: m[2] || '',
    build: m[3] === undefined ? null : Number(m[3]),
  };
}

const rankOf = (tag) => (tag === '' ? RELEASE_RANK : PRERELEASE_RANK.has(tag) ? PRERELEASE_RANK.get(tag) : UNKNOWN_RANK);

/**
 * 比较两个版本号：a 比 b 新返回 >0，相同返回 0，更旧返回 <0。
 * 任一方解析不了时返回 0（调用方的口径是"不确认更新"，宁可不更新也不乱升级）。
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  const len = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < len; i += 1) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  const rx = rankOf(x.tag);
  const ry = rankOf(y.tag);
  if (rx !== ry) return rx > ry ? 1 : -1;
  if (rx === UNKNOWN_RANK && x.tag !== y.tag) return x.tag > y.tag ? 1 : -1;
  // 同标签：带尾号的新（beta2 > beta，beta2 > beta1）
  if (x.build === null && y.build === null) return 0;
  if (x.build === null) return -1;
  if (y.build === null) return 1;
  return x.build === y.build ? 0 : x.build > y.build ? 1 : -1;
}

/** 线上版本是否比本机更高（唯一会触发下载/安装的判定）。 */
export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

/** 从 URL 里取文件名，去掉查询串；取不到就退回一个稳定的名字。 */
export function setupFileNameFromUrl(url, fallback = 'jican-simulator-setup.exe') {
  try {
    const name = decodeURIComponent(new URL(String(url)).pathname.split('/').pop() || '');
    if (/\.exe$/i.test(name) && !/[\u0000-\u001f<>:"/\\|?*]/.test(name)) return name;
  } catch {
    /* 不是合法 URL */
  }
  return fallback;
}

/**
 * 在 download.json 的「安装包名 → 直链」表里挑当前版本对应的安装包。
 * 键名形如「机惨模拟器-Win10满血版-v1.2.1beta-1107」，同时带渠道与版本，正好够用：
 *   版本命中（必须）+ 渠道命中（优先），同分时优先 setupName 前缀完全一致的键。
 */
export function pickSetupUrl(map, { flavor = '', version = '', setupName = '' } = {}) {
  if (!map || typeof map !== 'object') return null;
  const wantVersion = normalizeVersion(version).toLowerCase();
  const wantFlavor = /win7/i.test(flavor) ? 'win7' : /win10/i.test(flavor) ? 'win10' : '';
  const wantName = String(setupName || '').toLowerCase();
  let best = null;
  for (const [key, url] of Object.entries(map)) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    const k = String(key).toLowerCase();
    const versionHit = Boolean(wantVersion) && k.includes(wantVersion);
    if (!versionHit) continue;
    const flavorHit = wantFlavor ? k.includes(wantFlavor) : false;
    const nameHit = Boolean(wantName) && k.includes(wantName);
    const score = (nameHit ? 4 : 0) + (flavorHit ? 2 : 0) + 1; // 版本命中保底 1 分
    if (!best || score > best.score) best = { score, key, url };
  }
  return best ? { name: best.key, url: best.url } : null;
}

const sse = (n) => Math.max(0, Math.round(n));

/**
 * @param {{
 *   rootDir: string, dataDir: string, logger?: Console,
 *   enabled?: boolean, version?: string, flavor?: string, setupName?: string,
 *   feedUrl?: string, downloadMapUrl?: string,
 *   fetchImpl?: typeof fetch, spawnImpl?: typeof spawn, requestQuit?: (reason:string)=>void,
 *   now?: () => number, log?: (msg:string)=>void,
 * }} opts
 */
export function createUpdater({
  rootDir = '',
  dataDir = '',
  logger = console,
  enabled = true,
  version = '',
  flavor = '',
  setupName = '',
  feedUrl = UPDATE_FEED_URL,
  downloadMapUrl = UPDATE_DOWNLOAD_MAP_URL,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  requestQuit = null,
  now = Date.now,
  log = null,
} = {}) {
  const logLine = (msg) => {
    try {
      (log || (logger && typeof logger.log === 'function' ? (m) => logger.log('[更新] ' + m) : null))?.(msg);
    } catch {
      /* 日志失败不能拖垮更新 */
    }
  };
  const localVersion = normalizeVersion(version);
  const updatesDir = join(dataDir || rootDir || '.', 'updates');
  const CHECK_TTL_MS = 10 * 60_000;
  let remote = null;
  let checkedAt = 0;
  let setup = null;
  let state = {
    phase: enabled ? 'idle' : 'disabled',
    received: 0,
    total: 0,
    percent: null,
    speed: 0,
    error: '',
    installer: '',
    startedAt: 0,
  };

  const setState = (patch) => {
    state = { ...state, ...patch };
  };

  const snapshot = (extra = {}) => ({
    ok: true,
    enabled,
    supported: Boolean(enabled),
    localVersion,
    remoteVersion: remote ? String(remote.version ?? '') : '',
    channel: remote ? String(remote.channel ?? '') : '',
    releasedAt: remote ? String(remote.releasedAt ?? '') : '',
    headline: remote ? String(remote.headline ?? '') : '',
    notes: remote && Array.isArray(remote.notes) ? remote.notes.slice(0, 20) : [],
    updateAvailable: Boolean(remote) && isNewerVersion(remote.version, localVersion),
    phase: state.phase,
    received: state.received,
    total: state.total,
    percent: state.percent,
    speed: state.speed,
    error: state.error,
    installer: state.installer,
    ...extra,
  });

  const fetchJson = async (url, { timeoutMs = 12000 } = {}) => {
    if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: { 'cache-control': 'no-cache', 'user-agent': 'jican-simulator-updater/1.0' },
        signal: ac.signal,
      });
      if (!res.ok) throw new Error('服务器返回 HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };

  /** 检查线上版本；force 用于用户点「重新检查」，否则 10 分钟内复用结果。 */
  async function check({ force = false } = {}) {
    if (!enabled) return snapshot({ message: '开发模式不检查更新' });
    if (!force && remote && now() - checkedAt < CHECK_TTL_MS) return snapshot();
    setState({ phase: 'checking', error: '' });
    try {
      const info = await fetchJson(feedUrl);
      if (!info || typeof info !== 'object' || !info.version) throw new Error('版本信息格式不对（缺少 version）');
      remote = info;
      checkedAt = now();
      const available = isNewerVersion(remote.version, localVersion);
      const older = !available && !versionsEqual(localVersion, remote.version);
      setState({ phase: available ? 'available' : 'latest', error: '' });
      logLine(
        '本机 ' + localVersion + ' / 线上 ' + remote.version + (available ? ' → 有新版本' : older ? ' → 线上更旧，不更新' : ' → 已是最新'),
      );
    } catch (err) {
      setState({ phase: 'error', error: '检查更新失败：' + String(err && err.message ? err.message : err) });
      logLine(state.error);
    }
    return snapshot();
  }

  /** 解析安装包直链：优先用 version.json 内嵌的 downloads（将来可扩展），否则查 download.json。 */
  async function resolveSetup() {
    if (remote && remote.downloads) {
      const picked = pickSetupUrl(remote.downloads, { flavor, version: remote.version, setupName });
      if (picked) return picked;
    }
    const map = await fetchJson(downloadMapUrl);
    const picked = pickSetupUrl(map, { flavor, version: remote ? remote.version : '', setupName });
    if (!picked) {
      throw new Error(
        '官方下载表里没有匹配当前版本（' + normalizeVersion(remote ? remote.version : '') + '）和渠道（' + (flavor || '未知') + '）的安装包',
      );
    }
    return picked;
  }

  /** 后台下载安装包：进度写进 state，前端轮询 /api/update/status 显示。 */
  async function download() {
    if (!enabled) throw new Error('开发模式不检查更新');
    if (!remote) await check({ force: true });
    const available = remote && isNewerVersion(remote.version, localVersion);
    if (!available) {
      const err = new Error('当前已经是最新版本，无需下载');
      setState({ phase: 'error', error: err.message });
      throw err;
    }
    if (state.phase === 'downloading') return snapshot({ message: '已经在下载中' });
    setState({ phase: 'downloading', received: 0, total: 0, percent: null, speed: 0, error: '', installer: '' });
    try {
      const picked = await resolveSetup();
      setup = picked;
      mkdirSync(updatesDir, { recursive: true });
      const file = join(updatesDir, setupFileNameFromUrl(picked.url, 'jican-simulator-' + normalizeVersion(remote.version) + '-setup.exe'));
      const tmp = file + '.part';
      rmSync(tmp, { force: true });
      const res = await fetchImpl(picked.url, {
        headers: { 'user-agent': 'jican-simulator-updater/1.0' },
      });
      if (!res.ok || !res.body) throw new Error('下载失败：服务器返回 HTTP ' + res.status);
      const total = Number(res.headers.get('content-length') || 0);
      setState({ total: total > 0 ? sse(total) : 0 });
      const startedAt = now();
      let received = 0;
      const counter = new TransformStreamCounter((n) => {
        received += n;
        const elapsed = Math.max(0.001, (now() - startedAt) / 1000);
        setState({
          received: sse(received),
          speed: sse(received / elapsed / 1024),
          total: total > 0 ? sse(total) : 0,
          percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
        });
      });
      await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tmp));
      if (total > 0 && received < total) throw new Error('下载不完整（' + received + '/' + total + ' 字节）');
      rmSync(file, { force: true });
      renameSync(tmp, file);
      const size = statSync(file).size;
      if (size < 1024) throw new Error('下载的文件太小（' + size + ' 字节），可能不是安装包');
      setState({ phase: 'ready', installer: file, percent: 100, received: size, error: '' });
      logLine('下载完成：' + file + '（' + size + ' 字节）');
      return snapshot();
    } catch (err) {
      setState({ phase: 'error', error: '下载失败：' + String(err && err.message ? err.message : err) });
      logLine(state.error);
      throw err;
    }
  }

  /** 启动安装程序，随后让游戏本体退出（宿主看到 update.quit 标记后一起退出）。 */
  async function install() {
    const file = state.installer;
    if (state.phase !== 'ready' || !file) throw new Error('安装包还没下载完成');
    setState({ phase: 'installing', error: '' });
    try {
      const child = spawnImpl(file, [], { detached: true, stdio: 'ignore', cwd: updatesDir });
      child.unref?.();
      // 宿主（launch.exe）轮询这个标记：看到就收掉自己的窗口一起退出，
      // 不然安装程序会一直撞上"文件被占用"。
      try {
        writeFileSync(join(dataDir, 'update.quit'), JSON.stringify({ at: new Date().toISOString(), installer: file }));
      } catch {
        /* 标记写不了也要尽量退出 */
      }
      logLine('已启动安装程序：' + file);
      setTimeout(() => {
        try {
          requestQuit?.('update');
        } catch {
          /* 忽略 */
        }
      }, 600);
      return { ok: true, installer: file, setupName: setup ? setup.name : '' };
    } catch (err) {
      setState({ phase: 'error', error: '启动安装程序失败：' + String(err && err.message ? err.message : err) });
      throw err;
    }
  }

  return {
    check,
    download,
    install,
    status: () => snapshot({ ok: true }),
    get localVersion() {
      return localVersion;
    },
    get enabled() {
      return enabled;
    },
  };
}

/** 边下边报进度：一个极小的 Transform 计数器（避免为了进度引入依赖）。 */
class TransformStreamCounter extends Transform {
  constructor(onChunk) {
    super();
    this.onChunk = onChunk;
  }
  _transform(chunk, _enc, cb) {
    this.onChunk(chunk.length);
    this.push(chunk);
    cb();
  }
}
