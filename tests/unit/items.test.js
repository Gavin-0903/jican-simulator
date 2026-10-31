// 道具系统（需求 2.1/2.2）：商店购买 / 升级 / 使用五件道具。
// 所有扣钱、随机判定、次数消耗都只发生在本文件——InteractionSystem 不再重复处理道具指令，
// 其它系统只「读」道具状态（frozenUntil / items.buyoff / items.password）生效。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION, CONTROL, ERR, EVENT, ITEM_ID, STATUS } from '../../shared/constants.js';
import { evalCost } from '../../server/systems/ItemSystem.js';
import { Snapshot } from '../../server/core/Snapshot.js';
import { makeGame } from '../helpers.js';

const buy = (g, id, payload = {}) => g.item(id, 'item.buy', payload);
const upgrade = (g, id, payload = {}) => g.item(id, 'item.upgrade', payload);
const use = (g, id, payload = {}) => g.item(id, 'item.use', payload);

test('价格模板求值：{Lv} * 50 / {Lv} * 5', () => {
  assert.equal(evalCost('{Lv} * 50', 3), 150);
  assert.equal(evalCost('{Lv} * 5', 4), 20);
  assert.equal(evalCost(200, 1), 200);
});

test('金币不足时买不起，也不扣钱', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 100;
  buy(g, 's1-01', { itemId: 'hourglass' }); // 850
  g.step(1);
  assert.equal(g.ch('s1-01').score, 100);
  assert.equal(g.ch('s1-01').items.hourglass.lv, 0);
  assert.equal(g.out.errors.at(-1).code, ERR.ITEM);
});

test('购买成功扣钱、等级 1、得到满仓使用次数', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 300;
  buy(g, 's1-01', { itemId: 'freeze' });
  g.step(1);
  assert.equal(g.ch('s1-01').score, 150);
  assert.equal(g.ch('s1-01').items.freeze.lv, 1);
  assert.ok(g.ch('s1-01').items.freeze.uses >= 1, '购买后至少有 1 次使用机会');
  assert.equal(g.ch('s1-01').itemStats.goldSpent, 150);
  assert.ok(g.out.events.some((e) => e.type === EVENT.ITEM_BOUGHT && e.itemId === 'freeze'));
});

test('购买/升级在非 PLAYING 或角色被淘汰时被拒绝', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 1000;
  g.ch('s1-01').status = STATUS.ELIMINATED;
  buy(g, 's1-01', { itemId: 'freeze' });
  g.step(1);
  assert.equal(g.ch('s1-01').score, 1000);
  assert.equal(g.out.errors.at(-1).code, ERR.ELIMINATED);
});

test('升级：按 {Lv} * 50 计价，满级后拒绝', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 10000;
  buy(g, 's1-01', { itemId: 'freeze' });
  g.step(1);
  assert.equal(g.ch('s1-01').items.freeze.lv, 1, '刚买来是 Lv1');
  upgrade(g, 's1-01', { itemId: 'freeze' }); // Lv1 → 2，花 50
  g.step(1);
  assert.equal(g.ch('s1-01').items.freeze.lv, 2, '升级后等级 +1');
  assert.equal(g.ch('s1-01').itemStats.goldSpent, 150 + 50, '购价 150 + 升级 50');
  upgrade(g, 's1-01', { itemId: 'freeze' }); // Lv2 → 3，花 100
  g.step(1);
  assert.equal(g.ch('s1-01').items.freeze.lv, 3);
  g.ch('s1-01').items.freeze.lv = g.balance.items.freeze.maxLevel;
  upgrade(g, 's1-01', { itemId: 'freeze' });
  g.step(1);
  assert.equal(g.ch('s1-01').items.freeze.lv, g.balance.items.freeze.maxLevel);
  assert.equal(g.out.errors.at(-1).code, ERR.ITEM);
});

test('未购买的道具不能升级、不能使用', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 1000;
  upgrade(g, 's1-01', { itemId: 'buyoff' });
  g.step(1);
  assert.equal(g.out.errors.at(-1).code, ERR.ITEM);
  use(g, 's1-01', { itemId: 'freeze', targetId: 's1-02' });
  g.step(1);
  assert.equal(g.out.errors.at(-1).code, ERR.ITEM);
});

test('定格手枪：目标被定格 Lv 秒不能移动，到期自动解冻', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 1000;
  buy(g, 's1-01', { itemId: 'freeze' });
  g.step(1);
  const target = g.ch('s1-02');
  const before = { ...target.pos };
  use(g, 's1-01', { itemId: 'freeze', targetId: 's1-02' });
  g.step(1);
  assert.ok(target.frozenUntil > g.state.tick, '应写入 frozenUntil');
  assert.ok(g.out.events.some((e) => e.type === EVENT.FROZEN && e.targetId === 's1-02'));
  // 被定格：输入方向也不生效
  g.state.inputQueue.push({ charId: 's1-02', type: 'move', payload: { dir: { x: 1, y: 0 } } });
  g.step(4); // 1 秒定格 = 10 tick（10Hz 以上），先确认定格期间不动
  assert.equal(target.pos.x, before.x);
  assert.equal(target.vel.x, 0);
  g.step(20); // 等到定格结束
  assert.ok(g.state.tick >= target.frozenUntil);
  g.state.inputQueue.push({ charId: 's1-02', type: 'move', payload: { dir: { x: 1, y: 0 } } });
  g.step(3);
  assert.ok(target.pos.x > before.x, '解冻后可以移动');
});

test('被定格时不能执行交互动作，也不强制退出电脑', () => {
  const g = makeGame({ player: 's1-01' });
  g.parkTeachers();
  g.place('s1-01', g.pc('pc-c1-02').pos);
  g.act('s1-01', 'enterPc', { pcId: 'pc-c1-02' });
  g.step(1);
  assert.equal(g.ch('s1-01').operatingPcId, 'pc-c1-02');
  g.ch('s1-01').frozenUntil = g.state.tick + 100;
  g.act('s1-01', 'jc.open', { pcId: 'pc-c1-02' });
  g.step(1);
  assert.equal(g.out.errors.at(-1).code, ERR.FROZEN);
  assert.equal(g.ch('s1-01').operatingPcId, 'pc-c1-02');
});

test('被定格时提问进度暂停（既不加分也不中断）', () => {
  const g = makeGame({ player: 's1-01' });
  g.place('s1-01', { x: 140, y: 434 }); // t4 在办公室 (140,400)
  g.act('s1-01', 'askQuestion');
  g.step(2);
  const st = g.ch('s1-01').asking;
  assert.ok(st, '应开始提问');
  const ms = st.ms;
  g.ch('s1-01').frozenUntil = g.state.tick + 50;
  g.step(5);
  assert.equal(g.ch('s1-01').asking.ms, ms, '定格期间进度不变');
  assert.ok(g.ch('s1-01').asking, '不会被中断');
});

test('时间沙漏：除自己外全场定格，每局上限 ceil(Lv/2)', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 10000;
  buy(g, 's1-01', { itemId: 'hourglass' }); // 850，Lv1
  g.step(1);
  assert.equal(g.ch('s1-01').items.hourglass.lv, 1);
  use(g, 's1-01', { itemId: 'hourglass' });
  g.step(1);
  const others = g.state.characters.filter((c) => c.id !== 's1-01' && c.status === STATUS.ACTIVE);
  assert.ok(others.length > 0);
  assert.ok(others.every((c) => c.frozenUntil > g.state.tick), '其他所有人都被定格');
  assert.ok(g.ch('s1-01').frozenUntil <= g.state.tick, '自己不被定格');
  // Lv1 每局只能 1 次
  use(g, 's1-01', { itemId: 'hourglass' });
  g.step(1);
  assert.equal(g.out.errors.at(-1).code, ERR.ITEM);
  assert.equal(g.out.errors.at(-1).reason, 'round_limit');
});

test('买通老师：目击概率按 Lv 打 9 折，Lv10 时完全看不见', () => {
  const g = makeGame({ player: 's1-01' });
  g.balance.teacher.catchProbabilityLerp = [1, 1]; // 概率恒为 1
  g.ch('s1-01').score = 10000;
  buy(g, 's1-01', { itemId: 'buyoff' });
  g.step(1);
  assert.equal(g.ch('s1-01').items.buyoff.lv, 1);
  // 概率 1 * 0.9 = 0.9：rng 0.95 不会命中
  g.loop.pipeline.find(([n]) => n === 'vision')[1].rngOf = () => ({ next: () => 0.95 });
  g.parkTeachers();
  g.ch('s1-02').score = 200;
  g.place('s1-01', g.pc('pc-c1-02').pos);
  g.place('s1-02', { x: 960, y: 715 });
  g.act('s1-01', 'enterPc', { pcId: 'pc-c1-02' });
  g.step(1);
  g.act('s1-01', 'jc.open', { pcId: 'pc-c1-02' });
  g.step(1);
  g.place('t1', { x: 230, y: 830 }, Math.PI / 2);
  g.commit('s1-01', 's1-01', 50);
  g.step(1);
  assert.equal(g.out.events.filter((e) => e.type === 'teacher_catch').length, 0, '0.95 > 0.9 不该被看见');
  assert.equal(g.ch('s1-02').score, 150, 'JC 仍然生效');
});

test('买通老师 Lv 达到 10 时概率归零', () => {
  const g = makeGame({ player: 's1-01' });
  g.balance.teacher.catchProbabilityLerp = [1, 1];
  g.ch('s1-01').items.buyoff.lv = 10;
  g.loop.pipeline.find(([n]) => n === 'vision')[1].rngOf = () => ({ next: () => 0 });
  g.parkTeachers();
  g.ch('s1-02').score = 200;
  g.place('s1-01', g.pc('pc-c1-02').pos);
  g.place('s1-02', { x: 960, y: 715 });
  g.act('s1-01', 'enterPc', { pcId: 'pc-c1-02' });
  g.step(1);
  g.act('s1-01', 'jc.open', { pcId: 'pc-c1-02' });
  g.step(1);
  g.place('t1', { x: 230, y: 830 }, Math.PI / 2);
  g.commit('s1-01', 's1-01', 50);
  g.step(1);
  assert.equal(g.out.events.filter((e) => e.type === 'teacher_catch').length, 0);
});

test('强密码：拦截 JC，解锁期间再次提交只返回剩余时间，解锁完成后可正常 JC', () => {
  const g = makeGame({ player: 's1-01' });
  g.parkTeachers();
  g.ch('s1-02').score = 200;
  g.ch('s1-02').items.password.lv = 1; // 受害者持有 Lv1 强密码
  g.place('s1-01', g.pc('pc-c1-02').pos);
  g.place('s1-02', { x: 960, y: 715 });
  g.act('s1-01', 'enterPc', { pcId: 'pc-c1-02' });
  g.step(1);
  g.act('s1-01', 'jc.open', { pcId: 'pc-c1-02' });
  g.step(1);
  g.commit('s1-01', 's1-01', 50);
  g.step(1);
  const locked = g.out.dialogs.find((d) => d.payload.kind === 'jc_locked');
  assert.ok(locked, '应返回 jc_locked 对话框');
  assert.ok(locked.payload.remainMs > 0);
  assert.equal(g.ch('s1-02').score, 200, '解锁期间不扣分');
  assert.ok(g.ch('s1-01').unlock['s1-02'].until > g.state.tick);
  // 解锁期内再次提交：只返回剩余时间，且不重置计时
  const first = locked.payload.remainMs;
  const until0 = g.ch('s1-01').unlock['s1-02'].until;
  g.step(1);
  g.commit('s1-01', 's1-01', 50);
  g.step(1);
  const again = g.out.dialogs.filter((d) => d.payload.kind === 'jc_locked').at(-1);
  assert.ok(again.payload.remainMs <= first, '剩余时间在减少');
  assert.equal(g.ch('s1-01').unlock['s1-02'].until, until0, '重复提交不会重置解锁计时');
  assert.equal(g.ch('s1-02').score, 200);
  // 等解锁完成。注意：到期条目由 ItemSystem 清理，"破完了"这一刻要靠 unlockOnce 标记记住，
  // 否则「到期 → 下一次提交」永远会被当成首次触发而重新计时（死循环）。
  g.step(30);
  assert.equal(g.ch('s1-01').unlockOnce['s1-02'], true, '解锁计时到期后留有一次性放行标记');
  g.ch('s1-01').pendingActions.push({ kind: 'jc.commit', selfUsername: 's1-01', amount: 50, _seq: null });
  g.step(1);
  assert.equal(g.ch('s1-01').lastResult.ok, true, '解锁后 JC 正常生效');
  assert.equal(g.ch('s1-02').score, 150);
});

test('强密码对已被淘汰/被定格的持有者依然生效', () => {
  const g = makeGame({ player: 's1-01' });
  g.parkTeachers();
  g.ch('s1-02').score = 200;
  g.ch('s1-02').items.password.lv = 2;
  g.ch('s1-02').frozenUntil = g.state.tick + 500;
  g.place('s1-01', g.pc('pc-c1-02').pos);
  g.place('s1-02', { x: 960, y: 715 });
  g.act('s1-01', 'enterPc', { pcId: 'pc-c1-02' });
  g.step(1);
  g.act('s1-01', 'jc.open', { pcId: 'pc-c1-02' });
  g.step(1);
  g.commit('s1-01', 's1-01', 50);
  g.step(1);
  assert.ok(g.out.dialogs.some((d) => d.payload.kind === 'jc_locked'));
  assert.equal(g.ch('s1-02').score, 200);
});

test('黑客手册：开列表 → 成功改分（add / set）', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 5000;
  g.ch('s1-01').items.hackbook = { lv: 10, uses: 5 }; // Lv10 → 失败率 0
  use(g, 's1-01', { itemId: 'hackbook' });
  g.step(1);
  const dlg = g.out.dialogs.find((d) => d.payload.kind === 'hack.targets');
  assert.ok(dlg, '应返回全员列表');
  assert.ok(dlg.payload.list.length >= 30);
  assert.ok(dlg.payload.list.some((t) => t.role === 'teacher'), '列表包含老师');
  use(g, 's1-01', { itemId: 'hackbook', charId: 's1-02', action: 'add', amount: 200 });
  g.step(1);
  assert.equal(g.ch('s1-02').score, 200);
  assert.equal(g.ch('s1-01').itemStats.hackSuccess, 1);
  // 每局最多 1 次：第二次直接被拒绝
  g.ch('t1').score = 100;
  use(g, 's1-01', { itemId: 'hackbook', charId: 't1', action: 'set', amount: 999 });
  g.step(1);
  assert.equal(g.ch('t1').score, 100, '第二次使用被每局上限拒绝');
  assert.equal(g.out.errors.at(-1).reason, 'round_limit');
});

test('黑客手册：Lv1 失败率 90% → 自己 -100 分且目标不变', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 5000;
  g.ch('s1-01').items.hackbook = { lv: 1, uses: 5 };
  g.loop.pipeline.find(([n]) => n === 'items')[1].rngOf = () => ({ next: () => 0.05 });
  use(g, 's1-01', { itemId: 'hackbook', charId: 's1-02', action: 'add', amount: 200 });
  g.step(1);
  assert.equal(g.ch('s1-02').score, 0, '目标不变');
  assert.equal(g.ch('s1-01').score, 4900);
  assert.equal(g.ch('s1-01').itemStats.hackFail, 1);
  assert.ok(g.out.events.some((e) => e.type === EVENT.ITEM_FAILED));
});

test('黑客手册：被校长发现则开除（人类玩家结束本局）', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 5000;
  g.ch('s1-01').items.hackbook = { lv: 1, uses: 5 };
  g.loop.pipeline.find(([n]) => n === 'items')[1].rngOf = () => ({ next: () => 0 });
  use(g, 's1-01', { itemId: 'hackbook', charId: 's1-02', action: 'add', amount: 200 });
  g.step(1);
  assert.equal(g.ch('s1-01').status, STATUS.ELIMINATED);
  assert.equal(g.state.result.reason, 'player_eliminated');
  assert.ok(g.out.events.some((e) => e.type === EVENT.ELIMINATED && e.actorId === 's1-01'));
});

test('黑客手册每局最多 1 次；沙漏每局上限随等级提升', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 5000;
  g.ch('s1-01').items.hackbook = { lv: 10, uses: 5 };
  use(g, 's1-01', { itemId: 'hackbook', charId: 's1-02', action: 'add', amount: 10 });
  g.step(1);
  assert.equal(g.ch('s1-01').itemRoundCount.hackbook, 1);
  use(g, 's1-01', { itemId: 'hackbook', charId: 's1-02', action: 'add', amount: 10 });
  g.step(1);
  assert.equal(g.out.errors.at(-1).reason, 'round_limit');
  assert.equal(g.ch('s1-01').itemRoundCount.hackbook, 1);
  assert.equal(Math.ceil(4 / 2), 2, 'Lv4 沙漏每局 2 次');
});

test('快照与大厅：meView 带道具字段、charView 带剩余定格毫秒、rules 带 items', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 1000;
  buy(g, 's1-01', { itemId: 'freeze' });
  g.step(1);
  const snap = new Snapshot({ map: g.map, balance: g.balance, stepMs: g.loop.stepMs });
  const view = snap.build(g.state, 's1-01');
  assert.equal(view.me.items.freeze.lv, 1);
  assert.ok(view.me.items.freeze.uses >= 1, 'meView 带剩余次数');
  assert.equal(typeof view.me.frozenMs, 'number');
  assert.equal(view.chars['s1-01'].fz, 0);
  g.ch('s1-02').frozenUntil = g.state.tick + 50;
  const view2 = snap.build(g.state, 's1-01');
  assert.ok(view2.chars['s1-02'].fz > 0, 'charView.fz 是剩余定格毫秒');
  assert.ok(snap.build(g.state, 's1-01').me.itemPrices.freeze.price > 0, 'meView 带价目表');
  assert.ok(g.balance.items.hackbook.price > 0);
});

test('定格手枪可补充使用次数（buyType=uses），道具指令走 pendingActions 不算未知动作', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 1000;
  buy(g, 's1-01', { itemId: 'freeze' });
  g.step(1);
  use(g, 's1-01', { itemId: 'freeze', targetId: 's1-02' });
  g.step(1);
  assert.equal(g.ch('s1-01').items.freeze.uses, 9);
  assert.equal(g.ch('s1-01').pendingActions.length, 0);
  const before = g.ch('s1-01').score;
  buy(g, 's1-01', { itemId: 'freeze', buyType: 'uses', amount: 2 }); // Lv1: 2 * (1*5) = 10
  g.step(1);
  assert.equal(g.ch('s1-01').score, before - 10);
  assert.equal(g.ch('s1-01').items.freeze.uses, 9 + 2);
  assert.ok(!g.out.errors.some((e) => e.code === ERR.BADMSG), 'item.* 不能被当成未知动作');
});

test('ACTION 枚举形式同样可用（kind buyItem/useItem）', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 1000;
  g.act('s1-01', ACTION.BUY_ITEM, { itemId: 'password' });
  g.step(1);
  assert.equal(g.ch('s1-01').items.password.lv, 1);
  assert.equal(g.ch('s1-01').control, CONTROL.HUMAN);
});
test('买通老师：Lv5 时 50% 的目击被吞掉（固定 rng 0.6 命中 0.5 阈值之外）', () => {
  const g = makeGame({ player: 's1-01' });
  g.balance.teacher.catchProbabilityLerp = [1, 1]; // 几何命中率恒为 1，只看买通折扣
  g.ch('s1-01').items.buyoff.lv = 5; // 1 - 5 * 0.10 = 0.5
  g.loop.pipeline.find(([n]) => n === 'vision')[1].rngOf = () => ({ next: () => 0.6 });
  g.parkTeachers();
  g.ch('s1-02').score = 200;
  g.place('s1-01', g.pc('pc-c1-02').pos);
  g.place('s1-02', { x: 960, y: 715 });
  g.act('s1-01', 'enterPc', { pcId: 'pc-c1-02' });
  g.step(1);
  g.act('s1-01', 'jc.open', { pcId: 'pc-c1-02' });
  g.step(1);
  // 同一次 JC 里可能有多位老师目击，任何一位被「看见」都会记 teacher_catch，这里要求一次都没有
  g.place('t1', { x: 230, y: 830 }, Math.PI / 2);
  g.commit('s1-01', 's1-01', 50);
  g.step(1);
  assert.equal(g.out.events.filter((e) => e.type === EVENT.TEACHER_CATCH).length, 0, '0.6 > 0.5，不该被目击');
  assert.equal(g.ch('s1-02').score, 150, 'JC 照常生效');
  assert.ok(g.ch('s1-01').itemBuyoffSeen >= 1, '记下了一次被买通老师的目击');
});

test('黑客手册：第一次使用成功、第二次触发每局上限，且失败不消耗目标的分数', () => {
  const g = makeGame({ player: 's1-01' });
  g.ch('s1-01').score = 5000;
  g.ch('s1-01').items.hackbook = { lv: 10, uses: 2 }; // Lv10：失败率 0、开除率 20%
  g.loop.pipeline.find(([n]) => n === 'items')[1].rngOf = () => ({ next: () => 0.99 }); // 两个抽签都落在概率之外
  use(g, 's1-01', { itemId: 'hackbook', charId: 's1-02', action: 'set', amount: 777 });
  g.step(1);
  assert.equal(g.ch('s1-02').score, 777, 'set 把积分直接改成给定值');
  assert.equal(g.ch('s1-01').items.hackbook.uses, 1, '消耗 1 次');
  const r = g.out.dialogs.find((d) => d.payload.kind === 'hack_result');
  assert.equal(r.payload.ok, true);
  assert.equal(r.payload.expelled, false);
  use(g, 's1-01', { itemId: 'hackbook', charId: 's1-02', action: 'add', amount: 1 });
  g.step(1);
  assert.equal(g.out.errors.at(-1).code, ERR.ITEM);
  assert.equal(g.out.errors.at(-1).reason, 'round_limit');
  assert.equal(g.ch('s1-02').score, 777, '被拒绝的第二次没有改动目标');
  assert.ok(g.ch('s1-01').items.hackbook.uses === 1, '被拒绝时不扣使用次数');
});
