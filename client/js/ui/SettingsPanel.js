// 设置面板：AI 增强状态、镜头、视野扇形显示、快捷键说明。

import { h, icon, kbd } from '../util/dom.js';

const KEYS = [
  ['W A S D / 方向键', '移动（按住鼠标左键也可朝鼠标方向移动）'],
  ['E / 空格', '交互：进入电脑 / 与老师互动 / 老师检查电脑'],
  ['Q · F', '靠近老师时：提问 · 讨好'],
  ['V', '在自己电脑上查看积分'],
  ['J', '在他人电脑上打开 JC'],
  ['Esc', '关闭对话框 / 暂停'],
  ['Tab', '显示统计与事件记录'],
  ['+ / −', '倍速 0.5× / 1× / 2×'],
  ['M', '切换跟随镜头 / 全景'],
];

export class SettingsPanel {
  constructor(modals, store, renderer, net) {
    this.modals = modals;
    this.store = store;
    this.renderer = renderer;
    this.net = net;
  }

  show(onClose) {
    const llm = this.store.game.llm ?? this.store.lobby?.llm;
    const on = llm?.mode === 'llm';
    const camSeg = h('div.segmented', {},
      ...[['follow', '跟随'], ['overview', '全景']].map(([v, label]) =>
        h('button', { 'aria-pressed': String(this.renderer.cameraMode === v), onclick: () => { this.renderer.setCameraMode(v); this.show(onClose); } }, label)));
    const coneSeg = h('div.segmented', {},
      ...[[true, '显示'], [false, '隐藏']].map(([v, label]) =>
        h('button', { 'aria-pressed': String(this.renderer.showCones === v), onclick: () => { this.renderer.showCones = v; this.show(onClose); } }, label)));
    this.modals.open('settings', {
      title: '设置',
      icon: 'settings',
      onDismiss: onClose,
      body: [
        h('div.note', {}, h(`span.badge-llm.${on ? 'on' : 'degraded'}`, {}, h('span.dot')),
          h('span', { text: on ? `AI 增强：已启用（${llm?.mode === 'llm' ? '本地模型生成台词与性格倾向' : ''}）` : `AI 增强：已降级为纯规则 AI${llm?.reason ? `（${llm.reason}）` : ''}` })),
        h('div.kv', {},
          h('dt', { text: '镜头' }), h('dd', {}, camSeg),
          h('dt', { text: '老师视野扇形' }), h('dd', {}, coneSeg),
          h('dt', { text: '网络延迟' }), h('dd', { text: this.net.latency != null ? `${this.net.latency} ms` : '—' }),
          h('dt', { text: '随机种子' }), h('dd', { text: String(this.store.game.seed ?? '—') })),
        h('div.section-title', {}, icon('keyboard', 'sm'), '快捷键'),
        h('dl.kv', {}, ...KEYS.flatMap(([k, v]) => [h('dt', {}, kbd(k)), h('dd', { text: v })])),
      ],
      foot: [h('button.btn.primary', { onclick: () => { this.modals.close(); onClose?.(); } }, '完成')],
    });
  }
}
