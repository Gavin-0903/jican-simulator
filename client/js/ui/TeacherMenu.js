// 学生靠近老师时的互动菜单：提问（办公室内连续停留）/ 讨好。

import { ACTION } from '/shared/constants.js';
import { h, icon, kbd } from '../util/dom.js';

export class TeacherMenu {
  constructor(root, store, net) {
    this.root = root;
    this.store = store;
    this.net = net;
    this.targetId = null;
  }

  get open() {
    return !this.root.hidden;
  }

  show(target) {
    this.targetId = target.id;
    const name = this.store.rosterEntry(target.id)?.name ?? '老师';
    this.root.replaceChildren(
      h('span.who', {}, icon('teacher', 'sm'), ` ${name}`),
      h('button.btn.primary.sm', { onclick: () => this.ask() }, icon('question', 'sm'), '提问', kbd('Q')),
      h('button.btn.sm', { onclick: () => this.flatter() }, icon('heart', 'sm'), '讨好', kbd('F')),
      h('button.btn.ghost.icon.sm', { onclick: () => this.hide(), 'aria-label': '关闭' }, icon('close', 'sm')),
    );
    this.root.hidden = false;
  }

  hide() {
    this.root.hidden = true;
    this.targetId = null;
  }

  ask(targetId = this.targetId) {
    this.net.action(ACTION.ASK, targetId ? { targetId } : {});
    this.hide();
  }

  flatter(targetId = this.targetId) {
    this.net.action(ACTION.FLATTER, targetId ? { targetId } : {});
    this.hide();
  }
}
