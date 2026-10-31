// OpenAI 兼容 Provider：对接 LM Studio、vLLM 等自托管服务。密钥只从环境变量读取，绝不下发前端。

export class OpenAICompatProvider {
  constructor({ baseURL, model, apiKeyEnv, temperature = 0.8, maxTokens = 64 }) {
    this.name = 'openai-compat';
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.model = model;
    this.apiKey = apiKeyEnv ? process.env[apiKeyEnv] || '' : '';
    this.temperature = temperature;
    this.maxTokens = maxTokens;
  }

  headers() {
    const h = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async health(signal) {
    const res = await fetch(`${this.baseURL}/v1/models`, { headers: this.headers(), signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  }

  async chat(messages, signal) {
    const res = await fetch(`${this.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        model: this.model,
        messages,
        response_format: { type: 'json_object' },
        max_tokens: this.maxTokens,
        temperature: this.temperature,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return body?.choices?.[0]?.message?.content ?? '';
  }
}
