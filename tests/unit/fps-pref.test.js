// 帧率偏好（client/js/render/fps.js）的自测：默认值、持久化、非法值回退、节流判定。
// 不依赖真实浏览器：用内存版 localStorage 顶替，Import 前先挂到 globalThis 上。

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 内存版 localStorage，Node 里没有真货。 */
globalThis.localStorage = (() => {
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
})();

const { FPS_DEFAULT, FPS_OPTIONS, getFps, setFps, fpsLabel, shouldRender } = await import(
  '../../client/js/render/fps.js'
);

test('默认 60 帧', () => {
  assert.equal(FPS_DEFAULT, 60);
  assert.equal(getFps(), 60);
  assert.equal(fpsLabel(), '60');
});

test('选项里包含 30/45/60/90/120/不限', () => {
  assert.deepEqual(FPS_OPTIONS.map(([v]) => v), [30, 45, 60, 90, 120, 0]);
});

test('setFps 生效并写进 localStorage', () => {
  setFps(30);
  assert.equal(getFps(), 30);
  assert.equal(globalThis.localStorage.getItem('jican.fps'), '30');
});

test('非法值回退默认 60', () => {
  assert.equal(setFps(37), 60);
  assert.equal(getFps(), 60);
  assert.equal(setFps('abc'), 60);
});

test('不限（0）时每帧都画', () => {
  setFps(0);
  assert.equal(shouldRender(10), true);
  assert.equal(shouldRender(11), true);
  assert.equal(shouldRender(11), true);
});

test('30 帧时节流到大约 33ms 一帧', () => {
  setFps(30);
  assert.equal(shouldRender(0), true); // 首帧
  assert.equal(shouldRender(16), false); // 16ms 还没到 33ms
  assert.equal(shouldRender(31), false); // 31ms 仍在容差外（33.3-1.5≈31.8）
  assert.equal(shouldRender(34), true);
  assert.equal(shouldRender(50), false);
  assert.equal(shouldRender(68), true);
});

test('60 帧时 60Hz 的抖动不会被误判成 30 帧', () => {
  setFps(60);
  assert.equal(shouldRender(0), true);
  assert.equal(shouldRender(16.6), true); // 16.6 < 16.67，但容差 1.5ms 放行
  assert.equal(shouldRender(33.3), true);
});

test('改帧率后立刻生效，不用等旧节流窗口', () => {
  setFps(120);
  assert.equal(shouldRender(0), true);
  setFps(30); // 内部会把 lastRenderAt 清零
  assert.equal(shouldRender(1), true);
});
