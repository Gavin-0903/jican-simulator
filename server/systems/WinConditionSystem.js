// 结算系统：回合时间到 / 有学生达到目标积分 / 人类玩家失败 → 结束并生成排名。

import { AUDIENCE, END_REASON, END_REASON_TEXT, EVENT, PHASE, STATUS } from '../../shared/constants.js';
import { isStudent, isTeacher } from '../core/GameState.js';

const statusOrder = (c) => (c.status === STATUS.ACTIVE ? 0 : 1);

export function computeRanking(state) {
  const entry = (c, i) => ({
    rank: i + 1,
    id: c.id,
    name: c.name,
    username: c.username,
    title: c.title,
    role: c.role,
    classId: c.classId,
    score: c.score,
    status: c.status,
    control: c.control,
    stats: { ...c.stats },
  });
  const byScore = (a, b) => statusOrder(a) - statusOrder(b) || b.score - a.score || (a.id < b.id ? -1 : 1);
  return {
    students: state.characters.filter(isStudent).sort(byScore).map(entry),
    teachers: state.characters.filter(isTeacher).sort(byScore).map(entry),
  };
}

export function endRound(state, ctx, reason, winnerId = null) {
  if (state.phase === PHASE.ENDED) return;
  state.phase = PHASE.ENDED;
  state.pausedReason = null;
  state.result = { reason, winnerId, endedTick: state.tick, endedMs: state.elapsedMs };
  state.ranking = computeRanking(state);
  ctx?.emit({ type: EVENT.ROUND_END, reason, actorId: winnerId, text: END_REASON_TEXT[reason], audience: [AUDIENCE.ALL] });
}

export class WinConditionSystem {
  update(state, ctx) {
    if (state.phase !== PHASE.PLAYING) return;
    if (state.result) return endRound(state, ctx, state.result.reason, state.result.winnerId);
    if (state.targetScore > 0) {
      let winner = null;
      for (const c of state.characters) {
        if (isStudent(c) && c.status === STATUS.ACTIVE && c.score >= state.targetScore && (!winner || c.score > winner.score)) winner = c;
      }
      if (winner) return endRound(state, ctx, END_REASON.TARGET_REACHED, winner.id);
    }
    if (state.elapsedMs >= state.roundMs) endRound(state, ctx, END_REASON.TIME_UP);
  }
}
