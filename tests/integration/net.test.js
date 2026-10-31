// 集成：真实 HTTP + WebSocket 服务（随机端口、临时存档目录）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../../server/index.js';
import { quiet } from '../helpers.js';

let srv;
let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jican-test-'));
  srv = await startServer({ port: 0, logger: quiet, watch: false, llm: false, saveDir: dir });
});

after(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 简易客户端：收集消息，支持按类型等待。 */
function client(headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers });
  const msgs = [];
  const waiters = [];
  let seq = 0;
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  const api = {
    ws,
    msgs,
    open: () => new Promise((ok, fail) => { ws.once('open', ok); ws.once('error', fail); ws.once('unexpected-response', (_, res) => fail(new Error(`HTTP ${res.statusCode}`))); }),
    send: (type, payload = {}) => ws.send(JSON.stringify({ v: 1, type, seq: ++seq, ts: Date.now(), payload })),
    wait(pred, ms = 3000) {
      const found = msgs.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((ok, fail) => {
        const w = { pred, resolve: ok };
        waiters.push(w);
        setTimeout(() => fail(new Error('等待消息超时')), ms);
      });
    },
    type: (t, extra = () => true) => api.wait((m) => m.type === t && extra(m.payload)),
    close: () => new Promise((ok) => { ws.once('close', ok); ws.close(); }),
  };
  return api;
}

test('HTTP：首页带 CSP、静态资源与 API 可用、目录穿越被拒绝', async () => {
  const base = `http://127.0.0.1:${srv.port}`;
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(base + '/shared/constants.js')).status, 200);
  const map = await (await fetch(base + '/api/map')).json();
  assert.equal(map.pcs.length, 35);
  assert.ok(map.occluders.tall.length > 10);
  assert.equal((await fetch(base + '/shared/../server/index.js')).status, 404);
  assert.equal((await fetch(base + '/js/%2e%2e/%2e%2e/server/index.js')).status, 404);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
  const health = await (await fetch(base + '/debug/health')).json();
  assert.equal(health.llm.mode, 'disabled');
});

test('WebSocket：跨站 Origin 被拒绝', async () => {
  const c = client({ origin: 'http://evil.example.com' });
  await assert.rejects(c.open(), /403/);
});

test('WebSocket：握手、加入、输入校验、暂停、倍速、断线重连补发、结算', async () => {
  const a = client();
  await a.open();
  a.send('ping');
  const err = await a.type('error');
  assert.equal(err.payload.code, 'E_PROTO', '必须先 hello');
  a.send('hello', { clientVersion: '0.1.0' });
  const welcome = await a.type('welcome');
  assert.equal(welcome.payload.role, 'controller');
  assert.equal(welcome.payload.lobby.roster.length, 35);
  const sessionId = welcome.payload.sessionId;

  // 第二个连接只能观战
  const b = client();
  await b.open();
  b.send('hello', {});
  assert.equal((await b.type('welcome')).payload.role, 'spectator');
  b.send('join', { characterId: 's1-02' });
  assert.equal((await b.type('error')).payload.code, 'E_SPECTATOR');
  await b.close();

  a.send('join', { characterId: 's1-01', role: 'student', seed: 4242 });
  await a.type('phase', (p) => p.phase === 'PLAYING');
  const snap = await a.type('snapshot', (p) => p.state.game.phase === 'PLAYING');
  assert.equal(snap.payload.state.game.playerCharId, 's1-01');
  assert.equal(snap.payload.state.game.seed, 4242);

  a.send('input.move', { dir: { x: 9, y: 0 } });
  assert.equal((await a.type('error', (p) => p.code === 'E_BADMSG')).payload.code, 'E_BADMSG');
  a.send('input.action', { kind: 'enterPc', pcId: 'pc-c3-10' });
  assert.equal((await a.type('error', (p) => p.code === 'E_OUTOFRANGE')).payload.code, 'E_OUTOFRANGE');
  a.send('input.action', { kind: 'enterPc', pcId: 'pc-c1-01' });
  const pcDialog = await a.type('dialog', (p) => p.kind === 'pc');
  assert.equal(pcDialog.payload.own, true);
  a.send('input.action', { kind: 'viewScore' });
  const view = await a.type('dialog', (p) => p.kind === 'score_view');
  assert.equal(view.payload.score, 0);
  a.send('input.action', { kind: 'leavePc' });
  await a.type('dialog', (p) => p.kind === 'close');

  a.send('set.speed', { mult: 2 });
  await a.wait((m) => (m.type === 'delta' && m.payload.game?.speedMult === 2) || (m.type === 'snapshot' && m.payload.state.game.speedMult === 2));
  a.send('pause', { on: true });
  await a.type('phase', (p) => p.phase === 'PAUSED');
  a.send('pause', { on: false });
  await a.type('phase', (p) => p.phase === 'PLAYING');

  // 断线：游戏自动暂停；同一会话带 lastSeq 重连后补发增量并自动继续
  const lastSeq = Math.max(...a.msgs.filter((m) => m.type === 'snapshot' || m.type === 'delta').map((m) => m.payload.seq));
  await a.close();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(srv.controller.phase, 'PAUSED');
  assert.equal(srv.controller.state.pausedReason, 'disconnect');
  const a2 = client();
  await a2.open();
  a2.send('hello', { sessionId, lastSeq });
  const w2 = await a2.type('welcome');
  assert.equal(w2.payload.role, 'controller');
  assert.equal(w2.payload.resumed, true);
  const replay = await a2.wait((m) => m.type === 'delta' || m.type === 'snapshot');
  if (replay.type === 'delta') assert.equal(replay.payload.seq, lastSeq + 1, '补发应从断点继续');
  await a2.type('phase', (p) => p.phase === 'PLAYING');

  a2.send('leave');
  const over = await a2.type('gameover');
  assert.equal(over.payload.reason, 'quit');
  assert.equal(over.payload.ranking.students.length, 30);
  assert.ok(over.payload.summary.length > 0);
  a2.send('lobby');
  await a2.type('phase', (p) => p.phase === 'LOBBY');
  await a2.close();
});
