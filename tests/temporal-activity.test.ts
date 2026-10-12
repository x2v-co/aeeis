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
});
