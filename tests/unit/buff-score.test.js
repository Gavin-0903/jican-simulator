import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGame } from '../helpers.js';

test('厕所：每停留 3 秒 +10% 速度，最多 5 层；离开后按 15 秒半衰期衰减', () => {
  const g = makeGame({ player: 's1-01' });
  g.place('s1-01', { x: 230, y: 200 });
  g.step(29);
  assert.equal(g.ch('s1-01').toiletLevel, 0);
  g.step(1);
  assert.equal(g.ch('s1-01').toiletLevel, 1);
  assert.ok(Math.abs(g.ch('s1-01').speedMul - 1.1) < 1e-9);
  g.step(200);
  assert.equal(g.ch('s1-01').toiletLevel, 5);
  assert.ok(Math.abs(g.ch('s1-01').speedMul - 1.5) < 1e-9);
  assert.equal(g.out.events.filter((e) => e.type === 'buff_gained').length, 5);
  g.place('s1-01', { x: 960, y: 715 });
  g.step(150);
  assert.ok(Math.abs(g.ch('s1-01').toiletLevel - 2.5) < 0.05, String(g.ch('s1-01').toiletLevel));
});

test('厕所计时必须连续：中途离开清零', () => {
  const g = makeGame({ player: 's1-01' });
  g.place('s1-01', { x: 230, y: 200 });
  g.step(20);
  g.place('s1-01', { x: 960, y: 715 });
  g.step(1);
  g.place('s1-01', { x: 230, y: 200 });
  g.step(20);
  assert.equal(g.ch('s1-01').toiletLevel, 0);
});

test('聊天室：全属性按秒 +0.01%，离开后保留，上限 1.10', () => {
  const g = makeGame({ player: 's1-01' });
  g.place('s1-01', { x: 1500, y: 470 });
  g.step(10);
  const m = g.ch('s1-01').attrMul;
  for (const k of ['speed', 'vision', 'interact', 'scoreGain']) assert.ok(Math.abs(m[k] - 1.0001) < 1e-7, `${k} ${m[k]}`);
  g.place('s1-01', { x: 960, y: 715 });
  g.step(50);
  assert.ok(Math.abs(g.ch('s1-01').attrMul.speed - 1.0001) < 1e-7);
  g.ch('s1-01').attrMul.speed = 1.09999;
  g.place('s1-01', { x: 1500, y: 470 });
  g.step(100);
  assert.equal(g.ch('s1-01').attrMul.speed, 1.1);
});

test('学生积分 ≤ −1000 被淘汰；玩家被淘汰则本局结束', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-05').score = -1000;
  g.step(1);
  assert.equal(g.ch('s1-05').status, 'eliminated');
  assert.equal(g.state.phase, 'PLAYING');
  g.ch('s1-01').score = -1200;
  g.step(1);
  assert.equal(g.state.phase, 'ENDED');
  assert.equal(g.state.result.reason, 'player_eliminated');
  assert.equal(g.state.ranking.students.at(-1).status, 'eliminated');
});

test('人类老师工资 < 0 失败；AI 老师工资为负仍继续', () => {
  const g = makeGame({ player: 't1' });
  g.ch('t2').score = -500;
  g.step(1);
  assert.equal(g.ch('t2').status, 'active');
  g.ch('t1').score = -1;
  g.step(1);
  assert.equal(g.ch('t1').status, 'failed');
  assert.equal(g.state.result.reason, 'player_failed');
  assert.equal(g.state.phase, 'ENDED');
});

test('学生率先达到目标积分立即获胜；时间到按排名结算', () => {
  const g = makeGame({ player: 's1-01' });
  // makeGame 默认把 targetScore 归零（方便规则用例），这里要真实结算，先恢复成本局的配置值
  g.state.targetScore = g.config.app.round.targetScore;
  g.ch('s2-03').score = g.state.targetScore;
  g.step(1);
  assert.equal(g.state.result.reason, 'target_reached');
  assert.equal(g.state.result.winnerId, 's2-03');
  assert.equal(g.state.ranking.students[0].id, 's2-03');
  const g2 = makeGame({ player: 's1-01' });
  g2.state.roundMs = 1000;
  g2.step(10);
  assert.equal(g2.state.result.reason, 'time_up');
  g2.step(5);
  assert.equal(g2.state.tick, 10, '结束后不再推进');
});
