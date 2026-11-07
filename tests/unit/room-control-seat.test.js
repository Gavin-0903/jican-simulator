// 座位制（v0.9）HTTP 路由自测：/api/lobby/room/seat 与 /api/lobby/room/settings。
//
// 为什么单独一个文件：room-control.test.js 已经 490 行，而这一组锁的是
// 「多人房间里谁能动谁的座位」这张权限表，和开局/排队逻辑是两回事，放一起会越读越乱。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { computeIdKey } from '../../server/net/IdKey.js';
import { RoomManager } from '../../server/net/RoomManager.js';
import { LobbyGateway } from '../../server/net/LobbyGateway.js';
import { createLobbyRouter } from '../../server/net/LobbyHttp.js';
import { quiet } from '../helpers.js';

/** 造一个合法（256 位 hex）的 ID 密钥。 */
const makeKey = (n) => computeIdKey({ timezone: 'Asia/Shanghai', mac: `aabbcc0000${n}`, os: 'win-x64', lang: 'zh_CN', username: `u${n}`, appCount: n, rand: String(n).repeat(64).slice(0, 64) });

/** 把大厅路由挂到一个真实 HTTP 服务上（和 room-control.test.js 同一套用法）。 */
async function withRoomControl(fn) {
  const rooms = new RoomManager({ logger: quiet, now: () => 1000 });
  const ownerKey = makeKey(40);
  const created = rooms.create({ idKey: ownerKey, username: '房主' });
  const started = [];
  const controller = { startRound: (arg) => started.push(arg), hasConnection: () => true };
  const lobby = new LobbyGateway({ rooms, controller, logger: quiet });
  let broadcasts = 0;
  const route = createLobbyRouter({
    rooms,
    idKey: ownerKey,
    serverName: '测试源',
    logger: quiet,
    lobby,
    broadcastPlayers: () => { broadcasts += 1; },
  });
  const server = createServer((req, res) => {
    if (!route(req, res)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"ok":false}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const post = async (path, body) => {
    const res = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    return await fn({ origin, rooms, lobby, controller, started, post, room: created.room, ownerKey, broadcasts: () => broadcasts });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---- ⑥ 座位制（v0.9）：谁可以替谁安排座位 / 单局参数 / 开局以座位表为准 ----
//
// 这一组锁住的都是「一个名额外人就能毁掉别人的局面」的问题：
// ① 非房主不能替别人改座位（否则任何人可以把别人的角色抢走或清空）；
// ② 非房主可以给自己落座/让座 —— HTTP 侧只带 idKey，服务端必须自己翻出他是谁；
// ③ 同一个角色不能被两个人坐（两个窗口抢同一个座位会互相覆盖视图）；
// ④ settings 只有房主能改，并且开局时真的作为 overrides 传给 startRound；
// ⑤ 开局是「所有座位一起开」，characters 表只是兜底。

test('claimSeat：房主可以替任何成员指派/清空座位，并且记进 view().seats', async () => {
  await withRoomControl(async ({ post, room, ownerKey, rooms }) => {
    const guestKey = makeKey(70);
    rooms.join({ idKey: guestKey, username: '客人', roomId: room.id, token: room.token, invCode: room.invCode });
    rooms.approve(room.id, ownerKey, '客人');

    const asg = await post('/api/lobby/room/seat', { roomid: room.id, id: ownerKey, username: '客人', characterId: 's1-03' });
    assert.equal(asg.status, 200);
    assert.equal(asg.body.ok, true);
    assert.equal(asg.body.action, 'seat');
    assert.equal(asg.body.username, '客人');
    assert.equal(asg.body.seat, 's1-03');
    assert.equal(asg.body.seats['客人'], 's1-03');
    assert.equal(room.seats.get('客人'), 's1-03');

    // 房主替客人让座（characterId 空）
    const rel = await post('/api/lobby/room/seat', { roomid: room.id, id: ownerKey, username: '客人', characterId: '' });
    assert.equal(rel.status, 200);
    assert.equal(rel.body.seat, null);
    assert.equal(room.seats.has('客人'), false);
  });
});

test('claimSeat：非房主可以给自己落座（idKey 由房间身份表翻译成用户名）', async () => {
  await withRoomControl(async ({ post, room, ownerKey, rooms }) => {
    const guestKey = makeKey(71);
    // 真实链路是 /api/net/join → 校验 token/邀请码 → 房主 approve，身份在这一步就绑定了
    rooms.join({ idKey: guestKey, username: '客人', roomId: room.id, token: room.token, invCode: room.invCode });
    rooms.approve(room.id, ownerKey, '客人');

    // 省略 username = 给自己落座（前端就是这么发的）
    const self = await post('/api/lobby/room/seat', { roomid: room.id, id: guestKey, characterId: 's1-02' });
    assert.equal(self.status, 200, JSON.stringify(self.body));
    assert.equal(self.body.username, '客人', '服务端必须自己认出操作者是谁');
    assert.equal(self.body.seat, 's1-02');
    assert.equal(room.seats.get('客人'), 's1-02');
    assert.equal(room.seats.has('房主'), false, '不能顺手动到房主那一行');
  });
});

test('claimSeat：非房主替别人安排座位 → 403 FORBIDDEN（不能抢座位）', async () => {
  await withRoomControl(async ({ post, room, ownerKey, rooms }) => {
    const guestKey = makeKey(72);
    rooms.join({ idKey: guestKey, username: '客人', roomId: room.id, token: room.token, invCode: room.invCode });
    rooms.approve(room.id, ownerKey, '客人');
    await post('/api/lobby/room/seat', { roomid: room.id, id: ownerKey, characterId: 's1-01' });

    // 客人想把房主的座位抢走
    const steal = await post('/api/lobby/room/seat', { roomid: room.id, id: guestKey, username: '房主', characterId: 't-01' });
    assert.equal(steal.status, 403);
    assert.equal(steal.body.code, 'FORBIDDEN');
    assert.equal(room.seats.get('房主'), 's1-01', '房主的座位不许被别人改');

    // 客人想给另一个人（根本不在房里）安排座位，也一样拒
    const assign = await post('/api/lobby/room/seat', { roomid: room.id, id: guestKey, username: '路人', characterId: 's1-02' });
    assert.equal(assign.status, 403);
    assert.equal(assign.body.code, 'FORBIDDEN');
  });
});

test('claimSeat：还没被审批的人不能选座位（NOT_MEMBER），已开局后座位锁定（ROOM_STARTED）', async () => {
  await withRoomControl(async ({ post, room, ownerKey, rooms }) => {
    const guestKey = makeKey(73);
    rooms.join({ idKey: guestKey, username: '客人', roomId: room.id, token: room.token, invCode: room.invCode });
    const outside = await post('/api/lobby/room/seat', { roomid: room.id, id: guestKey, characterId: 's1-02' });
    assert.equal(outside.status, 403);
    assert.equal(outside.body.code, 'NOT_MEMBER');

    rooms.approve(room.id, ownerKey, '客人');
    assert.equal((await post('/api/lobby/room/seat', { roomid: room.id, id: guestKey, characterId: 's1-02' })).status, 200);
    rooms.start(room.id, ownerKey);
    const locked = await post('/api/lobby/room/seat', { roomid: room.id, id: ownerKey, username: '客人', characterId: 's1-04' });
    assert.equal(locked.status, 403);
    assert.equal(locked.body.code, 'ROOM_STARTED');
  });
});

test('resolve：ws 直连进房（没走 HTTP /api/net/join）也补绑身份 —— 审批后能自己选座，选完座位就是控制端', async () => {
  await withRoomControl(async ({ post, room, ownerKey, rooms, lobby }) => {
    const guestKey = makeKey(75);
    // 移动端 / 点邀请链接的真实形状：前端只连 /lobby 一条 ws，不调 /api/net/join。
    // 老实现里 resolve 的 join 分支在 pending / member 两处都提前 return，跳过 usernames.set，
    // 于是服务端不知道 guestKey 是「客人」，选座被判成「只有房主可以替别人安排座位」403 —— 用户报的
    // 「联机时移动端无法选择位置」。这里钉死：握手阶段就要把身份记进房间身份表。
    const qs = `?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&id=${guestKey}&username=${encodeURIComponent('客人')}`;
    const hello = lobby.resolve(qs);
    assert.equal(hello.ok, true);
    assert.equal(hello.pending, true, '还没审批：先挂申请队列');
    assert.equal(rooms.identityOf(room, guestKey), '客人', '握手阶段就补绑 idKey → username');

    rooms.approve(room.id, ownerKey, '客人');
    const self = await post('/api/lobby/room/seat', { roomid: room.id, id: guestKey, characterId: 's1-02' });
    assert.equal(self.status, 200, JSON.stringify(self.body));
    assert.equal(self.body.username, '客人', '服务端必须自己认出操作者是谁');
    assert.equal(room.seats.get('客人'), 's1-02');

    // 第二半：座位判定 isSeat 也依赖同一张表 —— 不补绑的话成员重连后永远被当成观战者，
    // 房主开局了他也收不到私有包（用户报的「成员没有开始游戏」）。
    const again = lobby.resolve(qs);
    assert.equal(again.seat, true, '选完座位重连必须是控制端');
    assert.equal(again.role, 'controller');
  });
});

test('resolve：ws 直连不抢别人已经认领的用户名（拿邀请链接也顶不了座）', async () => {
  await withRoomControl(async ({ room, ownerKey, rooms, lobby }) => {
    const guestKey = makeKey(76);
    rooms.join({ idKey: guestKey, username: '客人', roomId: room.id, token: room.token, invCode: room.invCode });
    rooms.approve(room.id, ownerKey, '客人');

    const thiefKey = makeKey(77);
    const out = lobby.resolve(`?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&id=${thiefKey}&username=${encodeURIComponent('客人')}`);
    assert.equal(out.ok, true);
    assert.equal(rooms.identityOf(room, thiefKey), null, '别人的名字不许被抢绑');
    assert.equal(rooms.identityOf(room, guestKey), '客人', '原绑定不动');
  });
});

test('claimSeat：同一个角色不能被两个人同时坐（SEAT_TAKEN），本人重复选同一个座位是幂等的', async () => {
  await withRoomControl(async ({ post, room, ownerKey, rooms }) => {
    const guestKey = makeKey(74);
    rooms.join({ idKey: guestKey, username: '客人', roomId: room.id, token: room.token, invCode: room.invCode });
    rooms.approve(room.id, ownerKey, '客人');
    await post('/api/lobby/room/seat', { roomid: room.id, id: ownerKey, characterId: 's1-01' });

    const again = await post('/api/lobby/room/seat', { roomid: room.id, id: ownerKey, characterId: 's1-01' });
    assert.equal(again.status, 200);
    assert.equal(room.seats.get('房主'), 's1-01');

    const taken = await post('/api/lobby/room/seat', { roomid: room.id, id: guestKey, characterId: 's1-01' });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.code, 'SEAT_TAKEN');
    assert.equal(room.seats.has('客人'), false);
  });
});

test('claimSeat：房间不存在 → 404；不传 characterId 字段按「让座」处理', async () => {
  await withRoomControl(async ({ post, room, ownerKey }) => {
    const gone = await post('/api/lobby/room/seat', { roomid: '000000', id: ownerKey, characterId: 's1-01' });
    assert.equal(gone.status, 404);
    assert.equal(gone.body.code, 'ROOM_NOT_FOUND');

    await post('/api/lobby/room/seat', { roomid: room.id, id: ownerKey, characterId: 's1-01' });
    const noField = await post('/api/lobby/room/seat', { roomid: room.id, id: ownerKey });
    assert.equal(noField.status, 200);
    assert.equal(noField.body.seat, null, '没传 characterId = 让座');
    assert.equal(room.seats.has('房主'), false);
  });
});

test('settings：只有房主能改，只覆盖传入的键，null 表示回默认', async () => {
  await withRoomControl(async ({ post, room, ownerKey }) => {
    const ok = await post('/api/lobby/room/settings', { roomid: room.id, id: ownerKey, durationMs: 120000, targetScore: 1500 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.action, 'settings');
    assert.equal(ok.body.settings.durationMs, 120000);
    assert.equal(ok.body.settings.targetScore, 1500);
    assert.equal(ok.body.room.settings.targetScore, 1500, 'view() 里也要看得到');

    // 只改一项：另一项保持不变（不能顺手清空）
    const one = await post('/api/lobby/room/settings', { roomid: room.id, id: ownerKey, targetScore: 900 });
    assert.equal(one.body.settings.targetScore, 900);
    assert.equal(one.body.settings.durationMs, 120000);

    // 传 null = 回默认
    const back = await post('/api/lobby/room/settings', { roomid: room.id, id: ownerKey, durationMs: null });
    assert.equal(back.body.settings.durationMs, null);

    const notOwner = await post('/api/lobby/room/settings', { roomid: room.id, id: makeKey(75), durationMs: 1000 });
    assert.equal(notOwner.status, 403);
    assert.equal(notOwner.body.code, 'NOT_OWNER');
  });
});

test('startRoom：座位表是角色事实源，settings 作为 round overrides 传给 startRound', async () => {
  const rooms = new RoomManager({ logger: quiet });
  const ownerKey = makeKey(76);
  const { room } = rooms.create({ idKey: ownerKey, username: '房主' });
  const guestKey = makeKey(77);
  rooms.join({ idKey: guestKey, username: '客人', roomId: room.id, token: room.token, invCode: room.invCode });
  rooms.approve(room.id, ownerKey, '客人');
  rooms.claimSeat(room.id, ownerKey, '房主', 's1-01');
  rooms.claimSeat(room.id, guestKey, '客人', 's1-03', '客人');
  rooms.setSettings(room.id, ownerKey, { durationMs: 300000, targetScore: 1200 });

  const started = [];
  const controller = { startRound: (arg) => started.push(arg), hasConnection: () => true, roster: [] };
  const lobby = new LobbyGateway({ rooms, controller, logger: quiet });
  const out = lobby.startRoom(room.id, ownerKey);
  assert.equal(out.ok, true, out.message);
  assert.equal(started.length, 1);
  const arg = started[0];
  assert.equal(arg.characterId, 's1-01', '房主自己的角色');
  assert.equal(arg.seed, null);
  assert.deepEqual(arg.seats, { 房主: 's1-01', 客人: 's1-03' }, '两个座位都要开成人');
  assert.deepEqual(arg.round, { durationMs: 300000, targetScore: 1200 }, '房间参数作为 overrides');

  // 没设过参数：round 里两个键都是 null（由 GameController 回默认），不能凭空塞值
  const rooms2 = new RoomManager({ logger: quiet });
  const owner2 = makeKey(78);
  const r2 = rooms2.create({ idKey: owner2, username: '房主' }).room;
  rooms2.claimSeat(r2.id, owner2, '房主', 's1-01');
  const started2 = [];
  const lobby2 = new LobbyGateway({ rooms: rooms2, controller: { startRound: (a) => started2.push(a), hasConnection: () => true }, logger: quiet });
  assert.equal(lobby2.startRoom(r2.id, owner2).ok, true);
  assert.deepEqual(started2[0].round, { durationMs: null, targetScore: null });
});

test('startRoom：房主没选座位但 characters 表里有（老前端）→ 仍能开局，座位表补上房主', async () => {
  const rooms = new RoomManager({ logger: quiet });
  const ownerKey = makeKey(79);
  const { room } = rooms.create({ idKey: ownerKey, username: '房主' });
  const started = [];
  const lobby = new LobbyGateway({ rooms, controller: { startRound: (a) => started.push(a), hasConnection: () => true }, logger: quiet });
  lobby.setCharacter(ownerKey, 's1-01', '房主');
  const out = lobby.startRoom(room.id, ownerKey);
  assert.equal(out.ok, true, out.message);
  assert.equal(out.characterId, 's1-01');
  assert.deepEqual(started[0].seats, { 房主: 's1-01' }, '至少要给房主自己开一个座位，否则全员黑屏');
});
