// 事件驱动特效：飘字、连线、扩散圈。全部用 CSS 动画，结束后移除节点。

import { s } from '../util/dom.js';

export class Effects {
  constructor(layer) {
    this.layer = layer;
  }

  add(node, ttl = 1600) {
    this.layer.append(node);
    setTimeout(() => node.remove(), ttl);
  }

  floatText(x, y, text, cls = 'plus') {
    this.add(s('text', { class: `fx-float ${cls}`, x, y: y - 26, text }));
  }

  line(x1, y1, x2, y2, cls = '') {
    this.add(s('line', { class: `fx-line ${cls}`, x1, y1, x2, y2 }));
  }

  ring(x, y, r = 26, cls = '') {
    this.add(s('circle', { class: `fx-ring ${cls}`, cx: x, cy: y, r }), 1200);
  }
}
