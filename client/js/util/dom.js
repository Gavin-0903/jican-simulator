// 轻量 DOM 工具：h() 创建元素、图标、时间格式化。

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div.card#id', { onclick, attrs... }, ...children)
 * 文本子节点一律作为 textContent 插入（不解析 HTML，避免注入）。
 */
export function h(tag, props = {}, ...children) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || 'div');
  for (const part of rest) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else if (part[0] === '#') el.id = part.slice(1);
  }
  // 容错：不少人会写成 h('dl', child1, child2) 省略 props 对象。
  // 旧实现把 child1 当 props 遍历（HTMLElement 没有可枚举自有属性），
  // 于是它被静静丢弃 —— 表现为「容器里的第一个子节点凭空消失」。
  // 这里把「不像 props 对象」的第二参数还原成第一个子节点。
  let p = props;
  let kids = children;
  if (p !== null && p !== undefined && !isPropsObject(p)) {
    kids = [p, ...children];
    p = {};
  }
  applyProps(el, p);
  append(el, kids);
  return el;
}

/** 只有「普通对象」才配当 props；Node / 数组 / 字符串 / 数字一律按子节点处理。 */
function isPropsObject(v) {
  if (typeof v !== 'object' || v === null) return false;
  if (typeof Node !== 'undefined' && v instanceof Node) return false;
  if (Array.isArray(v)) return false;
  return true;
}

export function s(tag, props = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  // 同 h()：省略 props 时第二参数是子节点，不要当 props 吃掉。
  let p = props;
  let kids = children;
  if (p !== null && p !== undefined && !isPropsObject(p)) {
    kids = [p, ...children];
    p = {};
  }
  for (const [k, v] of Object.entries(p || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, String(v));
  }
  append(el, kids);
  return el;
}

function applyProps(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** 自绘 SVG 图标（作为 CSS 遮罩，继承 currentColor）。 */
export function icon(name, cls = '') {
  const el = document.createElement('i');
  el.className = `ico ${cls}`.trim();
  el.style.setProperty('--ico', `url(/assets/icons/${name}.svg)`);
  return el;
}

/** 把页面里 <i data-icon="x"> 占位转成图标。 */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.style.setProperty('--ico', `url(/assets/icons/${el.dataset.icon}.svg)`);
  }
}

export function kbd(text) {
  return h('span.kbd', { text });
}

export function fmtClock(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export function fmtAgo(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  if (t < 5) return '刚刚';
  if (t < 60) return `${t} 秒前`;
  return `${Math.floor(t / 60)} 分钟前`;
}

export function fmtSigned(n) {
  return n > 0 ? `+${n}` : String(n);
}

export const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 隐私模式等不可用时忽略 */
    }
  },
};
