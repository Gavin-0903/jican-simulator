// 游戏流程控制：阶段机（LOBBY → PLAYING ⇄ PAUSED → ENDED → LOBBY）、开局/续局/结束、
// 暂停与倍速、输入入队、每帧快照/增量下发、周期存档。网络层只订阅本控制器的事件。

import { EventEmitter } from 'node:events';
import { CONTROL, END_REASON, END_REASON_TEXT, EVENT, MSG, PHASE, SPEEDS, AUDIENCE } from '../../shared/constants.js';
import { buildRoster, createGameState, getChar, SCHEMA_VERSION } from './GameState.js';
import { GameLoop } from './GameLoop.js';
import { Snapshot } from './Snapshot.js';
import { hashString, randomSeed } from './Rng.js';
import { computeRanking, endRound } from '../systems/WinConditionSystem.js';
import { FlavorService } from '../llm/FlavorService.js';
import { summaryTemplate } from '../llm/templates.js';

const MAX_QUEUE = 256;

export class GameController extends EventEmitter {
  /**
   * @param {{config:{app,balance,llm,mapData}, map, saveManager?, gateway?, logger?}} opts
   */
  constructor({ config, map, saveManager = null, gateway = null, logger = console, autoStart = true }) {
    super();
    this.app = config.app;
    this.balance = config.balance;
    this.map = map;
    this.saves = saveManager;
    this.gateway = gateway;
    this.log = logger;
    this.roster = buildRoster(this.app.roster);
    this.configHash = hashString(JSON.stringify({ map: config.mapData, roster: this.app.roster, schema: SCHEMA_VERSION })).toString(16);
    this.flavor = new FlavorService({ gateway, llmCfg: config.llm });
    this.loop = new GameLoop({ map, app: this.app, balance: this.balance, flavor: this.flavor, logger });
    this.snapshot = new Snapshot({ map, balance: this.balance, stepMs: this.loop.stepMs, historySize: this.app.net.deltaHistory });
    // 多座位（v0.9）：每个玩家连接一个 viewer，各自一份视图。
    // key = 座位键（WsServer 用 conn 的唯一标识），value = { characterId, snapshot }。
    // 为什么每个 viewer 一个 Snapshot 实例：Snapshot 的 prev/seq/history 是实例状态，
    // 共用一份必然串台（A 的 prev 被 B 覆盖，B 收到的 delta 就是差的）。
    this.viewers = new Map();
    // 观战者（v0.9）：联机房间里没坐座位的人是观众，也要收「公共视图」。
    // 他们排不进 viewers（没有角色），但同样需要逐帧增量 —— 否则看着看着就停在进场那一帧。
    // key = viewerKey，value = { snapshot }（公共口径，me 恒 null）。
    this.spectators = new Map();
    // 权威状态的代数：每 install 一次 +1。用来识别「上一帧算到一半，状态被换掉了」的竞态。
    this.stateGen = 0;
    this.state = null;
    this.gameover = null;
    this.lastFullAt = 0;
    this.lastSaveAt = 0;
    gateway?.onStatus(() => this.flush());
    this.toLobby();
    if (autoStart) this.loop.start(() => this.onFrame());
  }

  get viewerId() {
    return this.state?.playerCharId ?? null;
  }

  get phase() {
    return this.state?.phase ?? PHASE.LOBBY;
  }

  llmStatus() {
    return this.gateway ? this.gateway.status() : { mode: 'disabled', reason: '未配置' };
  }

  lobbyInfo() {
    const resumable = this.saves?.latestResumable(this.configHash);
    return {
      roster: this.roster,
      round: { durationMs: this.app.round.durationMs, targetScore: this.app.round.targetScore },
      rules: {
        failScore: this.balance.student.failScore,
        initialSalary: this.balance.teacher.initialSalary,
        askReward: this.balance.ask.reward,
        askDwellMs: this.balance.ask.dwellMs,
        catchReward: this.balance.teacher.catchReward,
        classLosePenalty: this.balance.teacher.classLosePenalty,
        flatter: { min: this.balance.flatter.min, max: this.balance.flatter.max, rateMin: this.balance.flatter.successRateMin, rateMax: this.balance.flatter.successRateMax, failMin: this.balance.flatter.failPenaltyMin, failMax: this.balance.flatter.failPenaltyMax },
        interactRadius: this.balance.interact.radius,
        inspectRadius: this.balance.teacher.inspectRadius,
        viewRadius: this.balance.vision.viewRadius,
        teacherVision: { radius: this.balance.teacher.visionRadius, halfAngleDeg: this.balance.teacher.visionHalfAngleDeg },
        // 道具：大厅就把完整定价/上限下发给客户端，进入游戏后无需再请求一次
        items: this.balance.items ?? {},
      },
      resumable: resumable ? { savedAt: resumable.savedAt, ...resumable.meta, playerName: this.roster.find((r) => r.id === resumable.meta.playerCharId)?.name } : null,
      llm: this.llmStatus(),
    };
  }

  setBalance(balance) {
    this.balance = balance;
    this.map.occ.depth = balance.vision.lowCoverDepth;
    this.loop.setBalance(balance);
    this.snapshot.setBalance(balance);
  }

  // ------------------------------------------------------------ 阶段切换

  newState(seed, overrides = null) {
    const s = createGameState({ app: this.app, balance: this.balance, map: this.map, seed: seed >>> 0, configHash: this.configHash });
    s.startedAt = Date.now();
    // 房间参数（v0.9）：房主在大厅里设的单局时长/目标分，只覆盖非 null 的项，
    // 空值一律回到 config 默认（不能把 null 写进 state.roundMs，否则 WinCondition 永远不结算）。
    const round = overrides?.round ?? overrides ?? null;
    if (round) {
      const durationMs = round.durationMs == null ? null : Math.round(Number(round.durationMs));
      if (Number.isFinite(durationMs) && durationMs > 0) s.roundMs = durationMs;
      const targetScore = round.targetScore == null ? null : Math.round(Number(round.targetScore));
      if (Number.isFinite(targetScore) && targetScore >= 0) s.targetScore = targetScore;
    }
    return s;
  }

  install(state) {
    this.state = state;
    this.stateGen += 1;
    this.loop.setState(state);
    this.snapshot.reset();
    // 每个 viewer 的 prev 也必须清掉：换了 state，旧的 prev 是上一局的视图，
    // 拿它做 diff 会算出「全量变化」或者干脆漏字段。
    for (const v of this.viewers.values()) v.snapshot.reset();
    for (const v of this.spectators.values()) v.snapshot.reset();
    this.gameover = null;
  }

  /** 某个角色对应的 Snapshot 实例（按角色找第一个登记的 viewer），没有返回 null。 */
  viewerSnapshot(viewerId) {
    if (!viewerId) return this.snapshot;
    for (const v of this.viewers.values()) if (v.characterId === viewerId) return v.snapshot;
    return null;
  }

  /**
   * 登记一个玩家连接（v0.9）。key 由 WsServer 给（稳定唯一），characterId 是他的座位角色。
   * 返回该 key 对应的 Snapshot 实例（每 viewer 独立 prev/seq/history）。
   */
  attachViewer(key, characterId) {
    if (key == null || !characterId) return null;
    const k = String(key);
    let v = this.viewers.get(k);
    if (!v) {
      v = { characterId: String(characterId), snapshot: new Snapshot({ map: this.map, balance: this.balance, stepMs: this.loop.stepMs, historySize: this.app.net.deltaHistory }) };
      this.viewers.set(k, v);
    } else {
      v.characterId = String(characterId);
    }
    return v.snapshot;
  }

  /** 注销一个玩家连接。返回是否真的删掉了。 */
  detachViewer(key) {
    if (key == null) return false;
    return this.viewers.delete(String(key));
  }

  /**
   * 登记一个观战连接（v0.9）：只收公共视图，没有 me、不能操作。
   * 返回值同 attachViewer（该连接的 Snapshot 实例），没 key 返回 null。
   */
  attachSpectator(key) {
    if (key == null) return null;
    const k = String(key);
    let v = this.spectators.get(k);
    if (!v) {
      v = { snapshot: new Snapshot({ map: this.map, balance: this.balance, stepMs: this.loop.stepMs, historySize: this.app.net.deltaHistory }) };
      this.spectators.set(k, v);
    }
    return v.snapshot;
  }

  detachSpectator(key) {
    if (key == null) return false;
    return this.spectators.delete(String(key));
  }

  /** 这个 key 此刻登记的角色（没有返回 null）。 */
  viewerCharOf(key) {
    const v = this.viewers.get(String(key ?? ''));
    return v ? v.characterId : null;
  }

  toLobby() {
    const s = this.newState(this.app.seed ?? randomSeed());
    s.phase = PHASE.LOBBY;
    this.install(s);
    this.broadcastPhase();
    this.broadcastFull();
  }

  /**
   * 开一局。
   * @param {{characterId:string, seed?:number|null, round?:{durationMs?:number|null,targetScore?:number|null}, seats?:Record<string,string>}} opt
   *   - characterId：房主自己的角色（座位制下只是「主玩家」，其余座位的角色从 seats 来）
   *   - round：房主在房间里设的单局参数，只覆盖非 null 项
   *   - seats：房间座位表 username → characterId，开局时每个座位都变成人类玩家
   */
  startRound({ characterId, seed = null, round = null, seats = null }) {
    const entry = this.roster.find((r) => r.id === characterId);
    if (!entry) throw new Error('角色不存在');
    const s = this.newState(seed ?? this.app.seed ?? randomSeed(), { round });
    // 座位制：座位表里的每个角色都由人操控。没传 seats（单机/老路径）就只开房主自己。
    const seatMap = seats && typeof seats === 'object' ? seats : { '': characterId };
    const ids = [...new Set([characterId, ...Object.values(seatMap)])].filter(Boolean);
    for (const id of ids) {
      const c = getChar(s, id);
      if (c) c.control = CONTROL.HUMAN;
    }
    const me = getChar(s, characterId);
    me.control = CONTROL.HUMAN;
    s.playerCharId = me.id;
    s.phase = PHASE.PLAYING;
    this.install(s);
    // viewer 角色可能因为重连/换座而变：统一按最新座位表刷新
    for (const v of this.viewers.values()) {
      const hit = Object.entries(seatMap).find(([, cid]) => cid === v.characterId);
      if (hit) v.username = hit[0];
    }
    this.lastSaveAt = Date.now();
    this.log.info?.(`[game] 新的一局：玩家 ${me.name}（${me.id}），种子 ${s.seed}`);
    this.broadcastPhase();
    this.broadcastFull([{ type: EVENT.ROUND_START, tick: 0, actorId: me.id, text: me.role === 'student' ? '新的一局开始！先去办公室找老师提问攒积分吧。' : '新的一局开始！巡视机房，留意动别人电脑的学生。', audience: [AUDIENCE.ALL] }]);
    this.saveNow('start');
  }

  async resumeSave() {
    const latest = this.saves?.latestResumable(this.configHash);
    if (!latest) throw new Error('没有可以继续的存档');
    const s = await this.saves.load(latest.file);
    s.phase = PHASE.PAUSED;
    s.pausedReason = 'resume';
    s.inputQueue = [];
    this.install(s);
    this.log.info?.(`[game] 已读取存档，第 ${s.tick} 帧，暂停中`);
    this.broadcastPhase();
    this.broadcastFull();
  }

  quit() {
    const s = this.state;
    if (s.phase !== PHASE.PLAYING && s.phase !== PHASE.PAUSED) return;
    const events = [];
    endRound(s, { emit: (e) => events.push({ tick: s.tick, ...e }) }, END_REASON.QUIT);
    this.afterEnd(events);
  }

  pause(on, reason = 'player') {
    const s = this.state;
    if (on && s.phase === PHASE.PLAYING) {
      s.phase = PHASE.PAUSED;
      s.pausedReason = reason;
      this.saveNow('pause');
    } else if (!on && s.phase === PHASE.PAUSED) {
      s.phase = PHASE.PLAYING;
      s.pausedReason = null;
    } else {
      return false;
    }
    this.broadcastPhase();
    this.flush();
    return true;
  }

  setSpeed(mult) {
    if (!SPEEDS.includes(mult)) return false;
    this.state.speedMult = mult;
    this.flush();
    return true;
  }

  /** 玩家输入入队：与 AI 意图同构，下个 tick 统一消费。 */
  enqueue(charId, type, payload, seq = null) {
    const s = this.state;
    if (s.phase !== PHASE.PLAYING) return false;
    if (s.inputQueue.length >= MAX_QUEUE) return false;
    s.inputQueue.push({ charId, type, payload, seq });
    return true;
  }

  onConnectionLost() {
    if (this.state.phase === PHASE.PLAYING) this.pause(true, 'disconnect');
  }

  onConnectionRestored() {
    if (this.state.phase === PHASE.PAUSED && this.state.pausedReason === 'disconnect') this.pause(false);
  }

  // ------------------------------------------------------------ 帧输出

  /**
   * 这条 packets 要发给谁：多座位时每个 viewer 一份（各自 viewerId），单机时还走老的群发。
   * 返回 [{ key, characterId, snapshot }]，key=null 表示「老的单机群发包」。
   */
  packetTargets() {
    if (this.viewers.size > 0) {
      return [...this.viewers.entries()].map(([key, v]) => ({ key, characterId: v.characterId, snapshot: v.snapshot }));
    }
    return [{ key: null, characterId: this.viewerId, snapshot: this.snapshot }];
  }

  /** 发一个包给某个目标：多座位走 onPrivateTo（只给那个连接），单机走老 packet 事件。 */
  emitTo(target, type, payload) {
    if (target.key == null) this.emit('packet', type, payload);
    else this.emit('privateTo', target.key, type, payload);
  }

  onFrame() {
    const out = this.loop.drain();
    // 私有消息（对话框/错误）按每个 viewer 自己的角色过滤，不能再只看 playerCharId
    for (const target of this.packetTargets()) {
      const viewer = target.characterId;
      for (const d of out.dialogs) if (d.charId === viewer) this.emitTo(target, MSG.DIALOG, d.payload);
      for (const e of out.errors) {
        if (e.charId !== viewer) continue;
        const { charId, ...rest } = e;
        this.emitTo(target, MSG.ERROR, rest);
      }
    }
    if (this.state.phase === PHASE.ENDED && !this.gameover) return this.afterEnd(out.events);
    this.flush(out.events);
    if (this.saves && this.state.phase === PHASE.PLAYING && Date.now() - this.lastSaveAt >= this.app.save.everyMs) this.saveNow('auto');
  }

  flush(events = []) {
    if (!this.state) return;
    // 一帧之内状态可能被换掉（开局/回大厅）；换了就不再对旧状态算包，
    // 否则观战者会收到「旧局的 LOBBY 视图」把开局后的新视图盖回去（详见 fullPublic/install）。
    const gen = this.stateGen;
    if (Date.now() - this.lastFullAt >= this.app.net.fullSnapshotMs) return this.broadcastFull(events);
    const llm = this.llmStatus();
    for (const target of this.packetTargets()) {
      if (gen !== this.stateGen) return;
      const payload = target.snapshot.delta(this.state, target.characterId, events, llm);
      if (payload) this.emitTo(target, MSG.DELTA, payload);
    }
    for (const [key, v] of this.spectators) {
      if (gen !== this.stateGen) return;
      const payload = v.snapshot.deltaPublic(this.state, events, llm);
      if (payload) this.emit('privateTo', key, MSG.DELTA, payload);
    }
  }

  broadcastFull(events = []) {
    if (!this.state) return;
    const llm = this.llmStatus();
    for (const target of this.packetTargets()) {
      const payload = target.snapshot.full(this.state, target.characterId, events, llm);
      this.emitTo(target, MSG.SNAPSHOT, payload);
    }
    this.lastFullAt = Date.now();
    for (const [key, v] of this.spectators) {
      const payload = v.snapshot.fullPublic(this.state, events, llm);
      this.emit('privateTo', key, MSG.SNAPSHOT, payload);
    }
  }

  broadcastPhase() {
    const s = this.state;
    this.emit('packet', MSG.PHASE, { phase: s.phase, roundMs: s.roundMs, reason: s.pausedReason });
  }

  afterEnd(events = []) {
    const s = this.state;
    s.ranking ??= computeRanking(s);
    const reason = s.result?.reason ?? END_REASON.TIME_UP;
    // 多座位：结算要按「每个观众自己的角色」给出玩家视角（playerCharId + 名次）,
    // 所以底下群发的这份 gameover 用主玩家，具体的个人视角在 emitTo 时按 viewer 覆写。
    this.gameover = {
      reason,
      reasonText: END_REASON_TEXT[reason],
      winnerId: s.result?.winnerId ?? null,
      playerCharId: s.playerCharId,
      seed: s.seed,
      durationMs: Math.round(s.elapsedMs),
      ranking: s.ranking,
      stats: s.stats,
      summary: summaryTemplate(s, s.ranking),
      summarySource: 'template',
    };
    this.broadcastPhase();
    this.broadcastFull(events);
    // 每个人的 gameover 里 playerCharId 要是「他自己那个角色」，否则前端会拿别人的成绩当自己的
    for (const target of this.packetTargets()) {
      const payload = target.key == null || !target.characterId ? this.gameover : { ...this.gameover, playerCharId: target.characterId };
      this.emitTo(target, MSG.GAMEOVER, payload);
    }
    // 先给出模板小结；LLM 可用时异步生成更自然的版本再覆盖
    if (this.gateway?.available) {
      const ref = this.gameover;
      this.flavor.summarize(s, s.ranking).then(({ text, source }) => {
        if (this.gameover !== ref || source !== 'llm') return;
        ref.summary = text;
        ref.summarySource = source;
        this.emit('packet', MSG.DIALOG, { kind: 'summary', text, source });
      });
    }
    this.saveNow('end');
    this.log.info?.(`[game] 本局结束：${END_REASON_TEXT[reason]}`);
  }

  saveNow(reason) {
    const s = this.state;
    if (!this.saves || !s?.playerCharId || s.phase === PHASE.LOBBY) return Promise.resolve();
    this.lastSaveAt = Date.now();
    return this.saves.save(s, reason);
  }

  // ------------------------------------------------------------ 连接初始化 / 重连

  /** 新连接（或重连）需要的初始消息序列。lastSeq 可用时尝试补发增量。 */
  /**
   * 新连接（或重连）需要的初始消息序列。lastSeq 可用时尝试补发增量。
   * @param {number|null} lastSeq
   * @param {string|null} key 观众键（多座位）。传了就用该 viewer 自己的 Snapshot 与角色；
   *   不传 = 老的单机 path（用 this.snapshot / this.viewerId）。
   */
  initialMessages(lastSeq = null, key = null) {
    const msgs = [[MSG.PHASE, { phase: this.state.phase, roundMs: this.state.roundMs, reason: this.state.pausedReason }]];
    // 观战者：公共视图（me=null），走自己那份 Snapshot，重连时按 lastSeq 补公共增量
    const spec = key != null && !this.viewers.has(String(key)) ? this.spectators.get(String(key)) : null;
    const v = key == null ? null : this.viewers.get(String(key));
    const snap = spec ? spec.snapshot : (v ? v.snapshot : this.snapshot);
    const viewerId = spec ? null : (v ? v.characterId : this.viewerId);
    const replay = lastSeq != null ? snap.since(lastSeq) : null;
    if (replay) for (const p of replay) msgs.push([p.type === 'snapshot' ? MSG.SNAPSHOT : MSG.DELTA, p.payload]);
    else {
      const payload = spec ? snap.fullPublic(this.state, [], this.llmStatus()) : snap.full(this.state, viewerId, [], this.llmStatus());
      this.lastFullAt = Date.now();
      msgs.push([MSG.SNAPSHOT, payload]);
    }
    // 结算包同样要按这个 viewer 的角色给出（gameover.playerCharId 决定前端显示谁的成绩）
    if (this.gameover) {
      msgs.push([MSG.GAMEOVER, key != null && viewerId ? { ...this.gameover, playerCharId: viewerId } : this.gameover]);
    }
    return msgs;
  }

  health() {
    return {
      phase: this.state.phase,
      tick: this.state.tick,
      elapsedMs: Math.round(this.state.elapsedMs),
      speedMult: this.state.speedMult,
      loop: this.loop.tickStats(),
      memory: { rssMB: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10, heapMB: Math.round((process.memoryUsage().heapUsed / 1048576) * 10) / 10 },
      llm: this.llmStatus(),
    };
  }

  async close() {
    this.loop.stop();
    if (this.state && (this.state.phase === PHASE.PLAYING || this.state.phase === PHASE.PAUSED)) {
      if (this.state.phase === PHASE.PLAYING) {
        this.state.phase = PHASE.PAUSED;
        this.state.pausedReason = 'shutdown';
      }
      await this.saveNow('shutdown');
    }
    await this.saves?.flush();
  }
}
