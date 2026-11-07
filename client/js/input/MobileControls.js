// 移动端操作层：左下虚拟摇杆负责移动，右下技能按钮负责交互 / 提问 / 讨好 / JC / 积分 / 商店 / 统计。
// 只在判定为移动端时挂载；桌面端完全不创建节点，键鼠逻辑不受影响。

import { PHASE } from '/shared/constants.js';
import { h, icon } from '../util/dom.js';
import { platformInfo } from '../util/platform.js';

const BUTTONS = [
  { act: 'e', label: '交互', icon: 'hand', primary: true },
  { act: 'tab', label: '统计', icon: 'eye' },
  { act: 'q', label: '提问', icon: 'question' },
  { act: 'f', label: '讨好', icon: 'heart' },
  { act: 'j', label: 'JC', icon: 'target' },
  { act: 'v', label: '积分', icon: 'coin' },
  { act: 'b', label: '商店', icon: 'bolt' },
];

const DEAD_ZONE = 0.18;

export class MobileControls {
  constructor({ container, store, input, ui }) {
    this.container = container;
    this.store = store;
    this.input = input;
    this.ui = ui;
    this.root = null;
    this.stick = null;
    this.knob = null;
    this.buttons = new Map();
    this.dragging = false;
    this.pointerId = null;
    this.disabledState = '';
    this.pickHidden = null;
    this.stickMovable = null;
    if (!platformInfo().mobile) return;
    this.mount();
    window.addEventListener('blur', () => this.releaseStick());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseStick();
    });
    store.addEventListener('phase', () => this.releaseStick());
    window.addEventListener('pointermove', (e) => this.onWindowMove(e));
    window.addEventListener('pointerup', (e) => this.onWindowUp(e));
    window.addEventListener('pointercancel', (e) => this.onWindowUp(e));
  }

  mount() {
    if (!this.container) return;
    this.stick = h('div.mc-stick#mobile-stick', { role: 'application', 'aria-label': '移动摇杆' },
      h('div.mc-stick-ring'),
      h('div.mc-stick-knob#mobile-knob'),
      h('span.mc-stick-label', { text: '移动' }));
    this.knob = this.stick.querySelector('.mc-stick-knob');
    const actions = h('div.mc-actions#mobile-actions', { role: 'group', 'aria-label': '技能按钮' });
    for (const def of BUTTONS) {
      const btn = h('button.mc-btn' + (def.primary ? '.primary' : ''), {
        type: 'button',
        dataset: { act: def.act },
        'aria-label': def.label,
      }, icon(def.icon, 'sm'), h('span.mc-lb', { text: def.label }));
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        try { btn.blur(); } catch (err) { /* 忽略 */ }
        this.fire(def.act);
      });
      actions.append(btn);
      this.buttons.set(def.act, btn);
    }
    this.root = h('div.mobile-controls#mobile-controls', {}, this.stick, actions);
    this.container.append(this.root);
    this.stick.addEventListener('pointerdown', (e) => this.onStickDown(e));
    this.stick.addEventListener('contextmenu', (e) => e.preventDefault());
    this.stick.addEventListener('lostpointercapture', () => this.releaseStick());
  }

  onStickDown(e) {
    if (!this.input || !this.input.canMove || this.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    this.dragging = true;
    this.pointerId = e.pointerId;
    this.stick.classList.add('is-active');
    try { this.stick.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无法捕获 */ }
    this.updateFromPoint(e.clientX, e.clientY);
  }

  onWindowMove(e) {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    e.preventDefault();
    this.updateFromPoint(e.clientX, e.clientY);
  }

  onWindowUp(e) {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    this.releaseStick();
  }

  /** 把触点换算成 -1..1 的方向；死区内视为松开。 */
  updateFromPoint(clientX, clientY) {
    if (!this.stick || !this.knob) return;
    const rect = this.stick.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const max = rect.width * 0.3;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const len = Math.hypot(dx, dy);
    if (!len) {
      this.input.setTouchDirection(0, 0);
      this.knob.style.transform = 'translate(0px, 0px)';
      return;
    }
    const nx = dx / len;
    const ny = dy / len;
    const clamped = Math.min(len, max);
    const kx = nx * clamped;
    const ky = ny * clamped;
    this.knob.style.transform = 'translate(' + kx.toFixed(1) + 'px,' + ky.toFixed(1) + 'px)';
    const mag = clamped / max;
    if (mag < DEAD_ZONE) this.input.setTouchDirection(0, 0);
    else this.input.setTouchDirection(nx, ny);
  }

  releaseStick() {
    this.dragging = false;
    this.pointerId = null;
    if (this.stick) this.stick.classList.remove('is-active');
    if (this.knob) this.knob.style.transform = 'translate(0px, 0px)';
    if (this.input) this.input.setTouchDirection(0, 0);
  }

  setDisabled(act, off) {
    const btn = this.buttons.get(act);
    if (btn && btn.disabled !== off) btn.disabled = off;
  }

  updateButtons() {
    const st = this.store;
    const playing = st.phase === PHASE.PLAYING;
    const inGame = playing || st.phase === PHASE.PAUSED;
    const modal = !!this.ui.modalOpen;
    const me = st.me;
    const pc = !!(me && me.operatingPcId);
    const active = playing && !!me && me.status === 'active' && !modal;
    const free = active && !pc;
    const pcReady = playing && pc && !modal;
    const utility = inGame && !modal;
    const sig = (free ? '1' : '0') + (pcReady ? '1' : '0') + (utility ? '1' : '0');
    if (sig === this.disabledState) return;
    this.disabledState = sig;
    this.setDisabled('e', !free);
    this.setDisabled('q', !free);
    this.setDisabled('f', !free);
    this.setDisabled('j', !pcReady);
    this.setDisabled('v', !pcReady);
    this.setDisabled('b', !utility);
    this.setDisabled('tab', !utility);
  }

  fire(act) {
    if (this.ui.modalOpen) return;
    if (act === 'tab') return this.ui.toggleStats();
    if (act === 'b') return this.ui.toggleItemShop();
    this.input.hotkey(act);
  }

  /** 每帧调用：同步按钮可用状态、选目标时隐藏操作层、不可移动时收起摇杆。 */
  tick() {
    if (!this.root) return;
    this.updateButtons();
    const pick = !!this.input.frozenPick;
    if (pick !== this.pickHidden) {
      this.pickHidden = pick;
      this.root.classList.toggle('is-hidden', pick);
    }
    const movable = !!this.input.canMove;
    if (movable !== this.stickMovable) {
      this.stickMovable = movable;
      if (this.stick) this.stick.classList.toggle('is-off', !movable);
      if (!movable && this.dragging) this.releaseStick();
    }
  }
}
