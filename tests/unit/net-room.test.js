// 联机相关的服务端纯逻辑与 HTTP 入口自测（不依赖真实 WebSocket）
// 覆盖：ID 密钥格式、房间注册表（建房 / 加入 / 违规封禁）、联机 URL 解析、大厅 HTTP 路由。
// 权限模型故意做得很窄——同一用户只能一间房、连续 3 次违规封禁 24 小时、房间号+Token+邀请码三者全对才允许加入，
// 所以这里逐条把「拒绝」路径也钉住，避免以后改动把校验放宽。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { computeIdKey, isValidIdKey } from '../../server/net/IdKey.js';
import { RoomManager, parseRoomUrl, buildRoomUrl, MAX_ROOMS_PER_USER } from '../../server/net/RoomManager.js';
import { createLobbyRouter } from '../../server/net/LobbyHttp.js';
import { quiet } from '../helpers.js';

/** 造一个合法（256 位 hex）的 ID 密钥，rand 不同则密钥不同。 */
const makeKey = (n) => computeIdKey({ timezone: 'Asia/Shanghai', mac: `aabbcc0000${n}`, os: 'win-x64', lang: 'zh_CN', username: `u${n}`, appCount: n, rand: String(n).repeat(64).slice(0, 64) });

test('computeIdKey 输出 256 位纯小写 hex，且不同输入的密钥不同', () => {
  const a = makeKey(1);
  const b = makeKey(2);
  for (const k of [a, b]) {
    assert.equal(k.length, 256);
    assert.match(k, /^[0-9a-f]{256}$/);
    assert.ok(isValidIdKey(k));
  }
  assert.notEqual(a, b);
});

test('isValidIdKey 拒绝非法密钥', () => {
  assert.equal(isValidIdKey('abc'), false);
  assert.equal(isValidIdKey(makeKey(3).toUpperCase()), false, '大写 hex 不合法');
  assert.equal(isValidIdKey(makeKey(3).slice(0, 255)), false, '长度不足不合法');
  assert.equal(isValidIdKey(null), false);
});

test('RoomManager.create 成功返回 {id, token, invCode}，且房间可查', () => {
  const rooms = new RoomManager({ logger: quiet, now: () => 1000 });
  const key = makeKey(4);
  const out = rooms.create({ idKey: key, username: '张三' });
  assert.equal(out.ok, true);
  assert.match(out.room.id, /^\d{6}$/, '房间号是 6 位数字');
  assert.ok(out.room.token.length >= 6, '带 token');
  assert.ok(out.room.invCode.length >= 6, '带邀请码');
  const view = rooms.view(out.room);
  assert.deepEqual(view.members, ['张三']);
  assert.equal(view.owner, '张三');
});

test('同一 ID 密钥重复建房 → 500 并累计违规；连续 3 次封禁', () => {
  const rooms = new RoomManager({ logger: quiet, now: () => 1000 });
  const key = makeKey(5);
  assert.equal(rooms.create({ idKey: key, username: '张三' }).ok, true);
  // 换 username（等价于换 token）就不再算「同一房间复用」，会撞上「一人一房」
  const first = rooms.create({ idKey: key, username: '张三', token: 'OTHERTOKEN' });
  assert.equal(first.ok, false);
  assert.equal(first.status, 500);
  assert.equal(rooms.strikeCount(key), 1);
  assert.equal(rooms.isBanned(key), false);
  rooms.create({ idKey: key, username: '张三', token: 'TOKEN-2' });
  rooms.create({ idKey: key, username: '张三', token: 'TOKEN-3' });
  assert.equal(rooms.isBanned(key), true, '连续 3 次违规后封禁');
  const banned = rooms.create({ idKey: key, username: '张三' });
  assert.equal(banned.ok, false);
  assert.equal(banned.status, 500);
});

test('每人最多一间房（MAX_ROOMS_PER_USER）', () => {
  const rooms = new RoomManager({ logger: quiet });
  const key = makeKey(6);
  rooms.create({ idKey: key, username: 'A' });
  assert.equal(rooms.byUser(key).length, MAX_ROOMS_PER_USER);
  assert.equal(MAX_ROOMS_PER_USER, 1);
});

test('join：房间号 + Token + 邀请码全对才成功，任一不符都拒绝（房间不存在 404，其余 500）', () => {
  const rooms = new RoomManager({ logger: quiet });
  const ownerKey = makeKey(7);
  const guestKey = makeKey(8);
  const room = rooms.create({ idKey: ownerKey, username: '房主' }).room;
  const base = { idKey: guestKey, username: '访客', roomId: room.id };
  assert.equal(rooms.join({ ...base, token: room.token, invCode: room.invCode }).ok, true);
  const badToken = rooms.join({ ...base, token: 'WRONG', invCode: room.invCode });
  assert.equal(badToken.ok, false);
  assert.equal(badToken.status, 500);
  const badInv = rooms.join({ ...base, token: room.token, invCode: 'WRONG' });
  assert.equal(badInv.ok, false);
  assert.equal(badInv.status, 500);
  const noRoom = rooms.join({ ...base, roomId: '000000', token: room.token, invCode: room.invCode });
  assert.equal(noRoom.ok, false);
  // 房间不存在/已被清除 → 404，不再混成 500（清除房间后旧房间号必须能被前端识别为「房间没了」）
  assert.equal(noRoom.status, 404);
  assert.equal(noRoom.code, 'ROOM_NOT_FOUND');
});

test('join 成功会结清违规计数', () => {
  const rooms = new RoomManager({ logger: quiet });
  const ownerKey = makeKey(9);
  const guestKey = makeKey(10);
  const room = rooms.create({ idKey: ownerKey, username: '房主' }).room;
  rooms.strike(guestKey, '测试用');
  assert.equal(rooms.strikeCount(guestKey), 1);
  rooms.join({ idKey: guestKey, username: '访客', roomId: room.id, token: room.token, invCode: room.invCode });
  assert.equal(rooms.strikeCount(guestKey), 0, '成功加入后违规清零');
});

test('close：只有房主能清除房间，清除后房间号立即作废（404 ROOM_NOT_FOUND）', () => {
  const rooms = new RoomManager({ logger: quiet });
  const ownerKey = makeKey(21);
  const guestKey = makeKey(22);
  const room = rooms.create({ idKey: ownerKey, username: '房主' }).room;
  // 非房主 → 403，且房间必须还在
  const denied = rooms.close(room.id, guestKey);
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'NOT_OWNER');
  assert.ok(rooms.rooms.get(room.id), '被拒绝时不能把房间删掉');
  // 房主 → 成功删除
  const ok = rooms.close(room.id, ownerKey);
  assert.equal(ok.ok, true);
  assert.equal(ok.closed, true);
  assert.equal(rooms.rooms.has(room.id), false);
  // 重复清除 → 404
  const again = rooms.close(room.id, ownerKey);
  assert.equal(again.ok, false);
  assert.equal(again.status, 404);
  assert.equal(again.code, 'ROOM_NOT_FOUND');
  // 房间没了：任何人再 join 都必须是 404 而不是 500（前端靠 code 跳回大厅）
  const rejoin = rooms.join({ idKey: guestKey, username: '访客', roomId: room.id, token: room.token, invCode: room.invCode });
  assert.equal(rejoin.ok, false);
  assert.equal(rejoin.status, 404);
  assert.equal(rejoin.code, 'ROOM_NOT_FOUND');
  // 房主清掉旧房后可以立刻建新房（byUser 不该再算上已删除的那间）
  const fresh = rooms.create({ idKey: ownerKey, username: '房主' });
  assert.equal(fresh.ok, true);
  assert.notEqual(fresh.room.id, room.id);
});

test('parseRoomUrl：完整 URL 解析出全部字段', () => {
  const key = makeKey(11);
  const raw = `https://abc.ts.net/?token=TK123456&id=${key}&type=join&roomid=123456&invcode=INVCODE1&username=%E5%BC%A0%E4%B8%89`;
  const out = parseRoomUrl(raw);
  assert.equal(out.ok, true);
  assert.equal(out.url.origin, 'https://abc.ts.net');
  assert.equal(out.url.token, 'TK123456');
  assert.equal(out.url.idKey, key);
  assert.equal(out.url.type, 'join');
  assert.equal(out.url.roomId, '123456');
  assert.equal(out.url.invCode, 'INVCODE1');
  assert.equal(out.url.username, '张三');
});

test('parseRoomUrl：缺 token / 缺 id / type 非法 / join 缺 roomid 都拒绝', () => {
  const key = makeKey(12);
  assert.equal(parseRoomUrl(`https://a.ts.net/?id=${key}&type=join&roomid=1`).ok, false);
  assert.equal(parseRoomUrl('https://a.ts.net/?token=T&type=create').ok, false);
  assert.equal(parseRoomUrl(`https://a.ts.net/?token=T&id=${key}&type=other`).ok, false);
  assert.equal(parseRoomUrl(`https://a.ts.net/?token=T&id=${key}&type=join`).ok, false);
  assert.equal(parseRoomUrl('not a url').ok, false);
});

test('buildRoomUrl 与 parseRoomUrl 往返一致', () => {
  const key = makeKey(13);
  const url = buildRoomUrl('https://x.ts.net', { token: 'T1', idKey: key, type: 'create', username: '张三' });
  const back = parseRoomUrl(url);
  assert.equal(back.ok, true);
  assert.equal(back.url.token, 'T1');
  assert.equal(back.url.idKey, key);
  assert.equal(back.url.type, 'create');
  assert.equal(back.url.username, '张三');
});

/** 把大厅路由挂到真实 HTTP 服务上，用 fetch 跑一遍（与线上入口同一段代码）。 */
async function withLobby(fn, opts = {}) {
  const rooms = new RoomManager({ logger: quiet });
  const idKey = makeKey(20);
  const route = createLobbyRouter({ rooms, idKey, serverName: '测试源', logger: quiet, lobby: opts.lobby });
  const server = createServer((req, res) => {
    if (!route(req, res)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"ok":false}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  try {
    return await fn({ origin, rooms, idKey });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('LobbyHttp /api/net/info：200，下发 256 位 idKey 与服务器名', async () => {
  await withLobby(async ({ origin, idKey }) => {
    const res = await fetch(`${origin}/api/net/info`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', '联机模式允许跨源');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, '测试源');
    assert.equal(body.idKey, idKey);
    assert.equal(body.idKey.length, 256);
    assert.ok(isValidIdKey(body.idKey));
    assert.equal(typeof body.rooms, 'number');
  });
});

test('LobbyHttp /api/net/join：非法 id 密钥 → 500', async () => {
  await withLobby(async ({ origin }) => {
    const res = await fetch(`${origin}/api/net/join?token=T1&id=abc&type=create&username=u`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /ID 密钥/);
  });
});

test('LobbyHttp /api/net/join：create 建房成功返回 wsPath，同房 token 邀请码可加入', async () => {
  await withLobby(async ({ origin }) => {
    const key = makeKey(21);
    const res = await fetch(`${origin}/api/net/join?token=T1&id=${key}&type=create&username=${encodeURIComponent('房主')}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.created, true);
    assert.match(body.wsPath, /^\/ws\?roomid=\d{6}&token=/);
    const { id, token, invCode } = body.room;
    const guest = makeKey(22);
    const joined = await fetch(`${origin}/api/net/join?token=${token}&id=${guest}&type=join&roomid=${id}&invcode=${invCode}&username=${encodeURIComponent('访客')}`);
    assert.equal(joined.status, 200);
    const jb = await joined.json();
    assert.equal(jb.ok, true);
    // v0.8 排队制：type=join 只提交申请，不再直接进 room.members（要房主审批，审批逻辑在 room-control.test.js）。
    assert.equal(jb.pending, true, 'join 只是提交申请');
    assert.equal(jb.room.members.includes('访客'), false, '审批前不该出现在成员里');
    assert.equal(jb.room.pendingCount, 1, '申请要计入 pendingCount');
    // token 错 → 500
    const bad = await fetch(`${origin}/api/net/join?token=WRONG&id=${guest}&type=join&roomid=${id}&invcode=${invCode}&username=x`);
    assert.equal(bad.status, 500);
    // 房间不存在 → 404（与「房间已被房主清除」同一语义）
    const none = await fetch(`${origin}/api/net/join?token=${token}&id=${guest}&type=join&roomid=000000&invcode=${invCode}&username=x`);
    assert.equal(none.status, 404);
  });
});

test('LobbyHttp /api/lobby/room action=close：非房主 403，房主 200 closed，之后 join 404', async () => {
  // /api/lobby/room/* 只有挂了联机网关（lobby）才可用，没挂直接 501 —— 这里给个最小桩。
  const lobby = { closeRoom() {} };
  await withLobby(async ({ origin }) => {
    const owner = makeKey(23);
    const guest = makeKey(24);
    const created = await fetch(`${origin}/api/net/join?token=T1&id=${owner}&type=create&username=${encodeURIComponent('房主')}`);
    assert.equal(created.status, 200);
    const { room } = await created.json();
    // 路由形如 /api/lobby/room/<action>（见 server/net/LobbyHttp.js:574-583），不是 body 里的 action。
    const post = (id, body) => fetch(`${origin}/api/lobby/room/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomid: id, ...body }),
    });
    // 非房主：403，房间必须还在
    const denied = await post(room.id, { id: guest });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'NOT_OWNER');
    // 房主：200 closed（响应里不再带 room 视图 —— 房间已经删了）
    const ok = await post(room.id, { id: owner });
    assert.equal(ok.status, 200);
    const ob = await ok.json();
    assert.equal(ob.ok, true);
    assert.equal(ob.closed, true);
    assert.equal(ob.roomId, room.id);
    assert.equal(ob.room, undefined, '房间已删除，不该再返回视图');
    // 重复清除 → 404
    const again = await post(room.id, { id: owner });
    assert.equal(again.status, 404);
    // 清除后别人再按老房间号进来 → 404 ROOM_NOT_FOUND（前端据此跳回大厅）
    const rejoin = await fetch(`${origin}/api/net/join?token=${room.token}&id=${guest}&type=join&roomid=${room.id}&invcode=${room.invCode}&username=x`);
    assert.equal(rejoin.status, 404);
    assert.equal((await rejoin.json()).code, 'ROOM_NOT_FOUND');
  }, { lobby });
});

test('LobbyHttp 未知路径不接管（返回 false 交给上层）与 OPTIONS 预检', async () => {
  await withLobby(async ({ origin }) => {
    const res = await fetch(`${origin}/api/other`);
    assert.equal(res.status, 404);
    const opt = await fetch(`${origin}/api/net/info`, { method: 'OPTIONS' });
    assert.equal(opt.status, 204);
  });
});