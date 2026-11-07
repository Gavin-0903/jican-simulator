// 大厅（v0.9 座位制）：不再在大厅里挑「学生/老师 + 班级 + 角色卡片」。
// 座位是唯一的角色来源 —— 单机直接用默认角色开局，联机的座位在房间里选（见 main.js 的座位表）。
// 顶部的联机面板（含「单机 / 联机」切换）由 NetPanel 画；房间页（地址栏带 token/id 或 ?room=）
// 上那个切换整块不画 —— 那一页必然是联机（需求 v0.10，见 NetPanel 的 roomPage）。

import { h, icon, store as ls, fmtClock, webAsset } from '../util/dom.js';
import { forceEnglishInput } from '../util/ime.js';
import { MSG } from '/shared/constants.js';
import { defaultSoloCharacter } from '../net/roomUrl.js';

const CLASS_COLOR = { 1: 'var(--class-1)', 2: 'var(--class-2)', 3: 'var(--class-3)' };

/** 身份卡的配色：老师走强调色，学生按班级上色（和角色卡片时代同一套 CSS 变量）。 */
const charColor = (e) => (e?.role === 'teacher' ? 'var(--accent-teacher)' : CLASS_COLOR[e?.classId] ?? 'var(--class-1)');

/**
 * 单机「我是谁」卡：只读展示这次要扮演谁，旁边一个「换一个」。
 *
 * 为什么不再是一整片角色卡片：用户的诉求是「联机窗口干掉人物选择，改成每个玩家选自己的座位」。
 * 大厅里留一片可点的人头，就等于在房间里还有第二套"我选谁"的入口 —— 两边会漂移，
 * 而且新手会以为大厅选了座位等于房间也选好了。所以这里降级成一张卡 + 一个循环切换按钮。
 */
function soloCard({ char, roster, onCycle, disabled }) {
  return h('div.solo-card', { style: { '--c': charColor(char) }, 'data-char': char?.id ?? '' },
    h('span.solo-dot'),
    h('div.grow', {},
      h('div.solo-name', { text: char ? char.name : '没有可用角色' }),
      h('div.solo-sub', {
        text: char
          ? `${char.username ?? ''}${char.role === 'teacher' ? ' · 老师' : ` · ${char.classId ?? 1} 班`} · 其余 ${Math.max(0,(roster?.length ?? 1) - 1)} 人由 AI 驱动`
          : '配置里一个角色都没有：请到「设置」里检查人物表',
      })),
    h('button.btn.ghost.sm.solo-swap', {
      type: 'button',
      title: '换成下一个人物（只影响单机）',
      disabled: disabled || !(roster?.length > 1),
      onclick: onCycle,
    }, icon('refresh', 'sm'), '换一个'));
}

export class Lobby {
  constructor(root, store, net, netPanel = null) {
    this.root = root;
    this.store = store;
    this.net = net;
    this.netPanel = netPanel;
    this.pickId = ls.get('jican.lastChar') || ''; // 单机想用的角色（'' = 用默认的第一个学生）
    this.seed = '';
    this.settingsSlot = null; // 由 main.js 传入的「设置」入口挂载点（见 LobbySettingsButton）
  }

  show(on) {
    this.root.hidden = !on;
    if (on) this.render();
  }

  /**
   * 单机这次扮演谁：lastChar（或本地点过的「换一个」）优先，其次 roster 里第一个学生。
   * 判定全在 roomUrl.js 的 defaultSoloCharacter 里（有单测钉住），这里只管存和画。
   */
  soloCharacter(lobby = this.store.lobby) {
    const roster = Array.isArray(lobby?.roster) ? lobby.roster : [];
    return defaultSoloCharacter(roster, this.pickId);
  }

  /** 「换一个」：在 roster 里按顺序挑下一个（跳过老师以外没有的情况下也不会空转）。 */
  cycleSolo() {
    const roster = Array.isArray(this.store.lobby?.roster) ? this.store.lobby.roster : [];
    if (roster.length < 2) return;
    const ids = roster.map((e) => e.id);
    const cur = this.soloCharacter()?.id;
    const next = ids[(Math.max(0, ids.indexOf(cur)) + 1) % ids.length];
    this.pickId = next;
    ls.set('jican.lastChar', next);
    this.render();
  }

  /** 单机开局：只带 characterId（role 由服务端按 roster 反查，前端别自己猜）。 */
  startSolo(char) {
    if (!char || this.store.role === 'spectator') return;
    this.net.send(MSG.JOIN, { characterId: char.id, role: char.role, seed: this.seed ? Number(this.seed) >>> 0 : null });
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
          h('img.brand-mark', { src: webAsset('/assets/icons/favicon.svg'), alt: '' }),
          h('div', {}, h('div.brand-title', { text: '机惨模拟器' }), h('div.brand-sub', { text: '正在连接本地服务器…' })),
          h('div.spacer'),
          this.settingsSlot ? this.settingsSlot() : null),
        netSlot));
      this.netPanel?.mount(netSlot);
      return;
    }
    const r = lobby.rules;
    // 「这是被别的窗口夺权的旁看」和「我在房间里，只是这局还没轮到我操作」是两回事：
    //   soloSpectator —— 单机通道被另一个窗口接管（老行为：红条 + 禁用开始按钮 + 「点此夺回」）。
    //   inRoom        —— 有房间上下文（welcome.room 或地址栏本来就是房间页），此时角色来源是房间座位表，
    //                    大厅的「单机 · 你要扮演谁」和「开始游戏」根本不适用，不该画（也不该红着脸喊夺权）。
    const roomId = this.store.welcome?.room?.id ?? '';
    const inRoom = Boolean(roomId) || Boolean(this.netPanel?.roomPage);
    const soloSpectator = this.store.role === 'spectator' && !inRoom;
    const char = this.soloCharacter(lobby);
    const roster = Array.isArray(lobby.roster) ? lobby.roster : [];
    const isTeacher = char?.role === 'teacher';

    const llm = lobby.llm;
    const llmBadge = h(`span.chip.badge-llm.${llm?.mode === 'llm' ? 'on' : 'degraded'}`, { title: llm?.reason ?? '' },
      h('span.dot'), llm?.mode === 'llm' ? `AI 增强：${llm.model}` : 'AI 增强：未启用（纯规则 AI）');

    const rules = h('ul.rules', {},
      ...(isTeacher
        ? [
          ['eye', ['扇形视野 ', h('b', { text: `${r.teacherVision.radius}px · ±${r.teacherVision.halfAngleDeg}°` }), '，墙和桌子会挡住视线，鼠标控制朝向']],
          ['yen', ['亲眼看到学生 JC 或检查到有人用别人电脑：', h('b', { text: `工资 +${r.catchReward}￥` })]],
          ['warn', ['本班学生每被 JC 一次：', h('b', { text: `−${r.classLosePenalty}￥` }), `；初始 ${r.initialSalary}￥，`, h('b', { text: '工资 < 0 即失败' })]],
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

    const resume = lobby.resumable && !soloSpectator
      ? h('div.resume-box', {}, icon('refresh'),
        h('div.grow', { text: `发现未完成的对局：${lobby.resumable.playerName ?? lobby.resumable.playerCharId}，已进行 ${fmtClock(lobby.resumable.elapsedMs)}` }),
        h('button.btn.gold.sm', { onclick: () => this.net.send(MSG.JOIN, { resume: true }) }, '继续上局'))
      : null;

    // 联机模式（顶部「单机 / 联机」切到联机）下，底部主按钮不再是单机开局，而是打开房间窗口：
    // 房间页是独立窗口，这里只是回到那间房的入口；还没进过房间时禁用并说明先创建/加入。
    // 单机模式完全保持原样（角色卡 + 随机种子 + 以当前角色开始）。
    const netMode = this.netPanel?.mode === 'net';
    const canOpenRoom = netMode && Boolean(this.netPanel?.canReopen?.());
    const seedInput = h('input.input', { placeholder: '随机种子（可选）', inputmode: 'numeric', value: this.seed, 'aria-label': '随机种子', oninput: (e) => { this.seed = e.target.value.replace(/\D/g, '').slice(0, 10); e.target.value = this.seed; } });
    forceEnglishInput(seedInput);
    const start = h('button.btn.primary', {
      disabled: !char || soloSpectator,
      title: soloSpectator ? '已有其他窗口在控制游戏' : char ? `以 ${char.name} 开始单机` : '没有可用角色',
      onclick: () => this.startSolo(this.soloCharacter()),
    }, icon('play', 'sm'), soloSpectator ? '观战模式' : '开始游戏');
    const openRoom = h('button.btn.primary', {
      disabled: !canOpenRoom,
      title: canOpenRoom ? '在独立窗口里打开这间房（关掉后还能再打开）' : '先在联机面板创建或加入房间',
      onclick: () => this.netPanel?.reopenGameWindow(),
    }, icon('door', 'sm'), '打开房间窗口');

    const netSlot = h('div.net-slot');
    this.root.replaceChildren(h('div.card.lobby-card', {},
      h('div.lobby-top', {},
        h('img.brand-mark', { src: webAsset('/assets/icons/favicon.svg'), alt: '' }),
        h('div', {}, h('div.brand-title', { text: '机惨模拟器' }), h('div.brand-sub', { text: `${roster.length || '30 名'} 名学生 + 5 名老师 · 你扮演其中一人，其余由 AI 驱动 · 单局 ${Math.round(lobby.round.durationMs / 60000)} 分钟` })),
        h('div.spacer'),
        ...(this.settingsSlot ? [this.settingsSlot()] : []),
        llmBadge),
      netSlot,
      // 注意：appendChild/条件三元里的 null 会被当成字符串「null」画出来（大厅里实测出现过一枚孤儿 "null"），
      // 所以条件子节点一律用 ...[] 展开，跟 main.js 的 renderPlayersPanel 一个规矩。
      ...(soloSpectator ? [h('div.note.warn', {}, icon('warn', 'sm'), '已有其他窗口在控制游戏，当前为观战模式。关闭那个窗口后刷新本页即可接管。')] : []),
      ...(resume ? [resume] : []),
      h('div.lobby-grid', {},
        // 房间页不画「单机 · 你要扮演谁」：这一页的角色只能来自房间座位表（见 main.js 的座位表 / NetPanel 的房间面板）
        ...(inRoom ? [] : [h('div.lobby-section', {},
          h('div.section-title', {}, '单机 · 你要扮演谁'),
          soloCard({ char, roster, disabled: soloSpectator, onCycle: () => this.cycleSolo() }),
          h('div.note.seat-note', {}, icon('user', 'sm'), '联机时不在这里选人：进房间后每个玩家在自己的座位行里选角色，房主还能替你指派。'))]),
        h('div.lobby-section', {},
          h('div.section-title', {}, isTeacher ? '老师怎么玩' : '学生怎么玩'),
          rules,
          ...(lobby.round.targetScore ? [h('div.note', {}, icon('trophy', 'sm'), `学生率先达到 ${lobby.round.targetScore} 分立即获胜；否则时间到按积分排名。`)] : []))),
      // 房间页不画底部操作条：开局按钮在房间页自己的面板里（只有房主能点）。
      // 大厅窗口（非房间页）联机模式下把「开始游戏」换成「打开房间窗口」，单机模式不变。
      ...(inRoom ? [] : [h('div.lobby-actions', {},
        ...(netMode ? [] : [seedInput]),
        h('div.spacer'),
        netMode ? openRoom : start)])));
    this.netPanel?.mount(netSlot);
  }
}
