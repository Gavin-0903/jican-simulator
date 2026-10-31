// Ollama Provider：/api/tags 健康检查，/api/chat 对话（format: "json" 强制结构化输出）。

export class OllamaProvider {
  constructor({ baseURL, model, temperature = 0.8, maxTokens = 64 }) {
    this.name = 'ollama';
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
  }

  async health(signal) {
    const res = await fetch(`${this.baseURL}/api/tags`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const names = (body.models || []).map((m) => m.name || m.model);
    if (!names.some((n) => n === this.model || n.startsWith(`${this.model}:`) || n.split(':')[0] === this.model)) {
      throw new Error(`模型 ${this.model} 未安装（已安装：${names.join(', ') || '无'}）`);
    }
    return true;
  }

  async chat(messages, signal) {
    const res = await fetch(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        format: 'json',
        options: { temperature: this.temperature, num_predict: this.maxTokens },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return body?.message?.content ?? '';
  }
}
