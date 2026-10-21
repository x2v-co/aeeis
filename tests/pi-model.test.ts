import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PiModelAdapter, type PiModelOptions, type PiToolBinding } from '../src/adapters/pi/model.js';
import { CatalogModelResolver, StaticModelResolver } from '../src/runtime/model-router.js';
import { ModelOutcomeUnknown, ModelRateLimited, ModelResponseRejected, ModelTimeout, type ModelRequest } from '../src/runtime/model.js';
import { piModel, piPin, recordingFetch, responses, sse, type ResponsesOptions } from './support/pi-fixture.js';

const binding: PiToolBinding = {
  name: 'lookup', toolId: 'fixture.lookup', toolVersion: '1', description: 'Read fixture status',
  input: z.object({ key: z.string() }).strict(),
};
const args = { input: { key: 'status' }, purpose: 'Read the approved status' };
const decision = { type: 'capability', toolId: binding.toolId, toolVersion: binding.toolVersion, ...args };
const request: ModelRequest = { system: 'Return the requested JSON.', input: { goal: 'fixture' } };
const executor: ModelRequest = {
  ...request, input: {
    task: { id: 'operate' }, observations: [],
    capabilityCatalog: { schemaVersion: 'capability-catalog/1', tools: [{ id: binding.toolId, version: binding.toolVersion, inputSchema: z.toJSONSchema(binding.input, { io: 'input' }) }] },
  },
};
function fixture(value: unknown, responseOptions: ResponsesOptions = {}, options: Partial<PiModelOptions> = {}) {
  const transport = recordingFetch(() => responses(value, responseOptions));
  const adapter = new PiModelAdapter({ pin: piPin, model: piModel, apiKey: 'fixture-key', tools: [binding], fetch: transport.fetch, ...options });
  return { adapter, ...transport };
}
function native(argumentsValue: unknown = args, name = binding.name) { return { name, arguments: argumentsValue }; }

describe('pi single-request model adapter', () => {
  it('uses the actual pi parser for one JSON response and keeps the frozen input intact', async () => {
    const { adapter, requests } = fixture({ answer: 'ok' });
    const before = structuredClone(request);
    const result = await adapter.complete({ ...request, idempotencyKey: 'model:run:call', includeRawOutput: true, maxTokens: 128 });
    expect(result.value).toEqual({ answer: 'ok' });
    expect(request).toEqual(before);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${piModel.baseUrl}/responses`);
    expect(requests[0]?.headers.get('idempotency-key')).toBe('model:run:call');
    expect(requests[0]?.body).toMatchObject({ model: piModel.id, max_output_tokens: 128, stream: true, store: false });
    expect(JSON.stringify(requests[0]?.body)).toContain('Return the requested JSON.');
    expect(requests[0]?.body).not.toHaveProperty('reasoning');
    expect(result.rawOutput).toContain('reportedUsage');
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 5, details: { source: 'pi-ai/1.3.0', accounting: 'tokens-only' } });
  });

  it('maps one native call without granting permissions or copying the provider call ID', async () => {
    const { adapter, requests } = fixture(undefined, { calls: [native()] });
    const result = await adapter.complete(executor);
    expect(result.value).toEqual(decision);
    expect(result.value).not.toHaveProperty('idempotencyKey');
    expect(result.value).not.toHaveProperty('authorization');
    expect(requests[0]?.body.tools).toEqual([expect.objectContaining({ type: 'function', name: 'lookup', parameters: expect.objectContaining({ required: ['input', 'purpose'] }) })]);
  });

  it('supports validated legacy JSON capability decisions', async () => {
    const { adapter } = fixture(decision);
    expect((await adapter.complete(executor)).value).toEqual(decision);
  });

  it.each([
    ['unknown tool', args, 'unapproved'],
    ['wrong type', { ...args, input: { key: 3 } }, 'lookup'],
    ['extra argument', { ...args, input: { key: 'status', authorization: 'trusted' } }, 'lookup'],
    ['missing purpose', { input: args.input }, 'lookup'],
    ['forged authorization', { ...args, authorization: { decision: 'authorized' } }, 'lookup'],
    ['malformed JSON', '{"input":{"key":"status"},"purpose":"Read status"', 'lookup'],
  ])('rejects %s rather than executing or repairing it', async (_label, input, name) => {
    const { adapter, requests } = fixture(undefined, { calls: [native(input, name as string)] });
    await expect(adapter.complete(executor)).rejects.toBeInstanceOf(ModelResponseRejected);
    expect(requests).toHaveLength(1);
  });

  it('rejects a whole multi-call batch while preserving settled usage', async () => {
    const { adapter, requests } = fixture(undefined, { calls: [native(), native()] });
    await expect(adapter.complete(executor)).rejects.toMatchObject({ usage: expect.objectContaining({ inputTokens: 20, outputTokens: 5 }), message: expect.stringContaining('multiple native tool calls') });
    expect(requests).toHaveLength(1);
  });

  it.each([
    ['planner', request.input],
    ['final-only', { ...executor.input as object, executionBudget: { finalOnly: true } }],
    ['finish repair', { ...executor.input as object, finishRepair: { reason: 'invalid finish' } }],
    ['wrong version', { ...executor.input as object, capabilityCatalog: { schemaVersion: 'capability-catalog/1', tools: [{ id: binding.toolId, version: '2', inputSchema: z.toJSONSchema(binding.input, { io: 'input' }) }] } }],
  ])('does not advertise native tools for %s and rejects unsolicited calls', async (_label, input) => {
    const { adapter, requests } = fixture(undefined, { calls: [native()] });
    await expect(adapter.complete({ ...request, input })).rejects.toBeInstanceOf(ModelResponseRejected);
    expect(requests[0]?.body.tools ?? []).toEqual([]);
  });

  it('fails before dispatch when the frozen catalog schema differs', async () => {
    const { adapter, requests } = fixture({ answer: 'ok' });
    await expect(adapter.complete({ ...executor, input: { ...executor.input as object, capabilityCatalog: { schemaVersion: 'capability-catalog/1', tools: [{ id: binding.toolId, version: '1', inputSchema: {} }] } } })).rejects.toThrow('differs from frozen catalog');
    expect(requests).toHaveLength(0);
  });

  it('does not allow text JSON to bypass tool argument validation', async () => {
    const { adapter } = fixture({ ...decision, input: { key: 123 } });
    await expect(adapter.complete(executor)).rejects.toThrow('strict validation');
  });

  it('allows completed text only when explicitly requested', async () => {
    const { adapter } = fixture(undefined, { text: 'A plain plan proposal.' });
    await expect(adapter.complete(request)).rejects.toBeInstanceOf(ModelResponseRejected);
    expect((await adapter.complete({ ...request, allowTextOutput: true })).value).toBe('A plain plan proposal.');
  });

  it.each(['length', 'error'] as const)('rejects %s terminal responses without dropping their usage', async stopReason => {
    const { adapter, requests } = fixture(undefined, { calls: [native()], stopReason });
    await expect(adapter.complete({ ...executor, includeRawOutput: true })).rejects.toMatchObject({ usage: expect.objectContaining({ inputTokens: 20, outputTokens: 5 }), rawOutput: expect.any(String) });
    expect(requests).toHaveLength(1);
  });

  it('counts cached input once and never adds reasoning tokens to output again', async () => {
    const { adapter } = fixture({ answer: 'ok' }, { usage: {
      input_tokens: 100, output_tokens: 15, total_tokens: 115,
      input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 4 },
    } });
    expect((await adapter.complete(request)).usage).toEqual({
      inputTokens: 100, outputTokens: 15,
      details: {
        source: 'pi-ai/1.3.0', accounting: 'tokens-only', cacheReadTokens: 60, cacheWriteTokens: 10, reasoningTokens: 4,
        reported: { input_tokens: 100, output_tokens: 15, total_tokens: 115, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 4 } },
        normalized: { input: 30, output: 15, cacheRead: 60, cacheWrite: 10, totalTokens: 115 },
      },
    });
  });

  it('keeps unreported cache/reasoning fields unknown despite pi zero-fill', async () => {
    const { adapter } = fixture({ answer: 'ok' });
    const details = (await adapter.complete(request)).usage!.details!;
    expect(details).not.toHaveProperty('cacheReadTokens');
    expect(details).not.toHaveProperty('cacheWriteTokens');
    expect(details).not.toHaveProperty('reasoningTokens');
    expect(details.normalized.cacheRead).toBe(0);
  });

  it('preserves reported zero distinctly from unknown', async () => {
    const { adapter } = fixture({}, { usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
    expect((await adapter.complete(request)).usage).toMatchObject({ inputTokens: 0, outputTokens: 0, details: { cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } });
  });

  it.each([
    null,
    { input_tokens: 20, output_tokens: 5, total_tokens: 999 },
    { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 21 } },
    { input_tokens: 20, output_tokens: 5, output_tokens_details: { reasoning_tokens: 6 } },
    { input_tokens: -1, output_tokens: 5 },
  ])('does not invent valid usage for absent or invalid counters: %j', async usage => {
    const { adapter } = fixture({}, { usage });
    expect((await adapter.complete(request)).usage).toBeUndefined();
  });

  it.each([15, 4097, Number.NaN])('rejects unsupported maxTokens %s before dispatch instead of clamping', async maxTokens => {
    const { adapter, requests } = fixture({});
    await expect(adapter.complete({ ...request, maxTokens })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it.each([
    { thinking: 'enabled' as const }, { thinking: 'auto' as const }, { reasoningEffort: 'high' as const },
    { thinkingUnsupported: true }, { midstreamRetries: 1 },
  ])('rejects unsupported request controls explicitly: %j', async controls => {
    const { adapter, requests } = fixture({});
    await expect(adapter.complete({ ...request, ...controls })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it('forwards supported reasoning effort and preserves null omission', async () => {
    const { adapter, requests } = fixture({}, {}, { model: { ...piModel, reasoning: true } });
    await adapter.complete({ ...request, reasoningEffort: 'low' });
    expect(requests[0]?.body.reasoning).toMatchObject({ effort: 'low' });
    await adapter.complete({ ...request, thinking: null, reasoningEffort: null });
    expect(requests[1]?.body).not.toHaveProperty('reasoning');
    await expect(adapter.complete({ ...request, thinking: 'disabled' })).rejects.toThrow('thinking toggles');
  });

  it('has no hidden retry for HTTP 429 and records the single rejection', async () => {
    const transport = recordingFetch(() => new Response('{"error":{"message":"fixture rate limit"}}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } }));
    const adapter = new PiModelAdapter({ pin: piPin, model: piModel, apiKey: 'fixture-key', fetch: transport.fetch });
    const onRateLimited = vi.fn(), beforeRetry = vi.fn(), onMidstreamRetry = vi.fn();
    await expect(adapter.complete({ ...request, disableRetries: false, onRateLimited, beforeRetry, onMidstreamRetry })).rejects.toBeInstanceOf(ModelRateLimited);
    expect(transport.requests).toHaveLength(1);
    expect(onRateLimited).toHaveBeenCalledTimes(1);
    expect(onRateLimited).toHaveBeenCalledWith(expect.objectContaining({ willRetry: false, attempt: 1, maxAttempts: 1 }));
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(onMidstreamRetry).not.toHaveBeenCalled();
  });

  it.each([500, 503])('classifies HTTP %s as unknown with only one fetch', async status => {
    const transport = recordingFetch(() => new Response('fixture unavailable', { status }));
    const adapter = new PiModelAdapter({ pin: piPin, model: piModel, apiKey: 'fixture-key', fetch: transport.fetch });
    await expect(adapter.complete(request)).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    expect(transport.requests).toHaveLength(1);
  });

  it('does not replay a disconnected stream', async () => {
    const transport = recordingFetch(() => sse([{ type: 'response.created', response: { id: 'resp', status: 'in_progress' } }]));
    const adapter = new PiModelAdapter({ pin: piPin, model: piModel, apiKey: 'fixture-key', fetch: transport.fetch });
    await expect(adapter.complete(request)).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    expect(transport.requests).toHaveLength(1);
  });

  it('honors a pre-dispatch abort without issuing a request', async () => {
    const { adapter, requests } = fixture({});
    await expect(adapter.complete({ ...request, signal: AbortSignal.abort() })).rejects.toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } });
    expect(requests).toHaveLength(0);
  });

  it('bounds timeout even when injected fetch ignores cancellation', async () => {
    let finish!: (response: Response) => void;
    const transport = recordingFetch(() => new Promise<Response>(resolve => { finish = resolve; }));
    const adapter = new PiModelAdapter({ pin: piPin, model: piModel, apiKey: 'fixture-key', fetch: transport.fetch });
    await expect(adapter.complete({ ...request, timeoutMs: 25 })).rejects.toBeInstanceOf(ModelTimeout);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.signal?.aborted).toBe(true);
    finish(responses({ late: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(transport.requests).toHaveLength(1);
  });

  it('aborts an in-flight request without claiming the provider rolled it back', async () => {
    let finish!: (response: Response) => void;
    const transport = recordingFetch(() => new Promise<Response>(resolve => { finish = resolve; }));
    const adapter = new PiModelAdapter({ pin: piPin, model: piModel, apiKey: 'fixture-key', fetch: transport.fetch });
    const controller = new AbortController();
    const pending = adapter.complete({ ...request, signal: controller.signal });
    const assertion = expect(pending).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    controller.abort();
    await assertion;
    finish(responses({ late: true }));
    expect(transport.requests[0]?.signal?.aborted).toBe(true);
  });

  it('bounds UTF-8 response bytes before the provider parser and stops consumption', async () => {
    const { adapter, requests } = fixture(undefined, { text: '汉'.repeat(2000) });
    await expect(adapter.complete({ ...request, allowTextOutput: true, maxResponseBytes: 2000 })).rejects.toThrow('exceeds 2000 bytes');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  it('rejects a provider-side model substitution while retaining reported usage', async () => {
    const transport = recordingFetch(() => sse([{ type: 'response.completed', response: {
      id: 'resp_other', status: 'completed', model: 'different-model', output: [],
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    } }]));
    const adapter = new PiModelAdapter({ pin: piPin, model: piModel, apiKey: 'fixture-key', fetch: transport.fetch });
    await expect(adapter.complete(request)).rejects.toMatchObject({ message: expect.stringContaining('different model'), usage: expect.objectContaining({ inputTokens: 20, outputTokens: 5 }) });
    expect(transport.requests).toHaveLength(1);
  });

  it('records zero usage for local validation and serialization failures', async () => {
    const { adapter, requests } = fixture({});
    await expect(adapter.complete({ ...request, thinking: 'auto' })).rejects.toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } });
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    await expect(adapter.complete({ ...request, input: cyclic })).rejects.toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } });
    expect(requests).toHaveLength(0);
  });

  it('records zero usage when pi converts a pre-dispatch payload error into an error event', async () => {
    const baseUrl = 'https://api.openai.com/v1';
    const { adapter, requests } = fixture({}, {}, { model: { ...piModel, baseUrl }, pin: { ...piPin, endpoint: baseUrl } });
    // The SDK treats this inert, non-API-key token as a different auth mode and omits the token cap.
    await expect(adapter.complete(request)).rejects.toMatchObject({ message: 'Pi request failed before dispatch', usage: { inputTokens: 0, outputTokens: 0 } });
    expect(requests).toHaveLength(0);
  });

  it.each([400, 401, 403, 404, 422])('records HTTP %s as a definite unbilled rejection', async status => {
    const transport = recordingFetch(() => new Response('{"error":{"message":"fixture rejection"}}', { status, headers: { 'content-type': 'application/json' } }));
    const adapter = new PiModelAdapter({ pin: piPin, model: piModel, apiKey: 'fixture-key', fetch: transport.fetch });
    await expect(adapter.complete(request)).rejects.toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } });
    expect(transport.requests).toHaveLength(1);
  });

  it('finishes and records usage after a terminal event even when the server never closes SSE', async () => {
    let cancelled = false;
    const transport = recordingFetch(async () => {
      const bytes = new Uint8Array(await responses({ answer: 'complete' }).arrayBuffer());
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); },
        cancel() { cancelled = true; },
      }), { headers: { 'content-type': 'text/event-stream' } });
    });
    const adapter = new PiModelAdapter({ pin: piPin, model: piModel, apiKey: 'fixture-key', fetch: transport.fetch });
    const result = await adapter.complete({ ...request, timeoutMs: 200 });
    expect(result.value).toEqual({ answer: 'complete' });
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 5 });
    expect(transport.requests).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  it.each(['queued', 'in_progress', undefined])('does not accept an inconsistent terminal status %s', async status => {
    const transport = recordingFetch(async () => {
      const body = await responses(undefined, { calls: [native()] }).text();
      const events = body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      const last = events.at(-1)!;
      last.type = 'response.incomplete';
      last.response.status = status;
      return sse(events);
    });
    const adapter = new PiModelAdapter({ pin: piPin, model: piModel, apiKey: 'fixture-key', tools: [binding], fetch: transport.fetch });
    await expect(adapter.complete(executor)).rejects.toMatchObject({ usage: expect.objectContaining({ inputTokens: 20, outputTokens: 5 }) });
    expect(transport.requests).toHaveLength(1);
  });

  it('derives the default output allowance from the frozen pin ceiling', async () => {
    const { adapter, requests } = fixture({}, {}, { pin: { ...piPin, maxOutputTokens: 1024 } });
    expect(adapter.requestDefaults().maxTokens).toBe(1024);
    await adapter.complete(request);
    expect(requests[0]?.body.max_output_tokens).toBe(1024);
    await expect(adapter.complete({ ...request, maxTokens: 1025 })).rejects.toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } });
    expect(requests).toHaveLength(1);
  });

  it('generates local recursive schema references relative to the complete tool envelope', async () => {
    interface Tree { value: string; children?: Tree[] | undefined }
    const tree: z.ZodType<Tree> = z.lazy(() => z.object({ value: z.string(), children: z.array(tree).optional() }).strict());
    const treeBinding = { ...binding, input: tree };
    const input = { value: 'root', children: [{ value: 'child' }] };
    const transport = recordingFetch(() => responses(undefined, { calls: [native({ input, purpose: args.purpose })] }));
    const adapter = new PiModelAdapter({ pin: piPin, model: piModel, apiKey: 'fixture-key', tools: [treeBinding], fetch: transport.fetch });
    const result = await adapter.complete({ ...executor, input: {
      ...executor.input as object,
      capabilityCatalog: { schemaVersion: 'capability-catalog/1', tools: [{ id: binding.toolId, version: '1', inputSchema: z.toJSONSchema(tree, { io: 'input' }) }] },
    } });
    expect(result.value).toEqual({ ...decision, input });
    const parameters = (transport.requests[0]!.body.tools as Array<{ parameters: unknown }>)[0]!.parameters;
    expect(parameters).toEqual(z.toJSONSchema(z.object({ input: tree, purpose: z.string().min(1).max(2000) }).strict(), { io: 'input' }));
    expect(JSON.stringify(parameters)).not.toContain('"$ref":"#"');
    expect(parameters).toMatchObject({
      properties: { input: { $ref: '#/$defs/__schema0' } },
      $defs: { __schema0: { properties: { value: { type: 'string' }, children: { items: { $ref: '#/$defs/__schema0' } } } } },
    });
  });

  it('does not resume a token-only pin under a different accounting mode', () => {
    const { adapter } = fixture({});
    const resolver = new StaticModelResolver(adapter);
    expect(resolver.forPin(structuredClone(adapter.pin))).toBe(adapter);
    const oldPin = { ...adapter.pin }; delete oldPin.usageAccounting;
    expect(() => resolver.forPin(oldPin)).toThrow('Pinned model is unavailable');
  });

  it('rejects formal catalog routing before producing an unrecoverable chat-completions pin', async () => {
    const { adapter, requests } = fixture({});
    const resolver = new CatalogModelResolver({ list: async () => [{
      model: piModel.id, provider: 'openai', endpoint: piModel.baseUrl, capabilities: ['agent'],
      offeringId: 'fixture-offering', modelId: 'fixture-model', modelVersion: 'fixture-1', versionStatus: 'pinned',
      providerId: 'openai', channelId: 'fixture-channel', regionSetId: 'fixture-region', pricingVariantId: 'fixture-price',
      catalogVersion: 'fixture-catalog', catalogDigest: `sha256:${'1'.repeat(64)}`, offeringHash: `sha256:${'2'.repeat(64)}`,
      endpointRef: piModel.baseUrl, requestModel: piModel.id, mappingVersion: 'fixture-mapping', pricingSnapshot: {},
    }] }, { create: () => adapter });
    await expect(resolver.resolve({ capability: 'agent', privacy: 'internal' })).rejects.toThrow('do not support formal catalog');
    expect(requests).toHaveLength(0);
  });

  it('pins request identity and rejects transport overrides or duplicate tool bindings', () => {
    const options = { pin: piPin, model: piModel, apiKey: 'fixture-key' };
    expect(() => new PiModelAdapter({ ...options, pin: { ...piPin, model: 'other-model' } })).toThrow('frozen model pin');
    expect(() => new PiModelAdapter({ ...options, model: { ...piModel, samplingParams: { model: 'other-model' } } })).toThrow('overrides');
    expect(() => new PiModelAdapter({ ...options, tools: [binding, binding] })).toThrow('unique names');
    expect(() => new PiModelAdapter({ ...options, apiKey: '' })).toThrow('explicit API key');
  });
});
