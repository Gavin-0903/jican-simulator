import test from 'node:test';
import assert from 'node:assert/strict';

// clint/js/util/dom.js 在函数体内引用 document / Node，这里搭一个最小 DOM 桩先注入全局，
// 再动态 import —— 这样 h() 的核心契约（props 与子节点的位置）能在 Node 里被回归测试覆盖。
class FakeNode {
  constructor(type) {
    this.nodeType = type;
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = {};
    this._cls = new Set();
    this._text = '';
    const self = this;
    this.classList = {
      add: (c) => self._cls.add(c),
      contains: (c) => self._cls.has(c),
    };
    this.style = { setProperty() {} };
    this.dataset = {};
  }
  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    if (this.nodeType === 3) {
      this._text = String(v);
      return;
    }
    this.childNodes = [new FakeNode(3)];
    this.childNodes[0]._text = String(v);
    this.childNodes[0].parentNode = this;
  }
  get className() {
    return [...this._cls].join(' ');
  }
  set className(v) {
    this._cls = new Set(String(v).split(/\\s+/).filter(Boolean));
  }
  get id() {
    return this.attrs.id || '';
  }
  set id(v) {
    this.attrs.id = v;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener() {}
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? textNode(n) : n;
      if (node.parentNode) {
        node.parentNode.childNodes = node.parentNode.childNodes.filter((c) => c !== node);
      }
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  /** 只给测试用：方便写断言。 */
  get elementChildren() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
}

function textNode(s) {
  const n = new FakeNode(3);
  n._text = String(s);
  return n;
}

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (name) => {
    const el = new FakeNode(1);
    el.tagName = String(name).toUpperCase();
    return el;
  },
  createTextNode: (s) => textNode(s),
  createElementNS: (ns, name) => {
    const el = new FakeNode(1);
    el.tagName = String(name).toUpperCase();
    return el;
  },
};

const { h } = await import('../../client/js/util/dom.js');

test('h: 省略 props 时第二参数是子节点，不能被吞（回归：ID 密钥「来源路径」整行消失）', () => {
  const dt = h('dt', { text: 'a' });
  const dd = h('dd', { text: 'b' });
  const dl = h('dl', dt, dd);
  assert.equal(dl.childNodes.length, 2, '两个子节点都要在（修复前只剩 1 个）');
  assert.equal(dl.elementChildren[0].tagName, 'DT');
  assert.equal(dl.textContent, 'ab');
});

test('h: 正常 props 写法不受影响（props 仍生效、子节点不丢）', () => {
  const el = h('div.card#x', { text: 'hi' }, h('span', { text: '!' }));
  assert.equal(el.className, 'card');
  assert.equal(el.id, 'x');
  assert.equal(el.childNodes.length, 2, 'text 与 span 都在：text 是 props 设置而非子节点');
  assert.equal(el.elementChildren.length, 1);
  assert.equal(el.elementChildren[0].tagName, 'SPAN');
});

test('h: 字符串/数字当第二参数时按子节点处理', () => {
  const el = h('div', 'a', 'b');
  assert.equal(el.childNodes.length, 2);
  assert.equal(el.textContent, 'ab');
});

test('h: 数组当第二参数时展开为多个子节点', () => {
  const el = h('div', [h('i', {}), h('b', {})]);
  assert.equal(el.childNodes.length, 2);
});

test('h: 空/未定义的第二参数仍按 props 处理，不产生幽灵子节点', () => {
  const el = h('div', null, h('span', {}));
  assert.equal(el.childNodes.length, 1);
  assert.equal(el.elementChildren[0].tagName, 'SPAN');
});
