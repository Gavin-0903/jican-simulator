// 纯网页版自动冒烟：CDP 驱动 Chrome，检查启动错误、点「开始游戏」后是否真的进入对局。
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const URL_PAGE = 'file:///E:/jican-simulator-claude/dist-web/index.html';
const PORT = 9333;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + process.env.TEMP + '\\jican-smoke',
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(path) {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + path); return await r.json(); } catch { await sleep(200); }
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
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push('[console.' + msg.params.type + '] ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push('[exception] ' + (d.exception?.description || d.text));
  }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL_PAGE });
await sleep(5000);
const lobbyText = await evaluate('document.body.innerText');
console.log('=== 启动后页面文本（前 700 字） ===');
console.log((lobbyText || '').slice(0, 700));
console.log('=== 控制台/异常 ===');
console.log(logs.length ? logs.join('\n') : '(无)');

const tabInfo = await evaluate('JSON.stringify(Array.from(document.querySelectorAll("button")).filter(function(b){return /联机|房间|邀请/.test(b.textContent)}).map(function(b){return {t:b.textContent.trim().slice(0,20), d:b.disabled, c:b.className}}))');
console.log('=== 联机相关按钮 ===', tabInfo);
const forced = await evaluate('(function(){var bs=document.querySelectorAll("button");for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf("联机")>=0){bs[i].click();return "已点击";}}return "没找到联机按钮";})()');
console.log('=== 点击联机 tab ===', forced);
await sleep(1200);
const afterNet = await evaluate('JSON.stringify({netPanel:!!document.querySelector(".net2-bar"), text:(document.querySelector(".net2-panel")||document.body).innerText.slice(0,80)})');
console.log('=== 联机面板 ===', afterNet);
await evaluate('(function(){var bs=document.querySelectorAll("button");for(var i=0;i<bs.length;i++){if(bs[i].textContent.trim()==="单机"){bs[i].click();return;}}})()');
await sleep(800);
const errRed = await evaluate('document.body.innerText.indexOf("不支持的消息")');
console.log('=== 页面上是否有「不支持的消息」 ===', errRed);

const clickExpr = ["(function () {", "var bs = document.querySelectorAll('button');", "for (var i = 0; i < bs.length; i++) if (bs[i].textContent.indexOf('开始游戏') >= 0) { bs[i].click(); return bs[i].textContent; }", 'return null;', '})()'].join('');
const clicked = await evaluate(clickExpr);
console.log('=== 点击开始游戏 ===', clicked);
await sleep(4000);
const gameText = await evaluate('document.body.innerText');
console.log('=== 开局后页面文本（前 700 字） ===');
console.log((gameText || '').slice(0, 700));
const phase = await evaluate('document.getElementById("app")?.getAttribute("data-phase")');
console.log('=== data-phase ===', phase);
const keys = await evaluate('JSON.stringify(Object.keys(window.__JICAN_WEB__.engine.controller.state||{}))');
console.log('=== state 键 ===', keys);
const posExpr = '(function(){var c=(window.__JICAN_WEB__.engine.controller.state.characters||[]).filter(function(p){return p.id==="s1-01"})[0];if(!c)return "no-char";var p=c.pos||c;return JSON.stringify({x:p.x,y:p.y,keys:Object.keys(c)});})()';
const before = await evaluate(posExpr);
await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", {key:"w", code:"KeyW", bubbles:true}))');
await sleep(700);
await evaluate('window.dispatchEvent(new KeyboardEvent("keyup", {key:"w", code:"KeyW", bubbles:true}))');
await sleep(300);
const after = await evaluate(posExpr);
console.log('=== 按住 W 前位置 ===', before);
console.log('=== 按住 W 后位置 ===', after);
console.log('=== 移动生效 ===', before !== after);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('E:\\jican-simulator-claude\\dist-web\\game.png', Buffer.from(shot.result.data, 'base64'));
console.log('=== 截图 dist-web/game.png 已保存 ===');
console.log('=== 最新日志 ===');
console.log(logs.slice(-10).join('\n') || '(无)');
ws.close();
chrome.kill();
process.exit(0);