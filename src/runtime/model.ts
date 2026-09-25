import { createHash, randomUUID } from 'node:crypto';
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

/** Model transport backed by Toolkit's Agentpay credit MCP tool. */
export class AgentpayModelAdapter implements ModelAdapter {
  readonly pin: ModelPin;
  private requestId = 0;
  private initialized?: Promise<void>;
  constructor(private readonly mcpUrl: string, private readonly token: string, model: string, private readonly maxCredits: number, private readonly timeoutMs = 120_000, private readonly catalogUrl?: string, private readonly catalogToken?: string) {
    const url = new URL(mcpUrl);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Agentpay MCP URL must use HTTPS except loopback');
    if (!token || !Number.isFinite(maxCredits) || maxCredits <= 0 || maxCredits > 100) throw new Error('Agentpay credentials and max credits are required');
    this.pin = { model, provider: 'toolkit-agentpay', endpoint: url.href, promptVersion: 'aeeis-project-agent/agentpay-1' };
  }
  private async rpc(method: string, params?: unknown, timeoutMs = 15_000): Promise<any> {
    const id = ++this.requestId;
    const response = await fetch(this.mcpUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) });
    if (!response.ok) throw new Error(`Agentpay MCP returned HTTP ${response.status}`);
    const body = await response.json() as any;
    if (body.error) throw new Error(String(body.error.message || 'Agentpay MCP error'));
    return body.result;
  }
  private async init() { if (!this.initialized) this.initialized = this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aeeis', version: '1.0.0' } }).then(() => undefined); return this.initialized; }
  async health() { const checkedAt = new Date().toISOString(); try { await this.init(); return { ready: true, detail: 'Agentpay MCP reachable', checkedAt }; } catch { return { ready: false, detail: 'Agentpay MCP unavailable', checkedAt }; } }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    await this.init();
    if (this.catalogUrl) {
      const catalog = new URL('/v1/catalog/models', this.catalogUrl);
      const response = await fetch(catalog, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: this.catalogToken ? { authorization: `Bearer ${this.catalogToken}` } : {} });
      if (!response.ok) throw new ModelOutcomeUnknown(`Planprice catalog returned HTTP ${response.status}; reconcile before purchasing`);
      const body = await response.json() as any;
      const offering = (body.offerings || []).find((item: any) => item.modelId === this.pin.model || item.slug === this.pin.model);
      if (!offering || offering.catalogStatus === 'unavailable') throw new Error(`Planprice has no available offering for ${this.pin.model}`);
    }
    const purchaseId = `aeeis_${createHash('sha256').update(request.idempotencyKey ?? randomUUID()).digest('hex').slice(0, 48)}`;
    const prompt = `${request.system}\n\n${JSON.stringify(request.input)}`;
    const result = await this.rpc('tools/call', { name: 'agentpay_credit_purchase', arguments: { request: { purchaseId, paymentMethod: 'toolkit_credits', prompt, outputCap: 4096, model: this.pin.model, maxCredits: this.maxCredits } } }, this.timeoutMs);
    const wrapper = result?.structuredContent ?? result;
    const data = wrapper?.data ?? wrapper;
    if (result?.isError || data?.errorCode) {
      if (data?.state === 'execution_unknown') throw new ModelOutcomeUnknown('Agentpay purchase outcome is unknown; reconcile the same purchaseId before retrying');
      throw new Error(String(data?.errorCode || 'Agentpay purchase failed'));
    }
    const value = data?.result ?? data?.result?.result ?? data?.output ?? data;
    if (value === undefined || value === null) throw new ModelOutcomeUnknown('Agentpay returned no model output; reconcile the same purchaseId');
    let parsed: unknown = value;
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { /* preserve text output */ } }
    const usage = data?.usage && Number.isInteger(data.usage.inputTokens) && Number.isInteger(data.usage.outputTokens) ? data.usage : undefined;
    return { value: parsed, ...(usage ? { usage } : {}) };
  }
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
