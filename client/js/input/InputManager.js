// 输入：键盘 / 鼠标 / 触屏 → 方向向量与动作意图。只上报「我想做什么」，不做任何判定。

import { ACTION, MSG, PHASE } from '/shared/constants.js';
import { normalize, round2 } from '/shared/math.js';
import { findInteractable } from '../util/world.js';

const MOVE_KEYS = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};

/** 需求 1.1：Ctrl/Cmd + C/V/X/A 与 Ctrl+Insert / Shift+Insert 一律拦截（禁止复制粘贴）。 */
const CLIPBOARD_CODES = new Set(['KeyC', 'KeyV', 'KeyX', 'KeyA']);
const isClipboardCombo = (e) =>
  ((e.ctrlKey || e.metaKey) && CLIPBOARD_CODES.has(e.code)) ||
  ((e.ctrlKey || e.shiftKey) && e.code === 'Insert');

/** 数字键 1-5（含小键盘）→ 道具槽位下标；Shift+数字按主键盘上的符号位反查。 */
const DIGIT_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'];
const NUMPAD_CODES = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5'];
const SHIFT_SYMBOLS = ['!', '@', '#', '$', '%'];
/** 返回 0..4 的槽位下标；不是 1-5 键则返回 -1。 */
const itemSlotIndex = (e) => {
  const d = DIGIT_CODES.indexOf(e.code);
  if (d >= 0) return d;
  const n = NUMPAD_CODES.indexOf(e.code);
  if (n >= 0) return n;
  return SHIFT_SYMBOLS.indexOf(e.key); // Shift+1..5 在部分键盘上 key 为 "!" 等
};

export class InputManager {
  constructor({ svg, store, net, renderer, ui }) {
    this.svg = svg;
    this.store = store;
    this.net = net;
    this.renderer = renderer;
    this.ui = ui;
    this.keys = new Set();
    this.pointer = null; // { id, x, y }（屏幕坐标）
    this.lastSent = { x: 0, y: 0, face: null };
    this.lastFaceAt = 0;
    this.faceAngle = null;
    this.frozenPick = false; // 定格选目标模式：此时点击画面不移动，由 main.js 接管

    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.clear());
    svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    window.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    for (const b of document.querySelectorAll('#touch-pad [data-key]')) {
      b.addEventListener('click', () => this.hotkey(b.dataset.key));
    }
  }

  get canMove() {
    const st = this.store;
    return st.phase === PHASE.PLAYING && st.me?.status === 'active' && !st.me?.operatingPcId && !this.ui.modalOpen;
  }

  typing(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  /**
   * 是否处于「游戏内」：只有对局中（PLAYING / PAUSED）才拦剪贴板快捷键。
   * 大厅要复用 Ctrl+V 粘贴房间号 / 服务器地址，设置页要复制 ID 密钥与 Token，
   * 结算页要复制成绩——这些阶段无条件放行（与 util/ime.js 的 setTypingGuard 同口径）。
   */
  get guardTyping() {
    const p = this.store?.phase;
    return p === PHASE.PLAYING || p === PHASE.PAUSED;
  }

  onKeyDown(e) {
    // 复制/粘贴/剪切/全选：对局中无论焦点在哪一律吃掉（需求 1.1）；
    // 未进对局（大厅 / 设置 / 结算）放行，否则连粘贴房间号都做不到。
    // 先拦一道，若事件从窗口冒泡上来被这里捕获，就不再往下走
    if (this.guardTyping && isClipboardCombo(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.ui.escape();
      return;
    }
    if (this.typing(e)) return;
    if (MOVE_KEYS[e.code]) {
      e.preventDefault();
      this.keys.add(e.code);
      this.sync();
      return;
    }
    if (e.repeat) return;
    // 道具快捷键只在能用道具时生效；否则落回字母键本身（否则 B / 1-5 会被无条件吞掉）
    const itemsReady = () => {
      const st = this.store;
      const inGame = st.phase === PHASE.PLAYING || st.phase === PHASE.PAUSED;
      return inGame && !!st.me && !!st.lobby?.rules?.items;
    };
    // 道具：B 打开商店，1-5（或 Shift+1..5 / 小键盘）快捷使用对应槽位
    if (e.code === 'KeyB' && itemsReady()) {
      e.preventDefault();
      return this.ui.toggleItemShop?.();
    }
    const slot = itemSlotIndex(e);
    if (slot >= 0 && itemsReady()) {
      e.preventDefault();
      return this.ui.useItemSlot?.(slot);
    }
    // 其余热键（E/Space/Q/F/J/V/Tab/M/+/-）只在对局中生效：
    // 大厅和结算页没有任何「对局内热键」可用，继续 preventDefault 只会把 Ctrl+V 这类焦点在 body 上的组合键吃掉。
    if (!this.guardTyping) return;
    const map = { KeyE: 'e', Space: 'e', KeyQ: 'q', KeyF: 'f', KeyJ: 'j', KeyV: 'v', Tab: 'tab', KeyM: 'm', Equal: '+', NumpadAdd: '+', Minus: '-', NumpadSubtract: '-' };
    const k = map[e.code];
    if (!k) return;
    e.preventDefault();
    this.hotkey(k);
  }

  onKeyUp(e) {
    if (MOVE_KEYS[e.code]) {
      this.keys.delete(e.code);
      this.sync();
    }
  }

  hotkey(k) {
    const st = this.store;
    switch (k) {
      case 'tab': return this.ui.toggleStats();
      case 'm': return this.ui.toggleCamera();
      case '+':
      case '-': return this.ui.stepSpeed(k === '+' ? 1 : -1);
      default: break;
    }
    if (st.phase !== PHASE.PLAYING || !st.me) return;
    const me = st.me;
    if (k === 'v' && me.operatingPcId) return this.net.action(ACTION.VIEW_SCORE);
    if (k === 'j' && me.operatingPcId) return this.net.action(ACTION.JC_OPEN, { pcId: me.operatingPcId });
    if (this.ui.modalOpen || me.operatingPcId) return;
    // 用最新的权威位置计算交互目标（不依赖渲染循环，后台标签页也可用）
    const target = findInteractable(st, st.myChar());
    if (k === 'e') {
      if (!target) return;
      if (target.kind === 'pc') return this.net.action(ACTION.ENTER_PC, { pcId: target.id });
      if (target.kind === 'inspect') return this.net.action(ACTION.INSPECT_PC, { pcId: target.id });
      if (target.kind === 'teacher') return this.ui.teacherMenu.show(target);
    }
    if (k === 'q') return this.ui.teacherMenu.ask(target?.kind === 'teacher' ? target.id : null);
    if (k === 'f') return this.ui.teacherMenu.flatter(target?.kind === 'teacher' ? target.id : null);
  }

  onPointerDown(e) {
    if (this.frozenPick) return; // 选目标模式：交给 main.js 的 targetPick
    if (e.button !== 0 || !this.canMove) return;
    this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      this.svg.setPointerCapture?.(e.pointerId);
    } catch {
      // 合成事件或指针已释放时无法捕获，不影响移动
    }
    this.sync();
  }

  onPointerMove(e) {
    if (this.frozenPick) return;
    if (this.pointer && e.pointerId === this.pointer.id) {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.sync();
      return;
    }
    // 老师：鼠标控制朝向（扇形视野指向鼠标）
    if (this.store.me?.role === 'teacher' && e.pointerType === 'mouse') {
      const me = this.store.myChar();
      const w = this.renderer.toWorld(e.clientX, e.clientY);
      if (!me || !w) return;
      this.faceAngle = Math.atan2(w.y - me.y, w.x - me.x);
      const now = performance.now();
      if (now - this.lastFaceAt > 110) {
        this.lastFaceAt = now;
        this.sync();
      }
    }
  }

  onPointerUp(e) {
    if (this.pointer && e.pointerId === this.pointer.id) {
      this.pointer = null;
      this.sync();
    }
  }

  clear() {
    this.keys.clear();
    this.pointer = null;
    this.sync(true);
  }

  direction() {
    if (!this.canMove) return { x: 0, y: 0 };
    let x = 0;
    let y = 0;
    for (const code of this.keys) {
      x += MOVE_KEYS[code][0];
      y += MOVE_KEYS[code][1];
    }
    if (x || y) return normalize({ x, y });
    if (this.pointer) {
      const me = this.store.myChar();
      const w = this.renderer.toWorld(this.pointer.x, this.pointer.y);
      if (me && w) {
        const dx = w.x - me.x;
        const dy = w.y - me.y;
        const d = Math.hypot(dx, dy);
        if (d > 6) return { x: dx / d, y: dy / d };
      }
    }
    return { x: 0, y: 0 };
  }

  /** 方向或朝向变化时才上报（去重）。 */
  sync(force = false) {
    const dir = this.direction();
    const d = { x: round2(dir.x), y: round2(dir.y) };
    const face = this.store.me?.role === 'teacher' && this.faceAngle != null && !d.x && !d.y ? round2(this.faceAngle) : null;
    const l = this.lastSent;
    if (!force && d.x === l.x && d.y === l.y && face === l.face) return;
    if (this.store.phase !== PHASE.PLAYING) return;
    const payload = { dir: d };
    if (face !== null) payload.face = face;
    if (this.net.send(MSG.MOVE, payload)) this.lastSent = { ...d, face };
  }

  /** 需求 2.1：定格目标选择模式 —— 直接点画面里的角色（命中判定在 main.js 的 targetPick）。 */
  setFrozenPick(on) {
    this.frozenPick = !!on;
    this.pointer = null;
    this.svg.style.cursor = on ? 'crosshair' : '';
    if (on) this.sync(true);
  }

  /** 每帧调用：鼠标按住时玩家在移动，方向需要随位置持续更新。 */
  tick() {
    if (this.pointer) this.sync();
    else if (!this.canMove && (this.lastSent.x || this.lastSent.y)) this.sync();
  }
}

