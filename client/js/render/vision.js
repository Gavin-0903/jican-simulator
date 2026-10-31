// 视野渲染：玩家视线遮罩（被墙/桌子等遮挡的区域显示为黑色）+ 老师视野扇形（同样被遮挡物裁切）。

import { s } from '../util/dom.js';
import { polygonPath, rectsToSegments, visibilityPolygon, lowCoverShadow, dist, angleDiff } from '/shared/math.js';

export class VisionLayer {
  constructor(layers, map) {
    this.map = map;
    this.outer = `M0 0H${map.width}V${map.height}H0Z`;
    this.fog = s('path', { class: 'fog', d: '' });
    this.edge = s('path', { class: 'fog-edge', d: '' });
    this.shadow = s('path', { class: 'fog low-shadow', d: '' });
    layers.fog.append(this.fog, this.edge);
    layers.lowshadow.append(this.shadow);
    this.conesLayer = layers.cones;
    this.cones = new Map();
    // 高遮挡物（墙、隔板、柜子…）的边用于计算可见多边形；低遮挡物（桌子、沙发）只投下短阴影
    this.occ = map.occluders;
    this.segs = rectsToSegments(this.occ.tall);
    this.last = null;
    this.poly = null;
    this.enabled = false;
  }

  /** 更新玩家视野遮罩；返回可见多边形。 */
  update(origin, radius, skipPcId = null) {
    const l = this.last;
    if (!this.enabled || !l || dist(l.origin, origin) > 0.6 || Math.abs(l.radius - radius) > 0.5 || l.skip !== skipPcId) {
      this.poly = visibilityPolygon(origin, radius, this.segs, { rays: 120 });
      const p = polygonPath(this.poly);
      this.fog.setAttribute('d', this.outer + p);
      this.edge.setAttribute('d', p);
      let shadows = '';
      for (const r of this.occ.low) {
        if (r.pcId && r.pcId === skipPcId) continue;
        if (dist(origin, { x: r.x + r.w / 2, y: r.y + r.h / 2 }) > radius + 40) continue;
        const poly = lowCoverShadow(origin, r, this.occ.depth);
        if (poly) shadows += polygonPath(poly);
      }
      this.shadow.setAttribute('d', shadows);
      this.last = { origin: { ...origin }, radius, skip: skipPcId };
    }
    if (!this.enabled) {
      this.fog.style.display = '';
      this.edge.style.display = '';
      this.shadow.style.display = '';
      this.enabled = true;
    }
    return this.poly;
  }

  clear() {
    if (!this.enabled) return;
    this.enabled = false;
    this.fog.style.display = 'none';
    this.edge.style.display = 'none';
    this.shadow.style.display = 'none';
    this.last = null;
  }

  /** list: [{ id, x, y, f, radius, halfAngle, mine }] */
  updateCones(list) {
    const seen = new Set();
    for (const c of list) {
      seen.add(c.id);
      let entry = this.cones.get(c.id);
      if (!entry) {
        entry = { path: s('path', { class: 'cone' }), last: null };
        this.conesLayer.append(entry.path);
        this.cones.set(c.id, entry);
      }
      entry.path.classList.toggle('mine', !!c.mine);
      const l = entry.last;
      if (!l || dist(l, c) > 0.6 || angleDiff(l.f, c.f) > 0.01 || l.radius !== c.radius) {
        const poly = visibilityPolygon({ x: c.x, y: c.y }, c.radius, this.segs, { facing: c.f, halfAngle: c.halfAngle, rays: 48 });
        entry.path.setAttribute('d', polygonPath(poly));
        entry.last = { x: c.x, y: c.y, f: c.f, radius: c.radius };
      }
      entry.path.style.display = '';
    }
    for (const [id, entry] of this.cones) if (!seen.has(id)) entry.path.style.display = 'none';
  }
}
