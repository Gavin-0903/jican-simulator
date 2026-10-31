import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGame } from '../helpers.js';
import { Snapshot } from '../../server/core/Snapshot.js';

function snap(g) {
  return new Snapshot({ map: g.map, balance: g.balance, stepMs: 100, historySize: 5 });
}

test('公共视图不包含学生积分与 AI 私有数据；玩家私有数据在 me 中', () => {
  const g = makeGame({ player: 's1-01', ai: true });
  g.step(20);
  const s = snap(g);
  const full = s.full(g.state, 's1-01');
  const json = JSON.stringify(full.state.chars);
  assert.ok(!json.includes('"score"'));
  assert.ok(!json.includes('persona'));
  assert.equal(full.state.me.id, 's1-01');
  assert.equal(full.state.me.salary, null);
  assert.ok('lastViewedScore' in full.state.me);
  const t = s.full(g.state, 't1');
  assert.equal(t.state.me.salary, g.balance.teacher.initialSalary);
});

test('增量只包含变化字段，序号连续，可按 lastSeq 补发', () => {
  const g = makeGame({ player: 's1-01' });
  const s = snap(g);
  const f = s.full(g.state, 's1-01');
  g.move('s1-01', { x: 1, y: 0 });
  g.step(3);
  const d = s.delta(g.state, 's1-01');
  assert.equal(d.seq, f.seq + 1);
  const mine = d.chars.find((c) => c.id === 's1-01');
  assert.ok('x' in mine);
  assert.ok(!('id' in mine && 'st' in mine), '未变化的状态字段不应下发');
  assert.equal(d.chars.length, 1);
  assert.equal(s.delta(g.state, 's1-01'), null, '无变化时不发包');
  assert.deepEqual(s.since(f.seq).map((p) => p.payload.seq), [d.seq]);
  for (let i = 0; i < 10; i++) {
    g.step(1);
    s.delta(g.state, 's1-01');
  }
  assert.equal(s.since(f.seq), null, '历史不连续时需要全量');
});

test('事件按可见范围过滤：本人、目标、视线可见的目击者', () => {
  const g = makeGame({ player: 's1-01' });
  const s = snap(g);
  const evs = [
    { type: 'jc_success', actorId: 's2-01', targetId: 's2-02', pos: { x: 770, y: 902 }, audience: ['actor', 'witness'] },
    { type: 'jc_victim', targetId: 's1-01', audience: ['target'] },
    { type: 'teacher_catch', actorId: 't1', targetId: 's3-01', audience: ['all'] },
    { type: 'score_changed', actorId: 's1-02', audience: ['actor'] },
  ];
  g.place('s1-01', { x: 130, y: 906 }); // 一班教室，看不到二班
  const seen = s.filterEvents(g.state, 's1-01', evs).map((e) => e.type);
  assert.deepEqual(seen, ['jc_victim', 'teacher_catch']);
  g.place('s1-01', { x: 760, y: 836 }); // 二班教室内
  assert.ok(s.filterEvents(g.state, 's1-01', evs).some((e) => e.type === 'jc_success'));
  assert.ok(!s.filterEvents(g.state, 's1-01', evs)[0].audience, 'audience 字段不下发');
});
