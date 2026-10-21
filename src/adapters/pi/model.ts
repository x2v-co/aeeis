import { normalizeContext, type AssistantMessage, type FetchFunction, type Model, type Tool, type TSchema } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-responses';
import { z } from 'zod';
import type { ModelCallUsage, ModelPin } from '../../runtime/contracts.js';
import { digest } from '../../runtime/digest.js';
import { ModelOutcomeUnknown, ModelRateLimited, ModelResponseRejected, ModelTimeout, type ModelAdapter, type ModelRequest, type ModelResponse } from '../../runtime/model.js';

export interface PiToolBinding {
  name: string;
  toolId: string;
  toolVersion: string;
  description: string;
  input: z.ZodType;
}

export interface PiModelOptions {
  pin: ModelPin;
  model: Model<'openai-responses'>;
  apiKey: string;
  fetch?: FetchFunction;
  tools?: PiToolBinding[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  cacheRetention?: 'none' | 'short' | 'long';
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reportedUsage = z.object({
  input_tokens: count, output_tokens: count, total_tokens: count.optional(),
  input_tokens_details: z.object({ cached_tokens: count.optional(), cache_write_tokens: count.optional() }).optional(),
  output_tokens_details: z.object({ reasoning_tokens: count.optional() }).optional(),
});
const executorContext = z.object({
  task: z.object({ id: z.string() }), observations: z.array(z.unknown()),
  capabilityCatalog: z.object({ schemaVersion: z.literal('capability-catalog/1'), tools: z.array(z.object({ id: z.string(), version: z.string(), inputSchema: z.unknown() })) }),
  executionBudget: z.object({ finalOnly: z.boolean().optional() }).optional(),
  finishRepair: z.unknown().optional(),
});
const callArguments = z.object({ input: z.unknown(), purpose: z.string().trim().min(1).max(2000) }).strict();
const zeroUsage = { inputTokens: 0, outputTokens: 0 };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function usageFrom(raw: unknown, message: AssistantMessage): ModelCallUsage | undefined {
  const parsed = reportedUsage.safeParse(raw);
  if (!parsed.success) return;
  const row = parsed.data;
  const total = row.input_tokens + row.output_tokens;
  const cacheRead = row.input_tokens_details?.cached_tokens;
  const cacheWrite = row.input_tokens_details?.cache_write_tokens;
  const reasoning = row.output_tokens_details?.reasoning_tokens;
  if (!Number.isSafeInteger(total) || (row.total_tokens !== undefined && row.total_tokens !== total)
    || (cacheRead ?? 0) + (cacheWrite ?? 0) > row.input_tokens || (reasoning ?? 0) > row.output_tokens) return;
  const { input, output, cacheRead: normalizedRead, cacheWrite: normalizedWrite, totalTokens } = message.usage;
  if (![input, output, normalizedRead, normalizedWrite, totalTokens].every(value => count.safeParse(value).success)) return;
  return {
    inputTokens: row.input_tokens, outputTokens: row.output_tokens,
    details: {
      source: 'pi-ai/1.3.0', accounting: 'tokens-only',
      reported: {
        input_tokens: row.input_tokens, output_tokens: row.output_tokens,
        ...(row.total_tokens === undefined ? {} : { total_tokens: row.total_tokens }),
        ...(cacheRead === undefined && cacheWrite === undefined ? {} : { input_tokens_details: {
          ...(cacheRead === undefined ? {} : { cached_tokens: cacheRead }),
          ...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
        } }),
        ...(reasoning === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoning } }),
      },
      ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
      ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
      normalized: { input, output, cacheRead: normalizedRead, cacheWrite: normalizedWrite, totalTokens },
    },
  };
}

/** Single Responses request; AEEIS, not pi, owns approval, tools and recovery. */
export class PiModelAdapter implements ModelAdapter {
  readonly pin: ModelPin;
  private readonly model: Model<'openai-responses'>;
  private readonly apiKey: string;
  private readonly fetch: FetchFunction;
  private readonly bindings: Array<PiToolBinding & { schema: unknown; tool: Tool }>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly cacheRetention: 'none' | 'short' | 'long';

  constructor(options: PiModelOptions) {
    const model = structuredClone(options.model);
    if (model.api !== 'openai-responses' || model.provider !== 'openai') throw new Error('Pi PoC supports only the openai Responses adapter');
    const endpoint = new URL(model.baseUrl);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) {
      throw new Error('Pi endpoint must use HTTPS except loopback, without credentials, query or fragment');
    }
    if (options.pin.model !== model.id || options.pin.endpoint.replace(/\/$/, '') !== model.baseUrl.replace(/\/$/, '')
      || (options.pin.provider !== undefined && options.pin.provider !== model.provider)
      || (options.pin.requestModel !== undefined && options.pin.requestModel !== model.id)) throw new Error('Pi model does not match the frozen model pin');
    if (!options.apiKey.trim()) throw new Error('Pi requires an explicit API key; environment credential discovery is disabled');
    if (model.samplingParams || model.samplingParamsByThinkingLevel || model.headers
      || model.compat?.supportsMaxOutputTokens === false || model.compat?.supportsMidConvoEffort) {
      throw new Error('Pi PoC does not allow model transport or sampling overrides');
    }
    this.pin = Object.freeze({ ...structuredClone(options.pin), usageAccounting: 'tokens-only' });
    this.model = model;
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = positive(options.timeoutMs ?? 120_000, 'timeoutMs');
    if (this.timeoutMs > 2_147_483_647) throw new Error('timeoutMs exceeds the supported timer range');
    this.maxResponseBytes = positive(options.maxResponseBytes ?? 1_000_000, 'maxResponseBytes');
    this.cacheRetention = options.cacheRetention ?? 'none';
    if (this.cacheRetention === 'long' && model.compat?.supportsLongCacheRetention === false) throw new Error('This model does not support long cache retention');
    const names = new Set<string>();
    const identities = new Set<string>();
    this.bindings = (options.tools ?? []).map(binding => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(binding.name) || !binding.toolId || !binding.toolVersion
        || names.has(binding.name) || identities.has(`${binding.toolId}@${binding.toolVersion}`)) throw new Error('Pi tool bindings require unique names and versioned identities');
      names.add(binding.name); identities.add(`${binding.toolId}@${binding.toolVersion}`);
      const schema = z.toJSONSchema(binding.input, { io: 'input' });
      return { ...binding, schema, tool: {
        name: binding.name, description: binding.description, constrainedSampling: false,
        parameters: z.toJSONSchema(z.object({ input: binding.input, purpose: z.string().min(1).max(2000) }).strict(), { io: 'input' }) as unknown as TSchema,
      } };
    });
    this.tokenLimit(this.defaultMaxTokens());
  }

  private defaultMaxTokens(): number {
    return this.pin.maxTokens ?? Math.min(16_384, this.model.maxTokens, this.pin.maxOutputTokens ?? this.model.maxTokens);
  }

  requestDefaults(): Pick<ModelRequest, 'maxTokens' | 'thinking' | 'reasoningEffort'> {
    return { maxTokens: this.defaultMaxTokens(), thinking: null, reasoningEffort: null };
  }

  private tokenLimit(value: number): number {
    positive(value, 'maxTokens');
    const ceiling = Math.min(this.model.maxTokens, this.pin.maxOutputTokens ?? this.model.maxTokens);
    if (value < 16 || value > ceiling) throw new Error(`Pi Responses maxTokens must be between 16 and ${ceiling}; implicit clamping is disabled`);
    return value;
  }

  private toolsFor(request: ModelRequest) {
    const parsed = executorContext.safeParse(request.input);
    if (!parsed.success || parsed.data.executionBudget?.finalOnly || parsed.data.finishRepair !== undefined) return [];
    return this.bindings.filter(binding => {
      const descriptor = parsed.data.capabilityCatalog.tools.find(tool => tool.id === binding.toolId && tool.version === binding.toolVersion);
      if (!descriptor) return false;
      if (digest(descriptor.inputSchema) !== digest(binding.schema)) throw new Error(`Pi tool schema differs from frozen catalog: ${binding.toolId}@${binding.toolVersion}`);
      return true;
    });
  }

  private prepare(request: ModelRequest) {
    try {
      const maxTokens = this.tokenLimit(request.maxTokens ?? this.defaultMaxTokens());
      const timeoutMs = Math.min(positive(request.timeoutMs ?? this.timeoutMs, 'timeoutMs'), this.timeoutMs);
      const maxBytes = Math.min(positive(request.maxResponseBytes ?? this.maxResponseBytes, 'maxResponseBytes'), this.maxResponseBytes);
      if (request.thinking != null && !(request.thinking === 'disabled' && !this.model.reasoning)) throw new Error('Pi Responses does not support thinking toggles; use reasoningEffort or null');
      if (request.thinkingUnsupported || (request.midstreamRetries ?? 0) !== 0) throw new Error('Pi cannot resume HTTP-adapter transport history');
      if (request.reasoningEffort && (!this.model.reasoning || this.model.thinkingLevelMap?.[request.reasoningEffort] === null
        || (this.model.thinkingLevelMap?.[request.reasoningEffort] !== undefined && this.model.thinkingLevelMap[request.reasoningEffort] !== request.reasoningEffort))) throw new Error('Unsupported reasoning effort for this pinned model');
      const bindings = this.toolsFor(request);
      const content = JSON.stringify(request.input);
      if (content === undefined) throw new Error('Pi model input must be JSON serializable');
      return { maxTokens, timeoutMs, maxBytes, bindings, content };
    } catch (error) {
      throw new ModelResponseRejected(error instanceof Error ? error.message : 'Invalid Pi request', zeroUsage);
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { maxTokens, timeoutMs, maxBytes, bindings, content } = this.prepare(request);
    if (request.signal?.aborted) throw new ModelResponseRejected('Pi request cancelled before dispatch', zeroUsage);
    const controller = new AbortController();
    let abortError: Error | undefined;
    let dispatches = 0;
    let status: number | undefined;
    let providerTerminal = false;
    let terminalCompleted = false;
    let responseModelMismatch = false;
    let finishBody: (() => void) | undefined;
    let rawUsage: unknown;
    const rawCalls = new Map<string, { name: string; arguments: string }>();
    let rejectAbort!: (error: Error) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const interrupt = (error: Error) => {
      if (abortError) return;
      abortError = error;
      controller.abort(error);
      rejectAbort(error);
    };
    const cancelled = () => interrupt(new ModelOutcomeUnknown('Pi request cancelled; provider billing or execution may require reconciliation'));
    request.signal?.addEventListener('abort', cancelled, { once: true });
    const timer = setTimeout(() => interrupt(new ModelTimeout(`Pi model overall timeout after ${timeoutMs}ms; reconcile provider usage`)), timeoutMs);
    const fetchOnce: FetchFunction = async (url, init) => {
      if (controller.signal.aborted) throw abortError;
      const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (target !== `${this.model.baseUrl.replace(/\/$/, '')}/responses` || dispatches !== 0) throw new Error('Pi attempted an unexpected endpoint or another request');
      dispatches++;
      const response = await this.fetch(url, { ...init, redirect: 'error', signal: controller.signal });
      status = response.status;
      if (controller.signal.aborted) { await response.body?.cancel().catch(() => undefined); throw abortError; }
      if (status === 429) await request.onRateLimited?.({ status: 429, attempt: 1, maxAttempts: 1, delayMs: 0, retryAfterMs: null, willRetry: false, decision: 'retry-disabled' });
      if (!response.body) return response;
      const reader = response.body.getReader();
      let bytes = 0, closed = false;
      const cancelReader = () => { void reader.cancel().catch(() => undefined); };
      const cleanup = () => controller.signal.removeEventListener('abort', cancelReader);
      controller.signal.addEventListener('abort', cancelReader, { once: true });
      return new Response(new ReadableStream<Uint8Array>({
        start(sink) {
          finishBody = () => {
            if (closed) return;
            closed = true; cleanup(); sink.close(); cancelReader();
          };
        },
        async pull(sink) {
          try {
            const chunk = await reader.read();
            if (closed) return;
            if (chunk.done) { closed = true; cleanup(); sink.close(); return; }
            bytes += chunk.value.byteLength;
            if (bytes > maxBytes) {
              const error = new ModelOutcomeUnknown(`Pi response exceeds ${maxBytes} bytes; reconcile provider usage`);
              closed = true; cleanup(); cancelReader(); interrupt(error); sink.error(error); return;
            }
            sink.enqueue(chunk.value);
          } catch (error) { cleanup(); if (!closed) { closed = true; sink.error(error); } }
        },
        async cancel(reason) { closed = true; cleanup(); await reader.cancel(reason); },
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const consume = async (): Promise<ModelResponse> => {
      const events = stream(this.model, normalizeContext({ systemPrompt: request.system, messages: [{ role: 'user', content, timestamp: 0 }], tools: bindings.map(binding => binding.tool) }), {
        apiKey: this.apiKey, fetch: fetchOnce, signal: controller.signal, maxRetries: 0, timeoutMs, maxTokens,
        cacheRetention: this.cacheRetention, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        ...(request.idempotencyKey ? { headers: { 'Idempotency-Key': request.idempotencyKey } } : {}),
        onPayload: payload => {
          const params = object(payload);
          if (!params || params.model !== this.model.id || params.max_output_tokens !== maxTokens || params.stream !== true || params.store !== false) throw new Error('Pi changed a pinned request control');
          // Pi inserts effort:none for reasoning models; null means omission in AEEIS.
          if (!request.reasoningEffort) delete params.reasoning;
          return params;
        },
        onProviderStreamEvent: data => {
          if (providerTerminal) throw new Error('Pi provider emitted data after its terminal event');
          const event = object(data);
          if (event?.type === 'response.output_item.done') {
            const item = object(event.item);
            if (item?.type === 'function_call') {
              if (typeof item.id !== 'string' || typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw new Error('Malformed native tool call');
              const id = `${item.call_id}|${item.id}`;
              if (rawCalls.has(id)) throw new Error('Duplicate native tool call');
              rawCalls.set(id, { name: item.name, arguments: item.arguments });
            }
          }
          if (['response.completed', 'response.incomplete', 'response.failed'].includes(String(event?.type))) {
            providerTerminal = true;
            const response = object(event?.response);
            rawUsage = response?.usage;
            terminalCompleted = event?.type === 'response.completed' && response?.status === 'completed';
            responseModelMismatch = response?.model !== undefined && response.model !== this.model.id;
            // Pi waits for EOF after a terminal event; some gateways keep SSE open.
            finishBody?.();
          }
        },
      });
      for await (const event of events) {
        if (controller.signal.aborted) throw abortError;
        if (event.type !== 'done' && event.type !== 'error') continue;
        const message = event.type === 'done' ? event.message : event.error;
        const usage = usageFrom(rawUsage, message);
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
        const rawOutput = request.includeRawOutput ? JSON.stringify({ content: message.content, stopReason: message.stopReason, reportedUsage: rawUsage }) : undefined;
        if (event.type === 'error') {
          if (dispatches === 0) throw new ModelResponseRejected('Pi request failed before dispatch', zeroUsage, rawOutput);
          if (status === 429) throw new ModelRateLimited('Pi provider rejected the request with HTTP 429; no retry was attempted', 1);
          if (providerTerminal) throw new ModelResponseRejected('Pi provider rejected the response', usage, rawOutput);
          if (status !== undefined && [400, 401, 403, 404, 422].includes(status)) throw new ModelResponseRejected(`Pi provider rejected the request with HTTP ${status}`, zeroUsage, rawOutput);
          throw new ModelOutcomeUnknown('Pi provider stream failed without a definitive result; reconcile before retrying');
        }
        if (!providerTerminal) throw new ModelOutcomeUnknown('Pi stream ended without a provider terminal event');
        if (responseModelMismatch) throw new ModelResponseRejected('Pi provider returned a different model than the frozen pin', usage, rawOutput);
        if (!['stop', 'toolUse'].includes(message.stopReason)) throw new ModelResponseRejected(`Pi response is not complete: ${message.stopReason}`, usage, rawOutput);
        if (!terminalCompleted) throw new ModelResponseRejected('Pi provider did not confirm a completed response', usage, rawOutput);
        const calls = message.content.filter(block => block.type === 'toolCall');
        if (calls.length > 1 || rawCalls.size > 1) throw new ModelResponseRejected('Pi PoC rejects multiple native tool calls as a whole', usage, rawOutput);
        let value: unknown;
        if (calls.length === 1) {
          const call = calls[0]!;
          const raw = rawCalls.get(call.id);
          const binding = bindings.find(item => item.name === call.name);
          if (!raw || raw.name !== call.name || !binding) throw new ModelResponseRejected('Pi returned an unapproved or incomplete native tool call', usage, rawOutput);
          try {
            const args = JSON.parse(raw.arguments) as unknown;
            if (digest(args) !== digest(call.arguments)) throw new Error('Pi normalized or repaired tool arguments');
            value = this.capability(binding, args);
          } catch { throw new ModelResponseRejected('Pi tool arguments failed strict validation', usage, rawOutput); }
        } else {
          if (rawCalls.size || message.stopReason === 'toolUse') throw new ModelResponseRejected('Pi tool response is inconsistent', usage, rawOutput);
          try { value = JSON.parse(text); }
          catch {
            if (!request.allowTextOutput || !text.trim()) throw new ModelResponseRejected('Pi response is not valid JSON', usage, rawOutput);
            value = text;
          }
          const decision = object(value);
          if (decision?.type === 'capability') {
            const binding = bindings.find(item => item.toolId === decision.toolId && item.toolVersion === decision.toolVersion);
            if (!binding) throw new ModelResponseRejected('Pi returned an unmapped capability decision', usage, rawOutput);
            try { value = this.capability(binding, { input: decision.input, purpose: decision.purpose }); }
            catch { throw new ModelResponseRejected('Pi capability input failed strict validation', usage, rawOutput); }
          }
        }
        return { value, ...(rawOutput === undefined ? {} : { rawOutput }), ...(usage === undefined ? {} : { usage }) };
      }
      throw new ModelOutcomeUnknown('Pi stream ended without a terminal result');
    };
    try {
      return await Promise.race([consume(), interrupted]);
    } catch (error) {
      if (abortError) throw abortError;
      if (error instanceof ModelOutcomeUnknown || error instanceof ModelResponseRejected) throw error;
      if (dispatches) throw new ModelOutcomeUnknown('Pi request failed after dispatch; reconcile before retrying');
      throw new ModelResponseRejected('Pi request failed before dispatch', zeroUsage);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', cancelled);
      controller.abort();
    }
  }

  private capability(binding: PiToolBinding, raw: unknown) {
    const args = callArguments.parse(raw);
    const input = binding.input.parse(args.input);
    if (digest(input) !== digest(args.input)) throw new Error('Tool argument coercion or stripping is not allowed');
    return { type: 'capability', toolId: binding.toolId, toolVersion: binding.toolVersion, input, purpose: args.purpose };
  }
}
