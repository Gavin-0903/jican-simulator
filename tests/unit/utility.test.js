import { test } from 'node:test';
import assert from 'node:assert/strict';
import { norm, scoreUtility, softmaxSelect } from '../../server/ai/UtilityScorer.js';
import { Rng } from '../../server/core/Rng.js';

test('归一化落在 [0,1]', () => {
  assert.equal(norm(50, 100), 0.5);
  assert.equal(norm(-5, 100), 0);
  assert.equal(norm(500, 100), 1);
});

test('效用 = 收益 − 成本 − 风险 + 性格 − 冷却', () => {
  const w = { gain: 1, cost: 0.6, risk: 0.8, persona: 0.3, cooldown: 0.5 };
  const u = scoreUtility({ gain: 1, cost: 0.5, risk: 0.5, persona: 1, cooldown: 1 }, w);
  assert.ok(Math.abs(u - (1 - 0.3 - 0.4 + 0.3 - 0.5)) < 1e-9);
});

test('softmax：τ→0 退化为贪心；τ 大时各选项都会被选到', () => {
  const cands = [{ id: 'a', utility: 0.1 }, { id: 'b', utility: 0.5 }, { id: 'c', utility: 0.3 }];
  const rng = Rng.fromSeed(1);
  for (let i = 0; i < 50; i++) assert.equal(softmaxSelect(cands, 0.001, rng).id, 'b');
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(softmaxSelect(cands, 1, rng).id);
  assert.equal(seen.size, 3);
  assert.equal(softmaxSelect([], 0.1, rng), null);
});
