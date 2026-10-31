import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ROOT, quiet } from '../helpers.js';
import { mergeOverride, validateConfig, loadConfig } from '../../server/persistence/ConfigLoader.js';
import { buildRoster } from '../../server/core/GameState.js';

test('地图：7 个房间 + 走廊、35 台电脑，每个座位与房间都可达', () => {
  const { map } = setup();
  assert.equal(map.rooms.filter((r) => r.walls !== false).length, 7);
  assert.equal(map.pcs.length, 35);
  assert.equal(map.pcs.filter((p) => p.roomId.startsWith('classroom')).length, 30);
  const start = { x: 960, y: 715 };
  for (const pc of map.pcs) {
    assert.ok(map.isFree(pc.seat), `座位 ${pc.id} 与障碍重叠`);
    const path = map.findPath(start, pc.seat);
    assert.ok(path && path.length, `到 ${pc.id} 无路径`);
    for (let i = 1; i < path.length; i++) assert.ok(map.segmentClear(path[i - 1], path[i], map.radius - 1.5), `${pc.id} 路径穿墙`);
  }
  for (const r of map.rooms) {
    const p = map.randomPointInRoom(r.id, { range: (a, b) => (a + b) / 2 });
    assert.ok(map.findPath(start, p), `到 ${r.id} 无路径`);
  }
  assert.equal(map.roomAt({ x: 140, y: 420 }).type, 'office');
  assert.equal(map.roomAt({ x: 960, y: 715 }).type, 'corridor');
  assert.equal(map.roomAt({ x: 960, y: 200 }), null);
});

test('名单：30 学生 + 5 老师（3 任课 + 2 常驻），用户名唯一', () => {
  const { config } = setup();
  const roster = buildRoster(config.app.roster);
  assert.equal(roster.length, 35);
  assert.equal(roster.filter((r) => r.role === 'student').length, 30);
  assert.equal(roster.filter((r) => r.role === 'teacher' && r.classId).length, 3);
  assert.equal(roster.filter((r) => r.role === 'teacher' && !r.classId).length, 2);
  assert.equal(new Set(roster.map((r) => r.username)).size, 35);
  assert.equal(new Set(roster.map((r) => r.name)).size, 35);
});

test('运行期覆盖：只接受已存在且类型一致的键', () => {
  const base = { a: 1, b: { c: 'x', d: [1] }, e: null };
  const [out, rejected] = mergeOverride(base, { a: 2, b: { c: 5, d: [2, 3] }, e: 7, z: 1 });
  assert.deepEqual(out, { a: 2, b: { c: 'x', d: [2, 3] }, e: 7 });
  assert.equal(rejected.length, 2);
  assert.equal(base.a, 1, '不修改原对象');
});

test('配置校验能发现非法数值', () => {
  const { config } = setup();
  const bad = structuredClone(config.balance);
  bad.flatter.successRateMin = 0.9;
  bad.toilet.maxStack = 0;
  const errors = validateConfig(bad, [['toilet.maxStack', (v) => v >= 1]], 'balance');
  assert.ok(errors.some((e) => e.includes('maxStack')));
  assert.ok(errors.some((e) => e.includes('successRateMin')));
  assert.doesNotThrow(() => loadConfig(ROOT, { logger: quiet }));
});
