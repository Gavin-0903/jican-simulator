// 房间控制（v0.8）自测：开局锁房 / 排队审批 / 踢人 / 房主控制路由。
//
// 锁住四件事：
// ① 房主点了「开始游戏」之后，join 必须被拒（ROOM_STARTED），房主自己重连不受影响；
// ② join 不再直接进 members，而是挂在 pending 队列里等审批 —— 而且 probe 绝不产生副作用；
// ③ 踢人/审批/开局只能房主做（非房主一律 403 NOT_OWNER），被踢的人再 join 是 KICKED；
// ④ 四条第 /api/lobby/room/* 路由的字段名与状态码和前端约定一致。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { computeIdKey } from '../../server/net/IdKey.js';
import { RoomManager } from '../../server/net/RoomManager.js';
import { LobbyGateway } from '../../server/net/LobbyGateway.js';
import { createLobbyRouter } from '../../server/net/LobbyHttp.js';
import { MessageRouter } from '../../server/net/MessageRouter.js';
import { GAMEOVER_LEAVE_MS, MSG } from '../../shared/constants.js';
import { quiet } from '../helpers.js';

/** 造一个合法（256 位 hex）的 ID 密钥。 */
const makeKey = (n) => computeIdKey({ timezone: 'Asia/Shanghai', mac: `aabbcc0000${n}`, os: 'win-x64', lang: 'zh_CN', username: `u${n}`, appCount: n, rand: String(n).repeat(64).slice(0, 64) });

/** 一间房 + 一个网关 + 一个假的 controller（记录 startRound 收到了什么）。 */
const setup = (n = 1) => {
  const rooms = new RoomManager({ logger: quiet, now: () => 1000 });
  const ownerKey = makeKey(n);
  const created = rooms.create({ idKey: ownerKey, username: '房主' });
  const started = [];
  const controller = { startRound: (arg) => started.push(arg), hasConnection: () => true };
  const lobby = new LobbyGateway({ rooms, controller, logger: quiet });
  return { rooms, lobby, controller, started, ownerKey, room: created.room };
};

/** 走 resolve 的 join 一路（和 ws 握手用的是同一段判定）。 */
const joinQs = (room) => `?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&id=${makeKey(200)}&username=客人`;

// ---- ① 开局锁房 ----

test('房间开局后不再接受新成员：join → ROOM_STARTED，房主 create 重连不受影响', () => {
  const { rooms, lobby, ownerKey, room } = setup(1);
  // 开局前：join 能进申请队列
  assert.equal(lobby.resolve(joinQs(room)).ok, true);
  assert.equal(rooms.start(room.id, ownerKey).ok, true);
  // 开局后：同一个 join 被拒
  const out = lobby.resolve(joinQs(room));
  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
  assert.equal(out.code, 'ROOM_STARTED');
  assert.match(out.message, /已开始游戏/);
  // 房主自己重连（create 一路）完全不受影响
  const owner = lobby.resolve(`?type=create&roomid=${room.id}&token=${room.token}&id=${ownerKey}&username=房主`);
  assert.equal(owner.ok, true);
  assert.equal(owner.role, 'controller');
  assert.equal(owner.seat, true);
});

test('房主选好角色后 startRoom 真的开局（并锁房），view 里能看到 started', () => {
  const { lobby, started, ownerKey, room } = setup(2);
  lobby.setCharacter(ownerKey, 's1-01');
  const out = lobby.startRoom(room.id, ownerKey);
  assert.equal(out.ok, true);
  assert.equal(out.started, true);
  assert.equal(out.characterId, 's1-01');
  assert.equal(out.view.started, true, 'view 里要能看到 started');
  assert.equal(started.length, 1, '真的调了 controller.startRound');
  // v0.9 座位制：startRound 的入参多了 round（单局时长/目标分，null=用默认）与 seats（座位表快照），
  // 所以不能再整对象 deepEqual，只钉住这次改动真正关心的三个字段。
  assert.equal(started[0].characterId, 's1-01');
  assert.equal(started[0].seed, null);
  assert.deepEqual(started[0].seats, { 房主: 's1-01' });
  // 开局后 join 一律被拒
  assert.equal(lobby.resolve(joinQs(room)).code, 'ROOM_STARTED');
});

test('没选角色就开局 → NO_CHARACTER（不能靠 startRound 抛 500 兜着）', () => {
  const { lobby, ownerKey, room } = setup(3);
  const out = lobby.startRoom(room.id, ownerKey);
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.equal(out.code, 'NO_CHARACTER');
  // 座位制后文案是「请先在房间里选好座位」——断言语义而不是原字面
  assert.match(out.message, /选好座位/);
  assert.equal(lobby.rooms.rooms.get(room.id).started, false, '失败不能留下「已开局」的状态位');
});

test('非房主开局 / 踢人 / 审批一律 NOT_OWNER（房间只能由房主控制）', () => {
  const { rooms, lobby, ownerKey, room } = setup(4);
  const other = makeKey(44);
  lobby.setCharacter(ownerKey, 's1-01');
  const st = lobby.startRoom(room.id, other);
  assert.equal(st.ok, false);
  assert.equal(st.status, 403);
  assert.equal(st.code, 'NOT_OWNER');
  assert.equal(rooms.rooms.get(room.id).started, false);

  rooms.addPending(room, { idKey: other, username: '客人' });
  const kk = rooms.kick(room.id, other, '客人');
  assert.equal(kk.ok, false);
  assert.equal(kk.code, 'NOT_OWNER');
  assert.equal(kk.status, 403);
  const ap = rooms.approve(room.id, other, '客人');
  assert.equal(ap.ok, false);
  assert.equal(ap.code, 'NOT_OWNER');
  const rj = rooms.reject(room.id, other, '客人');
  assert.equal(rj.ok, false);
  assert.equal(rj.code, 'NOT_OWNER');
  // 非房主折腾一圈之后房间里什么都没变
  assert.equal(rooms.rooms.get(room.id).started, false);
  assert.equal(room.members.has('客人'), false);
  assert.equal(room.pending.length, 1, '申请还在队列里');
});

// ---- ② 排队制 ----

test('join 只进 pending 不进 members，且重复申请幂等（不动队列长度）', () => {
  const { rooms, lobby, room } = setup(5);
  const out = lobby.resolve(joinQs(room));
  assert.equal(out.ok, true);
  assert.equal(out.pending, true);
  assert.equal(out.seat, false);
  assert.equal(out.role, 'pending');
  assert.equal(room.pending.length, 1);
  assert.equal(room.members.has('客人'), false, '没审批就不是成员');
  assert.equal(room.members.size, 1, 'members 里只有房主');
  assert.equal(rooms.view(room).pendingCount, 1, 'view 要暴露 pendingCount');

  // 再申请一次：队列长度不变，只是刷新时间戳
  const again = lobby.resolve(joinQs(room));
  assert.equal(again.ok, true);
  assert.equal(again.pending, true);
  assert.equal(room.pending.length, 1, '同一用户名重复申请不该堆出第二条');
});

test('probe 绝无副作用：不建房间、不占座、不进成员、不进申请队列', () => {
  const { rooms, lobby, room } = setup(6);
  const out = lobby.resolve(joinQs(room), { probe: true });
  assert.equal(out.ok, true);
  assert.equal(room.pending.length, 0, 'probe 不能产生入房申请');
  assert.equal(room.members.size, 1, 'probe 不能加成员');
  assert.equal(rooms.rooms.size, 1, 'probe 不能造房间');
});

// ---- ③ 踢人 / 审批 ----

test('踢人之后：成员消失、再 join 直接 KICKED 且不进申请队列', () => {
  const { rooms, lobby, ownerKey, room } = setup(7);
  // 先把客人审批进来
  rooms.addPending(room, { idKey: makeKey(200), username: '客人' });
  assert.equal(rooms.approve(room.id, ownerKey, '客人').ok, true);
  assert.equal(room.members.has('客人'), true);

  const out = rooms.kick(room.id, ownerKey, '客人');
  assert.equal(out.ok, true);
  assert.equal(room.members.has('客人'), false, '被踢的人从成员里删掉');
  assert.equal(room.kicked.has('客人'), true, '进黑名单');

  const again = lobby.resolve(joinQs(room));
  assert.equal(again.ok, false);
  assert.equal(again.status, 403);
  assert.equal(again.code, 'KICKED');
  assert.match(again.message, /移出房间/);
  assert.equal(room.pending.length, 0, '被踢的人不能靠重新申请回来');
});

test('kick 会把「还没审批的申请」一起清掉（拉黑 + 从队列删）', () => {
  const { rooms, ownerKey, room } = setup(8);
  rooms.addPending(room, { idKey: makeKey(201), username: '捣乱的' });
  assert.equal(room.pending.length, 1);
  assert.equal(rooms.kick(room.id, ownerKey, '捣乱的').ok, true);
  assert.equal(room.pending.length, 0);
  assert.equal(room.kicked.has('捣乱的'), true);
});

test('房主不能踢自己（CANNOT_KICK_OWNER）', () => {
  const { rooms, ownerKey, room } = setup(9);
  const out = rooms.kick(room.id, ownerKey, '房主');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'CANNOT_KICK_OWNER');
  assert.equal(room.members.has('房主'), true);
});

test('approve 把申请移进 members；没有这条申请 → NO_PENDING；已被踢的 → KICKED', () => {
  const { rooms, ownerKey, room } = setup(10);
  rooms.addPending(room, { idKey: makeKey(202), username: '客人' });
  assert.equal(rooms.approve(room.id, ownerKey, '客人').ok, true);
  assert.equal(room.members.has('客人'), true);
  assert.equal(room.pending.length, 0, '审批后从队列里删掉');

  const missing = rooms.approve(room.id, ownerKey, '查无此人');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NO_PENDING');
  assert.equal(missing.status, 404);

  // 补一条申请，但把人拉黑，再审批 → KICKED
  rooms.addPending(room, { idKey: makeKey(203), username: '黑名单' });
  room.kicked.add('黑名单');
  const blocked = rooms.approve(room.id, ownerKey, '黑名单');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'KICKED');
});

test('reject 把申请踢出队列并拉黑（之后 join 是 KICKED）', () => {
  const { rooms, lobby, ownerKey, room } = setup(11);
  const guestKey = makeKey(204);
  rooms.addPending(room, { idKey: guestKey, username: '客人' });
  const out = rooms.reject(room.id, ownerKey, '客人');
  assert.equal(out.ok, true);
  assert.equal(room.pending.length, 0);
  assert.equal(room.kicked.has('客人'), true);
  assert.equal(room.members.has('客人'), false);
  const again = lobby.resolve(joinQs(room));
  assert.equal(again.code, 'KICKED');
});

// ---- playerList 的 role=pending ----

test('playerList 给每条未审批申请输出 role=pending（online:false、characterId:null、idKey 只给 8 位）', () => {
  const { lobby, ownerKey, room } = setup(12);
  const guestKey = makeKey(205);
  lobby.resolve(`?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&id=${guestKey}&username=客人`);
  lobby.setCharacter(ownerKey, 's1-01');
  const list = lobby.playerList();
  assert.equal(list.length, 2, '房主 + 一条申请');
  const owner = list.find((p) => p.role === 'owner');
  const pend = list.find((p) => p.role === 'pending');
  assert.ok(owner, '房主那条还在');
  assert.ok(pend, '申请那条要出现，否则房主不知道有人在门口等');
  // 字段名与其它条目完全一致（前端同一个表格渲染）
  assert.deepEqual(Object.keys(pend).sort(), ['characterId', 'idKey', 'online', 'role', 'roomId', 'username']);
  assert.equal(pend.username, '客人');
  assert.equal(pend.characterId, null);
  assert.equal(pend.online, false, '没真正进来，不算在线');
  assert.equal(pend.roomId, room.id);
  assert.equal(pend.idKey, guestKey.slice(0, 8), '只给 8 位提示，不泄露完整密钥');

  // 审批之后这条从 pending 变成 spectator
  lobby.rooms.approve(room.id, ownerKey, '客人');
  const after = lobby.playerList();
  assert.equal(after.filter((p) => p.role === 'pending').length, 0);
  assert.equal(after.filter((p) => p.role === 'spectator').length, 1);
});

// ---- ④ HTTP 路由 ----

/** 把大厅路由挂到一个真实 HTTP 服务上（和 lobby-gateway.test.js 同一套用法）。 */
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

test('POST /api/lobby/room/start：房主开局 200 + started/room，非房主 403 NOT_OWNER，没角色 400 NO_CHARACTER', async () => {
  await withRoomControl(async ({ post, started, room, ownerKey, lobby }) => {
    // 没选角色先开 → 400 NO_CHARACTER
    const noChar = await post('/api/lobby/room/start', { roomid: room.id, id: ownerKey });
    assert.equal(noChar.status, 400);
    assert.equal(noChar.body.code, 'NO_CHARACTER');
    assert.match(noChar.body.error, /选好座位/);

    lobby.setCharacter(ownerKey, 's1-01');
    const other = await post('/api/lobby/room/start', { roomid: room.id, id: makeKey(41) });
    assert.equal(other.status, 403);
    assert.equal(other.body.code, 'NOT_OWNER');

    const ok = await post('/api/lobby/room/start', { roomid: room.id, id: ownerKey });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.started, true);
    assert.equal(ok.body.characterId, 's1-01');
    assert.equal(ok.body.room.started, true, 'room 是 rooms.view()，带 started');
    assert.equal(typeof ok.body.room.pendingCount, 'number');
    assert.equal(started.length, 1, '真的调了 controller.startRound');
  });
});

test('POST /api/lobby/room/kick/approve/reject：字段名、状态码、每次成功都广播玩家列表', async () => {
  await withRoomControl(async ({ post, rooms, room, ownerKey, broadcasts }) => {
    // 先让「客人」申请进来
    rooms.addPending(room, { idKey: makeKey(42), username: '客人' });
    const b0 = broadcasts();
    const ap = await post('/api/lobby/room/approve', { roomid: room.id, id: ownerKey, username: '客人' });
    assert.equal(ap.status, 200);
    assert.equal(ap.body.ok, true);
    assert.equal(ap.body.action, 'approve');
    assert.equal(ap.body.username, '客人');
    assert.equal(ap.body.room.members.includes('客人'), true);
    assert.equal(broadcasts(), b0 + 1, '审批后要广播玩家列表');

    const kk = await post('/api/lobby/room/kick', { roomid: room.id, id: ownerKey, username: '客人' });
    assert.equal(kk.status, 200);
    assert.equal(kk.body.action, 'kick');
    assert.equal(kk.body.room.members.includes('客人'), false);
    assert.equal(broadcasts(), b0 + 2);

    // reject：先把申请加回来再拒
    rooms.addPending(room, { idKey: makeKey(43), username: '路人' });
    const rj = await post('/api/lobby/room/reject', { roomid: room.id, id: ownerKey, username: '路人' });
    assert.equal(rj.status, 200);
    assert.equal(rj.body.action, 'reject');
    assert.equal(rj.body.room.pendingCount, 0);
    assert.equal(broadcasts(), b0 + 3);

    // 非房主踢人 → 403 NOT_OWNER
    const notOwner = await post('/api/lobby/room/kick', { roomid: room.id, id: makeKey(44), username: '路人' });
    assert.equal(notOwner.status, 403);
    assert.equal(notOwner.body.code, 'NOT_OWNER');
  });
});

test('房间控制路由的参数校验：缺 roomid/id/username → 400，非 POST → 405，未知动作 → 404，没 lobby → 501', async () => {
  await withRoomControl(async ({ origin, post, room, ownerKey }) => {
    const noRoomId = await post('/api/lobby/room/start', { id: ownerKey });
    assert.equal(noRoomId.status, 400);
    assert.equal(noRoomId.body.code, 'BAD_REQUEST');
    assert.match(noRoomId.body.error, /roomid/);

    const noId = await post('/api/lobby/room/start', { roomid: room.id });
    assert.equal(noId.status, 400);
    assert.match(noId.body.error, /id/);

    const noUser = await post('/api/lobby/room/kick', { roomid: room.id, id: ownerKey });
    assert.equal(noUser.status, 400);
    assert.match(noUser.body.error, /username/);

    const getRes = await fetch(`${origin}/api/lobby/room/start`, { method: 'GET' });
    assert.equal(getRes.status, 405);
    await getRes.arrayBuffer();

    const unknown = await post('/api/lobby/room/dance', { roomid: room.id, id: ownerKey });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'NOT_FOUND');
  });
  // 没有 lobby 的实例：整组路由 501
  const rooms = new RoomManager({ logger: quiet });
  const key = makeKey(45);
  rooms.create({ idKey: key, username: '房主' });
  const route = createLobbyRouter({ rooms, idKey: key, serverName: '测试源', logger: quiet });
  const server = createServer((req, res) => {
    if (!route(req, res)) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/lobby/room/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).code, 'LOBBY_DISABLED');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('/api/net/join（type=join）也走排队制：返回 pending:true，且开局后陌生人回 ROOM_STARTED', async () => {
  await withRoomControl(async ({ origin, rooms, room, ownerKey }) => {
    const guestKey = makeKey(46);
    const qs = `?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&username=客人&id=${guestKey}`;
    const join = await fetch(origin + '/api/net/join' + qs);
    assert.equal(join.status, 200);
    const jb = await join.json();
    assert.equal(jb.ok, true);
    assert.equal(jb.pending, true, 'join 只是提交申请');
    assert.equal(jb.created, false);
    assert.equal(room.pending.length, 1);
    assert.equal(room.members.has('客人'), false, '没审批就不是成员');
    assert.ok(jb.lobbyPath.includes('type=join'));

    // 房主开局后：没被审批过的陌生人再 join 必须被拒，code = ROOM_STARTED（前端按 code 分支）
    rooms.start(room.id, ownerKey);
    const strangerQs = `?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&username=陌生人&id=${makeKey(47)}`;
    const denied = await fetch(origin + '/api/net/join' + strangerQs);
    const db = await denied.json();
    assert.equal(db.ok, false);
    assert.equal(db.code, 'ROOM_STARTED');

    // 但"已经在房间里的人"（房主 / 已审批成员）开局后重连必须放行（rejoined:true）——
    // 否则关掉游戏窗口再点"再次打开窗口"、或者刷新页面，就永远回不到房间，只能看"观战中"。
    const ownerBack = await fetch(origin + '/api/net/join' + `?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&username=房主&id=${ownerKey}`);
    const ob = await ownerBack.json();
    assert.equal(ob.ok, true, '房主开局后重连要放行');
    assert.equal(ob.rejoined, true);
    const memberBack = await fetch(origin + '/api/net/join' + `?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&username=客人&id=${guestKey}`);
    const mb = await memberBack.json();
    assert.equal(mb.ok, true, '已审批成员开局后重连要放行');
    assert.equal(mb.rejoined, true);
  });
});

// ---- ⑤ 联机端到端：JOIN 记角色 → 「开始游戏」真的开得起来 ----
//
// 这一组锁住两个曾经真实坏掉的点（都在 server 侧，前端只是被动吃 NO_CHARACTER）：
// ① MessageRouter 处理 MSG.JOIN 时不写 characters 表 → LobbyGateway.startRoom 恒拿不到 characterId
//    → 房主点「开始游戏」永远回 400 NO_CHARACTER，房间永远开不了局；
// ② playerList 用 controller.hasConnection() 当「房主在线」，跟「这个房间里的人在不在」无关。

test('MSG.JOIN 会把房间里的角色记进 characters 表：startRoom 不再回 NO_CHARACTER', async () => {
  const rooms = new RoomManager({ logger: quiet });
  const ownerKey = makeKey(61);
  const { room } = rooms.create({ idKey: ownerKey, username: '房主' });
  const started = [];
  const controller = {
    roster: [{ id: 's1-01', role: 'student' }, { id: 't-01', role: 'teacher' }],
    phase: 'LOBBY',
    viewerId: null,
    startRound: (arg) => started.push(arg),
    hasConnection: () => false,
  };
  const lobby = new LobbyGateway({ rooms, controller, logger: quiet });
  const router = new MessageRouter({ controller, lobby, logger: quiet });
  const conn = { role: 'controller', lobby: { idKey: ownerKey, room, seat: true, username: '房主' }, sent: [], errors: [],
    send: (type, payload) => conn.sent.push({ type, payload }),
    error: (code, message) => conn.errors.push({ code, message }) };

  // v0.9 语义：联机 JOIN 只是「落座」（占座位 + 记 characters + 升级视图），不再顺手开一局，
  // 开局统一由房主点「开始游戏」（HTTP startRoom）。所以这里 started 应为 0、回一个 seated 确认。
  await router.handle(conn, { type: MSG.JOIN, payload: { characterId: 's1-01', role: 'student' }, seq: 1 });
  assert.equal(conn.errors.length, 0, '选座位本身不该报错：' + JSON.stringify(conn.errors));
  assert.equal(started.length, 0, '联机 JOIN 不负责开局，开局归房主的「开始游戏」');
  const seatedAck = conn.sent.find((m) => m.type === MSG.PONG && m.payload && m.payload.seated);
  assert.ok(seatedAck, '落座成功要回一个带 seated 的 pong：' + JSON.stringify(conn.sent));
  assert.equal(seatedAck.payload.seated, 's1-01');
  assert.equal(lobby.characters.get(ownerKey), 's1-01', 'MSG.JOIN 必须把角色记进 characters');
  assert.equal(rooms.seatOf(room, '房主'), 's1-01', 'MSG.JOIN 必须把角色落进房间座位表');

  // 房主回到大厅后点「开始游戏」（HTTP 的 startRoom 一路）
  controller.phase = 'LOBBY';
  const out = lobby.startRoom(room.id, ownerKey);
  assert.equal(out.ok, true, out.message);
  assert.equal(out.started, true);
  assert.equal(started.length, 1);
  assert.equal(started[0].characterId, 's1-01');
  assert.equal(room.started, true);
});

test('单机/老 /ws 连接（没有房间里 idKey）不会污染 characters 表', async () => {
  const controller = { roster: [{ id: 's1-01', role: 'student' }], phase: 'LOBBY', viewerId: null,
    startRound: () => {}, hasConnection: () => true };
  const lobby = new LobbyGateway({ rooms: new RoomManager({ logger: quiet }), controller, logger: quiet });
  const router = new MessageRouter({ controller, lobby, logger: quiet });
  const conn = { role: 'controller', lobby: null, sent: [], errors: [],
    send: (t, p) => conn.sent.push({ type: t, payload: p }), error: (c, m) => conn.errors.push({ code: c, message: m }) };
  await router.handle(conn, { type: MSG.JOIN, payload: { characterId: 's1-01', role: 'student' }, seq: 1 });
  assert.equal(conn.errors.length, 0);
  assert.equal(lobby.characters.size, 0, '没有 idKey 的连接不该往表里写');
});

test('playerList 的 online 来自真实连接，而不是 controller.hasConnection()', () => {
  const rooms = new RoomManager({ logger: quiet });
  const ownerKey = makeKey(62);
  const { room } = rooms.create({ idKey: ownerKey, username: '房主' });
  rooms.join({ roomId: room.id, username: '客人', token: room.token, invCode: room.invCode, idKey: makeKey(63) });
  rooms.approve(room.id, ownerKey, '客人');
  // 全局「有人控制着这一局」= true，但房间里一个人也没连上来
  const lobby = new LobbyGateway({ rooms, controller: { hasConnection: () => true }, logger: quiet });
  let rows = lobby.playerList();
  assert.equal(rows.find((r) => r.role === 'owner').online, false, '没人连上来就不算在线');
  assert.equal(rows.find((r) => r.username === '客人').online, false);

  const untrackOwner = lobby.trackConnection({ idKey: ownerKey, username: '房主' });
  rows = lobby.playerList();
  assert.equal(rows.find((r) => r.role === 'owner').online, true, '房主连上来之后才在线');
  assert.equal(rows.find((r) => r.username === '客人').online, false, '客人还没连上');

  const untrackGuest = lobby.trackConnection({ idKey: makeKey(63), username: '客人' });
  assert.equal(lobby.playerList().find((r) => r.username === '客人').online, true);

  // 注销幂等：重复调用不该把别人的记录删掉
  untrackGuest();
  untrackGuest();
  rows = lobby.playerList();
  assert.equal(rows.find((r) => r.username === '客人').online, false);
  assert.equal(rows.find((r) => r.role === 'owner').online, true);
  untrackOwner();
  assert.equal(lobby.playerList().find((r) => r.role === 'owner').online, false);
});

// ---- ⑥ 结算后 120 秒离开：房主点「返回大厅」才删房 ----
//
// 需求（m01341）：结算后给玩家 120 秒看排名；点「返回大厅」删房并退出，时间到自动退出并删房。
// 锁四件事：① 房主 LEAVE 只结束对局，房间先留着；② 结算页 LOBBY 才删房且不把结算画面切回大厅；
// ③ 成员 LEAVE 只走人，房间还在；④ 单机连接（无 lobby）不碰房间。

test('房主 MSG.LEAVE 只结束对局；结算页点返回大厅才删房（不切掉结算画面）', async () => {
  const rooms = new RoomManager({ logger: quiet });
  const ownerKey = makeKey(71);
  const guestKey = makeKey(72);
  const { room } = rooms.create({ idKey: ownerKey, username: '房主' });
  rooms.join({ roomId: room.id, username: '客人', token: room.token, invCode: room.invCode, idKey: guestKey });
  rooms.approve(room.id, ownerKey, '客人');
  const packets = [];
  const calls = [];
  const controller = {
    roster: [{ id: 's1-01', role: 'student' }],
    phase: 'PLAYING',
    viewerId: 's1-01',
    quit: () => calls.push('quit'),
    toLobby: () => calls.push('toLobby'),
    // 真 controller 是 EventEmitter：WsServer 订阅 'packet' 后收到 (type, payload)。
    emit: (...args) => packets.push(args.slice(1)),
  };
  const lobby = new LobbyGateway({ rooms, controller, logger: quiet });
  const router = new MessageRouter({ controller, lobby, logger: quiet });
  const conn = {
    role: 'controller',
    lobby: { idKey: ownerKey, room, seat: true, username: '房主' },
    sent: [],
    errors: [],
    send: (type, payload) => conn.sent.push({ type, payload }),
    error: (code, message) => conn.errors.push({ code, message }),
  };

  await router.handle(conn, { type: MSG.LEAVE, payload: {}, seq: 1 });

  assert.deepEqual(conn.errors, []);
  assert.deepEqual(calls, ['quit'], '结束本局不影响房间：给所有人留 120 秒看结算');
  assert.equal(rooms.rooms.has(room.id), true, '结算后房间要先保留（倒计时结束或房主点返回大厅才删）');
  assert.equal(packets.find(([t]) => t === MSG.ROOM_CLOSED), undefined, '还没删房，不能提前广播 room.closed');

  // 结算页点「返回大厅」：phase 已经是 ENDED，房主这一下才删房。
  controller.phase = 'ENDED';
  await router.handle(conn, { type: MSG.LOBBY, payload: {}, seq: 2 });
  assert.deepEqual(conn.errors, []);
  assert.deepEqual(calls, ['quit', 'toLobby'], 'closeOwnedRoom 要传 toLobby:false，否则结算画面会被立刻换成大厅');
  assert.equal(rooms.rooms.has(room.id), false, '房主点返回大厅后房间必须从服务器删除');
  const closed = packets.find(([t]) => t === MSG.ROOM_CLOSED);
  assert.ok(closed, '要广播 room.closed 让结算页收起「再来一局」：' + JSON.stringify(packets));
  assert.equal(closed[1].roomId, room.id);
});

test('非房主 MSG.LEAVE 只走人：房间原样保留；单机连接也不碰房间', async () => {
  const rooms = new RoomManager({ logger: quiet });
  const ownerKey = makeKey(73);
  const guestKey = makeKey(74);
  const { room } = rooms.create({ idKey: ownerKey, username: '房主' });
  rooms.join({ roomId: room.id, username: '客人', token: room.token, invCode: room.invCode, idKey: guestKey });
  rooms.approve(room.id, ownerKey, '客人');
  const packets = [];
  const controller = {
    roster: [{ id: 's1-01', role: 'student' }],
    phase: 'PLAYING',
    viewerId: 's1-01',
    quit: () => {},
    toLobby: () => {},
    emit: (...args) => packets.push(args.slice(1)),
  };
  const lobby = new LobbyGateway({ rooms, controller, logger: quiet });
  const router = new MessageRouter({ controller, lobby, logger: quiet });
  const makeConn = (info) => {
    const conn = {
      role: 'controller',
      lobby: info,
      sent: [],
      errors: [],
      send: (type, payload) => conn.sent.push({ type, payload }),
      error: (code, message) => conn.errors.push({ code, message }),
    };
    return conn;
  };

  const guestConn = makeConn({ idKey: guestKey, room, seat: true, username: '客人' });
  await router.handle(guestConn, { type: MSG.LEAVE, payload: {}, seq: 1 });
  assert.deepEqual(guestConn.errors, []);
  assert.equal(rooms.rooms.has(room.id), true, '成员退出不能删房主的房间');
  assert.equal(packets.length, 0, '没删房就不该广播 room.closed');

  // 单机 /ws：没有房间上下文，LEAVE 只结束本机对局。
  const solo = makeConn(null);
  await router.handle(solo, { type: MSG.LEAVE, payload: {}, seq: 2 });
  assert.deepEqual(solo.errors, []);
  assert.equal(rooms.rooms.has(room.id), true, '单机连接不该碰任何房间');
});

test('结算后 120 秒没离开：自动删房、广播 room.closed 并把人送回大厅', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rooms = new RoomManager({ logger: quiet });
  const ownerKey = makeKey(81);
  const { room } = rooms.create({ idKey: ownerKey, username: '房主' });
  const packets = [];
  const calls = [];
  const controller = {
    phase: 'ENDED',
    toLobby: () => calls.push('toLobby'),
    emit: (...args) => packets.push(args.slice(1)),
  };
  const lobby = new LobbyGateway({ rooms, controller, logger: quiet });
  // 真实路径由 startRoom 写入 activeRoomId；这里直接标上，专测计时器本身。
  lobby.activeRoomId = room.id;

  assert.equal(lobby.onGameOver(), true, '房间局结算要起 120 秒计时');
  t.mock.timers.tick(GAMEOVER_LEAVE_MS - 1);
  assert.equal(rooms.rooms.has(room.id), true, '120 秒之内房间必须还在（玩家还在看结算）');

  t.mock.timers.tick(1);
  assert.equal(rooms.rooms.has(room.id), false, '到点自动删房');
  assert.deepEqual(calls, ['toLobby'], '删房后把所有人送回大厅');
  const closed = packets.find(([type]) => type === MSG.ROOM_CLOSED);
  assert.ok(closed, '要广播 room.closed：' + JSON.stringify(packets));
  assert.equal(closed[1].roomId, room.id);
  assert.equal(lobby.activeRoomId, '', '计时器触发后要清空 activeRoomId');
});

test('单机结算（没有 activeRoomId）不会起自动删房计时', () => {
  const rooms = new RoomManager({ logger: quiet });
  const controller = { phase: 'ENDED', toLobby() {}, emit() {} };
  const lobby = new LobbyGateway({ rooms, controller, logger: quiet });
  assert.equal(lobby.onGameOver(), false);
  assert.equal(lobby.gameoverTimer, null);
});
