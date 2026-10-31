// 事件提示：右上角堆叠，自动消失。

import { h, icon } from '../util/dom.js';

const ICONS = { info: 'signal', ok: 'check', warn: 'warn', danger: 'warn', gold: 'sparkle' };
const MAX = 5;

export class Toast {
  constructor(root) {
    this.root = root;
  }

  show(text, type = 'info', iconName = null, ttl = 3800) {
    const el = h(`div.toast.${type}`, { role: 'status' }, icon(iconName ?? ICONS[type] ?? 'signal'), h('div', { text }));
    this.root.prepend(el);
    while (this.root.children.length > MAX) this.root.lastElementChild.remove();
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 240);
    }, ttl);
  }
}
