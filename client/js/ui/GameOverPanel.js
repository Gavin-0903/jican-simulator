// 结算面板：结束原因、个人结果、学生榜 / 老师榜、统计与小结。

import { h, icon, fmtClock } from '../util/dom.js';

export class GameOverPanel {
  constructor(modals, store, handlers) {
    this.modals = modals;
    this.store = store;
    this.handlers = handlers;
    this.summaryEl = null;
    this.tab = 'students';
  }

  show(p) {
    const me = p.playerCharId;
    const all = [...p.ranking.students, ...p.ranking.teachers];
    const mine = all.find((e) => e.id === me);
    const winner = p.winnerId ? all.find((e) => e.id === p.winnerId) : null;
    const teacher = mine?.role === 'teacher';
    const list = teacher ? p.ranking.teachers : p.ranking.students;
    const rank = mine ? list.findIndex((e) => e.id === me) + 1 : null;
    this.tab = teacher ? 'teachers' : 'students';

    const hero = mine
      ? h('div.result-hero', {},
        h('div.trophy', {}, icon(mine.status === 'active' && rank <= 3 ? 'trophy' : 'flag')),
        h('div', { style: { flex: '1' } },
          h('div.modal-sub', { text: teacher ? '最终工资' : '最终积分' }),
          h(`div.big-number${mine.score < 0 ? '.neg' : ''}`, { text: teacher ? `¥${mine.score}` : String(mine.score) }),
          h('div.modal-sub', { text: `${teacher ? '老师榜' : '学生榜'}第 ${rank} 名 / 共 ${list.length} 人${mine.status !== 'active' ? ' · 已出局' : ''}` })),
        h('div.stat-row', { style: { maxWidth: '50%', justifyContent: 'flex-end' } }, ...this.statChips(mine)))
      : null;

    const tableWrap = h('div.ranking-wrap');
    const renderTable = () => {
      const rows = (this.tab === 'teachers' ? p.ranking.teachers : p.ranking.students).map((e, i) =>
        h(`tr${e.id === me ? '.me' : ''}${e.status !== 'active' ? '.out' : ''}`, {},
          h('td', { text: String(i + 1) }),
          h('td', {}, e.name, e.id === me ? h('span.tag.gold', { text: '你', style: { marginLeft: '6px' } }) : null, e.status === 'eliminated' ? h('span.tag.danger', { text: '淘汰', style: { marginLeft: '6px' } }) : null),
          h('td', { text: e.title }),
          h('td.num', { text: this.tab === 'teachers' ? `¥${e.score}` : String(e.score) }),
          h('td.num', { text: this.tab === 'teachers' ? String(e.stats.catches) : `${e.stats.jcSuccess} / ${e.stats.jcVictim}` }),
        ));
      tableWrap.replaceChildren(h('table.ranking', {},
        h('thead', {}, h('tr', {}, h('th', { text: '#' }), h('th', { text: '角色' }), h('th', { text: '身份' }), h('th.num', { text: this.tab === 'teachers' ? '工资' : '积分' }), h('th.num', { text: this.tab === 'teachers' ? '抓获' : 'JC 成功/被 JC' }))),
        h('tbody', {}, ...rows)));
      for (const b of tabs.children) b.setAttribute('aria-pressed', String(b.dataset.tab === this.tab));
    };
    const tabs = h('div.segmented', {},
      h('button', { dataset: { tab: 'students' }, onclick: () => { this.tab = 'students'; renderTable(); } }, '学生榜'),
      h('button', { dataset: { tab: 'teachers' }, onclick: () => { this.tab = 'teachers'; renderTable(); } }, '老师榜'));
    renderTable();

    this.summaryEl = h('div.summary-text', { text: p.summary ?? '' });
    const s = p.stats;
    this.modals.open('gameover', {
      title: winner ? `${winner.name} 率先达到目标积分！` : p.reasonText,
      sub: `用时 ${fmtClock(p.durationMs)} · 种子 ${p.seed}`,
      icon: 'trophy',
      tone: 'gold',
      wide: true,
      dismissable: false,
      body: [
        hero,
        h('div.stat-row', {},
          h('span.chip', {}, icon('target', 'sm'), `JC ${s.jc} 次 · 转移 ${s.jcAmount} 分`),
          h('span.chip', {}, icon('eye', 'sm'), `老师抓获 ${s.catches} 次`),
          h('span.chip', {}, icon('question', 'sm'), `提问 ${s.asks} 次`),
          h('span.chip', {}, icon('heart', 'sm'), `讨好 ${s.flatters} 次`),
          s.eliminations ? h('span.chip.danger', {}, icon('warn', 'sm'), `淘汰 ${s.eliminations} 人`) : null),
        this.summaryEl,
        tabs,
        tableWrap,
      ],
      foot: [
        h('button.btn', { onclick: () => this.handlers.onLobby() }, icon('exit', 'sm'), '返回大厅'),
        h('div.spacer'),
        mine ? h('button.btn.primary', { onclick: () => this.handlers.onReplay(mine.id) }, icon('refresh', 'sm'), '再来一局') : null,
      ],
    });
  }

  statChips(e) {
    const st = e.stats;
    if (e.role === 'teacher') return [h('span.chip', {}, `抓获 ${st.catches}`), h('span.chip', {}, `检查 ${st.inspects}`)];
    return [
      h('span.chip', {}, `JC ${st.jcSuccess} 次 +${st.jcGained}`),
      h('span.chip', {}, `被 JC ${st.jcVictim} 次 −${st.jcLost}`),
      h('span.chip', {}, `被抓 ${st.caught}`),
      h('span.chip', {}, `提问 ${st.asks}`),
    ];
  }

  updateSummary(text) {
    if (this.summaryEl) this.summaryEl.textContent = text;
  }
}
