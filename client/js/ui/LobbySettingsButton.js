// 大厅（首页）上的「设置」入口：一个显眼的按钮 + 服务端配置面板的接线。
// 只在 LOBBY 阶段显示；进入对局后由 main.js 的 applyPhase 隐藏。

import { h, icon } from '../util/dom.js';

export class LobbySettingsButton {
  /**
   * @param {HTMLElement} host 挂载点（大厅卡片内）
   * @param {{onOpen:Function}} opts 点开配置面板的回调
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.onOpen = opts.onOpen || (() => {});
    this.btn = null;
  }

  render() {
    const btn = h('button.btn.lobby-settings', {
      type: 'button',
      title: '打开服务端配置（config.json）',
      onclick: () => this.onOpen(),
    },
    icon('settings', 'sm'),
    h('span', { text: '设置' }),
    h('span.fine.config-entry-hint', { text: 'config.json' }));
    this.btn = btn;
    this.host.append(btn);
    return btn;
  }

  /** 跟随阶段显隐；返回是否可见。 */
  show(on) {
    if (this.btn) this.btn.hidden = !on;
    return !!on;
  }
}
