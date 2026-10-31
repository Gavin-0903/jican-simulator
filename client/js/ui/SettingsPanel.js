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

/** 道具（需求 2.1）快捷键：服务端没下发道具配置时整段隐藏。 */
const ITEM_KEYS = [
  ['B', '打开 / 关闭道具商店（购买与升级）'],
  ['1 – 5', '使用道具栏对应槽位的道具（Shift+1..5 或小键盘同样可用）'],
  ['1 · 定格手枪', '进入「选择目标」模式，点击画面里的角色后定格（Esc 取消）'],
  ['2 · 买通老师', '立即生效：老师目击你 JC 时有概率看不出'],
  ['3 · 强密码', '立即生效：别人 JC 你的电脑前要先破解锁定时间'],
  ['4 · 时间沙漏', '立即生效：除你之外全场定格（每局次数有限）'],
  ['5 · 黑客手册', '打开入侵面板，改任意角色的积分 / 工资（风险极高）'],
];

export class SettingsPanel {
  constructor(modals, store, renderer, net) {
    this.modals = modals;
    this.store = store;
    this.renderer = renderer;
    this.net = net;
    // 联机（v0.3）：本机是否为服务器源 / 当前暴露方式，进入设置页时探测一次（GET /api/net/online）
    this.onlineInfo = null;
  }

  /** 拉一次本机的联机状态；失败保持 null（不弹错，设置页照常显示其它内容）。 */
  async probeOnline() {
    try {
      const r = await fetch('/api/net/online', { cache: 'no-store' });
      const j = await r.json();
      this.onlineInfo = j?.online ?? null;
    } catch {
      this.onlineInfo = null;
    }
    return this.onlineInfo;
  }

  /** 切换 serve ↔ funnel（真调 tailscale，失败把原因显示出来）。 */
  async switchMode(mode, rerender) {
    try {
      const r = await fetch('/api/net/online/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const j = await r.json();
      if (!j.ok) this.switchError = j.error ?? '切换失败';
      else this.switchError = null;
    } catch (e) {
      this.switchError = e.message;
    }
    await this.probeOnline();
    rerender();
  }

  /** 联机区块：本机是服务器源时给出地址与暴露方式切换。 */
  netSection(refreshBody) {
    const rerender = refreshBody;
    const o = this.onlineInfo;
    if (!o || typeof o !== 'object') return h('div.note', {}, icon('signal', 'sm'), '联机：未探测到本机的 /api/net/online（可能不在服务器源实例上）');
    const modeSeg = h('div.segmented', {},
      ...[['serve', 'Serve（仅 tailnet）'], ['funnel', 'Funnel（公网）']].map(([v, label]) =>
        h('button', { 'aria-pressed': String(o.mode === v), onclick: () => this.switchMode(v, rerender) }, label)));
    return h('div.note', {},
      h(`span.badge-llm.${o.enabled ? 'on' : 'degraded'}`, {}, h('span.dot')),
      h('span', { text: o.enabled ? `联机已开启 · 本机是服务器源 ${o.serverUrl || '（地址待 TailScale 就绪）'}` : '联机未开启：本机按单机模式运行' }),
      o.enabled ? h('div.kv', {},
        h('dt', { text: '暴露方式' }), h('dd', {}, modeSeg),
        h('dt', { text: '服务器地址' }), h('dd', { text: o.serverUrl || '—' }),
        h('dt', { text: '联机 Token' }), h('dd', { text: o.hasToken ? '已生成（见 data/config.json）' : '未生成' })) : null,
      // Serve 仅 tailnet 内可访问；Funnel 需要先在 TailScale 后台开启 Funnel 能力，否则切换会失败
      o.enabled ? h('div.fine', { text: o.mode === 'funnel'
        ? 'Funnel：公网可访问，需在 TailScale 管理后台为这台机器开启 Funnel 能力。'
        : 'Serve：仅同一 tailnet 内的设备可访问。想让外网同学直接加入就切到 Funnel。' }) : null,
      this.switchError ? h('div.note.warn', { text: `切换失败：${this.switchError}` }) : null);
  }

  show(onClose) {
    // onClose 只在用户点「完成」时调用（它负责还原暂停/焦点）；内部重绘绝不能带它。
    const llm = this.store.game.llm ?? this.store.lobby?.llm;
    const hasItems = !!this.store.lobby?.rules?.items;
    const on = llm?.mode === 'llm';
    // refreshBody：只重建设置面板的 body（换镜头 / 切曝光方式都不该关窗、也不该重复入栈）。
    // buildBody 内部会读 this.store / this.net / this.renderer，必须显式绑 this（它是普通函数，this 会丢）。
    const refreshBody = () => this.modals.setBody('settings', buildBody());
    // 首次打开先显示占位，探测回来只换 body（避免 null 被当成「未启用」的误判）
    if (this.onlineInfo === null) {
      this.onlineInfo = '__probing';
      this.probeOnline().then(refreshBody);
    } else if (this.onlineInfo === '__probing') {
      this.onlineInfo = null; // 探测失败：本轮按「未知」渲染
    }
    const camSeg = h('div.segmented', {},
      ...[['follow', '跟随'], ['overview', '全景']].map(([v, label]) =>
        h('button', { 'aria-pressed': String(this.renderer.cameraMode === v), onclick: () => { this.renderer.setCameraMode(v); refreshBody(); } }, label)));
    const coneSeg = h('div.segmented', {},
      ...[[true, '显示'], [false, '隐藏']].map(([v, label]) =>
        h('button', { 'aria-pressed': String(this.renderer.showCones === v), onclick: () => { this.renderer.showCones = v; refreshBody(); } }, label)));
    const buildBody = () => {
      return [
        h('div.note', {}, h(`span.badge-llm.${on ? 'on' : 'degraded'}`, {}, h('span.dot')),
          h('span', { text: on ? `AI 增强：已启用（${llm?.mode === 'llm' ? '本地模型生成台词与性格倾向' : ''}）` : `AI 增强：已降级为纯规则 AI${llm?.reason ? `（${llm.reason}）` : ''}` })),
        h('div.kv', {},
          h('dt', { text: '镜头' }), h('dd', {}, camSeg),
          h('dt', { text: '老师视野扇形' }), h('dd', {}, coneSeg),
          h('dt', { text: '网络延迟' }), h('dd', { text: this.net.latency != null ? `${this.net.latency} ms` : '—' }),
          h('dt', { text: '随机种子' }), h('dd', { text: String(this.store.game.seed ?? '—') })),
        h('div.section-title', {}, icon('keyboard', 'sm'), '快捷键'),
        h('dl.kv', {}, ...KEYS.flatMap(([k, v]) => [h('dt', {}, kbd(k)), h('dd', { text: v })])),
        hasItems ? h('div.section-title', {}, icon('bolt', 'sm'), '道具快捷键') : null,
        hasItems ? h('dl.kv', {}, ...ITEM_KEYS.flatMap(([k, v]) => [h('dt', {}, kbd(k)), h('dd', { text: v })])) : null,
        hasItems ? h('div.note', {}, icon('coin', 'sm'), '道具全部由服务端裁定：价格、升级与使用效果以对局内实际扣除为准。') : null,
        h('div.section-title', {}, icon('signal', 'sm'), '输入与联机'),
        this.onlineInfo === '__probing' ? null : this.netSection(refreshBody),
        h('dl.kv', {},
          h('dt', {}, kbd('Ctrl+C / V')), h('dd', { text: '已禁用：复制、粘贴、剪切、全选在游戏内一律拦截' }),
          h('dt', {}, kbd('输入法')), h('dd', { text: '所有输入框强制英文键盘（ime-mode: disabled），直接键入即可' }),
          h('dt', {}, kbd('联机')), h('dd', { text: '大厅顶部可切到「联机」：本机是服务器源时自动使用本机地址，否则填写服务器源 URL 与 Token' })),
      ];
    };
    this.modals.open('settings', {
      title: '设置',
      icon: 'settings',
      onDismiss: onClose,
      body: buildBody(),
      foot: [h('button.btn.primary', { onclick: () => { this.modals.close(); onClose?.(); } }, '完成')],
    });
  }
}