// 输入法 / 剪贴板管控（需求 1.1）：进入对局后「只能键入」，禁止复制粘贴、禁止中文输入法。
// 未进入对局（大厅 / 服务器控制台 / 设置页 / 结算页）不禁用——那里玩家要复制房间号、联机地址和 Token，
// 无差别拦截会让「复制」按钮之外的一切操作都变别扭，也不符合原始需求（要求约束的是游戏内文本输入）。
// 浏览器对 ime-mode 的支持很有限（Chrome 已移除、仅老 IE/Edge 生效），所以这里做了多层兜底：
//   1) CSS：client/css/components.css 里 input, textarea { ime-mode: disabled; }（未进对局时由
//      documentElement.dataset.typingGuard = 'off' 整体关掉）
//   2) 运行时：给每个输入框写 style.imeMode = 'disabled'，并在输入法组合期间打断候选框。
//   3) 剪贴板事件：copy / paste / cut 在 window 捕获阶段 preventDefault，并拦截相关快捷键。
// 开关由 client/js/main.js 在阶段变化时调用 setTypingGuard(on)，阶段口径在 util/typing-guard.js。

const CLIP_KEYS = new Set(['KeyA', 'KeyC', 'KeyV', 'KeyX']);
const CLIP_EVENTS = ['copy', 'paste', 'cut'];

/** 当前是否处于「禁止复制粘贴 + 强制英文」状态。默认关（未进对局）。 */
let armed = false;

/** 查询当前状态（调试 / 测试用）。 */
export function isTypingGuardOn() {
  return armed;
}

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

/** 捕获阶段的剪贴板拦截：复制 / 剪切 / 粘贴全部禁止。未武装时直接放行。 */
function blockClipboardEvent(e) {
  if (!armed) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

/** Ctrl/Cmd + A/C/V/X 的按键级兜底（部分浏览器 copy 事件也不触发时会漏）。未武装时放行。 */
function blockClipboardKeys(e) {
  if (!armed) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  if (!CLIP_KEYS.has(e.code)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

/** 输入法开始组合（打中文）时立刻打断：直接取消组合，候选框随之关闭，输入框不丢焦点。 */
function breakImeComposition(e) {
  if (!armed) return;
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

/**
 * 开关「游戏内输入管控」：
 * - true：拦截 copy/cut/paste、Ctrl+A/C/V/X、打断中文输入法，并给已存在的输入框加 ime-mode。
 * - false：全部放行（大厅 / 设置页 / 结算页要能正常复制房间号与 Token）。
 * 幂等：重复设置同一状态不做事。
 */
export function setTypingGuard(on) {
  const next = Boolean(on);
  if (installed && next === armed) return armed;
  armed = next;
  try {
    // CSS 也用这个标记兜住 ime-mode（现代浏览器忽略了 IMEMode，但老 Edge 仍认）
    if (document.documentElement) {
      document.documentElement.dataset.typingGuard = armed ? 'on' : 'off';
    }
  } catch {
    // 忽略：无 document 环境（单测）
  }
  if (armed) forceEnglishInputAll();
  return armed;
}

/** 页面级安装（幂等）：装好监听器 + 跟踪动态插入的输入框；是否拦截由 setTypingGuard 决定。 */
export function installInputGuards() {
  if (installed) return;
  installed = true;
  const opts = { capture: true };
  for (const type of CLIP_EVENTS) window.addEventListener(type, blockClipboardEvent, opts);
  window.addEventListener('keydown', blockClipboardKeys, opts);
  window.addEventListener('compositionstart', breakImeComposition, opts);
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
  setTypingGuard(false); // 默认不拦：没进对局前复制粘贴必须可用
}
