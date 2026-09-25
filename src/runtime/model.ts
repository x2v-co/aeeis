import { z } from 'zod';
import type { ModelPin } from './contracts.js';

export interface ModelRequest { system: string; input: unknown; idempotencyKey?: string }
export interface ModelResponse { value: unknown; usage?: { inputTokens: number; outputTokens: number } }
export interface ModelHealth {
  ready: boolean;
  detail: string;
  checkedAt: string;
  /** When dynamic routing is enabled, preserve the catalog dependency result separately. */
  catalog?: { ready: boolean; detail: string; checkedAt?: string };
  /** When dynamic routing is enabled, preserve the selected provider result separately. */
  provider?: { ready: boolean; detail: string; checkedAt?: string };
}
export interface ModelAdapter {
  readonly pin: ModelPin;
  complete(request: ModelRequest): Promise<ModelResponse>;
  health?(): Promise<ModelHealth>;
}
export class ModelOutcomeUnknown extends Error {}
/** A completed provider response may be billable even if its output is unusable. */
export class ModelResponseRejected extends Error {
  constructor(message: string, readonly usage?: ModelResponse['usage']) { super(message); }
}
const envelope = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }), finish_reason: z.string().nullable() })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).optional(),
});

// OpenAI-compatible chat transport; no credentials or provider response bodies enter public errors.
export class HttpModelAdapter implements ModelAdapter {
  readonly pin: ModelPin;
  private readonly healthEndpoint?: string;
  constructor(baseUrl: string, model: string, private apiKey: string, provider?: string, private requestTimeoutMs = 60000, healthUrl?: string, allowInsecureHttp = false, pinOverrides?: Partial<ModelPin>) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Model endpoint must not contain credentials, query or fragment');
    if (url.protocol !== 'https:' && !(allowInsecureHttp || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new Error('Model endpoint must use HTTPS (except loopback development servers)');
    }
    this.pin = { model, endpoint: `${url.href.replace(/\/$/, '')}/chat/completions`, promptVersion: 'aeeis-project-agent/1', ...(provider ? { provider } : {}), ...pinOverrides };
    if (healthUrl) {
      const health = new URL(healthUrl);
      if (health.username || health.password || health.search || health.hash) throw new Error('Model health endpoint must not contain credentials, query or fragment');
      if (health.protocol !== 'https:' && !(allowInsecureHttp || (health.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(health.hostname)))) throw new Error('Model health endpoint must use HTTPS (except loopback development servers)');
      this.healthEndpoint = health.href;
    }
  }
  async health(): Promise<ModelHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.healthEndpoint) return { ready: true, detail: 'model configured; provider health probe not configured', checkedAt };
    try {
      const response = await fetch(this.healthEndpoint, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, 10_000)), headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {} });
      await response.body?.cancel();
      return { ready: response.ok, detail: response.ok ? 'provider health probe passed' : `provider health probe returned HTTP ${response.status}`, checkedAt };
    } catch { return { ready: false, detail: 'provider health probe failed or timed out', checkedAt }; }
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    let response: Response;
    try {
      response = await fetch(this.pin.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...(request.idempotencyKey ? { 'idempotency-key': request.idempotencyKey } : {}) },
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
    const usage = raw.usage ? { inputTokens: raw.usage.prompt_tokens, outputTokens: raw.usage.completion_tokens } : undefined;
    if (raw.choices[0]!.finish_reason !== 'stop') throw new ModelResponseRejected('Model response is incomplete', usage);
    let value: unknown;
    try { value = JSON.parse(raw.choices[0]!.message.content); }
    catch { throw new ModelResponseRejected('Model response did not contain valid JSON', usage); }
    return { value, ...(usage ? { usage } : {}) };
  }
}
