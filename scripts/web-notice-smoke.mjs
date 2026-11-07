// 网页版顶部公告冒烟：起静态服务，验证公告、下载链接、布局偏移、关闭持久化与 file:// 版本。
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { WebSocket } from 'ws';

const ROOT = 'E:\\jican-simulator-claude';
const PORT = 8129;
const PAGE = 'http://127.0.0.1:' + PORT + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const py = spawn('python', ['serve.py', '--port', String(PORT), '--no-browser'], { cwd: ROOT + '\\disk-web', stdio: ['ignore', 'pipe', 'pipe'] });
py.stdout.on('data', (d) => process.stdout.write('[serve] ' + d));
py.stderr.on('data', (d) => process.stdout.write('[serve:err] ' + d));
let ready = false;
for (let i = 0; i < 50; i += 1) {
  try { const r = await fetch(PAGE); if (r.ok) { ready = true; break; } } catch (e) {}
  await sleep(200);
}
if (!ready) { console.error('serve.py 没起来'); py.kill(); process.exit(1); }
console.log('=== 静态服务 === 正常 ' + PAGE);

const profile = process.env.TEMP + '\\jican-notice-smoke-' + Date.now();
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9336', '--user-data-dir=' + profile,
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });
async function json(path) {
  for (let i = 0; i < 60; i += 1) { try { const r = await fetch('http://127.0.0.1:9336' + path); return await r.json(); } catch (e) { await sleep(200); } }
  throw new Error('CDP 没起来');
}
const list = await json('/json/list');
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.once('open', res));
let seq = 0; const pending = new Map(); const logs = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.consoleAPICalled') logs.push('[console.' + msg.params.type + '] ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  if (msg.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id: id, method: method, params: params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
  return r.result?.result?.value;
};
async function navigate(url) { await send('Page.navigate', { url: url }); await sleep(4500); }
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(ROOT + '\\dist-web', { recursive: true });
  writeFileSync(ROOT + '\\dist-web\\' + name, Buffer.from(r.result.data, 'base64'));
  console.log('=== 截图 === dist-web\\' + name);
}

await send('Runtime.enable');
await send('Page.enable');
await navigate(PAGE);

const info = await evaluate('(function(){var n=document.getElementById("web-notice");var a=n&&n.querySelector("a");var app=document.querySelector(".app");var r=n&&n.getBoundingClientRect();var ar=app&&app.getBoundingClientRect();return JSON.stringify({exists:!!n,text:n&&n.innerText.replace(/\s+/g," ").trim(),href:a&&a.getAttribute("href"),target:a&&a.getAttribute("target"),rel:a&&a.getAttribute("rel"),noticeBottom:r&&Math.round(r.bottom),appTop:ar&&Math.round(ar.top),appHeight:ar&&Math.round(ar.height),winH:innerHeight,hasClass:document.body.classList.contains("has-web-notice"),dismissedKey:localStorage.getItem("jican.web.notice.download.dismissed"),phase:(app&&app.getAttribute("data-phase"))});})()');
console.log('=== 公告与布局 ===');
console.log(info);
await shot('notice.png');

const closeRes = await evaluate('(function(){var b=document.querySelector("#web-notice .wn-close");if(!b)return "no-btn";b.click();var app=document.querySelector(".app");return JSON.stringify({notice:!!document.getElementById("web-notice"),marginTop:getComputedStyle(app).marginTop,hasClass:document.body.classList.contains("has-web-notice"),stored:localStorage.getItem("jican.web.notice.download.dismissed")});})()');
console.log('=== 点击 × 关闭 ===', closeRes);

await navigate(PAGE);
const afterReload = await evaluate('(function(){var n=document.getElementById("web-notice");var app=document.querySelector(".app");return JSON.stringify({notice:!!n,marginTop:getComputedStyle(app).marginTop,phase:app.getAttribute("data-phase"),lobbyText:document.body.innerText.slice(0,80).replace(/\s+/g," ")});})()');
console.log('=== 刷新后不再出现 ===', afterReload);
await shot('notice-closed.png');

// file:// 版本（独立 origin，公告应再次出现）
await navigate('file:///E:/jican-simulator-claude/dist-web/index.html');
const fileInfo = await evaluate('(function(){var n=document.getElementById("web-notice");var app=document.querySelector(".app");return JSON.stringify({notice:!!n,link:!!(n&&n.querySelector("a")),marginTop:getComputedStyle(app).marginTop,phase:app.getAttribute("data-phase")});})()');
console.log('=== file:// 版本 ===', fileInfo);
await shot('notice-file.png');

console.log('=== 启动异常 ===');
console.log(logs.length ? logs.join('\n') : '(无)');

ws.close();
try { chrome.kill(); } catch (e) {}
try { py.kill(); } catch (e) {}
await sleep(800);
process.exit(0);
