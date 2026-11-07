// 纯网页版引导：内联引擎 + 只读接口兜底 + 可选联机（只当客户端，连别人的服务器源）。
// 联机能力：填写服务器源后，创建/加入房间的 HTTP 与 WebSocket 全部发往那台机器；
// 本页自己不监听端口、不生成服务器源，DevTools 也变不出「本机当服务器源」。
const DATA = globalThis.__JICAN_WEB__ || {};
globalThis.__JICAN_WEB__ = DATA;

import { createEngine } from './engine.js';
import { createConfigStore } from './configStore.js';
import { BrowserSaveManager } from './saveManager.js';

// 配置与存档都放在浏览器里：配置改完刷新页面生效；存档每 5 秒自动写 localStorage。
const configStore = createConfigStore();
const effectiveConfig = configStore.effective();
const saveManager = new BrowserSaveManager({
  keepRounds: (effectiveConfig.app.save && effectiveConfig.app.save.keepRounds) || 10,
  logger: console,
});
const engine = createEngine({
  app: effectiveConfig.app,
  balance: effectiveConfig.balance,
  llm: effectiveConfig.llm,
  mapData: DATA.mapData,
  serverVersion: DATA.version,
  saveManager: saveManager,
});

const SOURCE_KEY = 'jican.web.source';
const TOKEN_KEY = 'jican.web.token';
const IDKEY_KEY = 'jican.web.idkey';

function readStorage(key) {
  try { return String(localStorage.getItem(key) || '').trim(); } catch (err) { return ''; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, String(value == null ? '' : value)); } catch (err) { /* 隐私模式忽略 */ }
}
function searchParam(name) {
  try { return new URLSearchParams(location.search).get(name) || ''; } catch (err) { return ''; }
}
function normSource(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(s) ? s : '';
}
function remoteSource() {
  let src = searchParam('src');
  if (!src) src = readStorage(SOURCE_KEY);
  return normSource(src);
}
function makeIdKey() {
  let key = readStorage(IDKEY_KEY);
  if (/^[0-9a-f]{256}$/i.test(key)) return key;
  const bytes = new Uint8Array(128);
  (globalThis.crypto || {}).getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  writeStorage(IDKEY_KEY, out);
  return out;
}
function saveSetting(key, value) {
  if (key === 'source' || key === 'origin') writeStorage(SOURCE_KEY, localStorageSafe(value));
  else if (key === 'token') writeStorage(TOKEN_KEY, localStorageSafe(value));
  else if (key === 'username') writeStorage('jican.web.username', localStorageSafe(value));
}
function localStorageSafe(value) { return String(value == null ? '' : value).trim(); }
function webRoomUrl(origin, q) {
  const base = String(location.href || '').split('#')[0].split('?')[0];
  const qs = q && typeof q.toString === 'function' ? q.toString() : String(q || '');
  const src = normSource(origin);
  return base + '?' + qs + (src ? '&src=' + encodeURIComponent(src) : '');
}
DATA.roomUrl = webRoomUrl;
DATA.saveSetting = saveSetting;
DATA.isOnline = true;

// 房间页（地址栏带 src / token）：先把服务器源与口令记住，刷新和断线重连都还知道连哪台。
(function rememberRoomContext() {
  const src = normSource(searchParam('src'));
  if (src) writeStorage(SOURCE_KEY, src);
  const token = searchParam('token');
  if (/^[0-9a-f]{256}$/i.test(token)) writeStorage(TOKEN_KEY, token);
})();

// ---- fetch 兜底：本地只读接口，以及「把联机请求转发给服务器源」 ----
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
const origFetch = globalThis.fetch.bind(globalThis);

// 这些路径在联机房间页属于服务器源，必须原样转给远端（含方法/请求体）。
function isRemotePath(path) {
  return path.indexOf('/api/lobby/') === 0 ||
    path === '/api/net/room/check' ||
    path === '/api/net/room' ||
    path.indexOf('/api/net/room/') === 0 ||
    path.indexOf('/api/net/join') === 0;
}
function proxyTo(remote, url, init) {
  const rest = String(url).replace(/^https?:\/\/[^/]+/, '');
  const target = remote + (rest.charAt(0) === '/' ? rest : '/' + rest);
  return origFetch(target, init).catch(function () {
    return jsonResponse({ ok: false, code: 'WEB_SOURCE_UNREACHABLE', error: '连不上服务器源：' + remote }, 502);
  });
}
function readBody(init) {
  try {
    const raw = init && init.body;
    if (!raw) return {};
    if (typeof raw === 'string') return JSON.parse(raw);
    return {};
  } catch (err) {
    return null;
  }
}
function localResponse(url, init) {
  const rest = String(url).replace(/^file:\/\/[^/]*/, '').replace(/^https?:\/\/[^/]+/, '');
  const path = rest.split('?')[0].split('#')[0];
  if (isRemotePath(path)) {
    const remote = remoteSource();
    if (remote) return proxyTo(remote, url, init);
  }
  if (path === '/api/map' || path === '/map') return jsonResponse(DATA.mapView);
  if (path === '/api/lobby') return jsonResponse(engine.controller.lobbyInfo());
  if (path === '/api/app/ping') return jsonResponse({ ok: true, mode: 'web', online: Boolean(remoteSource()), ts: Date.now() });
  if (path === '/api/local/id') return jsonResponse({ ok: true, idKey: makeIdKey(), serverSource: false });
  if (path === '/api/net/info') {
    return jsonResponse({ ok: true, name: '纯网页版（联机客户端）', serverSource: false, idKeyHint: makeIdKey().slice(0, 8) + '…', rooms: 0 });
  }
  if (path === '/api/net/admin/token') {
    const token = readStorage(TOKEN_KEY);
    return jsonResponse(token ? { ok: true, token: token } : { ok: false, error: '纯网页版没有本机 Token：请填房主给的 Token' });
  }
  if (path === '/api/net/online') {
    return jsonResponse({ ok: true, online: { enabled: false, mode: 'off', serverUrl: remoteSource(), port: null, hasToken: Boolean(readStorage(TOKEN_KEY)) } });
  }
  if (path === '/api/net/admin' || path.indexOf('/api/net/admin/') === 0) {
    return jsonResponse({ ok: false, error: '纯网页版不能作为服务器源：请填写别人的服务器源地址' }, 403);
  }
  // ---- 配置：读写浏览器里的 config/*.json（ConfigPanel 用同一套接口） ----
  if (path === '/api/config/json') {
    if (init && String(init.method || 'GET').toUpperCase() === 'POST') {
      const body = readBody(init);
      if (!body) return jsonResponse({ ok: false, message: '请求体不是合法 JSON' }, 400);
      return jsonResponse(configStore.writeJson(body));
    }
    return jsonResponse(configStore.jsonTree());
  }
  if (path === '/api/config/json/raw') return jsonResponse(configStore.jsonRaw());
  if (path === '/api/config/reset') {
    const body = readBody(init);
    if (!body) return jsonResponse({ ok: false, message: '请求体不是合法 JSON' }, 400);
    return jsonResponse(configStore.reset(body.section));
  }
  if (path === '/api/config') {
    if (init && String(init.method || 'GET').toUpperCase() === 'POST') {
      const body = readBody(init);
      if (!body) return jsonResponse({ ok: false, message: '请求体不是合法 JSON' }, 400);
      return jsonResponse(configStore.apply(body));
    }
    return jsonResponse(configStore.describe());
  }
  if (path.indexOf('/assets/maps/') === 0) {
    return new Response(DATA.mapSvg, { status: 200, headers: { 'content-type': 'image/svg+xml' } });
  }
  if (path.indexOf('/assets/') === 0) return new Response('', { status: 404 });
  if (path === '/version.json') return jsonResponse({ version: DATA.version, enabled: false });
  if (path.indexOf('/api/net/') === 0) {
    return jsonResponse({ ok: false, code: 'WEB_NO_LOCAL_SERVER', error: '纯网页版没有本机服务端：这个接口只对服务器源有效' }, 501);
  }
  return jsonResponse({ ok: false, code: 'WEB_NOT_IMPLEMENTED', error: '纯网页版没有这个接口：' + path }, 404);
}
// 判断一个地址是不是「本页自己的接口」：file:// 或与当前页面同源。
// 通过 http 静态服务器打开时，客户端有些代码会拼出 http://127.0.0.1:8123/api/... 的绝对地址，
// 这些仍然必须走本地兜底，不能真的打到 python 静态服务器上。
function isLocalUrl(url) {
  if (url.indexOf('data:') === 0 || url.indexOf('blob:') === 0) return false;
  if (url.indexOf('http://') !== 0 && url.indexOf('https://') !== 0) return true;
  try {
    const target = new URL(url, location.href);
    if (target.protocol === 'file:') return true;
    return target.origin === location.origin;
  } catch (err) {
    return false;
  }
}
globalThis.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (isLocalUrl(url)) return Promise.resolve(localResponse(url, init));
  return origFetch(input, init);
};

// ---- WebSocket：连别人的服务器源交给原生实现，本页自己的 /ws 走本地单机引擎 ----
// 注意：用 http:// 静态服务器打开时，buildConnectionUrl 会拼出 ws://127.0.0.1:8000/ws
// 这种「同源的绝对地址」，它仍然属于本页，必须走本地引擎，不能真的去连静态服务器。
const NativeWebSocket = globalThis.WebSocket;
function isForeignWs(raw) {
  if (!/^wss?:\/\//i.test(String(raw))) return false;
  try {
    const target = new URL(String(raw), location.href);
    return target.host !== location.host;
  } catch (err) {
    return true;
  }
}
class LocalWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, protocols) {
    if (isForeignWs(url)) {
      return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    }
    super();
    this.url = String(url);
    this.readyState = 0;
    this.binaryType = 'blob';
    this._conn = null;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    const self = this;
    const online = /\/lobby(\?|$)/.test(this.url);
    setTimeout(function () {
      if (online) {
        self.readyState = 3;
        self._fire('error', {});
        self._fire('close', { code: 4404, reason: '还没填写服务器源：请在大厅「联机 → 高级」里填服务器源地址与 Token' });
        return;
      }
      self.readyState = 1;
      engine.attach(self);
      self._fire('open', {});
    }, 0);
  }

  _fire(type, ev) {
    const detail = ev || {};
    const event = Object.assign(new Event(type), detail);
    this.dispatchEvent(event);
    const handler = this['on' + type];
    if (typeof handler === 'function') handler(Object.assign({ type: type, target: this }, detail));
  }

  _deliver(text) {
    if (this.readyState !== 1) return;
    const event = new Event('message');
    event.data = text;
    this.dispatchEvent(event);
  }

  send(raw) {
    if (this.readyState !== 1) return;
    engine.receive(this, raw);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this._conn) {
      this._conn.close();
      this._conn = null;
    }
    const self = this;
    setTimeout(function () {
      self._fire('close', { code: 1000, reason: 'closed' });
    }, 0);
  }
}
globalThis.WebSocket = LocalWebSocket;
globalThis.__JICAN_WEB__.engine = engine;
globalThis.__JICAN_WEB__.configStore = configStore;
globalThis.__JICAN_WEB__.saveManager = saveManager;

// ---- 只把美术资源换成本地 data URL（联机按钮不再禁用：现在有真的联机客户端逻辑） ----
function swapAssetImages() {
  const assets = DATA.assets || {};
  const imgs = document.querySelectorAll('img[src^="/assets/"]');
  for (let i = 0; i < imgs.length; i++) {
    const el = imgs[i];
    const data = assets[el.getAttribute('src')];
    if (data) el.src = data;
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', swapAssetImages);
} else {
  swapAssetImages();
}
new MutationObserver(swapAssetImages).observe(document.body, { childList: true, subtree: true });

await import('../../client/js/main.js');
