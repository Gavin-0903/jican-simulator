// 主渲染器：静态层一次绘制；动态层按 requestAnimationFrame 差分更新（节点复用，只改属性）。
// 逻辑 10 Hz，渲染 60 FPS：角色位置在两次权威快照之间做线性插值。

import { PHASE } from '/shared/constants.js';
import { bodyVisible, dist, degToRad } from '/shared/math.js';
import { s } from '../util/dom.js';
import { createLayers } from './layers.js';
import { ActorSprite } from './sprite.js';
import { Effects } from './effects.js';
import { VisionLayer } from './vision.js';
import { findInteractable } from '../util/world.js';

const INTERP_DELAY = 110;
const FLOOR_PATTERN = { classroom: 'pat-classroom', office: 'pat-office', toilet: 'pat-toilet', chatroom: 'pat-chatroom', corridor: 'pat-corridor' };
const SYMBOL_ROUND = new Set(['plant', 'tree', 'pillar']);

export class SvgRenderer {
  constructor(svg, store) {
    this.svg = svg;
    this.store = store;
    this.sprites = new Map();
    this.pcNodes = new Map();
    this.cameraMode = 'follow';
    this.cam = { x: 960, y: 540, w: 1920, h: 1080 };
    this.lastFrame = performance.now();
    this.interactable = null;
    this.showCones = true;
  }

  async init(map) {
    this.map = map;
    this.svg.setAttribute('viewBox', `0 0 ${map.width} ${map.height}`);
    await this.loadArt('/assets/maps/default.svg');
    this.layers = createLayers(this.svg);
    this.drawStatic();
    this.drawPcs();
    this.vision = new VisionLayer(this.layers, map);
    this.effects = new Effects(this.layers.fx);
    this.buildOverlay();
    this.cam = { x: map.width / 2, y: map.height / 2, w: map.width, h: map.height };
  }

  async loadArt(url) {
    try {
      const text = await (await fetch(url)).text();
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const defs = doc.querySelector('defs');
      if (defs) this.svg.append(document.importNode(defs, true));
    } catch {
      // 美术资源加载失败时退化为纯色块，不影响游玩
    }
  }

  // ------------------------------------------------------------ 静态层

  drawStatic() {
    const { bg, zones, walls, labels } = this.layers;
    const m = this.map;
    bg.append(s('rect', { x: 0, y: 0, width: m.width, height: m.height, fill: 'url(#pat-yard)' }));
    for (const r of m.rooms) {
      const { x, y, w, h } = r.rect;
      bg.append(s('rect', { x, y, width: w, height: h, rx: r.walls ? 4 : 0, fill: `url(#${FLOOR_PATTERN[r.type] ?? 'pat-yard'})` }));
      if (r.buffZone) zones.append(s('rect', { class: `zone-pulse zone-${r.buffZone.kind}`, x: x + 12, y: y + 12, width: w - 24, height: h - 24, rx: 10 }));
      if (r.walls) {
        labels.append(s('text', { class: 'room-label', x: x + 18, y: y + 32, text: r.name }));
        const sub = r.type === 'toilet' ? '停留 3 秒 速度 +10%' : r.type === 'chatroom' ? '全属性 +0.01%/秒' : r.type === 'office' ? '老师身边停留 10 秒可提问' : '';
        if (sub) labels.append(s('text', { class: 'room-label-sub', x: x + 18, y: y + 48, text: sub }));
      } else {
        labels.append(s('text', { class: 'room-label', x: x + 24, y: y + h / 2 + 5, text: r.name, opacity: 0.55 }));
      }
      for (const d of r.doors || []) {
        const t = m.wallThickness;
        let x1, y1, x2, y2;
        if (d.side === 'top' || d.side === 'bottom') {
          x1 = x + d.offset + 4; x2 = x + d.offset + d.width - 4;
          y1 = y2 = d.side === 'top' ? y + t / 2 : y + h - t / 2;
        } else {
          y1 = y + d.offset + 4; y2 = y + d.offset + d.width - 4;
          x1 = x2 = d.side === 'left' ? x + t / 2 : x + w - t / 2;
        }
        walls.append(s('line', { class: 'room-door', x1, y1, x2, y2 }));
      }
    }
    for (const w of m.walls) walls.append(s('rect', { class: 'room-wall', x: w.x, y: w.y, width: w.w, height: w.h, rx: 2 }));
    for (const f of m.furniture) {
      const { x, y, w, h } = f.rect;
      const node = s('use', { href: `#sym-${f.kind}`, x, y, width: w, height: h });
      if (SYMBOL_ROUND.has(f.kind)) node.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      walls.append(node);
    }
  }

  drawPcs() {
    for (const pc of this.map.pcs) {
      const { desk, seat } = pc;
      const cx = desk.x + desk.w / 2;
      const g = s('g', { class: 'pc', 'data-pc': pc.id });
      g.append(
        s('use', { href: '#sym-chair', x: seat.x - 9, y: seat.y - 6, width: 18, height: 18 }),
        s('use', { href: '#sym-desk', x: desk.x, y: desk.y, width: desk.w, height: desk.h }),
        s('use', { href: '#sym-monitor', x: cx - 15, y: desk.y + 3, width: 30, height: 14 }),
        s('rect', { class: 'pc-mark', x: desk.x - 5, y: desk.y - 5, width: desk.w + 10, height: desk.h + 34, rx: 8 }),
        s('circle', { class: 'pc-ring', cx, cy: desk.y + desk.h / 2 + 8, r: 26 }),
        s('text', { class: 'pc-label', x: cx, y: desk.y - 3, 'text-anchor': 'middle', text: pc.owner.role === 'student' ? `${pc.owner.classId}-${String(pc.owner.index).padStart(2, '0')}` : '教师' }),
      );
      this.layers.pcs.append(g);
      this.pcNodes.set(pc.id, { g, cls: '' });
    }
  }

  buildOverlay() {
    this.hint = s('g', { style: 'display:none' });
    const bob = s('g', { class: 'hint-bubble' });
    bob.append(s('rect', { x: -12, y: -12, width: 24, height: 24, rx: 7 }), s('text', { x: 0, y: 0, text: 'E' }));
    this.hint.append(bob);
    this.progress = s('g', { style: 'display:none' });
    this.progressBg = s('circle', { class: 'progress-ring-bg', r: 24 });
    this.progressArc = s('circle', { class: 'progress-ring', r: 24 });
    this.progress.append(this.progressBg, this.progressArc);
    this.layers.overlay.append(this.progress, this.hint);
  }

  // ------------------------------------------------------------ 动态层

  ensureSprites() {
    const playerId = this.store.playerId;
    for (const id of this.store.chars.keys()) {
      let sp = this.sprites.get(id);
      const entry = this.store.rosterEntry(id);
      if (!entry) continue;
      if (!sp) {
        sp = new ActorSprite(this.layers.actors, entry, id === playerId);
        this.sprites.set(id, sp);
      }
      sp.setPlayer(id === playerId);
    }
    for (const [id, sp] of this.sprites) {
      if (!this.store.chars.has(id)) {
        sp.remove();
        this.sprites.delete(id);
      }
    }
  }

  setCameraMode(mode) {
    this.cameraMode = mode;
  }

  toggleCamera() {
    this.cameraMode = this.cameraMode === 'follow' ? 'overview' : 'follow';
    return this.cameraMode;
  }

  /** 屏幕坐标 → 世界坐标。 */
  toWorld(clientX, clientY) {
    const ctm = this.svg.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  frame(now) {
    if (!this.map) return;
    const dt = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    const st = this.store;
    const renderTime = now - INTERP_DELAY;
    const me = st.myChar();
    const mine = st.me;
    const inRound = st.phase === PHASE.PLAYING || st.phase === PHASE.PAUSED;
    const mePos = me ? st.sample(me.id, renderTime) : null;
    const fogOn = inRound && me && me.st === 'active' && mePos;
    const viewR = (st.lobby?.rules?.viewRadius ?? 380) * (mine?.attrMul?.vision ?? 1);
    if (fogOn) this.vision.update(mePos, viewR, me.pc ?? null);
    else this.vision.clear();

    const occ = this.map.occluders;
    const cones = [];
    const teacherVision = st.lobby?.rules?.teacherVision ?? { radius: 260, halfAngleDeg: 60 };
    for (const [id, entry] of st.chars) {
      const sp = this.sprites.get(id);
      if (!sp) continue;
      const pos = st.sample(id, renderTime);
      const data = entry.data;
      let visible = true;
      if (fogOn && id !== me.id) {
        visible = data.st === 'active' && dist(mePos, pos) <= viewR && bodyVisible(mePos, pos, occ, 9.8, data.pc ?? null);
      }
      sp.update(pos, data, visible);
      const role = st.rosterEntry(id)?.role;
      if (this.showCones && role === 'teacher' && data.st === 'active' && visible && inRound) {
        const isMe = me && id === me.id;
        cones.push({ id, x: pos.x, y: pos.y, f: pos.f, radius: teacherVision.radius * (isMe ? mine?.attrMul?.vision ?? 1 : 1), halfAngle: degToRad(teacherVision.halfAngleDeg), mine: isMe });
      }
    }
    this.vision.updateCones(cones);
    this.updatePcs(me);
    this.updateOverlay(me, mePos, inRound);
    this.updateCamera(mePos, dt, inRound);
  }

  updatePcs(me) {
    const homePc = me ? this.store.rosterEntry(me.id)?.homePcId : null;
    for (const pc of this.map.pcs) {
      const node = this.pcNodes.get(pc.id);
      const op = this.store.pcs.get(pc.id)?.op ?? null;
      const owner = this.store.pcOwner?.get(pc.id)?.id;
      let cls = 'pc';
      if (op) cls += op === owner ? ' busy-own' : ' busy-other';
      if (pc.id === homePc) cls += ' mine';
      if (cls !== node.cls) {
        node.g.setAttribute('class', cls);
        node.cls = cls;
      }
    }
  }

  updateOverlay(me, mePos, inRound) {
    const target = inRound && this.store.phase === PHASE.PLAYING ? findInteractable(this.store, mePos) : null;
    this.interactable = target;
    if (target) {
      this.hint.setAttribute('transform', `translate(${target.x.toFixed(1)} ${(target.y - 40).toFixed(1)})`);
      this.hint.style.display = '';
    } else {
      this.hint.style.display = 'none';
    }
    const mine = this.store.me;
    let progress = null;
    if (inRound && mine && mePos) {
      const askMs = this.store.lobby?.rules?.askDwellMs ?? 10000;
      if (mine.asking) progress = { p: Math.min(1, mine.asking.ms / askMs), cls: 'ask' };
      else if (mine.toiletMs > 0) progress = { p: Math.min(1, mine.toiletMs / 3000), cls: 'toilet' };
    }
    if (progress) {
      const C = 2 * Math.PI * 24;
      this.progress.setAttribute('transform', `translate(${mePos.x.toFixed(1)} ${mePos.y.toFixed(1)})`);
      this.progressArc.setAttribute('class', `progress-ring ${progress.cls}`);
      this.progressArc.setAttribute('stroke-dasharray', `${(C * progress.p).toFixed(1)} ${C.toFixed(1)}`);
      this.progress.style.display = '';
    } else {
      this.progress.style.display = 'none';
    }
  }

  updateCamera(mePos, dt, inRound) {
    const m = this.map;
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const aspect = rect.width / rect.height;
    let target;
    if (this.cameraMode === 'follow' && inRound && mePos) {
      // 屏幕像素/世界单位：桌面约 0.9；竖屏手机至少 0.75，保证角色足够大
      const scale = Math.max(0.75, Math.min(rect.width, rect.height * (16 / 9)) / (m.width / 1.75));
      let w = rect.width / scale;
      let h = w / aspect;
      if (h > m.height) {
        h = m.height;
        w = h * aspect;
      }
      const cx = w >= m.width ? m.width / 2 : Math.min(m.width - w / 2, Math.max(w / 2, mePos.x));
      const cy = h >= m.height ? m.height / 2 : Math.min(m.height - h / 2, Math.max(h / 2, mePos.y));
      target = { x: cx, y: cy, w, h };
    } else {
      target = { x: m.width / 2, y: m.height / 2, w: m.width, h: m.height };
    }
    const k = 1 - Math.exp(-dt / 140);
    const c = this.cam;
    c.x += (target.x - c.x) * k;
    c.y += (target.y - c.y) * k;
    c.w += (target.w - c.w) * k;
    c.h += (target.h - c.h) * k;
    this.svg.setAttribute('viewBox', `${(c.x - c.w / 2).toFixed(1)} ${(c.y - c.h / 2).toFixed(1)} ${c.w.toFixed(1)} ${c.h.toFixed(1)}`);
  }

  // ------------------------------------------------------------ 事件特效

  playEvents(events) {
    const st = this.store;
    const me = st.playerId;
    const posOf = (id) => {
      const e = st.chars.get(id);
      return e ? { x: e.data.x, y: e.data.y } : null;
    };
    for (const e of events) {
      switch (e.type) {
        case 'jc_success': {
          const p = e.pos ?? posOf(e.actorId);
          if (!p) break;
          this.effects.floatText(p.x, p.y, `+${e.amount}`, 'plus');
          const victim = posOf(e.targetId);
          const victimSprite = this.sprites.get(e.targetId);
          if (victim && victimSprite?.cache.visible) {
            this.effects.line(p.x, p.y, victim.x, victim.y);
            this.effects.floatText(victim.x, victim.y, `-${e.amount}`, 'minus');
            victimSprite.flash();
          }
          break;
        }
        case 'jc_victim': {
          const p = posOf(me);
          this.sprites.get(me)?.flash();
          if (p) this.effects.ring(p.x, p.y, 24);
          break;
        }
        case 'teacher_catch': {
          const sp = posOf(e.targetId);
          const tp = posOf(e.actorId);
          if (sp && (this.sprites.get(e.targetId)?.cache.visible || e.targetId === me || e.actorId === me)) {
            this.effects.ring(sp.x, sp.y, 30);
            this.effects.floatText(sp.x, sp.y, `-${e.penalty}`, 'minus');
            this.sprites.get(e.targetId)?.flash();
            if (tp) this.effects.line(tp.x, tp.y, sp.x, sp.y, 'red');
          }
          break;
        }
        case 'score_changed': {
          const p = posOf(e.actorId);
          if (p && e.actorId === me) this.effects.floatText(p.x, p.y, e.amount >= 0 ? `+${e.amount}` : String(e.amount), e.amount >= 0 ? 'good' : 'minus');
          break;
        }
        case 'salary_changed': {
          const p = posOf(e.actorId);
          if (p && e.actorId === me) this.effects.floatText(p.x, p.y, `${e.amount}￥`, 'minus');
          break;
        }
        case 'buff_gained': {
          const p = posOf(e.actorId);
          if (p) this.effects.ring(p.x, p.y, 22, 'ok');
          break;
        }
        case 'inspect_clear':
          if (e.pos) this.effects.ring(e.pos.x, e.pos.y, 22, 'info');
          break;
        case 'eliminated': {
          const p = e.pos ?? posOf(e.actorId);
          if (p) this.effects.ring(p.x, p.y, 34);
          break;
        }
        default:
          break;
      }
    }
  }
}
