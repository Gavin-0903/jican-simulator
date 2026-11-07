// 帧率（流畅度）偏好：纯客户端设置，存 localStorage，服务端不参与。
//
// 为什么不用 config/default.json：帧率是「这台机器 + 这块屏」的渲染能力问题，不是对局规则。
// 写进服务端配置会被整屋同步（房主改 30 帧，别人也掉帧），而且换台电脑还得重新改服务器配置。
//
// 取值：30 / 45 / 60 / 90 / 120 / 0（0 = 不限制，跟随显示器刷新率，由 requestAnimationFrame 的 vsync 兜底）。
// 实际效果还受显示器刷新率和机器性能限制：设 120 但屏幕只有 60Hz，看到的还是 60 帧。

const STORAGE_KEY = 'jican.fps';

export const FPS_DEFAULT = 60;

/** [值, 按钮文案]；0 表示不限制。 */
export const FPS_OPTIONS = Object.freeze([
  [30, '30'],
  [45, '45'],
  [60, '60'],
  [90, '90'],
  [120, '120'],
  [0, '不限'],
]);

function normalize(v) {
  const n = Number(v);
  return FPS_OPTIONS.some(([x]) => x === n) ? n : FPS_DEFAULT;
}

function readStored() {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(STORAGE_KEY);
    if (raw == null || raw === '') return FPS_DEFAULT;
    return normalize(raw);
  } catch {
    // 隐私模式 / 禁用存储：退回默认值，不影响开游戏
    return FPS_DEFAULT;
  }
}

let current = readStored();
let lastRenderAt = 0;

export function getFps() {
  return current;
}

export function setFps(v) {
  current = normalize(v);
  lastRenderAt = -Infinity; // 立刻生效：下一帧一定画（不从 0 起算，否则会白等一个间隔）
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(STORAGE_KEY, String(current));
  } catch {
    /* 隐私模式：只在本次会话生效 */
  }
  return current;
}

/** 设置页文案（不带单位，界面里拼「帧」）。 */
export function fpsLabel(v = current) {
  const hit = FPS_OPTIONS.find(([x]) => x === normalize(v));
  return hit ? hit[1] : String(current);
}

/**
 * 渲染循环的节流判断：这一帧该不该画。
 * 容差 1.5ms：60Hz 屏上 requestAnimationFrame 的间隔在 16.6~16.7ms 之间抖，
 * 不留容差会在 16.6 < 16.67 的那一帧误判为「还没到点」，实际掉到 30 帧。
 */
export function shouldRender(now) {
  if (!current) return true;
  const interval = 1000 / current;
  if (now - lastRenderAt < interval - 1.5) return false;
  lastRenderAt = now;
  return true;
}
