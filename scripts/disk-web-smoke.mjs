// DiskWeb 冒烟：起 python 静态服务器，用 Chrome CDP 验证启动、配置读写、存档与续局。
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const ROOT = 'E:\\jican-simulator-claude';
const PORT = 8123;
const PAGE = 'http://127.0.0.1:' + PORT + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const py = spawn('python', ['serve.py', '--port', String(PORT), '--no-browser'], { cwd: ROOT + '\\disk-web', stdio: ['ignore', 'pipe', 'pipe'] });
py.stdout.on('data', (d) => process.stdout.write('[serve] ' + d));
py.stderr.on('data', (d) => process.stdout.write('[serve:err] ' + d));

let ready = false;
for (let i = 0; i < 50; i += 1) {
  try {
    const r = await fetch(PAGE);
    if (r.ok && (await r.text()).indexOf('__JICAN_WEB__') >= 0) { ready = true; break; }
  } catch (err) { /* 还没起来 */ }
  await sleep(200);
}
if (!ready) { console.error('python 静态服务器没起来'); py.kill(); process.exit(1); }
console.log('=== HTTP 静态服务 === 正常，' + PAGE);

const profile = process.env.TEMP + '\\jican-disk-smoke-' + Date.now();
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=9334', '--user-data-dir=' + profile,
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

async function json(path) {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch('http://127.0.0.1:9334' + path); return await r.json(); } catch (err) { await sleep(200); }
  }
  throw new Error('CDP 没起来');
}
const list = await json('/json/list');
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.once('open', res));
let seq = 0;
const pending = new Map();
const logs = [];
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
async function navigate(url) {
  await send('Page.navigate', { url: url });
  await sleep(4500);
}

await send('Runtime.enable');
await send('Page.enable');
await navigate(PAGE);
const lobbyText = await evaluate('document.body.innerText');
console.log('=== 大厅文本（前 300 字） ===');
console.log((lobbyText || '').slice(0, 300));
console.log('=== 启动异常 ===');
console.log(logs.length ? logs.join('\n') : '(无)');
console.log('=== 单文件标题 ===', await evaluate('document.title'));

// ---- 配置接口 ----
const treeInfo = await evaluate('fetch("/api/config/json").then(function(r){return r.json();}).then(function(j){var n=(j.tree||[]).filter(function(x){return x.path==="app.debug.endpoints";})[0];return JSON.stringify({ok:j.ok,count:(j.tree||[]).length,files:(j.files||[]).length,endpoints:n&&n.value});})');
console.log('=== GET /api/config/json ===', treeInfo);

const writeRes = await evaluate('fetch("/api/config/json",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:"app.debug.endpoints",value:false})}).then(function(r){return r.json().then(function(j){return JSON.stringify({http:r.status,body:j});});})');
console.log('=== POST /api/config/json 改 app.debug.endpoints=false ===', writeRes);
const stored = await evaluate('localStorage.getItem("jican.web.config.default")?"yes"+localStorage.getItem("jican.web.config.default").length:"no"');
console.log('=== localStorage 配置键 ===', stored);

await navigate(PAGE);
const persisted = await evaluate('fetch("/api/config/json").then(function(r){return r.json();}).then(function(j){var n=(j.tree||[]).filter(function(x){return x.path==="app.debug.endpoints";})[0];return JSON.stringify({ok:j.ok,endpoints:n&&n.value,differences:(window.__JICAN_WEB__.configStore.describe().differences||[]).length});})');
console.log('=== 刷新后配置仍在 ===', persisted);
const restoreRes = await evaluate('fetch("/api/config/json",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:"app.debug.endpoints",value:true})}).then(function(r){return r.json().then(function(j){return JSON.stringify({ok:j.ok});});})');
console.log('=== 还原 app.debug.endpoints ===', restoreRes);

// ---- 开一局并验证存档 ----
const clicked = await evaluate('(function(){var bs=document.querySelectorAll("button");for(var i=0;i<bs.length;i++)if(bs[i].textContent.indexOf("开始游戏")>=0){bs[i].click();return true;}return false;})()');
console.log('=== 点击开始游戏 ===', clicked);
await sleep(4000);
const phase = await evaluate('document.getElementById("app")?.getAttribute("data-phase")');
console.log('=== data-phase ===', phase);
const posExpr = '(function(){var c=(window.__JICAN_WEB__.engine.controller.state.characters||[]).filter(function(p){return p.id==="s1-01"})[0];if(!c)return "no-char";var p=c.pos||c;return JSON.stringify({x:p.x,y:p.y});})()';
const before = await evaluate(posExpr);
await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"w",code:"KeyW",bubbles:true}))');
await sleep(700);
await evaluate('window.dispatchEvent(new KeyboardEvent("keyup",{key:"w",code:"KeyW",bubbles:true}))');
await sleep(300);
const after = await evaluate(posExpr);
console.log('=== 按住 W 前/后 ===', before, after, '移动生效=', before !== after);

await sleep(6500);
const saveInfo = await evaluate('(function(){var idx=JSON.parse(localStorage.getItem("jican.web.save.index")||"[]");var c=window.__JICAN_WEB__.engine.controller;var latest=c.saves&&c.saves.latestResumable(c.configHash);var bytes=0;for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k.indexOf("jican.web.")===0)bytes+=(k.length+(localStorage.getItem(k)||"").length);}return JSON.stringify({saves:idx.length,latest:latest?{savedAt:latest.savedAt,tick:latest.meta.tick,phase:latest.meta.phase}:null,localStorageKB:Math.round(bytes/1024)});})()');
console.log('=== 自动存档 ===', saveInfo);

await navigate(PAGE);
await sleep(1500);
const resumeInfo = await evaluate('JSON.stringify({phase:document.getElementById("app")?.getAttribute("data-phase"),resumable:window.__JICAN_WEB__.engine.controller.lobbyInfo().resumable,buttons:Array.from(document.querySelectorAll("button")).filter(function(b){return /继续上局|继续上一局|继续/.test(b.textContent)}).map(function(b){return {t:b.textContent.trim().slice(0,20),d:b.disabled}})})');
console.log('=== 刷新后大厅可续局 ===', resumeInfo);

// ---- 设置里的 config.json 面板真的能读浏览器里的配置树 ----
const settingsClicked = await evaluate('(function(){var bs=document.querySelectorAll("button");for(var i=0;i<bs.length;i++)if(bs[i].textContent.indexOf("设置")>=0&&bs[i].textContent.indexOf("config.json")>=0){bs[i].click();return true;}return false;})()');
await sleep(1800);
const cfgPanel = await evaluate('JSON.stringify({hasTitle:document.body.innerText.indexOf("config/default.json")>=0,hasApp:document.body.innerText.indexOf("app.")>=0,hasSave:document.body.innerText.indexOf("save")>=0,hasWrite:document.body.innerText.indexOf("写入")>=0,body:(document.body.innerText||"").slice(0,160)})');
console.log('=== 设置/config.json 面板 ===', settingsClicked, cfgPanel);
const cfgShot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(ROOT + '\\dist-web\\disk-web-config.png', Buffer.from(cfgShot.result.data, 'base64'));
await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",code:"Escape",bubbles:true}))');
await sleep(800);

// ---- 点「继续上局」真的能读回存档继续 ----
const resumeClicked = await evaluate('(function(){var bs=document.querySelectorAll("button");for(var i=0;i<bs.length;i++)if(bs[i].textContent.indexOf("继续上局")>=0){bs[i].click();return true;}return false;})()');
await sleep(3500);
const resumed = await evaluate('JSON.stringify({phase:document.getElementById("app")?.getAttribute("data-phase"),player:(window.__JICAN_WEB__.engine.controller.state.characters||[]).filter(function(p){return p.id==="s1-01"})[0]?.pos})');
console.log('=== 继续上局 ===', resumeClicked, resumed);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(ROOT + '\\dist-web\\disk-web.png', Buffer.from(shot.result.data, 'base64'));
console.log('=== 截图 dist-web/disk-web.png 已保存 ===');
console.log('=== 最新异常/日志 ===');
console.log(logs.slice(-8).join('\n') || '(无)');

ws.close();
chrome.kill();
py.kill();
process.exit(0);
