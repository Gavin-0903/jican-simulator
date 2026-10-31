// 权威状态容器与实体工厂。GameState 是纯 JSON 对象（无 Map/Set/类实例），
// 因此可以直接序列化做存档、断线恢复与确定性回放比对。

import { PHASE, ROLE, CONTROL, STATUS } from '../../shared/constants.js';
import { childCell, createCell } from './Rng.js';

export const SCHEMA_VERSION = 1;

const SURNAMES = ['林', '陈', '周', '许', '沈', '顾', '叶', '苏', '韩', '唐', '江', '何', '宋', '程', '白', '方', '贺', '陆', '姜', '温'];
const GIVEN = [
  '子涵', '一诺', '浩然', '欣怡', '宇轩', '梓萱', '俊杰', '雨桐', '思远', '佳琪',
  '博文', '诗涵', '天佑', '可馨', '明哲', '若溪', '晨阳', '语嫣', '嘉树', '星辰',
  '沐阳', '安然', '皓轩', '芷若', '景行', '清禾', '书瑶', '泽宇', '乐言', '知秋',
];
const TEACHER_SURNAMES = ['王', '李', '张', '刘', '赵', '孙', '马', '黄'];

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 根据配置生成角色名单（与随机种子无关，大厅可提前展示）。
 * 学生 id 即用户名：s{班}-{序号}；老师：t{序号}。
 */
export function buildRoster(roster) {
  const list = [];
  let n = 0;
  for (let k = 1; k <= roster.classes; k++) {
    for (let i = 1; i <= roster.studentsPerClass; i++, n++) {
      const id = `s${k}-${pad2(i)}`;
      const base = SURNAMES[(n * 7) % SURNAMES.length] + GIVEN[n % GIVEN.length];
      const name = n < GIVEN.length ? base : `${base}${Math.floor(n / GIVEN.length) + 1}`;
      list.push({ id, username: id, name, role: ROLE.STUDENT, classId: k, title: `${k} 班学生` });
    }
  }
  const totalTeachers = roster.subjectTeachers + roster.residentTeachers;
  for (let t = 1; t <= totalTeachers; t++) {
    const subject = t <= roster.subjectTeachers;
    const classId = subject && t <= roster.classes ? t : null;
    list.push({
      id: `t${t}`,
      username: `t${t}`,
      name: `${TEACHER_SURNAMES[(t - 1) % TEACHER_SURNAMES.length]}老师`,
      role: ROLE.TEACHER,
      classId,
      title: classId ? `${classId} 班任课老师` : '办公室常驻老师',
    });
  }
  return list;
}

/** 把名单里的角色与地图里的归属电脑配对。 */
export function assignPcs(rosterList, mapPcs) {
  const free = [...mapPcs];
  const result = new Map();
  for (const entry of rosterList) {
    const idx = free.findIndex((pc) =>
      entry.role === ROLE.STUDENT
        ? pc.owner.role === ROLE.STUDENT && pc.owner.classId === entry.classId && `s${entry.classId}-${pad2(pc.owner.index)}` === entry.id
        : pc.owner.role === ROLE.TEACHER && pc.owner.slot === entry.id,
    );
    if (idx < 0) throw new Error(`地图中没有为角色 ${entry.id} 准备归属电脑`);
    result.set(entry.id, free.splice(idx, 1)[0]);
  }
  return result;
}

export function msToTicks(ms, stepMs) {
  return Math.ceil(ms / stepMs);
}

function createCharacter(entry, pc, spawn, balance, seed) {
  const student = entry.role === ROLE.STUDENT;
  return {
    id: entry.id,
    name: entry.name,
    username: entry.username,
    title: entry.title,
    role: entry.role,
    classId: entry.classId,
    homePcId: pc.id,
    control: CONTROL.AI,
    pos: { x: spawn.x, y: spawn.y },
    vel: { x: 0, y: 0 },
    facing: student ? -Math.PI / 2 : Math.PI / 2,
    baseSpeed: balance.move.baseSpeed,
    speedMul: 1,
    attrMul: { speed: 1, vision: 1, interact: 1, scoreGain: 1 },
    buffs: [],
    toiletLevel: 0,
    score: student ? balance.student.initialScore : balance.teacher.initialSalary,
    status: STATUS.ACTIVE,
    dwell: { toiletMs: 0 },
    opLock: null,
    operatingPcId: null,
    jcOpenPcId: null,
    asking: null,
    cooldowns: { ask: 0, flatter: 0, jc: 0, inspect: 0, pcReenter: 0 },
    askCount: 0,
    inputDir: { x: 0, y: 0 },
    faceTarget: null,
    pendingActions: [],
    lastViewedScore: null,
    lastViewedTick: null,
    knownDelta: 0,
    lastPcView: null,
    lastResult: null,
    favor: student ? null : {},
    stats: { jcSuccess: 0, jcGained: 0, jcVictim: 0, jcLost: 0, caught: 0, catches: 0, asks: 0, flatterOk: 0, flatterFail: 0, buffs: 0, inspects: 0 },
    // 道具（v0.2）：等级与剩余次数；frozenUntil 是「定格到此 tick 为止」的绝对时刻。
    items: { freeze: { lv: 0, uses: 0 }, buyoff: { lv: 0, uses: 0 }, password: { lv: 0, uses: 0 }, hourglass: { lv: 0, uses: 0 }, hackbook: { lv: 0, uses: 0 } },
    itemRoundCount: {},
    itemBuyoffSeen: 0,
    itemStats: { bought: 0, upgraded: 0, used: 0, goldSpent: 0, hackSuccess: 0, hackFail: 0, frozenTimes: 0 },
    frozenUntil: 0,
    unlock: {},
    unlockOnce: {},
    ai: null,
    speech: null,
    speechUntil: 0,
    speechKey: 0,
    rng: childCell(seed, entry.id),
  };
}

/**
 * 创建一局新的权威状态。
 * @param {{app:object, balance:object, map:import('../world/GameMap.js').GameMap, seed:number, configHash?:string}} opts
 */
export function createGameState({ app, balance, map, seed, configHash = '' }) {
  const roster = buildRoster(app.roster);
  const pcByChar = assignPcs(roster, map.pcs);
  const posts = map.anchors.teacherPosts || {};
  const characters = roster.map((entry) => {
    const pc = pcByChar.get(entry.id);
    const spawn = entry.role === ROLE.TEACHER && posts[entry.id] ? posts[entry.id] : pc.seat;
    return createCharacter(entry, pc, spawn, balance, seed);
  });
  const ownerByPc = new Map([...pcByChar.entries()].map(([charId, pc]) => [pc.id, charId]));
  const pcs = map.pcs.map((pc) => ({
    id: pc.id,
    roomId: pc.roomId,
    ownerCharId: ownerByPc.get(pc.id) ?? null,
    ownerRole: pc.owner.role,
    pos: { x: pc.seat.x, y: pc.seat.y },
    operatorId: null,
    lockUntil: 0,
    sessionStartTick: 0,
    lastActionTick: 0,
  }));
  const rooms = map.rooms.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    rect: r.rect,
    classId: r.classId ?? null,
    pcIds: pcs.filter((p) => p.roomId === r.id).map((p) => p.id),
    buffZone: r.buffZone ?? null,
    noJc: !!r.noJc,
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    configHash,
    phase: PHASE.LOBBY,
    pausedReason: null,
    tick: 0,
    elapsedMs: 0,
    roundMs: app.round.durationMs,
    targetScore: app.round.targetScore || 0,
    mapId: map.id,
    seed,
    speedMult: 1,
    rooms,
    pcs,
    characters,
    playerCharId: null,
    inputQueue: [],
    recentJc: [],
    ranking: null,
    result: null,
    stats: { jc: 0, jcAmount: 0, catches: 0, asks: 0, flatters: 0, eliminations: 0, buffs: 0 },
    rng: createCell(seed ^ 0x9e3779b9),
  };
}

// ------------------------------------------------------------ 索引查询（缓存随数组实例失效）

const charIndex = new WeakMap();
const pcIndex = new WeakMap();

export function getChar(state, id) {
  if (!id) return null;
  let m = charIndex.get(state.characters);
  if (!m) {
    m = new Map(state.characters.map((c) => [c.id, c]));
    charIndex.set(state.characters, m);
  }
  return m.get(id) ?? null;
}

export function getPc(state, id) {
  if (!id) return null;
  let m = pcIndex.get(state.pcs);
  if (!m) {
    m = new Map(state.pcs.map((p) => [p.id, p]));
    pcIndex.set(state.pcs, m);
  }
  return m.get(id) ?? null;
}

export const isActive = (c) => c && c.status === STATUS.ACTIVE;
export const isStudent = (c) => c && c.role === ROLE.STUDENT;
export const isTeacher = (c) => c && c.role === ROLE.TEACHER;

/** 学生对自己积分的「认知值」：上次查看值 + 之后自己知道的变化（被 JC 的损失不在其中）。 */
export function believedScore(c, initial = 0) {
  return (c.lastViewedScore ?? initial) + c.knownDelta;
}

/** 让角色离开正在操作的电脑。 */
export function releasePc(state, c) {
  if (!c.operatingPcId) return null;
  const pc = getPc(state, c.operatingPcId);
  if (pc && pc.operatorId === c.id) pc.operatorId = null;
  const pcId = c.operatingPcId;
  c.operatingPcId = null;
  c.jcOpenPcId = null;
  if (c.opLock?.kind === 'operate') c.opLock = null;
  return pcId;
}
