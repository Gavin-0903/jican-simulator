// 交互系统：进入/离开电脑、查看积分、JC、问老师问题、讨好老师、老师检查电脑。
// 所有数值读 balance 配置；所有判定只在服务端执行，玩家与 AI 走同一套处理函数。

import { ACTION, AUDIENCE, ERR, EVENT, ITEM_ID, JC_BLOCK, JC_BLOCK_TEXT, ROOM_TYPE, STATUS } from '../../shared/constants.js';
import { dist, lerp, clamp } from '../../shared/math.js';
import { getChar, getPc, isActive, isStudent, isTeacher, releasePc } from '../core/GameState.js';

const MAX_RECENT_JC = 12;

export class InteractionSystem {
  update(state, ctx) {
    for (const c of state.characters) {
      if (!c.pendingActions.length) continue;
      const actions = c.pendingActions;
      c.pendingActions = [];
      for (const a of actions) {
        if (c.status !== STATUS.ACTIVE) {
          ctx.fail(c, a.kind, ERR.ELIMINATED, '你已退出本局', a);
          continue;
        }
        // 被定格期间不能做任何交互（但不会被强制离开电脑——定格只是暂停操作，
        // 强迫退出会把「定格 + 举报」变成一次免费抓人，成本与收益失衡）。
        if (ctx.frozen(c)) {
          ctx.fail(c, a.kind, ERR.FROZEN, '你被定格了', a);
          continue;
        }
        this.handle(state, ctx, c, a);
      }
    }
    this.updateAsking(state, ctx);
    this.updatePcSessions(state, ctx);
  }

  handle(state, ctx, c, a) {
    switch (a.kind) {
      case ACTION.ENTER_PC: return this.enterPc(state, ctx, c, a);
      case ACTION.LEAVE_PC: return this.leavePc(state, ctx, c, a);
      case ACTION.VIEW_SCORE: return this.viewScore(state, ctx, c, a);
      case ACTION.JC_OPEN: return this.jcOpen(state, ctx, c, a);
      case 'jc.commit': return this.jcCommit(state, ctx, c, a);
      case ACTION.ASK: return this.askQuestion(state, ctx, c, a);
      case ACTION.CANCEL_ASK: return this.cancelAsk(state, ctx, c, a);
      case ACTION.FLATTER: return this.flatter(state, ctx, c, a);
      case ACTION.INSPECT_PC: return this.inspectPc(state, ctx, c, a);
      default: return ctx.fail(c, a.kind, ERR.BADMSG, '未知动作', a);
    }
  }

  // ------------------------------------------------------------ 电脑

  enterPc(state, ctx, c, a) {
    const R = ctx.balance.interact.radius;
    const pc = getPc(state, a.pcId);
    if (!pc) return ctx.fail(c, a.kind, ERR.BADMSG, '电脑不存在', a);
    if (c.operatingPcId) {
      if (c.operatingPcId === pc.id) return this.sendPcDialog(state, ctx, c, pc);
      return ctx.fail(c, a.kind, ERR.STATE, '你正在使用另一台电脑', a);
    }
    const own = pc.id === c.homePcId;
    if (isTeacher(c) && !own) return ctx.fail(c, a.kind, ERR.FORBIDDEN, '老师只能使用自己的电脑；检查学生电脑请按 E「检查」', a);
    if (isStudent(c) && pc.ownerRole !== 'student') return ctx.fail(c, a.kind, ERR.FORBIDDEN, '这是老师的电脑', a);
    if (dist(c.pos, pc.pos) > R) return ctx.fail(c, a.kind, ERR.OUTOFRANGE, '离电脑太远', a);
    if (pc.operatorId) {
      if (pc.operatorId === pc.ownerCharId) {
        return ctx.fail(c, a.kind, ERR.IMMUNE, '电脑主人正在使用自己的电脑（免疫）', a, { reason: JC_BLOCK.TARGET_IMMUNE });
      }
      return ctx.fail(c, a.kind, ERR.BUSY, '这台电脑正被别人占用', a, { operatorId: pc.operatorId });
    }
    if (own && c.cooldowns.pcReenter > state.tick) {
      return ctx.fail(c, a.kind, ERR.COOLDOWN, '刚离开电脑，稍后才能再次使用', a, { remainingMs: ctx.ticksToMs(c.cooldowns.pcReenter - state.tick) });
    }
    if (c.asking) this.stopAsking(state, ctx, c, '开始使用电脑，提问中断');
    pc.operatorId = c.id;
    pc.sessionStartTick = state.tick;
    pc.lastActionTick = state.tick;
    pc.lockUntil = state.tick + ctx.toTicks(ctx.balance.pc.idleTimeoutMs);
    c.operatingPcId = pc.id;
    c.opLock = { kind: 'operate', pcId: pc.id };
    c.inputDir = { x: 0, y: 0 };
    c.vel = { x: 0, y: 0 };
    if (ctx.map.isFree(pc.pos)) c.pos = { x: pc.pos.x, y: pc.pos.y };
    c.facing = -Math.PI / 2;
    const owner = getChar(state, pc.ownerCharId);
    if (!own && owner) c.lastPcView = { pcId: pc.id, ownerId: owner.id, ownerScore: owner.score, tick: state.tick };
    ctx.ok(c, a.kind, { pcId: pc.id, own, ownerId: owner?.id ?? null, ownerScore: own ? null : owner?.score ?? null });
    this.sendPcDialog(state, ctx, c, pc);
  }

  sendPcDialog(state, ctx, c, pc) {
    const own = pc.id === c.homePcId;
    const owner = getChar(state, pc.ownerCharId);
    ctx.dialog(c, {
      kind: 'pc',
      pcId: pc.id,
      own,
      ownerId: owner?.id ?? null,
      ownerName: owner?.name ?? '无主电脑',
      ownerUsername: owner?.username ?? null,
      ownerRole: pc.ownerRole,
      ownerStatus: owner?.status ?? null,
      // §1.6 Q9：可以进入他人电脑查看他人积分；自己的积分需要主动「查看积分」
      ownerScore: own ? null : owner?.score ?? null,
      idleTimeoutMs: ctx.balance.pc.idleTimeoutMs,
      maxSessionMs: own ? ctx.balance.pc.ownMaxSessionMs : null,
      canJc: !own && isStudent(c) && pc.ownerRole === 'student',
    });
  }

  leavePc(state, ctx, c, a) {
    const pcId = releasePc(state, c);
    if (!pcId) return ctx.fail(c, a.kind, ERR.STATE, '你没有在使用电脑', a);
    ctx.ok(c, a.kind, { pcId });
    ctx.dialog(c, { kind: 'close', reason: 'left' });
  }

  viewScore(state, ctx, c, a) {
    const pc = getPc(state, c.operatingPcId);
    if (!pc || pc.id !== c.homePcId) {
      return ctx.fail(c, a.kind, ERR.FORBIDDEN, '只能在自己的电脑上查看自己的积分', a);
    }
    pc.lastActionTick = state.tick;
    if (isStudent(c)) {
      c.lastViewedScore = c.score;
      c.lastViewedTick = state.tick;
      c.knownDelta = 0;
      ctx.ok(c, a.kind, { score: c.score });
      ctx.dialog(c, {
        kind: 'score_view',
        role: c.role,
        name: c.name,
        username: c.username,
        score: c.score,
        failScore: ctx.balance.student.failScore,
        targetScore: state.targetScore,
        askCount: c.askCount,
        askLimit: ctx.balance.ask.limit,
      });
    } else {
      const roster = state.characters
        .filter((s) => isStudent(s) && c.classId != null && s.classId === c.classId)
        .map((s) => ({ id: s.id, name: s.name, username: s.username, score: s.score, status: s.status }))
        .sort((x, y) => y.score - x.score);
      ctx.ok(c, a.kind, { salary: c.score });
      ctx.dialog(c, { kind: 'score_view', role: c.role, name: c.name, username: c.username, salary: c.score, classId: c.classId, roster });
    }
  }

  // ------------------------------------------------------------ JC

  jcBlock(state, ctx, c, a, reason, code) {
    ctx.fail(c, a.kind, code, JC_BLOCK_TEXT[reason], a, { reason });
    ctx.dialog(c, { kind: 'jc_blocked', reason, message: JC_BLOCK_TEXT[reason], remainingMs: Math.max(0, ctx.ticksToMs(c.cooldowns.jc - state.tick)) });
  }

  jcOpen(state, ctx, c, a) {
    if (!isStudent(c)) return ctx.fail(c, a.kind, ERR.FORBIDDEN, '只有学生可以 JC', a);
    const pc = getPc(state, c.operatingPcId);
    if (!pc || pc.id === c.homePcId || pc.ownerRole !== 'student' || (a.pcId && a.pcId !== pc.id)) {
      return this.jcBlock(state, ctx, c, a, JC_BLOCK.NOT_AT_PC, ERR.STATE);
    }
    if (c.cooldowns.jc > state.tick) return this.jcBlock(state, ctx, c, a, JC_BLOCK.COOLDOWN, ERR.COOLDOWN);
    const owner = getChar(state, pc.ownerCharId);
    pc.lastActionTick = state.tick;
    c.jcOpenPcId = pc.id;
    c.lastPcView = { pcId: pc.id, ownerId: owner.id, ownerScore: owner.score, tick: state.tick };
    ctx.ok(c, a.kind, { pcId: pc.id, ownerScore: owner.score });
    ctx.dialog(c, {
      kind: 'jc.open',
      pcId: pc.id,
      ownerId: owner.id,
      ownerName: owner.name,
      ownerScore: owner.score,
    });
  }

  /**
   * 强密码（道具）：目标持有 password Lv 级时，攻击者第一次提交会先「解锁」Lv 秒，
   * 解锁期内表单锁定、再次提交只返回剩余时间；解锁完成后本次 JC 不再受拦截。
   * 判定放在扣分之前，且冷冻/淘汰者持有密码仍然生效（状态只读持有者的 items，不看其 status）。
   */
  passwordGate(state, ctx, c, a, owner) {
    const lv = owner?.items?.password?.lv ?? 0;
    if (lv <= 0) return false;
    const now = state.tick;
    const cur = c.unlock[owner.id];
    const lockTicks = ctx.toTicks((ctx.balance.items.password.lockMsPerLevel ?? 0) * lv);
    if (cur && cur.until > now) {
      const remainMs = Math.max(0, ctx.ticksToMs(cur.until - now));
      ctx.fail(c, a.kind, ERR.ITEM, '这台电脑上了强密码，正在破解中', a, { reason: 'locked', victimId: owner.id, remainMs });
      ctx.dialog(c, { kind: 'jc_locked', victimId: owner.id, remainMs, lockMs: ctx.ticksToMs(lockTicks) });
      return true;
    }
    // 上一次已经破完（ItemSystem 清理过期条目时留下的 unlockOnce 标记）：本次放行。
    // 一次标记只放行一次，避免「破解成功 → 之后每次 JC 都免解锁」。
    if (c.unlockOnce?.[owner.id]) {
      delete c.unlockOnce[owner.id];
      return false;
    }
    // 首次触发：开始计时
    c.unlock[owner.id] = { until: now + lockTicks, victimId: owner.id };
    const remainMs = ctx.ticksToMs(lockTicks);
    ctx.fail(c, a.kind, ERR.ITEM, '这台电脑上了强密码，需要先解锁', a, { reason: 'locked', victimId: owner.id, remainMs });
    ctx.dialog(c, { kind: 'jc_locked', victimId: owner.id, remainMs, lockMs: remainMs });
    ctx.emit({ type: EVENT.ITEM_USED, actorId: c.id, targetId: owner.id, itemId: ITEM_ID.PASSWORD, amount: remainMs, audience: [AUDIENCE.ACTOR] });
    return true;
  }

  jcCommit(state, ctx, c, a) {
    const pcId = c.jcOpenPcId;
    const pc = getPc(state, pcId);
    if (!pc || c.operatingPcId !== pcId) return this.jcBlock(state, ctx, c, a, JC_BLOCK.NOT_AT_PC, ERR.STATE);
    if (c.cooldowns.jc > state.tick) return this.jcBlock(state, ctx, c, a, JC_BLOCK.COOLDOWN, ERR.COOLDOWN);
    if (this.passwordGate(state, ctx, c, a, getChar(state, pc.ownerCharId))) return undefined;
    const owner = getChar(state, pc.ownerCharId);
    const username = typeof a.selfUsername === 'string' ? a.selfUsername.trim() : '';
    if (username !== c.username) {
      c.cooldowns.jc = Math.max(c.cooldowns.jc, state.tick + ctx.toTicks(ctx.balance.jc.mismatchCooldownMs));
      return this.jcBlock(state, ctx, c, a, JC_BLOCK.USERNAME_MISMATCH, ERR.USERNAME);
    }
    const amount = a.amount;
    if (!Number.isInteger(amount) || amount <= 0 || amount > ctx.balance.jc.maxAmount) {
      return this.jcBlock(state, ctx, c, a, JC_BLOCK.INVALID_AMOUNT, ERR.AMOUNT);
    }
    // §1.6 Q4：x ≤ 目标积分；目标积分 ≤ 0 时无正数解
    if (!owner || owner.score <= 0 || amount > owner.score) return this.jcBlock(state, ctx, c, a, JC_BLOCK.EXCEED_TARGET, ERR.AMOUNT);
    if (pc.operatorId !== c.id) return this.jcBlock(state, ctx, c, a, JC_BLOCK.TARGET_IMMUNE, ERR.IMMUNE);
    if (dist(c.pos, pc.pos) > ctx.balance.interact.radius) return this.jcBlock(state, ctx, c, a, JC_BLOCK.OUT_OF_RANGE, ERR.OUTOFRANGE);

    owner.score -= amount;
    c.score += amount;
    c.knownDelta += amount;
    c.stats.jcSuccess += 1;
    c.stats.jcGained += amount;
    owner.stats.jcVictim += 1;
    owner.stats.jcLost += amount;
    state.stats.jc += 1;
    state.stats.jcAmount += amount;
    c.cooldowns.jc = state.tick + ctx.toTicks(ctx.balance.jc.cooldownMs);
    c.jcOpenPcId = null;
    pc.lastActionTick = state.tick;
    c.lastPcView = { pcId: pc.id, ownerId: owner.id, ownerScore: owner.score, tick: state.tick };

    const record = { tick: state.tick, actorId: c.id, targetId: owner.id, amount, pcId: pc.id, pos: { x: c.pos.x, y: c.pos.y } };
    state.recentJc.push(record);
    if (state.recentJc.length > MAX_RECENT_JC) state.recentJc.shift();
    ctx.frame.pendingJc.push(record);

    ctx.ok(c, a.kind, { amount, targetId: owner.id, ownerScore: owner.score });
    ctx.emit({ type: EVENT.JC_SUCCESS, actorId: c.id, targetId: owner.id, amount, pos: record.pos, pcId: pc.id, audience: [AUDIENCE.ACTOR, AUDIENCE.WITNESS] });
    ctx.emit({ type: EVENT.JC_VICTIM, targetId: owner.id, pos: record.pos, text: '你的电脑好像被人动过……', audience: [AUDIENCE.TARGET] });
  }

  // ------------------------------------------------------------ 问问题 / 讨好

  nearestTeacher(state, c, radius, filter = () => true) {
    let best = null;
    let bestD = Infinity;
    for (const t of state.characters) {
      if (!isTeacher(t) || !isActive(t) || t.id === c.id || !filter(t)) continue;
      const d = dist(c.pos, t.pos);
      if (d <= radius && d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  }

  inOffice(ctx, p) {
    return ctx.map.roomAt(p)?.type === ROOM_TYPE.OFFICE;
  }

  askQuestion(state, ctx, c, a) {
    const { ask, interact } = ctx.balance;
    if (!isStudent(c)) return ctx.fail(c, a.kind, ERR.FORBIDDEN, '只有学生可以提问', a);
    if (c.operatingPcId) return ctx.fail(c, a.kind, ERR.STATE, '正在使用电脑', a);
    if (c.asking) return ctx.ok(c, a.kind, { already: true });
    if (c.askCount >= ask.limit) return ctx.fail(c, a.kind, ERR.COOLDOWN, '本局提问次数已用完', a);
    if (c.cooldowns.ask > state.tick) {
      return ctx.fail(c, a.kind, ERR.COOLDOWN, '提问冷却中', a, { remainingMs: ctx.ticksToMs(c.cooldowns.ask - state.tick) });
    }
    if (!this.inOffice(ctx, c.pos)) return ctx.fail(c, a.kind, ERR.OUTOFRANGE, '只能在办公室向老师提问', a);
    const inOffice = (t) => this.inOffice(ctx, t.pos);
    let teacher = a.targetId ? getChar(state, a.targetId) : this.nearestTeacher(state, c, interact.radius, inOffice);
    if (!teacher || !isTeacher(teacher) || !isActive(teacher) || !inOffice(teacher) || dist(c.pos, teacher.pos) > interact.radius) {
      return ctx.fail(c, a.kind, ERR.OUTOFRANGE, '身边没有在办公室的老师', a);
    }
    c.asking = { teacherId: teacher.id, ms: 0 };
    c.opLock = { kind: 'ask', targetId: teacher.id };
    ctx.ok(c, a.kind, { started: true, teacherId: teacher.id });
    ctx.emit({ type: EVENT.ASK_STARTED, actorId: c.id, targetId: teacher.id, pos: { ...c.pos }, audience: [AUDIENCE.ACTOR] });
    ctx.say(c, 'ask', { teacher: teacher.name });
  }

  cancelAsk(state, ctx, c, a) {
    if (!c.asking) return ctx.fail(c, a.kind, ERR.STATE, '当前没有在提问', a);
    this.stopAsking(state, ctx, c, '你中断了提问');
  }

  stopAsking(state, ctx, c, text) {
    c.asking = null;
    if (c.opLock?.kind === 'ask') c.opLock = null;
    c.lastResult = { kind: ACTION.ASK, ok: false, cancelled: true, tick: state.tick };
    ctx.emit({ type: EVENT.ASK_CANCELLED, actorId: c.id, text, audience: [AUDIENCE.ACTOR] });
  }

  updateAsking(state, ctx) {
    const { ask, interact, flatter } = ctx.balance;
    for (const c of state.characters) {
      if (!c.asking) continue;
      const t = getChar(state, c.asking.teacherId);
      // 定格期间提问进度暂停（不中断）：被定格不是玩家的错，不该白白丢掉已积累的停留时间。
      if (ctx.frozen(c) || ctx.frozen(t)) continue;
      const valid =
        isActive(c) && isActive(t) && !c.operatingPcId &&
        this.inOffice(ctx, c.pos) && this.inOffice(ctx, t.pos) &&
        dist(c.pos, t.pos) <= interact.radius * ask.rangeTolerance;
      if (!valid) {
        this.stopAsking(state, ctx, c, '离开了老师身边，提问中断（需连续停留）');
        continue;
      }
      c.asking.ms += ctx.stepMs * c.attrMul.interact;
      if (c.asking.ms < ask.dwellMs) continue;
      const reward = Math.round(ask.reward * c.attrMul.scoreGain);
      c.score += reward;
      c.knownDelta += reward;
      c.askCount += 1;
      c.stats.asks += 1;
      state.stats.asks += 1;
      t.favor[c.id] = clamp((t.favor[c.id] ?? flatter.favorInit) + flatter.askFavorGain, 0, 1);
      c.cooldowns.ask = state.tick + ctx.toTicks(ask.cooldownMs);
      c.asking = null;
      if (c.opLock?.kind === 'ask') c.opLock = null;
      c.lastResult = { kind: ACTION.ASK, ok: true, done: true, amount: reward, tick: state.tick };
      ctx.emit({ type: EVENT.SCORE_CHANGED, actorId: c.id, targetId: t.id, amount: reward, reason: 'ask', text: `问完问题，+${reward} 分`, audience: [AUDIENCE.ACTOR] });
      ctx.say(t, 'answer', { student: c.name });
    }
  }

  flatter(state, ctx, c, a) {
    const { flatter, interact } = ctx.balance;
    if (!isStudent(c)) return ctx.fail(c, a.kind, ERR.FORBIDDEN, '只有学生可以讨好老师', a);
    if (c.operatingPcId) return ctx.fail(c, a.kind, ERR.STATE, '正在使用电脑', a);
    if (c.asking) return ctx.fail(c, a.kind, ERR.STATE, '正在提问，先专心问完', a);
    if (c.cooldowns.flatter > state.tick) {
      return ctx.fail(c, a.kind, ERR.COOLDOWN, '讨好冷却中', a, { remainingMs: ctx.ticksToMs(c.cooldowns.flatter - state.tick) });
    }
    const teacher = a.targetId ? getChar(state, a.targetId) : this.nearestTeacher(state, c, interact.radius);
    if (!teacher || !isTeacher(teacher) || !isActive(teacher) || dist(c.pos, teacher.pos) > interact.radius) {
      return ctx.fail(c, a.kind, ERR.OUTOFRANGE, '身边没有老师', a);
    }
    // §1.6 Q2：成功率 40%~80%，由老师对该学生的好感度决定；成功得 0~100，失败扣 5~40
    const favor = teacher.favor[c.id] ?? flatter.favorInit;
    const p = lerp(flatter.successRateMin, flatter.successRateMax, favor);
    const rng = ctx.rngOf(c);
    c.cooldowns.flatter = state.tick + ctx.toTicks(flatter.cooldownMs);
    state.stats.flatters += 1;
    if (rng.next() < p) {
      const amount = Math.round(rng.int(flatter.min, flatter.max) * c.attrMul.scoreGain);
      c.score += amount;
      c.knownDelta += amount;
      c.stats.flatterOk += 1;
      teacher.favor[c.id] = clamp(favor + flatter.favorGain, 0, 1);
      ctx.ok(c, a.kind, { success: true, amount, teacherId: teacher.id });
      ctx.emit({ type: EVENT.SCORE_CHANGED, actorId: c.id, targetId: teacher.id, amount, reason: 'flatter_ok', text: `讨好成功，+${amount} 分`, audience: [AUDIENCE.ACTOR] });
      ctx.say(c, 'flatter', { teacher: teacher.name });
    } else {
      const penalty = rng.int(flatter.failPenaltyMin, flatter.failPenaltyMax);
      c.score -= penalty;
      c.knownDelta -= penalty;
      c.stats.flatterFail += 1;
      teacher.favor[c.id] = clamp(favor - flatter.favorLoss, 0, 1);
      ctx.ok(c, a.kind, { success: false, amount: -penalty, teacherId: teacher.id });
      ctx.emit({ type: EVENT.SCORE_CHANGED, actorId: c.id, targetId: teacher.id, amount: -penalty, reason: 'flatter_fail', text: `马屁拍到马腿上，-${penalty} 分`, audience: [AUDIENCE.ACTOR] });
      ctx.say(c, 'flatter', { teacher: teacher.name });
      ctx.say(teacher, 'flatter_reject', { student: c.name });
      ctx.notifyAi(teacher, 'flatter_fail', { charId: c.id });
    }
  }

  // ------------------------------------------------------------ 老师检查电脑

  inspectPc(state, ctx, c, a) {
    const { teacher } = ctx.balance;
    if (!isTeacher(c)) return ctx.fail(c, a.kind, ERR.FORBIDDEN, '只有老师可以检查电脑', a);
    if (c.cooldowns.inspect > state.tick) return ctx.fail(c, a.kind, ERR.COOLDOWN, '检查冷却中', a);
    let pc = a.pcId ? getPc(state, a.pcId) : null;
    if (!pc) {
      let bestD = Infinity;
      for (const p of state.pcs) {
        const d = dist(c.pos, p.pos);
        if (p.operatorId && d <= teacher.inspectRadius && d < bestD) {
          pc = p;
          bestD = d;
        }
      }
    }
    if (!pc || dist(c.pos, pc.pos) > teacher.inspectRadius) return ctx.fail(c, a.kind, ERR.OUTOFRANGE, '附近没有正在使用的电脑', a);
    c.cooldowns.inspect = state.tick + ctx.toTicks(teacher.inspectCooldownMs);
    c.stats.inspects += 1;
    const op = getChar(state, pc.operatorId);
    if (op && isStudent(op) && op.id !== pc.ownerCharId) {
      ctx.frame.pendingCatches.push({ teacherId: c.id, charId: op.id, reason: 'trespass', pcId: pc.id, amount: 0 });
      ctx.ok(c, a.kind, { caught: op.id });
    } else {
      ctx.ok(c, a.kind, { caught: null });
      ctx.emit({ type: EVENT.INSPECT_CLEAR, actorId: c.id, pos: { ...pc.pos }, text: op ? `${op.name} 在用自己的电脑，没有异常` : '电脑没人在用', audience: [AUDIENCE.ACTOR] });
    }
  }

  // ------------------------------------------------------------ 电脑会话超时

  updatePcSessions(state, ctx) {
    const { pc: pcCfg } = ctx.balance;
    for (const pc of state.pcs) {
      if (!pc.operatorId) continue;
      const op = getChar(state, pc.operatorId);
      if (!op || !isActive(op) || op.operatingPcId !== pc.id) {
        pc.operatorId = null;
        continue;
      }
      const idle = state.tick - pc.lastActionTick >= ctx.toTicks(pcCfg.idleTimeoutMs);
      const ownLimit = op.id === pc.ownerCharId && state.tick - pc.sessionStartTick >= ctx.toTicks(pcCfg.ownMaxSessionMs);
      if (!idle && !ownLimit) continue;
      releasePc(state, op);
      if (ownLimit) op.cooldowns.pcReenter = state.tick + ctx.toTicks(pcCfg.reenterCooldownMs);
      const text = ownLimit ? '使用时间到，你离开了电脑' : '长时间没有操作，自动离开电脑';
      op.lastResult = { kind: ACTION.LEAVE_PC, ok: true, auto: true, tick: state.tick };
      ctx.dialog(op, { kind: 'close', reason: ownLimit ? 'session_limit' : 'idle', message: text });
      ctx.emit({ type: EVENT.PC_KICKED, actorId: op.id, text, audience: [AUDIENCE.ACTOR] });
    }
  }
}
