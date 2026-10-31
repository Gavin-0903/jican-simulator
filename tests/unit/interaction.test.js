import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGame } from '../helpers.js';

test('问老师问题：办公室内连续停留 10 秒 +50 分，之后冷却 30 秒', () => {
  const g = makeGame({ player: 's1-01' });
  g.place('s1-01', { x: 140, y: 434 }); // t4 在 (140,400)
  g.act('s1-01', 'askQuestion');
  g.step(1);
  assert.ok(g.ch('s1-01').asking);
  g.step(98);
  assert.equal(g.ch('s1-01').score, 0);
  g.step(1);
  assert.equal(g.ch('s1-01').score, 50);
  assert.equal(g.ch('s1-01').askCount, 1);
  assert.equal(g.ch('s1-01').knownDelta, 50);
  g.act('s1-01', 'askQuestion');
  g.step(1);
  assert.equal(g.out.errors.at(-1).code, 'E_COOLDOWN');
});

test('提问中离开老师身边即中断、不加分', () => {
  const g = makeGame({ player: 's1-01' });
  g.place('s1-01', { x: 140, y: 434 });
  g.act('s1-01', 'askQuestion');
  g.step(50);
  g.place('s1-01', { x: 385, y: 700 });
  g.step(60);
  assert.equal(g.ch('s1-01').asking, null);
  assert.equal(g.ch('s1-01').score, 0);
  assert.ok(g.out.events.some((e) => e.type === 'ask_cancelled'));
});

test('只能在办公室提问；单局次数上限', () => {
  const g = makeGame({ player: 's1-01' });
  g.place('t1', { x: 330, y: 838 });
  g.place('s1-01', { x: 330, y: 860 }); // 教室里贴着任课老师
  g.act('s1-01', 'askQuestion');
  g.step(1);
  assert.equal(g.out.errors.at(-1).code, 'E_OUTOFRANGE');
  g.place('s1-01', { x: 140, y: 434 });
  g.ch('s1-01').askCount = g.balance.ask.limit;
  g.act('s1-01', 'askQuestion');
  g.step(1);
  assert.match(g.out.errors.at(-1).message, /次数/);
});

test('讨好老师：成功率落在 40%~80%，成功 0~100，失败扣 5~40', () => {
  const g = makeGame({ player: 's1-01' });
  g.state.targetScore = 0; // 关闭目标积分，避免中途结束
  g.place('s1-01', { x: 140, y: 434 });
  const t4 = g.ch('t4');
  const s = g.ch('s1-01');
  let ok = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    t4.favor = {}; // 固定好感度为初始值 0.5 → 成功率 60%
    s.cooldowns.flatter = 0;
    const before = s.score;
    g.act('s1-01', 'flatter', { targetId: 't4' });
    g.step(1);
    assert.equal(s.lastResult.tick, g.state.tick, '本帧必须有讨好结果');
    const d = s.score - before;
    if (s.lastResult.success) {
      ok++;
      assert.ok(d >= 0 && d <= 100);
    } else {
      assert.ok(d <= -5 && d >= -40, `penalty ${d}`);
    }
  }
  const rate = ok / N;
  assert.ok(rate > 0.5 && rate < 0.7, `rate ${rate}`);
});

test('好感度把讨好成功率限制在 [40%, 80%]', () => {
  const g = makeGame({ player: 's1-01' });
  g.state.targetScore = 0;
  g.place('s1-01', { x: 140, y: 434 });
  const s = g.ch('s1-01');
  const t4 = g.ch('t4');
  const measure = (favor) => {
    let ok = 0;
    for (let i = 0; i < 300; i++) {
      t4.favor[s.id] = favor;
      s.cooldowns.flatter = 0;
      g.act('s1-01', 'flatter', { targetId: 't4' });
      g.step(1);
      assert.equal(s.lastResult.tick, g.state.tick);
      if (s.lastResult.success) ok++;
    }
    return ok / 300;
  };
  const low = measure(0);
  const high = measure(1);
  assert.ok(low > 0.3 && low < 0.5, `low ${low}`);
  assert.ok(high > 0.7 && high < 0.9, `high ${high}`);
});

test('查看积分只能在自己的电脑上，进入他人电脑可看到对方积分', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 77;
  g.act('s1-01', 'enterPc', { pcId: 'pc-c1-01' });
  g.step(1);
  g.act('s1-01', 'viewScore');
  g.step(1);
  assert.equal(g.ch('s1-01').lastViewedScore, 77);
  assert.equal(g.out.dialogs.at(-1).payload.score, 77);
  g.act('s1-01', 'leavePc');
  g.step(1);
  g.ch('s1-02').score = 333;
  g.place('s1-02', { x: 960, y: 715 });
  g.place('s1-01', g.pc('pc-c1-02').pos);
  g.act('s1-01', 'enterPc', { pcId: 'pc-c1-02' });
  g.step(1);
  const pcDialog = g.out.dialogs.at(-1).payload;
  assert.equal(pcDialog.kind, 'pc');
  assert.equal(pcDialog.ownerScore, 333);
  g.act('s1-01', 'viewScore');
  g.step(1);
  assert.equal(g.out.errors.at(-1).code, 'E_FORBIDDEN');
});

test('操作电脑时无法移动；20 秒无操作自动离开', () => {
  const g = makeGame({ player: 's1-01' });
  g.act('s1-01', 'enterPc', { pcId: 'pc-c1-01' });
  g.step(1);
  const pos = { ...g.ch('s1-01').pos };
  g.move('s1-01', { x: 0, y: 1 });
  g.step(10);
  assert.deepEqual(g.ch('s1-01').pos, pos);
  g.step(190);
  assert.equal(g.ch('s1-01').operatingPcId, null);
  assert.ok(g.out.dialogs.some((d) => d.payload.kind === 'close' && d.payload.reason === 'idle'));
});

test('老师检查电脑：抓到擅自使用他人电脑者（老师 +100，学生扣分并被赶走）', () => {
  const g = makeGame({ player: 't1' });
  g.place('s1-02', { x: 960, y: 715 });
  g.place('s1-01', g.pc('pc-c1-02').pos);
  g.act('s1-01', 'enterPc', { pcId: 'pc-c1-02' });
  g.step(1);
  g.place('t1', { x: 250, y: 930 });
  const before = g.ch('t1').score;
  g.act('t1', 'inspectPc', { pcId: 'pc-c1-02' });
  g.step(1);
  assert.equal(g.ch('t1').score, before + g.balance.teacher.catchReward);
  assert.equal(g.ch('s1-01').score, -g.balance.jc.trespassPenalty);
  assert.equal(g.ch('s1-01').operatingPcId, null);
  // 电脑主人自己在用：无异常
  g.place('s1-03', g.pc('pc-c1-03').pos);
  g.act('s1-03', 'enterPc', { pcId: 'pc-c1-03' });
  g.step(25);
  g.place('t1', { x: 330, y: 930 });
  g.act('t1', 'inspectPc', { pcId: 'pc-c1-03' });
  g.step(1);
  assert.ok(g.out.events.some((e) => e.type === 'inspect_clear'));
});

test('学生不能检查电脑，老师不能进入学生电脑', () => {
  const g = makeGame({ player: 's1-01' });
  g.act('s1-01', 'inspectPc', { pcId: 'pc-c1-02' });
  g.step(1);
  assert.equal(g.out.errors.at(-1).code, 'E_FORBIDDEN');
  const g2 = makeGame({ player: 't1' });
  g2.place('t1', g2.pc('pc-c1-02').pos);
  g2.act('t1', 'enterPc', { pcId: 'pc-c1-02' });
  g2.step(1);
  assert.equal(g2.out.errors.at(-1).code, 'E_FORBIDDEN');
});
