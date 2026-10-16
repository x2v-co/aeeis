import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpModelAdapter, ModelOutcomeUnknown, modelTransportConfig } from '../src/runtime/model.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
const chunk = (content: string, reason: string | null = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason: reason }], usage: null });
const usage = { prompt_tokens: 12, completion_tokens: 30 };
const event = (value: unknown, separator = '\n') => `data: ${JSON.stringify(value)}${separator}${separator}`;
function response(text: string, byteChunks: boolean | number = false) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    if (byteChunks === true) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else if (typeof byteChunks === 'number') for (let offset = 0; offset < bytes.length; offset += byteChunks) controller.enqueue(bytes.slice(offset, offset + byteChunks));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
const adapter = (options = {}) => new HttpModelAdapter('https://ark.cn-beijing.volces.com/api/v3', 'ark-model', 'secret', undefined, 180_000, undefined, false, undefined, { retryBaseMs: 0, ...options });
const stalledResponse = (text: string) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); } }), { headers: { 'content-type': 'text/event-stream' } });

describe('OpenAI-compatible SSE transport', () => {
  it('logs UTF-8 content/reasoning counters, all SSE frames and reasoning-token usage without text', async () => {
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    const rawOutput = '{"text":"中🙂"}', reasoning = 'private reasoning 中文🙂', alias = 'private alias';
    const metered = { ...usage, completion_tokens_details: { reasoning_tokens: 18 } };
    const stream = ': heartbeat\n\n' + event({ choices: [
      { index: 0, delta: { reasoning_content: reasoning }, finish_reason: null },
      { index: 1, delta: { content: 'alternate', reasoning: 'other' }, finish_reason: null },
    ] }) + event({ choices: [{ index: 0, delta: { content: rawOutput, reasoning: alias }, finish_reason: 'stop' }] })
      + event({ choices: [], usage: metered }) + 'data: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => response(stream, true)));
    await expect(adapter().complete({ system: 'private system', input: {} })).resolves.toEqual({ value: { text: '中🙂' }, usage: { inputTokens: 12, outputTokens: 30 } });
    const contentBytes = Buffer.byteLength(rawOutput + 'alternate'), reasoningBytes = Buffer.byteLength(reasoning + alias + 'other');
    expect(JSON.parse(logs.mock.calls[0]![0])).toMatchObject({ sseFrames: 5, contentBytes, reasoningBytes,
      responseBytes: Buffer.byteLength(stream), otherBytes: Buffer.byteLength(stream) - contentBytes - reasoningBytes, finishReason: 'stop', usage: metered });
    expect(JSON.stringify(logs.mock.calls)).not.toContain('private');
    expect(JSON.stringify(logs.mock.calls)).not.toContain('中🙂');
  });

  it.each(['idle', 'overall', 'eof', 'invalid'] as const)('retains diagnostics and usage on a partial %s stream', async kind => {
    vi.useFakeTimers();
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const metered = { ...usage, completion_tokens_details: { reasoning_tokens: 20 } };
    const prefix = ': heartbeat\n\n' + event({ choices: [{ index: 0, delta: { reasoning_content: 'private reasoning', reasoning: '🙂' }, finish_reason: null }] })
      + event(chunk('{"secret":"private text"}', 'stop')) + event({ choices: [], usage: metered });
    const stream = prefix + (kind === 'invalid' ? 'data: {bad JSON}\n\n' : 'data: unfinished');
    const fetch = vi.fn(async () => kind === 'eof' || kind === 'invalid' ? response(stream, true) : stalledResponse(stream));
    vi.stubGlobal('fetch', fetch);
    const result = expect(adapter({ midstreamRetries: 0, idleTimeoutMs: 100, streamOverallTimeoutMs: kind === 'overall' ? 50 : 1000 })
      .complete({ system: 's', input: {}, idempotencyKey: 'stable' })).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    await vi.advanceTimersByTimeAsync(105); await result;
    const contentBytes = Buffer.byteLength('{"secret":"private text"}'), reasoningBytes = Buffer.byteLength('private reasoning🙂');
    expect(JSON.parse(logs.mock.calls[0]![0])).toMatchObject({ sseFrames: kind === 'invalid' ? 5 : 4,
      contentBytes, reasoningBytes, otherBytes: Buffer.byteLength(stream) - contentBytes - reasoningBytes,
      finishReason: 'stop', usage: metered, usageUnknown: true, willRetry: false,
      retryDecision: kind === 'overall' ? 'overall-timeout' : kind === 'idle' ? 'attempts-exhausted' : 'not-retryable' });
    expect(JSON.stringify(logs.mock.calls)).not.toContain('private');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([': heartbeat\n\n', 'data: unfinished', event(chunk('{"abandoned":'))])('replays an idle stall once with the same body and a distinct key: %s', async partial => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {}), logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValueOnce(stalledResponse(partial))
      .mockResolvedValueOnce(response(event(chunk('{"ok":true}', 'stop')) + event({ choices: [], usage }) + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetch);
    const onMidstreamRetry = vi.fn();
    const done = expect(adapter({ idleTimeoutMs: 100, maxAttempts: 1 }).complete({ system: 's', input: {}, idempotencyKey: 'stable', onMidstreamRetry }))
      .resolves.toEqual({ value: { ok: true } }); // Final usage cannot stand in for both billable attempts.
    await vi.advanceTimersByTimeAsync(105); await done;
    expect(fetch.mock.calls.map(([, options]) => options.headers['idempotency-key'])).toEqual(['stable', 'stable:midstream-1']);
    expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body);
    expect(onMidstreamRetry).toHaveBeenCalledWith({ midstreamRetries: 1, responseBytes: Buffer.byteLength(partial) });
    expect(JSON.parse(errors.mock.calls[0]![0])).toMatchObject({ retryable: true, willRetry: true, retryDecision: 'midstream-retry',
      billingRisk: 'duplicate-possible', responseBytes: Buffer.byteLength(partial), usageUnknown: true });
    expect(JSON.parse(logs.mock.calls[0]![0])).toMatchObject({ usage, usageUnknown: true, billingRisk: 'duplicate-possible', midstreamRetries: 1 });
  });

  it.each([0, 1, 2, 3])('bounds midstream replay independently of normal transport attempts (limit=%s)', async limit => {
    vi.useFakeTimers(); const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => stalledResponse(event({ choices: [{ index: 0, delta: { reasoning: 'thinking' }, finish_reason: null }] })));
    vi.stubGlobal('fetch', fetch);
    const done = expect(adapter({ ...modelTransportConfig({ AEEIS_MODEL_MIDSTREAM_RETRIES: String(limit) }), idleTimeoutMs: 100, maxAttempts: 1, retryBaseMs: 0 })
      .complete({ system: 's', input: {}, idempotencyKey: 'stable' })).rejects.toThrow('idle timeout');
    await vi.advanceTimersByTimeAsync(100 * (limit + 1) + 5); await done;
    expect(fetch).toHaveBeenCalledTimes(limit + 1);
    expect(fetch.mock.calls.map(([, options]) => options.headers['idempotency-key'])).toEqual(['stable', ...Array.from({ length: limit }, (_, i) => `stable:midstream-${i + 1}`)]);
    expect(JSON.parse(logs.mock.calls.at(-1)![0])).toMatchObject({ retryable: true, willRetry: false, retryDecision: 'attempts-exhausted', midstreamRetries: limit });
  });

  it('refuses midstream replay once the call wall-clock budget is exhausted and keeps duplicate-possible billingRisk', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => stalledResponse(': heartbeat\n\n'));
    vi.stubGlobal('fetch', fetch);
    const done = expect(adapter({
      idleTimeoutMs: 100, firstByteTimeoutMs: 80, callBudgetMs: 150, streamOverallTimeoutMs: 10_000,
      midstreamRetries: 3, maxAttempts: 1, retryBaseMs: 0,
    }).complete({ system: 's', input: {}, idempotencyKey: 'stable' })).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    await vi.advanceTimersByTimeAsync(120); await done;
    expect(fetch).toHaveBeenCalledTimes(1);
    const last = JSON.parse(errors.mock.calls.at(-1)![0]);
    expect(last).toMatchObject({
      willRetry: false, retryDecision: 'call-budget-exhausted',
      billingRisk: 'duplicate-possible', usageUnknown: true, responseBytes: expect.any(Number),
    });
  });

  it.each(['no-key', 'overall', 'network', 'json', 'http-error'] as const)('does not replay a partial %s outcome', async kind => {
    vi.useFakeTimers(); const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => kind === 'network' ? new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(event(chunk('{')))); setTimeout(() => c.error(new TypeError('reset')), 10);
    } }), { headers: { 'content-type': 'text/event-stream' } })
      : kind === 'json' || kind === 'http-error' ? new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }), { status: kind === 'http-error' ? 503 : 200 })
      : stalledResponse(': heartbeat\n\n'));
    vi.stubGlobal('fetch', fetch);
    const done = expect(adapter({ idleTimeoutMs: 100, streamOverallTimeoutMs: kind === 'overall' ? 50 : 1000 })
      .complete({ system: 's', input: {}, ...(kind === 'no-key' ? {} : { idempotencyKey: 'stable' }) })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(kind === 'json' || kind === 'http-error' ? 1005 : 105); await done;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.mock.calls[0]![0])).toMatchObject({ willRetry: false,
      retryDecision: kind === 'no-key' ? 'no-idempotency-key' : ['overall', 'json', 'http-error'].includes(kind) ? 'overall-timeout' : 'body-bytes-received' });
  });

  it('uses the current replay key for subsequent zero-byte retries and keeps the replay bound across length retries', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValueOnce(stalledResponse(': heartbeat\n\n'))
      .mockRejectedValueOnce(new TypeError('reset'))
      .mockResolvedValueOnce(response(event(chunk('{}', 'length')) + event({ choices: [], usage }) + 'data: [DONE]\n\n'))
      .mockResolvedValueOnce(stalledResponse(': heartbeat\n\n'));
    vi.stubGlobal('fetch', fetch);
    const beforeRetry = vi.fn();
    const done = expect(adapter({ idleTimeoutMs: 100 }).complete({ system: 's', input: {}, idempotencyKey: 'stable', beforeRetry })).rejects.toThrow('idle timeout');
    await vi.advanceTimersByTimeAsync(205); await done;
    expect(fetch.mock.calls.map(([, options]) => options.headers['idempotency-key'])).toEqual(['stable', 'stable:midstream-1', 'stable:midstream-1', 'stable:length-retry:midstream-1']);
    expect(beforeRetry).toHaveBeenCalledWith(undefined);
  });

  it('withholds a final HTTP rejection meter after an unknown partial attempt', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValueOnce(stalledResponse(': heartbeat\n\n')).mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    const done = expect(adapter({ idleTimeoutMs: 100 }).complete({ system: 's', input: {}, idempotencyKey: 'stable' })).rejects.toMatchObject({ usage: undefined });
    await vi.advanceTimersByTimeAsync(105); await done;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([-1, 4, 1.5, NaN])('rejects an invalid midstream retry limit (%s)', limit => {
    expect(() => adapter({ midstreamRetries: limit })).toThrow();
  });

  it.each([
    ['https://ark.cn-beijing.volces.com/api/v3', undefined],
    ['https://ark.ap-southeast.volcengineapi.com/api/v3', undefined],
    ['https://gateway.example/v1', 'ark'],
  ])('defaults ARK thinking to disabled and freezes it (%s)', async (endpoint, provider) => {
    const fetch = vi.fn(async () => response(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n')); vi.stubGlobal('fetch', fetch);
    const model = new HttpModelAdapter(endpoint!, 'ark-model', '', provider);
    expect(model.requestDefaults()).toMatchObject({ thinking: 'disabled', reasoningEffort: null });
    await model.complete({ system: 's', input: {} });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ thinking: { type: 'disabled' } });
  });

  it.each(['https://other.example/v1', 'https://evilvolces.com/v1', 'https://volces.com.other.example/v1', 'https://ark.ap-southeast.bytepluses.com/api/v3'])('keeps unset thinking omitted for %s', async endpoint => {
    const fetch = vi.fn(async () => response(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n')); vi.stubGlobal('fetch', fetch);
    const model = new HttpModelAdapter(endpoint, 'model', '');
    expect(model.requestDefaults()).toMatchObject({ thinking: null, reasoningEffort: null });
    await model.complete({ system: 's', input: {} });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).not.toHaveProperty('thinking');
  });

  it('immediately downgrades ARK HTTP 400 once, records it and remembers the omitted controls', async () => {
    vi.useFakeTimers(); const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{"error":{"code":"UnsupportedParameter"}}', { status: 400 }))
      .mockImplementation(async () => response(event(chunk('{}', 'stop')) + event({ choices: [], usage }) + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetch);
    const model = adapter({ maxAttempts: 1, retryBaseMs: 5000, thinking: 'enabled', reasoningEffort: 'high' });
    const onThinkingUnsupported = vi.fn(), request = { system: 's', input: {}, thinking: 'enabled' as const, reasoningEffort: 'high' as const, idempotencyKey: 'stable', onThinkingUnsupported };
    const frozen = JSON.stringify(request);
    await expect(model.complete(request)).resolves.toMatchObject({ usage: { inputTokens: 12, outputTokens: 30 } });
    expect(JSON.stringify(request)).toBe(frozen);
    expect(onThinkingUnsupported).toHaveBeenCalledWith({ reason: 'http-400' });
    expect(model.requestDefaults()).toMatchObject({ thinking: null, reasoningEffort: null });
    await model.complete({ ...model.requestDefaults(), system: 's', input: {}, idempotencyKey: 'next' });
    expect(fetch).toHaveBeenCalledTimes(3);
    const bodies = fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    for (const body of bodies.slice(1)) { expect(body).not.toHaveProperty('thinking'); expect(body).not.toHaveProperty('reasoning_effort'); }
    expect(bodies[1]).toEqual(bodies[2]);
    expect(fetch.mock.calls.map(([, options]) => options.headers['idempotency-key'])).toEqual(['stable', 'stable:thinking-unsupported', 'next']);
    expect(JSON.parse(errors.mock.calls[0]![0])).toMatchObject({ status: 400, retryable: true, willRetry: true, retryDecision: 'thinking-unsupported', thinkingUnsupported: true, retryDelayMs: 0 });
  });

  it('records a cached downgrade for an older frozen request before dispatch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
      .mockImplementation(async () => response(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n')); vi.stubGlobal('fetch', fetch);
    const model = adapter(); await model.complete({ system: 's', input: {} });
    const onThinkingUnsupported = vi.fn(async () => { expect(fetch).toHaveBeenCalledTimes(2); });
    await model.complete({ system: 's', input: {}, thinking: 'disabled', idempotencyKey: 'frozen', onThinkingUnsupported });
    expect(onThinkingUnsupported).toHaveBeenCalledWith({ reason: 'adapter-cache' });
    expect(fetch.mock.calls[2]![1].headers['idempotency-key']).toBe('frozen:thinking-unsupported');
  });

  it('downgrades reasoning_effort alone without requiring an idempotency key', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
      .mockResolvedValueOnce(response(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n')); vi.stubGlobal('fetch', fetch);
    await adapter({ thinking: 'provider-default', reasoningEffort: 'low' }).complete({ system: 's', input: {} });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toHaveProperty('reasoning_effort', 'low');
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).not.toHaveProperty('reasoning_effort');
  });

  it.each(['provider-default', 'frozen-omission', 'non-ark', 'downgraded', 'error-body-timeout'] as const)('does not downgrade a %s 400', async kind => {
    vi.useFakeTimers(); const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => kind === 'error-body-timeout' ? new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }), { status: 400 }) : new Response('invalid', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const model = kind === 'non-ark' ? new HttpModelAdapter('https://other.example', 'model', '', undefined, 180000, undefined, false, undefined, { reasoningEffort: 'high' })
      : adapter({ idleTimeoutMs: 50, ...(kind === 'provider-default' ? { thinking: 'provider-default' } : {}) });
    const done = expect(model.complete({ system: 's', input: {}, ...(kind === 'frozen-omission' ? { thinking: null, reasoningEffort: null } : {}), ...(kind === 'downgraded' ? { thinkingUnsupported: true } : {}) })).rejects.toThrow('HTTP 400');
    await vi.advanceTimersByTimeAsync(kind === 'error-body-timeout' ? 180005 : 55); await done;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errors.mock.calls[0]![0])).toMatchObject({ willRetry: false, retryDecision: kind === 'error-body-timeout' ? 'overall-timeout' : 'not-retryable' });
  });

  it('never downgrades a rejected request more than once', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response('invalid', { status: 400 })); vi.stubGlobal('fetch', fetch);
    await expect(adapter({ maxAttempts: 10 }).complete({ system: 's', input: {} })).rejects.toThrow('HTTP 400');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(errors.mock.calls[1]![0])).toMatchObject({ willRetry: false, retryDecision: 'not-retryable', thinkingUnsupported: true });
  });

  it.each(['thinking', 'midstream'] as const)('does not replay when %s history cannot be persisted', async kind => {
    vi.useFakeTimers(); const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => kind === 'thinking' ? new Response('unsupported', { status: 400 }) : stalledResponse(': heartbeat\n\n')); vi.stubGlobal('fetch', fetch);
    const record = vi.fn(async () => { throw new Error('repository unavailable'); });
    const done = expect(adapter({ idleTimeoutMs: 100 }).complete({ system: 's', input: {}, idempotencyKey: 'stable', onThinkingUnsupported: record, onMidstreamRetry: record })).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    await vi.advanceTimersByTimeAsync(105); await done;
    expect(record).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errors.mock.calls[0]![0])).toMatchObject({ willRetry: false, retryDecision: 'retry-recording-failed' });
  });
  it.each([false, true])('retries a first-byte timeout by default before/after headers (headers: %s)', async headers => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn().mockImplementationOnce((_url, options) => headers
      ? Promise.resolve(new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }))
      : new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })))
      .mockResolvedValue(response(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetch);
    const result = expect(adapter({ firstByteTimeoutMs: 100, idleTimeoutMs: 20 }).complete({ system: 's', input: {}, idempotencyKey: 'same-key' })).resolves.toEqual({ value: {} });
    await vi.advanceTimersByTimeAsync(105); await result;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![1].body).toBe(fetch.mock.calls[0]![1].body);
    expect(fetch.mock.calls.map(([, options]) => options.headers['idempotency-key'])).toEqual(['same-key', 'same-key']);
  });

  it('does not reset the first-byte deadline at headers or zero-length chunks', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(() => new Promise<Response>(resolve => setTimeout(() => resolve(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array()); } }), { headers: { 'content-type': 'text/event-stream' } })), 80)));
    vi.stubGlobal('fetch', fetch);
    const result = expect(adapter({ firstByteTimeoutMs: 100, idleTimeoutMs: 20, maxAttempts: 1 }).complete({ system: 's', input: {}, idempotencyKey: 'same' })).rejects.toThrow('100ms (first-byte timeout)');
    await vi.advanceTimersByTimeAsync(101); await result;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('starts idle timing only at the first body byte and records timing without content', async () => {
    vi.useFakeTimers();
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    let body!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => setTimeout(() => resolve(new Response(new ReadableStream({ start(c) { body = c; } }), { headers: { 'content-type': 'text/event-stream' } })), 40))));
    const result = adapter({ firstByteTimeoutMs: 100, idleTimeoutMs: 20 }).complete({ system: 'private-system', input: { secret: 'private-input' } });
    await vi.advanceTimersByTimeAsync(80);
    body.enqueue(new TextEncoder().encode(': keepalive\n\n'));
    await vi.advanceTimersByTimeAsync(15);
    body.enqueue(new TextEncoder().encode(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n')); body.close();
    await expect(result).resolves.toEqual({ value: {} });
    expect(JSON.parse(logs.mock.calls[0]![0])).toMatchObject({ protocol: 'aeeis-model-completion/1', headersMs: 40, firstByteMs: 80, elapsedMs: 95 });
    expect(JSON.stringify(logs.mock.calls)).not.toContain('private-');
  });

  it('does not count zero-length chunks as activity after the first byte', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn(async () => new Response(new ReadableStream({ start(c) { body = c; c.enqueue(new TextEncoder().encode(':')); } }), { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const result = expect(adapter({ idleTimeoutMs: 100, firstByteTimeoutMs: 10, midstreamRetries: 0 }).complete({ system: 's', input: {}, idempotencyKey: 'stable' })).rejects.toThrow('100ms (idle timeout)');
    for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(30); body.enqueue(new Uint8Array()); }
    await vi.advanceTimersByTimeAsync(11); await result; expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['enabled', 'disabled', 'auto'] as const)('sends thinking=%s only when configured', async thinking => {
    const fetch = vi.fn(async () => response(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n')); vi.stubGlobal('fetch', fetch);
    await adapter(modelTransportConfig({ AEEIS_MODEL_THINKING: thinking })).complete({ system: 's', input: {} });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toMatchObject({ thinking: { type: thinking } });
  });

  it.each(['minimal', 'low', 'medium', 'high'] as const)('sends reasoning_effort=%s only when configured', async effort => {
    const fetch = vi.fn(async () => response(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n')); vi.stubGlobal('fetch', fetch);
    await adapter(modelTransportConfig({ AEEIS_MODEL_REASONING_EFFORT: effort })).complete({ system: 's', input: {} });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toHaveProperty('reasoning_effort', effort);
  });

  it('omits provider-default wire controls and respects frozen explicit omissions', async () => {
    const fetch = vi.fn(async () => response(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n')); vi.stubGlobal('fetch', fetch);
    await adapter(modelTransportConfig({ AEEIS_MODEL_THINKING: 'provider-default' })).complete({ system: 's', input: {} });
    await adapter({ thinking: 'enabled', reasoningEffort: 'high' }).complete({ system: 's', input: {}, thinking: null, reasoningEffort: null });
    for (const [, options] of fetch.mock.calls) {
      const body = JSON.parse(options.body as string);
      expect(body).not.toHaveProperty('thinking'); expect(body).not.toHaveProperty('reasoning_effort');
    }
  });

  it('uses the env output allowance and doubles it on a completed length retry', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(event(chunk('', 'length')) + 'data: [DONE]\n\n'))
      .mockResolvedValueOnce(response(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n')); vi.stubGlobal('fetch', fetch);
    await adapter(modelTransportConfig({ AEEIS_MODEL_MAX_TOKENS: '4096' })).complete({ system: 's', input: {}, idempotencyKey: 'stable' });
    expect(fetch.mock.calls.map(([, options]) => JSON.parse(options.body).max_tokens)).toEqual([4096, 8192]);
  });

  it.each([false, true])('allows zero-byte first-byte replay with the identical key (enabled: %s)', async enabled => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn().mockImplementationOnce(async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValue(response(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetch);
    const completion = adapter({ retryEmptyIdle: enabled, firstByteTimeoutMs: 100 }).complete({ system: 's', input: {}, idempotencyKey: 'durable-call-key' });
    const assertion = enabled ? expect(completion).resolves.toEqual({ value: {} }) : expect(completion).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    await vi.advanceTimersByTimeAsync(105);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(enabled ? 2 : 1);
    if (enabled) {
      expect(fetch.mock.calls[0]![1].headers['idempotency-key']).toBe('durable-call-key');
      expect(fetch.mock.calls[1]![1].body).toBe(fetch.mock.calls[0]![1].body);
      expect(fetch.mock.calls[1]![1].headers['idempotency-key']).toBe('durable-call-key');
    }
  });

  it('exhausts the configured first-byte attempts and never retries without a key', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const result = expect(adapter({ firstByteTimeoutMs: 100, maxAttempts: 10 }).complete({ system: 's', input: {}, idempotencyKey: 'stable' })).rejects.toThrow('first-byte timeout');
    await vi.advanceTimersByTimeAsync(1010); await result;
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(new Set(fetch.mock.calls.map(([, options]: any) => options.headers['idempotency-key']))).toEqual(new Set(['stable']));
    expect(new Set(fetch.mock.calls.map(([, options]: any) => options.body)).size).toBe(1);
    fetch.mockClear();
    const noKey = expect(adapter({ firstByteTimeoutMs: 100 }).complete({ system: 's', input: {} })).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    await vi.advanceTimersByTimeAsync(105); await noKey;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([': keepalive\n\n', event({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }] }), 'd'])('leaves an idle timeout unknown when midstream replay is disabled: %s', async bytes => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(bytes)); } }), { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const result = expect(adapter({ retryEmptyIdle: true, idleTimeoutMs: 100, midstreamRetries: 0 }).complete({ system: 's', input: {}, idempotencyKey: 'stable' })).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    await vi.advanceTimersByTimeAsync(105); await result;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry an empty overall timeout', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const result = expect(adapter({ retryEmptyIdle: true, idleTimeoutMs: 1000, streamOverallTimeoutMs: 100 }).complete({ system: 's', input: {}, idempotencyKey: 'stable' })).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    await vi.advanceTimersByTimeAsync(105); await result;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['https://ark.cn-beijing.volces.com/api/v3', 'https://ark.ap-southeast.bytepluses.com/api/v3'])('auto-enables streaming for the ARK endpoint %s', async endpoint => {
    const fetch = vi.fn(async () => response(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n')); vi.stubGlobal('fetch', fetch);
    await new HttpModelAdapter(endpoint, 'ark-model', '').complete({ system: 's', input: {} });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string).stream).toBe(true);
  });
  it('parses split UTF-8, CRLF/multiline data, reasoning deltas and final usage-only frames', async () => {
    const multiline = 'data: {"choices":\r\ndata: [{"index":0,"delta":{"content":"{\\\"text\\\":\\\""},"finish_reason":null}]}\r\n\r\n';
    const stream = ': heartbeat\r\n\r\n' + event({ choices: [{ index: 0, delta: { reasoning_content: 'untrusted reasoning' }, finish_reason: null }] }, '\r\n') + multiline
      + event(chunk('中文🙂"}', 'stop'), '\r\n') + event({ choices: [], usage }, '\r\n') + 'data: [DONE]\r\n\r\n';
    const fetch = vi.fn(async () => response(stream, true)); vi.stubGlobal('fetch', fetch);
    await expect(adapter().complete({ system: 's', input: {}, idempotencyKey: 'stream-key', includeRawOutput: true })).resolves.toEqual({ value: { text: '中文🙂' }, rawOutput: '{"text":"中文🙂"}', usage: { inputTokens: 12, outputTokens: 30 } });
    const options = fetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(options.body as string)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect((options.headers as Record<string, string>)['idempotency-key']).toBe('stream-key');
  });

  it.each([
    ['LF', '\n', false], ['LF', '\n', true],
    ['CRLF', '\r\n', false], ['CRLF', '\r\n', true],
    ['CR', '\r', false], ['CR', '\r', true],
  ] as const)('parses %s multiline events and usage (separator: %j, one-byte chunks: %s)', async (_name, separator, byteChunks) => {
    const multiline = `data: {"choices":${separator}data: [{"index":0,"delta":{"content":"{\\"text\\":\\""},"finish_reason":null}]}${separator}${separator}`;
    const stream = `: heartbeat${separator}event: completion${separator}${separator}` + multiline
      + event(chunk('中文🙂"}', 'stop'), separator) + event({ choices: [], usage }, separator) + `data: [DONE]${separator}${separator}`;
    const fetch = vi.fn(async () => response(stream, byteChunks)); vi.stubGlobal('fetch', fetch);
    await expect(adapter().complete({ system: 's', input: {}, includeRawOutput: true })).resolves.toEqual({
      value: { text: '中文🙂' }, rawOutput: '{"text":"中文🙂"}', usage: { inputTokens: 12, outputTokens: 30 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('handles mixed line endings without dispatching a split CRLF as a blank line', async () => {
    const stream = ': heartbeat\r\n\r' + 'event: completion\n'
      + 'data: {"choices":\r\ndata: [{"index":0,"delta":{"content":"{}"},"finish_reason":"stop"}]}\r\n\r\n'
      + event({ choices: [], usage }, '\r') + 'data: [DONE]\n\r';
    vi.stubGlobal('fetch', vi.fn(async () => response(stream, true)));
    await expect(adapter().complete({ system: 's', input: {} })).resolves.toEqual({ value: {}, usage: { inputTokens: 12, outputTokens: 30 } });
  });

  it('keeps length retries, metering, finish_reason and idempotency keys consistent with JSON transport', async () => {
    const replies = [response(event(chunk('{"partial":', 'length')) + event({ choices: [], usage }) + 'data: [DONE]\n\n'),
      response(event(chunk('{"ok":true}', 'stop')) + event({ choices: [], usage }) + 'data: [DONE]\n\n')];
    const fetch = vi.fn(async () => replies.shift()!); vi.stubGlobal('fetch', fetch);
    const beforeRetry = vi.fn();
    await expect(adapter().complete({ system: 's', input: {}, idempotencyKey: 'key', beforeRetry })).resolves.toEqual({ value: { ok: true }, usage: { inputTokens: 24, outputTokens: 60 } });
    expect(beforeRetry).toHaveBeenCalledWith({ inputTokens: 12, outputTokens: 30 });
    expect(fetch.mock.calls.map(([, options]: any) => options.headers['idempotency-key'])).toEqual(['key', 'key:length-retry']);
    expect(fetch.mock.calls.map(([, options]: any) => JSON.parse(options.body).max_tokens)).toEqual([16384, 32768]);
  });

  it.each(['content_filter', 'tool_calls', null])('retains billable usage for non-stop finish_reason %s', async reason => {
    const fetch = vi.fn(async () => response(event(chunk('private output', reason)) + event({ choices: [], usage }) + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetch);
    await expect(adapter().complete({ system: 's', input: {} })).rejects.toMatchObject({ usage: { inputTokens: 12, outputTokens: 30 }, rawOutput: 'private output' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps absent streaming usage absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n')));
    await expect(adapter().complete({ system: 's', input: {} })).resolves.toEqual({ value: {} });
  });

  it.each([false, 997])('accepts long streams with repeated metadata and reasoning (byte chunks: %s)', async byteChunks => {
    const text = 'x'.repeat(8000);
    const metadata = { id: 'chatcmpl-long-completion', object: 'chat.completion.chunk', created: 1780000000, model: 'ark-model', system_fingerprint: 'fp_fixture' };
    const stream = event({ ...metadata, choices: [{ index: 0, delta: { reasoning_content: 'thinking '.repeat(1000) }, finish_reason: null }] }).repeat(150)
      + Array.from(JSON.stringify(text), character => event({ ...metadata, ...chunk(character) })).join('')
      + event(chunk('', 'stop')) + event({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 9000 } }) + 'data: [DONE]\n\n';
    expect(Buffer.byteLength(stream)).toBeGreaterThan(1_400_000);
    const fetch = vi.fn(async () => response(stream, byteChunks)); vi.stubGlobal('fetch', fetch);
    await expect(adapter().complete({ system: 's', input: {}, includeRawOutput: true })).resolves.toEqual({ value: text, rawOutput: JSON.stringify(text), usage: { inputTokens: 12, outputTokens: 9000 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('excludes 6000 short reasoning frames and heartbeats from retained output limits', async () => {
    const metadata = { id: 'chatcmpl-reasoning', object: 'chat.completion.chunk', created: 1780000000, model: 'ark-model' };
    const reasoning = event({ ...metadata, choices: [{ index: 0, delta: { reasoning_content: 'plan' }, finish_reason: null }] });
    const stream = (': heartbeat\n\n' + reasoning).repeat(6000)
      + event(chunk('{"ok":true}', 'stop')) + event({ choices: [], usage }) + 'data: [DONE]\n\n';
    expect(Buffer.byteLength(stream)).toBeGreaterThan(1_000_000);
    const fetch = vi.fn(async () => response(stream, 997)); vi.stubGlobal('fetch', fetch);
    await expect(adapter().complete({ system: 's', input: {} })).resolves.toEqual({ value: { ok: true }, usage: { inputTokens: 12, outputTokens: 30 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['complete frame', 'unfinished frame', 'accumulated content'])('bounds %s independently of total wire bytes', async kind => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stream = kind === 'accumulated content' ? event(chunk('🙂'.repeat(75_000))).repeat(4)
      : 'data: ' + 'x'.repeat(1_000_001) + (kind === 'complete frame' ? '\n\n' : '');
    const fetch = vi.fn(async () => response(stream, kind === 'complete frame' ? false : 16384)); vi.stubGlobal('fetch', fetch);
    await expect(adapter().complete({ system: 's', input: {} })).rejects.toThrow(/size limit/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([event(chunk('{"ok":true}', 'stop')), 'data: {bad JSON}\n\n', 'data: {"error":{"message":"Bearer secret"}}\n\n', 'data: [DONE]\n\n'])('leaves incomplete/malformed streams unknown without a transport retry', async stream => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => response(stream)); vi.stubGlobal('fetch', fetch);
    await expect(adapter().complete({ system: 's', input: {} })).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs.mock.calls)).not.toContain('secret');
  });

  it.each(['idle', 'overall'])('bounds a stream with the %s deadline and preserves unknown outcomes', async kind => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn(async () => new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(event(chunk('')))); } }), { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const result = expect(adapter({ idleTimeoutMs: 100, streamOverallTimeoutMs: kind === 'overall' ? 250 : 1000 }).complete({ system: 's', input: {} })).rejects.toThrow(kind + ' timeout');
    await vi.advanceTimersByTimeAsync(0);
    if (kind === 'overall') for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(75); controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
    }
    await vi.advanceTimersByTimeAsync(kind === 'overall' ? 25 : 100);
    await result; expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('allows active streams to run beyond the legacy non-streaming deadline', async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-type': 'text/event-stream' } })));
    const result = new HttpModelAdapter('https://example.com', 'fixture', '', undefined, 100, undefined, false, undefined, { stream: true, idleTimeoutMs: 100, streamOverallTimeoutMs: 500 }).complete({ system: 's', input: {} });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(75); controller.enqueue(new TextEncoder().encode(event({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }] }))); }
    controller.enqueue(new TextEncoder().encode(event(chunk('{}', 'stop')) + event({ choices: [], usage }) + 'data: [DONE]\n\n')); controller.close();
    await expect(result).resolves.toMatchObject({ value: {}, usage: { inputTokens: 12, outputTokens: 30 } });
  });

  it.each([': keepalive\n\n', event({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }] })])('counts SSE activity before content and uses the Ark 240s default', async heartbeat => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_url, options) => {
      expect(JSON.parse(options.body)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
      return new Response(new ReadableStream({ start(controller) {
        const send = (text: string) => controller.enqueue(new TextEncoder().encode(text));
        setTimeout(() => send(heartbeat), 217_000);
        setTimeout(() => send(heartbeat), 350_000);
        setTimeout(() => { send(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n'); controller.close(); }, 480_000);
      } }), { headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetch);
    const completion = adapter(modelTransportConfig({})).complete({ system: 's', input: {} });
    await vi.advanceTimersByTimeAsync(480_001);
    await expect(completion).resolves.toMatchObject({ value: {} });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit Ark first-byte environment override', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => stalledResponse('')));
    const completion = expect(adapter({ ...modelTransportConfig({ AEEIS_MODEL_FIRST_BYTE_TIMEOUT_MS: '120000' }), maxAttempts: 1 })
      .complete({ system: 's', input: {} })).rejects.toThrow('120000ms (first-byte timeout)');
    await vi.advanceTimersByTimeAsync(120_001);
    await completion;
  });

  it('allows disabling streaming for ARK and enabling it for other providers, with JSON response fallback', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }))); vi.stubGlobal('fetch', fetch);
    await adapter({ stream: false }).complete({ system: 's', input: {} });
    await new HttpModelAdapter('https://example.com', 'fixture', '', undefined, 1000, undefined, false, undefined, modelTransportConfig({ AEEIS_MODEL_STREAM: '1' })).complete({ system: 's', input: {} });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string).stream).toBeUndefined();
    expect(JSON.parse(fetch.mock.calls[1]![1].body as string).stream).toBe(true);
    expect(modelTransportConfig({ AEEIS_MODEL_TIMEOUT_MS: '200000' })).toMatchObject({ idleTimeoutMs: 180000, streamOverallTimeoutMs: 900000, callBudgetMs: 600000, retryEmptyIdle: true, midstreamRetries: 1, maxTokens: 16384 });
  });
});
