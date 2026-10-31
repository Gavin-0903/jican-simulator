// 规则 AI 调度器：感知 → 黑板 → 效用评分 → 行为选择与执行 → 意图指令。
// 产出的意图与玩家 WS 输入同构（{charId, type, payload}），写入 state.inputQueue，下个 tick 统一消费。

import { CONTROL, ROLE, STATUS } from '../../shared/constants.js';
import { dist, sightClear, bodyVisible, inFan, catchProbability, degToRad, round2 } from '../../shared/math.js';
import { believedScore, getChar, getPc, isStudent, isTeacher } from '../core/GameState.js';
import { teacherSees } from '../systems/VisionSystem.js';
import { createBlackboard, decayBlackboard } from './Blackboard.js';
import { scoreUtility, softmaxSelect } from './UtilityScorer.js';
import { clearNav } from './Navigator.js';
import { STUDENT_BEHAVIORS } from './student.behavior.js';
import { TEACHER_BEHAVIORS } from './teacher.behavior.js';

const byId = (list) => Object.fromEntries(list.map((b) => [b.id, b]));
const STUDENT_LIB = byId(STUDENT_BEHAVIORS);
const TEACHER_LIB = byId(TEACHER_BEHAVIORS);
const INTERRUPT_MARGIN = 0.3;

export class RuleAIEngine {
  update(state, ctx) {
    const decisionTicks = Math.max(1, ctx.toTicks(ctx.balance.ai.decisionMs));
    const decayTicks = Math.max(1, ctx.toTicks(ctx.balance.ai.blackboardDecayMs));
    for (const c of state.characters) {
      if (c.control !== CONTROL.AI || c.status !== STATUS.ACTIVE) continue;
      const rng = ctx.rngOf(c);
      if (!c.ai) c.ai = createBlackboard(c, rng, ctx.balance, state.tick, ctx.stepMs);
      const bb = c.ai;
      if (state.tick < bb.wakeTick) continue;
      const ax = this.makeContext(state, ctx, c, rng);
      const slot = (state.tick + bb.phase) % decisionTicks === 0;
      if (slot) this.perceive(ax);
      if ((state.tick + bb.phase) % decayTicks === 0) decayBlackboard(bb, ctx.balance.ai.suspicion.decay);

      if (slot) {
        const cur = bb.behavior;
        const curDef = cur && this.lib(c)[cur.id];
        if (!cur || curDef?.interruptible) {
          const best = this.choose(ax, cur?.id ?? null);
          if (best && (!cur || best.utility > cur.utility + INTERRUPT_MARGIN)) {
            if (cur) this.finish(ax, cur, 'aborted');
            bb.behavior = { id: best.id, st: best.def.start(ax, best.data), utility: best.utility, startedTick: state.tick };
            c.activity = best.def.label;
          }
        }
      }

      const cur = bb.behavior;
      if (!cur) {
        ax.stop();
        continue;
      }
      const def = this.lib(c)[cur.id];
      let res;
      try {
        res = def.update(ax, cur.st);
      } catch (err) {
        ctx.log?.warn?.(`[ai] ${c.id} 行为 ${cur.id} 异常：${err.message}`);
        res = 'failed';
      }
      if (res !== 'running') this.finish(ax, cur, res);
    }
  }

  lib(c) {
    return c.role === ROLE.STUDENT ? STUDENT_LIB : TEACHER_LIB;
  }

  choose(ax, currentId) {
    const { self, bb, balance } = ax;
    const student = isStudent(self);
    const base = student ? balance.ai.weights.student : balance.ai.weights.teacher;
    const w = student && ax.band === 'danger' ? { ...base, risk: base.riskDanger ?? base.risk } : base;
    const lib = student ? STUDENT_BEHAVIORS : TEACHER_BEHAVIORS;
    const cands = [];
    for (const def of lib) {
      if (def.id === currentId) continue;
      if ((bb.behaviorCooldowns[def.id] ?? 0) > ax.tick) continue;
      const ev = def.evaluate(ax);
      if (!ev) continue;
      const terms = { ...ev.terms, cooldown: def.repeatPenalty && bb.lastBehaviorId === def.id ? 1 : 0 };
      cands.push({ id: def.id, def, data: ev.data, utility: scoreUtility(terms, w) + (bb.moodBias ?? 0) * (def.aggressive ? 1 : 0) });
    }
    return softmaxSelect(cands, bb.tau, ax.rng);
  }

  finish(ax, cur, result) {
    const { self, bb, balance, tick } = ax;
    const def = this.lib(self)[cur.id];
    def?.abort?.(ax, cur.st, result);
    if (result !== 'done') {
      if (self.operatingPcId) ax.act('leavePc');
      if (self.asking) ax.act('cancelAsk');
    }
    const cfgMs = balance.ai.behaviorCooldownMs[cur.id] ?? 0;
    const ms = result === 'done' ? cfgMs : Math.max(3000, Math.min(cfgMs, 8000));
    if (ms > 0) bb.behaviorCooldowns[cur.id] = tick + ax.toTicks(ms);
    bb.lastBehaviorId = cur.id;
    bb.behavior = null;
    clearNav(bb);
    ax.stop();
  }

  // ------------------------------------------------------------ 感知

  perceive(ax) {
    const { self: c, bb, state, map, balance, tick } = ax;
    const R = balance.vision.viewRadius * c.attrMul.vision;
    const teacherMode = isTeacher(c);
    const sus = balance.ai.suspicion;
    const dtSec = Math.min(1, ax.ticksToMs(tick - bb.lastPerceiveTick) / 1000);
    for (const o of state.characters) {
      if (o.id === c.id || o.status !== STATUS.ACTIVE) continue;
      const d = dist(c.pos, o.pos);
      if (d > R || !bodyVisible(c.pos, o.pos, map.occ, balance.move.radius * 0.7, o.operatingPcId)) continue;
      // 学生不是监控摄像头：远处的老师有一定概率没注意到
      if (!teacherMode && isTeacher(o) && d > 140 && ax.rng.next() > 0.65) continue;
      const prev = bb.lastSeen[o.id];
      bb.lastSeen[o.id] = {
        x: Math.round(o.pos.x), y: Math.round(o.pos.y), facing: round2(o.facing), tick, op: o.operatingPcId,
        score: prev?.score ?? null, scoreTick: prev?.scoreTick ?? null,
      };
      if (teacherMode && isStudent(o) && teacherSees(c, o, balance, map).inside) {
        const favor = c.favor[o.id] ?? balance.flatter.favorInit;
        const k = 1 - 0.5 * favor; // 好感度降低怀疑度
        if (o.operatingPcId && o.operatingPcId !== o.homePcId) {
          bb.suspicion[o.id] = (bb.suspicion[o.id] ?? 0) + sus.trespassPerSec * dtSec * k;
        } else if (!o.operatingPcId && this.lingersAtForeignPc(state, o)) {
          bb.suspicion[o.id] = (bb.suspicion[o.id] ?? 0) + sus.lingerPerSec * dtSec * k;
        }
      }
    }
    for (const jc of state.recentJc) {
      if (jc.tick <= bb.lastPerceiveTick) continue;
      if (dist(c.pos, jc.pos) > R || !sightClear(c.pos, jc.pos, map.occ, jc.pcId)) continue;
      if (teacherMode) bb.suspicion[jc.actorId] = (bb.suspicion[jc.actorId] ?? 0) + sus.heardJc;
      else if (jc.targetId === c.id) bb.grudge[jc.actorId] = (bb.grudge[jc.actorId] ?? 0) + 1;
    }
    for (const ev of bb.events) {
      if (ev.type === 'flatter_fail') bb.suspicion[ev.charId] = (bb.suspicion[ev.charId] ?? 0) + 0.15;
      else if (ev.type === 'caught') delete bb.suspicion[ev.charId];
    }
    bb.events = [];
    bb.lastPerceiveTick = tick;
  }

  lingersAtForeignPc(state, o) {
    for (const pc of state.pcs) {
      if (pc.ownerRole === 'student' && pc.id !== o.homePcId && dist(pc.pos, o.pos) <= 36) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ 行为上下文

  makeContext(state, ctx, c, rng) {
    const engine = this;
    const { balance, map } = ctx;
    const bb = c.ai;
    const belief = isStudent(c) ? believedScore(c, balance.student.initialScore) : c.score;
    const bands = balance.ai.bands;
    const band = belief > bands.safe ? 'safe' : belief <= bands.danger ? 'danger' : 'balanced';
    const push = (type, payload) => state.inputQueue.push({ charId: c.id, type, payload });
    const ax = {
      state, self: c, bb, map, balance, app: ctx.app, rng,
      tick: state.tick,
      stepMs: ctx.stepMs,
      toTicks: ctx.toTicks,
      ticksToMs: ctx.ticksToMs,
      repathTicks: Math.max(1, ctx.toTicks(balance.ai.repathMs)),
      belief,
      band,
      getChar: (id) => getChar(state, id),
      getPc: (id) => getPc(state, id),
      move(dir, face = null) {
        const dx = round2(dir.x);
        const dy = round2(dir.y);
        const f = face === null ? null : round2(face);
        if (dx === bb.lastDir.x && dy === bb.lastDir.y && f === bb.lastFace) return;
        bb.lastDir = { x: dx, y: dy };
        bb.lastFace = f;
        const payload = { dir: { x: dx, y: dy } };
        if (f !== null) payload.face = f;
        push('move', payload);
      },
      stop(face = null) {
        ax.move({ x: 0, y: 0 }, face);
      },
      face(angle) {
        ax.move({ x: 0, y: 0 }, angle);
      },
      act(kind, extra = {}) {
        push('action', { kind, ...extra });
      },
      commitJc(amount) {
        push('jc.commit', { selfUsername: c.username, amount });
      },
      /** 发出动作并在 st 上记录等待；用 poll() 读取结果。 */
      request(st, kind, extra = {}) {
        if (kind === 'jc.commit') ax.commitJc(extra.amount);
        else ax.act(kind, extra);
        st.wait = { kind, tick: state.tick };
      },
      poll(st) {
        if (!st.wait) return null;
        const r = c.lastResult;
        if (r && r.kind === st.wait.kind && r.tick > st.wait.tick) {
          st.wait = null;
          return r;
        }
        if (state.tick - st.wait.tick > 15) {
          const kind = st.wait.kind;
          st.wait = null;
          return { ok: false, timeout: true, kind };
        }
        return 'pending';
      },
      say: (kind, vars) => ctx.say(c, kind, vars),
      perceive: () => engine.perceive(ax),
      canSee(p) {
        return dist(c.pos, p) <= balance.vision.viewRadius * c.attrMul.vision && sightClear(c.pos, p, map.occ);
      },
      /** 学生视角：在 p 处被老师目击的估计概率（只用自己看到/记得的老师信息）。 */
      exposureAt(p, skipPcId = null) {
        const R = balance.teacher.visionRadius;
        const half = degToRad(balance.teacher.visionHalfAngleDeg);
        const memoryTicks = ctx.toTicks(10000);
        let risk = 0;
        for (const t of state.characters) {
          if (!isTeacher(t) || t.status !== STATUS.ACTIVE) continue;
          const seen = bb.lastSeen[t.id];
          if (!seen || state.tick - seen.tick > memoryTicks) continue;
          const d = dist(seen, p);
          if (d > R + 140) continue;
          const los = sightClear(seen, p, map.occ, skipPcId);
          let r;
          if (los && inFan(seen, seen.facing, p, R, half).inside) r = catchProbability(d, R);
          else if (los && d <= R) r = 0.3; // 老师随时可能转身
          else if (d <= R) r = 0.08;
          else r = 0.04;
          if (state.tick - seen.tick > ctx.toTicks(1500)) r *= 0.6;
          risk = 1 - (1 - risk) * (1 - r);
        }
        return risk;
      },
    };
    return ax;
  }
}

