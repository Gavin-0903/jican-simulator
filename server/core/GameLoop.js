// 固定步长循环（累加器模式）+ 帧流水线编排。本身不含任何业务规则。
//
// step(dt):
//   1. 消费输入队列（玩家输入与上一 tick 的 AI 意图同构，统一消费）
//   2. AI 决策（按频率）→ 产生意图写入队列，下个 tick 消费
//   3. MoveSystem → 4. InteractionSystem → 5. BuffSystem → 6. VisionSystem → 7. ScoreSystem → 8. WinConditionSystem
//   （9–11 快照/广播/存档由 GameController 在每帧结束后处理）
// 顺序不可随意调换：Vision 依赖本帧 JC 结果，Score 依赖目击结果。

import { performance } from 'node:perf_hooks';
import { CONTROL, ERR, PHASE, STATUS } from '../../shared/constants.js';
import { clampLen } from '../../shared/math.js';
import { Rng } from './Rng.js';
import { getChar } from './GameState.js';
import { MoveSystem } from '../systems/MoveSystem.js';
import { InteractionSystem } from '../systems/InteractionSystem.js';
import { BuffSystem } from '../systems/BuffSystem.js';
import { VisionSystem } from '../systems/VisionSystem.js';
import { ScoreSystem } from '../systems/ScoreSystem.js';
import { WinConditionSystem } from '../systems/WinConditionSystem.js';
import { RuleAIEngine } from '../ai/RuleAIEngine.js';
import { FlavorService } from '../llm/FlavorService.js';

const MAX_PENDING_ACTIONS = 6;

export class GameLoop {
  /**
   * @param {{map, app, balance, flavor?, ai?, logger?, strict?:boolean}} opts
   *   strict=true 时系统异常直接抛出（测试用）；否则隔离异常，单系统出错不崩整局。
   */
  constructor({ map, app, balance, flavor = null, ai = null, logger = console, strict = false }) {
    this.map = map;
    this.app = app;
    this.balance = balance;
    this.flavor = flavor ?? new FlavorService();
    this.ai = ai ?? new RuleAIEngine();
    this.log = logger;
    this.strict = strict;
    this.pipeline = [
      ['move', new MoveSystem()],
      ['interaction', new InteractionSystem()],
      ['buff', new BuffSystem()],
      ['vision', new VisionSystem()],
      ['score', new ScoreSystem()],
      ['win', new WinConditionSystem()],
    ];
    this.state = null;
    this.out = { events: [], dialogs: [], errors: [] };
    this.metrics = { ticks: 0, errors: 0, lastMs: 0, maxMs: 0, samples: [] };
    this.timer = null;
    this.acc = 0;
  }

  get stepMs() {
    return 1000 / this.app.tickRate;
  }

  setState(state) {
    this.state = state;
    this.acc = 0;
    this.out = { events: [], dialogs: [], errors: [] };
  }

  setBalance(balance) {
    this.balance = balance;
  }

  makeContext(frame) {
    const loop = this;
    const s = this.state;
    const stepMs = this.stepMs;
    const ctx = {
      app: this.app,
      balance: this.balance,
      map: this.map,
      stepMs,
      frame,
      log: this.log,
      toTicks: (ms) => Math.max(0, Math.ceil(ms / stepMs - 1e-9)),
      ticksToMs: (t) => Math.round(t * stepMs),
      rngOf: (c) => new Rng(c.rng),
      emit(ev) {
        loop.out.events.push({ tick: s.tick, actorId: null, targetId: null, amount: null, pos: null, text: null, ...ev });
      },
      dialog(c, payload) {
        if (c.control === CONTROL.HUMAN) loop.out.dialogs.push({ charId: c.id, payload });
      },
      ok(c, kind, extra = {}) {
        c.lastResult = { kind, ok: true, tick: s.tick, ...extra };
      },
      fail(c, kind, code, message, action = null, extra = {}) {
        c.lastResult = { kind, ok: false, code, message, tick: s.tick, ...extra };
        if (c.control === CONTROL.HUMAN) loop.out.errors.push({ charId: c.id, code, message, kind, refSeq: action?._seq ?? null, ...extra });
      },
      say(c, kind, vars) {
        loop.flavor.say(s, ctx, c, kind, vars);
      },
      notifyAi(c, type, data) {
        if (c.ai) c.ai.events.push({ type, ...data, tick: s.tick });
      },
    };
    return ctx;
  }

  /** 执行一个逻辑帧。返回是否真的推进了。 */
  step() {
    const s = this.state;
    if (!s || s.phase !== PHASE.PLAYING) return false;
    const t0 = performance.now();
    s.tick += 1;
    s.elapsedMs += this.stepMs;
    const frame = { pendingJc: [], pendingCatches: [] };
    const ctx = this.makeContext(frame);
    this.guard('flavor', () => this.flavor.applyResults(s));
    this.guard('input', () => this.consumeInputs(s, ctx));
    this.guard('ai', () => this.ai.update(s, ctx));
    for (const [name, sys] of this.pipeline) this.guard(name, () => sys.update(s, ctx));
    this.guard('speech', () => this.expireSpeech(s));
    this.guard('persona', () => this.flavor.maybeRefreshPersona(s, ctx));
    const ms = performance.now() - t0;
    const m = this.metrics;
    m.ticks += 1;
    m.lastMs = ms;
    if (ms > m.maxMs) m.maxMs = ms;
    m.samples.push(ms);
    if (m.samples.length > 600) m.samples.shift();
    return true;
  }

  guard(name, fn) {
    if (this.strict) return fn();
    try {
      return fn();
    } catch (err) {
      this.metrics.errors += 1;
      this.log.error?.(`[loop] 系统「${name}」异常，已隔离：${err.stack || err.message}`);
      return undefined;
    }
  }

  consumeInputs(s, ctx) {
    const queue = s.inputQueue;
    s.inputQueue = [];
    for (const it of queue) {
      const c = getChar(s, it.charId);
      if (!c) continue;
      const p = it.payload || {};
      if (c.status !== STATUS.ACTIVE) {
        if (it.type !== 'move') ctx.fail(c, p.kind ?? it.type, ERR.ELIMINATED, '你已退出本局', { _seq: it.seq });
        continue;
      }
      if (it.type === 'move') {
        c.inputDir = clampLen({ x: Number(p.dir?.x) || 0, y: Number(p.dir?.y) || 0 }, 1);
        c.faceTarget = typeof p.face === 'number' && Number.isFinite(p.face) ? p.face : null;
      } else if (c.pendingActions.length < MAX_PENDING_ACTIONS) {
        if (it.type === 'jc.commit') c.pendingActions.push({ kind: 'jc.commit', selfUsername: p.selfUsername, amount: p.amount, _seq: it.seq ?? null });
        else if (it.type === 'action') c.pendingActions.push({ ...p, _seq: it.seq ?? null });
      }
    }
  }

  expireSpeech(s) {
    for (const c of s.characters) {
      if (c.speech && c.speechUntil <= s.tick) c.speech = null;
    }
  }

  /** 取出本帧产出（事件、对话框、错误），供控制器下发。 */
  drain() {
    const out = this.out;
    this.out = { events: [], dialogs: [], errors: [] };
    return out;
  }

  tickStats() {
    const s = [...this.metrics.samples].sort((a, b) => a - b);
    const q = (p) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 1000) / 1000 : 0);
    const avg = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
    return { ticks: this.metrics.ticks, errors: this.metrics.errors, avgMs: Math.round(avg * 1000) / 1000, p95Ms: q(0.95), p99Ms: q(0.99), maxMs: Math.round(this.metrics.maxMs * 1000) / 1000 };
  }

  /** 以实时时钟驱动（服务端用）；倍速通过缩放累加器实现。 */
  start(onFrame) {
    this.stop();
    let last = performance.now();
    this.acc = 0;
    const maxSteps = this.app.loop?.maxCatchUpSteps ?? 5;
    this.timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(now - last, 1000);
      last = now;
      const s = this.state;
      if (!s || s.phase !== PHASE.PLAYING) {
        this.acc = 0;
        return;
      }
      this.acc += dt * s.speedMult;
      let steps = 0;
      while (this.acc >= this.stepMs && steps < maxSteps) {
        this.step();
        this.acc -= this.stepMs;
        steps++;
        if (s.phase !== PHASE.PLAYING) break;
      }
      if (steps >= maxSteps) this.acc = Math.min(this.acc, this.stepMs); // 防雪崩：不追补过多 tick
      if (steps) onFrame?.(steps);
    }, 20);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
