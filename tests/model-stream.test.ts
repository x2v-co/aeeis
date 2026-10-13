import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpModelAdapter, ModelOutcomeUnknown, modelTransportConfig } from '../src/runtime/model.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
const chunk = (content: string, reason: string | null = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason: reason }], usage: null });
const usage = { prompt_tokens: 12, completion_tokens: 30 };
const event = (value: unknown, separator = '\n') => `data: ${JSON.stringify(value)}${separator}${separator}`;
function response(text: string, byteChunks = false) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    if (byteChunks) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
const adapter = (options = {}) => new HttpModelAdapter('https://ark.cn-beijing.volces.com/api/v3', 'ark-model', 'secret', undefined, 180_000, undefined, false, undefined, { retryBaseMs: 0, ...options });

describe('OpenAI-compatible SSE transport', () => {
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
    expect(modelTransportConfig({ AEEIS_MODEL_TIMEOUT_MS: '200000' })).toMatchObject({ idleTimeoutMs: 200000, streamOverallTimeoutMs: 600000 });
  });
});
