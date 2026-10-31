// 统计面板（Tab）：个人统计与最近事件。

import { h, icon } from '../util/dom.js';

const NAME = (store, id) => store.rosterEntry(id)?.name ?? id ?? '';

export function describeEvent(store, e) {
  switch (e.type) {
    case 'jc_success': return `${NAME(store, e.actorId)} JC 了 ${NAME(store, e.targetId)}（${e.amount}）`;
    case 'teacher_catch': return e.text;
    case 'jc_victim': return '你的电脑被人动过';
    case 'score_changed':
    case 'salary_changed':
    case 'buff_gained':
    case 'ask_cancelled':
    case 'inspect_clear':
    case 'pc_kicked':
    case 'eliminated':
    case 'failed':
    case 'round_start':
    case 'round_end':
      return e.text;
    case 'ask_started': return `开始向${NAME(store, e.targetId)}提问`;
    default: return e.text ?? e.type;
  }
}

export class StatsPanel {
  constructor(root, store) {
    this.root = root;
    this.store = store;
  }

  get open() {
    return !this.root.hidden;
  }

  toggle() {
    if (this.open) this.root.hidden = true;
    else {
      this.render();
      this.root.hidden = false;
    }
  }

  render() {
    const me = this.store.me;
    const st = me?.stats ?? {};
    const items = me?.role === 'teacher'
      ? [['抓获', st.catches], ['检查电脑', st.inspects]]
      : [['JC 成功', `${st.jcSuccess ?? 0} 次（+${st.jcGained ?? 0}）`], ['被 JC', `${st.jcVictim ?? 0} 次`], ['被老师抓', st.caught ?? 0], ['提问', st.asks ?? 0], ['讨好成功/失败', `${st.flatterOk ?? 0} / ${st.flatterFail ?? 0}`], ['厕所加速', `${st.buffs ?? 0} 层`]];
    const log = [...this.store.eventLog].reverse().slice(0, 40).map((e) => h('div', { text: describeEvent(this.store, e) }));
    this.root.replaceChildren(
      h('div.section-title', {}, icon('flag', 'sm'), '我的统计'),
      h('dl.kv', {}, ...items.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })])),
      h('div.event-log', {}, h('div.section-title', {}, icon('book', 'sm'), '最近事件'), ...log),
    );
  }
}
