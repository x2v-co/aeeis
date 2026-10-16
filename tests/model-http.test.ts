import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { HttpModelAdapter, ModelOutcomeUnknown, ModelResponseRejected } from '../src/runtime/model.js';

const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

function sequence(replies: Array<{ reason: string | null; content?: string; usage?: { prompt_tokens: number; completion_tokens: number } }>) {
  const fetch = vi.fn(async () => {
    const reply = replies.shift()!;
    return new Response(JSON.stringify({ choices: [{ message: { content: reply.content ?? '{"ok":true}' }, finish_reason: reply.reason }], ...(reply.usage ? { usage: reply.usage } : {}) }));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function fixture(body: unknown, status = 200): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body));
    });
    servers.push(server); server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
  });
}

describe('HttpModelAdapter', () => {
  it.each(['errorCode', 'error', 'sse'] as const)('ark-200-errorCode: retries %s with backoff and billing-risk diagnostics', async shape => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const completions = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const failure = shape === 'error' ? { error: { code: 'ProviderBusy', message: 'try again' } } : { errorCode: 'ProviderBusy', message: 'try again' };
      const fetch = vi.fn().mockResolvedValueOnce(new Response(shape === 'sse' ? `data: ${JSON.stringify(failure)}\n\n` : JSON.stringify(failure), { headers: { 'content-type': shape === 'sse' ? 'text/event-stream' : 'application/json' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] })));
      vi.stubGlobal('fetch', fetch);
      const adapter = new HttpModelAdapter('https://ark.cn-beijing.volces.com/api/v3', 'fixture', '', undefined, 1000, undefined, false, undefined, { retryBaseMs: 1, retryMaxMs: 2 });
      expect((await adapter.complete({ system: 's', input: {}, idempotencyKey: 'ark-200' })).value).toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]![1].headers['idempotency-key']).toBe(fetch.mock.calls[1]![1].headers['idempotency-key']);
      expect(JSON.parse(logs.mock.calls[0]![0])).toMatchObject({ status: 200, errorCode: 'ProviderBusy', retryable: true, willRetry: true, retryDecision: 'provider-error-retry', usageUnknown: true, billingRisk: 'duplicate-possible' });
      expect(JSON.parse(completions.mock.calls[0]![0])).toMatchObject({ usageUnknown: true, billingRisk: 'duplicate-possible', transportAttempt: 2 });
    } finally { logs.mockRestore(); completions.mockRestore(); }
  });
  it.each(['no-key', 'disabled', 'exhausted', 'partial-stream'])('ark-200-errorCode: respects %s replay fence', async mode => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const error = { errorCode: 'Error' };
      const partial = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] })}\n\n`;
      const fetch = vi.fn(async () => new Response(mode === 'partial-stream' ? `${partial}data: ${JSON.stringify(error)}\n\n` : JSON.stringify(error), { headers: { 'content-type': mode === 'partial-stream' ? 'text/event-stream' : 'application/json' } }));
      vi.stubGlobal('fetch', fetch);
      const adapter = new HttpModelAdapter('https://ark.cn-beijing.volces.com/api/v3', 'fixture', '', undefined, 1000, undefined, false, undefined, { retryBaseMs: 0, maxAttempts: 2 });
      await expect(adapter.complete({ system: 's', input: {}, ...(mode === 'no-key' ? {} : { idempotencyKey: 'ark-200' }), disableRetries: mode === 'disabled' })).rejects.toBeInstanceOf(ModelOutcomeUnknown);
      expect(fetch).toHaveBeenCalledTimes(mode === 'exhausted' ? 2 : 1);
      expect(JSON.parse(logs.mock.calls.at(-1)![0])).toMatchObject({ status: 200, retryable: true, willRetry: false, billingRisk: 'duplicate-possible' });
    } finally { logs.mockRestore(); }
  });

  it('never doubles the token allowance or retries a length-limited repair', async () => {
    const fetch = sequence([{ reason: 'length', content: '{"partial":' }]);
    const adapter = new HttpModelAdapter('https://example.com', 'fixture', '');
    await expect(adapter.complete({ system: 'repair', input: {}, maxTokens: 4096, disableRetries: true })).rejects.toThrow('incomplete');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1].body).max_tokens).toBe(4096);
  });
  it.each([false, true])('caps repair response bytes before a stream can hang (stream=%s)', async stream => {
    const content = 'x'.repeat(651 * 1024);
    const body = stream ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n` : JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); }, cancel } ), { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } });
    const fetch = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetch);
    const adapter = new HttpModelAdapter('https://example.com', 'fixture', '', undefined, 1000, undefined, false, undefined, { stream, retryBaseMs: 0 });
    await expect(adapter.complete({ system: 'repair', input: {}, idempotencyKey: 'repair-cap', maxResponseBytes: 65536, disableRetries: true })).rejects.toBeInstanceOf(ModelResponseRejected);
    expect(fetch).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([500, 502, 503])('does not replay HTTP %s after any body bytes, retaining structured diagnostics', async status => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'ProviderBusy', message: 'Bearer secret' } }), { status, headers: { 'x-request-id': 'ark-request-1' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] })));
      vi.stubGlobal('fetch', fetch);
      const adapter = new HttpModelAdapter('https://ark.cn-beijing.volces.com/api/v3', 'ark-model', 'secret', undefined, 1000, undefined, false, undefined, { retryBaseMs: 0 });
      await expect(adapter.complete({ system: 's', input: {}, idempotencyKey: 'ark-key' })).rejects.toThrow(`HTTP ${status}`);
      expect(fetch).toHaveBeenCalledTimes(1);
      const log = JSON.parse(logs.mock.calls[0]![0]);
      expect(log).toMatchObject({ status, requestId: 'ark-request-1', attempt: 1, errorCode: 'ProviderBusy', willRetry: false });
      expect(log.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(log.bodyExcerpt).not.toContain('secret');
    } finally { logs.mockRestore(); }
  });

  it.each([401, 403, 404, 408, 422])('does not retry ARK HTTP %s', async status => {
    const fetch = vi.fn(async () => new Response('invalid request', { status }));
    vi.stubGlobal('fetch', fetch);
    const adapter = new HttpModelAdapter('https://ark.cn-beijing.volces.com/api/v3', 'ark-model', 'secret');
    await expect(adapter.complete({ system: 's', input: {} })).rejects.toThrow(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a known 401 when its error body times out', async () => {
    let requests = 0;
    const port = await new Promise<string>(resolve => {
      const server = createServer((_request, response) => { requests++; response.statusCode = 401; response.flushHeaders(); });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
    });
    await expect(new HttpModelAdapter(`http://127.0.0.1:${port}`, 'model', '', 'ark', 40)
      .complete({ system: 's', input: {} })).rejects.toThrow('HTTP 401');
    expect(requests).toBe(1);
  });

  it('retries network failures, caps attempts and preserves unknown outcomes on exhaustion', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) }); });
    vi.stubGlobal('fetch', fetch);
    const adapter = new HttpModelAdapter('https://ark.cn-beijing.volces.com/api/v3', 'ark-model', '', undefined, 1000, undefined, false, undefined, { retryBaseMs: 0 });
    await expect(adapter.complete({ system: 's', input: {} })).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])('leaves first-byte timeouts unknown without a durable key (headers=%s)', async headersSent => {
    let requests = 0;
    const port = await new Promise<string>(resolve => {
      const server = createServer((_request, response) => {
        requests++;
        if (headersSent) response.flushHeaders();
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
    });
    const adapter = new HttpModelAdapter(`http://127.0.0.1:${port}`, 'model', '', 'ark', 40, undefined, false, undefined, { retryBaseMs: 0, firstByteTimeoutMs: 40 });
    await expect(adapter.complete({ system: 's', input: {} })).rejects.toThrow('timed out after 40ms');
    expect(requests).toBe(1);
  });

  it('uses capped exponential backoff with jitter between retries', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetch = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    try {
      const adapter = new HttpModelAdapter('https://ark.cn-beijing.volces.com/api/v3', 'model', '', undefined, 1000, undefined, false, undefined, { maxAttempts: 4, retryBaseMs: 100, retryMaxMs: 150 });
      const done = expect(adapter.complete({ system: 's', input: {} })).rejects.toBeInstanceOf(ModelOutcomeUnknown);
      await vi.advanceTimersByTimeAsync(49); expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(74); expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(75); expect(fetch).toHaveBeenCalledTimes(4);
      await done;
    } finally { random.mockRestore(); vi.useRealTimers(); }
  });

  it.each([
    { pin: {}, call: {}, expected: 16384 },
    { pin: { maxTokens: 8192 }, call: {}, expected: 8192 },
    { pin: { maxTokens: 8192 }, call: { maxTokens: 24000 }, expected: 24000 },
    { pin: {}, call: { maxTokens: 65536 }, expected: 65536 },
    { pin: { maxOutputTokens: 4096 }, call: {}, expected: 4096 },
    { pin: { maxOutputTokens: 20000 }, call: { maxTokens: 24000 }, expected: 20000 },
  ])('uses the configured output allowance: %j', async ({ pin, call, expected }) => {
    const fetch = sequence([{ reason: 'stop' }]);
    const adapter = new HttpModelAdapter('https://example.com', 'fixture', '', undefined, 60000, undefined, false, pin);
    await adapter.complete({ system: 's', input: {}, ...call });
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).max_tokens).toBe(expected);
  });

  it('retries length once with a capped doubled allowance and sums both meters', async () => {
    const fetch = sequence([
      { reason: 'length', content: '{"partial":', usage: { prompt_tokens: 10, completion_tokens: 20 } },
      { reason: 'stop', usage: { prompt_tokens: 12, completion_tokens: 30 } },
    ]);
    const beforeRetry = vi.fn();
    const adapter = new HttpModelAdapter('https://example.com', 'fixture', '', undefined, 60000, undefined, false, { maxOutputTokens: 24000 });
    await expect(adapter.complete({ system: 's', input: { x: 1 }, idempotencyKey: 'call-1', beforeRetry })).resolves.toEqual({ value: { ok: true }, usage: { inputTokens: 22, outputTokens: 50 } });
    expect(beforeRetry).toHaveBeenCalledTimes(1);
    expect(beforeRetry).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 20 });
    const attempts = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(attempts.map(([, options]) => JSON.parse(options.body as string).max_tokens)).toEqual([16384, 24000]);
    expect(attempts.map(([, options]) => (options.headers as Record<string, string>)['idempotency-key'])).toEqual(['call-1', 'call-1:length-retry']);
    expect(attempts.map(([, options]) => JSON.parse(options.body as string).messages)).toEqual([
      [{ role: 'system', content: 's' }, { role: 'user', content: '{"x":1}' }],
      [{ role: 'system', content: 's' }, { role: 'user', content: '{"x":1}' }],
    ]);
  });

  it.each(['length', 'content_filter', 'tool_calls', null, 'invalid-json'])('rejects an unusable retry and retains summed usage: %s', async reason => {
    const fetch = sequence([
      { reason: 'length', usage: { prompt_tokens: 10, completion_tokens: 20 } },
      { reason: reason === 'invalid-json' ? 'stop' : reason, content: 'not-json', usage: { prompt_tokens: 12, completion_tokens: 30 } },
    ]);
    const result = new HttpModelAdapter('https://example.com', 'fixture', '').complete({ system: 's', input: {} });
    await expect(result).rejects.toBeInstanceOf(ModelResponseRejected);
    await expect(result).rejects.toMatchObject({ rawOutput: 'not-json', usage: { inputTokens: 22, outputTokens: 50 } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).max_tokens).toBe(32768);
  });

  it.each(['content_filter', 'tool_calls', null])('does not retry another non-stop reason: %s', async reason => {
    const fetch = sequence([{ reason, usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
    await expect(new HttpModelAdapter('https://example.com', 'fixture', '').complete({ system: 's', input: {} })).rejects.toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the retry within the provider output cap even when it is already reached', async () => {
    const fetch = sequence([
      { reason: 'length', usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { reason: 'length', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    const adapter = new HttpModelAdapter('https://example.com', 'fixture', '', undefined, 60000, undefined, false, { maxOutputTokens: 8000 });
    await expect(adapter.complete({ system: 's', input: {} })).rejects.toMatchObject({ usage: { inputTokens: 20, outputTokens: 10 } });
    const attempts = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(attempts.map(([, options]) => JSON.parse(options.body as string).max_tokens)).toEqual([8000, 8000]);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid token limits before any request: %s', async maxTokens => {
    const fetch = sequence([]);
    expect(() => new HttpModelAdapter('https://example.com', 'fixture', '', undefined, 60000, undefined, false, { maxTokens })).toThrow();
    expect(() => new HttpModelAdapter('https://example.com', 'fixture', '', undefined, 60000, undefined, false, { maxOutputTokens: maxTokens })).toThrow();
    await expect(new HttpModelAdapter('https://example.com', 'fixture', '').complete({ system: 's', input: {}, maxTokens })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([0, 1])('keeps aggregate usage missing when attempt %s omits its meter', async missing => {
    const fetch = sequence([0, 1].map(index => ({ reason: index === 0 ? 'length' : 'stop', ...(index === missing ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5 } }) })));
    await expect(new HttpModelAdapter('https://example.com', 'fixture', '').complete({ system: 's', input: {} })).resolves.toEqual({ value: { ok: true } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries length even when all tokens were spent before any content was produced', async () => {
    const fetch = sequence([
      { reason: 'length', content: '', usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 8 } },
    ]);
    await expect(new HttpModelAdapter('https://example.com', 'fixture', '').complete({ system: 's', input: {} })).resolves.toEqual({ value: { ok: true }, usage: { inputTokens: 20, outputTokens: 13 } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves first-attempt spend when the retry is refused with HTTP 400', async () => {
    const fetch = sequence([{ reason: 'length', usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })));
    fetch.mockResolvedValueOnce(new Response('private provider error', { status: 400 }));
    const result = new HttpModelAdapter('https://example.com', 'fixture', '').complete({ system: 's', input: {} });
    await expect(result).rejects.toMatchObject({ message: 'Model provider returned HTTP 400', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('leaves an interrupted retry unknown and makes no further requests', async () => {
    const fetch = sequence([{ reason: 'length', usage: { prompt_tokens: 10, completion_tokens: 5 } }]);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })));
    fetch.mockRejectedValueOnce(new Error('private transport error'));
    await expect(new HttpModelAdapter('https://example.com', 'fixture', '').complete({ system: 's', input: {} })).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('identifies timeout before or after headers (headers sent: %s) without retrying', async headersSent => {
    let requests = 0;
    const port = await new Promise<string>(resolve => {
      const server = createServer((_request, response) => {
        requests++;
        if (headersSent) { response.setHeader('content-type', 'application/json'); response.flushHeaders(); }
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
    });
    const result = new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', 'secret', undefined, 100)
      .complete({ system: 's', input: {}, idempotencyKey: 'timeout-test' });
    await expect(result).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    await expect(result).rejects.toThrow('timed out after 100ms');
    expect(requests).toBe(1);
  });

  it('accepts a slow response within a longer configured deadline', async () => {
    const port = await new Promise<string>(resolve => {
      const server = createServer((_request, response) => {
        setTimeout(() => response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] })), 150);
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
    });
    await expect(new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', '', undefined, 1000)
      .complete({ system: 's', input: {} })).resolves.toEqual({ value: { ok: true } });
  });

  it.each([
    { content: '{"partial":', finish_reason: 'length' },
    { content: 'not-json', finish_reason: 'stop' },
  ])('preserves billable usage when provider output is unusable: %j', async choice => {
    const port = await fixture({ choices: [{ message: { content: choice.content }, finish_reason: choice.finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const request = new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', '').complete({ system: 's', input: {} });
    await expect(request).rejects.toBeInstanceOf(ModelResponseRejected);
    await expect(request).rejects.toMatchObject({ usage: { inputTokens: choice.finish_reason === 'length' ? 20 : 10, outputTokens: choice.finish_reason === 'length' ? 10 : 5 } });
  });
  it('parses an OpenAI-compatible JSON response and reports usage', async () => {
    const port = await fixture({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5 } });
    const adapter = new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', 'secret');
    await expect(adapter.complete({ system: 's', input: { x: 1 } })).resolves.toEqual({ value: { ok: true }, usage: { inputTokens: 3, outputTokens: 5 } });
  });
  it('preserves provider text when diagnostics are requested and when a length retry is refused', async () => {
    const content = ' { "ok": true } ';
    const fetch = sequence([{ reason: 'stop', content }, { reason: 'length', content: '{"partial":' }]);
    const adapter = new HttpModelAdapter('https://example.com', 'fixture', '');
    await expect(adapter.complete({ system: 's', input: {}, includeRawOutput: true })).resolves.toEqual({ value: { ok: true }, rawOutput: content });
    await expect(adapter.complete({ system: 's', input: {}, beforeRetry: () => { throw new Error('Budget exhausted'); } })).rejects.toMatchObject({ message: 'Budget exhausted', rawOutput: '{"partial":' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects incomplete provider responses and unsafe endpoint URLs', async () => {
    const port = await fixture({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] });
    await expect(new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', '').complete({ system: 's', input: {} })).rejects.toThrow('incomplete');
    expect(() => new HttpModelAdapter('https://example.com?secret=1', 'fixture', '')).toThrow('query');
    expect(() => new HttpModelAdapter('http://example.com', 'fixture', '')).toThrow('HTTPS');
    expect(() => new HttpModelAdapter('http://example.com', 'fixture', '', undefined, 60000, undefined, true)).not.toThrow();
  });

  it('forwards the durable provider idempotency key', async () => {
    let request: IncomingMessage | undefined;
    const port = await new Promise<string>((resolve) => {
      const server = createServer((_request, response) => {
        request = _request;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }));
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
    });
    const adapter = new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', '');
    await adapter.complete({ system: 's', input: {}, idempotencyKey: 'model:run_1:call_1' });
    expect(request?.headers['idempotency-key']).toBe('model:run_1:call_1');
  });

  it('probes a configured provider health endpoint without exposing credentials', async () => {
    const port = await new Promise<string>((resolve) => {
      const server = createServer((request, response) => {
        expect(request.headers.authorization).toBe('Bearer secret');
        response.statusCode = 200; response.end('ok');
      });
      servers.push(server); server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
    });
    const adapter = new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', 'secret', undefined, 2000, `http://127.0.0.1:${port}/health`);
    await expect(adapter.health?.()).resolves.toMatchObject({ ready: true, detail: 'provider health probe passed' });
  });
});
