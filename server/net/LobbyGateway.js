// 联机网关（v0.3）：把「URL 里的房间参数」翻译成「这个连接该当什么角色」。
//
// 需求原文是「房间鉴权 + 玩家列表 + 全员一个房间 + 延迟 < 100ms」：
// - 房间鉴权：ws 升级时必须能对上房间号 + token（或邀请码），对不上就 404，绝不让陌生人连进来；
// - 全员一个房间：一个房间只有一个「玩家」座位（房主），其余人都是观战 —— 观战能看、不能操作，
//   由 MessageRouter 的 conn.role !== 'controller' 兜住；
// - 玩家列表：playerList() 给前端渲染用的扁平数组，字段名是前后端约定的（见下），不要改名；
// - 延迟 < 100ms：这个类**不做**任何缓冲、节流、批量合并，纯粹是内存里的 Map 查表 + 一次 O(n) 遍历。

/** 房间号固定 6 位数字（RoomManager.makeRoomId 生成的就是这个形状）。 */
const ROOM_ID_RE = /^\d{6}$/;

/** idKey 的展示提示：256 位 hex 太长，列表里只显示前 8 位（够区分，也不泄露完整密钥）。 */
export function idKeyHint(idKey) {
  const s = String(idKey ?? '');
  return s ? s.slice(0, 8) : '';
}

export class LobbyGateway {
  /**
   * @param {object} opt
   * @param {import('./RoomManager.js').RoomManager} opt.rooms   房间表
   * @param {{onConnectionRestored?:Function,onConnectionLost?:Function}} [opt.controller] 目前的单控制会话控制器（可空）
   * @param {Console} [opt.logger]
   */
  constructor({ rooms, controller = null, logger = console, broadcast = null } = {}) {
    this.rooms = rooms;
    this.controller = controller;
    this.onBroadcast = typeof broadcast === 'function' ? broadcast : null;
    this.log = logger ?? console;
    // idKey → characterId：玩家选的「角色」。只在内存里，重连后仍在（进程重启就没了，这是有意的：
    // 角色是这一局的选择，不该写进配置文件）。
    this.characters = new Map();
    // idKey → username：座位表是按用户名记的（room.seats: username → characterId），
    // 而 ws 握手时手上只有 idKey，要有这一张表才能把「我有没有座位」翻译出来。
    this.usernames = new Map();
    // wsQuery: type 缺省时按「未鉴权」的本地连接处理（/ws 老路径），存下来是为了 welcome 里能区分。
    this.stats = { resolved: 0, denied: 0 };
    // 在线连接：只有「真的完成了 ws 握手、坐在座位上」的人算在线。
    // 不能再用 controller.hasConnection() —— 那是「有没有人控制着这台机器全局的那一局」，
    // 跟「这个房间里的人在不在」是两件事（房主还没连上时它会说 true，房主连上后又可能被别人占着）。
    this.conns = new Set();
  }

  /**
   * 登记/注销一条联机连接（WsServer 在 hello 成功后调，close 时注销）。
   * @param {{idKey:string, username:string}} info
   * @returns {() => void} 注销函数（幂等）
   */
  trackConnection(info) {
    const rec = { idKey: String(info?.idKey ?? ''), username: String(info?.username ?? '') };
    this.conns.add(rec);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.conns.delete(rec);
    };
  }

  /** 某个用户名此刻是否有活着的连接（房主那条按 idKey 认，成员按 username 认）。 */
  isOnline(room, name, isOwner = false) {
    for (const rec of this.conns) {
      if (isOwner ? rec.idKey === String(room.ownerId ?? '') : rec.username === String(name)) return true;
    }
    return false;
  }

  /**
   * 解析一条 ws 升级请求的 query，判断该连接的身份。
   * 返回 { ok:true, room, seat:boolean, role, pending?:boolean } 或 { ok:false, status, code, message }。
   *
   * v0.8 新增的失败 code（前端按 code 分支提示，不要看 message 文案）：
   * - ROOM_STARTED（403）：房主已开局，房间不再收人；
   * - KICKED（403）：这个用户名被房主移出过；
   * - NOT_OWNER（403）：只有房主能开局/踢人/审批（出现在 startRoom 与 4 条 /api/lobby/room/* 路由）；
   * - NO_CHARACTER（400）：房主还没选角色就点开始；
   * - NO_PENDING（404）：审批的 username 不在申请队列里；
   * - CANNOT_KICK_OWNER（400）：不能把房主自己移出房间。
   * 成功时的 role：'controller'（房主）/ 'spectator'（已审批成员）/ 'pending'（刚提交申请，等审批）。
   *
   * status/code 的分工（WsServer 直接写进 HTTP 状态行，前端据此区分「改地址」还是「重试」）：
   * - 400：参数不全（缺 token / id / type 写错）—— 用户把地址粘错了；
   * - 404：房间不存在、token 或邀请码不匹配 —— 房间关了或被踢；
   * - 500：我们自己算崩了。
   */
  resolve(query, { probe = false } = {}) {
    const q = typeof query === 'string' ? new URLSearchParams(query) : new URLSearchParams(query ?? {});
    const token = String(q.get('token') ?? '').trim();
    const idKey = String(q.get('id') ?? '').trim();
    const type = String(q.get('type') ?? '').trim();
    const roomId = String(q.get('roomid') ?? '').trim();
    const invCode = String(q.get('invcode') ?? '').trim();
    const username = String(q.get('username') ?? '').trim();

    // 没有 type 的连接是老的 /ws（本机单机/测试用），交给 WsServer 按「首个连接 = 控制端」的老规则处理
    if (!type) return { ok: true, room: null, seat: false, role: 'legacy', pending: true };

    if (!token) return { ok: false, status: 400, code: 'BAD_REQUEST', message: '缺少 token' };
    if (!idKey) return { ok: false, status: 400, code: 'BAD_REQUEST', message: '缺少 id（ID 密钥）' };
    if (type !== 'create' && type !== 'join') return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'type 必须是 create 或 join' };

    let room = null;
    if (type === 'join') {
      if (!roomId) return { ok: false, status: 400, code: 'BAD_REQUEST', message: '加入房间必须带 roomid' };
      if (!ROOM_ID_RE.test(roomId)) return { ok: false, status: 400, code: 'BAD_REQUEST', message: '房间号必须是 6 位数字' };
      room = this.rooms.rooms.get(roomId) ?? null;
      if (!room) return { ok: false, status: 404, code: 'ROOM_NOT_FOUND', message: '房间不存在或已关闭' };
      // 被房主移出过的人：直接拒。这一条放在「已开局」之前 —— 他的语义是「你被请出去了」，
      // 而不是「这局已经开始了」，前端要显示的是完全不同的提示文案。
      if (this.rooms.isKicked(room, username)) return { ok: false, status: 403, code: 'KICKED', message: '你已被房主移出房间' };
      // 房主点了「开始游戏」之后房间就锁上了：不再让人进来（房主自己走 create 一路，不受影响）。
      //
      // 例外（v0.10，用户报「两个窗口互相只能观战、开不了战斗」的根因）：
      // 锁门的目的是「不接新成员」，不是「把已经在屋里的人赶出去」。判据里必须先放行**已经是这间房成员的身份**：
      //   - 房间门口认的是 idKey（ID 密钥），同一个浏览器开的两个窗口共用一份 idKey；
      //   - 所以"我自己的第二个窗口 / 关掉游戏窗口后重开"如果撞上 ROOM_STARTED，就会被无限重连 → 界面停在最后一帧，
      //     前端再把 spectator 当成"被夺权"，用户看到的就是"两个窗口互相只能观战"。
      // 已经是成员（members 里有这个名字，或这个 idKey 就是房主 / 有房间级身份）就一律放行，
      // 让 WsServer 照常按座位表给他 role/seat —— 该控制的控制，该旁观的旁观，但连接不再被 403 打断。
      if (room.started && !this.alreadyInRoom(room, idKey, username)) {
        return { ok: false, status: 403, code: 'ROOM_STARTED', message: '房主已开始游戏，不再接受新成员' };
      }
      if (room.token !== token) return { ok: false, status: 404, code: 'TOKEN_MISMATCH', message: '房间 Token 不匹配' };
      // 邀请码是「进房」的第二把锁：房主分享的链接里带它，光有 token 不够
      if (room.invCode !== invCode) return { ok: false, status: 404, code: 'INVCODE_MISMATCH', message: '邀请码不匹配' };
      // v0.8 排队制：鉴权通过**不等于**进房。先挂进 pending 队列，房主 approve 之后才是成员。
      // 为什么不再直接 members.add：房主要能在人进来之前看一眼「谁申请了」，并把捣乱的拒掉。
      // 这里必须严格区分 probe：probe=true（/api/net/room/check 预探测）**只校验参数，零副作用** ——
      // 探测一下就往队列里塞一条申请，房主的面板上会冒出根本没连上来的幽灵申请。
      if (!probe && username) {
        if (username !== room.username && !room.members.has(username)) {
          this.rooms.addPending(room, { idKey, username });
          return { ok: true, room, idKey, username, seat: false, role: 'pending', pending: true };
        }
        // 房主自己 / 已是成员：直接算成员，不进队列
        room.members.add(username);
        const seat = this.isSeat(room, idKey);
        return { ok: true, room, idKey, username, seat, role: seat ? 'controller' : 'spectator', pending: false };
      }
    } else {
      // create：房主自己那条连接。房间可能还没建（HTTP /api/net/room 先建），
      // 也可能已建；两种都接受，但不许凭空造房间（造了就没 token 校验的意义了）。
      //
      // probe（/api/net/room/check 预探测）语义：**只校验「这组参数本身能不能用来建房」**，
      // 只要 token/id/type 合法就返回 ok —— 不看这个 idKey 是不是已经开着房间。
      // 为什么：面板上「创建房间」按钮点下去之前会先 check 一次，如果这里按「同一 ID 只能开一个房间」
      // 判定，用户点创建就莫名其妙吃到 400；真正的上限/封禁判定在 POST /api/net/room 里做（那里才有副作用与提示）。
      room = roomId ? this.rooms.rooms.get(roomId) ?? null : (this.rooms.byUser(idKey)[0] ?? null);
      if (!room) {
        // probe 且还没房间：ok（参数合法就能建房，不需要先存在一个房间）
        if (probe) return { ok: true, room: null, idKey, username, seat: true, role: 'controller', willCreate: true };
        return { ok: false, status: 404, code: 'ROOM_NOT_FOUND', message: '房间不存在或已关闭' };
      }
      // 已有房间：token 必须对得上（不能拿任意 token 白拿去查别人的房间）。
      // probe 时 token 不对不算失败 —— 用户手里的 token 与「这个人名下那间房」的 token 本来就不同
      // （换机/重装后是新的 token），此时语义是「我能不能新建一间」，答案仍然是能；
      // 真正的 token 校验发生在真连接 /lobby 与 POST /api/net/room 上。
      if (room.token !== token) {
        if (probe) return { ok: true, room: null, idKey, username, seat: true, role: 'controller', willCreate: true };
        return { ok: false, status: 404, code: 'TOKEN_MISMATCH', message: '房间 Token 不匹配' };
      }
      if (username && !probe) room.members.add(username);
    }

    // 联机握手成功后把 idKey → username 记下来：座位判定（isSeat）与玩家列表都要靠它。
    // probe 不写：探测一下就在网关里留下身份映射，等于给幽灵玩家发座位。
    if (!probe && room && idKey && username) this.usernames.set(idKey, username);

    if (room) {
      const seat = this.isSeat(room, idKey);
      if (!probe) this.stats.resolved += 1;
      return { ok: true, room, idKey, username, seat, role: seat ? 'controller' : 'spectator' };
    }
    // 走到这里只可能是 type=create 的 probe（上面已提前返回）：房间还不存在，参数是合法的。
    // 不改统计（probe 不代表「有人连进来了」），也不算座位判定。
    return { ok: true, room: null, idKey, username, seat: true, role: 'controller', willCreate: true };
  }

  /**
   * 座位判定：一个房间只有房主能玩，其余人都观战。
   * 「房主」的判据是 room.ownerId（建房间时的 idKey），不是「第一个连上的」——
   * 否则谁先连谁当房主，房主掉线再上来就变成观战了。
   */
  /**
   * 座位判定（v0.9）：一个房间可以有多个座位，每个座位坐一个角色。
   *
   * 判据按优先级：
   * 1) 这个 idKey 名下的用户名（this.usernames: idKey → username）在 room.seats 里有座位 → 是玩家；
   * 2) idKey 就是 ownerId（房主）→ 是玩家（房主即使还没选座位，也允许他连接进来选）；
   * 3) 其余人（已审批但没选座位 / 纯观战）→ 观战。
   *
   * 注意第 2 条：房主不选座位也进来，是为了让他能在大厅里点「开始游戏」并看到座位面板；
   * 真正的「能操作」由 MessageRouter 用 conn.seat（= 是否选好座位）兜住。
   */
  /**
   * 这个连接的身份是不是**已经在这间房里**了（v0.10）。
   *
   * 只用来给「房间已开局」那一关开一扇门：开局锁的是「新成员」，不是「已经在屋里的人重连」。
   * 判据（任一成立即是自己人）：
   *   ① username 就是房主名下那个名字 —— 房主关掉游戏窗口再开，走 join 一路也得能回来；
   *   ② members 里已经有这个 username —— 已审批的客人刷新页面 / 开第二个窗口；
   *   ③ 房间级身份表里这个 idKey 已经绑过名字（RoomManager.identityOf）—— HTTP 建/进房留下的绑定；
   *   ④ 这个 idKey 就是 ownerId。
   * 不满足这四条的一律照旧 403：真正的新人不能靠开局后的连接混进去。
   */
  alreadyInRoom(room, idKey, username) {
    if (!room) return false;
    const key = String(idKey ?? '');
    const name = String(username ?? '');
    if (key && String(room.ownerId ?? '') === key) return true;
    if (name && String(room.username ?? '') === name) return true;
    if (name && room.members?.has?.(name)) return true;
    const bound = key ? this.rooms.identityOf?.(room, key) ?? this.usernames.get(key) ?? '' : '';
    return Boolean(bound) && (!name || String(bound) === name);
  }

  isSeat(room, idKey) {
    if (!room) return false;
    const key = String(idKey ?? '');
    if (!key) return false;
    if (String(room.ownerId ?? '') === key) return true;
    // 身份表是房间级的（同一个人在不同房间可能是不同名字），先查房间再回退到全局表。
    // 漏了这一步的话，房主替客人安排好座位、客人随后连上来，握手那刻会把客人当观战
    // （HTTP 建/进房走的是 rooms.join，不经过 resolve，全局 usernames 里没有他）。
    const name = this.rooms.identityOf?.(room, key) ?? this.usernames.get(key) ?? null;
    if (!name) return false;
    return Boolean(this.rooms.seatOf(room, name));
  }

  /** 从房间视图里找某个 idKey 的座位信息（房主 = members[0] 对应的 owner）。 */
  seatOf(roomView, idKey) {
    if (!roomView || !this.isSeat({ ownerId: roomView.ownerId ?? roomView.owner }, idKey)) return { seat: false, username: null };
    return { seat: true, username: roomView.owner ?? null };
  }

  /**
   * 玩家列表（前端 NetPanel 直接渲染这个数组，字段名是约定好的，别改）。
   * online：房主那条连接在 = true；其他成员是观战，也算「在房间里」但不算玩家。
   * 注意这里是**实时**快照（每次调用重新算），不做缓存 —— 缓存就要失效逻辑，一失效列表就骗人。
   */
  playerList() {
    const out = [];
    for (const room of this.rooms.rooms.values()) {
      const view = this.rooms.view(room);
      // 原来这里是 controller.hasConnection()：那是「这台机器上有没有人控制着全局那一局」，
      // 与「这个房间的房主在不在线」无关 —— 房主本地窗口会把它带成 true，
      // 房主在别的机器上连则可能是 false。改成看本房间实测的连接。
      const online = this.isOnline(room, view.owner, true);
      out.push({
        idKey: idKeyHint(room.ownerId),
        username: view.owner,
        // v0.9：座位表是角色的唯一事实源；characters 只是「选过但还没落座」的过渡缓存
        characterId: this.rooms.seatOf(room, view.owner) ?? this.characters.get(room.ownerId) ?? null,
        online,
        role: 'owner',
        roomId: room.id,
      });
      // 其余成员：v0.9 起「坐了座位的成员」是玩家（role:'spectator' 字段名保持不变，
      // 但 characterId 与 seat 字段会填上），没选座位的仍是纯观战。
      for (const name of view.members) {
        if (name === view.owner) continue;
        const seated = this.rooms.seatOf(room, name);
        out.push({ idKey: '', username: name, characterId: seated ?? null, online: this.isOnline(room, name), role: 'spectator', seat: Boolean(seated), roomId: room.id });
      }
      // v0.8 未审批的入房申请也要出现在列表里，否则房主根本不知道有人在门口等着。
      // online:false —— 他们还没真正进来（ws 也没鉴权通过），所以不算在线、没有角色。
      // idKey 只给前 8 位提示：申请者的完整密钥不该出现在别人屏幕上。
      for (const item of room.pending ?? []) {
        out.push({ idKey: idKeyHint(item.idKey), username: item.username, characterId: null, online: false, role: 'pending', roomId: room.id });
      }
    }
    return out;
  }

  /**
   * 房主开局（POST /api/lobby/room/start）：把 started 置上并真正让主体开一局。
   *
   * 为什么走 gateway 而不是直接在路由里调 controller：
   * 1) 开局的三个前置条件（房间存在 / 是房主 / 选过角色）都要读房间表和 characters 表，
   *    这些只有 gateway 有，路由层不该再拼一遍判定（两套判定必然漂移）；
   * 2) controller.startRound 需要 characterId，而 characterId 的**唯一事实源**是 characters，
   *    从路由传进来的只能是 idKey，中间那一步转换必须在这里做；
   * 3) 开完局要广播玩家列表（started 状态变了，所有窗口都要刷新）。
   *
   * 返回 {ok:true, started, view} 或 {ok:false, status, code, message}。
   */
  startRoom(roomId, operatorIdKey) {
    const room = this.rooms.rooms.get(String(roomId ?? '')) ?? null;
    if (!room) return { ok: false, status: 404, code: 'ROOM_NOT_FOUND', message: '房间不存在或已关闭' };
    // 座位制下观战者也能有座位，所以身份判据必须是 ownerId，不能再用 isSeat。
    // 兼容：operatorIdKey 可能是 idKey（HTTP 路由）也可能是用户名（内部调用），两种都认。
    const operator = String(operatorIdKey ?? '');
    const isOwner = operator === String(room.ownerId ?? '') || (operator && operator === String(room.username ?? ''));
    if (!isOwner) {
      return { ok: false, status: 403, code: 'NOT_OWNER', message: '只有房主可以开始游戏' };
    }
    // v0.9：开局是「所有座位一起开」。座位表是角色的事实源，characters 只是过渡缓存
    // （老前端只调 setCharacter 不选座位时，靠它兜底成房主一个人玩）。
    const seats = this.rooms.seatsOf(room);
    const ownerName = String(room.username ?? '');
    const characterId = seats[ownerName] ?? this.characters.get(String(operatorIdKey ?? '')) ?? null;
    if (!characterId) return { ok: false, status: 400, code: 'NO_CHARACTER', message: '请先在房间里选好座位' };
    // 单机式开局（没有任何玩家开 ws / 没传 seats）时至少要有房主自己的座位：
    // 否则 controller 建不出任何 viewer，房间里所有人都是黑屏。
    if (!seats[ownerName]) seats[ownerName] = characterId;
    // overrides：房主设的单局参数（null = 回默认，由 GameController 自己判）
    const settings = room.settings ?? {};
    const round = { durationMs: settings.durationMs ?? null, targetScore: settings.targetScore ?? null };
    const out = this.rooms.start(room.id, operatorIdKey);
    if (!out.ok) return out;
    // 真正开局：座位制下把「谁坐哪个角色」一起交给 controller，它会为每个座位建 viewer。
    let started = false;
    const c = this.controller;
    if (c && typeof c.startRound === 'function') {
      try {
        c.startRound({ characterId, seed: null, round, seats: { ...seats } });
        started = true;
      } catch (err) {
        // 开局失败：状态位回滚，别让房间卡在「已开始但没开始」的半死状态
        room.started = false;
        return { ok: false, status: 400, code: 'START_FAILED', message: String(err && err.message ? err.message : err) };
      }
    }
    return { ok: true, started, characterId, seats: { ...seats }, settings: { ...round }, room, view: this.rooms.view(room) };
  }

  /**
   * 清除房间时要做的收尾（v0.11）：把这一间的对局停下来，别让 controller 还抱着
   * 已经在表里不存在的房间继续跑（那会出现「房间没了但游戏还在计时」的怪状态）。
   *
   * 这里刻意只调「结束这一局」，不碰别的房间、也不碰本机单机对局；
   * 异常一律吞掉——房间已经被删了，这里失败不该让房主看到 500。
   *
   * @param {string} roomId 被清除的房间号
   * @param {object|null} at 被删那一刻的 room 快照（RoomManager.close 返回的 room），
   *   用来知道「这间房绑定过哪些 idKey」，把它们的身份缓存一起丢掉。
   */
  closeRoom(roomId, at = null) {
    const id = String(roomId ?? '');
    if (!id) return false;
    // 房间都没了，这间房留下的身份缓存也要一起作废（否则同名新房间会串到旧座位）。
    // 两层都要清：
    //   ① 全局表 this.usernames（idKey → username）：握手成功后写的那种；
    //   ② 房间级表 room.ids（idKey → username，RoomManager.bindIdentity 在 create/join 时写）。
    // 只清 ① 会漏掉「从没连过 ws、只走 HTTP 建/进房」的人 —— 那正是清除房间最常见的场景。
    // at 参数：房间已经从表里删掉了，拿不到 room 对象，只能靠调用方把 ids 快照传进来。
    const idsSnapshot = at && at.ids instanceof Map ? new Map(at.ids) : null;
    const dropped = new Set(idsSnapshot ? [...idsSnapshot.keys()] : []);
    for (const [key, name] of [...this.usernames]) {
      const room = this.rooms.rooms.get(id);
      if (!room || String(room.username ?? '') === String(name) || dropped.has(String(key))) this.usernames.delete(key);
    }
    // 把这一局退回大厅：房间不存在了还停在 PLAYING 会出现「房间没了游戏还在计时」。
    const c = this.controller;
    if (c && typeof c.toLobby === 'function') {
      try {
        c.toLobby();
      } catch {
        /* controller 还没装好：忽略 */
      }
    }
    return true;
  }

  /** 记录某人的角色选择。characterId 为空 = 清掉。返回 {ok:true,characterId}。 */
  setCharacter(idKey, characterId, username = null) {
    const key = String(idKey ?? '');
    if (!key) return { ok: false, message: '缺少 idKey' };
    const id = characterId == null ? null : String(characterId);
    if (id) this.characters.set(key, id);
    else this.characters.delete(key);
    // 记住这个 idKey 对应的用户名：isSeat 要靠它去 room.seats 里查座位。
    if (username != null && String(username).trim()) this.usernames.set(key, String(username).trim());
    return { ok: true, characterId: id };
  }

  /**
   * 这个 idKey 在房间里的用户名（没登记过返回 null）。
   *
   * 两个来源，优先取房间级的：
   * 1) room.ids（RoomManager.bindIdentity 写的）：只有 token / 邀请码校验通过的
   *    create / join 才会写，是「这个人自己承认的名字」，最可信；
   * 2) this.usernames（ws 握手时记的）：给还没走过 HTTP 的老链路兜底。
   */
  usernameOf(idKey, room = null) {
    const key = String(idKey ?? '');
    if (!key) return null;
    if (room && typeof this.rooms.identityOf === 'function') {
      const bound = this.rooms.identityOf(room, key);
      if (bound) return bound;
    }
    const known = this.usernames.get(key);
    if (known) return known;
    // 兜底：房主的用户名就是房间的 owner 名，不需要额外登记
    if (room && String(room.ownerId ?? '') === key) return String(room.username ?? '') || null;
    return null;
  }

  /**
   * 座位上的人（v0.9）：把「这条连接的角色」落到房间座位表里，并记下 idKey → username。
   * 房主替别人指派走 RoomManager.claimSeat 的 owner 分支（这里只用它管自己的座位）。
   * 返回 RoomManager.claimSeat 的结果（{ok,room,seat} 或 {ok:false,status,code,message}）。
   */
  claimSeat(roomId, idKey, username, characterId) {
    const room = this.rooms.rooms.get(String(roomId ?? '')) ?? null;
    if (!room) return { ok: false, status: 404, code: 'ROOM_NOT_FOUND', message: '房间不存在或已关闭' };
    const name = String(username ?? '').trim() || this.usernameOf(idKey, room);
    if (!name) return { ok: false, status: 400, code: 'BAD_REQUEST', message: '缺少 username —— 服务端认不出这条连接的玩家名（HTTP 侧要用本人 ID 密钥选座）' };
    // selfName = 「这个 idKey 自己的用户名」。RoomManager.claimSeat 看不到 idKey→username 的对应关系，
    // 只能拿它来证明「不是房主的人动的确实是自己那一行」。这里解析不到（没登记过）就传 null，
    // 结果是非房主的调用一律 FORBIDDEN —— 宁可严一点，也不能让别人抢座位。
    const selfName = this.usernameOf(idKey, room);
    const out = this.rooms.claimSeat(room.id, idKey, name, characterId, selfName);
    if (out.ok && characterId) this.setCharacter(idKey, characterId, name);
    return { ...out, username: name };
  }

  clearCharacter(idKey) {
    return this.characters.delete(String(idKey ?? ''));
  }

  /**
   * 房间成员/座位变化后广播玩家列表。
   * broadcast 由 server/index.js 注入（形如 (players) => ws.broadcastPlayers()）；
   * 失败不抛：广播是锦上添花，不能因此让 HTTP 请求 500。
   */
  broadcast(players = this.playerList()) {
    if (typeof this.onBroadcast !== 'function') return players;
    try {
      this.onBroadcast(players);
    } catch (err) {
      this.log.warn?.('[lobby] 玩家列表广播失败：' + String(err && err.message ? err.message : err));
    }
    return players;
  }
}
