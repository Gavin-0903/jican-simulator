// LLM 网关：Provider 抽象 + 队列/并发上限 + 超时 + 熔断（半开探测）+ Schema 校验 + 降级。
// request() 永不抛错：任何失败都返回 null，由调用方使用模板结果兜底。LLM 绝不进入关键路径。

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { OllamaProvider } from './providers/OllamaProvider.js';
import { OpenAICompatProvider } from './providers/OpenAICompatProvider.js';
import { validate, extractJson } from './validate.js';

const KINDS = ['speech', 'persona', 'summary'];

const percentile = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};

export function createProvider(cfg) {
  const common = { temperature: cfg.temperature, maxTokens: cfg.maxTokens };
  if (cfg.provider === 'openai-compat') return new OpenAICompatProvider({ ...cfg.openaiCompat, ...common });
  return new OllamaProvider({ ...cfg.ollama, ...common });
}

export class LlmGateway {
  constructor(cfg, { logger = console, dir = dirname(fileURLToPath(import.meta.url)), provider = null } = {}) {
    this.cfg = cfg;
    this.log = logger;
    this.enabled = !!cfg.enabled;
    this.provider = provider ?? (this.enabled ? createProvider(cfg) : null);
    this.healthy = false;
    this.reason = this.enabled ? '尚未完成健康检查' : '配置中已关闭（config/llm.json → enabled=false）';
    this.circuit = { state: 'closed', fails: 0, openUntil: 0 };
    this.queue = [];
    this.active = 0;
    this.metrics = { ok: 0, fail: 0, degraded: 0, dropped: 0, latencies: [] };
    this.prompts = {};
    this.schemas = {};
    for (const kind of KINDS) {
      const p = join(dir, 'prompts', `${kind}.md`);
      const s = join(dir, 'schema', `${kind}.json`);
      if (existsSync(p)) this.prompts[kind] = readFileSync(p, 'utf8');
      if (existsSync(s)) this.schemas[kind] = JSON.parse(readFileSync(s, 'utf8'));
    }
    this.timer = null;
    this.listeners = new Set();
  }

  onStatus(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emitStatus() {
    for (const fn of this.listeners) fn(this.status());
  }

  async init() {
    if (!this.enabled) {
      this.log.info?.('[llm] AI 增强已关闭，使用纯规则 AI');
      return this.status();
    }
    await this.checkHealth();
    if (this.cfg.recheckMs > 0) {
      this.timer = setInterval(() => {
        if (!this.healthy) this.checkHealth();
      }, this.cfg.recheckMs);
      this.timer.unref?.();
    }
    return this.status();
  }

  async checkHealth() {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.cfg.healthTimeoutMs);
    const was = this.healthy;
    try {
      await this.provider.health(ac.signal);
      this.healthy = true;
      this.reason = null;
      if (!was) this.log.info?.(`[llm] AI 增强已启用：${this.provider.name} / ${this.provider.model}`);
    } catch (err) {
      this.healthy = false;
      this.reason = err.name === 'AbortError' ? `连接 ${this.provider.baseURL} 超时` : `不可用：${err.cause?.code || err.message}`;
      if (was || !this.warned) this.log.warn?.(`[llm] LLM 已降级为纯规则 AI（${this.reason}）`);
      this.warned = true;
    } finally {
      clearTimeout(t);
      if (was !== this.healthy) this.emitStatus();
    }
    return this.healthy;
  }

  get available() {
    if (!this.enabled || !this.healthy) return false;
    if (this.circuit.state === 'open' && Date.now() < this.circuit.openUntil) return false;
    return true;
  }

  /** @returns {Promise<object|null>} 校验通过的结构化结果，失败为 null */
  request(kind, vars) {
    if (!this.available || !this.prompts[kind]) {
      this.metrics.degraded++;
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      if (this.queue.length >= this.cfg.queueMax) {
        this.queue.shift().resolve(null); // 队列满：丢弃最旧任务
        this.metrics.dropped++;
      }
      this.queue.push({ kind, vars, resolve });
      this.pump();
    });
  }

  pump() {
    while (this.active < this.cfg.maxConcurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.run(job).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  render(kind, vars) {
    return this.prompts[kind].replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''));
  }

  async run(job) {
    if (this.circuit.state === 'open') {
      if (Date.now() < this.circuit.openUntil) {
        this.metrics.degraded++;
        return job.resolve(null);
      }
      this.circuit.state = 'half-open'; // 半开：放行一次试探
    }
    const messages = [
      { role: 'system', content: '你是游戏台词生成器。只输出一个 JSON 对象，不要输出其他内容。' },
      { role: 'user', content: this.render(job.kind, job.vars) },
    ];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    const t0 = performance.now();
    try {
      const text = await this.provider.chat(messages, ac.signal);
      const obj = JSON.parse(extractJson(text));
      const errors = this.schemas[job.kind] ? validate(this.schemas[job.kind], obj) : [];
      if (errors.length) throw new Error(`输出不符合 Schema：${errors[0]}`);
      this.onSuccess(performance.now() - t0);
      job.resolve(obj);
    } catch (err) {
      this.onFailure(err.name === 'AbortError' ? new Error('超时') : err);
      job.resolve(null);
    } finally {
      clearTimeout(timer);
    }
  }

  onSuccess(ms) {
    this.metrics.ok++;
    this.metrics.latencies.push(ms);
    if (this.metrics.latencies.length > 100) this.metrics.latencies.shift();
    const wasOpen = this.circuit.state !== 'closed';
    this.circuit = { state: 'closed', fails: 0, openUntil: 0 };
    if (wasOpen) {
      this.log.info?.('[llm] 熔断恢复，AI 增强重新启用');
      this.emitStatus();
    }
  }

  onFailure(err) {
    this.metrics.fail++;
    this.circuit.fails++;
    if (this.circuit.state === 'half-open' || this.circuit.fails >= this.cfg.circuit.failThreshold) {
      this.circuit.state = 'open';
      this.circuit.openUntil = Date.now() + this.cfg.circuit.openMs;
      this.reason = `连续失败（${err.message}），熔断 ${Math.round(this.cfg.circuit.openMs / 1000)} 秒`;
      this.log.warn?.(`[llm] LLM 已降级：${this.reason}`);
      this.emitStatus();
    }
  }

  status() {
    const mode = !this.enabled ? 'disabled' : this.available ? 'llm' : 'degraded';
    return {
      enabled: this.enabled,
      mode,
      provider: this.provider?.name ?? null,
      model: this.provider?.model ?? null,
      healthy: this.healthy,
      circuit: this.circuit.state,
      reason: mode === 'llm' ? null : this.reason,
      metrics: {
        ok: this.metrics.ok,
        fail: this.metrics.fail,
        degraded: this.metrics.degraded,
        dropped: this.metrics.dropped,
        p50: percentile(this.metrics.latencies, 50),
        p95: percentile(this.metrics.latencies, 95),
      },
    };
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    for (const job of this.queue) job.resolve(null);
    this.queue = [];
  }
}
