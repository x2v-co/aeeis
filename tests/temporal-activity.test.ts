import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdvanceRunActivity } from '../src/temporal/activity.js';

afterEach(() => vi.unstubAllGlobals());

describe('Temporal AEEIS activity contract', () => {
  it.each([{ status: 'running' }, { status: 'unknown', progress: 'durable-progress' }])('returns the bounded run status envelope %j', async result => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetch);
    await expect(createAdvanceRunActivity({ api: 'http://127.0.0.1:4323', token: 'test' })('run-1')).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:4323/internal/runs/run-1/advance', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ 'x-aeeis-advance-progress': '1', authorization: 'Bearer test' }),
    }));
  });

  it('marks auth and protocol errors as non-retryable Temporal failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    const advance = createAdvanceRunActivity({ api: 'http://127.0.0.1:4323', token: 'test' });
    await expect(advance('run-2')).rejects.toMatchObject({ type: 'AeeisPermanentError', nonRetryable: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'running', progress: 123 }))));
    await expect(advance('run-2')).rejects.toMatchObject({ type: 'AeeisProtocolError', nonRetryable: true });
  });

  it('keeps overload responses retryable for Temporal activity policy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })));
    await expect(createAdvanceRunActivity({ api: 'http://127.0.0.1:4323', token: 'test' })('run-3')).rejects.toThrow('retryable HTTP 503');
  });

  it('starts once, polls with short requests and heartbeats while a model tick remains active', async () => {
    const heartbeat = vi.fn();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'running', progress: 'started' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'running', progress: 'started' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'reviewing', progress: 'completed' })));
    vi.stubGlobal('fetch', fetch);
    await expect(createAdvanceRunActivity({ api: 'http://localhost', token: 'test', pollIntervalMs: 1, heartbeat })('run')).resolves.toEqual({ status: 'reviewing', progress: 'completed' });
    expect(fetch.mock.calls.map(call => call[1].method)).toEqual(['POST', 'GET', 'GET']);
    expect(fetch.mock.calls[0]![1].headers['x-aeeis-advance-async']).toBe('1');
    expect(fetch.mock.calls[1]![1].body).toBeUndefined();
    expect(heartbeat).toHaveBeenCalledTimes(6);
  });

  it('keeps response body disconnects retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new TypeError('terminated'); } })));
    await expect(createAdvanceRunActivity({ api: 'http://localhost', token: 'test' })('run')).rejects.toThrow('response transport failed');
  });

  it('bounds each HTTP request independently of the long polling activity', async () => {
    const fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    await expect(createAdvanceRunActivity({ api: 'http://localhost', token: 'test', requestTimeoutMs: 10, timeoutMs: 1000 })('run')).rejects.toThrow('activity transport failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
