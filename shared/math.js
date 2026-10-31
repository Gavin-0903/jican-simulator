// 前后端共享的几何与数值工具：向量、碰撞、视线、扇形判定、可见多边形、插值。
// 全部为纯函数，服务端用于权威判定，前端用于绘制视野遮罩与插值。

export const EPS = 1e-9;
export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const round1 = (v) => Math.round(v * 10) / 10;
export const round2 = (v) => Math.round(v * 100) / 100;
export const degToRad = (d) => (d * Math.PI) / 180;

export const vec = (x = 0, y = 0) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s });
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

export function normalize(v) {
  const l = Math.hypot(v.x, v.y);
  return l < EPS ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

/** 把向量长度裁到 ≤ max。 */
export function clampLen(v, max) {
  const l = Math.hypot(v.x, v.y);
  return l > max ? { x: (v.x / l) * max, y: (v.y / l) * max } : { x: v.x, y: v.y };
}

export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export const angleDiff = (a, b) => Math.abs(wrapAngle(a - b));
export const angleTo = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);

/** 角度插值（走最短弧）。 */
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;

export function rotateToward(current, target, maxStep) {
  const d = wrapAngle(target - current);
  if (Math.abs(d) <= maxStep) return wrapAngle(target);
  return wrapAngle(current + Math.sign(d) * maxStep);
}

// ---------------------------------------------------------------- 矩形

export const pointInRect = (p, r, pad = 0) =>
  p.x > r.x - pad && p.x < r.x + r.w + pad && p.y > r.y - pad && p.y < r.y + r.h + pad;

export const inflateRect = (r, d) => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

export const rectCenter = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export const rectsOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** 圆是否与矩形重叠。 */
export function circleHitsRect(c, radius, r) {
  const nx = clamp(c.x, r.x, r.x + r.w);
  const ny = clamp(c.y, r.y, r.y + r.h);
  return (c.x - nx) ** 2 + (c.y - ny) ** 2 < radius * radius;
}

/**
 * 把圆推出所有矩形（就地修改 pos）。沿法线推出即可自然产生「贴墙滑动」。
 * @returns {boolean} 是否发生了碰撞
 */
export function resolveCircleRects(pos, radius, rects) {
  let hit = false;
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    for (const r of rects) {
      if (pos.x + radius <= r.x || pos.x - radius >= r.x + r.w || pos.y + radius <= r.y || pos.y - radius >= r.y + r.h) continue;
      const nx = clamp(pos.x, r.x, r.x + r.w);
      const ny = clamp(pos.y, r.y, r.y + r.h);
      const dx = pos.x - nx;
      const dy = pos.y - ny;
      const d2 = dx * dx + dy * dy;
      if (d2 >= radius * radius) continue;
      if (d2 > EPS) {
        const d = Math.sqrt(d2);
        const push = radius - d + 0.01;
        pos.x += (dx / d) * push;
        pos.y += (dy / d) * push;
      } else {
        // 圆心落入矩形内部：沿最短轴推出
        const left = pos.x - r.x;
        const right = r.x + r.w - pos.x;
        const top = pos.y - r.y;
        const bottom = r.y + r.h - pos.y;
        const m = Math.min(left, right, top, bottom);
        if (m === left) pos.x = r.x - radius - 0.01;
        else if (m === right) pos.x = r.x + r.w + radius + 0.01;
        else if (m === top) pos.y = r.y - radius - 0.01;
        else pos.y = r.y + r.h + radius + 0.01;
      }
      moved = true;
      hit = true;
    }
    if (!moved) break;
  }
  return hit;
}

// ---------------------------------------------------------------- 线段 / 视线

/** 线段 ab 是否穿过矩形 r（含边界）。 */
export function segmentHitsRect(ax, ay, bx, by, r) {
  return segmentRectT(ax, ay, bx, by, r) !== null;
}

/** Liang–Barsky：返回线段 ab 穿过矩形 r 的参数区间 [t0, t1]，不相交返回 null。 */
export function segmentRectT(ax, ay, bx, by, r) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - r.x, r.x + r.w - ax, ay - r.y, r.y + r.h - ay];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < EPS) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/** a 与 b 之间是否没有被「高遮挡物」（墙、隔板、柜子、柱子、树…）挡住。skipPcId 指定的电脑桌不参与。 */
export function lineOfSight(a, b, rects, skipPcId = null) {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  for (const r of rects) {
    if (r.x > maxX || r.x + r.w < minX || r.y > maxY || r.y + r.h < minY) continue;
    if (skipPcId && r.pcId === skipPcId) continue;
    if (segmentHitsRect(a.x, a.y, b.x, b.y, r)) return false;
  }
  return true;
}

/**
 * 「低矮遮挡物」（桌子、沙发）：只挡住紧贴在它后面（depth 以内）的东西，人可以越过它看到更远处。
 * 观察者自己也紧贴着它时（距离 ≤ depth）不算遮挡。
 */
export function lowCoverHides(a, b, r, depth) {
  const t = segmentRectT(a.x, a.y, b.x, b.y, r);
  if (!t) return false;
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  return (1 - t[1]) * L <= depth && t[0] * L > depth;
}

/**
 * 视线判定（高遮挡 + 低遮挡）。occ = { tall: Rect[], low: Rect[], depth: number }。
 * skipPcId：目标正在使用的电脑桌不挡住他本人。
 */
export function sightClear(a, b, occ, skipPcId = null) {
  if (!lineOfSight(a, b, occ.tall, skipPcId)) return false;
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  for (const r of occ.low) {
    if (r.x > maxX || r.x + r.w < minX || r.y > maxY || r.y + r.h < minY) continue;
    if (skipPcId && r.pcId === skipPcId) continue;
    if (lowCoverHides(a, b, r, occ.depth)) return false;
  }
  return true;
}

/**
 * 能否看见一个角色：视线连到身体中心或身体两侧任一点即算可见。
 * 角色正在使用的电脑桌（skipPcId）不会挡住他本人——坐在电脑前的人从桌子对面也看得见。
 */
export function bodyVisible(from, to, occ, bodyR = 10, skipPcId = null) {
  if (sightClear(from, to, occ, skipPcId)) return true;
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  if (d < EPS) return true;
  const px = (-(to.y - from.y) / d) * bodyR;
  const py = ((to.x - from.x) / d) * bodyR;
  return sightClear(from, { x: to.x + px, y: to.y + py }, occ, skipPcId) || sightClear(from, { x: to.x - px, y: to.y - py }, occ, skipPcId);
}

/** 凸包（Andrew 单调链），用于绘制低遮挡物投下的短阴影。 */
export function convexHull(points) {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** 低遮挡物 r 相对观察者 origin 投下的阴影多边形（含物体本身，深度 depth）；观察者紧贴物体时返回 null。 */
export function lowCoverShadow(origin, r, depth) {
  const nx = clamp(origin.x, r.x, r.x + r.w);
  const ny = clamp(origin.y, r.y, r.y + r.h);
  if (Math.hypot(origin.x - nx, origin.y - ny) <= depth) return null;
  const corners = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
  const ext = corners.map((c) => {
    const dx = c.x - origin.x;
    const dy = c.y - origin.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: c.x + (dx / l) * depth, y: c.y + (dy / l) * depth };
  });
  return convexHull([...corners, ...ext]);
}

/** 半径为 radius 的圆沿线段 ab 扫过时是否会碰到任何矩形（用于路径平滑）。 */
export function sweptCircleClear(a, b, radius, rects) {
  for (const r of rects) {
    if (segmentHitsRect(a.x, a.y, b.x, b.y, inflateRect(r, radius))) return false;
  }
  return true;
}

/**
 * 扇形视野判定。
 * @returns {{inside:boolean, d:number, angle:number}}
 */
export function inFan(origin, facing, target, radius, halfAngle) {
  const d = dist(origin, target);
  if (d > radius) return { inside: false, d, angle: Math.PI };
  if (d < EPS) return { inside: true, d, angle: 0 };
  const angle = angleDiff(facing, angleTo(origin, target));
  return { inside: angle <= halfAngle, d, angle };
}

/** 射线 o + t·(dx,dy) 与线段的交点参数 t，无交点返回 Infinity。 */
export function raySegment(ox, oy, dx, dy, s) {
  const ex = s.x2 - s.x1;
  const ey = s.y2 - s.y1;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < EPS) return Infinity;
  const px = s.x1 - ox;
  const py = s.y1 - oy;
  const t = (px * ey - py * ex) / denom;
  const u = (px * dy - py * dx) / denom;
  return t >= 0 && u >= -EPS && u <= 1 + EPS ? t : Infinity;
}

export function rectsToSegments(rects) {
  const segs = [];
  for (const r of rects) {
    const x2 = r.x + r.w;
    const y2 = r.y + r.h;
    segs.push(
      { x1: r.x, y1: r.y, x2, y2: r.y },
      { x1: x2, y1: r.y, x2, y2 },
      { x1: x2, y1: y2, x2: r.x, y2 },
      { x1: r.x, y1: y2, x2: r.x, y2: r.y },
    );
  }
  return segs;
}

/**
 * 计算以 origin 为中心、半径 radius 的可见多边形（被线段遮挡的部分剔除）。
 * 传入 facing/halfAngle 时只计算扇形，并把 origin 作为多边形首点。
 * 算法：向所有附近线段端点（±微小偏移）及均匀分布的角度发射射线，取最近交点。
 */
export function visibilityPolygon(origin, radius, segments, opts = {}) {
  const { facing = null, halfAngle = Math.PI, rays = 96 } = opts;
  const fan = facing !== null && halfAngle < Math.PI - EPS;
  const near = [];
  const r2 = radius * radius;
  for (const s of segments) {
    const minX = Math.min(s.x1, s.x2);
    const maxX = Math.max(s.x1, s.x2);
    const minY = Math.min(s.y1, s.y2);
    const maxY = Math.max(s.y1, s.y2);
    if (minX > origin.x + radius || maxX < origin.x - radius || minY > origin.y + radius || maxY < origin.y - radius) continue;
    near.push(s);
  }
  const angles = [];
  const pushAngle = (a) => {
    if (fan) {
      const rel = wrapAngle(a - facing);
      if (rel < -halfAngle || rel > halfAngle) return;
      angles.push(rel);
    } else {
      angles.push(wrapAngle(a));
    }
  };
  if (fan) {
    const n = Math.max(8, Math.ceil((rays * halfAngle) / Math.PI));
    for (let i = 0; i <= n; i++) angles.push(-halfAngle + (2 * halfAngle * i) / n);
  } else {
    for (let i = 0; i < rays; i++) angles.push(-Math.PI + (TAU * i) / rays);
  }
  for (const s of near) {
    for (const [px, py] of [[s.x1, s.y1], [s.x2, s.y2]]) {
      if ((px - origin.x) ** 2 + (py - origin.y) ** 2 > r2 * 1.1) continue;
      const a = Math.atan2(py - origin.y, px - origin.x);
      pushAngle(a - 0.0004);
      pushAngle(a);
      pushAngle(a + 0.0004);
    }
  }
  angles.sort((a, b) => a - b);
  const points = [];
  if (fan) points.push({ x: origin.x, y: origin.y });
  let last = NaN;
  for (const rel of angles) {
    if (Math.abs(rel - last) < 1e-6) continue;
    last = rel;
    const a = fan ? facing + rel : rel;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let tMin = radius;
    for (const s of near) {
      const t = raySegment(origin.x, origin.y, dx, dy, s);
      if (t < tMin) tMin = t;
    }
    points.push({ x: origin.x + dx * tMin, y: origin.y + dy * tMin });
  }
  return points;
}

/** 射线法判断点是否在多边形内。 */
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y + EPS) + a.x) inside = !inside;
  }
  return inside;
}

/** 多边形 → SVG path d 字符串。 */
export function polygonPath(poly) {
  if (!poly.length) return '';
  let d = `M${poly[0].x.toFixed(1)} ${poly[0].y.toFixed(1)}`;
  for (let i = 1; i < poly.length; i++) d += `L${poly[i].x.toFixed(1)} ${poly[i].y.toFixed(1)}`;
  return `${d}Z`;
}

/** 目击概率：距离越近越高（near → far 线性衰减）。 */
export const catchProbability = (d, radius, near = 1, far = 0.5) => lerp(near, far, clamp(d / radius, 0, 1));
