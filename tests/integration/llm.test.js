// 集成：LLM 网关的降级、超时、熔断与 Schema 校验（使用假 Provider，不依赖真实模型）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmGateway } from '../../server/llm/LlmGateway.js';
import { quiet } from '../helpers.js';

const cfg = (over = {}) => ({
  enabled: true, provider: 'ollama', ollama: { baseURL: 'http://127.0.0.1:1', model: 'qwen2:0.5b' },
  timeoutMs: 200, healthTimeoutMs: 200, recheckMs: 0, maxConcurrency: 1, queueMax: 2,
  circuit: { failThreshold: 3, openMs: 60000 }, temperature: 0.8, maxTokens: 64, ...over,
});

const fake = (chat, health = async () => true) => ({ name: 'fake', model: 'fake-0.5b', baseURL: 'fake://', health, chat });

test('配置关闭：不发请求，返回 null，状态为 disabled', async () => {
  const gw = new LlmGateway(cfg({ enabled: false }), { logger: quiet });
  await gw.init();
  assert.equal(gw.status().mode, 'disabled');
  assert.equal(await gw.request('speech', {}), null);
});

test('服务不可用：健康检查失败即降级', async () => {
  const gw = new LlmGateway(cfg(), { logger: quiet, provider: fake(async () => '{}', async () => { throw new Error('ECONNREFUSED'); }) });
  await gw.init();
  assert.equal(gw.status().mode, 'degraded');
  assert.match(gw.status().reason, /ECONNREFUSED/);
  assert.equal(await gw.request('speech', {}), null);
});

test('正常返回并通过 Schema 校验', async () => {
  const gw = new LlmGateway(cfg(), { logger: quiet, provider: fake(async () => '好的：{"speech":"老师我懂了！","moodDelta":0.2}') });
  await gw.init();
  assert.deepEqual(await gw.request('speech', { name: 'x' }), { speech: '老师我懂了！', moodDelta: 0.2 });
  assert.equal(gw.status().metrics.ok, 1);
});

test('输出不符合 Schema、超时都静默返回 null；连续失败 3 次打开熔断', async () => {
  let calls = 0;
  const gw = new LlmGateway(cfg(), {
    logger: quiet,
    provider: fake((messages, signal) => {
      calls++;
      if (calls === 1) return Promise.resolve('{"wrong":1}');
      return new Promise((_, fail) => signal.addEventListener('abort', () => fail(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }),
  });
  await gw.init();
  assert.equal(await gw.request('speech', {}), null);
  const t0 = Date.now();
  assert.equal(await gw.request('speech', {}), null);
  assert.ok(Date.now() - t0 < 1000, '超时必须及时返回');
  assert.equal(await gw.request('speech', {}), null);
  assert.equal(gw.status().circuit, 'open');
  assert.equal(gw.status().mode, 'degraded');
  assert.equal(await gw.request('speech', {}), null);
  assert.equal(calls, 3, '熔断期间不再发请求');
});
