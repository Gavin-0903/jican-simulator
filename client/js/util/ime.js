// 输入法 / 剪贴板管控（需求 1.1）：所有文本输入一律「只能键入」，禁止复制粘贴、禁止中文输入法。
// 浏览器对 ime-mode 的支持很有限（Chrome 已移除、仅老 IE/Edge 生效），所以这里做了多层兜底：
//   1) CSS：client/css/components.css 里 input, textarea { ime-mode: disabled; }
//   2) 运行时：给每个输入框写 style.imeMode = 'disabled'，并在输入法组合期间打断候选框。
//   3) 剪贴板事件：copy / paste / cut 在 window 捕获阶段 preventDefault，并拦截相关快捷键。
// 注意：这会影响「任何输入框粘贴」，是需求要求的刻意行为；键入（数字 / 字母）不受影响。

const CLIP_KEYS = new Set(['KeyA', 'KeyC', 'KeyV', 'KeyX']);
const CLIP_EVENTS = ['copy', 'paste', 'cut'];

/** 把输入框统一成「英文键入」模式（autocomplete / spellcheck / ime-mode）。 */
export function forceEnglishInput(el) {
  if (!el) return el;
  if (el.setAttribute) {
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('spellcheck', 'false');
  }
  try {
    el.style.imeMode = 'disabled'; // 标准属性（多数浏览器已忽略，此处兼容老 Edge/IE）
  } catch {
    // 某些节点（如 SVG）没有可变 style，忽略
  }
  el.dataset.imeForced = '1';
  return el;
}

/** 扫描 root 下所有 input / textarea 并加固（root 自身是输入框时也生效）。 */
export function forceEnglishInputAll(root = document) {
  if (root.matches?.('input, textarea')) forceEnglishInput(root);
  for (const el of root.querySelectorAll('input, textarea')) forceEnglishInput(el);
}

/** 捕获阶段的剪贴板拦截：复制 / 剪切 / 粘贴全部禁止。 */
function blockClipboardEvent(e) {
  e.preventDefault();
  e.stopImmediatePropagation();
}

/** Ctrl/Cmd + A/C/V/X 的按键级兜底（部分浏览器 copy 事件也不触发时会漏）。 */
function blockClipboardKeys(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (!CLIP_KEYS.has(e.code)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

/** 输入法开始组合（打中文）时立刻打断：直接取消组合，候选框随之关闭，输入框不丢焦点。 */
function breakImeComposition(e) {
  const el = e.target?.closest?.('input, textarea');
  if (!el) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  // IE/老 Edge 的显式取消；其余浏览器 preventDefault 已足以阻止候选人上屏
  try {
    if (typeof e.data?.toString === 'function' && el.ownerDocument) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } catch {
    // 忽略：打断失败不影响正常键入
  }
}

let installed = false;

/** 页面级安装（幂等）：全局防护 + 动态插入的输入框自动加固。 */
export function installInputGuards() {
  if (installed) return;
  installed = true;
  const opts = { capture: true };
  for (const type of CLIP_EVENTS) window.addEventListener(type, blockClipboardEvent, opts);
  window.addEventListener('keydown', blockClipboardKeys, opts);
  window.addEventListener('compositionstart', breakImeComposition, opts);
  forceEnglishInputAll();
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node.nodeType === 1) forceEnglishInputAll(node);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
}