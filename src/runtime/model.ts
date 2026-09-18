import { z } from 'zod';
import type { ModelPin } from './contracts.js';

export interface ModelRequest { system: string; input: unknown }
export interface ModelResponse { value: unknown; usage?: { inputTokens: number; outputTokens: number } }
export interface ModelAdapter {
  readonly pin: ModelPin;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
export class ModelOutcomeUnknown extends Error {}
const envelope = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }), finish_reason: z.string().nullable() })).min(1),
  usage: z.object({ prompt_tokens: z.number().nonnegative(), completion_tokens: z.number().nonnegative() }).optional(),
});

// OpenAI-compatible chat transport; no credentials or provider response bodies enter public errors.
export class HttpModelAdapter implements ModelAdapter {
  readonly pin: ModelPin;
  constructor(baseUrl: string, model: string, private apiKey: string, provider?: string, private requestTimeoutMs = 60000) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Model endpoint must not contain credentials, query or fragment');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('Model endpoint must use HTTPS (except loopback development servers)');
    }
    this.pin = { model, endpoint: `${url.href.replace(/\/$/, '')}/chat/completions`, promptVersion: 'aeeis-project-agent/1', ...(provider ? { provider } : {}) };
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    let response: Response;
    try {
      response = await fetch(this.pin.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.pin.model, max_tokens: 4096, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: request.system }, { role: 'user', content: JSON.stringify(request.input) }] }),
      });
    } catch { throw new ModelOutcomeUnknown('Model request outcome is unknown after a transport failure. Reconcile before retrying; the provider may have billed the request.'); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status >= 500 || response.status === 408) throw new ModelOutcomeUnknown(`Model provider returned HTTP ${response.status}; execution outcome requires reconciliation`);
      throw new Error(`Model provider returned HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty model response');
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch { throw new ModelOutcomeUnknown('Model response transport interrupted; reconcile before retrying'); }
      const { done, value } = chunk; if (done) break;
      size += value.length;
      if (size > 1_000_000) { await reader.cancel(); throw new Error('Model response exceeds size limit'); }
      chunks.push(value);
    }
    const raw = envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (raw.choices[0]!.finish_reason !== 'stop') throw new Error('Model response is incomplete');
    return { value: JSON.parse(raw.choices[0]!.message.content),
      ...(raw.usage ? { usage: { inputTokens: raw.usage.prompt_tokens, outputTokens: raw.usage.completion_tokens } } : {}) };
  }
}
