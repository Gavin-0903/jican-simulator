// 联机进房的纯函数单测（client/js/net/roomUrl.js）。
//
// 这一组用例守的是三件在浏览器里很难回归的事：
//   ① 通道选择：凑齐 type+token+id 必须走 /lobby 且 query 逐字节透传，缺一个就退回 /ws；
//   ② 地址栏擦除：只留 ?room=<6位>，token/id/invcode 绝不留在 URL 里（截图/复制链接会泄露）；
//   ③ 观战者权限：观战者不能发操作类指令、seat!==true 不能开局。
// 任何一条改了都会让"联机窗口连错通道"或"观战者把房主顶掉"，所以都写成硬断言。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROOM_KEY,
  ROOM_PARAM,
  ROOM_TYPES,
  LOBBY_CODE_TEXT,
  SPECTATOR_BLOCKED,
  parseRoomQuery,
  isRoomJoinQuery,
  buildConnectionUrl,
  resolveSearch,
  roomCredentialFrom,
  scrubbedQuery,
  readScrubbedRoomId,
  describeLobbyError,
  normalizeLobbyPlayers,
  countOnline,
  roomBadgeText,
  canSendAsRole,
  canSendAsRoleStrict,
  SPECTATOR_ALLOWED,
  canStartGame,
  LOBBY_FATAL_CODES,
  isFatalLobbyCode,
  ROLE_RANK,
  splitLobbyPlayers,
  ROOM_ACTIONS,
  OWNER_ROOM_ACTIONS,
  canModerateRoom,
  startButtonState,
  roomLockNote,
  seatRows,
  markSeatRows,
  seatSummary,
  rosterGrid,
  settingsLabel,
  settingsPatch,
  defaultSoloCharacter,
} from '../../client/js/net/roomUrl.js';

/** 服务端 /api/net/join 拼出来的那种完整进房 query（房主窗口地址栏里的原样）。 */
const FULL = '?token=' + 'a'.repeat(64) + '&id=' + 'f'.repeat(64) + '&type=create&roomid=123456&invcode=QYXQWN83&username=%E6%88%BF%E4%B8%BB';
/** 邀请链接那种"还没有房间号"的 query（type=join，进大厅自己挑房）。 */
const INVITE = '?token=' + 'b'.repeat(64) + '&id=' + 'e'.repeat(64) + '&type=join&username=%E5%B0%8F%E6%98%8E';

test('parseRoomQuery: 只保留白名单键，值 trim，空值不落键', () => {
  const q = parseRoomQuery('?token=%20tk%20&id=key&type=create&roomid=123456&username=%20%E9%98%BF%E4%B8%89&junk=1');
  assert.deepEqual(q, { token: 'tk', id: 'key', type: 'create', roomid: '123456', username: '阿三' });
  assert.deepEqual(parseRoomQuery(''), {});
  assert.deepEqual(parseRoomQuery(null), {});
});

test('parseRoomQuery: 接受前导 ? / 完整 URL / URLSearchParams / 普通对象四种输入', () => {
  assert.equal(parseRoomQuery('?token=a').token, 'a');
  assert.equal(parseRoomQuery('http://h/?token=b#frag').token, 'b');
  assert.equal(parseRoomQuery(new URLSearchParams('token=c')).token, 'c');
  assert.equal(parseRoomQuery({ token: 'd', type: 'join' }).token, 'd');
});

test('isRoomJoinQuery: 必须同时有 type=create|join + token + id', () => {
  assert.equal(isRoomJoinQuery(FULL), true);
  assert.equal(isRoomJoinQuery(INVITE), true);
  // 少任一项都不算（宁可退回 /ws，也不要拿半条参数去撞 404）
  assert.equal(isRoomJoinQuery('?type=create&token=x'), false);
  assert.equal(isRoomJoinQuery('?type=create&id=x'), false);
  assert.equal(isRoomJoinQuery('?token=x&id=y'), false);
  // type 写错（例如服务端契约外的 'spectate'）不算进房参数
  assert.equal(isRoomJoinQuery('?type=spectate&token=x&id=y'), false);
  assert.equal(isRoomJoinQuery(''), false);
});

test('buildConnectionUrl: 完整进房参数走 /lobby，且 query 逐字节透传', () => {
  const out = buildConnectionUrl({ search: FULL, origin: 'http://127.0.0.1:5199' });
  assert.equal(out.channel, 'lobby');
  assert.equal(out.room, true);
  assert.equal(out.path, '/lobby' + FULL);
  assert.equal(out.url, 'ws://127.0.0.1:5199/lobby' + FULL);
  // 透传：字段顺序、编码都不能被重排（中文用户名的 percent 编码必须原样）
  assert.ok(out.path.includes('%E6%88%BF%E4%B8%BB'));
});

test('buildConnectionUrl: 没有进房参数时退回 /ws（单机/测试路径）', () => {
  for (const search of ['', '?debug', '?room=123456', '?type=create&token=x']) {
    const out = buildConnectionUrl({ search, origin: 'http://127.0.0.1:5199' });
    assert.equal(out.channel, 'ws', `search=${search} 应该走 /ws`);
    assert.equal(out.path, '/ws');
    assert.equal(out.url, 'ws://127.0.0.1:5199/ws');
    assert.equal(out.room, false);
  }
});

test('buildConnectionUrl: https 页面用 wss，http 页面用 ws', () => {
  assert.equal(buildConnectionUrl({ search: FULL, origin: 'https://a.example' }).url.startsWith('wss://a.example/lobby?'), true);
  assert.equal(buildConnectionUrl({ search: '', origin: 'https://a.example' }).url, 'wss://a.example/ws');
  assert.equal(buildConnectionUrl({ search: FULL, origin: 'http://a.example:8080' }).url.startsWith('ws://a.example:8080/lobby?'), true);
});

test('buildConnectionUrl: 给不出 origin 时只回 path（不拼出 ws://null）', () => {
  const out = buildConnectionUrl({ search: FULL, origin: '' });
  assert.equal(out.url, '/lobby' + FULL);
  assert.equal(buildConnectionUrl({ search: '' }).url, '/ws');
});

test('resolveSearch: 地址栏有完整参数时用地址栏；否则回退 sessionStorage', () => {
  assert.deepEqual(resolveSearch({ search: FULL, stored: null }), { search: FULL, source: 'url' });
  const stored = { token: 'tk', id: 'key', type: 'create', roomid: '123456', invcode: 'QQ', username: '阿三' };
  const back = resolveSearch({ search: '?debug', stored });
  assert.equal(back.source, 'session');
  assert.equal(back.search.startsWith('?'), true);
  assert.deepEqual(parseRoomQuery(back.search), stored);
  // 两边都没有 → 空
  assert.deepEqual(resolveSearch({ search: '', stored: null }), { search: '', source: 'none' });
  // sessionStorage 里的垃圾也不能拼出半条参数
  assert.deepEqual(resolveSearch({ search: '', stored: { token: 'x' } }), { search: '', source: 'none' });
});

test('roomCredentialFrom: welcome.room + 原始 query 合成一份可落盘的凭据', () => {
  const welcome = { role: 'controller', room: { id: '123456', username: '房主', role: 'owner', seat: true } };
  assert.deepEqual(roomCredentialFrom(welcome, FULL), {
    type: 'create',
    token: 'a'.repeat(64),
    id: 'f'.repeat(64),
    roomid: '123456',
    invcode: 'QYXQWN83',
    username: '房主',
  });
  // 单机 /ws 的 welcome 没有 room → 不写 sessionStorage
  assert.equal(roomCredentialFrom({ role: 'controller' }, FULL), null);
  assert.equal(roomCredentialFrom(null, FULL), null);
  // 房间号形状不对 → 不认（防止把 'undefined' 存进去）
  assert.equal(roomCredentialFrom({ room: { id: 'abc' } }, FULL), null);
  // query 里没有 username 时退回 room.username
  const q = '?token=t&id=i&type=join&roomid=654321';
  assert.equal(roomCredentialFrom({ room: { id: '654321', username: '路人' } }, q).username, '路人');
});

test('scrubbedQuery: 只留 ?room=<6位房间号>', () => {
  assert.equal(scrubbedQuery('123456'), '?' + ROOM_PARAM + '=123456');
  // 形状不对时一个参数都不留（地址栏回到干净的 /）
  assert.equal(scrubbedQuery('12345'), '');
  assert.equal(scrubbedQuery(''), '');
  assert.equal(scrubbedQuery(null), '');
  // 擦除结果里绝不能再出现 token / id / invcode
  const s = scrubbedQuery('123456');
  for (const k of ['token', 'invcode', 'id=']) assert.equal(s.includes(k), false, `擦除后仍含 ${k}`);
});

test('readScrubbedRoomId: 从擦除后的地址栏读回房间号', () => {
  assert.equal(readScrubbedRoomId('?room=123456'), '123456');
  assert.equal(readScrubbedRoomId('?room=123456&debug'), '123456');
  assert.equal(readScrubbedRoomId('?debug'), '');
  assert.equal(readScrubbedRoomId(''), '');
  assert.equal(readScrubbedRoomId('?room=notanumber'), '');
});

// 服务端 /api/net/room/check 与 /lobby 握手回复体里的 7 个 code（backend-gateway 契约）
// 逐个做全：不靠 HTTP 状态码猜原因，而是让 code 直接决定文案。
test('describeLobbyError: 7 个服务端 code 各有专属中文文案，不靠状态码猜', () => {
  assert.equal(describeLobbyError(400, 'BAD_REQUEST'), '进房参数不合法（缺少 token / ID 密钥，或 type 写错）');
  assert.equal(describeLobbyError(404, 'ROOM_NOT_FOUND'), '房间不存在或已关闭');
  assert.equal(describeLobbyError(404, 'TOKEN_MISMATCH'), '房间 Token 不匹配（链接被改过或已过期）');
  assert.equal(describeLobbyError(404, 'INVCODE_MISMATCH'), '邀请码不匹配（这是另一个房间的邀请码）');
  assert.equal(describeLobbyError(501, 'LOBBY_DISABLED'), '这台服务器没有启用联机大厅');
  assert.equal(describeLobbyError(429, 'RATE_LIMIT'), '请求太频繁，等几秒再进');
  assert.equal(describeLobbyError(500, 'INTERNAL'), '服务器内部错误，稍后再试');
  // 同一个 HTTP 状态码 + 不同 code 必须给出不同文案（否则"码优先"就是假的）
  assert.notEqual(describeLobbyError(404, 'ROOM_NOT_FOUND'), describeLobbyError(404, 'TOKEN_MISMATCH'));
  // code 大小写不敏感，且带房间号时前缀房间号
  assert.equal(describeLobbyError(404, 'token_mismatch', { roomId: '123456' }), '房间 123456 房间 Token 不匹配（链接被改过或已过期）');
  // 7 个 code 全部在映射表里，且都是人话（非空字符串）
  for (const code of ['BAD_REQUEST', 'ROOM_NOT_FOUND', 'TOKEN_MISMATCH', 'INVCODE_MISMATCH', 'LOBBY_DISABLED', 'RATE_LIMIT', 'INTERNAL']) {
    assert.equal(typeof LOBBY_CODE_TEXT[code], 'string', `${code} 缺文案`);
    assert.ok(LOBBY_CODE_TEXT[code].length > 0, `${code} 文案为空`);
  }
});

test('describeLobbyError: 拿不到 code 时退回按 HTTP 状态码说人话', () => {
  assert.equal(describeLobbyError(400, ''), '进房参数不合法（缺少 token / ID密钥，或 type 写错）');
  assert.equal(describeLobbyError(404, ''), '鉴权失败（房间不存在或 Token 不匹配）');
  assert.equal(describeLobbyError(429, ''), '请求太频繁，等几秒再进');
  assert.equal(describeLobbyError(500, ''), '服务器内部错误，稍后再试');
  assert.equal(describeLobbyError(501, ''), '这台服务器没有启用联机大厅');
});

test('isFatalLobbyCode: 改链接才能好的 code 才算 fatal，限流/内部错还能重连', () => {
  for (const code of ['BAD_REQUEST', 'ROOM_NOT_FOUND', 'TOKEN_MISMATCH', 'INVCODE_MISMATCH', 'LOBBY_DISABLED']) {
    assert.equal(isFatalLobbyCode(code), true, `${code} 应当判为致命`);
    assert.equal(LOBBY_FATAL_CODES.includes(code), true);
  }
  for (const code of ['RATE_LIMIT', 'INTERNAL', 'NETWORK', '', 'nonsense']) {
    assert.equal(isFatalLobbyCode(code), false, `${code} 不该判为致命`);
  }
  assert.equal(isFatalLobbyCode('room_not_found'), true); // 大小写不敏感
});

test('describeLobbyError: 浏览器只给 close(1006) 时，带房间号说"可能不存在或 Token 不匹配"', () => {
  const t = describeLobbyError(0, '', { roomId: '123456' });
  assert.equal(t, '房间 123456 鉴权失败（可能房间不存在或 Token 不匹配）');
  assert.equal(describeLobbyError(0, ''), '房间鉴权失败（可能房间不存在或 Token 不匹配）');
  // 未知状态码也要回一句人话，不能把 undefined 喷到横幅上
  assert.equal(describeLobbyError(418, ''), '进房失败（HTTP 418）');
  assert.equal(typeof LOBBY_CODE_TEXT.BAD_REQUEST, 'string');
});

test('normalizeLobbyPlayers: 过滤别间房、补默认值、房主排第一', () => {
  const raw = [
    { idKey: 'b', username: '小明', characterId: null, online: true, role: 'spectator', roomId: '123456' },
    { idKey: 'a', username: '房主', characterId: 's1-01', online: true, role: 'owner', roomId: '123456' },
    { idKey: 'c', username: '别间房的人', online: true, role: 'spectator', roomId: '999999' },
    null,
    'junk',
  ];
  const out = normalizeLobbyPlayers(raw, '123456');
  assert.equal(out.length, 2);
  assert.equal(out[0].username, '房主');
  assert.equal(out[0].role, 'owner');
  assert.equal(out[1].role, 'spectator');
  // 非法输入一律回 []
  assert.deepEqual(normalizeLobbyPlayers(null), []);
  assert.deepEqual(normalizeLobbyPlayers(undefined, '123456'), []);
  assert.deepEqual(normalizeLobbyPlayers({}, '123456'), []);
});

test('countOnline / roomBadgeText: HUD 徽章文案「房间 123456 · 在线 n」', () => {
  assert.equal(countOnline([{ online: true }, { online: false }, { online: true }]), 2);
  assert.equal(countOnline(null), 0);
  assert.equal(roomBadgeText({ roomId: '123456', players: [{ online: true }, { online: true }] }), '房间 123456 · 在线 2');
  // 玩家列表还没到：只显示房间号，不要骗人说"在线 0"
  assert.equal(roomBadgeText({ roomId: '123456', players: null }), '房间 123456');
  assert.equal(roomBadgeText({ roomId: '123456', players: [{ online: true }], isSpectator: true }), '房间 123456 · 在线 1 · 观战中');
  // 单机（无房间）→ 返回空串，调用方据此把徽章藏起来
  assert.equal(roomBadgeText({}), '');
  assert.equal(roomBadgeText({ roomId: 'abc' }), '');
});

test('canSendAsRole: 观战者不发操作类指令，房主不受限', () => {
  assert.equal(canSendAsRole('controller', 'input.move'), true);
  assert.equal(canSendAsRole('controller', 'join'), true);
  assert.equal(canSendAsRole('spectator', 'input.move'), false);
  for (const type of ['join', 'leave', 'pause', 'item.use', 'input.action', 'jc.commit', 'set.speed']) {
    assert.equal(canSendAsRole('spectator', type), false, `观战者不该能发 ${type}`);
  }
  // 心跳与重同步是连接层的，观战者必须能发（否则会被服务端心跳踢掉）
  for (const type of ['ping', 'resync']) assert.equal(canSendAsRole('spectator', type), true, `观战者要能发 ${type}`);
  assert.equal(SPECTATOR_BLOCKED.has('join'), true);
  assert.equal(SPECTATOR_BLOCKED.size >= 9, true);
});

test('canSendAsRoleStrict: 观战者只放行 ping/resync，其余上行（含将来新加的）一律拒绝', () => {
  // 这条是"黑名单漏项"的兜底：canSendAsRole 用的是黑名单，漏一条就等于观战者能发
  assert.deepEqual([...SPECTATOR_ALLOWED].sort(), ['ping', 'resync']);
  for (const type of ['ping', 'resync']) assert.equal(canSendAsRoleStrict('spectator', type), true);
  for (const type of ['input.move', 'input.action', 'item.buy', 'item.upgrade', 'item.use', 'join', 'leave',
    'pause', 'set.speed', 'jc.commit', 'start', 'lobby', 'hello', '一条还没定义的上行指令']) {
    assert.equal(canSendAsRoleStrict('spectator', type), false, `观战者不该能发 ${type}`);
  }
  // 房主/单机（role 不是 spectator）完全不受限
  assert.equal(canSendAsRoleStrict('controller', 'input.action'), true);
  assert.equal(canSendAsRoleStrict(null, 'start'), true);
});

test('canStartGame: 只有 welcome.room.seat === true 才允许开始游戏', () => {
  assert.equal(canStartGame({ room: { seat: true } }), true);
  // 观战者：有 room 但 seat=false —— 老版本只看 room 存不存在，观战者点一下就能开局，这里守住
  assert.equal(canStartGame({ room: { seat: false } }), false);
  assert.equal(canStartGame({ room: { id: '123456' } }), false);
  assert.equal(canStartGame({}), false);
  assert.equal(canStartGame(null), false);
  assert.equal(canStartGame(undefined), false);
});

test('normalizeLobbyPlayers: role 三态 owner/spectator/pending，待审批排在最后别混进成员', () => {
  const raw = [
    { idKey: 'aa', username: '小明', characterId: null, online: false, role: 'pending', roomId: '123456' },
    { idKey: 'bb', username: '小红', characterId: null, online: true, role: 'spectator', roomId: '123456' },
    { idKey: 'cc', username: '房主', characterId: 's1-01', online: true, role: 'owner', roomId: '123456' },
    { idKey: 'dd', username: '未知角色', online: true, role: 'whatever', roomId: '123456' },
  ];
  const out = normalizeLobbyPlayers(raw, '123456');
  // 房主第一，其次观战者（同为 spectator 的按 localeCompare 排：'未知角色' 在 '小红' 前），待审批垫底
  assert.deepEqual(out.map((p) => p.username), ['房主', '未知角色', '小红', '小明']);
  // 关键回归：pending 绝不能被吞成 spectator（旧实现就是在这里骗人的）
  assert.equal(out[0].role, 'owner');
  assert.equal(out[1].role, 'spectator');
  assert.equal(out[3].role, 'pending');
  // 未知 role 一律按 spectator 处理，不要漏人
  assert.equal(out[2].role, 'spectator');
  assert.deepEqual(ROLE_RANK, { owner: 0, spectator: 1, pending: 2 });
});

test('splitLobbyPlayers: 房主一条、观战者若干、待审批单独一组', () => {
  const list = normalizeLobbyPlayers([
    { username: '房主', role: 'owner', online: true, characterId: 's1-01', roomId: '123456' },
    { username: '甲', role: 'spectator', online: true, roomId: '123456' },
    { username: '乙', role: 'pending', online: false, roomId: '123456' },
    { username: '丙', role: 'pending', online: false, roomId: '123456' },
  ], '123456');
  const g = splitLobbyPlayers(list);
  assert.equal(g.owner.username, '房主');
  assert.deepEqual(g.spectators.map((p) => p.username), ['甲']);
  // 同一角色内按名字排序（乙/丙 的拼音是 yi/bing，localeCompare 把「丙」排前面）
  assert.deepEqual(g.pending.map((p) => p.username), [...g.pending.map((p) => p.username)].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
  assert.equal(g.pending.length, 2);
  // 空/脏输入不抛
  assert.deepEqual(splitLobbyPlayers(null), { owner: null, spectators: [], pending: [] });
  assert.deepEqual(splitLobbyPlayers([null, undefined, 1, 'x']), { owner: null, spectators: [], pending: [] });
});

test('canModerateRoom: 只有房主能点头同意/踢人，观战者一个按钮都没有', () => {
  // 观战者（seat=false）连行内按钮都不该看到，而不是"点了被服务端 403"
  assert.equal(canModerateRoom({ seat: false }, 'kick'), false);
  assert.equal(canModerateRoom({}, 'kick'), false);
  assert.equal(canModerateRoom(null, 'kick'), false);
  // 房主：踢人 / 同意 / 拒绝都行
  for (const act of ['kick', 'approve', 'reject']) assert.equal(canModerateRoom({ seat: true }, act), true, act);
  assert.equal(canModerateRoom({ seat: true }, 'start'), true);
  // 已开局 = 房间锁定：不能再"开始"，但已进来的人仍可被踢（锁定的是入房，不是清场）
  assert.equal(canModerateRoom({ seat: true, started: true }, 'start'), false);
  assert.equal(canModerateRoom({ seat: true, started: true }, 'kick'), true);
  // 不认识的 action 一律拒绝（别把未知字符串直接拼进 /api/lobby/room/<action>）
  assert.equal(canModerateRoom({ seat: true }, 'drop-database'), false);
  // 座位制（v0.9）追加 seat / settings 两条路由；canModerateRoom 的判据是"需要房主"，
  // 所以 seat（成员都能坐自己那行）不算房主专属，settings 算。
  assert.deepEqual([...ROOM_ACTIONS], ['start', 'kick', 'approve', 'reject', 'seat', 'settings']);
  assert.deepEqual([...OWNER_ROOM_ACTIONS], ['start', 'kick', 'approve', 'reject', 'settings']);
  assert.equal(canModerateRoom({ seat: true }, 'settings'), true);
  assert.equal(canModerateRoom({ seat: false }, 'settings'), false);
  assert.equal(canModerateRoom({ seat: true, started: true }, 'settings'), false);
});

test('startButtonState: 房主可点「开始游戏」，观战者「等待房主开始」，开局后「已开始」', () => {
  assert.deepEqual(startButtonState({ seat: true, started: false }), { text: '开始游戏', disabled: false, locked: false });
  // 观战者：按钮在但那句话本身就已经说明"这不归你"
  assert.deepEqual(startButtonState({ seat: false, started: false }), { text: '等待房主开始', disabled: true, locked: false });
  assert.equal(startButtonState({}).disabled, true);
  assert.equal(startButtonState().disabled, true);
  // 正在请求：按钮先禁掉，防连点（连点会把 startRoom 打两遍）
  assert.deepEqual(startButtonState({ seat: true, started: false }, true), { text: '正在开始…', disabled: true, locked: false });
  // 开局后锁房：文案与 locked 位都要变
  assert.deepEqual(startButtonState({ seat: true, started: true }), { text: '已开始', disabled: true, locked: true });
  assert.equal(startButtonState({ seat: false, started: true }).locked, true);
});

test('roomLockNote: 只有开局后才提示「房间已锁定，不再接受新成员」', () => {
  assert.equal(roomLockNote(false), '');
  assert.equal(roomLockNote(undefined), '');
  assert.equal(roomLockNote(false, 3), '');
  assert.equal(roomLockNote(true), '房间已锁定，不再接受新成员');
  // 还有没处理完的申请时要说清楚，否则房主以为门口没人
  assert.equal(roomLockNote(true, 2), '房间已锁定，不再接受新成员（还有 2 条申请没处理）');
  assert.equal(roomLockNote(true, 0), '房间已锁定，不再接受新成员');
});

/* ------------------------------------------------------------------ 座位制（v0.9）
   这一组守的是「谁坐哪个座位」—— 大厅去掉选人 UI 之后，座位是唯一的角色来源。
   判定全在 roomUrl.js 的纯函数里，DOM 只负责画；所以回归成本最低的地方就在这里。 */

/** 一份典型 roster：两个学生（1 班）+ 一个老师（id 里带 t 前缀，与 Lobby.js 的老约定一致）。 */
const ROSTER = [
  { id: 's1-01', name: '小明', role: 'student', classId: 1, username: 'xiaoming' },
  { id: 's1-02', name: '小红', role: 'student', classId: 1, username: 'xiaohong' },
  { id: 't-01', name: '王老师', role: 'teacher', classId: 1, username: 'wang' },
];

test('seatRows: 成员一行，seats 优先于 players.characterId，pending 不占行', () => {
  const players = normalizeLobbyPlayers([
    { username: '房主', role: 'owner', online: true, roomId: '123456' },
    { username: '甲', role: 'spectator', online: true, roomId: '123456' },
    { username: '乙', role: 'spectator', online: false, roomId: '123456' },
    { username: '门口', role: 'pending', online: false, roomId: '123456' },
  ], '123456');
  const rows = seatRows(players, { 房主: 't-01' }, ROSTER);
  // 待审批的人不进座位表（他还没进来，给他留一行会让房主以为房间里多个人）
  assert.deepEqual(rows.map((r) => r.username), ['房主', '甲', '乙']);
  assert.equal(rows[0].isOwner, true);
  assert.equal(rows[0].characterId, 't-01');
  assert.equal(rows[0].charName, '王老师');
  assert.equal(rows[0].charRole, 'teacher');
  // 没坐座位的人：characterId 为 null，座位文案空（渲染层显示"未选座位"）
  assert.equal(rows[1].characterId, null);
  assert.equal(rows[1].seatLabel, '');
  assert.equal(rows[2].online, false);
  // seats 的优先级：players 里那份 characterId 是"控制位那台机器在用的角色"，房主刚指派的新座位还没推过来
  const withChar = seatRows(
    [{ username: '甲', role: 'spectator', online: true, characterId: 's1-01' }],
    { 甲: 's1-02' },
    ROSTER,
  );
  assert.equal(withChar[0].characterId, 's1-02');
  assert.equal(withChar[0].charName, '小红');
  // 没有任何 seats 时才退回 players.characterId
  const fallback = seatRows([{ username: '甲', role: 'spectator', online: true, characterId: 's1-01' }], null, ROSTER);
  assert.equal(fallback[0].characterId, 's1-01');
  // 脏输入一律回 []，绝不能抛（房间面板是 replaceChildren 一次性重画的，抛了整块面板就空白）
  assert.deepEqual(seatRows(null), []);
  assert.deepEqual(seatRows(undefined, { a: 'b' }), []);
  assert.deepEqual(seatRows([null, 'x', 1]), []);
  // roster 缺失时仍然出行，只是名字退回 characterId（不认识的 id 原样显示，别吞掉）
  const noRoster = seatRows([{ username: '甲', role: 'spectator', online: true }], { 甲: 's9-99' }, null);
  assert.equal(noRoster[0].charName, 's9-99');
  assert.equal(noRoster[0].charRole, '');
});

test('markSeatRows: 自己那行能点；房主能替所有人指派；开局后一律锁死', () => {
  const rows = seatRows([
    { username: '房主', role: 'owner', online: true },
    { username: '甲', role: 'spectator', online: true },
  ], {}, ROSTER);
  // 房主视角：两行都能改
  const owner = markSeatRows(rows, '房主', { seat: true, started: false });
  assert.deepEqual(owner.map((r) => r.canPick), [true, true]);
  assert.deepEqual(owner.map((r) => r.canAssign), [true, true]);
  assert.deepEqual(owner.map((r) => r.isMe), [true, false]);
  // 观战者视角：只能点自己那一行，别人的指派按钮一个都不该有
  const guest = markSeatRows(rows, '甲', { seat: false, started: false });
  assert.deepEqual(guest.map((r) => r.canPick), [false, true]);
  assert.deepEqual(guest.map((r) => r.canAssign), [false, false]);
  assert.deepEqual(guest.map((r) => r.isMe), [false, true]);
  // 已开局：座位锁死（服务端 RoomManager.claimSeat 也会回 ROOM_STARTED，前端先别给按钮）
  const locked = markSeatRows(rows, '房主', { seat: true, started: true });
  assert.deepEqual(locked.map((r) => r.canPick), [false, false]);
  assert.deepEqual(locked.map((r) => r.canAssign), [false, false]);
  // 没有用户名的观战者（不该出现，但别让 isMe 变成 true）
  assert.equal(markSeatRows(rows, '', { seat: false })[0].isMe, false);
  assert.deepEqual(markSeatRows(null, '甲', {}), []);
});

test('seatSummary: 还差谁没选座位（房主开局前要一眼看出来）', () => {
  const rows = markSeatRows(seatRows([
    { username: '房主', role: 'owner', online: true },
    { username: '甲', role: 'spectator', online: true },
    { username: '乙', role: 'spectator', online: true },
  ], { 房主: 's1-01' }, ROSTER));
  assert.deepEqual(seatSummary(rows), { seated: 1, unseated: ['甲', '乙'], total: 3 });
  assert.deepEqual(seatSummary([]), { seated: 0, unseated: [], total: 0 });
  assert.deepEqual(seatSummary(null), { seated: 0, unseated: [], total: 0 });
});

test('rosterGrid: 学生在前老师在后，别人坐着的置灰、自己坐着的不置灰、开局后全灰', () => {
  const grid = rosterGrid(ROSTER, { seats: { 甲: 's1-01', 我: 't-01' }, me: '我' });
  assert.deepEqual(grid.map((g) => g.key), ['student', 'teacher']);
  assert.equal(grid[0].chars.length, 2);
  assert.equal(grid[1].chars.length, 1);
  const xiaoming = grid[0].chars.find((c) => c.id === 's1-01');
  // 被「甲」坐着：置灰并说明是谁
  assert.equal(xiaoming.disabled, true);
  assert.equal(xiaoming.takenBy, '甲');
  assert.equal(xiaoming.isMine, false);
  const xiaohong = grid[0].chars.find((c) => c.id === 's1-02');
  assert.equal(xiaohong.disabled, false);
  assert.equal(xiaohong.classLabel, '1 班');
  // 自己坐着的那个：不算被抢，仍然可点（点了还是自己）
  const wang = grid[1].chars[0];
  assert.equal(wang.isMine, true);
  assert.equal(wang.takenBy, '');
  assert.equal(wang.disabled, false);
  assert.equal(wang.classLabel, '老师');
  // 开局后一律置灰
  const locked = rosterGrid(ROSTER, { locked: true, seats: {}, me: '我' });
  assert.equal(locked.every((g) => g.chars.every((c) => c.disabled)), true);
  // 脏 roster 不抛
  assert.deepEqual(rosterGrid(null), []);
  assert.deepEqual(rosterGrid([null, {}, 'x']), []);
});

test('settingsLabel / settingsPatch: 房间参数说人话，非法输入在本地就拦下', () => {
  assert.equal(settingsLabel({ durationMs: 600000, targetScore: 100 }), '单局 10 分钟 · 目标 100 分');
  assert.equal(settingsLabel({ durationMs: null, targetScore: null }, { durationMs: 300000, targetScore: 0 }), '单局 5 分钟 · 不限时结束（看积分）');
  assert.equal(settingsLabel(null, null), '不限时结束（看积分）');
  // 只带改了的键：空着的输入框 = 不动它（不回默认）
  assert.deepEqual(settingsPatch({ minutes: '10', targetScore: '200' }), { ok: true, body: { durationMs: 600000, targetScore: 200 } });
  assert.deepEqual(settingsPatch({ minutes: '', targetScore: '' }), { ok: true, body: {} });
  assert.deepEqual(settingsPatch({ minutes: '0.5' }).body, { durationMs: 30000 });
  // 越界在本地拦：别让服务器 400 打个红字回来
  assert.equal(settingsPatch({ minutes: '0' }).ok, false);
  assert.equal(settingsPatch({ minutes: '241' }).ok, false);
  assert.equal(settingsPatch({ minutes: 'abc' }).ok, false);
  assert.equal(settingsPatch({ targetScore: '-1' }).ok, false);
  assert.equal(settingsPatch({ targetScore: '1000001' }).ok, false);
  assert.equal(settingsPatch({}).ok, true);
});

test('defaultSoloCharacter: 单机不再选人，优先上次用的角色，其次第一个学生', () => {
  assert.equal(defaultSoloCharacter(ROSTER, 's1-02').id, 's1-02');
  // lastChar 不在 roster 里（配置换了/角色删了）→ 退回第一个学生
  assert.equal(defaultSoloCharacter(ROSTER, 'nope').id, 's1-01');
  assert.equal(defaultSoloCharacter(ROSTER, '').id, 's1-01');
  // 一个学生都没有时才用老师
  assert.equal(defaultSoloCharacter([{ id: 't-01', name: '王老师', role: 'teacher' }], '').id, 't-01');
  // roster 为空 → null（渲染层据此把开始按钮禁掉，而不是崩）
  assert.equal(defaultSoloCharacter([], 's1-01'), null);
  assert.equal(defaultSoloCharacter(null, 's1-01'), null);
});

test('常量形状：ROOM_KEY / ROOM_PARAM / ROOM_TYPES 与契约一致', () => {
  assert.equal(ROOM_KEY, 'jican.room');
  assert.equal(ROOM_PARAM, 'room');
  assert.deepEqual([...ROOM_TYPES], ['create', 'join']);
  assert.equal(Object.isFrozen(ROOM_TYPES), true);
  assert.equal(SPECTATOR_BLOCKED instanceof Set, true); // Set 冻结不了内容，真正的门是 canSendAsRole
});
