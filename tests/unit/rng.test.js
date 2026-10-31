import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng, childCell, createCell, hashString } from '../../server/core/Rng.js';

test('相同种子产生相同序列', () => {
  const a = Rng.fromSeed(123);
  const b = Rng.fromSeed(123);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
});

test('不同种子序列不同，输出位于 [0,1)', () => {
  const a = Rng.fromSeed(1);
  const b = Rng.fromSeed(2);
  let same = 0;
  for (let i = 0; i < 100; i++) {
    const x = a.next();
    assert.ok(x >= 0 && x < 1);
    if (x === b.next()) same++;
  }
  assert.ok(same < 3);
});

test('状态单元可序列化并精确续接', () => {
  const cell = createCell(99);
  const r = new Rng(cell);
  r.next();
  r.next();
  const saved = JSON.parse(JSON.stringify(cell));
  const expected = [r.next(), r.next(), r.next()];
  const resumed = new Rng(saved);
  assert.deepEqual([resumed.next(), resumed.next(), resumed.next()], expected);
});

test('每个角色独立子流：一个角色多抽不影响另一个', () => {
  const a1 = new Rng(childCell(7, 's1-01'));
  const b1 = new Rng(childCell(7, 's1-02'));
  const a2 = new Rng(childCell(7, 's1-01'));
  const b2 = new Rng(childCell(7, 's1-02'));
  for (let i = 0; i < 10; i++) a1.next(); // a1 多抽 10 次
  assert.equal(b1.next(), b2.next());
  assert.notEqual(a1.next(), a2.next());
});

test('int / range / pick 范围正确', () => {
  const r = Rng.fromSeed(5);
  for (let i = 0; i < 500; i++) {
    const n = r.int(5, 40);
    assert.ok(Number.isInteger(n) && n >= 5 && n <= 40);
    const f = r.range(0.4, 0.8);
    assert.ok(f >= 0.4 && f < 0.8);
  }
  assert.equal(r.pick([]), undefined);
  assert.equal(typeof hashString('abc'), 'number');
});
