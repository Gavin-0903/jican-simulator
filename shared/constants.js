// 前后端共享的协议常量与枚举。浏览器通过 /shared/constants.js 直接 import。

export const PROTOCOL_VERSION = 1;
export const CLIENT_VERSION = '0.2.0';

/** 消息类型白名单（C→S 与 S→C 共用一个命名空间）。 */
export const MSG = Object.freeze({
  // C → S
  HELLO: 'hello',
  JOIN: 'join',
  LEAVE: 'leave',
  LOBBY: 'lobby',
  MOVE: 'input.move',
  ACTION: 'input.action',
  JC_COMMIT: 'jc.commit',
  SET_SPEED: 'set.speed',
  PAUSE: 'pause',
  PING: 'ping',
  RESYNC: 'resync',
  ITEM_BUY: 'item.buy',
  ITEM_UPGRADE: 'item.upgrade',
  ITEM_USE: 'item.use',
  ITEM_LIST: 'item.list',
  // S → C
  WELCOME: 'welcome',
  PHASE: 'phase',
  SNAPSHOT: 'snapshot',
  DELTA: 'delta',
  EVENT: 'event',
  DIALOG: 'dialog',
  ERROR: 'error',
  GAMEOVER: 'gameover',
  // 房主退出/结算时房间已被直接删除：客户端据此收起「再来一局」（房间都没了，重开一定失败）。
  ROOM_CLOSED: 'room.closed',
  PONG: 'pong',
});

export const PHASE = Object.freeze({ LOBBY: 'LOBBY', PLAYING: 'PLAYING', PAUSED: 'PAUSED', ENDED: 'ENDED' });

export const ROLE = Object.freeze({ STUDENT: 'student', TEACHER: 'teacher' });

export const CONTROL = Object.freeze({ HUMAN: 'human', AI: 'ai' });

export const STATUS = Object.freeze({ ACTIVE: 'active', ELIMINATED: 'eliminated', FAILED: 'failed' });

export const ROOM_TYPE = Object.freeze({
  CLASSROOM: 'classroom',
  TOILET: 'toilet',
  CHATROOM: 'chatroom',
  OFFICE: 'office',
  CORRIDOR: 'corridor',
});

/** input.action 的 kind 白名单。 */
export const ACTION = Object.freeze({
  ENTER_PC: 'enterPc',
  LEAVE_PC: 'leavePc',
  ASK: 'askQuestion',
  CANCEL_ASK: 'cancelAsk',
  FLATTER: 'flatter',
  VIEW_SCORE: 'viewScore',
  JC_OPEN: 'jc.open',
  INSPECT_PC: 'inspectPc',
  // 道具（v0.2）：购买 / 升级 / 使用，均由服务端 ItemSystem 权威判定
  BUY_ITEM: 'buyItem',
  UPGRADE_ITEM: 'upgradeItem',
  USE_ITEM: 'useItem',
});

/** 道具 id 白名单（与 config/balance.json 的 items 键一一对应）。 */
export const ITEM_ID = Object.freeze({
  FREEZE: 'freeze',
  BUYOFF: 'buyoff',
  PASSWORD: 'password',
  HOURGLASS: 'hourglass',
  HACKBOOK: 'hackbook',
});

export const EVENT = Object.freeze({
  JC_SUCCESS: 'jc_success',
  JC_BLOCKED: 'jc_blocked',
  JC_VICTIM: 'jc_victim',
  TEACHER_CATCH: 'teacher_catch',
  SCORE_CHANGED: 'score_changed',
  SALARY_CHANGED: 'salary_changed',
  ELIMINATED: 'eliminated',
  FAILED: 'failed',
  BUFF_GAINED: 'buff_gained',
  ASK_STARTED: 'ask_started',
  ASK_CANCELLED: 'ask_cancelled',
  INSPECT_CLEAR: 'inspect_clear',
  PC_KICKED: 'pc_kicked',
  DIALOGUE: 'dialogue',
  ROUND_START: 'round_start',
  ROUND_END: 'round_end',
  // 道具（v0.2）
  ITEM_BOUGHT: 'item_bought',
  ITEM_UPGRADED: 'item_upgraded',
  ITEM_USED: 'item_used',
  ITEM_FAILED: 'item_failed',
  FROZEN: 'frozen',
  HACK_RESULT: 'hack_result',
});

/** 事件可见范围：服务端按玩家视角过滤后再下发。 */
export const AUDIENCE = Object.freeze({
  ALL: 'all',
  ACTOR: 'actor',
  TARGET: 'target',
  WITNESS: 'witness', // 玩家视线可见事件坐标时才下发
});

export const ERR = Object.freeze({
  PROTO: 'E_PROTO',
  BADMSG: 'E_BADMSG',
  NOTJOINED: 'E_NOTJOINED',
  OUTOFRANGE: 'E_OUTOFRANGE',
  IMMUNE: 'E_IMMUNE',
  BUSY: 'E_BUSY',
  USERNAME: 'E_USERNAME',
  AMOUNT: 'E_AMOUNT',
  COOLDOWN: 'E_COOLDOWN',
  ELIMINATED: 'E_ELIMINATED',
  FORBIDDEN: 'E_FORBIDDEN',
  STATE: 'E_STATE',
  RATE: 'E_RATE',
  SPECTATOR: 'E_SPECTATOR',
  ITEM: 'E_ITEM',
  FROZEN: 'E_FROZEN',
});

export const JC_BLOCK = Object.freeze({
  USERNAME_MISMATCH: 'username_mismatch',
  INVALID_AMOUNT: 'invalid_amount',
  EXCEED_TARGET: 'exceed_target',
  TARGET_IMMUNE: 'target_immune',
  OUT_OF_RANGE: 'out_of_range',
  COOLDOWN: 'cooldown',
  NOT_AT_PC: 'not_at_pc',
});

export const JC_BLOCK_TEXT = Object.freeze({
  username_mismatch: '用户名不匹配',
  invalid_amount: '数量必须是正整数',
  exceed_target: '数量超过了对方当前积分',
  target_immune: '对方正在操作自己的电脑，处于免疫状态',
  out_of_range: '离电脑太远',
  cooldown: 'JC 冷却中',
  not_at_pc: '你没有在操作对方的电脑',
});

export const END_REASON = Object.freeze({
  TIME_UP: 'time_up',
  TARGET_REACHED: 'target_reached',
  PLAYER_ELIMINATED: 'player_eliminated',
  PLAYER_FAILED: 'player_failed',
  QUIT: 'quit',
});

export const END_REASON_TEXT = Object.freeze({
  time_up: '回合时间到',
  target_reached: '有学生率先达到目标积分',
  player_eliminated: '你的积分跌破淘汰线，被淘汰',
  player_failed: '你的工资跌破 0，任教失败',
  quit: '你提前结束了本局',
});

export const SPEEDS = Object.freeze([0.5, 1, 2]);

/** 结算后留给玩家查看排名/复制成绩的时间；到点自动离开房间（房主离开会删房）。 */
export const GAMEOVER_LEAVE_MS = 120000;