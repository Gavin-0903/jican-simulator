// 纯网页版打包：把原版前端（client/ + shared/）与浏览器内游戏引擎打成单个 index.html。
// 原理：每个 ES 模块编成 Blob URL，动态注入 import map 解析 'jican:N' 裸标识符，
// 因此不需要本地服务器，双击 HTML（file://）即可游玩。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameMap } from '../server/world/GameMap.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist-web');
const DISK_DIR = join(ROOT, 'disk-web');
const ENTRY = join(ROOT, 'web/runtime/boot.js');
const OUT = join(OUT_DIR, 'index.html');
const DISK_OUT = join(DISK_DIR, 'index.html');

const SHIMS = {
  'node:events': 'export class EventEmitter {\n' +
    '  constructor(){ this._e = new Map(); }\n' +
    '  on(t, f){ if (!this._e.has(t)) this._e.set(t, []); this._e.get(t).push(f); return this; }\n' +
    '  off(t, f){ const a = this._e.get(t); if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } return this; }\n' +
    '  once(t, f){ const g = (...a) => { this.off(t, g); f(...a); }; return this.on(t, g); }\n' +
    '  emit(t, ...a){ const xs = this._e.get(t); if (!xs || !xs.length) return false; for (const f of xs.slice()) f(...a); return true; }\n' +
    '  removeAllListeners(t){ if (t) this._e.delete(t); else this._e.clear(); return this; }\n' +
    '  listenerCount(t){ return (this._e.get(t) || []).length; }\n' +
    '}\n',
  'node:perf_hooks': 'export const performance = globalThis.performance;\n',
  'node:util': 'export const inspect = (v) => JSON.stringify(v);\n',
};

const modules = new Map();
const order = [];
function addModule(key, code) {
  if (modules.has(key)) return modules.get(key);
  const rec = { id: String(order.length), code: '' };
  modules.set(key, rec);
  order.push({ key: key, rec: rec });
  rec.code = code;
  return rec;
}
const KEY = (k) => String(modules.get(k).id);

const SPEC_RE = /(from\s*|import\s*\(\s*)(['"])([^'"]+)\2/g;
function resolveSpec(fromFile, spec) {
  if (spec.indexOf('node:') === 0) return spec;
  let p = spec.charAt(0) === '/' ? join(ROOT, spec) : resolve(dirname(fromFile), spec);
  if (!existsSync(p)) {
    if (existsSync(p + '.js')) p = p + '.js';
    else if (existsSync(join(p, 'index.js'))) p = join(p, 'index.js');
    else return null;
  }
  return p;
}
function loadModule(file) {
  if (modules.has(file)) return;
  if (SHIMS[file]) { addModule(file, SHIMS[file]); return; }
  let code = readFileSync(file, 'utf8');
  addModule(file, '');
  code = code.replace(SPEC_RE, function (all, pre, q, spec) {
    const target = resolveSpec(file, spec);
    if (!target) return all; // 注释/文档字符串里的假 import，原样保留
    if (!modules.has(target)) loadModule(target);
    return pre + q + 'jican:' + KEY(target) + q;
  });
  modules.get(file).code = code;
}
loadModule(ENTRY);

// ---- 静态资源 ----
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const app = readJson('config/default.json');
const balance = readJson('config/balance.json');
const llm = readJson('config/llm.json');
const mapData = readJson('config/maps/default.json');
const map = new GameMap(mapData);
const mapView = map.publicView();
const mapSvg = readFileSync(join(ROOT, 'client/assets/maps/default.svg'), 'utf8');
const version = readJson('package.json').version;

const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
function dataUrl(absPath) {
  const ext = extname(absPath).toLowerCase();
  const m = mime[ext] || 'application/octet-stream';
  return 'data:' + m + ';base64,' + readFileSync(absPath).toString('base64');
}
const assets = {};
for (const name of readdirSync(join(ROOT, 'client/assets/icons'))) {
  assets['/assets/icons/' + name] = dataUrl(join(ROOT, 'client/assets/icons', name));
}
const ASSET_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
const cssFiles = ['theme.css', 'layout.css', 'components.css', 'cfg-panel.css', 'net-panel.css', 'mobile.css'];
let css = cssFiles.map(function (f) {
  return '/* ' + f + ' */\n' + readFileSync(join(ROOT, 'client/css', f), 'utf8');
}).join('\n');
css = css.replace(ASSET_RE, function (all, u) {
  if (/^(data:|https?:|#)/.test(u.trim())) return all;
  const clean = u.trim().replace(/^\//, '').split('?')[0];
  const abs = join(ROOT, clean);
  if (existsSync(abs)) return 'url(' + dataUrl(abs) + ')';
  return all;
});

const rawHtml = readFileSync(join(ROOT, 'client/index.html'), 'utf8');
const body = rawHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1];
const favicon = dataUrl(join(ROOT, 'client/assets/icons/favicon.svg'));
const headIcon = rawHtml.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*>/i);
const moduleList = order.map(function (x) { return [x.rec.id, x.rec.code]; });
const data = { config: { app: app, balance: balance, llm: llm }, mapData: mapData, mapView: mapView, mapSvg: mapSvg, assets: assets, version: version };

// 网页版顶部公告：说明这不是满血版，引导 Windows 10+ 用户去下载页；可关闭并记住。
const NOTICE_URL = 'https://gavin-bitwing.pages.dev/JC%E6%A8%A1%E6%8B%9F%E5%99%A8/DownLoad/';
const NOTICE_HTML = [
  '<div id="web-notice" role="note" aria-label="网页版说明">',
  '  <span class="wn-text">网页版不是满血版；如果你是 Windows 10 及以上用户，可以去 <a href="' + NOTICE_URL + '" target="_blank" rel="noopener noreferrer">下载页</a> 看看完整版哦！</span>',
  '  <button type="button" class="wn-close" aria-label="关闭公告" title="关闭公告">×</button>',
  '</div>'
].join('\n');
const NOTICE_CSS = [
  ':root { --web-notice-h: 0px; }',
  '#web-notice { position: fixed; top: 0; left: 0; right: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 44px 8px 16px; font-size: 12.5px; line-height: 1.55; color: #cfe1ff; text-align: center; background: linear-gradient(90deg, #162238, #1c2f4f 50%, #162238); border-bottom: 1px solid #34527c; box-shadow: 0 2px 10px rgba(0,0,0,.35); }',
  '#web-notice .wn-text { max-width: 100%; }',
  '#web-notice a { color: #8dc0ff; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }',
  '#web-notice a:hover { color: #b8d8ff; }',
  '#web-notice .wn-close { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 7px; background: rgba(255,255,255,.08); color: #cfe1ff; font-size: 17px; line-height: 1; cursor: pointer; }',
  '#web-notice .wn-close:hover { background: rgba(255,255,255,.18); }',
  'body.has-web-notice .app { height: calc(100vh - var(--web-notice-h)); height: calc(100dvh - var(--web-notice-h)); margin-top: var(--web-notice-h); }',
  '@media (max-width: 560px) { #web-notice { font-size: 11.5px; padding: 7px 38px 7px 10px; } }'
].join('\n');
const NOTICE_JS = [
  '<script>',
  '(function () {',
  '  var notice = document.getElementById("web-notice");',
  '  if (!notice) return;',
  '  var KEY = "jican.web.notice.download.dismissed";',
  '  var dismissed = false;',
  '  try { dismissed = localStorage.getItem(KEY) === "1"; } catch (e) { dismissed = false; }',
  '  if (dismissed) { notice.parentNode.removeChild(notice); return; }',
  '  var root = document.documentElement;',
  '  function layout() { root.style.setProperty("--web-notice-h", notice.offsetHeight + "px"); }',
  '  document.body.classList.add("has-web-notice");',
  '  layout();',
  '  window.addEventListener("resize", layout);',
  '  var btn = notice.querySelector(".wn-close");',
  '  if (btn) btn.addEventListener("click", function () {',
  '    try { localStorage.setItem(KEY, "1"); } catch (e) {}',
  '    window.removeEventListener("resize", layout);',
  '    document.body.classList.remove("has-web-notice");',
  '    root.style.setProperty("--web-notice-h", "0px");',
  '    if (notice.parentNode) notice.parentNode.removeChild(notice);',
  '  });',
  '})();',
  '</script>'
].join('\n');

const lines = [];
lines.push('<!doctype html>');
lines.push('<html lang="zh-CN">');
lines.push('<head>');
lines.push('<meta charset="utf-8">');
lines.push('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
lines.push('<meta name="color-scheme" content="dark">');
lines.push('<title>机惨模拟器 · 纯网页版</title>');
lines.push('<link rel="icon" href="' + favicon + '" type="image/svg+xml">');
lines.push('<style>' + css + '</style>');
lines.push('<style>' + NOTICE_CSS + '</style>');
lines.push('</head>');
lines.push('<body>');
lines.push(NOTICE_HTML);
lines.push(NOTICE_JS);
lines.push(body);
lines.push('<script>');
lines.push('window.__JICAN_WEB__ = ' + JSON.stringify(data) + ';');
lines.push('(function () {');
lines.push('  var MODULES = ' + JSON.stringify(moduleList) + ';');
lines.push('  var imports = {};');
lines.push('  for (var i = 0; i < MODULES.length; i++) {');
lines.push("    imports['jican:' + MODULES[i][0]] = URL.createObjectURL(new Blob([MODULES[i][1]], { type: 'text/javascript' }));");
lines.push('  }');
lines.push("  var im = document.createElement('script');");
lines.push("  im.type = 'importmap';");
lines.push('  im.textContent = JSON.stringify({ imports: imports });');
lines.push('  document.head.appendChild(im);');
lines.push('})();');
lines.push('</script>');
lines.push('<style>.web-online-disabled, .web-online-disabled:hover { opacity: .4 !important; cursor: not-allowed !important; filter: grayscale(1) !important; }</style>');
lines.push('<script type="module">import("jican:' + KEY(ENTRY) + '").catch(function (e) { console.error(e); document.title = "启动失败: " + e.message; });</script>');
lines.push('</body>');
lines.push('</html>');

const html = lines.join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, html, 'utf8');
// disk-web：同一个单文件产物，额外配 serve.py / 启动脚本，整个文件夹可以单独拷走。
mkdirSync(DISK_DIR, { recursive: true });
writeFileSync(DISK_OUT, html, 'utf8');
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log('入口模块 jican:' + KEY(ENTRY), '| 模块数 ' + modules.size + ' | 产物 ' + kb(Buffer.byteLength(html)));
console.log('输出 ' + relative(ROOT, OUT));
console.log('输出 ' + relative(ROOT, DISK_OUT));
const missing = [];
for (const rec of order) if (!rec.rec.code) missing.push(relative(ROOT, rec.key));
if (missing.length) { console.error('空模块: ' + missing.join(', ')); process.exit(1); }