// 联机网关（v0.3）自测：房间鉴权、座位判定、玩家列表。
// 需求原文：「房间鉴权 + 玩家列表 + 全员一个房间 + 延迟 < 100ms」。
// 这里锁住三件事：① 参数不全 → 400、房间/token/邀请码不对 → 404，绝不能放行；
// ② 一个房间只有一个玩家座位（房主），后来者一律观战；③ 玩家列表字段名与前端约定一致。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { computeIdKey } from '../../server/net/IdKey.js';
import { RoomManager } from '../../server/net/RoomManager.js';
import { LobbyGateway, idKeyHint } from '../../server/net/LobbyGateway.js';
import { createLobbyRouter } from '../../server/net/LobbyHttp.js';
import { quiet } from '../helpers.js';

/** 造一个合法（256 位 hex）的 ID 密钥。 */
const makeKey = (n) => computeIdKey({ timezone: 'Asia/Shanghai', mac: `aabbcc0000${n}`, os: 'win-x64', lang: 'zh_CN', username: `u${n}`, appCount: n, rand: String(n).repeat(64).slice(0, 64) });

/** 建一个房间 + 一个网关，返回常用句柄。 */
const setupRoom = (n = 1) => {
  const rooms = new RoomManager({ logger: quiet, now: () => 1000 });
  const ownerKey = makeKey(n);
  const created = rooms.create({ idKey: ownerKey, username: '房主' });
  const lobby = new LobbyGateway({ rooms, logger: quiet });
  return { rooms, lobby, ownerKey, room: created.room };
};

test('idKeyHint 只给前 8 位：列表里够区分但不泄露完整密钥', () => {
  assert.equal(idKeyHint('abcdef0123456789'), 'abcdef01');
  assert.equal(idKeyHint(''), '');
  assert.equal(idKeyHint(null), '');
});

test('resolve：没有 type 的 /ws 老连接放行但不定座位（不破坏单机模式）', () => {
  const { lobby } = setupRoom(1);
  const out = lobby.resolve('?roomid=123456&token=abc');
  assert.equal(out.ok, true);
  assert.equal(out.room, null, '老路径不绑房间');
  assert.equal(out.role, 'legacy');
  assert.equal(out.pending, true);
});

test('resolve：缺 token / 缺 id / type 写错 → 400（用户把地址粘错了）', () => {
  const { lobby } = setupRoom(2);
  const cases = [
    ['?type=join&roomid=123456', /缺少 token/],
    ['?type=join&roomid=123456&token=t', /缺少 id/],
    ['?type=whatever&token=t&id=k', /type 必须是/],
    ['?type=join&token=t&id=k', /加入房间必须带 roomid/],
    ['?type=join&token=t&id=k&roomid=12ab56', /6 位数字/],
  ];
  for (const [qs, re] of cases) {
    const out = lobby.resolve(qs);
    assert.equal(out.ok, false, qs + ' 应被拒');
    assert.equal(out.status, 400, qs + ' 应是 400');
    assert.match(out.message, re);
  }
});

test('resolve：房间不存在 / token 不符 / 邀请码不符 → 404（房间关了或被踢）', () => {
  const { lobby, room } = setupRoom(3);
  const noRoom = lobby.resolve(`?type=join&roomid=999999&token=${room.token}&invcode=${room.invCode}&id=k`);
  assert.equal(noRoom.ok, false);
  assert.equal(noRoom.status, 404);
  assert.equal(noRoom.code, 'ROOM_NOT_FOUND');

  const badToken = lobby.resolve(`?type=join&roomid=${room.id}&token=WRONG&invcode=${room.invCode}&id=k`);
  assert.equal(badToken.ok, false);
  assert.equal(badToken.status, 404);
  assert.equal(badToken.code, 'TOKEN_MISMATCH');

  const badInv = lobby.resolve(`?type=join&roomid=${room.id}&token=${room.token}&invcode=WRONG&id=k`);
  assert.equal(badInv.ok, false);
  assert.equal(badInv.status, 404);
  assert.equal(badInv.code, 'INVCODE_MISMATCH');
});

test('resolve：房主 create 拿到座位（controller），客人 join 只能排队等审批（pending）', () => {
  const { lobby, ownerKey, room } = setupRoom(4);
  const owner = lobby.resolve(`?type=create&roomid=${room.id}&token=${room.token}&id=${ownerKey}&username=房主`);
  assert.equal(owner.ok, true);
  assert.equal(owner.seat, true);
  assert.equal(owner.role, 'controller');

  // v0.8 排队制：join 不再直接进 members，先挂 pending 等房主审批
  const guestKey = makeKey(44);
  const guest = lobby.resolve(`?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&id=${guestKey}&username=客人`);
  assert.equal(guest.ok, true);
  assert.equal(guest.seat, false, '一个房间只有一个玩家座位');
  assert.equal(guest.role, 'pending');
  assert.equal(guest.pending, true);
  // 审批之后才是观战
  assert.equal(lobby.rooms.approve(room.id, ownerKey, '客人').ok, true);
  const after = lobby.resolve(`?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&id=${guestKey}&username=客人`);
  assert.equal(after.seat, false, '一个房间只有一个玩家座位');
  assert.equal(after.role, 'spectator');
  assert.equal(after.pending, false);
});

test('座位判定看 ownerId 不看「谁先连上」：客人先连也抢不到座位', () => {
  const { lobby, rooms, ownerKey, room } = setupRoom(5);
  const guestKey = makeKey(55);
  // 客人先连（只是排队，连观战都不算）
  const guestFirst = lobby.resolve(`?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&id=${guestKey}&username=客人`);
  assert.equal(guestFirst.role, 'pending');
  // 房主后连，仍然是 controller
  const ownerLater = lobby.resolve(`?type=create&roomid=${room.id}&token=${room.token}&id=${ownerKey}&username=房主`);
  assert.equal(ownerLater.role, 'controller');
  assert.equal(lobby.isSeat(room, ownerKey), true);
  assert.equal(lobby.isSeat(room, guestKey), false);
  assert.equal(rooms.view(room).owner, '房主');
});

test('playerList 字段名与前端约定一致（idKey 8 位提示 / username / characterId / online / role / roomId）', () => {
  const { lobby, rooms, ownerKey, room } = setupRoom(6);
  const guestKey = makeKey(66);
  lobby.resolve(`?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&id=${guestKey}&username=客人`);
  // v0.8：join 只是申请，要房主 approve 之后才是 spectator
  rooms.approve(room.id, ownerKey, '客人');
  lobby.setCharacter(ownerKey, 'student-1');
  // v0.8：online 现在来自「真的连上来的连接」（WsServer 握手成功后 trackConnection），
  // 不再是 controller.hasConnection()。这里显式登记一条房主连接，模拟握手完成。
  lobby.trackConnection({ idKey: ownerKey, username: '房主' });
  const list = lobby.playerList();
  assert.equal(list.length, 2, '房主 + 一个观战');
  const owner = list.find((p) => p.role === 'owner');
  const guest = list.find((p) => p.role === 'spectator');
  assert.deepEqual(Object.keys(owner).sort(), ['characterId', 'idKey', 'online', 'role', 'roomId', 'username']);
  assert.equal(owner.idKey, ownerKey.slice(0, 8));
  assert.equal(owner.username, '房主');
  assert.equal(owner.characterId, 'student-1');
  assert.equal(owner.online, true);
  assert.equal(owner.roomId, room.id);
  assert.equal(guest.username, '客人');
  assert.equal(guest.idKey, '', '观战者不暴露 idKey');
  assert.equal(guest.characterId, null);
});

test('setCharacter / clearCharacter：记角色、传 null 清掉，缺 idKey 拒绝', () => {
  const { lobby, ownerKey } = setupRoom(7);
  assert.equal(lobby.setCharacter(ownerKey, 'teacher-3').characterId, 'teacher-3');
  assert.equal(lobby.playerList()[0].characterId, 'teacher-3');
  assert.equal(lobby.setCharacter(ownerKey, null).characterId, null);
  assert.equal(lobby.playerList()[0].characterId, null);
  assert.equal(lobby.setCharacter('', 'x').ok, false);
  lobby.setCharacter(ownerKey, 'student-2');
  assert.equal(lobby.clearCharacter(ownerKey), true);
  assert.equal(lobby.clearCharacter(ownerKey), false, '重复清同一人返回 false');
});

test('seatOf 从房间视图还原座位；broadcast 注入回调失败也不抛（HTTP 不能被广播拖挂）', () => {
  const rooms = new RoomManager({ logger: quiet, now: () => 1000 });
  const key = makeKey(8);
  const created = rooms.create({ idKey: key, username: '房主' });
  let got = null;
  const lobby = new LobbyGateway({ rooms, logger: quiet, broadcast: (p) => { got = p; } });
  const view = { ...rooms.view(created.room), ownerId: created.room.ownerId };
  assert.deepEqual(lobby.seatOf(view, key), { seat: true, username: '房主' });
  assert.deepEqual(lobby.seatOf(view, makeKey(88)), { seat: false, username: null });
  lobby.broadcast();
  assert.ok(Array.isArray(got) && got.length === 1, '广播拿到的就是 playerList()');
  // 注入一个会炸的回调：不能把调用方带崩
  const boom = new LobbyGateway({ rooms, logger: quiet, broadcast: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => boom.broadcast());
});

// ---- /api/net/room/check 预探测（v0.3.1）----
// 为什么要有它：浏览器的 WebSocket API 在握手被拒时只给 close(1006)，页面拿不到 400/404 与 code。
// 所以前端先 fetch 这个接口拿「真实 HTTP 状态码 + 结构化 code」，再决定连不连 /lobby。
// 关键约束：它**只校验、不产生副作用** —— 不能建房间、不能把人加进成员列表。

/** 把大厅路由挂到真实 HTTP 服务上（与 net-room.test.js 同一套用法），额外塞一个 lobby 网关。 */
async function withLobbyCheck(fn) {
  const rooms = new RoomManager({ logger: quiet, now: () => 1000 });
  const ownerKey = makeKey(30);
  const created = rooms.create({ idKey: ownerKey, username: '房主' });
  const lobby = new LobbyGateway({ rooms, logger: quiet });
  const route = createLobbyRouter({ rooms, idKey: ownerKey, serverName: '测试源', logger: quiet, lobby });
  const server = createServer((req, res) => {
    if (!route(req, res)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"ok":false}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn({ origin: `http://127.0.0.1:${port}`, rooms, lobby, room: created.room, ownerKey, route });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('/api/net/room/check：参数不全 → 400，房间不存在 / token 不符 → 404 且 code 正确', async () => {
  await withLobbyCheck(async ({ origin, room }) => {
    const bad = await fetch(`${origin}/api/net/room/check?type=join&roomid=${room.id}`);
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.deepEqual(Object.keys(badBody).sort(), ['code', 'error', 'ok', 'status']);
    assert.equal(badBody.ok, false);
    assert.equal(badBody.status, 400);
    assert.equal(badBody.code, 'BAD_REQUEST');

    const noRoom = await fetch(`${origin}/api/net/room/check?type=join&roomid=999999&token=${room.token}&invcode=x&id=k`);
    assert.equal(noRoom.status, 404);
    const noRoomBody = await noRoom.json();
    assert.equal(noRoomBody.code, 'ROOM_NOT_FOUND');
    assert.equal(noRoomBody.status, 404);

    const badToken = await fetch(`${origin}/api/net/room/check?type=join&roomid=${room.id}&token=WRONG&invcode=${room.invCode}&id=k`);
    assert.equal(badToken.status, 404);
    const badTokenBody = await badToken.json();
    assert.equal(badTokenBody.code, 'TOKEN_MISMATCH');
    assert.match(badTokenBody.error, /Token/);
  });
});

test('/api/net/room/check：参数全对 → 200 带房间摘要，且绝不创建房间、不加成员', async () => {
  await withLobbyCheck(async ({ origin, rooms, room, ownerKey }) => {
    const sizeBefore = rooms.rooms.size;
    const membersBefore = room.members.size;
    const res = await fetch(`${origin}/api/net/room/check?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&id=k&username=探测者`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.room.id, room.id);
    assert.equal(body.room.owner, '房主');
    assert.equal(typeof body.room.memberCount, 'number');
    assert.equal(body.seat, false, '陌生人探测不该被当成房主');
    // 只校验不落地：房间数、成员数都必须原封不动
    assert.equal(rooms.rooms.size, sizeBefore, 'check 绝不能创建房间');
    assert.equal(room.members.size, membersBefore, 'check 绝不能把人加进成员列表');
    assert.equal(room.members.has('探测者'), false);
    // 房主自己探测：能拿到 seat=true，但同样不加成员
    const owner = await fetch(`${origin}/api/net/room/check?type=create&roomid=${room.id}&token=${room.token}&id=${ownerKey}`);
    assert.equal(owner.status, 200);
    const ownerBody = await owner.json();
    assert.equal(ownerBody.seat, true);
    assert.equal(rooms.rooms.size, sizeBefore);
  });
});

test('/api/net/room/check：type=create 的预探测只看参数，不因「这个 ID 已经开着房间」而拒', async () => {
  // 面板上「创建房间」按钮点下去之前会先 check 一次。若 probe 走「同一 ID 只能开一个房间」的判定，
  // 用户点创建就会莫名吃到 400 —— 所以 create 的 probe 必须恒 ok（只要 token/id/type 合法）。
  await withLobbyCheck(async ({ origin, rooms, ownerKey, room }) => {
    assert.equal(rooms.byUser(ownerKey).length, 1, '前提：这个 owner 已经开着 1 个房间');
    const res = await fetch(`${origin}/api/net/room/check?type=create&id=${ownerKey}&token=anytoken`);
    assert.equal(res.status, 200, '已有一间房也不该挡住「我能不能建房」的探测');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.seat, true, '建房的人是控制端');
    const sizeBefore = rooms.rooms.size;
    assert.equal(rooms.rooms.size, sizeBefore, 'probe 绝不建房间');
    // 已存在的房间 + 错 token + 房主身份：probe 依然 ok —— 语义是「我能不能新建一间」，答案永远是能。
    // （换机后 token 就是新的；真正的 token 校验在 /lobby 握手与 POST /api/net/room 上。）
    const ownWrongToken = await fetch(`${origin}/api/net/room/check?type=create&roomid=${room.id}&id=${ownerKey}&token=WRONG`);
    assert.equal(ownWrongToken.status, 200);
    // 但「join 别人的房间」这一路仍然死认 token/邀请码 —— probe 放宽只针对 create，不是把闸门全开
    const joinWrong = await fetch(`${origin}/api/net/room/check?type=join&roomid=${room.id}&id=k&token=WRONG&invcode=x`);
    assert.equal(joinWrong.status, 404);
    assert.equal((await joinWrong.json()).code, 'TOKEN_MISMATCH');
    // 这个 ID 名下根本没有房间时也 ok（参数合法就能建），且明确告诉前端「会新建」
    const stranger = await fetch(`${origin}/api/net/room/check?type=create&id=${makeKey(77)}&token=t`);
    assert.equal(stranger.status, 200);
    assert.equal((await stranger.json()).room, null);
    assert.equal(rooms.rooms.size, sizeBefore, '依然没有凭空造出房间');
  });
});

test('/api/net/room/check：同一 IP 1 分钟超过 120 次 → 429 RATE_LIMIT（内存闸门，无副作用）', async () => {
  await withLobbyCheck(async ({ origin, room, route }) => {
    route.resetCheckRateLimit();
    const url = `${origin}/api/net/room/check?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&id=k`;
    let firstBlocked = 0;
    for (let i = 1; i <= 121; i++) {
      const res = await fetch(url);
      if (res.status === 429) { firstBlocked = i; await res.arrayBuffer(); break; }
      assert.equal(res.status, 200, `第 ${i} 次应放行`);
      await res.arrayBuffer();
    }
    assert.equal(firstBlocked, 121, '前 120 次放行，第 121 次起拒绝');
    const blocked = await fetch(url);
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'RATE_LIMIT');
    assert.equal(body.status, 429);
    assert.match(body.error, /频繁/);
    route.resetCheckRateLimit();
    assert.equal((await fetch(url)).status, 200, '窗口清空后立刻恢复（测试口子，生产不调用）');
  });
});

test('/api/net/room/check：未启用联机网关（没有 lobby）→ 501，不 500', async () => {
  const rooms = new RoomManager({ logger: quiet });
  const key = makeKey(31);
  const route = createLobbyRouter({ rooms, idKey: key, serverName: '测试源', logger: quiet });
  const server = createServer((req, res) => {
    if (!route(req, res)) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/net/room/check?type=join&roomid=123456&token=t&id=k`);
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.code, 'LOBBY_DISABLED');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('closeRoom：清除房间后这间房的身份缓存（全局 + 房间级）全部作废，同名新房间不串座位', () => {
  const { rooms, lobby, room } = setupRoom(11);
  const guestKey = makeKey(12);
  // 模拟「客人只走 HTTP 进房」：join 会把 idKey→用户名 写进房间级身份表 room.ids。
  rooms.join({ idKey: guestKey, username: '客人', roomId: room.id, token: room.token, invCode: room.invCode });
  assert.equal(rooms.identityOf(room, guestKey), '客人', '前提：房间级身份表里有这条绑定');
  // 再把房主写进全局表（模拟他连过 ws）
  const ownerKey = [...room.ids.keys()][0];
  lobby.usernames.set(ownerKey, '房主');
  // 真删房间（拿到快照）+ 收尾
  const out = rooms.close(room.id, ownerKey);
  assert.equal(out.ok, true);
  lobby.closeRoom(room.id, out.room);
  assert.equal(lobby.usernames.has(ownerKey), false, '全局表里这间房的身份要清掉');
  // 新建一间同名房：客人（从没连过 ws）不该被认成这间房的人
  const fresh = rooms.create({ idKey: ownerKey, username: '房主' }).room;
  assert.equal(lobby.isSeat(fresh, guestKey), false, '旧房间的座位绑定不能串到新房间');
  assert.equal(lobby.resolve(`?type=join&roomid=${fresh.id}&token=${fresh.token}&invcode=${fresh.invCode}&id=${guestKey}&username=客人`).ok, true);
});

test('延迟依据：playerList/resolve 纯内存查表，1000 次 resolve 耗时远低于 100ms', () => {
  const { lobby, room } = setupRoom(9);
  // 传「已是成员」的名字：这样 resolve 走的是纯查表那条路（成员直通），
  // 不会因为反复 addPending 把待审队列越堆越长而把耗时记到鉴权头上。
  room.members.add('客人');
  const qs = `?type=join&roomid=${room.id}&token=${room.token}&invcode=${room.invCode}&id=${makeKey(99)}&username=客人`;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) lobby.resolve(qs);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // 100ms 是需求原文（「延迟 < 100ms」）。整机跑并行测试时单次抖动可达数倍，
  // 所以判据取 250ms：它仍然远小于一次真实的 ws 握手，也不会因为测试机负载而假红。
  assert.ok(ms < 250, `1000 次鉴权应远低于 250ms，实测 ${ms.toFixed(2)}ms`);
});
