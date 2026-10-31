// 进入电脑后的终端界面：自己的电脑 → 查看积分；别人的电脑 → 可看到对方积分并 JC。

import { ACTION } from '/shared/constants.js';
import { h, icon, kbd } from '../util/dom.js';

export class PcDialog {
  constructor(modals, net, onLeave) {
    this.modals = modals;
    this.net = net;
    this.onLeave = onLeave;
    this.last = null;
  }

  show(p) {
    this.last = p;
    const leave = h('button.btn.ghost', { onclick: () => this.onLeave() }, icon('exit', 'sm'), '离开电脑', kbd('Esc'));
    if (p.own) {
      const teacher = p.ownerRole === 'teacher';
      this.modals.open('pc', {
        title: '我的电脑',
        sub: '正在使用自己的电脑：其他人无法对你 JC（免疫），但你不能移动',
        icon: 'shield',
        tone: 'gold',
        onDismiss: () => this.onLeave(),
        body: [
          h('div.note', {}, icon('shield', 'sm'), h('span', { text: `免疫中。${p.maxSessionMs ? `单次最多使用 ${Math.round(p.maxSessionMs / 1000)} 秒，` : ''}${Math.round(p.idleTimeoutMs / 1000)} 秒无操作会自动离开。` })),
        ],
        foot: [
          leave,
          h('div.spacer'),
          h('button.btn.primary', { autofocus: true, onclick: () => this.net.action(ACTION.VIEW_SCORE) }, icon('eye', 'sm'), teacher ? '查看工资与本班积分' : '查看我的积分', kbd('V')),
        ],
      });
      return;
    }
    const negative = (p.ownerScore ?? 0) <= 0;
    this.modals.open('pc', {
      title: `${p.ownerName} 的电脑`,
      sub: `用户名 ${p.ownerUsername ?? '—'}${p.ownerStatus && p.ownerStatus !== 'active' ? ' · 已淘汰' : ''}`,
      icon: 'pc',
      tone: 'warn',
      onDismiss: () => this.onLeave(),
      body: [
        h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '12px' } },
          h('div', {}, h('div.modal-sub', { text: '对方当前积分' }), h(`div.big-number${(p.ownerScore ?? 0) < 0 ? '.neg' : ''}`, { text: String(p.ownerScore ?? '—') }))),
        h('div.note.warn', {}, icon('eye', 'sm'), h('span', { text: '你正在使用别人的电脑。老师看见会被抓（扣分），JC 时被老师目击会扣除相应积分。注意躲开老师视野（橙色扇形）。' })),
        negative ? h('div.note', {}, icon('warn', 'sm'), h('span', { text: '对方积分不大于 0，没有可以分享的积分。' })) : null,
      ],
      foot: [
        leave,
        h('div.spacer'),
        p.canJc ? h('button.btn.danger', { autofocus: true, disabled: negative, onclick: () => this.net.action(ACTION.JC_OPEN, { pcId: p.pcId }) }, icon('target', 'sm'), 'JC · 分享积分', kbd('J')) : null,
      ],
    });
  }

  /** JC 成功后刷新对方积分。 */
  refreshOwnerScore(score) {
    if (this.last && !this.last.own) this.show({ ...this.last, ownerScore: score });
  }
}
