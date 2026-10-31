// 前端状态镜像（只读）：保存最新快照/增量，并为每个角色维护位置样本做插值。
// 任何数值都以服务端为准；本地只做显示层面的插值与外推。

import { PHASE } from '/shared/constants.js';
import { lerp, lerpAngle } from '/shared/math.js';

const MAX_SAMPLES = 8;

export class GameStore extends EventTarget {
  constructor() {
    super();
    this.map = null;
    this.lobby = null;
    this.role = 'pending';
    this.tickRate = 10;
    this.phase = PHASE.LOBBY;
    this.pausedReason = null;
    this.game = {};
    this.gameRecvAt = 0;
    this.roster = new Map();
    this.pcOwner = new Map();
    this.chars = new Map();
    this.pcs = new Map();
    this.me = null;
    this.lastSeq = 0;
    this.gameover = null;
    this.eventLog = [];
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get tickMs() {
    return 1000 / this.tickRate;
  }

  get playerId() {
    return this.game.playerCharId ?? null;
  }

  welcome(p) {
    this.role = p.role;
    this.tickRate = p.tickRate;
    this.lobby = p.lobby;
    this.emit('lobby', p.lobby);
  }

  setPhase(p) {
    const changed = p.phase !== this.phase || p.reason !== this.pausedReason;
    this.phase = p.phase;
    this.pausedReason = p.reason ?? null;
    if (p.phase === PHASE.LOBBY || p.phase === PHASE.PLAYING) this.gameover = null;
    if (changed) this.emit('phase', p);
  }

  setGameover(p) {
    this.gameover = p;
    this.emit('gameover', p);
  }

  applySnapshot(p) {
    const now = performance.now();
    const st = p.state;
    this.lastSeq = p.seq;
    this.roster = new Map(st.roster.map((r) => [r.id, r]));
    this.pcOwner = new Map(st.roster.map((r) => [r.homePcId, r]));
    this.chars = new Map();
    for (const c of st.chars) this.chars.set(c.id, { data: c, samples: [{ t: now, x: c.x, y: c.y, f: c.f }] });
    this.pcs = new Map(st.pcs.map((pc) => [pc.id, pc]));
    this.applyGame(st.game, now);
    this.me = st.me;
    this.emit('snapshot', p);
    this.emit('me', this.me);
    if (p.events?.length) this.pushEvents(p.events);
  }

  /** 返回 false 表示序号不连续，需要请求全量。 */
  applyDelta(p) {
    if (p.seq !== this.lastSeq + 1) return false;
    this.lastSeq = p.seq;
    const now = performance.now();
    if (p.game) this.applyGame(p.game, now);
    if (p.chars) {
      for (const d of p.chars) {
        const entry = this.chars.get(d.id);
        if (!entry) continue;
        Object.assign(entry.data, d);
        if ('x' in d || 'y' in d || 'f' in d) this.pushSample(entry, now);
      }
    }
    if (p.pcs) for (const d of p.pcs) Object.assign(this.pcs.get(d.id) ?? {}, d);
    if (p.me) {
      this.me = { ...(this.me || {}), ...p.me };
      this.emit('me', this.me);
    }
    if (p.events?.length) this.pushEvents(p.events);
    this.emit('delta', p);
    return true;
  }

  applyGame(g, now) {
    const prevPhase = this.game.phase;
    Object.assign(this.game, g);
    if ('elapsedMs' in g || 'phase' in g || 'speedMult' in g) this.gameRecvAt = now;
    if (g.phase && g.phase !== prevPhase && g.phase !== this.phase) this.setPhase({ phase: g.phase, reason: this.game.pausedReason });
    if ('llm' in g) this.emit('llm', g.llm);
  }

  pushSample(entry, now) {
    const s = entry.samples;
    const last = s[s.length - 1];
    // 长时间静止后重新开始移动：补一个「上一位置」样本，避免插值被拉长
    if (last && now - last.t > this.tickMs * 2.5) s.push({ t: now - this.tickMs, x: last.x, y: last.y, f: last.f });
    s.push({ t: now, x: entry.data.x, y: entry.data.y, f: entry.data.f });
    while (s.length > MAX_SAMPLES) s.shift();
  }

  pushEvents(events) {
    for (const e of events) {
      this.eventLog.push({ ...e, at: Date.now() });
      if (this.eventLog.length > 60) this.eventLog.shift();
    }
    this.emit('events', events);
  }

  /** 在 renderTime 时刻插值得到角色位置与朝向。 */
  sample(id, renderTime) {
    const entry = this.chars.get(id);
    if (!entry) return null;
    const s = entry.samples;
    if (!s.length) return { x: entry.data.x, y: entry.data.y, f: entry.data.f };
    if (renderTime <= s[0].t) return s[0];
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1];
      const b = s[i];
      if (renderTime >= a.t && renderTime <= b.t) {
        const k = (renderTime - a.t) / Math.max(1, b.t - a.t);
        return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), f: lerpAngle(a.f, b.f, k) };
      }
    }
    return s[s.length - 1];
  }

  /** 本地外推的已进行时间（仅用于倒计时显示）。 */
  elapsedNow() {
    const g = this.game;
    let e = g.elapsedMs ?? 0;
    if (this.phase === PHASE.PLAYING) e += Math.min(250, performance.now() - this.gameRecvAt) * (g.speedMult ?? 1);
    return e;
  }

  rosterEntry(id) {
    return this.roster.get(id) ?? this.lobby?.roster?.find((r) => r.id === id) ?? null;
  }

  myChar() {
    return this.playerId ? this.chars.get(this.playerId)?.data ?? null : null;
  }
}
