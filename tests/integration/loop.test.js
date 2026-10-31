// 集成：确定性回放、存档续局一致、完整对局健壮性与性能预算。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGame } from '../helpers.js';

/** 固定的玩家输入脚本：tick → 指令。 */
function script(g, tick) {
  if (tick === 5) g.move('s1-01', { x: 1, y: 0 });
  if (tick === 9) g.move('s1-01', { x: 0, y: -1 });
  if (tick === 25) g.move('s1-01', { x: 0, y: 0 });
  if (tick === 30) g.act('s1-01', 'enterPc', { pcId: 'pc-c1-01' });
  if (tick === 31) g.act('s1-01', 'leavePc');
  if (tick === 300) g.move('s1-01', { x: -0.6, y: 0.8 });
}

function run(seed, ticks, until = null) {
  const g = makeGame({ seed, player: 's1-01', ai: true });
  for (let t = 1; t <= ticks; t++) {
    script(g, t);
    g.step(1);
    if (until && t === until) break;
  }
  return g;
}

const strip = (state) => JSON.stringify(state, (k, v) => (k === 'startedAt' ? undefined : v));

test('确定性回放：相同种子 + 相同输入 → 相同终态', () => {
  const a = run(2026, 1500);
  const b = run(2026, 1500);
  assert.equal(strip(a.state), strip(b.state));
  const c = run(2027, 1500);
  assert.notEqual(strip(a.state), strip(c.state));
});

test('存档续局：中途序列化再恢复，后续演化与不中断完全一致', () => {
  const full = run(77, 1200);
  const half = run(77, 1200, 600);
  const saved = JSON.parse(JSON.stringify(half.state));
  const resumed = makeGame({ seed: 77, player: 's1-01', ai: true });
  resumed.loop.setState(saved);
  resumed.state = saved;
  for (let t = 601; t <= 1200; t++) {
    script({ ...resumed, move: (id, dir) => saved.inputQueue.push({ charId: id, type: 'move', payload: { dir } }), act: (id, kind, extra = {}) => saved.inputQueue.push({ charId: id, type: 'action', payload: { kind, ...extra } }) }, t);
    resumed.loop.step();
    resumed.loop.drain();
  }
  assert.equal(strip(saved), strip(full.state));
});

test('完整 10 分钟对局：无异常、无穿墙，AI 产生提问 / 讨好 / JC / 目击，单 tick 远低于 8 ms', () => {
  const g = makeGame({ seed: 9, player: 's1-01', ai: true });
  const t0 = performance.now();
  while (g.state.phase === 'PLAYING' && g.state.tick < 6000) g.step(1);
  const avg = (performance.now() - t0) / g.state.tick;
  assert.equal(g.state.phase, 'ENDED');
  const { stats } = g.state;
  assert.ok(stats.asks > 20, `asks ${stats.asks}`);
  assert.ok(stats.flatters > 20, `flatters ${stats.flatters}`);
  assert.ok(stats.jc > 5, `jc ${stats.jc}`);
  for (const c of g.state.characters) assert.ok(g.map.isFree(c.pos, g.balance.move.radius - 1), `${c.id} 卡在障碍里 ${JSON.stringify(c.pos)}`);
  assert.ok(avg < 8, `avg tick ${avg.toFixed(3)} ms`);
  const stat = g.loop.tickStats();
  assert.equal(stat.errors, 0);
  assert.ok(g.state.ranking.students.length === 30 && g.state.ranking.teachers.length === 5);
});

test('多个种子下老师都能抓到 JC（目击 + 检查），且不是每次都抓到', () => {
  let jc = 0;
  let catches = 0;
  for (const seed of [1, 2, 3]) {
    const g = makeGame({ seed, player: 's1-01', ai: true });
    while (g.state.phase === 'PLAYING' && g.state.tick < 6000) g.step(1);
    jc += g.state.stats.jc;
    catches += g.state.stats.catches;
  }
  assert.ok(catches > 0, '老师从未抓到人');
  assert.ok(catches < jc, '每次 JC 都被抓，平衡有问题');
});
