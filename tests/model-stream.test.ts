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

describe('OpenAI-compatible SSE transport', () => {
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
    const result = expect(adapter({ idleTimeoutMs: 100, firstByteTimeoutMs: 10 }).complete({ system: 's', input: {}, idempotencyKey: 'stable' })).rejects.toThrow('100ms (idle timeout)');
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

  it('omits unset wire controls and respects frozen explicit omissions', async () => {
    const fetch = vi.fn(async () => response(event(chunk('{}', 'stop')) + 'data: [DONE]\n\n')); vi.stubGlobal('fetch', fetch);
    await adapter(modelTransportConfig({})).complete({ system: 's', input: {} });
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

  it.each([': keepalive\n\n', event({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }] }), 'd'])('never replays idle timeout after any response bytes: %s', async bytes => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(bytes)); } }), { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const result = expect(adapter({ retryEmptyIdle: true, idleTimeoutMs: 100 }).complete({ system: 's', input: {}, idempotencyKey: 'stable' })).rejects.toBeInstanceOf(ModelOutcomeUnknown);
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

  it('allows disabling streaming for ARK and enabling it for other providers, with JSON response fallback', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }))); vi.stubGlobal('fetch', fetch);
    await adapter({ stream: false }).complete({ system: 's', input: {} });
    await new HttpModelAdapter('https://example.com', 'fixture', '', undefined, 1000, undefined, false, undefined, modelTransportConfig({ AEEIS_MODEL_STREAM: '1' })).complete({ system: 's', input: {} });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string).stream).toBeUndefined();
    expect(JSON.parse(fetch.mock.calls[1]![1].body as string).stream).toBe(true);
    expect(modelTransportConfig({ AEEIS_MODEL_TIMEOUT_MS: '200000' })).toMatchObject({ firstByteTimeoutMs: 120000, idleTimeoutMs: 180000, streamOverallTimeoutMs: 900000, retryEmptyIdle: true, maxTokens: 16384 });
  });
});
