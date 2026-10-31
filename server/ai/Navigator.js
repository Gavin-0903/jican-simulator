// AI 寻路跟随：A* 路点序列 → 每 tick 产出方向意图（与玩家的 input.move 同构）。

import { dist, normalize, sub, clampLen } from '../../shared/math.js';

/**
 * 朝 goal 移动。返回 'arrived' | 'moving' | 'unreachable'。
 * @param {object} ax AI 上下文（见 RuleAIEngine.makeContext）
 */
export function navigate(ax, goal, tol = 8) {
  const { self: c, bb, map, tick } = ax;
  const nav = bb.nav;
  if (dist(c.pos, goal) <= tol) {
    ax.stop();
    nav.path = [];
    nav.goal = null;
    return 'arrived';
  }
  const goalMoved = !nav.goal || dist(nav.goal, goal) > 20;
  const canRepath = tick - nav.lastRepath >= ax.repathTicks;
  if (!nav.path.length || (goalMoved && canRepath) || nav.stuck > 12) {
    const path = map.findPath(c.pos, goal);
    nav.lastRepath = tick;
    nav.stuck = 0;
    if (!path || !path.length) {
      ax.stop();
      nav.path = [];
      nav.goal = null;
      return 'unreachable';
    }
    nav.path = path;
    nav.idx = 0;
    nav.goal = { x: goal.x, y: goal.y };
  }
  while (nav.idx < nav.path.length - 1 && dist(c.pos, nav.path[nav.idx]) < 10) nav.idx++;
  const wp = nav.path[nav.idx];
  const d = dist(c.pos, wp);
  const last = nav.idx === nav.path.length - 1;
  if (last && (d <= Math.min(tol, 6) || (d < 6 && dist(c.pos, goal) > tol))) {
    ax.stop();
    nav.path = [];
    nav.goal = null;
    return 'arrived';
  }
  let dir = normalize(sub(wp, c.pos));
  if (last && d < 18) dir = clampLen({ x: dir.x * (d / 18), y: dir.y * (d / 18) }, 1);
  ax.move(dir);
  if (dist(c.pos, nav.lastPos) < 0.3) nav.stuck++;
  else nav.stuck = 0;
  nav.lastPos = { x: c.pos.x, y: c.pos.y };
  return 'moving';
}

export function clearNav(bb) {
  bb.nav.path = [];
  bb.nav.goal = null;
  bb.nav.stuck = 0;
}
