// 查看积分：只能在自己的电脑上打开。学生看自己的积分；老师看工资与本班学生积分。

import { h, icon, kbd } from '../util/dom.js';

export class ScoreDialog {
  constructor(modals, onBack, onLeave) {
    this.modals = modals;
    this.onBack = onBack;
    this.onLeave = onLeave;
  }

  show(p) {
    const foot = [
      h('button.btn.ghost', { onclick: () => this.onLeave() }, icon('exit', 'sm'), '离开电脑'),
      h('div.spacer'),
      h('button.btn.primary', { autofocus: true, onclick: () => this.onBack() }, '返回', kbd('Esc')),
    ];
    if (p.role === 'teacher') {
      const rows = (p.roster || []).map((s, i) => h(`tr${s.status !== 'active' ? '.out' : ''}`, {},
        h('td', { text: String(i + 1) }), h('td', { text: s.name }), h('td', { text: s.username }), h('td.num', { text: String(s.score) })));
      this.modals.open('score', {
        title: '我的工资',
        sub: `${p.name} · ${p.username}`,
        icon: 'yen',
        tone: 'gold',
        onDismiss: () => this.onBack(),
        body: [
          h(`div.big-number${p.salary < 0 ? '.neg' : ''}`, { text: `¥${p.salary}` }),
          p.classId
            ? h('div.ranking-wrap', {}, h('table.ranking', {}, h('thead', {}, h('tr', {}, h('th', { text: '#' }), h('th', { text: '本班学生' }), h('th', { text: '用户名' }), h('th.num', { text: '积分' }))), h('tbody', {}, ...rows)))
            : h('div.note', {}, icon('book', 'sm'), '办公室常驻老师不带班：不承担班级扣薪，只靠目击学生 JC 增加工资。'),
        ],
        foot,
      });
      return;
    }
    const toFail = p.score - p.failScore;
    this.modals.open('score', {
      title: '我的积分',
      sub: `${p.name} · ${p.username}`,
      icon: 'coin',
      tone: 'gold',
      onDismiss: () => this.onBack(),
      body: [
        h(`div.big-number${p.score < 0 ? '.neg' : ''}`, { text: String(p.score) }),
        h('dl.kv', {},
          h('dt', { text: '距离淘汰线' }), h('dd', { text: `还差 ${toFail} 分（淘汰线 ${p.failScore}）` }),
          p.targetScore ? h('dt', { text: '获胜目标' }) : null, p.targetScore ? h('dd', { text: `${p.targetScore} 分（还差 ${Math.max(0, p.targetScore - p.score)}）` }) : null,
          h('dt', { text: '本局提问' }), h('dd', { text: `${p.askCount} / ${p.askLimit} 次` })),
        h('div.note', {}, icon('shield', 'sm'), '查看完毕后积分不会实时刷新——离开电脑后，被别人 JC 的损失只有回来再看才知道。'),
      ],
      foot,
    });
  }
}
