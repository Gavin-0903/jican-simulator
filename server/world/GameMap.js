// 地图：加载纯数据地图（config/maps/*.json），派生墙体/遮挡物，构建寻路网格并提供 A* 寻路。
// 新增房间、家具、电脑只需修改 JSON，不需要改代码。

import {
  pointInRect,
  circleHitsRect,
  inflateRect,
  segmentHitsRect,
  rectCenter,
  dist,
} from '../../shared/math.js';

const SQRT2 = Math.SQRT2;

function splitInterval(a, b, gaps) {
  const sorted = [...gaps].sort((g1, g2) => g1[0] - g2[0]);
  const parts = [];
  let cur = a;
  for (const [g0, g1] of sorted) {
    if (g0 > cur) parts.push([cur, Math.min(g0, b)]);
    cur = Math.max(cur, g1);
  }
  if (cur < b) parts.push([cur, b]);
  return parts.filter(([s, e]) => e - s > 0.5);
}

/** 根据房间矩形与门洞生成墙体矩形。 */
export function buildRoomWalls(room, t) {
  if (room.walls === false) return [];
  const { x, y, w, h } = room.rect;
  const doors = room.doors || [];
  const gapsOn = (side, base) =>
    doors.filter((d) => d.side === side).map((d) => [base + d.offset, base + d.offset + d.width]);
  const walls = [];
  for (const [s, e] of splitInterval(x, x + w, gapsOn('top', x))) walls.push({ x: s, y, w: e - s, h: t });
  for (const [s, e] of splitInterval(x, x + w, gapsOn('bottom', x))) walls.push({ x: s, y: y + h - t, w: e - s, h: t });
  for (const [s, e] of splitInterval(y, y + h, gapsOn('left', y))) walls.push({ x, y: s, w: t, h: e - s });
  for (const [s, e] of splitInterval(y, y + h, gapsOn('right', y))) walls.push({ x: x + w - t, y: s, w: t, h: e - s });
  return walls.map((r) => ({ ...r, roomId: room.id }));
}

class MinHeap {
  constructor() {
    this.items = [];
    this.keys = [];
  }
  get size() {
    return this.items.length;
  }
  push(item, key) {
    const { items, keys } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      items[i] = items[p];
      keys[i] = keys[p];
      i = p;
    }
    items[i] = item;
    keys[i] = key;
  }
  pop() {
    const { items, keys } = this;
    const top = items[0];
    const lastItem = items.pop();
    const lastKey = keys.pop();
    if (items.length) {
      let i = 0;
      const n = items.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        items[i] = items[c];
        keys[i] = keys[c];
        i = c;
      }
      items[i] = lastItem;
      keys[i] = lastKey;
    }
    return top;
  }
}

export class GameMap {
  /**
   * @param {object} data 地图 JSON
   * @param {{radius:number, gridSize:number}} opts
   */
  constructor(data, opts = {}) {
    this.data = data;
    this.id = data.id;
    this.name = data.name;
    this.width = data.width;
    this.height = data.height;
    this.radius = opts.radius ?? 14;
    this.lowCoverDepth = opts.lowCoverDepth ?? 48;
    this.gridSize = opts.gridSize ?? 16;
    const t = data.wallThickness ?? 12;
    const b = data.border ?? 20;

    this.rooms = data.rooms.map((r) => ({ classId: null, buffZone: null, noJc: false, doors: [], ...r }));
    this.roomsById = Object.fromEntries(this.rooms.map((r) => [r.id, r]));

    const border = [
      { x: 0, y: 0, w: this.width, h: b },
      { x: 0, y: this.height - b, w: this.width, h: b },
      { x: 0, y: 0, w: b, h: this.height },
      { x: this.width - b, y: 0, w: b, h: this.height },
    ].map((r) => ({ ...r, roomId: null }));
    this.walls = [...border, ...this.rooms.flatMap((room) => buildRoomWalls(room, t))];
    this.furniture = (data.furniture || []).map((f) => ({ solid: true, occludes: true, roomId: null, ...f }));
    this.pcs = data.pcs.map((pc) => ({ ...pc }));
    this.pcsById = Object.fromEntries(this.pcs.map((p) => [p.id, p]));

    const deskRects = this.pcs.map((pc) => ({ ...pc.desk, pcId: pc.id }));
    this.solids = [...this.walls, ...this.furniture.filter((f) => f.solid).map((f) => f.rect), ...deskRects];
    // 视线遮挡：高遮挡物完全挡住视线；低遮挡物（桌子、沙发）只挡住紧贴其后的东西
    this.occ = {
      tall: [...this.walls, ...this.furniture.filter((f) => f.occludes === 'full' || f.occludes === true).map((f) => f.rect)],
      low: [...this.furniture.filter((f) => f.occludes === 'low').map((f) => f.rect), ...deskRects],
      depth: this.lowCoverDepth,
    };
    this.anchors = data.anchors || {};

    this.buildNavGrid();
  }

  // ------------------------------------------------------------ 查询

  roomAt(p) {
    let corridor = null;
    for (const room of this.rooms) {
      if (!pointInRect(p, room.rect)) continue;
      if (room.walls === false) corridor ??= room;
      else return room;
    }
    return corridor;
  }

  /** 圆是否处于可站立位置（不与任何实体障碍重叠）。 */
  isFree(p, radius = this.radius) {
    if (p.x < radius || p.y < radius || p.x > this.width - radius || p.y > this.height - radius) return false;
    for (const r of this.solids) if (circleHitsRect(p, radius, r)) return false;
    return true;
  }

  /** 圆沿线段 ab 扫过时是否无碰撞。 */
  segmentClear(a, b, radius = this.radius) {
    const minX = Math.min(a.x, b.x) - radius;
    const maxX = Math.max(a.x, b.x) + radius;
    const minY = Math.min(a.y, b.y) - radius;
    const maxY = Math.max(a.y, b.y) + radius;
    for (const r of this.solids) {
      if (r.x > maxX || r.x + r.w < minX || r.y > maxY || r.y + r.h < minY) continue;
      if (segmentHitsRect(a.x, a.y, b.x, b.y, inflateRect(r, radius))) return false;
    }
    return true;
  }

  randomPointInRoom(roomId, rng, inset = 24) {
    const room = this.roomsById[roomId];
    if (!room) return null;
    const { x, y, w, h } = room.rect;
    for (let i = 0; i < 30; i++) {
      const p = { x: rng.range(x + inset, x + w - inset), y: rng.range(y + inset, y + h - inset) };
      if (this.isFree(p, this.radius + 2)) return p;
    }
    const c = this.cellCenter(this.nearestWalkableCell(rectCenter(room.rect)));
    return c;
  }

  // ------------------------------------------------------------ 寻路网格

  buildNavGrid() {
    const g = this.gridSize;
    this.cols = Math.ceil(this.width / g);
    this.rows = Math.ceil(this.height / g);
    this.walkable = new Uint8Array(this.cols * this.rows);
    const inflated = this.solids.map((r) => inflateRect(r, this.radius));
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const p = { x: c * g + g / 2, y: r * g + g / 2 };
        let ok = p.x > this.radius && p.y > this.radius && p.x < this.width - this.radius && p.y < this.height - this.radius;
        if (ok) for (const rect of inflated) if (pointInRect(p, rect)) { ok = false; break; }
        this.walkable[r * this.cols + c] = ok ? 1 : 0;
      }
    }
  }

  cellOf(p) {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(p.x / this.gridSize)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(p.y / this.gridSize)));
    return r * this.cols + c;
  }

  cellCenter(idx) {
    const g = this.gridSize;
    return { x: (idx % this.cols) * g + g / 2, y: Math.floor(idx / this.cols) * g + g / 2 };
  }

  nearestWalkableCell(p, maxRing = 8) {
    const start = this.cellOf(p);
    if (this.walkable[start]) return start;
    const c0 = start % this.cols;
    const r0 = Math.floor(start / this.cols);
    let best = -1;
    let bestD = Infinity;
    for (let ring = 1; ring <= maxRing; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const r = r0 + dr;
          const c = c0 + dc;
          if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue;
          const idx = r * this.cols + c;
          if (!this.walkable[idx]) continue;
          const d = dist(this.cellCenter(idx), p);
          if (d < bestD) {
            bestD = d;
            best = idx;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * A* 寻路，返回平滑后的路点（不含起点）。不可达返回 null。
   */
  findPath(from, to) {
    if (this.segmentClear(from, to) && this.isFree(to)) return [{ x: to.x, y: to.y }];
    const start = this.nearestWalkableCell(from);
    const goal = this.nearestWalkableCell(to);
    if (start < 0 || goal < 0) return null;
    const cols = this.cols;
    const n = this.walkable.length;
    const gScore = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const gc = goal % cols;
    const gr = Math.floor(goal / cols);
    const h = (idx) => {
      const dx = Math.abs((idx % cols) - gc);
      const dy = Math.abs(Math.floor(idx / cols) - gr);
      return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
    };
    const heap = new MinHeap();
    gScore[start] = 0;
    heap.push(start, h(start));
    let found = false;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === goal) {
        found = true;
        break;
      }
      if (closed[cur]) continue;
      closed[cur] = 1;
      const c = cur % cols;
      const r = Math.floor(cur / cols);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= this.rows || nc >= cols) continue;
          const ni = nr * cols + nc;
          if (!this.walkable[ni] || closed[ni]) continue;
          if (dr && dc && (!this.walkable[r * cols + nc] || !this.walkable[nr * cols + c])) continue; // 禁止切角
          const ng = gScore[cur] + (dr && dc ? SQRT2 : 1);
          if (ng < gScore[ni]) {
            gScore[ni] = ng;
            came[ni] = cur;
            heap.push(ni, ng + h(ni));
          }
        }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let cur = goal; cur !== -1; cur = came[cur]) cells.push(this.cellCenter(cur));
    cells.reverse();
    const raw = [{ x: from.x, y: from.y }, ...cells];
    if (this.isFree(to)) raw.push({ x: to.x, y: to.y });
    return this.smooth(raw).slice(1);
  }

  /** 拉绳法路径平滑：在无碰撞前提下尽量直线连接远处路点。 */
  smooth(points) {
    if (points.length <= 2) return points;
    const out = [points[0]];
    let anchor = 0;
    while (anchor < points.length - 1) {
      let next = anchor + 1;
      for (let j = points.length - 1; j > anchor + 1; j--) {
        if (this.segmentClear(points[anchor], points[j], this.radius - 1)) {
          next = j;
          break;
        }
      }
      out.push(points[next]);
      anchor = next;
    }
    return out;
  }

  // ------------------------------------------------------------ 对前端公开

  publicView() {
    return {
      id: this.id,
      name: this.name,
      width: this.width,
      height: this.height,
      wallThickness: this.data.wallThickness ?? 12,
      rooms: this.rooms.map(({ id, type, name, rect, classId, buffZone, doors, walls }) => ({
        id, type, name, rect, classId, buffZone, doors, walls: walls !== false,
      })),
      walls: this.walls.map(({ x, y, w, h }) => ({ x, y, w, h })),
      furniture: this.furniture.map(({ id, kind, rect, solid, occludes, roomId }) => ({ id, kind, rect, solid, occludes, roomId })),
      pcs: this.pcs.map(({ id, roomId, desk, seat, owner }) => ({ id, roomId, desk, seat, owner })),
      occluders: {
        tall: this.occ.tall.map(({ x, y, w, h }) => ({ x, y, w, h })),
        low: this.occ.low.map(({ x, y, w, h, pcId }) => (pcId ? { x, y, w, h, pcId } : { x, y, w, h })),
        depth: this.occ.depth,
      },
    };
  }
}
