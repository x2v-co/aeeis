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
  /** Transport history stays outside the frozen logical request/hash. */
  thinkingUnsupported?: boolean;
  midstreamRetries?: number;
  onThinkingUnsupported?: (details: { reason: 'http-400' | 'adapter-cache' }) => void | Promise<void>;
  onMidstreamRetry?: (details: { midstreamRetries: number; responseBytes: number }) => void | Promise<void>;
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
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(),
    completion_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().optional() }).optional() }).optional(),
});
const tokenLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const defaultMaxTokens = 16_384;
const responseSizeLimit = 1_000_000;
const streamFrameSizeLimit = 1_000_000;
const streamBufferSizeLimit = 1_000_000;

const streamChunk = z.object({
  choices: z.array(z.object({ index: z.number().int(), delta: z.object({ content: z.string().nullish(), reasoning_content: z.string().nullish(), reasoning: z.string().nullish(), tool_calls: z.array(z.object({ function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }).partial().nullish() }).passthrough()).nullish() }), finish_reason: z.string().nullish() })),
  usage: envelope.shape.usage.unwrap().nullish(),
});

interface StreamDiagnostics {
  sseFrames: number; contentBytes: number; reasoningBytes: number;
  /** tool_calls name+arguments deltas (not counted in content). */
  toolCallBytes?: number;
  /** Inter-frame gap stats in ms, measured at frame decode time. */
  frameGapAvgMs?: number; frameGapMaxMs?: number;
  lastFrameAt?: number; frameGapTotalMs?: number;
  finishReason?: string;
  usage?: z.infer<typeof envelope>['usage'];
}
interface TransportHistory {
  midstreamRetries: number; usageUnknown: boolean; thinkingUnsupported: boolean;
}

/** otherBytes = SSE framing + per-frame JSON envelope (id/model/created/choices/usage). */
function logDiagnostics(d: StreamDiagnostics, responseBytes: number) {
  const { lastFrameAt: _l, frameGapTotalMs: _t, ...rest } = d;
  const toolCallBytes = d.toolCallBytes ?? 0;
  const otherBytes = responseBytes - d.contentBytes - d.reasoningBytes - toolCallBytes;
  return { ...rest, toolCallBytes, otherBytes, envelopeBytesPerFrame: d.sseFrames ? Math.round(otherBytes / d.sseFrames) : undefined,
    contentBytesPerFrame: d.sseFrames ? Math.round(d.contentBytes / d.sseFrames * 10) / 10 : undefined };
}

/** Decode SSE frames across arbitrary UTF-8/chunk boundaries, retaining the final usage-only chunk. */
async function readStreamCompletion(read: () => Promise<ReadableStreamReadResult<Uint8Array>>, diagnostics: StreamDiagnostics): Promise<z.infer<typeof envelope>> {
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
        if (frame) {
          const now = Date.now();
          if (diagnostics.lastFrameAt !== undefined) {
            const gap = now - diagnostics.lastFrameAt;
            diagnostics.frameGapTotalMs = (diagnostics.frameGapTotalMs ?? 0) + gap;
            diagnostics.frameGapMaxMs = Math.max(diagnostics.frameGapMaxMs ?? 0, gap);
          }
          diagnostics.lastFrameAt = now;
          diagnostics.sseFrames++;
          if (diagnostics.sseFrames > 1) diagnostics.frameGapAvgMs = Math.round((diagnostics.frameGapTotalMs ?? 0) / (diagnostics.sseFrames - 1));
        }
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
        if (chunk.usage) diagnostics.usage = usage = chunk.usage;
        // Repeated metadata, reasoning and keepalives do not consume the retained content allowance.
        for (const choice of chunk.choices) {
          diagnostics.contentBytes += Buffer.byteLength(choice.delta.content ?? '', 'utf8');
          diagnostics.reasoningBytes += Buffer.byteLength(choice.delta.reasoning_content ?? '', 'utf8') + Buffer.byteLength(choice.delta.reasoning ?? '', 'utf8');
          for (const call of choice.delta.tool_calls ?? []) diagnostics.toolCallBytes = (diagnostics.toolCallBytes ?? 0) + Buffer.byteLength((call.function?.name ?? '') + (call.function?.arguments ?? ''), 'utf8');
          if (choice.index !== 0) continue;
          seenChoice = true;
          if (choice.finish_reason != null) diagnostics.finishReason = finishReason = choice.finish_reason;
          const delta = choice.delta.content ?? '';
          contentBytes += Buffer.byteLength(delta, 'utf8');
          if (contentBytes > responseSizeLimit) throw new ModelOutcomeUnknown('Model stream content exceeds size limit; the provider outcome requires reconciliation');
          content += delta;
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
  midstreamRetries?: number;
  maxTokens?: number;
  thinking?: 'enabled' | 'disabled' | 'auto' | 'provider-default';
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
    midstreamRetries: z.string().trim().min(1).transform(Number).pipe(z.number().int().min(0).max(3)).parse(env.AEEIS_MODEL_MIDSTREAM_RETRIES ?? '1'),
    maxTokens: Number(env.AEEIS_MODEL_MAX_TOKENS ?? defaultMaxTokens),
    ...(env.AEEIS_MODEL_THINKING === undefined ? {} : { thinking: z.enum(['enabled', 'disabled', 'auto', 'provider-default']).parse(env.AEEIS_MODEL_THINKING) }),
    ...(env.AEEIS_MODEL_REASONING_EFFORT === undefined ? {} : { reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).parse(env.AEEIS_MODEL_REASONING_EFFORT) }),
  };
}

// OpenAI-compatible chat transport; no credentials or provider response bodies enter public errors.
export class HttpModelAdapter implements ModelAdapter {
  readonly pin: ModelPin;
  private readonly healthEndpoint?: string;
  private readonly arkProvider: boolean;
  private thinkingUnsupported = false;
  private readonly transport: Required<Omit<ModelTransportOptions, 'thinking' | 'reasoningEffort'>> & {
    thinking?: ModelRequest['thinking']; reasoningEffort?: ModelTransportOptions['reasoningEffort'];
  };
  constructor(baseUrl: string, model: string, private apiKey: string, provider?: string, private requestTimeoutMs = 60000, healthUrl?: string, allowInsecureHttp = false, pinOverrides?: Partial<ModelPin>, transport: ModelTransportOptions = {}) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Model endpoint must not contain credentials, query or fragment');
    if (url.protocol !== 'https:' && !(allowInsecureHttp || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new Error('Model endpoint must use HTTPS (except loopback development servers)');
    }
    const ark = /(^|\.)(?:volces\.com|volcengineapi\.com|bytepluses\.com)$/.test(url.hostname) || /ark|volcengine|byteplus/i.test(provider ?? '');
    this.arkProvider = ark;
    const defaultThinkingDisabled = /(^|\.)(?:volces\.com|volcengineapi\.com)$/.test(url.hostname) || provider?.toLowerCase() === 'ark';
    this.transport = { maxAttempts: transport.maxAttempts ?? (ark ? 3 : 1), retryBaseMs: transport.retryBaseMs ?? 500, retryMaxMs: transport.retryMaxMs ?? 10_000,
      stream: transport.stream ?? ark, firstByteTimeoutMs: transport.firstByteTimeoutMs ?? 120_000,
      idleTimeoutMs: transport.idleTimeoutMs ?? Math.min(requestTimeoutMs, 180_000), streamOverallTimeoutMs: transport.streamOverallTimeoutMs ?? 900_000,
      retryEmptyIdle: transport.retryEmptyIdle ?? true, midstreamRetries: transport.midstreamRetries ?? 1, maxTokens: transport.maxTokens ?? defaultMaxTokens,
      thinking: transport.thinking === undefined ? (defaultThinkingDisabled ? 'disabled' : null)
        : transport.thinking === 'provider-default' ? null : z.enum(['enabled', 'disabled', 'auto']).parse(transport.thinking),
      ...(transport.reasoningEffort === undefined ? {} : { reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).parse(transport.reasoningEffort) }) };
    z.number().int().min(1).max(10).parse(this.transport.maxAttempts);
    z.number().int().min(0).max(60_000).parse(this.transport.retryBaseMs);
    z.number().int().min(this.transport.retryBaseMs).max(60_000).parse(this.transport.retryMaxMs);
    z.number().int().min(1).max(600_000).parse(this.requestTimeoutMs);
    z.boolean().parse(this.transport.stream);
    z.boolean().parse(this.transport.retryEmptyIdle);
    z.number().int().min(0).max(3).parse(this.transport.midstreamRetries);
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
      thinking: this.thinkingUnsupported ? null : this.transport.thinking ?? null,
      reasoningEffort: this.thinkingUnsupported ? null : this.transport.reasoningEffort ?? null };
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
    const history: TransportHistory = { midstreamRetries: request.midstreamRetries ?? 0,
      usageUnknown: (request.midstreamRetries ?? 0) > 0, thinkingUnsupported: request.thinkingUnsupported ?? false };
    z.number().int().min(0).max(3).parse(history.midstreamRetries);
    // A cached downgrade must also be recorded when an older frozen request still includes controls.
    if (!history.thinkingUnsupported && this.thinkingUnsupported &&
      ((request.thinking === undefined ? this.transport.thinking : request.thinking) || (request.reasoningEffort === undefined ? this.transport.reasoningEffort : request.reasoningEffort))) {
      try { await request.onThinkingUnsupported?.({ reason: 'adapter-cache' }); }
      catch { throw new ModelOutcomeUnknown('Model thinking downgrade could not be recorded; reconcile before retrying'); }
      history.thinkingUnsupported = true;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      let raw: z.infer<typeof envelope>;
      try { raw = await this.requestCompletion(request, maxTokens, attempt, history); }
      catch (error) {
        if (error instanceof ModelResponseRejected && history.usageUnknown) throw new ModelResponseRejected(error.message, undefined, error.rawOutput);
        if (error instanceof ModelResponseRejected && attempt > 0) {
          const total = usage && error.usage ? { inputTokens: usage.inputTokens + error.usage.inputTokens, outputTokens: usage.outputTokens + error.usage.outputTokens } : undefined;
          throw new ModelResponseRejected(error.message, total, error.rawOutput);
        }
        throw error;
      }
      const reported = raw.usage && !history.usageUnknown ? { inputTokens: raw.usage.prompt_tokens, outputTokens: raw.usage.completion_tokens } : undefined;
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
  private async requestCompletion(request: ModelRequest, maxTokens: number, lengthAttempt: number, history: TransportHistory): Promise<z.infer<typeof envelope>> {
    const started = Date.now();
    const thinking = request.thinking === undefined ? this.transport.thinking : request.thinking;
    const reasoningEffort = request.reasoningEffort === undefined ? this.transport.reasoningEffort : request.reasoningEffort;
    const baseBody = { model: this.pin.requestModel ?? this.pin.model, max_tokens: maxTokens, response_format: { type: 'json_object' },
      ...(this.transport.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      messages: [{ role: 'system', content: request.system }, { role: 'user', content: JSON.stringify(request.input) }] };
    const bodyWithControls = JSON.stringify({ ...baseBody, ...(thinking ? { thinking: { type: thinking } } : {}), ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) });
    const bodyWithoutControls = JSON.stringify(baseBody);
    let transportAttempt = 1;
    // Pre-connection failures never reach the provider, so they get one extra backoff retry beyond maxAttempts.
    let connectRetries = 0;
    for (let attempt = 1; ; attempt++) {
      const body = history.thinkingUnsupported ? bodyWithoutControls : bodyWithControls;
      const requestBodyHash = createHash('sha256').update(body).digest('hex');
      const idempotencyKey = request.idempotencyKey ? `${request.idempotencyKey}${lengthAttempt ? ':length-retry' : ''}${history.thinkingUnsupported ? ':thinking-unsupported' : ''}${history.midstreamRetries ? `:midstream-${history.midstreamRetries}` : ''}` : undefined;
      const diagnostics: StreamDiagnostics = { sseFrames: 0, contentBytes: 0, reasoningBytes: 0 };
      let retryDelayMs = 0;
      // A fresh deadline bounds fetch AND response-body consumption on each try.
      const controller = new AbortController(), signal = controller.signal;
      const streaming = this.transport.stream;
      const overallMs = streaming ? this.transport.streamOverallTimeoutMs : this.requestTimeoutMs;
      let timeoutMs = overallMs, timeoutKind = 'overall';
      let overallTimer = setTimeout(() => { timeoutMs = overallMs; timeoutKind = 'overall'; controller.abort(); }, overallMs);
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
          headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
          body,
        });
        stage = 'response';
        headersMs = Date.now() - attemptStarted;
        // HTTP classification must survive an error body that itself times out.
        if (!response.ok) httpError = response.status >= 500 || response.status === 408
          ? new ModelOutcomeUnknown(`Model provider returned HTTP ${response.status}; execution outcome requires reconciliation`)
          : new ModelResponseRejected(`Model provider returned HTTP ${response.status}`, { inputTokens: 0, outputTokens: 0 });
        // Read only a bounded error excerpt. Never put it in public Run errors.
        streamReceived = response.ok && (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false);
        if (streaming && !streamReceived && !signal.aborted) {
          // JSON and HTTP error bodies keep the request deadline even when SSE was requested.
          timeoutMs = Math.min(overallMs, this.requestTimeoutMs);
          clearTimeout(overallTimer);
          const remainingMs = timeoutMs - (Date.now() - attemptStarted);
          if (remainingMs <= 0) controller.abort();
          else overallTimer = setTimeout(() => controller.abort(), remainingMs);
        }
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
          if (!streamReceived) {
            diagnostics.contentBytes = Buffer.byteLength(raw.choices[0]!.message.content, 'utf8');
            if (raw.choices[0]!.finish_reason != null) diagnostics.finishReason = raw.choices[0]!.finish_reason;
          }
          console.info(JSON.stringify({ protocol: 'aeeis-model-completion/1', provider: this.pin.provider ?? new URL(this.pin.endpoint).hostname,
            model: this.pin.model, requestId: response?.headers.get('x-request-id') ?? response?.headers.get('x-tt-logid') ?? null,
            attempt, lengthAttempt, headersMs, firstByteMs, elapsedMs: Date.now() - attemptStarted, responseBytes,
            ...logDiagnostics(diagnostics, responseBytes),
            idempotencyKey, requestBodyHash, transportAttempt, midstreamRetries: history.midstreamRetries,
            thinkingUnsupported: history.thinkingUnsupported || undefined,
            ...(history.usageUnknown ? { usageUnknown: true, billingRisk: 'duplicate-possible' } : {}),
            promptChars: request.system.length + JSON.stringify(request.input).length, maxTokens, usage: raw.usage }));
          return raw;
        };
        if (streamReceived) return completed(await readStreamCompletion(read, diagnostics));
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
        const responseBody = Buffer.concat(chunks).toString('utf8');
        if (!response.ok) {
          bodyExcerpt = responseBody;
          try { const parsed = JSON.parse(responseBody); errorCode = String(parsed.error?.code ?? parsed.code ?? '') || undefined; } catch { /* text error */ }
          throw httpError;
        }
        return completed(envelope.parse(JSON.parse(responseBody)));
      } catch (error) {
        // The HTTP attempt has ended. Storage callbacks/backoff must not change its timeout classification.
        clearTimeout(overallTimer); clearTimeout(firstByteTimer); clearTimeout(idleTimer);
        void bodyReader?.cancel().catch(() => undefined);
        const network = stage === 'request' || signal.aborted || error instanceof TypeError || (
          error instanceof Error && /ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR/.test(String((error as NodeJS.ErrnoException).code ?? (error.cause as NodeJS.ErrnoException | undefined)?.code ?? ''))
        );
        const thinkingDowngrade = this.arkProvider && response?.status === 400 && !signal.aborted && !history.thinkingUnsupported && Boolean(thinking || reasoningEffort);
        const retryable = thinkingDowngrade || (httpError !== undefined
          ? response!.status === 429 || response!.status >= 500
          : network);
        // Retryability classifies the error. The decision explains the actual replay fence/budget.
        let retryDecision: string;
        if (signal.aborted && timeoutKind === 'overall') retryDecision = 'overall-timeout';
        else if (thinkingDowngrade) retryDecision = 'thinking-unsupported';
        else if (!retryable) retryDecision = 'not-retryable';
        else if (signal.aborted && timeoutKind === 'idle' && streamReceived && responseBytes > 0) {
          retryDecision = !request.idempotencyKey ? 'no-idempotency-key'
            : history.midstreamRetries >= this.transport.midstreamRetries ? 'attempts-exhausted' : 'midstream-retry';
        } else if (responseBytes > 0) retryDecision = 'body-bytes-received';
        else if (signal.aborted && timeoutKind === 'first-byte' && !request.idempotencyKey) retryDecision = 'no-idempotency-key';
        else if (signal.aborted && timeoutKind === 'first-byte' && !this.transport.retryEmptyIdle) retryDecision = 'retry-disabled';
        else if (transportAttempt >= this.transport.maxAttempts) retryDecision = 'attempts-exhausted';
        else if (signal.aborted && timeoutKind !== 'first-byte') retryDecision = 'not-retryable';
        else if (streamReceived && !signal.aborted) retryDecision = 'stream-started';
        else retryDecision = 'retry';
        const errorCodeRaw = String((error as NodeJS.ErrnoException)?.code ?? ((error as Error)?.cause as NodeJS.ErrnoException | undefined)?.code ?? '');
        const connectPhase = !signal.aborted && response === undefined && /^(?:UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/.test(errorCodeRaw);
        if (connectPhase && retryDecision === 'attempts-exhausted' && connectRetries < 1) retryDecision = 'connect-retry';
        let recordingFailed = false;
        const nextMidstreamRetry = history.midstreamRetries + 1;
        // Persist wire variants before sending them; never mutate the frozen logical request.
        try {
          if (retryDecision === 'thinking-unsupported') {
            this.thinkingUnsupported = true;
            await request.onThinkingUnsupported?.({ reason: 'http-400' });
          }
          if (retryDecision === 'midstream-retry') await request.onMidstreamRetry?.({ midstreamRetries: nextMidstreamRetry, responseBytes });
        } catch { recordingFailed = true; retryDecision = 'retry-recording-failed'; }
        const willRetry = ['retry', 'midstream-retry', 'thinking-unsupported', 'connect-retry'].includes(retryDecision);
        const delayMs = willRetry && retryDecision !== 'thinking-unsupported'
          ? Math.max(retryDecision === 'connect-retry' || connectPhase ? Math.min(2_000, this.transport.retryMaxMs) : 0,
            Math.floor(Math.min(this.transport.retryMaxMs, this.transport.retryBaseMs * 2 ** (transportAttempt - 1)) * (0.5 + Math.random() * 0.5))) : 0;
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
          ...logDiagnostics(diagnostics, responseBytes),
          idempotencyKey, requestBodyHash, transportAttempt, midstreamRetries: history.midstreamRetries, maxMidstreamRetries: this.transport.midstreamRetries,
          thinkingUnsupported: thinkingDowngrade || history.thinkingUnsupported || undefined,
          ...(streamReceived && responseBytes > 0 || history.usageUnknown ? { usageUnknown: true } : {}),
          ...(retryDecision === 'midstream-retry' || history.usageUnknown ? { billingRisk: 'duplicate-possible' } : {}),
          maxTokens, timeoutKind: signal.aborted ? timeoutKind : undefined, connectPhase: connectPhase || undefined, retryable, willRetry, retryDecision, retryDelayMs: delayMs,
        }));
        if (recordingFailed) throw new ModelOutcomeUnknown('Model retry could not be recorded; reconcile before retrying');
        if (willRetry) {
          retryDelayMs = delayMs;
          if (retryDecision === 'midstream-retry') { history.midstreamRetries = nextMidstreamRetry; history.usageUnknown = true; }
          else if (retryDecision === 'thinking-unsupported') history.thinkingUnsupported = true;
          else if (retryDecision === 'connect-retry') connectRetries++;
          else transportAttempt++;
        } else if (httpError) throw httpError;
        else if (network) throw new ModelOutcomeUnknown(signal.aborted
          ? `Model ${stage} timed out after ${timeoutMs}ms${streaming || timeoutKind === 'first-byte' ? ` (${timeoutKind} timeout)` : ''}. The provider outcome is unknown; reconcile before retrying because the request may have been billed.`
          : `Model ${stage} connection was interrupted. The provider outcome is unknown; reconcile before retrying because the request may have been billed.`);
        else throw error;
      } finally { clearTimeout(overallTimer); clearTimeout(firstByteTimer); clearTimeout(idleTimer); void bodyReader?.cancel().catch(() => undefined); }
      if (retryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
}
