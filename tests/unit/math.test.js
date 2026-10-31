import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inFan, lineOfSight, sightClear, bodyVisible, lowCoverHides, visibilityPolygon, rectsToSegments,
  pointInPolygon, resolveCircleRects, catchProbability, degToRad, wrapAngle, convexHull, lowCoverShadow,
} from '../../shared/math.js';

test('扇形判定：半径与张角', () => {
  const o = { x: 0, y: 0 };
  assert.equal(inFan(o, 0, { x: 100, y: 0 }, 260, degToRad(60)).inside, true);
  assert.equal(inFan(o, 0, { x: 100, y: 100 }, 260, degToRad(60)).inside, true); // 45°
  assert.equal(inFan(o, 0, { x: 50, y: 100 }, 260, degToRad(60)).inside, false); // 63°
  assert.equal(inFan(o, 0, { x: 300, y: 0 }, 260, degToRad(60)).inside, false); // 太远
  assert.equal(inFan(o, Math.PI, { x: -100, y: 0 }, 260, degToRad(60)).inside, true); // 朝左
});

test('目击概率随距离线性衰减（近 100% / 远 50%）', () => {
  assert.equal(catchProbability(0, 260), 1);
  assert.equal(catchProbability(260, 260), 0.5);
  assert.equal(catchProbability(130, 260), 0.75);
});

test('高遮挡物挡住视线；指定的电脑桌不挡', () => {
  const wall = { x: 40, y: -50, w: 20, h: 100 };
  assert.equal(lineOfSight({ x: 0, y: 0 }, { x: 100, y: 0 }, [wall]), false);
  assert.equal(lineOfSight({ x: 0, y: 0 }, { x: 100, y: 200 }, [wall]), true);
  const desk = { ...wall, pcId: 'pc-x' };
  assert.equal(lineOfSight({ x: 0, y: 0 }, { x: 100, y: 0 }, [desk], 'pc-x'), true);
});

test('低遮挡物（桌子）只挡住紧贴其后的目标，观察者贴近时不挡', () => {
  const desk = { x: 100, y: -12, w: 52, h: 24 };
  const occ = { tall: [], low: [desk], depth: 48 };
  // 目标紧贴桌子后方 20px → 被挡
  assert.equal(lowCoverHides({ x: 0, y: 0 }, { x: 172, y: 0 }, desk, 48), true);
  assert.equal(sightClear({ x: 0, y: 0 }, { x: 172, y: 0 }, occ), false);
  // 目标离桌子 100px → 越过桌子可见
  assert.equal(sightClear({ x: 0, y: 0 }, { x: 252, y: 0 }, occ), true);
  // 观察者自己贴着桌子 → 可见
  assert.equal(sightClear({ x: 80, y: 0 }, { x: 172, y: 0 }, occ), true);
});

test('身体可见：中心被挡但身体边缘露出也算可见', () => {
  const pillar = { x: 95, y: -3, w: 10, h: 6 };
  const occ = { tall: [pillar], low: [], depth: 48 };
  assert.equal(sightClear({ x: 0, y: 0 }, { x: 200, y: 0 }, occ), false);
  assert.equal(bodyVisible({ x: 0, y: 0 }, { x: 200, y: 0 }, occ, 10), true);
});

test('可见多边形：遮挡物后方的点不在多边形内', () => {
  const wall = { x: 100, y: -100, w: 20, h: 200 };
  const poly = visibilityPolygon({ x: 0, y: 0 }, 300, rectsToSegments([wall]));
  assert.equal(pointInPolygon({ x: 50, y: 0 }, poly), true);
  assert.equal(pointInPolygon({ x: 200, y: 0 }, poly), false);
  assert.equal(pointInPolygon({ x: -200, y: 0 }, poly), true);
  assert.equal(pointInPolygon({ x: -400, y: 0 }, poly), false); // 超出半径
});

test('扇形可见多边形以原点为首点', () => {
  const poly = visibilityPolygon({ x: 0, y: 0 }, 100, [], { facing: 0, halfAngle: degToRad(60), rays: 24 });
  assert.deepEqual(poly[0], { x: 0, y: 0 });
  assert.equal(pointInPolygon({ x: 50, y: 0 }, poly), true);
  assert.equal(pointInPolygon({ x: -50, y: 0 }, poly), false);
});

test('圆被推出矩形（贴墙滑动）', () => {
  const pos = { x: 95, y: 0 };
  assert.equal(resolveCircleRects(pos, 14, [{ x: 100, y: -50, w: 20, h: 100 }]), true);
  assert.ok(pos.x <= 100 - 14 + 0.02);
});

test('wrapAngle 落在 (-π, π]', () => {
  for (const a of [0, 3 * Math.PI, -3 * Math.PI, 7, -7]) {
    const w = wrapAngle(a);
    assert.ok(w > -Math.PI - 1e-9 && w <= Math.PI + 1e-9);
  }
});

test('低遮挡阴影：凸包包含桌子与身后区域；观察者贴近时无阴影', () => {
  const desk = { x: 100, y: -12, w: 52, h: 24 };
  const shadow = lowCoverShadow({ x: 0, y: 0 }, desk, 48);
  assert.ok(pointInPolygon({ x: 180, y: 0 }, shadow));
  assert.ok(!pointInPolygon({ x: 260, y: 0 }, shadow));
  assert.equal(lowCoverShadow({ x: 90, y: 0 }, desk, 48), null);
  assert.equal(convexHull([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 0.2, y: 0.2 }]).length, 3);
});
