// HUD 底部的道具栏（需求 2.1）：5 个槽位，有次数才能点。
// 快捷键 1-5（或 Shift+1..5 / 小键盘）由 InputManager 转成 ui.useItemSlot(slot) 调进来；
// freeze 需要先选目标 → 进入「选择目标」模式（由 main.js 的 targetPick 接管画面点击）。
// 一切扣费与生效都在服务端：这里只发 item.use。

import { MSG } from '/shared/constants.js';
import { h, icon } from '../util/dom.js';
import { ITEM_META, itemsConfig, slotState, canUseSlot, usesText, UNLIMITED, effectText } from './items.js';

/** 道具栏快捷键说明（SettingsPanel 与 HUD 提示共用）。 */
export const ITEM_HINTS = Object.freeze({ shop: 'B', slots: '1 – 5' });

export class ItemBar {
  constructor(root, store, net, handlers = {}) {
    this.root = root;
    this.store = store;
    this.net = net;
    this.handlers = handlers; // { onOpenShop, onBlocked, onPickTarget, onCancelPick, onHack }
    this.renderedKeys = '';
    this.root.addEventListener('click', (e) => {
      const btn = e.target.closest?.('[data-item]');
      if (btn && !btn.disabled) this.useSlot(Number(btn.dataset.slot));
    });
  }

  get items() {
    const cfg = itemsConfig(this.store);
    return cfg ? cfg.keys : [];
  }

  /** 每帧/每次快照后调用：没有配置或不在对局中时整体隐藏（优雅降级）。 */
  sync() {
    const cfg = itemsConfig(this.store);
    const me = this.store.me;
    const show = !!cfg && !!me && !!me.items;
    this.root.hidden = !show;
    if (!show) {
      if (this.renderedKeys) {
        this.renderedKeys = '';
        this.root.replaceChildren();
      }
      return;
    }
    const keys = cfg.keys.join(',');
    if (keys !== this.renderedKeys) {
      this.renderedKeys = keys;
      this.root.replaceChildren(...cfg.keys.map((id, i) => {
        const meta = ITEM_META[id] ?? { name: id, icon: 'bolt' };
        return h(`button.itembar-slot#itembar-${id}`, {
          type: 'button', dataset: { item: id, slot: String(i) },
          title: `${meta.name}（快捷键 ${i + 1}）`,
        },
        h('span.ibs-key', { text: String(i + 1) }),
        h('span.ibs-ico', {}, icon(meta.icon, 'md')),
        h('span.ibs-name', { text: meta.name }),
        h('span.ibs-uses'),
        h('span.ibs-lv'));
      }));
    }
    for (const [i, id] of cfg.keys.entries()) {
      const btn = this.root.querySelector(`#itembar-${id}`);
      if (!btn) continue;
      const itemCfg = cfg.items[id];
      const { lv, uses } = slotState(me, id);
      const maxUses = Number(itemCfg.maxUses) || UNLIMITED;
      const usable = canUseSlot(me, id, itemCfg);
      const text = usesText(uses, maxUses);
      const usesEl = btn.querySelector('.ibs-uses');
      if (usesEl.textContent !== text) usesEl.textContent = text;
      const lvText = lv > 0 ? `Lv${lv}` : '';
      const lvEl = btn.querySelector('.ibs-lv');
      if (lvEl.textContent !== lvText) lvEl.textContent = lvText;
      btn.classList.toggle('empty', lv <= 0);
      btn.classList.toggle('usable', usable);
      // 未持有：可见但不可点（提示去商店）；次数用尽仍可点，会给出明确提示
      btn.disabled = lv <= 0;
      btn.title = lv > 0
        ? `${ITEM_META[id]?.name ?? id}（快捷键 ${i + 1}）· ${effectText(id, lv, itemCfg)} · 剩余 ${text} 次`
        : `${ITEM_META[id]?.name ?? id}：还没有这件道具，按 B 打开商店`;
    }
  }

  /**
   * 点击 / 快捷键触发：按道具类型分流。
   * @returns {boolean} 是否已发出请求（或进入选择目标模式）
   */
  useSlot(i) {
    const cfg = itemsConfig(this.store);
    if (!cfg) return false;
    const id = cfg.keys[i];
    if (!id) return false;
    const me = this.store.me;
    if (!me) return false;
    const itemCfg = cfg.items[id];
    const { lv, uses } = slotState(me, id);
    if (lv <= 0) {
      this.handlers.onNeedBuy?.(id);
      return false;
    }
    if (!canUseSlot(me, id, itemCfg)) {
      this.handlers.onBlocked?.(id, lv);
      return false;
    }
    if (uses <= 0) {
      this.handlers.onBlocked?.(id, lv);
      return false;
    }
    if (id === 'freeze') {
      // 进入「选择目标」模式；真正的发送在 sendFreeze()
      this.handlers.onPickTarget?.(id);
      return true;
    }
    if (id === 'hackbook') {
      // 两步式：先只要目标列表（服务端不消耗次数），拿到 hack.targets 后再提交
      this.net.send(MSG.ITEM_USE, { itemId: 'hackbook' });
      this.handlers.onHack?.(id);
      return true;
    }
    // buyoff / password / hourglass：直接使用（装备 / 全场生效）
    this.net.send(MSG.ITEM_USE, { itemId: id });
    return true;
  }

  /** 定格手枪：选定目标后发送（targetId 由 main.js 的画面点击命中）。 */
  sendFreeze(targetId) {
    if (!targetId) return false;
    this.net.send(MSG.ITEM_USE, { itemId: 'freeze', targetId });
    return true;
  }
}
