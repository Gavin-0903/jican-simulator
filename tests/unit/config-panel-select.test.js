import test from 'node:test';
import assert from 'node:assert/strict';

// 用户要求（m00048）：「把 online.mode 后面的换成选项（serve/funnel……）」。
// 配置面板的每一行都是 buildRow() 画出来的：普通叶子是 <input>，枚举项（online.mode /
// online.tailscale.expose）必须画成 <select>，选项还得是服务端白名单认的值。
// client/js/ui/ConfigPanel.js 在模块里直接引用 document / Node，所以先注入一个最小 DOM 桩。

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.childNodes = [];
    this.attrs = {};
    this._cls = new Set();
    this._text = '';
    this.style = { setProperty() {} };
    this.dataset = {};
    const self = this;
    this.classList = { add: (c) => self._cls.add(c), remove: () => {}, contains: (c) => self._cls.has(c) };
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text || this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.childNodes = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener() {}
  append(...nodes) {
    for (const n of nodes) this.childNodes.push(typeof n === 'string' ? { textContent: n, childNodes: [] } : n);
  }
  appendChild(n) { this.append(n); return n; }
  querySelector() { return null; }
}

globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (t) => ({ textContent: String(t), childNodes: [] }),
  createDocumentFragment: () => new FakeNode('#fragment'),
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.Node = FakeNode;
globalThis.HTMLElement = FakeNode;

const { ConfigPanel } = await import('../../client/js/ui/ConfigPanel.js');

/** buildRow() 只用到 isOverridden / busyPath（commit 在事件里，不会在这里触发）。 */
function panel() {
  return { isOverridden: () => false, busyPath: '', invalid: new Set() };
}

/** 按服务端 jsonTree 的形状造一个叶子节点：default.json 的键带 app. 前缀。 */
function leaf(path, value, type = 'string') {
  return { path, value: String(value), type, depth: 1, hasChildren: false };
}

function buildRow(node) {
  return ConfigPanel.prototype.buildRow.call(panel(), node);
}

/** buildRow 的行结构：箭头 / 键 / 冒号 / 变值 / 尾部。 */
function valueElOf(row) {
  const rowEl = row.node;
  const kids = rowEl.childNodes;
  assert.equal(kids.length, 5, '一行应该是 5 列');
  return kids[3];
}

test('online.mode 渲染成下拉选项：只有 serve / funnel（服务端 APP_RULES 白名单）', () => {
  const valueEl = valueElOf(buildRow(leaf('app.online.mode', 'serve')));
  assert.equal(valueEl.tagName, 'SELECT', 'online.mode 必须是 <select>，不能再是输入框');
  const values = valueEl.childNodes.map((o) => o.getAttribute('value'));
  assert.deepEqual(values, ['serve', 'funnel'], '选项只能是服务端认的 serve / funnel（off 会被 400 拒掉）');
  assert.equal(valueEl.value, 'serve', '当前值要落在下拉框上');
  assert.equal(valueEl.getAttribute('aria-label'), 'app.online.mode');
});

test('online.mode 当前值不在选项里时补一条展示项，不能静默跳到第一项', () => {
  const valueEl = valueElOf(buildRow(leaf('app.online.mode', 'tailnet')));
  const values = valueEl.childNodes.map((o) => o.getAttribute('value'));
  assert.deepEqual(values, ['tailnet', 'serve', 'funnel']);
  assert.equal(valueEl.value, 'tailnet');
});

test('online.tailscale.expose 也是下拉：serve / funnel / off', () => {
  const valueEl = valueElOf(buildRow(leaf('app.online.tailscale.expose', 'serve')));
  assert.equal(valueEl.tagName, 'SELECT');
  const values = valueEl.childNodes.map((o) => o.getAttribute('value'));
  assert.deepEqual(values, ['serve', 'funnel', 'off']);
});

test('其它叶子仍然是输入框，没被误改成下拉', () => {
  for (const [path, value, type] of [
    ['app.server.port', 5173, 'number'],
    ['app.online.token', '', 'string'],
    ['app.online.serverUrl', '', 'string'],
    ['app.online.enabled', false, 'boolean'],
  ]) {
    const valueEl = valueElOf(buildRow(leaf(path, value, type)));
    assert.equal(valueEl.tagName, 'INPUT', path + ' 必须还是输入框');
  }
});
