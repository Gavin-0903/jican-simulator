// 「风味」服务：角色台词（模板即时生效，LLM 结果异步覆写）、AI 性格倾向刷新、回合小结。
// LLM 结果先进入 results 队列，由主循环在下一个 tick 开头统一写回，绝不在 tick 中途修改状态。

import { CONTROL, ROLE } from '../../shared/constants.js';
import { clamp } from '../../shared/math.js';
import { getChar } from '../core/GameState.js';
import { renderLine, situationOf, summaryTemplate } from './templates.js';

const sanitize = (s, max = 40) => String(s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

export class FlavorService {
  constructor({ gateway = null, llmCfg = {} } = {}) {
    this.gateway = gateway;
    this.rate = llmCfg.rate ?? { speechPerCharMs: 60000, victimPerCharMs: 30000, personaEveryMs: 120000, personaBatch: 6 };
    this.lastCall = new Map();
    this.results = [];
    this.personaCursor = 0;
  }

  /** 设置台词：模板立即生效；若 LLM 可用且未超频，异步请求更自然的台词。 */
  say(state, ctx, c, kind, vars = {}) {
    c.speech = renderLine(kind, vars, ctx.rngOf(c));
    c.speechKey = (c.speechKey + 1) | 0;
    c.speechUntil = state.tick + ctx.toTicks(ctx.balance.speech.durationMs);
    if (!this.gateway?.available || c.control !== CONTROL.AI) return;
    const limit = kind === 'victim' ? this.rate.victimPerCharMs : this.rate.speechPerCharMs;
    const key = `${c.id}:${kind}`;
    const now = Date.now();
    if (now - (this.lastCall.get(key) ?? 0) < limit) return;
    this.lastCall.set(key, now);
    const speechKey = c.speechKey;
    this.gateway
      .request('speech', { role: c.role === ROLE.STUDENT ? '学生' : '老师', name: c.name, situation: situationOf(kind, vars) })
      .then((res) => {
        if (res?.speech) this.results.push({ type: 'speech', charId: c.id, key: speechKey, speech: sanitize(res.speech), moodDelta: res.moodDelta });
      });
  }

  /** 每隔 personaEveryMs（游戏时间）为一小批 AI 学生请求性格倾向微调。 */
  maybeRefreshPersona(state, ctx) {
    if (!this.gateway?.available) return;
    const every = ctx.toTicks(this.rate.personaEveryMs);
    if (state.tick % every !== 1) return;
    const ais = state.characters.filter((c) => c.control === CONTROL.AI && c.role === ROLE.STUDENT && c.ai);
    for (let i = 0; i < Math.min(this.rate.personaBatch, ais.length); i++) {
      const c = ais[(this.personaCursor + i) % ais.length];
      const band = c.score > 200 ? '安全' : c.score <= -400 ? '危险' : '一般';
      this.gateway
        .request('persona', { name: c.name, risk: c.ai.persona.risk.toFixed(2), social: c.ai.persona.social.toFixed(2), band })
        .then((res) => {
          if (res) this.results.push({ type: 'persona', charId: c.id, riskDelta: res.riskDelta, socialDelta: res.socialDelta });
        });
    }
    this.personaCursor += this.rate.personaBatch;
  }

  /** 在 tick 开头写回异步结果。 */
  applyResults(state) {
    if (!this.results.length) return;
    const list = this.results;
    this.results = [];
    for (const r of list) {
      const c = getChar(state, r.charId);
      if (!c) continue;
      if (r.type === 'speech') {
        if (c.speechKey === r.key && c.speechUntil > state.tick) c.speech = r.speech;
        if (c.ai && typeof r.moodDelta === 'number') c.ai.moodBias = clamp((c.ai.moodBias ?? 0) + r.moodDelta * 0.05, -0.15, 0.15);
      } else if (r.type === 'persona' && c.ai) {
        c.ai.persona.risk = clamp(c.ai.persona.risk + r.riskDelta * 0.15, 0, 1);
        c.ai.persona.social = clamp(c.ai.persona.social + r.socialDelta * 0.15, 0, 1);
      }
    }
  }

  /** 回合小结：先给模板文案，LLM 可用时再尝试生成（调用方决定是否等待）。 */
  async summarize(state, ranking) {
    const text = summaryTemplate(state, ranking);
    if (!this.gateway?.available) return { text, source: 'template' };
    const res = await this.gateway.request('summary', { facts: text });
    return res?.summary ? { text: sanitize(res.summary, 160), source: 'llm' } : { text, source: 'template' };
  }
}
