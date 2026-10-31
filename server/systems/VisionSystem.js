// 视野系统：本帧发生的 JC 是否被老师目击。纯几何 + 概率（仅推进老师自己的随机子流）。
// 判定：扇形（半径 × 视野倍率、半张角）→ 遮挡（墙体/桌子等遮挡物）→ 距离线性衰减的命中概率。

import { STATUS } from '../../shared/constants.js';
import { inFan, bodyVisible, degToRad, catchProbability, dist } from '../../shared/math.js';
import { getChar, isTeacher } from '../core/GameState.js';

/** 老师 teacher 是否能看见角色 target（扇形 + 无遮挡；目标正在用的电脑桌不挡他本人）。 */
export function teacherSees(teacher, target, balance, map) {
  const radius = balance.teacher.visionRadius * teacher.attrMul.vision;
  const fan = inFan(teacher.pos, teacher.facing, target.pos, radius, degToRad(balance.teacher.visionHalfAngleDeg));
  if (!fan.inside) return { inside: false, d: fan.d, radius };
  if (!bodyVisible(teacher.pos, target.pos, map.occ, balance.move.radius * 0.7, target.operatingPcId)) {
    return { inside: false, blocked: true, d: fan.d, radius };
  }
  return { inside: true, d: fan.d, radius };
}

export class VisionSystem {
  update(state, ctx) {
    const { balance, map } = ctx;
    const [near, far] = balance.teacher.catchProbabilityLerp;
    for (const jc of ctx.frame.pendingJc) {
      const actor = getChar(state, jc.actorId);
      if (!actor) continue;
      const teachers = state.characters
        .filter((t) => isTeacher(t) && t.status === STATUS.ACTIVE)
        .map((t) => ({ t, d: dist(t.pos, actor.pos) }))
        .sort((a, b) => a.d - b.d || (a.t.id < b.t.id ? -1 : 1));
      for (const { t } of teachers) {
        const seen = teacherSees(t, actor, balance, map);
        if (!seen.inside) continue;
        const p = catchProbability(seen.d, seen.radius, near, far);
        if (ctx.rngOf(t).next() < p) {
          // 同一次 JC 最多一位老师获得目击奖励
          ctx.frame.pendingCatches.push({ teacherId: t.id, charId: actor.id, reason: 'jc', amount: jc.amount, pcId: jc.pcId, p });
          break;
        }
      }
    }
  }
}
