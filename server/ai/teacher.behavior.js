// 老师 AI 行为库：巡逻（任课老师）、办公室值守（常驻老师）、追查可疑学生、抽查电脑。

import { STATUS } from '../../shared/constants.js';
import { dist, angleTo, degToRad, clamp } from '../../shared/math.js';
import { isActive, isStudent } from '../core/GameState.js';
import { norm } from './UtilityScorer.js';
import { navigate } from './Navigator.js';
import { topEntry } from './Blackboard.js';

const isResident = (t) => t.classId == null;

// ------------------------------------------------------------ 巡逻

const patrol = {
  id: 'patrol',
  label: '巡逻',
  interruptible: true,
  evaluate(ax) {
    if (isResident(ax.self)) return null;
    return { terms: { gain: 0.5, cost: 0, risk: 0, persona: 0 }, data: null };
  },
  start(ax) {
    return { step: 'walk', t0: ax.tick };
  },
  update(ax, st) {
    const { self, bb, map, tick } = ax;
    const route = map.anchors.patrol?.[self.id] ?? (map.anchors.wander || []).map((p) => ({ ...p, dwellMs: [1000, 3000], look: 90 }));
    if (!route.length) return 'failed';
    const wp = route[bb.patrolIdx % route.length];
    if (st.step === 'walk') {
      const res = navigate(ax, wp, 10);
      if (res === 'unreachable' || tick - st.t0 > ax.toTicks(40000)) {
        bb.patrolIdx++;
        return 'failed';
      }
      if (res === 'arrived') {
        const [a, b] = wp.dwellMs || [1000, 2500];
        st.step = 'dwell';
        st.until = tick + ax.toTicks(ax.rng.range(a, b));
        st.look = degToRad(wp.look ?? 90);
        st.phase = ax.rng.range(0, Math.PI * 2);
        if (ax.rng.next() < 0.08) ax.say('patrol');
      }
      return 'running';
    }
    // 停留时左右扫视（约 ±50°），让「挑时机」成为可能
    ax.face(st.look + 0.9 * Math.sin(st.phase + (tick - st.t0) / 6));
    if (tick >= st.until) {
      bb.patrolIdx++;
      return 'done';
    }
    return 'running';
  },
};

// ------------------------------------------------------------ 办公室值守

const officeDuty = {
  id: 'office_duty',
  label: '办公室值守',
  interruptible: true,
  evaluate(ax) {
    if (!isResident(ax.self)) return null;
    return { terms: { gain: 0.5, cost: 0, risk: 0, persona: 0 }, data: null };
  },
  start(ax) {
    return { step: 'post', t0: ax.tick, strollAt: ax.tick + ax.toTicks(ax.rng.range(12000, 30000)) };
  },
  update(ax, st) {
    const { self, state, map, tick } = ax;
    const post = map.anchors.teacherPosts?.[self.id] ?? self.pos;
    const askers = state.characters.filter((s) => s.asking?.teacherId === self.id);
    if (askers.length) {
      ax.face(angleTo(self.pos, askers[0].pos));
      return tick - st.t0 > ax.toTicks(6000) ? 'done' : 'running';
    }
    if (st.step === 'stroll') {
      const res = navigate(ax, st.goal, 10);
      if (res !== 'moving') {
        st.step = 'linger';
        st.until = tick + ax.toTicks(ax.rng.range(2000, 4000));
      }
      return 'running';
    }
    if (st.step === 'linger') {
      ax.face(Math.PI / 2 + 0.8 * Math.sin(tick / 9));
      if (tick >= st.until) st.step = 'post';
      return 'running';
    }
    if (dist(self.pos, post) > 10) {
      const res = navigate(ax, post, 6);
      return res === 'unreachable' ? 'failed' : 'running';
    }
    ax.face(Math.PI / 2 + 0.8 * Math.sin(tick / 10));
    if (tick >= st.strollAt) {
      const room = map.roomAt(post);
      st.goal = room ? map.randomPointInRoom(room.id, ax.rng, 40) : post;
      st.step = 'stroll';
      st.strollAt = tick + ax.toTicks(ax.rng.range(15000, 35000));
      return 'running';
    }
    return tick - st.t0 > ax.toTicks(6000) ? 'done' : 'running';
  },
};

// ------------------------------------------------------------ 追查可疑学生

const chaseSuspect = {
  id: 'chase_suspect',
  label: '追查可疑学生',
  evaluate(ax) {
    const { self, bb, balance } = ax;
    if (isResident(self)) return null;
    const top = topEntry(bb.suspicion);
    if (!top || top.value < balance.ai.suspicion.chaseThreshold) return null;
    const s = ax.getChar(top.id);
    if (!isActive(s)) {
      delete bb.suspicion[top.id];
      return null;
    }
    const seen = bb.lastSeen[top.id];
    const d = seen ? dist(self.pos, seen) : 800;
    return {
      terms: { gain: 0.7 + 0.6 * clamp(top.value, 0, 1), cost: norm(d, 1600), risk: 0, persona: 0 },
      data: { suspectId: top.id },
    };
  },
  start(ax, data) {
    return { step: 'chase', suspectId: data.suspectId, t0: ax.tick };
  },
  update(ax, st) {
    const { self, bb, balance, tick } = ax;
    const s = ax.getChar(st.suspectId);
    if (!s || s.status !== STATUS.ACTIVE) return 'done';
    if (st.step === 'inspect') {
      const r = ax.poll(st);
      if (r === 'pending') return 'running';
      delete bb.suspicion[s.id];
      return 'done';
    }
    if (tick - st.t0 > ax.toTicks(18000)) {
      bb.suspicion[s.id] = (bb.suspicion[s.id] ?? 0) * 0.4;
      return 'done';
    }
    const visible = ax.canSee(s.pos);
    const seen = bb.lastSeen[s.id];
    const goal = visible ? s.pos : seen ?? s.pos;
    const R = balance.teacher.inspectRadius;
    if (visible && dist(self.pos, s.pos) <= R * 0.9) {
      const pc = s.operatingPcId ? ax.getPc(s.operatingPcId) : null;
      if (pc && pc.ownerCharId !== s.id && dist(self.pos, pc.pos) <= R) {
        ax.face(angleTo(self.pos, s.pos));
        ax.request(st, 'inspectPc', { pcId: pc.id });
        st.step = 'inspect';
        return 'running';
      }
      if (!pc) {
        ax.say('warn', { student: s.name });
        bb.suspicion[s.id] = (bb.suspicion[s.id] ?? 0) * 0.3;
        return 'done';
      }
    }
    const res = navigate(ax, goal, R * 0.5);
    if (res === 'unreachable') return 'failed';
    if (res === 'arrived' && !visible) {
      bb.suspicion[s.id] = (bb.suspicion[s.id] ?? 0) * 0.5;
      return 'done';
    }
    return 'running';
  },
};

// ------------------------------------------------------------ 抽查电脑

const inspectPc = {
  id: 'inspect_pc',
  label: '抽查电脑',
  evaluate(ax) {
    const { self, state, bb, tick } = ax;
    if (isResident(self)) return null;
    let best = null;
    for (const s of state.characters) {
      if (!isStudent(s) || s.status !== STATUS.ACTIVE) continue;
      const seen = bb.lastSeen[s.id];
      if (!seen?.op || tick - seen.tick > ax.toTicks(3000)) continue;
      const d = dist(self.pos, seen);
      if (d > 360) continue;
      if (!best || d < best.d) best = { d, pcId: seen.op };
    }
    if (!best) return null;
    return { terms: { gain: 0.42, cost: norm(best.d, 1600), risk: 0, persona: 0 }, data: { pcId: best.pcId } };
  },
  start(ax, data) {
    return { step: 'go', pcId: data.pcId, t0: ax.tick };
  },
  update(ax, st) {
    const { self, balance, tick } = ax;
    const pc = ax.getPc(st.pcId);
    if (!pc || tick - st.t0 > ax.toTicks(15000)) return 'failed';
    if (st.step === 'go') {
      if (!pc.operatorId) return 'done';
      const res = navigate(ax, pc.pos, balance.teacher.inspectRadius * 0.6);
      if (res === 'unreachable') return 'failed';
      if (dist(self.pos, pc.pos) <= balance.teacher.inspectRadius * 0.9) {
        ax.request(st, 'inspectPc', { pcId: pc.id });
        st.step = 'wait';
      }
      return 'running';
    }
    const r = ax.poll(st);
    return r === 'pending' ? 'running' : 'done';
  },
};

export const TEACHER_BEHAVIORS = [patrol, officeDuty, chaseSuspect, inspectPc];
