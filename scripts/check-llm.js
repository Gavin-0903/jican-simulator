#!/usr/bin/env node
// LLM 连通性自检：按 config/llm.json 检查本地模型服务，并试生成一句台词。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/persistence/ConfigLoader.js';
import { LlmGateway } from '../server/llm/LlmGateway.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { llm } = loadConfig(root, { logger: { warn: () => {} } });
const target = llm.provider === 'openai-compat' ? llm.openaiCompat : llm.ollama;
console.log(`Provider：${llm.provider}  地址：${target.baseURL}  模型：${target.model}  配置启用：${llm.enabled}`);
const gw = new LlmGateway({ ...llm, enabled: true, recheckMs: 0 }, { logger: { info: () => {}, warn: () => {} } });
const status = await gw.init();
if (status.mode !== 'llm') {
  console.log(`✗ 不可用：${status.reason}`);
  console.log('  游戏仍可完整游玩（纯规则 AI）。如需 AI 增强：安装 Ollama 并执行 `ollama pull qwen2:0.5b`。');
  process.exit(1);
}
const t0 = Date.now();
const res = await gw.request('speech', { role: '学生', name: '测试同学', situation: '你在办公室向老师请教问题' });
console.log(res ? `✓ 可用，耗时 ${Date.now() - t0} ms，示例台词：「${res.speech}」` : `✗ 健康检查通过，但生成失败（${gw.status().reason ?? '输出不符合格式'}）`);
gw.close();
process.exit(res ? 0 : 1);
