// 顶栏（身份 / 积分或工资 / 倒计时 / 倍速 / 暂停 / 关闭）与底部状态条（房间 / 增益 / 冷却 / 交互提示）。

import { PHASE } from '/shared/constants.js';
import { h, icon, kbd, fmtClock, fmtAgo, fmtSigned } from '../util/dom.js';
import { roomAt } from '../util/world.js';

const $ = (id) => document.getElementById(id);

export class HudPanel {
  constructor(store, renderer, handlers) {
    this.store = store;
    this.renderer = renderer;
    this.cache = new Map();
    this.el = {
      name: $('hud-name'), sub: $('hud-sub'),
      scoreLabel: $('hud-score-label'), scoreValue: $('hud-score-value'), scoreHint: $('hud-score-hint'),
      timer: $('hud-timer'), speed: $('speed-label'), pause: $('btn-pause'),
      room: $('sb-room'), buffs: $('sb-buffs'), cds: $('sb-cds'), hint: $('sb-hint'),
      freeze: $('freeze-mask'), freezeText: $('freeze-text'), freezeBar: $('freeze-bar'),
    };
    $('btn-speed').addEventListener('click', handlers.onSpeed);
    $('btn-pause').addEventListener('click', handlers.onPause);
    $('btn-settings').addEventListener('click', handlers.onSettings);
    $('btn-close').addEventListener('click', handlers.onClose);
    $('btn-camera').addEventListener('click', handlers.onCamera);
  }

  /** 只在值变化时写 DOM。 */
  set(key, value, apply) {
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    apply(value);
  }

  update() {
    const st = this.store;
    const me = st.me;
    const entry = me ? st.rosterEntry(me.id) : null;
    const el = this.el;
    this.set('name', entry ? entry.name : '观战中', (v) => (el.name.textContent = v));
    this.set('sub', entry ? `${entry.username} · ${entry.title}` : '', (v) => (el.sub.textContent = v));

    if (me?.role === 'teacher') {
      this.set('scoreLabel', '工资', (v) => (el.scoreLabel.textContent = v));
      this.set('scoreValue', `¥${me.salary}`, (v) => {
        el.scoreValue.textContent = v;
        el.scoreValue.style.color = me.salary < 0 ? 'var(--danger)' : '';
      });
      this.set('scoreHint', me.salary < 60 ? '低于 0 即失败' : '', (v) => (el.scoreHint.textContent = v));
    } else if (me) {
      this.set('scoreLabel', '积分（上次查看）', (v) => (el.scoreLabel.textContent = v));
      this.set('scoreValue', me.lastViewedScore == null ? '?' : String(me.lastViewedScore), (v) => {
        el.scoreValue.textContent = v;
        el.scoreValue.style.color = me.lastViewedScore != null && me.lastViewedScore < 0 ? 'var(--danger)' : '';
      });
      let hint = '回自己电脑查看';
      if (me.lastViewedTick != null) {
        const ago = fmtAgo((st.game.tick - me.lastViewedTick) * st.tickMs);
        hint = me.knownDelta ? `已知变化 ${fmtSigned(me.knownDelta)} · ${ago}` : ago;
      } else if (me.knownDelta) hint = `已知变化 ${fmtSigned(me.knownDelta)}`;
      this.set('scoreHint', hint, (v) => (el.scoreHint.textContent = v));
    }

    const remain = (st.game.roundMs ?? 0) - st.elapsedNow();
    this.set('timer', fmtClock(remain), (v) => {
      el.timer.textContent = v;
      el.timer.style.color = remain < 60000 && st.phase === PHASE.PLAYING ? 'var(--warn)' : '';
    });
    this.set('speed', `${st.game.speedMult ?? 1}×`, (v) => (el.speed.textContent = v));
    this.set('pauseIcon', st.phase === PHASE.PAUSED ? 'play' : 'pause', (v) => {
      el.pause.replaceChildren(icon(v, 'sm'));
    });

    // 底部状态条
    const myChar = st.myChar();
    const room = myChar ? roomAt(st.map, myChar) : null;
    this.set('room', room?.name ?? '校园', (v) => el.room.replaceChildren(icon('door', 'sm'), h('span', { text: v })));
    if (me) {
      const toiletPct = Math.round((me.toiletLevel ?? 0) * 10);
      const chatPct = ((me.attrMul?.speed ?? 1) - 1) * 100;
      const buffKey = `${toiletPct}|${chatPct.toFixed(3)}`;
      this.set('buffs', buffKey, () => {
        const chips = [];
        if (toiletPct > 0) chips.push(h('span.chip.ok', { title: '厕所加速（离开后按半衰期衰减）' }, icon('bolt', 'sm'), `速度 +${toiletPct}%`));
        if (chatPct > 0.0005) chips.push(h('span.chip.info', { title: '聊天室全属性加成（速度/视野/交互/积分系数）' }, icon('chat', 'sm'), `全属性 +${chatPct.toFixed(3)}%`));
        el.buffs.replaceChildren(...chips);
      });
      const cds = me.cooldowns || {};
      const sec = (ms) => `${Math.ceil(ms / 1000)}s`;
      const cdKey = `${me.role}|${me.askCount}|${Math.ceil((cds.ask ?? 0) / 1000)}|${Math.ceil((cds.flatter ?? 0) / 1000)}|${Math.ceil((cds.jc ?? 0) / 1000)}|${Math.ceil((cds.inspect ?? 0) / 1000)}`;
      this.set('cds', cdKey, () => {
        const chip = (iconName, label, ms, extra = '') =>
          h(`span.chip${ms > 0 ? '.muted' : ''}`, {}, icon(iconName, 'sm'), `${label}${extra}${ms > 0 ? ` ${sec(ms)}` : ''}`);
        if (me.role === 'teacher') el.cds.replaceChildren(chip('eye', '检查', cds.inspect ?? 0));
        else {
          el.cds.replaceChildren(
            chip('question', '提问', cds.ask ?? 0, ` ${me.askCount}/${me.askLimit}`),
            chip('heart', '讨好', cds.flatter ?? 0),
            chip('target', 'JC', cds.jc ?? 0),
          );
        }
      });
    }
    // 被定格（需求 2.1）：全屏遮罩 + 倒计时；剩余毫秒来自快照 me.frozenMs
    const frozenMs = Math.max(0, Number(me?.frozenMs) || 0);
    const frozen = frozenMs > 0 && st.phase === PHASE.PLAYING;
    if (frozenMs <= 0) this.freezeTotal = 0;
    this.set('frozen', frozen ? Math.ceil(frozenMs / 100) : 0, (v) => {
      const fm = this.el.freeze;
      if (!fm) return;
      fm.hidden = !v;
      el.hint.classList.toggle('frozen', !!v);
      $('app')?.classList.toggle('is-frozen', !!v);
    });
    if (frozen) {
      this.set('freezeText', `被定格了！还剩 ${(frozenMs / 1000).toFixed(1)} 秒`, (v) => {
        if (this.el.freezeText) this.el.freezeText.textContent = v;
      });
      // 进度条：按「冻结总时长」估算，快照里的 frozenMs 会随 tick 减少
      const total = Math.max(1000, this.freezeTotal || frozenMs);
      this.freezeTotal = Math.max(frozenMs, this.freezeTotal || 0);
      const pct = Math.max(0, Math.min(100, Math.round((frozenMs / total) * 100)));
      if (this.el.freezeBar) this.el.freezeBar.style.setProperty('--pct', `${pct}%`);
    }

    this.set('hint', this.hintText(), (v) => {
      const [k, text] = v.split('\u0001');
      el.hint.replaceChildren(...(k ? [kbd(k), ' '] : []), text ?? '');
    });
  }

  /** 服务端是否下发了道具配置（没有就不提示道具快捷键）。 */
  hasItems() {
    return !!this.store.lobby?.rules?.items && !!this.store.me?.items;
  }

  hintText() {
    const st = this.store;
    const me = st.me;
    if (st.phase === PHASE.LOBBY) return '\u0001';
    if (st.phase === PHASE.ENDED) return '\u0001本局已结束';
    if (!me) return '\u0001观战模式';
    if (me.status !== 'active') return `\u0001${me.role === 'student' ? '你已被淘汰' : '你已失败'}，等待本局结束`;
    if ((Number(me.frozenMs) || 0) > 0 && st.phase === PHASE.PLAYING) {
      return `\u0001被定格 ${(me.frozenMs / 1000).toFixed(1)} 秒：这段时间无法移动，但别人也拿你没办法`;
    }
    if (st.phase === PHASE.PAUSED) return 'Esc\u0001继续游戏';
    if (me.operatingPcId) return 'Esc\u0001正在使用电脑（无法移动），按 Esc 离开';
    if (me.asking) return '\u0001提问中…保持在老师身边，离开会中断';
    const t = this.renderer.interactable;
    if (t?.kind === 'teacher') return `E\u0001${t.label} · Q 提问 · F 讨好`;
    if (t) return `E\u0001${t.label}`;
    const itemHint = this.hasItems() ? ' · B 道具商店 · 1-5 使用道具' : '';
    return me.role === 'teacher'
      ? `WASD\u0001移动 · 鼠标控制朝向 · 靠近有人使用的学生电脑按 E 检查${itemHint}`
      : `WASD\u0001移动 · 去办公室找老师提问攒分，或去别人的电脑 JC${itemHint}`;
  }
}