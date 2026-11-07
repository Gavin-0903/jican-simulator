// 纯网页版联机冒烟：创建房间/选座开局 + 加入房间 + 大厅联机入口。
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const ORIGIN = 'http://127.0.0.1:8899';
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)]; return s; };
const mkId = () => hex(64) + hex(64) + hex(64) + hex(64);
const pageUrl = (query) => 'file:///E:/jican-simulator-claude/dist-web/index.html?' + new URLSearchParams(query);
const createRoom = async (username, token, id) => {
  const q = new URLSearchParams({ token, id, type: 'create', roomid: '', invcode: '', username });
  const j = await fetch(ORIGIN + '/api/net/join?' + q).then((r) => r.json());
  if (!j.ok) throw new Error('建房失败 ' + JSON.stringify(j));
  return { token, id, roomId: String(j.room.id), invCode: String(j.room.invCode) };
};

const idA = mkId(), tokenA = mkId();
const r1 = await createRoom('房主甲', tokenA, idA);
console.log('=== 建房1 ===', JSON.stringify({ roomId: r1.roomId, invCode: r1.invCode }));
const seatRes = await fetch(ORIGIN + '/api/lobby/room/seat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomid: r1.roomId, id: idA, username: '房主甲', characterId: 's1-01' }) }).then((r) => r.json());
console.log('=== 选座 s1-01 ===', seatRes.ok, seatRes.seat, seatRes.code || '');

const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + process.env.TEMP + '\\jican-online3', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

async function json(path) {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + path); return await r.json(); } catch (e) { await sleep(200); }
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
  if (msg.method === 'Runtime.exceptionThrown') { const d = msg.params.exceptionDetails; logs.push('[exception] ' + (d.exception?.description || d.text)); }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
const nav = async (url, wait) => { await send('Page.navigate', { url }); await sleep(wait); };
const clickText = async (word) => evaluate("(function(){var bs=document.querySelectorAll('button');for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('" + word + "')>=0){bs[i].click();return bs[i].textContent.trim();}}return null;})()");
const setLocalId = async (id) => evaluate("localStorage.setItem('jican.web.idkey','" + id + "')");

// 先打开本地页，写入我们的 id 密钥，保证页面身份与建房 id 一致
await nav('file:///E:/jican-simulator-claude/dist-web/index.html', 4000);
await setLocalId(idA);
await nav(pageUrl({ token: r1.token, id: r1.id, type: 'create', roomid: r1.roomId, invcode: r1.invCode, username: '房主甲', src: ORIGIN }), 7000);
const tA = await evaluate('document.body.innerText');
console.log('=== 房主页 ===', '房间号出现=', (tA || '').indexOf(r1.roomId) >= 0, '已进入=', (tA || '').indexOf('已进入') >= 0, 'data-phase=', await evaluate('document.getElementById("app")?.getAttribute("data-phase")'));
const c1 = await clickText('开始游戏');
await sleep(5000);
const phase1 = await evaluate('document.getElementById("app")?.getAttribute("data-phase")');
const roomAfter = await fetch(ORIGIN + '/api/net/room?roomid=' + r1.roomId).then((r) => r.json());
console.log('=== 点开始游戏 ===', c1, '-> data-phase=', phase1, '服务端 started=', roomAfter.room && roomAfter.room.started);
console.log('=== 房主阶段控制台 ===', logs.slice(-5).join(' ;; ') || '(无)');

// B. 加入房间（换一个 id 密钥）
logs.length = 0;
const idB = mkId(), tokenB = mkId();
const r2 = await createRoom('房主乙', tokenB, mkId());
await setLocalId(idB);
await nav(pageUrl({ token: r2.token, id: idB, type: 'join', roomid: r2.roomId, invcode: r2.invCode, username: '加入测试', src: ORIGIN }), 7000);
const tC = await evaluate('document.body.innerText');
const room2 = await fetch(ORIGIN + '/api/net/room?roomid=' + r2.roomId).then((r) => r.json());
console.log('=== 加入页 ===', '房间号出现=', (tC || '').indexOf(r2.roomId) >= 0, 'data-phase=', await evaluate('document.getElementById("app")?.getAttribute("data-phase")'));
console.log('=== 服务端房间成员 ===', JSON.stringify(room2.room && { members: room2.room.members, seats: room2.room.seats }));
console.log('=== 加入阶段控制台 ===', logs.slice(-5).join(' ;; ') || '(无)');

// C. 大厅「联机」入口
logs.length = 0;
await nav('file:///E:/jican-simulator-claude/dist-web/index.html', 5000);
const tab = await evaluate('JSON.stringify(Array.from(document.querySelectorAll("button")).filter(function(b){return /联机/.test(b.textContent)}).map(function(b){return {t:b.textContent.trim(), d:b.disabled, c:b.className}}))');
console.log('=== 联机按钮 ===', tab);
const entry = await clickText('联机');
await sleep(1500);
const panel = await evaluate('JSON.stringify({net:!!document.querySelector(".net2-panel"), text:(document.querySelector(".net2-panel")||document.body).innerText.slice(0,200)})');
console.log('=== 点击联机入口 ===', entry, panel);
const adv = await clickText('高级');
await sleep(800);
const inputs = await evaluate('JSON.stringify(Array.from(document.querySelectorAll(".net2-panel input")).map(function(i){return {ph:i.placeholder, v:i.value.slice(0,50), type:i.type}}))');
console.log('=== 高级输入框 ===', adv, inputs);
console.log('=== 大厅阶段控制台 ===', logs.slice(-8).join(' ;; ') || '(无)');
const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync('E:\\jican-simulator-claude\\dist-web\\online.png', Buffer.from(shot.result.data, 'base64'));
console.log('=== 截图 dist-web/online.png ===');
ws.close();
chrome.kill();
process.exit(0);