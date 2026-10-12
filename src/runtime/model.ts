import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelPin } from './contracts.js';

export interface ModelRequest {
  system: string; input: unknown; idempotencyKey?: string;
  /** Include provider text for durable Runtime diagnostics. */
  includeRawOutput?: boolean;
  /** Overrides the pin's initial output allowance. */
  maxTokens?: number;
  /** Check cumulative billable usage before an internal length retry. */
  beforeRetry?: (usage: ModelResponse['usage']) => void | Promise<void>;
}
export interface ModelResponse { value: unknown; rawOutput?: string; usage?: { inputTokens: number; outputTokens: number } }
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
  constructor(message: string, readonly usage?: ModelResponse['usage'], readonly rawOutput?: string) { super(message); }
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
    return { value: parsed, ...(request.includeRawOutput ? { rawOutput: typeof value === 'string' ? value : JSON.stringify(value) } : {}), ...(usage ? { usage } : {}) };
  }
}
const envelope = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }), finish_reason: z.string().nullable() })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative() }).optional(),
});
const tokenLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const defaultMaxTokens = 16_384;

export interface ModelTransportOptions { maxAttempts?: number; retryBaseMs?: number; retryMaxMs?: number }
export function modelTransportConfig(env: NodeJS.ProcessEnv): ModelTransportOptions {
  return {
    maxAttempts: Number(env.AEEIS_MODEL_MAX_ATTEMPTS ?? 3),
    retryBaseMs: Number(env.AEEIS_MODEL_RETRY_BASE_MS ?? 500),
    retryMaxMs: Number(env.AEEIS_MODEL_RETRY_MAX_MS ?? 10_000),
  };
}

// OpenAI-compatible chat transport; no credentials or provider response bodies enter public errors.
export class HttpModelAdapter implements ModelAdapter {
  readonly pin: ModelPin;
  private readonly healthEndpoint?: string;
  private readonly transport: Required<ModelTransportOptions>;
  constructor(baseUrl: string, model: string, private apiKey: string, provider?: string, private requestTimeoutMs = 60000, healthUrl?: string, allowInsecureHttp = false, pinOverrides?: Partial<ModelPin>, transport: ModelTransportOptions = {}) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Model endpoint must not contain credentials, query or fragment');
    if (url.protocol !== 'https:' && !(allowInsecureHttp || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new Error('Model endpoint must use HTTPS (except loopback development servers)');
    }
    const ark = /(^|\.)volces\.com$/.test(url.hostname) || /ark|volcengine/i.test(provider ?? '');
    this.transport = { maxAttempts: transport.maxAttempts ?? (ark ? 3 : 1), retryBaseMs: transport.retryBaseMs ?? 500, retryMaxMs: transport.retryMaxMs ?? 10_000 };
    z.number().int().min(1).max(10).parse(this.transport.maxAttempts);
    z.number().int().min(0).max(60_000).parse(this.transport.retryBaseMs);
    z.number().int().min(this.transport.retryBaseMs).max(60_000).parse(this.transport.retryMaxMs);
    z.number().int().min(1).max(600_000).parse(this.requestTimeoutMs);
    this.pin = { model, endpoint: `${url.href.replace(/\/$/, '')}/chat/completions`, promptVersion: 'aeeis-project-agent/1', ...(provider ? { provider } : {}), ...pinOverrides };
    if (this.pin.maxTokens !== undefined) tokenLimit.parse(this.pin.maxTokens);
    if (this.pin.maxOutputTokens !== undefined) tokenLimit.parse(this.pin.maxOutputTokens);
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
    const cap = this.pin.maxOutputTokens ?? Number.MAX_SAFE_INTEGER;
    let maxTokens = Math.min(tokenLimit.parse(request.maxTokens ?? this.pin.maxTokens ?? defaultMaxTokens), cap);
    let usage: ModelResponse['usage'];
    for (let attempt = 0; attempt < 2; attempt++) {
      let raw: z.infer<typeof envelope>;
      try { raw = await this.requestCompletion(request, maxTokens, attempt); }
      catch (error) {
        if (error instanceof ModelResponseRejected && attempt > 0) {
          const total = usage && error.usage ? { inputTokens: usage.inputTokens + error.usage.inputTokens, outputTokens: usage.outputTokens + error.usage.outputTokens } : undefined;
          throw new ModelResponseRejected(error.message, total, error.rawOutput);
        }
        throw error;
      }
      const reported = raw.usage ? { inputTokens: raw.usage.prompt_tokens, outputTokens: raw.usage.completion_tokens } : undefined;
      // A partial total must not look like fully reported usage to budget checks.
      usage = attempt === 0 ? reported : usage && reported ? {
        inputTokens: usage.inputTokens + reported.inputTokens,
        outputTokens: usage.outputTokens + reported.outputTokens,
      } : undefined;
      const choice = raw.choices[0]!;
      if (choice.finish_reason === 'length' && attempt === 0) {
        try { await request.beforeRetry?.(usage); }
        catch (error) { throw new ModelResponseRejected(error instanceof Error ? error.message : 'Model retry budget check failed', usage, choice.message.content); }
        maxTokens = Math.min(maxTokens * 2, cap);
        continue;
      }
      if (choice.finish_reason !== 'stop') throw new ModelResponseRejected('Model response is incomplete', usage, choice.message.content);
      let value: unknown;
      try { value = JSON.parse(choice.message.content); }
      catch { throw new ModelResponseRejected('Model response did not contain valid JSON', usage, choice.message.content); }
      return { value, ...(request.includeRawOutput ? { rawOutput: choice.message.content } : {}), ...(usage ? { usage } : {}) };
    }
    throw new ModelResponseRejected('Model response is incomplete', usage);
  }
  private async requestCompletion(request: ModelRequest, maxTokens: number, lengthAttempt: number): Promise<z.infer<typeof envelope>> {
    const started = Date.now();
    for (let attempt = 1; attempt <= this.transport.maxAttempts; attempt++) {
      // A fresh deadline bounds fetch AND response-body consumption on each try.
      const signal = AbortSignal.timeout(this.requestTimeoutMs);
      let response: Response | undefined;
      let stage: 'request' | 'response' = 'request';
      let bodyExcerpt = '';
      let errorCode: string | undefined;
      let httpError: Error | undefined;
      try {
        response = await fetch(this.pin.endpoint, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...(request.idempotencyKey ? { 'idempotency-key': lengthAttempt === 0 ? request.idempotencyKey : `${request.idempotencyKey}:length-retry` } : {}) },
          body: JSON.stringify({ model: this.pin.requestModel ?? this.pin.model, max_tokens: maxTokens, response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: request.system }, { role: 'user', content: JSON.stringify(request.input) }] }),
        });
        stage = 'response';
        // HTTP classification must survive an error body that itself times out.
        if (!response.ok) httpError = response.status >= 500 || response.status === 408
          ? new ModelOutcomeUnknown(`Model provider returned HTTP ${response.status}; execution outcome requires reconciliation`)
          : new ModelResponseRejected(`Model provider returned HTTP ${response.status}`, { inputTokens: 0, outputTokens: 0 });
        // Read only a bounded error excerpt. Never put it in public Run errors.
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty model response');
        const chunks: Uint8Array[] = []; let size = 0;
        const limit = response.ok ? 1_000_000 : 2048;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > limit) {
            if (!response.ok) chunks.push(value.slice(0, Math.max(0, limit - (size - value.length))));
            await reader.cancel();
            if (response.ok) throw new Error('Model response exceeds size limit');
            break;
          }
          chunks.push(value);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        if (!response.ok) {
          bodyExcerpt = body;
          try { const parsed = JSON.parse(body); errorCode = String(parsed.error?.code ?? parsed.code ?? '') || undefined; } catch { /* text error */ }
          throw httpError;
        }
        return envelope.parse(JSON.parse(body));
      } catch (error) {
        const network = stage === 'request' || signal.aborted || error instanceof TypeError || (
          error instanceof Error && /ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR/.test(String((error as NodeJS.ErrnoException).code ?? (error.cause as NodeJS.ErrnoException | undefined)?.code ?? ''))
        );
        const retryable = httpError !== undefined
          ? response!.status === 429 || response!.status >= 500
          : network;
        const willRetry = retryable && attempt < this.transport.maxAttempts;
        const delayMs = willRetry ? Math.floor(Math.min(this.transport.retryMaxMs, this.transport.retryBaseMs * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5)) : 0;
        const redact = (text: string): string => {
          if (this.apiKey) text = text.split(this.apiKey).join('[REDACTED]');
          return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/[\r\n]/g, ' ').slice(0, 1024);
        };
        console.error(JSON.stringify({
          protocol: 'aeeis-model-error/1', provider: this.pin.provider ?? new URL(this.pin.endpoint).hostname,
          model: this.pin.model, status: response?.status ?? null,
          requestId: response?.headers.get('x-request-id') ?? response?.headers.get('x-tt-logid') ?? null,
          attempt, maxAttempts: this.transport.maxAttempts, lengthAttempt, elapsedMs: Date.now() - started,
          errorCode: redact(errorCode ?? (signal.aborted ? 'TIMEOUT' : String((error as NodeJS.ErrnoException)?.code ?? ((error as Error)?.cause as NodeJS.ErrnoException | undefined)?.code ?? (network ? 'NETWORK_ERROR' : (error as Error)?.name ?? 'ERROR')))),
          bodyExcerpt: redact(bodyExcerpt), retryable, willRetry, retryDelayMs: delayMs,
        }));
        if (willRetry) { await new Promise(resolve => setTimeout(resolve, delayMs)); continue; }
        if (httpError) throw httpError;
        if (network) throw new ModelOutcomeUnknown(signal.aborted
          ? `Model ${stage} timed out after ${this.requestTimeoutMs}ms. The provider outcome is unknown; reconcile before retrying because the request may have been billed.`
          : `Model ${stage} connection was interrupted. The provider outcome is unknown; reconcile before retrying because the request may have been billed.`);
        throw error;
      }
    }
    throw new Error('Model retry attempts exhausted');
  }
}
