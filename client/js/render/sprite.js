// 角色 SVG：程序化生成，节点只创建一次，之后只改属性（transform / class / 文本）。

import { s } from '../util/dom.js';

const CLASS_COLORS = { 1: 'var(--class-1)', 2: 'var(--class-2)', 3: 'var(--class-3)' };

function textWidth(str) {
  let w = 0;
  for (const ch of str) w += /[\u0000-ÿ]/.test(ch) ? 7 : 12.5;
  return w;
}

export class ActorSprite {
  constructor(layer, entry, isPlayer) {
    this.id = entry.id;
    const role = entry.role;
    this.g = s('g', { class: `actor role-${role}${isPlayer ? ' is-player' : ''}` });
    if (role === 'student') this.g.style.setProperty('--c', CLASS_COLORS[entry.classId] ?? 'var(--accent-student)');
    this.g.append(s('ellipse', { class: 'a-shadow', cx: 0, cy: 10, rx: 13, ry: 5 }));
    this.body = s('g', { class: 'a-body' });
    this.body.append(
      s('circle', { class: 'a-torso', r: 14 }),
      s('path', { class: 'a-hair', d: 'M-6 -12.6 A14 14 0 0 0 -6 12.6 A10 10 0 0 1 -6 -12.6Z' }),
      s('path', { class: 'a-nose', d: 'M9 -4.5 L17.5 0 L9 4.5Z' }),
    );
    if (role === 'teacher') this.body.append(s('circle', { class: 'a-collar', r: 8.5 }));
    this.g.append(this.body, s('circle', { class: 'a-ring', r: 19 }));
    this.name = s('text', { class: 'a-name', y: -22, text: entry.name });
    this.status = s('text', { class: 'a-status', x: 0, y: -38 });
    this.speech = s('g', { class: 'a-speech', transform: 'translate(0 -48)' });
    this.speechRect = s('rect', { x: -20, y: -12, width: 40, height: 24, rx: 9 });
    this.speechText = s('text', { x: 0, y: 0.5 });
    this.speech.append(this.speechRect, this.speechText);
    this.speech.style.display = 'none';
    this.g.append(this.name, this.status, this.speech);
    layer.append(this.g);
    this.cache = { x: Infinity, y: Infinity, f: Infinity, visible: null, speech: null, status: null };
  }

  update(pos, data, visible) {
    const c = this.cache;
    if (visible !== c.visible) {
      this.g.style.display = visible ? '' : 'none';
      c.visible = visible;
    }
    if (!visible) return;
    if (Math.abs(pos.x - c.x) > 0.05 || Math.abs(pos.y - c.y) > 0.05) {
      this.g.setAttribute('transform', `translate(${pos.x.toFixed(1)} ${pos.y.toFixed(1)})`);
      c.x = pos.x;
      c.y = pos.y;
    }
    if (Math.abs(pos.f - c.f) > 0.005) {
      this.body.setAttribute('transform', `rotate(${((pos.f * 180) / Math.PI).toFixed(1)})`);
      c.f = pos.f;
    }
    const elim = data.st !== 'active';
    this.g.classList.toggle('is-elim', elim);
    const status = data.op === 'ask' ? '?' : '';
    if (status !== c.status) {
      this.status.textContent = status;
      c.status = status;
    }
    const sp = data.sp ?? null;
    if (sp !== c.speech) {
      c.speech = sp;
      if (sp) {
        const w = Math.min(260, textWidth(sp) + 18);
        this.speechRect.setAttribute('x', (-w / 2).toFixed(1));
        this.speechRect.setAttribute('width', w.toFixed(1));
        this.speechText.textContent = sp;
        this.speech.style.display = '';
      } else {
        this.speech.style.display = 'none';
      }
    }
  }

  setPlayer(on) {
    this.g.classList.toggle('is-player', on);
  }

  flash() {
    this.g.classList.remove('flash');
    void this.g.getBBox?.();
    this.g.classList.add('flash');
    setTimeout(() => this.g.classList.remove('flash'), 950);
  }

  remove() {
    this.g.remove();
  }
}
