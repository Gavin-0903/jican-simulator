// 弹窗宿主：同一时刻只显示一个弹窗；支持确认框。

import { h, icon } from '../util/dom.js';

export class ModalHost {
  constructor(root) {
    this.root = root;
    this.current = null;
  }

  get kind() {
    return this.current?.kind ?? null;
  }

  /**
   * @param {string} kind 弹窗类型（用于判断当前打开的是什么）
   * @param {{title:string, sub?:string, icon?:string, tone?:string, body:Node[], foot?:Node[], wide?:boolean, onDismiss?:Function, dismissable?:boolean}} opts
   */
  open(kind, opts) {
    this.close('replace');
    const head = h('div.modal-head', {},
      opts.icon ? h(`div.icon-wrap${opts.tone ? `.${opts.tone}` : ''}`, {}, icon(opts.icon, 'lg')) : null,
      h('div', {}, h('div.modal-title', { text: opts.title }), opts.sub ? h('div.modal-sub', { text: opts.sub }) : null),
    );
    const card = h(`div.card.modal${opts.wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
      head, h('div.modal-body', {}, ...(opts.body || [])), opts.foot?.length ? h('div.modal-foot', {}, ...opts.foot) : null);
    const overlay = h('div.overlay', {}, card);
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay && opts.dismissable !== false) this.dismiss();
    });
    this.root.append(overlay);
    this.current = { kind, overlay, card, opts };
    const focusable = card.querySelector('[autofocus], input, .btn.primary');
    setTimeout(() => focusable?.focus(), 30);
    return card;
  }

  /** 用户主动关闭（Esc / 点遮罩）：触发 onDismiss。 */
  dismiss() {
    const cur = this.current;
    if (!cur || cur.opts.dismissable === false) return false;
    this.close('dismiss');
    cur.opts.onDismiss?.();
    return true;
  }

  close() {
    if (!this.current) return;
    this.current.overlay.remove();
    this.current = null;
  }

  /** 只替换当前弹窗的 body（设置页改镜头/画面/曝光方式时用，避免整窗重建导致焦点与输入丢失）。 */
  setBody(kind, body) {
    const cur = this.current;
    if (!cur || (kind && cur.kind !== kind)) return false;
    const host = cur.card.querySelector('.modal-body');
    if (!host) return false;
    host.replaceChildren(...(body || []));
    return true;
  }

  confirm({ title, text, ok = '确定', tone = 'warn', iconName = 'warn' }) {
    return new Promise((resolve) => {
      const finish = (v) => {
        this.close();
        resolve(v);
      };
      this.open('confirm', {
        title,
        icon: iconName,
        tone,
        body: [h('div.summary-text', { text })],
        foot: [h('button.btn.ghost', { onclick: () => finish(false), text: '取消' }), h(`button.btn.${tone === 'danger' ? 'danger' : 'primary'}`, { onclick: () => finish(true), text: ok })],
        onDismiss: () => resolve(false),
      });
    });
  }
}
