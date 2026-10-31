// 黑客手册面板（道具 hackbook）：服务端下发 dialog kind:'hack.targets' 后列出全员，
// 玩家选目标 + 选模式（改为 / 增加）+ 填数值 → 发送 item.use{charId, action, amount}。
// 这里只负责收集与展示：成败、扣分、开除全部由服务端 ItemSystem 判定。

import { MSG } from '/shared/constants.js';
import { h, icon, kbd } from '../util/dom.js';
import { forceEnglishInput } from '../util/ime.js';

export class HackPanel {
  constructor(modals, store, net) {
    this.modals = modals;
    this.store = store;
    this.net = net;
    this.card = null;
    this.list = [];
    this.selectedId = null;
    this.failPct = 0;
    this.expelPct = 0;
    this.pending = false; // 已提交、等待服务端 hack_result / 错误
  }

  get open() {
    return this.modals.kind === 'hack';
  }

  /**
   * @param {{list:Array<{id:string,name:string,role:string,score:number,me:boolean}>, failPct?:number, expelPct?:number}} p
   */
  show(p) {
    const list = Array.isArray(p?.list) ? p.list : [];
    if (!list.length) return false;
    this.list = list;
    this.pending = false;
    this.failPct = Math.max(0, Math.min(100, Number(p.failPct) || 0));
    this.expelPct = Math.max(0, Math.min(100, Number(p.expelPct) || 0));
    if (!list.some((t) => t.id === this.selectedId)) this.selectedId = (list.find((t) => !t.me) ?? list[0]).id;

    const card = this.modals.open('hack', {
      title: '黑客手册 · 入侵监控系统',
      sub: '选择目标，把积分 / 工资「改为」指定值，或「增加」指定数量',
      icon: 'book',
      tone: 'danger',
      wide: true,
      onDismiss: () => this.reset(),
      body: [this.buildBody()],
      foot: [
        h('button.btn.ghost', { onclick: () => this.modals.dismiss() }, '放弃', kbd('Esc')),
        h('div.spacer'),
        h('span.hack-foot-note', { text: `失败 ${this.failPct}% · 开除 ${this.expelPct}%` }),
        h('button.btn.danger', { id: 'hack-submit', onclick: () => this.exec('set', null) }, icon('target', 'sm'), '执行入侵'),
      ],
    });
    this.card = card;
    return true;
  }

  buildBody() {
    const tone = (pct) => (pct >= 60 ? 'danger' : pct >= 30 ? 'warn' : 'ok');
    const rows = this.list.map((t) => {
      const unit = t.role === 'teacher' ? '工资' : '积分';
      const input = h('input.input.hack-amount', {
        type: 'number', step: 1, inputmode: 'numeric', placeholder: '数值',
        'aria-label': `${t.name} 的修改数值`,
        onkeydown: (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          this.selectedId = t.id;
          this.exec('set', t.id);
        },
      });
      forceEnglishInput(input);
      return h(`div.hack-row${t.id === this.selectedId ? '.sel' : ''}${t.me ? '.self' : ''}`, {
        dataset: { id: t.id },
        onclick: (e) => {
          if (e.target.closest?.('.hack-op')) return; // 点按钮/输入框时不要抢占选中
          this.select(t.id);
        },
      },
      h('div.hack-who', {},
        icon(t.role === 'teacher' ? 'teacher' : 'user', 'sm'),
        h('span.hack-name', { text: t.name }),
        t.me ? h('span.tag', { text: '我' }) : null),
      h('div.hack-score', {}, h('span.hack-unit', { text: unit }), h('b', { text: String(t.score) })),
      h('div.hack-op', {},
        input,
        h('button.btn.sm', { title: `把${unit}改为输入框里的数值`, onclick: () => { this.selectedId = t.id; this.exec('set', t.id); } }, '改为'),
        h('button.btn.sm.gold', { title: `在现有${unit}上加上输入框里的数值（负数即减少）`, onclick: () => { this.selectedId = t.id; this.exec('add', t.id); } }, '增加')));
    });

    return h('div.hack',
      h('div.note.danger', {}, icon('warn', 'sm'),
        h('span', {}, '风险极高：有 ',
          h('b', { text: `${this.failPct}%` }), ' 概率被防火墙弹回（自己被扣 100 分），',
          h('b', { text: `${this.expelPct}%` }), ' 概率被校长发现并直接开除出局。')),
      h('div.hack-legend', {},
        h(`span.chip.${tone(this.failPct)}`, { text: `失败 ${this.failPct}%` }),
        h(`span.chip.${tone(this.expelPct)}`, { text: `开除 ${this.expelPct}%` }),
        h('span.hack-tip', { text: '每局只能用一次 · 「改为」覆盖数值，「增加」是在现有数值上加减' })),
      h('div.hack-head', {},
        h('span', { text: '目标' }), h('span', { text: '当前' }), h('span', { text: '数值 · 改为 / 增加' })),
      h('div.hack-list', {}, ...rows));
  }

  select(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    for (const row of this.card?.querySelectorAll('.hack-row') ?? []) {
      row.classList.toggle('sel', row.dataset.id === id);
    }
  }

  /** 取出该行的数值并发送一次入侵请求。 */
  exec(action, targetId) {
    if (this.pending) return;
    const id = targetId ?? this.selectedId;
    if (!id) return;
    const row = this.card?.querySelector(`.hack-row[data-id="${id}"]`);
    const input = row?.querySelector('.hack-amount');
    const raw = input?.value?.trim() ?? '';
    const n = raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(n) || Math.trunc(n) === 0) {
      input?.classList.add('invalid');
      this.setHint('请先在这行填写要改为 / 增加的数值（不能为 0）', 'warn');
      return;
    }
    input.classList.remove('invalid');
    this.pending = true;
    const btn = this.card?.querySelector('#hack-submit');
    if (btn) btn.disabled = true;
    this.setHint('入侵指令已发出，等待结果…', 'info');
    this.net.send(MSG.ITEM_USE, { itemId: 'hackbook', charId: id, amount: Math.trunc(n), action });
  }

  setHint(text, tone = 'info') {
    if (!this.card) return;
    let el = this.card.querySelector('.hack-status');
    if (!el) {
      el = h('div.hack-status');
      this.card.querySelector('.modal-body')?.append(el);
    }
    el.textContent = text;
    el.dataset.tone = tone;
  }

  /** 收到 hack_result：解锁并关闭面板，结论由 main.js 出 toast。 */
  finish() {
    this.pending = false;
    this.reset();
    if (this.modals.kind === 'hack') this.modals.close();
  }

  /** 请求被拒（如次数用完、老师被定格）：解锁按钮并提示，允许重试或退出。 */
  reject(message) {
    this.pending = false;
    const btn = this.card?.querySelector('#hack-submit');
    if (btn) btn.disabled = false;
    if (message) this.setHint(message, 'danger');
  }

  reset() {
    this.pending = false;
    this.card = null;
  }
}
