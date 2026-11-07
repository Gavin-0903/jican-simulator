// 真起一个服务端 + 两条 /lobby 连接，验证「每个座位玩家各看各的」。
//
// 为什么值得单写一个 integration：单测能证明 Snapshot/GameController 的接口对，
// 但把「房间座位表 → viewerKey → controller 私有包」这条链子接起来的线
// （WsServer 的 viewerConns / onPrivateTo、MessageRouter 的 attachSeat）只有真的走一遍 ws 才会露馅。
// 这里起的是端口 0 的一次性实例，不碰仓库里的 config/default.json，也不写用户目录。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { computeIdKey } from '../../server/net/IdKey.js';
import { encode, parseMessage } from '../../server/net/Protocol.js';
import { MSG, PHASE } from '../../shared/constants.js';
import { startServer } from '../../server/index.js';

const quiet = { info() {}, warn() {}, error() {} };
const makeKey = (n) => computeIdKey({ timezone: 'Asia/Shanghai', mac: 'aabbcc' + String(n).padStart(4, '0'), os: 'win-x64', lang: 'zh_CN', username: 'seatprobe' + n, appCount: n, rand: String(n).repeat(64).slice(0, 64) });

/** 起一个一次性服务端（端口 0、临时存档目录、关掉 LLM 与 tailscale 探测）。 */
async function bootApp() {
  const home = mkdtempSync(join(tmpdir(), 'jican-seat-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', logger: quiet, watch: false, llm: false, saveDir: join(home, 'saves'), isServerSource: true, tailscale: false });
  return {
    port: srv.port,
    async stop() {
      try { await srv.close(); } catch { /* 已关 */ }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 连一条 /lobby：发 hello，收到 welcome 即认为就绪，过程中收到的包都攒着。 */
function connect(port, query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/lobby?' + query, { origin: 'http://127.0.0.1:' + port });
    const box = { ws, msgs: [], close: () => { try { ws.close(); } catch { /* 忽略 */ } } };
    const timer = setTimeout(() => reject(new Error('连接超时')), 8000);
    ws.on('message', (data) => {
      // 服务端下行包不经过 C2S 校验，直接读 JSON 信封 { v, seq, type, payload }
      let env = null;
      try { env = JSON.parse(String(data)); } catch { return; }
      if (!env || !env.type) return;
      const type = env.type;
      const payload = env.payload;
      box.msgs.push([type, payload]);
      if (type === MSG.WELCOME) { clearTimeout(timer); resolve(box); }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('open', () => ws.send(encode(MSG.HELLO, { lastSeq: null }, 1)));
  });
}

const lastOf = (box, type) => {
  for (let i = box.msgs.length - 1; i >= 0; i--) if (box.msgs[i][0] === type) return box.msgs[i][1];
  return null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(50); }
  return null;
}
const post = async (port, path, body) => {
  const res = await fetch('http://127.0.0.1:' + port + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('两个座位玩家各收各的 snapshot：me / playerCharId 是自己的角色，互不串台', async () => {
  const app = await bootApp();
  const ownerKey = makeKey(1);
  const guestKey = makeKey(2);
  let a = null;
  let b = null;
  try {
    const created = await fetch('http://127.0.0.1:' + app.port + '/api/net/join?token=' + '0'.repeat(64) + '&id=' + ownerKey + '&type=create&roomid=&invcode=&username=' + encodeURIComponent('房主'));
    const room = (await created.json()).room;
    assert.ok(room?.id, '建房失败');
    await fetch('http://127.0.0.1:' + app.port + '/api/net/join?token=' + room.token + '&id=' + guestKey + '&type=join&roomid=' + room.id + '&invcode=' + room.invCode + '&username=' + encodeURIComponent('客人'));
    const ap = await post(app.port, '/api/lobby/room/approve', { roomid: room.id, id: ownerKey, username: '客人' });
    assert.equal(ap.status, 200, JSON.stringify(ap.body));

    // 注意 query 键名：resolve 读的是 username（不是 name），且必须带 type/roomid
    const q = (key, name) => 'type=join&token=' + room.token + '&id=' + key + '&roomid=' + room.id + '&invcode=' + room.invCode + '&username=' + encodeURIComponent(name);
    a = await connect(app.port, q(ownerKey, '房主'));
    b = await connect(app.port, q(guestKey, '客人'));

    // 两人各选不同角色：ws 的 JOIN 在联机路径下 = 落座（不开局）
    // 注意：JOIN 的 schema 里没有 t 字段（严格校验，多一个键就是 E_BADMSG）
    a.ws.send(encode(MSG.JOIN, { characterId: 's1-01' }, 2));
    b.ws.send(encode(MSG.JOIN, { characterId: 's1-03' }, 2));
    const seatedA = await waitFor(() => lastOf(a, MSG.PONG)?.seated === 's1-01');
    const seatedB = await waitFor(() => lastOf(b, MSG.PONG)?.seated === 's1-03');
    if (!(seatedA && seatedB)) {
      const w = (box) => { const m = box.msgs.find(([t]) => t === MSG.WELCOME); return JSON.stringify(m?.[1]?.room ?? null); };
      const errs = (box) => JSON.stringify(box.msgs.filter(([t]) => t === MSG.ERROR).map(([, p]) => p));
      assert.fail('落座失败 [wA=' + w(a) + '] [wB=' + w(b) + '] [errB=' + errs(b) + ']');
    }

    // 房主开局（HTTP start，全座位一起开）
    const st = await post(app.port, '/api/lobby/room/start', { roomid: room.id, id: ownerKey });
    assert.equal(st.status, 200, JSON.stringify(st.body));

    // 快照信封：{ state: { game:{phase,playerCharId}, chars, pcs, me } }；每帧都会刷
    // 注意：开局那一刻发出的 snapshot 是「还没 install 完」的那份（phase 仍是 LOBBY），
    // 之后循环每 tick 发的是 DELTA，只有每 fullSnapshotMs（2s）才发全量 snapshot。
    // 所以判阶段必须「快照和它之后的 delta 一起看」，只盯 SNAPSHOT 会永远等不到 playing。
    const viewOf = (box) => {
      const view = { game: null };
      for (const [t, p] of box.msgs) {
        if (t === MSG.SNAPSHOT) {
          view.game = p?.state?.game ? { ...p.state.game } : null;
          if (p?.state?.me !== undefined) view.me = p.state.me;
          if (p?.state?.roster !== undefined) view.roster = p.state.roster;
        } else if (t === MSG.DELTA && view.game) {
          if (p?.game) view.game = { ...view.game, ...p.game };
          if (p?.me) view.me = { ...(view.me ?? {}), ...p.me };
        }
      }
      return view;
    };
    const isPlaying = (v) => Boolean(v.game && (v.game.phase === PHASE.PLAYING || v.game.phase === 'playing'));
    const okA = await waitFor(() => isPlaying(viewOf(a)));
    const okB = await waitFor(() => isPlaying(viewOf(b)));
    if (!(okA && okB)) {
      const g = (box) => JSON.stringify(viewOf(box).game?.phase);
      const hist = (box) => box.msgs.slice(-14).map(([t, p]) => t + (t === MSG.SNAPSHOT ? ':' + p?.state?.game?.phase + '/seq' + p?.seq : t === MSG.DELTA ? ':seq' + p?.seq : '')).join(' , ');
      assert.fail('没等到 PLAYING [A ' + g(a) + '] [B ' + g(b) + '] [phaseA=' + JSON.stringify(lastOf(a, MSG.PHASE)) + '] [histA=' + hist(a) + '] [histB=' + hist(b) + ']');
    }
    const sa = viewOf(a);
    const sb = viewOf(b);
    assert.ok(sa.me, '座位玩家的 me 不能是 null');
    assert.ok(sb.me, '座位玩家的 me 不能是 null');
    assert.equal(sa.me.id, 's1-01', '房主看到的是自己的角色');
    assert.equal(sb.me.id, 's1-03', '客人看到的必须是自己那个角色');
    assert.equal(sa.game.playerCharId, 's1-01');
    assert.equal(sb.game.playerCharId, 's1-03', '结算按 playerCharId 判输赢，串台等于把别人的分当自己的');
    // 互不串台的最硬判据：两份视图里「自己的」和「别人的」都必须对得上
    assert.notEqual(JSON.stringify(sa.me), JSON.stringify(sb.me), '两人的 me 不能是同一份');
    assert.equal(sa.roster.length, sb.roster.length, '两人看到的角色总表应该一致（只是 me 不同）');
    assert.notEqual(sa.game.seed, undefined, '开局要有种子（同一房间两人看到同一个）');
    assert.equal(sa.game.seed, sb.game.seed, '同一局两人看到同一个种子');
    console.log('  ▶ 甲 welcome.room.characterId=' + (a.msgs.find(([t]) => t === MSG.WELCOME)?.[1]?.room?.characterId) + ' view me=' + sa.me.id + ' playerCharId=' + sa.game.playerCharId);
    console.log('  ▶ 乙 welcome.room.characterId=' + (b.msgs.find(([t]) => t === MSG.WELCOME)?.[1]?.room?.characterId) + ' view me=' + sb.me.id + ' playerCharId=' + sb.game.playerCharId);

    // 结算也要按人头：房主退出（结束这一局），两人各收到自己那份 gameover
    a.ws.send(encode(MSG.LEAVE, {}, 3));
    const ga = await waitFor(() => lastOf(a, MSG.GAMEOVER));
    const gb = await waitFor(() => lastOf(b, MSG.GAMEOVER));
    assert.ok(ga && gb, '两人都要收到结算包');
    assert.equal(ga.playerCharId, 's1-01', '房主的结算包写的是自己的角色');
    assert.equal(gb.playerCharId, 's1-03', '客人的结算包必须写他自己的角色，不能跟着房主');
    assert.equal(ga.winnerId, gb.winnerId, '名次判定是全局的，两人看到的冠军必须是同一个');
    assert.equal(JSON.stringify(ga.ranking), JSON.stringify(gb.ranking), '排名表一致，只有「我是谁」不同');
    console.log('  ▶ gameover 甲 playerCharId=' + ga.playerCharId + ' 乙 playerCharId=' + gb.playerCharId + ' winner=' + ga.winnerId);

    // 结算后 120 秒离开（需求 m01341）：刚结算时房间还在，两人都还能看到排名；
    // 房主点「返回大厅」才删房并广播 room.closed。
    const still = await fetch('http://127.0.0.1:' + app.port + '/api/net/room?roomid=' + room.id);
    const stillBody = await still.json();
    assert.equal(stillBody.ok, true, '结算后要先保留房间（120 秒看排名）');

    a.ws.send(encode(MSG.LOBBY, {}, 4));
    const closedA = await waitFor(() => lastOf(a, MSG.ROOM_CLOSED));
    const closedB = await waitFor(() => lastOf(b, MSG.ROOM_CLOSED));
    assert.ok(closedA && closedB, '房主返回大厅后两人都要收到 room.closed');
    assert.equal(closedA.roomId, room.id, 'room.closed 要带被删的房间号');
    // 房间号立刻失效：GET /api/net/room 是前端判断「房间还在不在」的兜底接口。
    const gone = await fetch('http://127.0.0.1:' + app.port + '/api/net/room?roomid=' + room.id);
    const goneBody = await gone.json();
    assert.equal(goneBody.ok, false, '房主返回大厅后房间必须已从服务器删除');
    assert.ok(!goneBody.room, '已删除的房间不能再查得到');
    console.log('  ▶ 房主返回大厅后房间 ' + room.id + ' 已删除，双方收到 room.closed');
  } finally {
    a?.close();
    b?.close();
    await app.stop();
  }
});

test('没坐座位的观战者：收公共视图（me=null）且开局后仍在推进，看不到别人的 me', async () => {
  const app = await bootApp();
  const ownerKey = makeKey(3);
  const guestKey = makeKey(4);
  const watchKey = makeKey(5);
  let a = null;
  let w = null;
  try {
    const created = await fetch('http://127.0.0.1:' + app.port + '/api/net/join?token=' + '0'.repeat(64) + '&id=' + ownerKey + '&type=create&roomid=&invcode=&username=' + encodeURIComponent('房主'));
    const room = (await created.json()).room;
    await fetch('http://127.0.0.1:' + app.port + '/api/net/join?token=' + room.token + '&id=' + guestKey + '&type=join&roomid=' + room.id + '&invcode=' + room.invCode + '&username=' + encodeURIComponent('客人'));
    await fetch('http://127.0.0.1:' + app.port + '/api/net/join?token=' + room.token + '&id=' + watchKey + '&type=join&roomid=' + room.id + '&invcode=' + room.invCode + '&username=' + encodeURIComponent('观众'));
    await post(app.port, '/api/lobby/room/approve', { roomid: room.id, id: ownerKey, username: '客人' });
    await post(app.port, '/api/lobby/room/approve', { roomid: room.id, id: ownerKey, username: '观众' });

    const q = (key, name) => 'type=join&token=' + room.token + '&id=' + key + '&roomid=' + room.id + '&invcode=' + room.invCode + '&username=' + encodeURIComponent(name);
    a = await connect(app.port, q(ownerKey, '房主'));
    w = await connect(app.port, q(watchKey, '观众'));

    // 观众不选座，welcome 里必须是 spectator + seat:false
    const wr = w.msgs.find(([t]) => t === MSG.WELCOME)?.[1]?.room;
    assert.equal(wr?.role, 'spectator', '没选座位的人就是观战');
    assert.equal(wr?.seat, false);

    a.ws.send(encode(MSG.JOIN, { characterId: 's1-01' }, 2));
    assert.ok(await waitFor(() => lastOf(a, MSG.PONG)?.seated === 's1-01'), '房主落座失败');

    const st = await post(app.port, '/api/lobby/room/start', { roomid: room.id, id: ownerKey });
    assert.equal(st.status, 200, JSON.stringify(st.body));

    // 观战者要能跟上开局：靠的是他自己的公共视图增量（没有这条通道，画面会永远停在进场那一帧）
    const playing = (box) => {
      let phase = null;
      for (const [t, p] of box.msgs) {
        if (t === MSG.SNAPSHOT) phase = p?.state?.game?.phase ?? phase;
        else if (t === MSG.DELTA && p?.game?.phase) phase = p.game.phase;
      }
      return phase;
    };
    const gotPhase = await waitFor(() => playing(w) === PHASE.PLAYING || playing(w) === 'playing');
    assert.ok(gotPhase, '观战者必须收到 playing（当前 ' + playing(w) + '）');

    // 公共视图：me 恒为 null；playerCharId 是主玩家（全局视角）
    const lastSnap = lastOf(w, MSG.SNAPSHOT);
    assert.ok(lastSnap, '观战者要收到快照');
    assert.equal(lastSnap.state.me, null, '观战者不能拿到别人的 me 面板');
    assert.equal(lastSnap.state.game.playerCharId, 's1-01', '公共视图的 playerCharId 是主玩家（全局口径）');
  } finally {
    a?.close();
    w?.close();
    await app.stop();
  }
});
