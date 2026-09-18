import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createAdvanceRunActivity } from '../src/temporal/activity.js';

describe('Temporal AEEIS activity contract', () => {
  it('returns the bounded run status envelope', async () => {
    const server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ status: 'running' })); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind');
    try { await expect(createAdvanceRunActivity({ api: `http://127.0.0.1:${address.port}`, token: 'test' })('run-1')).resolves.toEqual({ status: 'running' }); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('marks auth and protocol errors as non-retryable Temporal failures', async () => {
    const server = createServer((_request, response) => { response.statusCode = 401; response.end('unauthorized'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind');
    try {
      await expect(createAdvanceRunActivity({ api: `http://127.0.0.1:${address.port}`, token: 'test' })('run-2')).rejects.toMatchObject({ type: 'AeeisPermanentError', nonRetryable: true });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('keeps overload responses retryable for Temporal activity policy', async () => {
    const server = createServer((_request, response) => { response.statusCode = 503; response.end('busy'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind');
    try { await expect(createAdvanceRunActivity({ api: `http://127.0.0.1:${address.port}`, token: 'test' })('run-3')).rejects.toThrow('retryable HTTP 503'); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
