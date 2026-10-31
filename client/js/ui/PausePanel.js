// 暂停面板。

import { h, icon, kbd } from '../util/dom.js';

const REASON = {
  player: '你暂停了游戏',
  disconnect: '连接中断，已自动暂停',
  resume: '已读取存档，准备好后继续',
  shutdown: '服务器关闭前自动保存的对局',
};

export class PausePanel {
  constructor(modals, handlers) {
    this.modals = modals;
    this.handlers = handlers;
  }

  show(reason) {
    this.modals.open('pause', {
      title: '已暂停',
      sub: REASON[reason] ?? '游戏已暂停',
      icon: 'pause',
      dismissable: true,
      onDismiss: () => this.handlers.onResume(),
      body: [h('div.summary-text', { text: '暂停期间逻辑时间冻结，AI 不会行动。进度每 5 秒以及暂停时都会自动存档。' })],
      foot: [
        h('button.btn.ghost', { onclick: () => this.handlers.onQuit() }, icon('flag', 'sm'), '结束本局'),
        h('div.spacer'),
        h('button.btn.primary', { autofocus: true, onclick: () => this.handlers.onResume() }, icon('play', 'sm'), '继续', kbd('Esc')),
      ],
    });
  }
}
