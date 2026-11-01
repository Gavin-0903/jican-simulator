// 大厅：选择身份 / 班级 / 角色，开始新局或继续存档。
// 顶部另有「单机 / 联机」切换与联机房间面板（需求 3，见 NetPanel）。

import { h, icon, store as ls, fmtClock } from '../util/dom.js';
import { forceEnglishInput } from '../util/ime.js';
import { MSG } from '/shared/constants.js';

const CLASS_COLOR = { 1: 'var(--class-1)', 2: 'var(--class-2)', 3: 'var(--class-3)' };

export class Lobby {
  constructor(root, store, net, netPanel = null) {
    this.root = root;
    this.store = store;
    this.net = net;
    this.netPanel = netPanel;
    const saved = ls.get('jican.lastChar');
    this.selected = saved || 's1-01';
    this.role = this.selected.startsWith('t') ? 'teacher' : 'student';
    this.classId = this.role === 'student' ? Number(this.selected[1]) || 1 : 1;
    this.seed = '';
    this.settingsSlot = null; // 由 main.js 传入的「设置」入口挂载点（见 LobbySettingsButton）
  }

  show(on) {
    this.root.hidden = !on;
    if (on) this.render();
  }

  render() {
    const lobby = this.store.lobby;
    // 注意：settingsSlot 必须用「先取再调」的写法——this.settingsSlot 可能为 null，
    // 每一分支只调用一次（每次调用都会新建 DOM 节点）。
    if (!lobby) {
      // 还没连上服务端时，联机面板仍然可用（它不依赖 lobby 快照）
      const netSlot = h('div.net-slot');
      this.root.replaceChildren(h('div.card.lobby-card', {},
        h('div.lobby-top', {},
          h('img.brand-mark', { src: '/assets/icons/favicon.svg', alt: '' }),
          h('div', {}, h('div.brand-title', { text: '机惨模拟器' }), h('div.brand-sub', { text: '正在连接本地服务器…' })),
          h('div.spacer'),
          this.settingsSlot ? this.settingsSlot() : null),
        netSlot));
      this.netPanel?.mount(netSlot);
      return;
    }
    const roster = lobby.roster;
    const r = lobby.rules;
    const spectator = this.store.role === 'spectator';
    const pick = (id) => {
      this.selected = id;
      ls.set('jican.lastChar', id);
      this.render();
    };
    const list = roster.filter((e) => e.role === this.role && (this.role === 'teacher' || e.classId === this.classId));
    if (!list.some((e) => e.id === this.selected)) this.selected = list[0]?.id;
    const sel = roster.find((e) => e.id === this.selected);

    const roleSeg = h('div.segmented', { role: 'group', 'aria-label': '身份' },
      ...[['student', '学生', 'user'], ['teacher', '老师', 'teacher']].map(([v, label, ic]) =>
        h('button', { 'aria-pressed': String(this.role === v), onclick: () => { this.role = v; this.selected = null; this.render(); } }, icon(ic, 'sm'), label)));
    const classSeg = this.role === 'student'
      ? h('div.segmented', { role: 'group', 'aria-label': '班级' },
        ...[1, 2, 3].map((k) => h('button', { 'aria-pressed': String(this.classId === k), onclick: () => { this.classId = k; this.selected = null; this.render(); } }, `${k} 班`)))
      : null;
    const cards = h('div.roster', {}, ...list.map((e) =>
      h('button.roster-card', { 'aria-pressed': String(e.id === this.selected), onclick: () => pick(e.id), style: { '--c': e.role === 'teacher' ? 'var(--accent-teacher)' : CLASS_COLOR[e.classId] } },
        h('span.rc-name', {}, h('span.rc-dot'), e.name),
        h('span.rc-sub', { text: e.role === 'teacher' ? `${e.username} · ${e.classId ? `${e.classId} 班任课` : '办公室'}` : e.username }))));

    const llm = lobby.llm;
    const llmBadge = h(`span.chip.badge-llm.${llm?.mode === 'llm' ? 'on' : 'degraded'}`, { title: llm?.reason ?? '' },
      h('span.dot'), llm?.mode === 'llm' ? `AI 增强：${llm.model}` : 'AI 增强：未启用（纯规则 AI）');

    const isTeacher = this.role === 'teacher';
    const rules = h('ul.rules', {},
      ...(isTeacher
        ? [
          ['eye', [`扇形视野 `, h('b', { text: `${r.teacherVision.radius}px · ±${r.teacherVision.halfAngleDeg}°` }), '，墙和桌子会挡住视线，鼠标控制朝向']],
          ['yen', ['亲眼看到学生 JC 或检查到有人用别人电脑：', h('b', { text: `工资 +${r.catchReward}￥` })]],
          ['warn', [`本班学生每被 JC 一次：`, h('b', { text: `−${r.classLosePenalty}￥` }), `；初始 ${r.initialSalary}￥，`, h('b', { text: '工资 < 0 即失败' })]],
          ['pc', ['电脑旁亮 ', h('b', { text: '红圈' }), ' 说明有人在用别人的电脑，靠近按 E 检查']],
        ]
        : [
          ['question', ['办公室里在老师身边连续停留 ', h('b', { text: `${r.askDwellMs / 1000} 秒` }), ` 提问：+${r.askReward} 分`]],
          ['heart', ['讨好老师：成功率 ', h('b', { text: `${Math.round(r.flatter.rateMin * 100)}%–${Math.round(r.flatter.rateMax * 100)}%` }), `，成功 +${r.flatter.min}~${r.flatter.max}，失败 −${r.flatter.failMin}~${r.flatter.failMax}`]],
          ['target', ['走到别人电脑前进入 → 可看到对方积分 → ', h('b', { text: 'JC 分享积分' }), '：输入自己的用户名和数量 x']],
          ['eye', ['老师看到你 JC：', h('b', { text: '扣除相应积分' }), '；躲在墙和桌子后面可以挡住老师视线']],
          ['shield', ['积分只能回 ', h('b', { text: '自己的电脑' }), ' 查看；正在用自己电脑时别人无法 JC 你']],
          ['bolt', ['厕所停留叠加速度，聊天室缓慢提升全属性；积分 ≤ ', h('b', { text: String(r.failScore) }), ' 被淘汰']],
        ]).map(([ic, parts]) => h('li', {}, icon(ic, 'sm'), h('span', {}, ...parts))));

    const resume = lobby.resumable && !spectator
      ? h('div.resume-box', {}, icon('refresh'),
        h('div.grow', { text: `发现未完成的对局：${lobby.resumable.playerName ?? lobby.resumable.playerCharId}，已进行 ${fmtClock(lobby.resumable.elapsedMs)}` }),
        h('button.btn.gold.sm', { onclick: () => this.net.send(MSG.JOIN, { resume: true }) }, '继续上局'))
      : null;

    const seedInput = h('input.input', { placeholder: '随机种子（可选）', inputmode: 'numeric', value: this.seed, 'aria-label': '随机种子', oninput: (e) => { this.seed = e.target.value.replace(/\D/g, '').slice(0, 10); e.target.value = this.seed; } });
    forceEnglishInput(seedInput);
    const start = h('button.btn.primary', {
      disabled: !sel || spectator,
      onclick: () => {
        const seed = this.seed ? Number(this.seed) >>> 0 : null;
        this.net.send(MSG.JOIN, { characterId: sel.id, role: sel.role, seed });
      },
    }, icon('play', 'sm'), sel ? `以 ${sel.name} 开始` : '选择角色');

    const netSlot = h('div.net-slot');
    this.root.replaceChildren(h('div.card.lobby-card', {},
      h('div.lobby-top', {},
        h('img.brand-mark', { src: '/assets/icons/favicon.svg', alt: '' }),
        h('div', {}, h('div.brand-title', { text: '机惨模拟器' }), h('div.brand-sub', { text: `30 名学生 + 5 名老师 · 你扮演其中一人，其余由 AI 驱动 · 单局 ${Math.round(lobby.round.durationMs / 60000)} 分钟` })),
        h('div.spacer'),
        this.settingsSlot ? this.settingsSlot() : null,
        llmBadge),
      netSlot,
      spectator ? h('div.note.warn', {}, icon('warn', 'sm'), '已有其他窗口在控制游戏，当前为观战模式。关闭那个窗口后刷新本页即可接管。') : null,
      resume,
      h('div.lobby-grid', {},
        h('div.lobby-section', {},
          h('div.section-title', {}, '选择角色'),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, roleSeg, classSeg),
          cards),
        h('div.lobby-section', {},
          h('div.section-title', {}, isTeacher ? '老师怎么玩' : '学生怎么玩'),
          rules,
          lobby.round.targetScore ? h('div.note', {}, icon('trophy', 'sm'), `学生率先达到 ${lobby.round.targetScore} 分立即获胜；否则时间到按积分排名。`) : null)),
      h('div.lobby-actions', {}, seedInput, h('div.spacer'), start)));
    this.netPanel?.mount(netSlot);
  }
}
