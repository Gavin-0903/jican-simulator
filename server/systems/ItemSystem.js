// 道具系统：商店购买 / 升级 / 使用五件道具（定格手枪、买通老师、强密码、时间沙漏、黑客手册）。
// 全部判定集中在本文件——购买扣钱、升级涨价、使用消耗与随机结果都只在这里发生一次，
// 避免 InteractionSystem 等处重复扣费；其它系统只读取道具状态（frozenUntil / items.buyoff / items.password）生效。
//
// pendingActions 的 kind 由 MessageRouter 入队的 type 原样带过来：'item.buy' / 'item.upgrade' / 'item.use'
// （不是 ACTION 枚举值，见契约 §3 与 Lead 补充说明）。同时兼容 ACTION.* 与 MSG.* 形式，客户端用哪种都能被同一路径处理。

import { ACTION, AUDIENCE, CONTROL, END_REASON, ERR, EVENT, ITEM_ID, MSG, STATUS } from '../../shared/constants.js';
import { clamp } from '../../shared/math.js';
import { getChar, isActive, isStudent } from '../core/GameState.js';

const KINDS = {
  [ACTION.BUY_ITEM]: 'buy',
  [ACTION.UPGRADE_ITEM]: 'upgrade',
  [ACTION.USE_ITEM]: 'use',
  'item.buy': 'buy',
  'item.upgrade': 'upgrade',
  'item.use': 'use',
  [MSG.ITEM_BUY]: 'buy',
  [MSG.ITEM_UPGRADE]: 'upgrade',
  [MSG.ITEM_USE]: 'use',
};

const ITEM_IDS = Object.values(ITEM_ID);

/** 定时类道具（重复购买只累加时长/次数）；其余是「一次一个」的持有型道具。 */
const TIMED = new Set([ITEM_ID.FREEZE, ITEM_ID.HOURGLASS]);

/** 依赖视野的运气型道具：老师被定格时不生效（否则可以「先定格老师再买通」白嫖）。 */
const VISION_DEPENDENT = new Set([ITEM_ID.BUYOFF, ITEM_ID.HACKBOOK]);

export const ITEM_LABEL = Object.freeze({
  [ITEM_ID.FREEZE]: '定格手枪',
  [ITEM_ID.BUYOFF]: '买通老师',
  [ITEM_ID.PASSWORD]: '强密码',
  [ITEM_ID.HOURGLASS]: '时间沙漏',
  [ITEM_ID.HACKBOOK]: '黑客手册',
});

/**
 * "{Lv} * 50" 这类简单模板求值：只允许数字、Lv、空白与 + - * / ( ) { }。
 * 不引入依赖也不 eval——配置来自可热重载的 JSON，eval 会把配置变成可执行代码。
 */
export function evalCost(expr, lv) {
  if (typeof expr === 'number') return Math.max(0, Math.round(expr));
  if (typeof expr !== 'string') return 0;
  // 配置里写作 "{Lv} * 50"（花括号是给文档看的占位符），求值前先去掉
  let s = expr.replace(/[{}]/g, '').trim();
  // 隐式乘法归一：'50 Lv' / '5(' / ')Lv' → 显式 '*'
  s = s.replace(/(\d)\s*(?=[A-Za-z(])/g, '$1*').replace(/\)\s*(?=[\dA-Za-z(])/g, ')*');
  const tokens = s.match(/\d+(?:\.\d+)?|Lv|[+\-*/()]/g) ?? [];
  if (!tokens.length) return 0;
  let i = 0;
  const unary = () => {
    const t = tokens[i++];
    if (t === '-') return -unary();
    if (t === '(') {
      const v = sum();
      if (tokens[i] === ')') i++;
      return v;
    }
    if (t === 'Lv') return lv;
    return Number(t) || 0;
  };
  const product = () => {
    let v = unary();
    while (tokens[i] === '*' || tokens[i] === '/') {
      const op = tokens[i++];
      const r = unary();
      v = op === '*' ? v * r : r === 0 ? 0 : v / r;
    }
    return v;
  };
  const sum = () => {
    let v = product();
    while (tokens[i] === '+' || tokens[i] === '-') {
      const op = tokens[i++];
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

export class ItemSystem {
  update(state, ctx) {
    // 1) 先清理到期解锁计时：不可见的辅助状态，及时删除让快照与存档更干净
    for (const c of state.characters) {
      for (const [victimId, u] of Object.entries(c.unlock ?? {})) {
        if (!u || u.until <= state.tick) {
          delete c.unlock[victimId];
          // 破完了：留一张「一次性放行券」，下一次 JC 不会再被强密码拦（见 InteractionSystem.passwordGate）
          if (u && u.until <= state.tick) c.unlockOnce = { ...(c.unlockOnce ?? {}), [victimId]: true };
        }
      }
    }
    // 2) 消费道具指令（非道具指令原样放回，交给 InteractionSystem）
    for (const c of state.characters) {
      if (!c.pendingActions.length) continue;
      const actions = c.pendingActions;
      c.pendingActions = [];
      for (const a of actions) {
        const op = KINDS[a.kind];
        if (!op) {
          c.pendingActions.push(a);
          continue;
        }
        if (c.status !== STATUS.ACTIVE) {
          ctx.fail(c, a.kind, ERR.ELIMINATED, '你已退出本局', a);
          continue;
        }
        if (ctx.frozen(c)) {
          ctx.fail(c, a.kind, ERR.FROZEN, '你被定格了', a);
          continue;
        }
        if (op === 'buy') this.buy(state, ctx, c, a);
        else if (op === 'upgrade') this.upgrade(state, ctx, c, a);
        else this.use(state, ctx, c, a);
      }
    }
  }

  // ------------------------------------------------------------ 工具

  cfgOf(ctx, itemId) {
    return ctx.balance.items?.[itemId] ?? null;
  }

  label(itemId) {
    return ITEM_LABEL[itemId] ?? itemId;
  }

  /** 时间沙漏每局可用次数：契约规定 ceil(Lv/2)，配置里没有该键，这里现算。 */
  hourglassMaxPerRound(lv) {
    return Math.max(1, Math.ceil(lv / 2));
  }

  lockMs(cfg, lv) {
    return Math.max(0, cfg.lockMsPerLevel * lv);
  }

  hackFailPct(cfg, lv) {
    return clamp(cfg.failPctBase - cfg.failPctPerLevel * lv, 0, 100);
  }

  hackExpelPct(cfg, lv) {
    return clamp(cfg.expelPctBase - cfg.expelPctPerLevel * lv, 0, 100);
  }

  teacherFrozen(state) {
    return state.characters.some((t) => !isStudent(t) && isActive(t) && t.frozenUntil > state.tick);
  }

  /** 扣一次使用次数；不足则失败。 */
  spend(ctx, c, a, itemId, slot) {
    if (slot.uses <= 0) {
      ctx.fail(c, ACTION.USE_ITEM, ERR.ITEM, '使用次数用完了', a, { itemId, reason: 'uses' });
      return false;
    }
    slot.uses -= 1;
    c.itemStats.used += 1;
    c.itemRoundCount[itemId] = (c.itemRoundCount[itemId] ?? 0) + 1;
    return true;
  }

  // ------------------------------------------------------------ 购买

  buy(state, ctx, c, a) {
    const itemId = a.itemId;
    const cfg = this.cfgOf(ctx, itemId);
    const slot = c.items?.[itemId];
    if (!cfg || !ITEM_IDS.includes(itemId) || !slot) return ctx.fail(c, ACTION.BUY_ITEM, ERR.ITEM, '没有这件道具', a, { itemId });
    const amount = Math.min(1000, Math.max(1, Math.floor(Number(a.amount) || 1)));

    // 定格手枪支持「按份补使用次数」：perUsePrice * amount，每份给 Lv 次
    if (a.buyType === 'uses') {
      if (itemId !== ITEM_ID.FREEZE) return ctx.fail(c, ACTION.BUY_ITEM, ERR.ITEM, '这件道具不能购买使用次数', a, { itemId, reason: 'buyType' });
      if (slot.lv <= 0) return ctx.fail(c, ACTION.BUY_ITEM, ERR.ITEM, '先购买道具，再补充使用次数', a, { itemId, reason: 'buyType' });
      const price = evalCost(cfg.perUsePrice, slot.lv) * amount;
      if (price > c.score) return ctx.fail(c, ACTION.BUY_ITEM, ERR.ITEM, `金币不足（需要 ${price}，你有 ${c.score}）`, a, { itemId, price, gold: c.score, reason: 'gold' });
      c.score -= price;
      c.itemStats.goldSpent += price;
      slot.uses += amount * slot.lv;
      ctx.ok(c, ACTION.BUY_ITEM, { itemId, buyType: 'uses', amount, gold: price, uses: slot.uses });
      ctx.emit({ type: EVENT.ITEM_BOUGHT, actorId: c.id, itemId, amount: price, buyType: 'uses', text: `补充了 ${amount} 份定格手枪弹药（-${price} 金）`, audience: [AUDIENCE.ACTOR] });
      return undefined;
    }

    // 持有型道具买过就不能再买（password 明确不可重复购买）
    if (!TIMED.has(itemId) && slot.lv > 0) {
      const text = cfg.repeatable === false ? '这件道具已经拥有，不能重复购买' : '你已经有这件道具了，可以直接使用';
      return ctx.fail(c, ACTION.BUY_ITEM, ERR.ITEM, text, a, { itemId, reason: 'owned' });
    }
    if (TIMED.has(itemId) && slot.lv >= cfg.maxLevel) {
      return ctx.fail(c, ACTION.BUY_ITEM, ERR.ITEM, '这件道具已经满级，只能补充使用次数', a, { itemId, reason: 'maxLevel' });
    }
    // 价格按「买第几件」计价：Lv 即已持有数量，所以第一件 {Lv}=1，重复购买同一道具逐件变贵。
    const price = evalCost(cfg.price, slot.lv + 1) * amount;
    if (price > c.score) return ctx.fail(c, ACTION.BUY_ITEM, ERR.ITEM, `金币不足（需要 ${price}，你有 ${c.score}）`, a, { itemId, price, gold: c.score, reason: 'gold' });
    c.score -= price;
    c.itemStats.goldSpent += price;
    if (slot.lv <= 0) slot.lv = 1;
    // 首次购买直接给满仓次数；已持有则「再买一份」= 次数 +amount（受 maxUses 上限约束）
    slot.uses = slot.uses > 0 ? Math.min(cfg.maxUses, slot.uses + amount) : Math.min(cfg.maxUses, Math.max(amount, cfg.maxUses));
    c.itemStats.bought += 1;
    ctx.ok(c, ACTION.BUY_ITEM, { itemId, lv: slot.lv, uses: slot.uses, gold: price });
    ctx.emit({ type: EVENT.ITEM_BOUGHT, actorId: c.id, itemId, amount: price, text: `${c.name} 购买了「${this.label(itemId)}」`, audience: [AUDIENCE.ALL] });
    ctx.dialog(c, { kind: 'item_bought', itemId, lv: slot.lv, uses: slot.uses, score: c.score });
    return undefined;
  }

  // ------------------------------------------------------------ 升级

  upgrade(state, ctx, c, a) {
    const itemId = a.itemId;
    const cfg = this.cfgOf(ctx, itemId);
    const slot = c.items?.[itemId];
    if (!cfg || !ITEM_IDS.includes(itemId) || !slot) return ctx.fail(c, ACTION.UPGRADE_ITEM, ERR.ITEM, '没有这件道具', a, { itemId });
    if (slot.lv <= 0) return ctx.fail(c, ACTION.UPGRADE_ITEM, ERR.ITEM, '你还没有这件道具', a, { itemId, reason: 'owned' });
    if (slot.lv >= cfg.maxLevel) return ctx.fail(c, ACTION.UPGRADE_ITEM, ERR.ITEM, '已经满级了', a, { itemId, lv: slot.lv, reason: 'maxLevel' });
    const price = evalCost(cfg.upLevelPrice, slot.lv);
    if (price > c.score) return ctx.fail(c, ACTION.UPGRADE_ITEM, ERR.ITEM, `金币不足（升级需要 ${price}，你有 ${c.score}）`, a, { itemId, price, gold: c.score, reason: 'gold' });
    c.score -= price;
    c.itemStats.goldSpent += price;
    slot.lv += 1;
    c.itemStats.upgraded += 1;
    ctx.ok(c, ACTION.UPGRADE_ITEM, { itemId, lv: slot.lv, gold: price });
    ctx.emit({ type: EVENT.ITEM_UPGRADED, actorId: c.id, itemId, amount: price, text: `${c.name} 把「${this.label(itemId)}」升到了 Lv${slot.lv}`, audience: [AUDIENCE.ACTOR] });
    ctx.dialog(c, { kind: 'item_upgraded', itemId, lv: slot.lv, score: c.score });
    return undefined;
  }

  // ------------------------------------------------------------ 使用

  use(state, ctx, c, a) {
    const itemId = a.itemId;
    const cfg = this.cfgOf(ctx, itemId);
    const slot = c.items?.[itemId];
    if (!cfg || !ITEM_IDS.includes(itemId) || !slot) return ctx.fail(c, ACTION.USE_ITEM, ERR.ITEM, '没有这件道具', a, { itemId });
    if (slot.lv <= 0) return ctx.fail(c, ACTION.USE_ITEM, ERR.ITEM, '你还没有这件道具', a, { itemId, reason: 'owned' });
    if (VISION_DEPENDENT.has(itemId) && this.teacherFrozen(state)) {
      return ctx.fail(c, ACTION.USE_ITEM, ERR.ITEM, '老师被定格时，这类道具不生效', a, { itemId, reason: 'teacher_frozen' });
    }
    switch (itemId) {
      case ITEM_ID.FREEZE: return this.useFreeze(state, ctx, c, a, cfg, slot);
      case ITEM_ID.BUYOFF: return this.useBuyoff(state, ctx, c, a, cfg, slot);
      case ITEM_ID.PASSWORD: return this.usePassword(state, ctx, c, a, cfg, slot);
      case ITEM_ID.HOURGLASS: return this.useHourglass(state, ctx, c, a, cfg, slot);
      case ITEM_ID.HACKBOOK: return this.useHackbook(state, ctx, c, a, cfg, slot);
      default: return ctx.fail(c, ACTION.USE_ITEM, ERR.ITEM, '没有这件道具', a, { itemId });
    }
  }

  // 定格手枪：指定角色定格 Lv 秒
  useFreeze(state, ctx, c, a, cfg, slot) {
    const target = typeof a.targetId === 'string' ? getChar(state, a.targetId) : null;
    if (!target || !isActive(target) || target.id === c.id) {
      return ctx.fail(c, ACTION.USE_ITEM, ERR.ITEM, '请选择一个还在这局里的角色', a, { itemId: ITEM_ID.FREEZE, reason: 'target' });
    }
    if (!this.spend(ctx, c, a, ITEM_ID.FREEZE, slot)) return undefined;
    const ms = Math.max(0, cfg.freezeMsPerLevel * slot.lv);
    target.frozenUntil = Math.max(target.frozenUntil, state.tick + ctx.toTicks(ms));
    target.itemStats.frozenTimes += 1;
    ctx.ok(c, ACTION.USE_ITEM, { itemId: ITEM_ID.FREEZE, targetId: target.id, ms, lv: slot.lv });
    ctx.emit({ type: EVENT.FROZEN, actorId: c.id, targetId: target.id, itemId: ITEM_ID.FREEZE, amount: ms, pos: { ...target.pos }, text: `${c.name} 定格了 ${target.name}（${Math.round(ms / 100) / 10} 秒）`, audience: [AUDIENCE.ALL] });
    ctx.dialog(c, { kind: 'item_used', itemId: ITEM_ID.FREEZE, targetId: target.id, ms, uses: slot.uses });
    return undefined;
  }

  // 买通老师：被动持有，这里只确认一次使用（真正生效在 VisionSystem）
  useBuyoff(state, ctx, c, a, cfg, slot) {
    const pct = Math.max(0, 100 - cfg.seeThroughPctPerLevel * slot.lv);
    c.itemRoundCount[ITEM_ID.BUYOFF] = (c.itemRoundCount[ITEM_ID.BUYOFF] ?? 0) + 1;
    ctx.ok(c, ACTION.USE_ITEM, { itemId: ITEM_ID.BUYOFF, seeThroughPct: pct, lv: slot.lv });
    ctx.emit({ type: EVENT.ITEM_USED, actorId: c.id, itemId: ITEM_ID.BUYOFF, text: `${c.name} 递了个眼神：这几次 JC 老师多半看不见`, audience: [AUDIENCE.ACTOR] });
    ctx.dialog(c, { kind: 'item_used', itemId: ITEM_ID.BUYOFF, seeThroughPct: pct, lv: slot.lv });
    return undefined;
  }

  // 强密码：被动持有，别人 JC 你时要先解锁 Lv 秒（生效在 InteractionSystem.jcCommit）
  usePassword(state, ctx, c, a, cfg, slot) {
    const ms = this.lockMs(cfg, slot.lv);
    ctx.ok(c, ACTION.USE_ITEM, { itemId: ITEM_ID.PASSWORD, lockMs: ms, lv: slot.lv });
    ctx.emit({ type: EVENT.ITEM_USED, actorId: c.id, itemId: ITEM_ID.PASSWORD, amount: ms, text: `${c.name} 的电脑已经上了强密码`, audience: [AUDIENCE.ACTOR] });
    ctx.dialog(c, { kind: 'item_used', itemId: ITEM_ID.PASSWORD, lockMs: ms, lv: slot.lv });
    return undefined;
  }

  // 时间沙漏：除自己外全场定格 Lv 秒，每局 ceil(Lv/2) 次
  useHourglass(state, ctx, c, a, cfg, slot) {
    const limit = this.hourglassMaxPerRound(slot.lv);
    const used = c.itemRoundCount[ITEM_ID.HOURGLASS] ?? 0;
    if (used >= limit) {
      return ctx.fail(c, ACTION.USE_ITEM, ERR.ITEM, '本局沙漏次数用完了', a, { itemId: ITEM_ID.HOURGLASS, reason: 'round_limit', limit, used });
    }
    if (!this.spend(ctx, c, a, ITEM_ID.HOURGLASS, slot)) return undefined;
    const ms = Math.max(0, cfg.freezeMsPerLevel * slot.lv);
    const until = state.tick + ctx.toTicks(ms);
    let n = 0;
    for (const o of state.characters) {
      if (o.id === c.id || !isActive(o)) continue;
      o.frozenUntil = Math.max(o.frozenUntil, until);
      o.itemStats.frozenTimes += 1;
      n += 1;
    }
    ctx.ok(c, ACTION.USE_ITEM, { itemId: ITEM_ID.HOURGLASS, ms, affected: n, limit, used: used + 1 });
    ctx.emit({ type: EVENT.FROZEN, actorId: c.id, itemId: ITEM_ID.HOURGLASS, amount: ms, pos: { ...c.pos }, text: `${c.name} 转动了时间沙漏：除自己外 ${n} 人定格 ${Math.round(ms / 100) / 10} 秒`, audience: [AUDIENCE.ALL] });
    ctx.dialog(c, { kind: 'item_used', itemId: ITEM_ID.HOURGLASS, ms, affected: n, limit, used: used + 1 });
    return undefined;
  }

  // 黑客手册：查全员 → 对指定角色改积分/工资；失败自己 -100；被发现直接开除
  useHackbook(state, ctx, c, a, cfg, slot) {
    const limit = Math.max(1, Math.floor(cfg.maxPerRound ?? 1));
    const used = c.itemRoundCount[ITEM_ID.HACKBOOK] ?? 0;
    if (used >= limit) {
      return ctx.fail(c, ACTION.USE_ITEM, ERR.ITEM, '本局黑客手册次数用完了', a, { itemId: ITEM_ID.HACKBOOK, reason: 'round_limit', limit, used });
    }
    const failPct = this.hackFailPct(cfg, slot.lv);
    const expelPct = this.hackExpelPct(cfg, slot.lv);
    // 第一步：只打开全员列表（不消耗次数，客户端据此让玩家选目标）
    if (!a.charId || !a.action) {
      const list = state.characters
        .filter(isActive)
        .map((o) => ({ id: o.id, name: o.name, role: o.role, score: o.score, me: o.id === c.id }))
        .sort((x, y) => (x.role === y.role ? (x.id < y.id ? -1 : 1) : x.role === 'teacher' ? -1 : 1));
      ctx.ok(c, ACTION.USE_ITEM, { itemId: ITEM_ID.HACKBOOK, list: true, targets: list.length });
      ctx.dialog(c, { kind: 'hack.targets', list, failPct, expelPct });
      return undefined;
    }
    const target = getChar(state, a.charId);
    if (!target || !isActive(target)) return ctx.fail(c, ACTION.USE_ITEM, ERR.ITEM, '请选择一个还在这局里的角色', a, { itemId: ITEM_ID.HACKBOOK, reason: 'target' });
    const mode = a.action === 'set' || a.action === 'add' ? a.action : null;
    if (!mode) return ctx.fail(c, ACTION.USE_ITEM, ERR.ITEM, 'action 只能是 set 或 add', a, { itemId: ITEM_ID.HACKBOOK, reason: 'action' });
    const amount = Math.trunc(Number(a.amount));
    if (!Number.isFinite(amount) || amount === 0) return ctx.fail(c, ACTION.USE_ITEM, ERR.ITEM, '请填写要修改的数值', a, { itemId: ITEM_ID.HACKBOOK, reason: 'amount' });

    if (!this.spend(ctx, c, a, ITEM_ID.HACKBOOK, slot)) return undefined;

    const rng = ctx.rngOf(c);
    const failed = failPct > 0 && rng.next() * 100 < failPct;
    // 开除判定两次都抽（保持随机流次数稳定），是否触发由概率决定
    const expelled = expelPct > 0 && rng.next() * 100 < expelPct;

    if (failed) {
      const penalty = 100;
      c.score -= penalty;
      c.knownDelta -= penalty;
      c.itemStats.hackFail += 1;
      ctx.ok(c, ACTION.USE_ITEM, { itemId: ITEM_ID.HACKBOOK, success: false, targetId: target.id, penalty, expelled, failPct, expelPct });
      ctx.emit({ type: EVENT.ITEM_FAILED, actorId: c.id, targetId: target.id, itemId: ITEM_ID.HACKBOOK, amount: -penalty, text: `${c.name} 的黑客工具被防火墙弹回来了，-${penalty} 分`, audience: [AUDIENCE.ACTOR] });
      ctx.emit({ type: EVENT.HACK_RESULT, actorId: c.id, targetId: target.id, ok: false, text: '入侵失败，目标毫发无损', audience: [AUDIENCE.ACTOR] });
      ctx.dialog(c, { kind: 'hack_result', ok: false, targetId: target.id, penalty, expelled, failPct, expelPct });
      if (expelled) this.expel(state, ctx, c);
      return undefined;
    }

    const before = target.score;
    target.score = mode === 'set' ? amount : target.score + amount;
    const delta = target.score - before;
    if (isStudent(target)) target.knownDelta += delta;
    c.itemStats.hackSuccess += 1;
    ctx.ok(c, ACTION.USE_ITEM, { itemId: ITEM_ID.HACKBOOK, success: true, targetId: target.id, delta, expelled });
    ctx.emit({ type: EVENT.HACK_RESULT, actorId: c.id, targetId: target.id, amount: delta, ok: true, text: `${c.name} 篡改了 ${target.name} 的${isStudent(target) ? '积分' : '工资'}`, audience: [AUDIENCE.ACTOR] });
    ctx.dialog(c, { kind: 'hack_result', ok: true, targetId: target.id, delta, score: target.score, expelled, failPct, expelPct });
    if (expelled) this.expel(state, ctx, c);
    return undefined;
  }

  /** 被开除：立刻退场（与 ScoreSystem 的淘汰分支保持一致）。 */
  expel(state, ctx, c) {
    if (c.status !== STATUS.ACTIVE) return;
    c.status = STATUS.ELIMINATED;
    c.frozenUntil = 0;
    c.asking = null;
    c.opLock = null;
    c.inputDir = { x: 0, y: 0 };
    c.vel = { x: 0, y: 0 };
    c.operatingPcId = null;
    c.jcOpenPcId = null;
    for (const pc of state.pcs) if (pc.operatorId === c.id) pc.operatorId = null;
    state.stats.eliminations += 1;
    ctx.dialog(c, { kind: 'close', reason: 'eliminated', message: '被校长发现入侵监控系统，开除出局' });
    ctx.emit({ type: EVENT.ELIMINATED, actorId: c.id, amount: c.score, pos: { ...c.pos }, text: `${c.name} 被校长发现入侵监控系统，开除出局`, audience: [AUDIENCE.ALL] });
    if (c.control === CONTROL.HUMAN) state.result ??= { reason: END_REASON.PLAYER_ELIMINATED, winnerId: null };
  }
}
