import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelPin } from './contracts.js';

export interface ModelRequest {
  system: string; input: unknown; idempotencyKey?: string;
  /** Include provider text for durable Runtime diagnostics. */
  includeRawOutput?: boolean;
  /** Delegate completed text output to the caller's schema/format validation. */
  allowTextOutput?: boolean;
  /** Overrides the pin's initial output allowance. */
  maxTokens?: number;
  /** Frozen wire controls; null explicitly preserves an omitted provider field. */
  thinking?: 'enabled' | 'disabled' | 'auto' | null;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | null;
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
  requestDefaults?(): Pick<ModelRequest, 'maxTokens' | 'thinking' | 'reasoningEffort'>;
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
const responseSizeLimit = 1_000_000;
const streamFrameSizeLimit = 1_000_000;
const streamBufferSizeLimit = 1_000_000;

const streamChunk = z.object({
  choices: z.array(z.object({ index: z.number().int(), delta: z.object({ content: z.string().nullish() }), finish_reason: z.string().nullish() })),
  usage: envelope.shape.usage.unwrap().nullish(),
});

/** Decode SSE frames across arbitrary UTF-8/chunk boundaries, retaining the final usage-only chunk. */
async function readStreamCompletion(read: () => Promise<ReadableStreamReadResult<Uint8Array>>): Promise<z.infer<typeof envelope>> {
  const decoder = new TextDecoder();
  let buffer = '', content = '', finishReason: string | null = null, contentBytes = 0, seenChoice = false;
  let skipLF = false, searchFrom = 0;
  let usage: z.infer<typeof envelope>['usage'];
  for (;;) {
    const { done, value } = await read();
    if (done) throw new ModelOutcomeUnknown('Model stream ended before [DONE]; the provider outcome requires reconciliation');
    // Drain large network chunks incrementally so many valid frames never fill the pending buffer.
    for (let offset = 0; offset < value.byteLength; offset += 65_536) {
      let text = decoder.decode(value.subarray(offset, offset + 65_536), { stream: true });
      if (!text) continue;
      // CR ends a line immediately; suppress its paired LF even across network/decoder chunks.
      if (skipLF && text.startsWith('\n')) text = text.slice(1);
      skipLF = text.endsWith('\r');
      buffer += text.replace(/\r\n|\r/g, '\n');
      for (;;) {
        const boundary = buffer.indexOf('\n\n', searchFrom);
        if (boundary < 0) { searchFrom = Math.max(0, buffer.length - 1); break; }
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); searchFrom = 0;
        if (Buffer.byteLength(frame, 'utf8') > streamFrameSizeLimit) throw new ModelOutcomeUnknown('Model stream frame exceeds size limit; the provider outcome requires reconciliation');
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue; // comments/keepalives/event metadata
        if (data.trim() === '[DONE]') {
          if (!seenChoice) throw new ModelOutcomeUnknown('Model stream contained no completion; the provider outcome requires reconciliation');
          return { choices: [{ message: { content }, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
        }
        let chunk: z.infer<typeof streamChunk>;
        try { chunk = streamChunk.parse(JSON.parse(data)); }
        catch { throw new ModelOutcomeUnknown('Model stream contained an invalid event; the provider outcome requires reconciliation'); }
        if (chunk.usage) usage = chunk.usage;
        // Repeated metadata, reasoning and keepalives do not consume the retained content allowance.
        for (const choice of chunk.choices) if (choice.index === 0) {
          seenChoice = true;
          const delta = choice.delta.content ?? '';
          contentBytes += Buffer.byteLength(delta, 'utf8');
          if (contentBytes > responseSizeLimit) throw new ModelOutcomeUnknown('Model stream content exceeds size limit; the provider outcome requires reconciliation');
          content += delta;
          if (choice.finish_reason != null) finishReason = choice.finish_reason;
        }
      }
      if (Buffer.byteLength(buffer, 'utf8') > streamBufferSizeLimit) throw new ModelOutcomeUnknown('Model stream buffer exceeds size limit; the provider outcome requires reconciliation');
    }
  }
}

export interface ModelTransportOptions {
  maxAttempts?: number; retryBaseMs?: number; retryMaxMs?: number;
  stream?: boolean; firstByteTimeoutMs?: number; idleTimeoutMs?: number; streamOverallTimeoutMs?: number;
  retryEmptyIdle?: boolean;
  maxTokens?: number;
  thinking?: 'enabled' | 'disabled' | 'auto';
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}
export function modelTransportConfig(env: NodeJS.ProcessEnv): ModelTransportOptions {
  return {
    maxAttempts: Number(env.AEEIS_MODEL_MAX_ATTEMPTS ?? 3),
    retryBaseMs: Number(env.AEEIS_MODEL_RETRY_BASE_MS ?? 500),
    retryMaxMs: Number(env.AEEIS_MODEL_RETRY_MAX_MS ?? 10_000),
    ...(env.AEEIS_MODEL_STREAM === undefined ? {} : { stream: env.AEEIS_MODEL_STREAM === '1' }),
    idleTimeoutMs: Number(env.AEEIS_MODEL_IDLE_TIMEOUT_MS ?? 180_000),
    firstByteTimeoutMs: Number(env.AEEIS_MODEL_FIRST_BYTE_TIMEOUT_MS ?? 120_000),
    streamOverallTimeoutMs: Number(env.AEEIS_MODEL_STREAM_OVERALL_TIMEOUT_MS ?? 900_000),
    retryEmptyIdle: env.AEEIS_MODEL_RETRY_EMPTY_IDLE !== '0',
    maxTokens: Number(env.AEEIS_MODEL_MAX_TOKENS ?? defaultMaxTokens),
    ...(env.AEEIS_MODEL_THINKING === undefined ? {} : { thinking: z.enum(['enabled', 'disabled', 'auto']).parse(env.AEEIS_MODEL_THINKING) }),
    ...(env.AEEIS_MODEL_REASONING_EFFORT === undefined ? {} : { reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).parse(env.AEEIS_MODEL_REASONING_EFFORT) }),
  };
}

// OpenAI-compatible chat transport; no credentials or provider response bodies enter public errors.
export class HttpModelAdapter implements ModelAdapter {
  readonly pin: ModelPin;
  private readonly healthEndpoint?: string;
  private readonly transport: Required<Omit<ModelTransportOptions, 'thinking' | 'reasoningEffort'>> & Pick<ModelTransportOptions, 'thinking' | 'reasoningEffort'>;
  constructor(baseUrl: string, model: string, private apiKey: string, provider?: string, private requestTimeoutMs = 60000, healthUrl?: string, allowInsecureHttp = false, pinOverrides?: Partial<ModelPin>, transport: ModelTransportOptions = {}) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Model endpoint must not contain credentials, query or fragment');
    if (url.protocol !== 'https:' && !(allowInsecureHttp || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new Error('Model endpoint must use HTTPS (except loopback development servers)');
    }
    const ark = /(^|\.)(?:volces\.com|bytepluses\.com)$/.test(url.hostname) || /ark|volcengine|byteplus/i.test(provider ?? '');
    this.transport = { maxAttempts: transport.maxAttempts ?? (ark ? 3 : 1), retryBaseMs: transport.retryBaseMs ?? 500, retryMaxMs: transport.retryMaxMs ?? 10_000,
      stream: transport.stream ?? ark, firstByteTimeoutMs: transport.firstByteTimeoutMs ?? 120_000,
      idleTimeoutMs: transport.idleTimeoutMs ?? Math.min(requestTimeoutMs, 180_000), streamOverallTimeoutMs: transport.streamOverallTimeoutMs ?? 900_000,
      retryEmptyIdle: transport.retryEmptyIdle ?? true, maxTokens: transport.maxTokens ?? defaultMaxTokens,
      ...(transport.thinking === undefined ? {} : { thinking: z.enum(['enabled', 'disabled', 'auto']).parse(transport.thinking) }),
      ...(transport.reasoningEffort === undefined ? {} : { reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).parse(transport.reasoningEffort) }) };
    z.number().int().min(1).max(10).parse(this.transport.maxAttempts);
    z.number().int().min(0).max(60_000).parse(this.transport.retryBaseMs);
    z.number().int().min(this.transport.retryBaseMs).max(60_000).parse(this.transport.retryMaxMs);
    z.number().int().min(1).max(600_000).parse(this.requestTimeoutMs);
    z.boolean().parse(this.transport.stream);
    z.boolean().parse(this.transport.retryEmptyIdle);
    tokenLimit.parse(this.transport.maxTokens);
    z.number().int().min(1).max(600_000).parse(this.transport.firstByteTimeoutMs);
    z.number().int().min(1).max(600_000).parse(this.transport.idleTimeoutMs);
    z.number().int().min(1).max(1_800_000).parse(this.transport.streamOverallTimeoutMs);
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
  /** Capture provider controls in the durable logical request before dispatch. */
  requestDefaults() {
    return { maxTokens: Math.min(this.pin.maxTokens ?? this.transport.maxTokens, this.transport.maxTokens, this.pin.maxOutputTokens ?? Number.MAX_SAFE_INTEGER),
      thinking: this.transport.thinking ?? null, reasoningEffort: this.transport.reasoningEffort ?? null };
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
    let maxTokens = Math.min(tokenLimit.parse(request.maxTokens ?? this.pin.maxTokens ?? this.transport.maxTokens), cap);
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
      catch {
        if (!request.allowTextOutput) throw new ModelResponseRejected('Model response did not contain valid JSON', usage, choice.message.content);
        value = choice.message.content;
      }
      return { value, ...(request.includeRawOutput ? { rawOutput: choice.message.content } : {}), ...(usage ? { usage } : {}) };
    }
    throw new ModelResponseRejected('Model response is incomplete', usage);
  }
  private async requestCompletion(request: ModelRequest, maxTokens: number, lengthAttempt: number): Promise<z.infer<typeof envelope>> {
    const started = Date.now();
    for (let attempt = 1; attempt <= this.transport.maxAttempts; attempt++) {
      // A fresh deadline bounds fetch AND response-body consumption on each try.
      const controller = new AbortController(), signal = controller.signal;
      const streaming = this.transport.stream;
      const overallMs = streaming ? this.transport.streamOverallTimeoutMs : this.requestTimeoutMs;
      let timeoutMs = overallMs, timeoutKind = 'overall';
      const overallTimer = setTimeout(() => controller.abort(), overallMs);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const firstByteTimer = setTimeout(() => { timeoutMs = this.transport.firstByteTimeoutMs; timeoutKind = 'first-byte'; controller.abort(); }, this.transport.firstByteTimeoutMs);
      let responseBytes = 0;
      let firstByteMs: number | undefined;
      let headersMs: number | undefined;
      const attemptStarted = Date.now();
      const activity = () => {
        if (responseBytes === 0) return;
        clearTimeout(firstByteTimer);
        if (!streaming) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { timeoutMs = this.transport.idleTimeoutMs; timeoutKind = 'idle'; controller.abort(); }, this.transport.idleTimeoutMs);
      };
      let streamReceived = false;
      let response: Response | undefined;
      let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let stage: 'request' | 'response' = 'request';
      let bodyExcerpt = '';
      let errorCode: string | undefined;
      let httpError: Error | undefined;
      try {
        response = await fetch(this.pin.endpoint, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...(request.idempotencyKey ? { 'idempotency-key': lengthAttempt === 0 ? request.idempotencyKey : `${request.idempotencyKey}:length-retry` } : {}) },
          body: JSON.stringify({ model: this.pin.requestModel ?? this.pin.model, max_tokens: maxTokens, response_format: { type: 'json_object' },
            ...((request.thinking === undefined ? this.transport.thinking : request.thinking) ? { thinking: { type: request.thinking ?? this.transport.thinking } } : {}),
            ...((request.reasoningEffort === undefined ? this.transport.reasoningEffort : request.reasoningEffort) ? { reasoning_effort: request.reasoningEffort ?? this.transport.reasoningEffort } : {}),
            ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
            messages: [{ role: 'system', content: request.system }, { role: 'user', content: JSON.stringify(request.input) }] }),
        });
        stage = 'response';
        headersMs = Date.now() - attemptStarted;
        // HTTP classification must survive an error body that itself times out.
        if (!response.ok) httpError = response.status >= 500 || response.status === 408
          ? new ModelOutcomeUnknown(`Model provider returned HTTP ${response.status}; execution outcome requires reconciliation`)
          : new ModelResponseRejected(`Model provider returned HTTP ${response.status}`, { inputTokens: 0, outputTokens: 0 });
        // Read only a bounded error excerpt. Never put it in public Run errors.
        streamReceived = response.ok && (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false);
        const reader = response.body?.getReader();
        if (!reader) throw streamReceived ? new ModelOutcomeUnknown('Empty model stream; the provider outcome requires reconciliation') : new Error('Empty model response');
        bodyReader = reader;
        const read = async () => {
          signal.throwIfAborted();
          let abort: () => void = () => {};
          const aborted = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
          try {
            const part = await Promise.race([reader.read(), aborted]);
            if (part.value?.byteLength) {
              firstByteMs ??= Date.now() - attemptStarted;
              responseBytes += part.value.byteLength;
              activity();
            }
            return part;
          }
          finally { signal.removeEventListener('abort', abort); }
        };
        const completed = (raw: z.infer<typeof envelope>) => {
          console.info(JSON.stringify({ protocol: 'aeeis-model-completion/1', provider: this.pin.provider ?? new URL(this.pin.endpoint).hostname,
            model: this.pin.model, requestId: response?.headers.get('x-request-id') ?? response?.headers.get('x-tt-logid') ?? null,
            attempt, lengthAttempt, headersMs, firstByteMs, elapsedMs: Date.now() - attemptStarted, responseBytes,
            promptChars: request.system.length + JSON.stringify(request.input).length, maxTokens, usage: raw.usage }));
          return raw;
        };
        if (streamReceived) return completed(await readStreamCompletion(read));
        const chunks: Uint8Array[] = []; let size = 0;
        const limit = response.ok ? responseSizeLimit : 2048;
        for (;;) {
          const { done, value } = await read();
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
        return completed(envelope.parse(JSON.parse(body)));
      } catch (error) {
        const network = stage === 'request' || signal.aborted || error instanceof TypeError || (
          error instanceof Error && /ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR/.test(String((error as NodeJS.ErrnoException).code ?? (error.cause as NodeJS.ErrnoException | undefined)?.code ?? ''))
        );
        const retryable = httpError !== undefined
          ? response!.status === 429 || response!.status >= 500
          : network;
        // No visible output is not proof of zero billing. Only first-byte
        // timeouts replay by default, using the identical request/key. Every
        // body byte (reasoning, heartbeat, error or fragment) forbids replay.
        const emptyFirstByteRetry = signal.aborted && timeoutKind === 'first-byte' && responseBytes === 0
          && Boolean(request.idempotencyKey) && this.transport.retryEmptyIdle;
        const willRetry = retryable && responseBytes === 0 && attempt < this.transport.maxAttempts
          && (signal.aborted ? emptyFirstByteRetry : !streamReceived);
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
          bodyExcerpt: redact(bodyExcerpt), responseBytes, headersMs, firstByteMs, promptChars: request.system.length + JSON.stringify(request.input).length,
          maxTokens, timeoutKind: signal.aborted ? timeoutKind : undefined, retryable, willRetry, retryDelayMs: delayMs,
        }));
        if (willRetry) { await new Promise(resolve => setTimeout(resolve, delayMs)); continue; }
        if (httpError) throw httpError;
        if (network) throw new ModelOutcomeUnknown(signal.aborted
          ? `Model ${stage} timed out after ${timeoutMs}ms${streaming || timeoutKind === 'first-byte' ? ` (${timeoutKind} timeout)` : ''}. The provider outcome is unknown; reconcile before retrying because the request may have been billed.`
          : `Model ${stage} connection was interrupted. The provider outcome is unknown; reconcile before retrying because the request may have been billed.`);
        throw error;
      } finally { clearTimeout(overallTimer); clearTimeout(firstByteTimer); clearTimeout(idleTimer); void bodyReader?.cancel().catch(() => undefined); }
    }
    throw new Error('Model retry attempts exhausted');
  }
}
