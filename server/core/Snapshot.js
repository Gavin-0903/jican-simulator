// 快照与增量：把权威状态投影成「玩家视角」的只读视图，并与上一帧视图做字段级差分。
// · 只下发变化字段（位置保留 1 位小数、朝向 2 位）
// · 学生积分不在公共视图里（§1.6 Q9），玩家自己的私有数据放在 me 中
// · 事件按可见范围过滤：actor/target 本人、或玩家视线能看到事件坐标（witness）
// · 维护最近 N 个包的历史，断线重连时按 lastSeq 补发

import { AUDIENCE, ROLE, STATUS } from '../../shared/constants.js';
import { dist, sightClear, round1, round2 } from '../../shared/math.js';
import { getChar } from './GameState.js';
import { evalCost as priceOf } from '../systems/ItemSystem.js';

const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;
const same = (a, b) => a === b || (typeof a === 'object' && a !== null && b !== null && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

function diffObject(prev, next) {
  const out = {};
  let changed = false;
  for (const k of Object.keys(next)) {
    if (!prev || !same(prev[k], next[k])) {
      out[k] = next[k];
      changed = true;
    }
  }
  return changed ? out : null;
}

export class Snapshot {
  constructor({ map, balance, stepMs, historySize = 50 }) {
    this.map = map;
    this.balance = balance;
    this.stepMs = stepMs;
    this.historySize = historySize;
    this.seq = 0;
    this.prev = null;
    this.history = [];
  }

  setBalance(balance) {
    this.balance = balance;
  }

  reset() {
    this.prev = null;
    this.history = [];
  }

  roster(state) {
    return state.characters.map((c) => ({
      id: c.id, name: c.name, username: c.username, title: c.title, role: c.role, classId: c.classId, homePcId: c.homePcId,
    }));
  }

  charView(c, state) {
    return {
      id: c.id,
      x: round1(c.pos.x),
      y: round1(c.pos.y),
      f: round2(c.facing),
      st: c.status,
      ctl: c.control,
      op: c.opLock?.kind ?? null,
      pc: c.operatingPcId,
      sp: c.speech && c.speechUntil > state.tick ? c.speech : null,
      tl: round1(c.toiletLevel),
      ch: r3((c.attrMul.speed - 1) * 100),
      // fz：剩余定格毫秒（客户端据此显示冻结遮罩与倒计时）；只下发给能看见这个角色的人也无妨，
      // 定格是全员可见的公开效果，不需要做可见性裁剪。
      fz: Math.max(0, Math.round(((c.frozenUntil - state.tick) * this.stepMs) / 100) * 100),
    };
  }

  meView(c, state) {
    const left = (until) => Math.max(0, Math.round(((until - state.tick) * this.stepMs) / 100) * 100);
    return {
      id: c.id,
      role: c.role,
      status: c.status,
      salary: c.role === ROLE.TEACHER ? c.score : null,
      lastViewedScore: c.lastViewedScore,
      lastViewedTick: c.lastViewedTick,
      knownDelta: c.knownDelta,
      cooldowns: {
        ask: left(c.cooldowns.ask),
        flatter: left(c.cooldowns.flatter),
        jc: left(c.cooldowns.jc),
        inspect: left(c.cooldowns.inspect),
        pcReenter: left(c.cooldowns.pcReenter),
      },
      askCount: c.askCount,
      askLimit: this.balance.ask.limit,
      asking: c.asking ? { teacherId: c.asking.teacherId, ms: Math.round(c.asking.ms / 100) * 100 } : null,
      toiletMs: c.dwell.toiletMs,
      toiletLevel: round2(c.toiletLevel),
      speedMul: r3(c.speedMul * c.attrMul.speed),
      attrMul: { speed: r4(c.attrMul.speed), vision: r4(c.attrMul.vision), interact: r4(c.attrMul.interact), scoreGain: r4(c.attrMul.scoreGain) },
      operatingPcId: c.operatingPcId,
      jcOpenPcId: c.jcOpenPcId,
      stats: { ...c.stats },
      // 道具：深拷贝，避免视图与权威状态共享引用
      items: Object.fromEntries(Object.entries(c.items).map(([id, s]) => [id, { lv: s.lv, uses: s.uses }])),
      itemRoundCount: { ...c.itemRoundCount },
      itemStats: { ...c.itemStats },
      itemPrices: this.itemPrices(c),
      frozenMs: left(c.frozenUntil),
      // 本人在别人电脑上触发过的强密码解锁倒计时：取最长剩余，客户端表单据此锁定
      unlockRemainMs: Math.max(0, ...Object.values(c.unlock ?? {}).map((u) => (u ? left(u.until) : 0)), 0),
    };
  }

  /** 当前等级下各道具的买入 / 升级 / 补弹价格（让客户端不必重复实现定价公式）。 */
  itemPrices(c) {
    const items = this.balance.items ?? {};
    const out = {};
    for (const [id, cfg] of Object.entries(items)) {
      const lv = c.items?.[id]?.lv ?? 0;
      out[id] = {
        price: cfg.price ?? 0,
        upLevel: lv > 0 && lv < cfg.maxLevel ? priceOf(cfg.upLevelPrice, lv) : null,
        perUse: cfg.perUsePrice ? priceOf(cfg.perUsePrice, Math.max(1, lv)) : null,
      };
    }
    return out;
  }

  build(state, viewerId, llm) {
    const viewer = getChar(state, viewerId);
    const chars = {};
    for (const c of state.characters) chars[c.id] = this.charView(c, state);
    const pcs = {};
    for (const p of state.pcs) pcs[p.id] = { id: p.id, op: p.operatorId };
    return {
      game: {
        phase: state.phase,
        pausedReason: state.pausedReason,
        tick: state.tick,
        elapsedMs: Math.round(state.elapsedMs),
        roundMs: state.roundMs,
        targetScore: state.targetScore,
        speedMult: state.speedMult,
        // 多座位（v0.9）：每人看到的是「他自己那个角色」，不是房主的主玩家。
        // 前端用它拿成绩/名次，串台就是把别人的分当自己的。
        playerCharId: viewer ? viewer.id : state.playerCharId,
        seed: state.seed,
        llm: llm ? { mode: llm.mode, reason: llm.reason } : null,
      },
      chars,
      pcs,
      me: viewer ? this.meView(viewer, state) : null,
    };
  }

  filterEvents(state, viewerId, events) {
    const viewer = getChar(state, viewerId);
    const R = viewer ? this.balance.vision.viewRadius * viewer.attrMul.vision : 0;
    const out = [];
    for (const { audience = [AUDIENCE.ALL], ...e } of events) {
      let ok = !viewer || audience.includes(AUDIENCE.ALL);
      if (!ok && audience.includes(AUDIENCE.ACTOR) && e.actorId === viewerId) ok = true;
      if (!ok && audience.includes(AUDIENCE.TARGET) && e.targetId === viewerId) ok = true;
      if (!ok && audience.includes(AUDIENCE.WITNESS) && e.pos && viewer.status === STATUS.ACTIVE &&
          dist(viewer.pos, e.pos) <= R && sightClear(viewer.pos, e.pos, this.map.occ, e.pcId ?? null)) ok = true;
      if (ok) out.push(e);
    }
    return out;
  }

  remember(type, payload) {
    this.history.push({ type, payload });
    if (this.history.length > this.historySize) this.history.shift();
  }

  /**
   * 观战视图：公共投影（me=null，playerCharId 保留主玩家）。
   *
   * 为什么观战者也需要自己的 Snapshot 实例：增量包是「与上一帧视图的差分」，
   * 观战者收到的那份公共视图必须自己算差分，否则要么收不到 delta（没实例），
   * 要么拿玩家的 prev 去差分（串台）。
   */
  publicView(state, llm = null) {
    const view = this.build(state, null, llm);
    view.game.playerCharId = state.playerCharId;
    return view;
  }

  full(state, viewerId, events = [], llm = null) {
    const view = this.build(state, viewerId, llm);
    this.prev = view;
    const payload = {
      tick: state.tick,
      seq: ++this.seq,
      state: { game: view.game, chars: Object.values(view.chars), pcs: Object.values(view.pcs), me: view.me, roster: this.roster(state) },
      events: this.filterEvents(state, viewerId, events),
    };
    this.remember('snapshot', payload);
    return payload;
  }

  /** 观战者的增量包：公共视图（me 恒 null），差分口径与 fullPublic 一致。 */
  deltaPublic(state, events = [], llm = null) {
    if (!this.prev) return null;
    const view = this.publicView(state, llm);
    const evs = this.filterEvents(state, null, events);
    const payload = this.diffView(state, view, evs);
    this.prev = view;
    if (Object.keys(payload).length <= 2) return null;
    payload.seq = ++this.seq;
    this.remember('delta', payload);
    return payload;
  }

  /** 观战者的全量包：公共视图 + 事件过滤（无 viewer = 只看 AUDIENCE.ALL）。 */
  fullPublic(state, events = [], llm = null) {
    const view = this.publicView(state, llm);
    this.prev = view;
    const payload = {
      tick: state.tick,
      seq: ++this.seq,
      state: { game: view.game, chars: Object.values(view.chars), pcs: Object.values(view.pcs), me: view.me, roster: this.roster(state) },
      events: this.filterEvents(state, null, events),
    };
    this.remember('snapshot', payload);
    return payload;
  }

  /** 两个视图之间的字段级差分（player/delta 与 public 共用同一套口径）。 */
  diffView(state, view, evs) {
    const payload = { tick: state.tick, seq: 0 };
    const game = diffObject(this.prev.game, view.game);
    if (game) payload.game = game;
    const chars = [];
    for (const id of Object.keys(view.chars)) {
      const d = diffObject(this.prev.chars[id], view.chars[id]);
      if (d) chars.push({ id, ...d });
    }
    if (chars.length) payload.chars = chars;
    const pcs = [];
    for (const id of Object.keys(view.pcs)) {
      const d = diffObject(this.prev.pcs[id], view.pcs[id]);
      if (d) pcs.push({ id, ...d });
    }
    if (pcs.length) payload.pcs = pcs;
    if (view.me) {
      const me = diffObject(this.prev.me, view.me);
      if (me) payload.me = me;
    }
    if (evs.length) payload.events = evs;
    return payload;
  }

  delta(state, viewerId, events = [], llm = null) {
    if (!this.prev) return null;
    const view = this.build(state, viewerId, llm);
    const payload = { tick: state.tick, seq: 0 };
    const game = diffObject(this.prev.game, view.game);
    if (game) payload.game = game;
    const chars = [];
    for (const id of Object.keys(view.chars)) {
      const d = diffObject(this.prev.chars[id], view.chars[id]);
      if (d) chars.push({ id, ...d });
    }
    if (chars.length) payload.chars = chars;
    const pcs = [];
    for (const id of Object.keys(view.pcs)) {
      const d = diffObject(this.prev.pcs[id], view.pcs[id]);
      if (d) pcs.push({ id, ...d });
    }
    if (pcs.length) payload.pcs = pcs;
    if (view.me) {
      const me = diffObject(this.prev.me, view.me);
      if (me) payload.me = me;
    }
    const evs = this.filterEvents(state, viewerId, events);
    if (evs.length) payload.events = evs;
    this.prev = view;
    if (Object.keys(payload).length <= 2) return null;
    payload.seq = ++this.seq;
    this.remember('delta', payload);
    return payload;
  }

  /** 断线重连：返回 lastSeq 之后的所有包；历史已不连续则返回 null（需要全量）。 */
  since(lastSeq) {
    if (!this.history.length) return null;
    const first = this.history[0].payload.seq;
    if (lastSeq < first - 1 || lastSeq > this.seq) return null;
    return this.history.filter((p) => p.payload.seq > lastSeq);
  }
}
