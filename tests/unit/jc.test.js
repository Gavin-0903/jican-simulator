import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGame } from '../helpers.js';

/** s1-01 进入 s1-02 的电脑并打开 JC 界面。 */
function atTargetPc(g, targetScore = 200) {
  g.parkTeachers();
  g.ch('s1-02').score = targetScore;
  g.place('s1-01', g.pc('pc-c1-02').pos);
  g.place('s1-02', { x: 960, y: 715 });
  g.act('s1-01', 'enterPc', { pcId: 'pc-c1-02' });
  g.step(1);
  assert.equal(g.ch('s1-01').operatingPcId, 'pc-c1-02');
  g.act('s1-01', 'jc.open', { pcId: 'pc-c1-02' });
  g.step(1);
  assert.equal(g.ch('s1-01').jcOpenPcId, 'pc-c1-02');
}

test('JC 成功：目标 −x、自己 +x，本班任课老师 −20￥', () => {
  const g = makeGame({ player: 's1-01' });
  atTargetPc(g, 200);
  const t1Before = g.ch('t1').score;
  g.commit('s1-01', 's1-01', 120);
  g.step(1);
  assert.equal(g.ch('s1-02').score, 80);
  assert.equal(g.ch('s1-01').score, 120);
  assert.equal(g.ch('t1').score, t1Before - 20);
  assert.equal(g.ch('t2').score, g.balance.teacher.initialSalary); // 别的班老师不受影响
  assert.equal(g.ch('t4').score, g.balance.teacher.initialSalary); // 常驻老师不承担
  assert.ok(g.out.events.some((e) => e.type === 'jc_success' && e.amount === 120));
  assert.ok(g.out.events.some((e) => e.type === 'jc_victim' && e.targetId === 's1-02'));
  const result = g.out.dialogs.find((d) => d.payload.kind === 'jc.result');
  assert.equal(result.payload.caught, false);
});

test('用户名不匹配：不转移积分，进入 1 秒冷却', () => {
  const g = makeGame({ player: 's1-01' });
  atTargetPc(g, 200);
  g.commit('s1-01', 's1-02', 50);
  g.step(1);
  assert.equal(g.ch('s1-02').score, 200);
  assert.ok(g.out.dialogs.some((d) => d.payload.kind === 'jc_blocked' && d.payload.reason === 'username_mismatch'));
  g.commit('s1-01', 's1-01', 50);
  g.step(1);
  assert.equal(g.ch('s1-02').score, 200, '冷却中不能提交');
  g.step(10);
  g.commit('s1-01', 's1-01', 50);
  g.step(1);
  assert.equal(g.ch('s1-02').score, 150);
});

test('数量非法 / 超过目标积分 / 目标积分不为正 均被拒绝', () => {
  const g = makeGame({ player: 's1-01' });
  atTargetPc(g, 100);
  for (const amount of [0, -5, 2.5, null]) {
    g.commit('s1-01', 's1-01', amount);
    g.step(1);
  }
  g.commit('s1-01', 's1-01', 101);
  g.step(1);
  const reasons = g.out.dialogs.filter((d) => d.payload.kind === 'jc_blocked').map((d) => d.payload.reason);
  assert.deepEqual(reasons, ['invalid_amount', 'invalid_amount', 'invalid_amount', 'invalid_amount', 'exceed_target']);
  assert.equal(g.ch('s1-02').score, 100);
  g.ch('s1-02').score = 0;
  g.commit('s1-01', 's1-01', 1);
  g.step(1);
  assert.equal(g.out.dialogs.at(-1).payload.reason, 'exceed_target');
});

test('电脑主人正在操作自己的电脑时免疫', () => {
  const g = makeGame({ player: 's1-01' });
  g.parkTeachers();
  g.act('s1-02', 'enterPc', { pcId: 'pc-c1-02' });
  g.step(1);
  assert.equal(g.pc('pc-c1-02').operatorId, 's1-02');
  g.place('s1-01', { x: 230, y: 906 });
  g.act('s1-01', 'enterPc', { pcId: 'pc-c1-02' });
  g.step(1);
  assert.equal(g.out.errors.at(-1).code, 'E_IMMUNE');
  assert.equal(g.ch('s1-01').operatingPcId, null);
});

test('离电脑太远不能进入', () => {
  const g = makeGame({ player: 's1-01' });
  g.place('s1-01', { x: 960, y: 715 });
  g.act('s1-01', 'enterPc', { pcId: 'pc-c1-02' });
  g.step(1);
  assert.equal(g.out.errors.at(-1).code, 'E_OUTOFRANGE');
});

test('JC 冷却：成功后 20 秒内不能再次打开', () => {
  const g = makeGame({ player: 's1-01' });
  atTargetPc(g, 200);
  g.commit('s1-01', 's1-01', 10);
  g.step(1);
  g.act('s1-01', 'jc.open', { pcId: 'pc-c1-02' });
  g.step(1);
  assert.equal(g.out.dialogs.at(-1).payload.reason, 'cooldown');
});

test('被老师目击：老师 +100￥，执行者扣除相应积分；同一次 JC 只有一位老师领奖', () => {
  const g = makeGame({ player: 's1-01' });
  g.balance.teacher.catchProbabilityLerp = [1, 1];
  atTargetPc(g, 200);
  g.place('t1', { x: 230, y: 830 }, Math.PI / 2); // 站在桌子另一侧面向学生
  g.place('t2', { x: 280, y: 836 }, Math.PI / 2);
  const before = { t1: g.ch('t1').score, t2: g.ch('t2').score };
  g.commit('s1-01', 's1-01', 120);
  g.step(1);
  const catches = g.out.events.filter((e) => e.type === 'teacher_catch');
  assert.equal(catches.length, 1);
  assert.equal(catches[0].penalty, 120);
  assert.equal(g.ch('s1-01').score, 0); // +120 −120
  const rewarded = ['t1', 't2'].filter((id) => g.ch(id).stats.catches === 1);
  assert.equal(rewarded.length, 1);
  const w = rewarded[0];
  assert.equal(g.ch(w).score, before[w] + 100 - (w === 't1' ? 20 : 0)); // t1 还要承担本班 −20
  assert.equal(g.ch('s1-01').operatingPcId, null, '被抓后赶离电脑');
  assert.equal(g.out.dialogs.find((d) => d.payload.kind === 'jc.result').payload.caught, true);
});

test('墙体挡住老师视线时不会被目击', () => {
  const g = makeGame({ player: 's1-01' });
  g.balance.teacher.catchProbabilityLerp = [1, 1];
  atTargetPc(g, 200);
  g.place('t1', { x: 230, y: 1040 }, -Math.PI / 2); // 教室南墙外
  g.commit('s1-01', 's1-01', 50);
  g.step(1);
  assert.equal(g.out.events.filter((e) => e.type === 'teacher_catch').length, 0);
});

test('老师背对时不会被目击（扇形之外）', () => {
  const g = makeGame({ player: 's1-01' });
  g.balance.teacher.catchProbabilityLerp = [1, 1];
  atTargetPc(g, 200);
  g.place('t1', { x: 230, y: 830 }, -Math.PI / 2);
  g.commit('s1-01', 's1-01', 50);
  g.step(1);
  assert.equal(g.out.events.filter((e) => e.type === 'teacher_catch').length, 0);
});

