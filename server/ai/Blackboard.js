// AI 黑板：每个 AI 角色的私有记忆（纯 JSON，随存档保存）。

import { lerp } from '../../shared/math.js';
import { hashString } from '../core/Rng.js';

export function createBlackboard(c, rng, balance, tick = 0, stepMs = 100) {
  const [tmin, tmax] = balance.ai.tauRange;
  const [w0, w1] = balance.ai.wakeDelayMs ?? [0, 0];
  return {
    // 开局错峰：每个 AI 先在原地待一会儿，避免所有人同时冲向办公室
    wakeTick: tick + Math.round(rng.range(w0, w1) / stepMs),
    persona: { risk: rng.next(), patience: rng.next(), social: rng.next() },
    tau: lerp(tmin, tmax, rng.next()),
    suspicion: {}, // 老师用：charId → 怀疑度
    grudge: {}, // charId → 仇恨（被其 JC 过）
    lastSeen: {}, // charId → { x, y, facing, tick, op, score?, scoreTick? }
    targetCache: null,
    behavior: null, // { id, st, utility, startedTick }
    lastBehaviorId: null,
    behaviorCooldowns: {}, // behaviorId → untilTick
    nav: { goal: null, path: [], idx: 0, lastRepath: -999, stuck: 0, lastPos: { x: c.pos.x, y: c.pos.y } },
    lastDir: { x: 0, y: 0 },
    lastFace: null,
    phase: hashString(c.id) % 5,
    lastPerceiveTick: 0,
    patrolIdx: 0,
    events: [], // 系统通知（如讨好失败、抓到人）
  };
}

/** 周期衰减：怀疑度、仇恨随时间淡化。 */
export function decayBlackboard(bb, factor) {
  for (const map of [bb.suspicion, bb.grudge]) {
    for (const k of Object.keys(map)) {
      map[k] *= factor;
      if (map[k] < 0.05) delete map[k];
    }
  }
}

export function topEntry(map) {
  let bestK = null;
  let bestV = -Infinity;
  for (const k of Object.keys(map).sort()) {
    if (map[k] > bestV) {
      bestV = map[k];
      bestK = k;
    }
  }
  return bestK ? { id: bestK, value: bestV } : null;
}
