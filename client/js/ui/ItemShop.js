// 道具商店（需求 2.1）：只负责展示与上报意图，购买/升级是否生效完全由服务端 ItemSystem 判定。
// 配置来自 lobbyInfo().rules.items（契约 v0.2 §1）；服务端还没下发时 itemsConfig() 返回 null，商店直接不显示。
// 金额优先用快照里的 me.itemPrices（服务端现算），没有时用 items.js 的前端公式等价计算。

import { MSG } from '/shared/constants.js';
import { h, icon, kbd } from '../util/dom.js';
import { ITEM_META, itemsConfig, slotState, effectText, hourglassLimit, upgradePriceOf, usePriceOf, usesText, UNLIMITED } from './items.js';

export class ItemShop {
  constructor(modals, store, net) {
    this.modals = modals;
    this.store = store;
    this.net = net;
    this.onDismiss = null;
  }

  get open() {
    return this.modals.kind === 'itemShop';
  }

  /** 服务端是否已经下发道具配置（读不到就整个商店不出现）。 */
  get available() {
    return !!itemsConfig(this.store);
  }

  show(onDismiss = null) {
    const cfg = itemsConfig(this.store);
    if (!cfg) return false;
    this.onDismiss = onDismiss;
    this.modals.open('itemShop', {
      title: '道具商店',
      sub: '购买与升级立刻扣分；使用效果与扣费以服务端为准',
      icon: 'coin',
      tone: 'gold',
      wide: true,
      onDismiss: () => this.onDismiss?.(),
      body: [this.buildBody(cfg)],
      foot: [h('button.btn.primary', { onclick: () => this.close() }, '关闭', kbd('Esc'))],
    });
    return true;
  }

  close() {
    this.modals.close();
    this.onDismiss?.();
  }

  /** 购买/升级成功后原地刷新（main.js 在 dialog item_bought/item_upgraded 或快照时调用）。 */
  refresh() {
    if (!this.open) return;
    if (!itemsConfig(this.store)) return this.close();
    this.show(this.onDismiss);
  }

  /** 当前金币（学生看「上次查看的积分」，老师看工资）。 */
  purse() {
    const me = this.store.me;
    return me?.role === 'teacher' ? me?.salary : me?.lastViewedScore;
  }

  buildBody(cfg) {
    const me = this.store.me;
    const isStudent = me?.role !== 'teacher';
    const purse = this.purse();
    const keys = cfg.keys;
    return h('div.shop',
      h('div.shop-top', {},
        h('span.chip.gold', {}, icon('coin', 'sm'), isStudent ? '可用积分（上次查看）' : '工资'),
        h('span.shop-purse', { text: purse == null ? '?' : String(purse) }),
        h('span.spacer'),
        h('span.shop-note', { text: '进度条满即可升级 · 按 B 可随时开关商店' })),
      h('div.shop-grid', {}, ...keys.map((id, i) => this.card(id, cfg.items[id], me, i + 1))));
  }

  card(id, itemCfg, me, slot) {
    const meta = ITEM_META[id] ?? { name: id, icon: 'bolt', tone: 'info', desc: '' };
    const { lv, uses } = slotState(me, id);
    const maxLevel = Math.max(1, Number(itemCfg.maxLevel) || 1);
    const maxUses = Number(itemCfg.maxUses) || UNLIMITED;
    const timed = id === 'freeze' || id === 'hourglass'; // 可重复购买、按次消耗
    const owned = lv > 0;
    const canBuy = timed ? owned === false || lv < maxLevel : !owned;
    const canUp = owned && lv < maxLevel;
    // 服务端 me.itemPrices 优先（upLevel 为 null 表示不可升级）；读不到时退回本地公式等价计算
    const prices = me?.itemPrices?.[id] ?? null;
    const upPrice = prices && 'upLevel' in prices
      ? (canUp ? Number(prices.upLevel) || 0 : 0)
      : (canUp ? upgradePriceOf(itemCfg, lv) : 0);
    const usePrice = prices && 'perUse' in prices
      ? (Number(prices.perUse) || 0)
      : usePriceOf(itemCfg, lv || 1);
    const basePrice = lv === 0 ? Number(itemCfg.price) || 0 : upPrice;
    const purse = this.purse();
    const poor = purse != null && basePrice > purse;

    const buyLabel = !owned ? '购买' : timed ? '补充一次' : '已持有';
    const row = (label, n) => h('div.ic-price', {}, h('span', { text: label }), h('b', { text: String(n) }));

    return h(`div.item-card.${meta.tone}`, {},
      h('div.ic-head', {},
        h('div.ic-icon', {}, icon(meta.icon, 'lg')),
        h('div.ic-title', {},
          h('div.ic-name', {}, meta.name, h('span.ic-slot', { text: String(slot) })),
          h('div.ic-lv', { text: owned ? `Lv ${lv}/${maxLevel}` : '未持有' })),
        h('span.spacer'),
        h('span.chip.muted', { title: '剩余使用次数' }, `次数 ${usesText(uses, maxUses)}`)),
      h('div.ic-desc', { text: meta.desc }),
      h('div.ic-effect', { text: effectText(id, lv, itemCfg) }),
      id === 'hourglass' ? h('div.ic-extra', { text: `本局已用 ${Number(me?.itemRoundCount?.hourglass) || 0}/${hourglassLimit(Math.max(1, lv))} 次` }) : null,
      id === 'hackbook' ? h('div.ic-extra.danger', { text: `本局已用 ${Number(me?.itemRoundCount?.hackbook) || 0}/${Math.max(1, Number(itemCfg.maxPerRound) || 1)} 次` }) : null,
      h('div.ic-prices', {},
        row(!owned ? '售价' : '升级', basePrice),
        usePrice ? row('补弹', usePrice) : null),
      h('div.ic-actions', {},
        !owned
          ? h('button.btn.gold.sm', { disabled: poor, title: poor ? '积分不够' : '', onclick: () => this.buy(id) }, icon('coin', 'sm'), buyLabel)
          : timed
            ? h('button.btn.gold.sm', { disabled: lv >= maxLevel, title: lv >= maxLevel ? '已满级' : '', onclick: () => this.buy(id) }, icon('coin', 'sm'), buyLabel)
            : h('button.btn.sm', { disabled: true, title: '这件道具只需购买一次' }, '已持有'),
        usePrice
          ? h('button.btn.ghost.sm', { disabled: !owned, title: owned ? `花 ${usePrice} 补充 ${lv} 次使用次数` : '先购买道具', onclick: () => this.buyUses(id) }, '买次数')
          : null,
        h('div.spacer'),
        lv >= maxLevel
          ? h('span.chip.ok', { text: '已满级' })
          : h(`button.btn${canUp ? '.primary' : ''}.sm`, { disabled: !canUp, title: canUp ? '' : '先购买道具才能升级', onclick: () => this.upgrade(id) }, icon('bolt', 'sm'), canUp ? `升级 ${upPrice}` : '未持有')));
  }

  /** 购买一份（服务端会按 maxLevel/maxUses 与金币再校验）。 */
  buy(itemId) {
    this.net.send(MSG.ITEM_BUY, { itemId, amount: 1 });
  }

  /** 定格手枪「补充使用次数」：perUsePrice × 1 份，服务端给它 Lv 次。 */
  buyUses(itemId) {
    this.net.send(MSG.ITEM_USE, { itemId, buyType: 'uses', amount: 1 });
  }

  upgrade(itemId) {
    this.net.send(MSG.ITEM_UPGRADE, { itemId });
  }
}