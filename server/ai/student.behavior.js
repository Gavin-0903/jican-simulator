// 学生 AI 行为库。每个行为单元 = { id, evaluate → {terms,data} | null, start, update → running|done|failed }。
// 新增行为只需在 STUDENT_BEHAVIORS 中注册。

import { ROOM_TYPE, STATUS } from '../../shared/constants.js';
import { dist, angleTo, lerp, clamp, degToRad } from '../../shared/math.js';
import { isActive, isStudent, isTeacher } from '../core/GameState.js';
import { norm } from './UtilityScorer.js';
import { navigate } from './Navigator.js';

const bandGain = (band, table) => table[band] ?? 1;

function roomTypeAt(ax, p) {
  return ax.map.roomAt(p)?.type ?? null;
}

/** 办公室里正在值守的老师（常驻老师始终在办公室，学生默认知道）。 */
function officeTeachers(ax) {
  return ax.state.characters.filter((t) => isTeacher(t) && isActive(t) && roomTypeAt(ax, t.pos) === ROOM_TYPE.OFFICE);
}

/** 学生「知道位置」的老师：办公室老师 + 最近见过的老师。 */
function knownTeachers(ax) {
  const memo = ax.toTicks(15000);
  return ax.state.characters.filter((t) => {
    if (!isTeacher(t) || !isActive(t)) return false;
    if (t.classId == null) return true;
    const seen = ax.bb.lastSeen[t.id];
    return seen && ax.tick - seen.tick <= memo;
  });
}

function askSlot(ax, teacher) {
  const { self, map, state } = ax;
  for (const deg of [90, 50, 130, 15, 165, -25, 205]) {
    const a = degToRad(deg);
    const p = { x: teacher.pos.x + Math.cos(a) * 32, y: teacher.pos.y + Math.sin(a) * 32 };
    if (!map.isFree(p, 12) || roomTypeAt(ax, p) !== ROOM_TYPE.OFFICE) continue;
    const crowded = state.characters.some((o) => o.id !== self.id && o.id !== teacher.id && isActive(o) && dist(o.pos, p) < 22);
    if (!crowded) return p;
  }
  return { x: teacher.pos.x, y: teacher.pos.y + 30 };
}

function nearestRoom(ax, type) {
  let best = null;
  let bestD = Infinity;
  for (const r of ax.map.rooms) {
    if (r.type !== type) continue;
    const c = { x: r.rect.x + r.rect.w / 2, y: r.rect.y + r.rect.h / 2 };
    const d = dist(ax.self.pos, c);
    if (d < bestD) {
      best = r;
      bestD = d;
    }
  }
  return best ? { room: best, d: bestD } : null;
}

function wanderPoint(ax) {
  const anchors = ax.map.anchors.wander || [];
  if (anchors.length && ax.rng.next() < 0.7) {
    const p = ax.rng.pick(anchors);
    return { x: p.x + ax.rng.range(-30, 30), y: p.y + ax.rng.range(-20, 20) };
  }
  const own = ax.map.rooms.find((r) => r.type === ROOM_TYPE.CLASSROOM && r.classId === ax.self.classId);
  return own ? ax.map.randomPointInRoom(own.id, ax.rng) : { x: 960, y: 715 };
}

// ------------------------------------------------------------ 问老师问题

const askQuestion = {
  id: 'ask_question',
  label: '去办公室问问题',
  evaluate(ax) {
    const { self, balance, tick, band } = ax;
    if (self.askCount >= balance.ask.limit || self.cooldowns.ask > tick) return null;
    const teachers = officeTeachers(ax);
    if (!teachers.length) return null;
    const load = (t) => ax.state.characters.filter((s) => s.asking?.teacherId === t.id).length;
    teachers.sort((a, b) => load(a) - load(b) || dist(self.pos, a.pos) - dist(self.pos, b.pos));
    const t = teachers[0];
    const gain = norm(balance.ask.reward * self.attrMul.scoreGain, 100) * bandGain(band, { balanced: 1.4, danger: 1.0, safe: 0.8 });
    return {
      terms: { gain, cost: norm(dist(self.pos, t.pos), 1600) + 0.12, risk: 0.02, persona: ax.bb.persona.patience * 0.5 },
      data: { teacherId: t.id },
    };
  },
  start(ax, data) {
    return { step: 'go', teacherId: data.teacherId, slot: null, t0: ax.tick };
  },
  update(ax, st) {
    const { self, balance, tick } = ax;
    const teacher = ax.getChar(st.teacherId);
    if (!isActive(teacher)) return 'failed';
    if (tick - st.t0 > ax.toTicks(45000)) return 'failed';
    const R = balance.interact.radius;
    if (st.step === 'go') {
      if (!st.slot || (tick - st.t0) % 10 === 0) st.slot = askSlot(ax, teacher);
      const res = navigate(ax, st.slot, 6);
      if (res === 'unreachable') return 'failed';
      const close = dist(self.pos, teacher.pos) <= R * 0.85 && roomTypeAt(ax, self.pos) === ROOM_TYPE.OFFICE;
      if (close && (res === 'arrived' || dist(self.pos, st.slot) < 14)) {
        ax.face(angleTo(self.pos, teacher.pos));
        ax.request(st, 'askQuestion', { targetId: teacher.id });
        st.step = 'asking';
      }
      return 'running';
    }
    // asking：原地连续停留 10 秒
    ax.face(angleTo(self.pos, teacher.pos));
    if (st.wait) {
      const r = ax.poll(st);
      if (r === 'pending') return 'running';
      return r.ok ? 'running' : 'failed';
    }
    if (self.asking) return 'running';
    const lr = self.lastResult;
    return lr?.kind === 'askQuestion' && lr.done ? 'done' : 'failed';
  },
};

// ------------------------------------------------------------ 讨好老师

const flatter = {
  id: 'flatter',
  label: '讨好老师',
  repeatPenalty: true,
  evaluate(ax) {
    const { self, balance, tick, band } = ax;
    if (self.cooldowns.flatter > tick) return null;
    let best = null;
    let bestD = Infinity;
    for (const t of knownTeachers(ax)) {
      const d = dist(self.pos, t.pos);
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    }
    if (!best) return null;
    const f = balance.flatter;
    const favor = best.favor[self.id] ?? f.favorInit;
    const p = lerp(f.successRateMin, f.successRateMax, favor);
    const expGain = p * ((f.min + f.max) / 2) * self.attrMul.scoreGain;
    const expLoss = (1 - p) * ((f.failPenaltyMin + f.failPenaltyMax) / 2);
    const gain = norm(expGain, 100) * bandGain(band, { danger: 1.5, balanced: 1.1, safe: 0.6 });
    return {
      terms: { gain, cost: norm(bestD, 1600) + 0.05, risk: norm(expLoss, 100), persona: ax.bb.persona.social * 0.6 },
      data: { teacherId: best.id },
    };
  },
  start(ax, data) {
    return { step: 'go', teacherId: data.teacherId, t0: ax.tick };
  },
  update(ax, st) {
    const { self, balance, tick } = ax;
    const teacher = ax.getChar(st.teacherId);
    if (!isActive(teacher) || tick - st.t0 > ax.toTicks(30000)) return 'failed';
    if (st.step === 'go') {
      const res = navigate(ax, teacher.pos, balance.interact.radius * 0.6);
      if (res === 'unreachable') return 'failed';
      if (dist(self.pos, teacher.pos) <= balance.interact.radius * 0.8) {
        ax.face(angleTo(self.pos, teacher.pos));
        ax.request(st, 'flatter', { targetId: teacher.id });
        st.step = 'wait';
      }
      return 'running';
    }
    const r = ax.poll(st);
    if (r === 'pending') return 'running';
    return r?.ok ? 'done' : 'failed';
  },
};

// ------------------------------------------------------------ JC 狩猎

function jcFraction(ax) {
  const { persona } = ax.bb;
  return clamp(0.3 + 0.5 * persona.risk + (ax.band === 'danger' ? 0.3 : 0), 0.15, 1);
}

function riskThreshold(ax) {
  return 0.18 + 0.4 * ax.bb.persona.risk + (ax.band === 'danger' ? 0.25 : 0);
}

const jcHunt = {
  id: 'jc_hunt',
  label: '寻找 JC 目标',
  aggressive: true,
  evaluate(ax) {
    const { self, state, bb, balance, tick, band } = ax;
    if (self.cooldowns.jc > tick) return null;
    const prior = balance.ai.priorScorePerMin * (state.elapsedMs / 60000);
    const frac = jcFraction(ax);
    let best = null;
    for (const o of state.characters) {
      if (!isStudent(o) || o.id === self.id || o.status !== STATUS.ACTIVE) continue;
      const pc = ax.getPc(o.homePcId);
      const seen = bb.lastSeen[o.id];
      // 主人刚被看到在自己电脑前（免疫）或就在附近，暂不考虑
      if (seen && tick - seen.tick < ax.toTicks(6000) && (seen.op === pc.id || dist(seen, pc.pos) < 120)) continue;
      const known = seen?.score;
      const est = known != null ? lerp(known, prior, clamp((tick - (seen.scoreTick ?? 0)) / ax.toTicks(180000), 0, 1)) : prior;
      if (est <= 5) continue;
      const grudge = Math.min(1, bb.grudge[o.id] ?? 0);
      const gain = norm(est * frac, 250) + 0.3 * grudge;
      const cost = norm(dist(self.pos, pc.pos), 1600);
      const risk = ax.exposureAt(pc.pos, pc.id);
      const local = gain - 0.6 * cost - 0.8 * risk;
      if (!best || local > best.local) best = { local, gain, cost, risk, targetId: o.id, pcId: pc.id };
    }
    if (!best) return null;
    const mult = { danger: 1.6, balanced: 0.75, safe: 0.35 }[band] ?? 1;
    return {
      terms: { gain: best.gain * mult, cost: best.cost + 0.08, risk: best.risk + 0.1, persona: bb.persona.risk * 0.8 - 0.2 },
      data: { targetId: best.targetId, pcId: best.pcId },
    };
  },
  start(ax, data) {
    return { step: 'go', targetId: data.targetId, pcId: data.pcId, t0: ax.tick, waitUntil: 0, flee: null };
  },
  update(ax, st) {
    const { self, bb, tick, balance } = ax;
    const pc = ax.getPc(st.pcId);
    const target = ax.getChar(st.targetId);
    if (!pc || !target) return 'failed';
    if (tick - st.t0 > ax.toTicks(70000)) return 'failed';
    const operating = self.operatingPcId === pc.id;
    // 操作他人电脑期间若暴露风险飙升，立刻撤离
    if (operating && st.step !== 'leaving' && ax.exposureAt(pc.pos, pc.id) > riskThreshold(ax) + 0.25) {
      ax.act('leavePc');
      st.step = 'leaving';
      st.leaveTick = tick;
      return 'running';
    }
    switch (st.step) {
      case 'go': {
        if (pc.operatorId && ax.canSee(pc.pos)) {
          bb.lastSeen[target.id] = { ...(bb.lastSeen[target.id] || {}), x: Math.round(target.pos.x), y: Math.round(target.pos.y), tick, op: pc.operatorId === target.id ? pc.id : null };
          return 'failed';
        }
        const res = navigate(ax, pc.pos, 6);
        if (res === 'unreachable') return 'failed';
        if (dist(self.pos, pc.pos) <= balance.interact.radius * 0.6) {
          st.step = 'assess';
          st.waitUntil = tick + ax.toTicks(2000 + 8000 * bb.persona.patience);
        }
        return 'running';
      }
      case 'assess': {
        ax.perceive();
        const risk = ax.exposureAt(pc.pos, pc.id);
        if (risk <= riskThreshold(ax)) {
          ax.request(st, 'enterPc', { pcId: pc.id });
          st.step = 'entering';
        } else if (tick > st.waitUntil) {
          return 'failed';
        } else {
          ax.face(self.facing + 0.6 * Math.sin(tick / 4)); // 东张西望
        }
        return 'running';
      }
      case 'entering': {
        const r = ax.poll(st);
        if (r === 'pending') return 'running';
        if (!r.ok) return 'failed';
        const score = r.ownerScore ?? target.score;
        bb.lastSeen[target.id] = { ...(bb.lastSeen[target.id] || { x: target.pos.x, y: target.pos.y, tick, facing: 0, op: null }), score, scoreTick: tick };
        if (score <= 0 || ax.exposureAt(pc.pos, pc.id) > riskThreshold(ax)) {
          ax.act('leavePc');
          st.step = 'leaving';
          st.leaveTick = tick;
          return 'running';
        }
        st.ownerScore = score;
        st.step = 'reading'; // 看清对方积分需要一点时间
        st.until = tick + ax.toTicks(ax.rng.range(600, 1600));
        return 'running';
      }
      case 'reading': {
        if (tick < st.until) return 'running';
        ax.request(st, 'jc.open', { pcId: pc.id });
        st.step = 'opening';
        return 'running';
      }
      case 'opening': {
        const r = ax.poll(st);
        if (r === 'pending') return 'running';
        if (!r.ok) {
          ax.act('leavePc');
          st.step = 'leaving';
          st.leaveTick = tick;
          return 'running';
        }
        st.ownerScore = r.ownerScore ?? st.ownerScore;
        st.step = 'typing'; // 输入用户名与数量
        st.until = tick + ax.toTicks(ax.rng.range(2000, 5000) * (1 - 0.4 * bb.persona.risk));
        return 'running';
      }
      case 'typing': {
        if (tick < st.until) return 'running';
        const score = st.ownerScore;
        const amount = clamp(Math.floor(score * jcFraction(ax)), 1, score);
        ax.request(st, 'jc.commit', { amount });
        st.step = 'committing';
        return 'running';
      }
      case 'committing': {
        const r = ax.poll(st);
        if (r === 'pending') return 'running';
        if (r.ok) {
          bb.lastSeen[target.id] = { ...(bb.lastSeen[target.id] || {}), score: r.ownerScore ?? 0, scoreTick: tick };
          st.success = true;
        }
        ax.act('leavePc');
        st.step = 'leaving';
        st.leaveTick = tick;
        return 'running';
      }
      case 'leaving': {
        if (self.operatingPcId && tick - st.leaveTick < 4) return 'running';
        if (self.operatingPcId) ax.act('leavePc');
        st.flee = st.flee || wanderPoint(ax);
        st.step = 'flee';
        st.fleeUntil = tick + ax.toTicks(9000);
        return 'running';
      }
      case 'flee': {
        const res = navigate(ax, st.flee, 16);
        if (res !== 'moving' || tick > st.fleeUntil) return st.success ? 'done' : 'failed';
        return 'running';
      }
      default:
        return 'failed';
    }
  },
};

// ------------------------------------------------------------ 回自己电脑查看积分（同时获得免疫）

const viewScore = {
  id: 'view_score',
  label: '回电脑查看积分',
  evaluate(ax) {
    const { self, bb, tick, belief, balance } = ax;
    const pc = ax.getPc(self.homePcId);
    const since = self.lastViewedTick == null ? tick : tick - self.lastViewedTick;
    const info = norm(ax.ticksToMs(since), 120000);
    const guard = belief > balance.ai.bands.safe ? 0.35 : 0;
    // 看到有人占着自己的电脑 → 赶回去
    let defend = 0;
    for (const id of Object.keys(bb.lastSeen)) {
      const s = bb.lastSeen[id];
      if (id !== self.id && s.op === pc.id && tick - s.tick < ax.toTicks(5000)) defend = 0.9;
    }
    return {
      terms: { gain: 0.45 * info + guard + defend, cost: norm(dist(self.pos, pc.pos), 1600) + 0.05, risk: 0, persona: (1 - bb.persona.risk) * 0.3 },
      data: { pcId: pc.id },
    };
  },
  start(ax, data) {
    return { step: 'go', pcId: data.pcId, t0: ax.tick, retries: 0 };
  },
  update(ax, st) {
    const { self, bb, tick, balance } = ax;
    const pc = ax.getPc(st.pcId);
    if (tick - st.t0 > ax.toTicks(60000)) return 'failed';
    switch (st.step) {
      case 'go': {
        const res = navigate(ax, pc.pos, 6);
        if (res === 'unreachable') return 'failed';
        if (dist(self.pos, pc.pos) <= balance.interact.radius * 0.6) {
          ax.request(st, 'enterPc', { pcId: pc.id });
          st.step = 'entering';
        }
        return 'running';
      }
      case 'entering': {
        const r = ax.poll(st);
        if (r === 'pending') return 'running';
        if (!r.ok) {
          if (pc.operatorId && pc.operatorId !== self.id) bb.grudge[pc.operatorId] = (bb.grudge[pc.operatorId] ?? 0) + 0.5;
          if (st.retries++ < 2) {
            st.step = 'wait';
            st.until = tick + ax.toTicks(2500);
            return 'running';
          }
          return 'failed';
        }
        ax.request(st, 'viewScore');
        st.step = 'viewing';
        return 'running';
      }
      case 'wait':
        if (tick >= st.until) st.step = 'go';
        return 'running';
      case 'viewing': {
        const r = ax.poll(st);
        if (r === 'pending') return 'running';
        const safe = ax.belief > balance.ai.bands.safe;
        st.until = tick + ax.toTicks(2000 + 6000 * (1 - bb.persona.risk) + (safe ? 8000 : 0));
        st.step = 'hold';
        return 'running';
      }
      case 'hold':
        if (!self.operatingPcId) return 'done';
        if (tick >= st.until) {
          ax.act('leavePc');
          return 'done';
        }
        return 'running';
      default:
        return 'failed';
    }
  },
};

// ------------------------------------------------------------ 增益区

const farmToilet = {
  id: 'farm_toilet',
  label: '去厕所叠加速',
  interruptible: true,
  repeatPenalty: true,
  evaluate(ax) {
    const { self, balance, band, bb } = ax;
    const near = nearestRoom(ax, ROOM_TYPE.TOILET);
    if (!near) return null;
    const lack = norm(balance.toilet.maxStack - self.toiletLevel, balance.toilet.maxStack);
    if (lack < 0.2) return null;
    const want = band === 'danger' ? 1.5 : 1;
    return {
      terms: { gain: 0.32 * lack * want, cost: norm(near.d, 1600) + 0.08, risk: 0, persona: (1 - bb.persona.patience) * 0.25 },
      data: { roomId: near.room.id },
    };
  },
  start(ax, data) {
    const goal = ax.map.randomPointInRoom(data.roomId, ax.rng, 40);
    return { step: 'go', roomId: data.roomId, goal, t0: ax.tick, targetLevel: 3 + Math.round(ax.bb.persona.patience * 2) };
  },
  update(ax, st) {
    const { self, tick } = ax;
    if (tick - st.t0 > ax.toTicks(40000)) return 'done';
    if (st.step === 'go') {
      const res = navigate(ax, st.goal, 10);
      if (res === 'unreachable') return 'failed';
      if (res === 'arrived') st.step = 'stay';
      return 'running';
    }
    ax.stop();
    return self.toiletLevel >= Math.min(ax.balance.toilet.maxStack, st.targetLevel) - 0.01 ? 'done' : 'running';
  },
};

const farmChatroom = {
  id: 'farm_chatroom',
  label: '去聊天室',
  interruptible: true,
  repeatPenalty: true,
  evaluate(ax) {
    const { bb, band, self, balance } = ax;
    if (band === 'danger') return null;
    if (self.attrMul.speed >= balance.chatroom.maxMul - 1e-6) return null;
    const near = nearestRoom(ax, ROOM_TYPE.CHATROOM);
    if (!near) return null;
    return {
      terms: { gain: (band === 'safe' ? 0.32 : 0.16) * (0.5 + bb.persona.social), cost: norm(near.d, 1600) + 0.1, risk: 0, persona: bb.persona.social * 0.4 },
      data: { roomId: near.room.id },
    };
  },
  start(ax, data) {
    return { step: 'go', goal: ax.map.randomPointInRoom(data.roomId, ax.rng, 36), t0: ax.tick, stayMs: ax.rng.range(15000, 40000) };
  },
  update(ax, st) {
    const { tick } = ax;
    if (st.step === 'go') {
      const res = navigate(ax, st.goal, 10);
      if (res === 'unreachable') return 'failed';
      if (res === 'arrived') {
        st.step = 'stay';
        st.until = tick + ax.toTicks(st.stayMs);
      } else if (tick - st.t0 > ax.toTicks(40000)) return 'failed';
      return 'running';
    }
    ax.stop();
    if (ax.rng.next() < 0.004) ax.say('chat');
    return tick >= st.until ? 'done' : 'running';
  },
};

const idleWander = {
  id: 'idle_wander',
  label: '闲逛',
  interruptible: true,
  evaluate(ax) {
    return { terms: { gain: 0.1 + ax.bb.persona.social * 0.05, cost: 0, risk: 0, persona: 0 }, data: null };
  },
  start(ax) {
    return { step: 'go', goal: wanderPoint(ax), t0: ax.tick, idleMs: ax.rng.range(1000, 4000) };
  },
  update(ax, st) {
    const { tick } = ax;
    if (st.step === 'go') {
      const res = navigate(ax, st.goal, 12);
      if (res === 'unreachable') return 'failed';
      if (res === 'arrived' || tick - st.t0 > ax.toTicks(25000)) {
        st.step = 'idle';
        st.until = tick + ax.toTicks(st.idleMs);
        if (ax.rng.next() < 0.15) ax.say('idle');
      }
      return 'running';
    }
    ax.stop();
    return tick >= st.until ? 'done' : 'running';
  },
};

export const STUDENT_BEHAVIORS = [askQuestion, flatter, jcHunt, viewScore, farmToilet, farmChatroom, idleWander];
