// 积分与工资系统：班级连带扣薪、目击奖惩、JC 结果回执、学生淘汰与人类老师失败判定。

import { AUDIENCE, CONTROL, END_REASON, EVENT, STATUS } from '../../shared/constants.js';
import { getChar, isActive, isStudent, isTeacher, releasePc } from '../core/GameState.js';

export class ScoreSystem {
  update(state, ctx) {
    const { balance } = ctx;
    const { pendingJc, pendingCatches } = ctx.frame;

    // 本班学生被 JC：该班任课老师 −20￥（办公室常驻老师 classId = null，不承担）
    for (const jc of pendingJc) {
      const victim = getChar(state, jc.targetId);
      if (!victim) continue;
      for (const t of state.characters) {
        if (!isTeacher(t) || t.classId == null || t.classId !== victim.classId || t.status !== STATUS.ACTIVE) continue;
        t.score -= balance.teacher.classLosePenalty;
        ctx.emit({
          type: EVENT.SALARY_CHANGED, actorId: t.id, targetId: victim.id, amount: -balance.teacher.classLosePenalty, reason: 'class_jc',
          text: `本班学生 ${victim.name} 被 JC，工资 -${balance.teacher.classLosePenalty}￥`, audience: [AUDIENCE.ACTOR],
        });
      }
    }

    // 目击 / 检查抓获：老师 +100￥，学生扣分（JC 扣相应积分，擅自操作他人电脑扣固定值）
    const caughtJc = new Map();
    for (const k of pendingCatches) {
      const teacher = getChar(state, k.teacherId);
      const student = getChar(state, k.charId);
      if (!teacher || !isActive(student)) continue;
      const penalty = k.reason === 'jc' ? Math.round(k.amount * balance.jc.caughtPenaltyMul) : balance.jc.trespassPenalty;
      student.score -= penalty;
      student.knownDelta -= penalty;
      student.stats.caught += 1;
      teacher.score += balance.teacher.catchReward;
      teacher.stats.catches += 1;
      state.stats.catches += 1;
      if (student.operatingPcId) {
        releasePc(state, student);
        ctx.dialog(student, { kind: 'close', reason: 'caught', message: `被${teacher.name}抓到，赶离电脑` });
      }
      if (k.reason === 'jc') caughtJc.set(student.id, { teacher, penalty });
      else student.lastResult = { kind: 'caught', ok: false, reason: k.reason, penalty, tick: state.tick };
      ctx.emit({
        type: EVENT.TEACHER_CATCH, actorId: teacher.id, targetId: student.id, amount: balance.teacher.catchReward, penalty, reason: k.reason,
        pos: { ...student.pos },
        text: k.reason === 'jc'
          ? `${teacher.name} 目击 ${student.name} JC！工资 +${balance.teacher.catchReward}￥，${student.name} -${penalty} 分`
          : `${teacher.name} 抓到 ${student.name} 擅自使用他人电脑！工资 +${balance.teacher.catchReward}￥，${student.name} -${penalty} 分`,
        audience: [AUDIENCE.ALL],
      });
      ctx.say(teacher, 'catch', { student: student.name });
      ctx.say(student, 'caught', { teacher: teacher.name });
      ctx.notifyAi(teacher, 'caught', { charId: student.id });
    }

    // JC 结果回执（目击判定完成后才知道是否暴露）
    for (const jc of pendingJc) {
      const actor = getChar(state, jc.actorId);
      const target = getChar(state, jc.targetId);
      if (!actor) continue;
      const c = caughtJc.get(actor.id);
      if (c) actor.lastResult = { kind: 'jc.commit', ok: true, amount: jc.amount, caught: true, penalty: c.penalty, tick: state.tick };
      ctx.dialog(actor, {
        kind: 'jc.result', ok: true, amount: jc.amount, targetName: target?.name, ownerScore: target?.score ?? null,
        caught: !!c, teacherName: c?.teacher.name ?? null, penalty: c?.penalty ?? 0,
      });
    }

    // 淘汰与失败
    for (const c of state.characters) {
      if (c.status !== STATUS.ACTIVE) continue;
      if (isStudent(c) && c.score <= balance.student.failScore) {
        c.status = STATUS.ELIMINATED;
        releasePc(state, c);
        c.asking = null;
        c.opLock = null;
        c.inputDir = { x: 0, y: 0 };
        c.vel = { x: 0, y: 0 };
        state.stats.eliminations += 1;
        ctx.dialog(c, { kind: 'close', reason: 'eliminated' });
        ctx.emit({ type: EVENT.ELIMINATED, actorId: c.id, amount: c.score, pos: { ...c.pos }, text: `${c.name} 积分跌破 ${balance.student.failScore}，退出本局`, audience: [AUDIENCE.ALL] });
        if (c.control === CONTROL.HUMAN) state.result ??= { reason: END_REASON.PLAYER_ELIMINATED, winnerId: null };
      } else if (isTeacher(c) && c.control === CONTROL.HUMAN && c.score < 0) {
        // AI 老师无敌：工资可为负但不判失败
        c.status = STATUS.FAILED;
        releasePc(state, c);
        ctx.emit({ type: EVENT.FAILED, actorId: c.id, amount: c.score, text: `${c.name} 工资跌破 0，任教失败`, audience: [AUDIENCE.ALL] });
        state.result ??= { reason: END_REASON.PLAYER_FAILED, winnerId: null };
      }
    }
  }
}
