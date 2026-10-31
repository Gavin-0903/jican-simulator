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

  newState(seed) {
    const s = createGameState({ app: this.app, balance: this.balance, map: this.map, seed: seed >>> 0, configHash: this.configHash });
    s.startedAt = Date.now();
    return s;
  }

  install(state) {
    this.state = state;
    this.loop.setState(state);
    this.snapshot.reset();
    this.gameover = null;
  }

  toLobby() {
    const s = this.newState(this.app.seed ?? randomSeed());
    s.phase = PHASE.LOBBY;
    this.install(s);
    this.broadcastPhase();
    this.broadcastFull();
  }

  startRound({ characterId, seed = null }) {
    const entry = this.roster.find((r) => r.id === characterId);
    if (!entry) throw new Error('角色不存在');
    const s = this.newState(seed ?? this.app.seed ?? randomSeed());
    const me = getChar(s, characterId);
    me.control = CONTROL.HUMAN;
    s.playerCharId = me.id;
    s.phase = PHASE.PLAYING;
    this.install(s);
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

  onFrame() {
    const out = this.loop.drain();
    const viewer = this.viewerId;
    for (const d of out.dialogs) if (d.charId === viewer) this.emit('private', MSG.DIALOG, d.payload);
    for (const e of out.errors) {
      if (e.charId !== viewer) continue;
      const { charId, ...rest } = e;
      this.emit('private', MSG.ERROR, rest);
    }
    if (this.state.phase === PHASE.ENDED && !this.gameover) return this.afterEnd(out.events);
    this.flush(out.events);
    if (this.saves && this.state.phase === PHASE.PLAYING && Date.now() - this.lastSaveAt >= this.app.save.everyMs) this.saveNow('auto');
  }

  flush(events = []) {
    if (!this.state) return;
    if (Date.now() - this.lastFullAt >= this.app.net.fullSnapshotMs) return this.broadcastFull(events);
    const payload = this.snapshot.delta(this.state, this.viewerId, events, this.llmStatus());
    if (payload) this.emit('packet', MSG.DELTA, payload);
  }

  broadcastFull(events = []) {
    const payload = this.snapshot.full(this.state, this.viewerId, events, this.llmStatus());
    this.lastFullAt = Date.now();
    this.emit('packet', MSG.SNAPSHOT, payload);
  }

  broadcastPhase() {
    const s = this.state;
    this.emit('packet', MSG.PHASE, { phase: s.phase, roundMs: s.roundMs, reason: s.pausedReason });
  }

  afterEnd(events = []) {
    const s = this.state;
    s.ranking ??= computeRanking(s);
    const reason = s.result?.reason ?? END_REASON.TIME_UP;
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
    this.emit('packet', MSG.GAMEOVER, this.gameover);
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
  initialMessages(lastSeq = null) {
    const msgs = [[MSG.PHASE, { phase: this.state.phase, roundMs: this.state.roundMs, reason: this.state.pausedReason }]];
    const replay = lastSeq != null ? this.snapshot.since(lastSeq) : null;
    if (replay) for (const p of replay) msgs.push([p.type === 'snapshot' ? MSG.SNAPSHOT : MSG.DELTA, p.payload]);
    else {
      const payload = this.snapshot.full(this.state, this.viewerId, [], this.llmStatus());
      this.lastFullAt = Date.now();
      msgs.push([MSG.SNAPSHOT, payload]);
    }
    if (this.gameover) msgs.push([MSG.GAMEOVER, this.gameover]);
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
