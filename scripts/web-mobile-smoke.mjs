// 移动端冒烟：CDP 模拟 iPhone，验证设备判定、虚拟摇杆、技能按钮、桌面端无控件。
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const ROOT = 'E:\\jican-simulator-claude';
const URL_PAGE = 'file:///' + ROOT.replace(/\\/g, '/') + '/dist-web/index.html';
const PORT = 9337;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + process.env.TEMP + '\\jican-mobile-smoke',
  '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(path) {
  for (let i = 0; i < 60; i++) {
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
  if (msg.method === 'Runtime.consoleAPICalled') logs.push('[console.' + msg.params.type + '] ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
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
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(ROOT + '\\dist-web\\' + name, Buffer.from(s.result.data, 'base64'));
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
await send('Page.navigate', { url: URL_PAGE + '?mobile=1' });
await sleep(5500);

const dev = await evaluate('JSON.stringify({cls:document.documentElement.className, os:document.documentElement.dataset.platform, device:document.documentElement.dataset.device, platform:window.__JICAN_PLATFORM__, phase:document.getElementById("app").dataset.phase})');
console.log('=== 设备判定 ===', dev);
const controls = await evaluate('JSON.stringify({root:!!document.getElementById("mobile-controls"), stick:!!document.getElementById("mobile-stick"), btns:Array.from(document.querySelectorAll(".mc-btn")).map(function(b){return {a:b.dataset.act, d:b.disabled}})})');
console.log('=== 移动端控件（大厅） ===', controls);
await shot('mobile-lobby.png');

// 开始游戏
const clicked = await evaluate("(function(){var bs=document.querySelectorAll('button');for(var i=0;i<bs.length;i++)if(bs[i].textContent.indexOf('开始游戏')>=0){bs[i].click();return true;}return false;})()");
console.log('=== 点击开始游戏 ===', clicked);
await sleep(4500);
const phase = await evaluate('document.getElementById("app").dataset.phase');
const visible = await evaluate('(function(){var c=document.getElementById("mobile-controls");if(!c)return null;var s=getComputedStyle(c);return {display:s.display,opacity:s.opacity,stick:!!document.getElementById("mobile-stick")}})()');
console.log('=== 对局中 ===', phase, JSON.stringify(visible));
const hud = await evaluate('(function(){var h=document.getElementById("hud"), id=document.querySelector(".hud-id"), acts=document.querySelector(".hud-actions"), tm=document.getElementById("hud-timer"), sc=document.getElementById("hud-score");var r=function(e){if(!e)return null;var b=e.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}};return JSON.stringify({hud:r(h),id:r(id),actions:r(acts),timer:r(tm),score:r(sc),scoreDisplay:sc?getComputedStyle(sc).display:null});})()');
console.log('=== HUD 布局 ===', hud);

const posExpr = '(function(){var c=(window.__JICAN_WEB__.engine.controller.state.characters||[]).filter(function(p){return p.id==="s1-01"})[0];if(!c)return "no-char";return JSON.stringify({x:Math.round(c.pos.x*100)/100,y:Math.round(c.pos.y*100)/100,op:c.operatingPcId||null});})()';
const before = await evaluate(posExpr);
console.log('=== 摇杆前位置 ===', before);

// 模拟按住摇杆向右上：pointerdown 在摇杆中心，pointermove 往右上
await evaluate(`(function(){
  var stick=document.getElementById('mobile-stick');
  if(!stick) return 'no-stick';
  var r=stick.getBoundingClientRect();
  var cx=r.left+r.width/2, cy=r.top+r.height/2;
  stick.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:7,pointerType:'touch',isPrimary:true,clientX:cx,clientY:cy,button:0,buttons:1}));
  window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:7,pointerType:'touch',isPrimary:true,clientX:cx+r.width*0.3,clientY:cy-r.height*0.3,button:0,buttons:1}));
  return 'ok';
})()`);
await sleep(1400);
const during = await evaluate(posExpr);
console.log('=== 摇杆中位置 ===', during);
const knob = await evaluate("document.getElementById('mobile-knob').style.transform");
console.log('=== 摇杆帽位移 ===', knob);
await shot('mobile-game.png');
await evaluate(`(function(){
  window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:7,pointerType:'touch',isPrimary:true,button:0,buttons:0}));
  return 'up';
})()`);
await sleep(900);
const after = await evaluate(posExpr);
console.log('=== 松开后位置 ===', after);
await sleep(2200);
const after2 = await evaluate(posExpr);
console.log('=== 松开 3 秒后位置 ===', after2);

// 技能按钮：商店（B）应该弹窗；再按 Esc 关闭
const shop = await evaluate("(function(){var b=document.querySelector('.mc-btn[data-act=\"b\"]');if(!b)return 'no-btn';b.click();return b.disabled;})()");
await sleep(700);
const modal = await evaluate('JSON.stringify({kind:(document.querySelector(".modal")||{}).className||null, text:(document.querySelector(".modal")||document.body).innerText.slice(0,40)})');
console.log('=== 商店按钮 ===', shop, modal);
await shot('mobile-shop.png');
await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}))");
await sleep(500);

const btnState = await evaluate('JSON.stringify(Array.from(document.querySelectorAll(".mc-btn")).map(function(b){return {a:b.dataset.act,d:b.disabled}}))');
console.log('=== 技能按钮可用状态 ===', btnState);

// 横屏对照
await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL_PAGE + '?mobile=1' });
await sleep(4500);
const land = await evaluate('JSON.stringify({phase:document.getElementById("app").dataset.phase,win:[innerWidth,innerHeight],noticeH:getComputedStyle(document.documentElement).getPropertyValue("--web-notice-h").trim(),stick:(function(){var b=document.getElementById("mobile-stick").getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width)}})(),actions:(function(){var b=document.querySelector(".mc-actions").getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}})()})');
console.log('=== 横屏大厅 ===', land);
await shot('mobile-landscape-lobby.png');
const clickedL = await evaluate("(function(){var bs=document.querySelectorAll('button');for(var i=0;i<bs.length;i++)if(bs[i].textContent.indexOf('开始游戏')>=0){bs[i].click();return true;}return false;})()");
await sleep(4000);
const landGame = await evaluate('JSON.stringify({clicked:arguments[0],phase:document.getElementById("app").dataset.phase,hud:(function(){var b=document.getElementById("hud").getBoundingClientRect();return {h:Math.round(b.height)}})()})'.replace('arguments[0]', JSON.stringify(clickedL)));
console.log('=== 横屏对局 ===', landGame);
await shot('mobile-landscape-game.png');

// 桌面模式对照
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Emulation.clearDeviceMetricsOverride');
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' });
await send('Page.navigate', { url: URL_PAGE + '?desktop=1' });
await sleep(4000);
const desk = await evaluate('JSON.stringify({cls:document.documentElement.className, os:document.documentElement.dataset.platform, device:document.documentElement.dataset.device, controls:!!document.getElementById("mobile-controls"), platform:window.__JICAN_PLATFORM__, touchpad:getComputedStyle(document.getElementById("touch-pad")).display})');
console.log('=== 桌面端对照 ===', desk);

console.log('=== 控制台/异常 ===');
console.log(logs.length ? logs.join('\n') : '(无)');
ws.close();
chrome.kill();
process.exit(0);
