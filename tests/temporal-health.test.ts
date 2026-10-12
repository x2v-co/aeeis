import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { Server, IncomingMessage } from 'node:http';
import { closeWorkerHealthServer, startWorkerHealthServer } from '../src/temporal/health.js';
import { checkWorkerHealth } from '../src/runtime/dispatcher.js';

const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

function worker(state: string) { return { getState: () => state } as never; }
async function request(port: number, path: string): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path }, (response: IncomingMessage) => {
      let body = ''; response.on('data', (chunk: Buffer) => body += chunk); response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }));
    });
    req.on('error', reject); req.end();
  });
}

describe('Temporal worker health surface', () => {
  const production = { AEEIS_ENV: 'production', AEEIS_TRUSTED_INTERNAL_HOSTS: 'api,worker' };

  it('probes trusted worker HTTP with redirects disabled in production', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await expect(checkWorkerHealth('http://worker:4324/readyz', 100, production)).resolves.toMatchObject({ ready: true });
    expect(fetch).toHaveBeenCalledWith('http://worker:4324/readyz', expect.objectContaining({ redirect: 'error' }));
  });

  it.each(['http://unlisted:4324/readyz', 'http://worker.example:4324/readyz', 'http://10.0.0.2:4324/readyz', 'http://worker:4324/readyz?token=secret', 'ftp://worker:4324/readyz'])('rejects unsafe worker health before fetching %s', endpoint => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    return checkWorkerHealth(endpoint, 100, production).then(result => {
      expect(result.ready).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('distinguishes process liveness from worker readiness', async () => {
    const server = await startWorkerHealthServer(worker('INITIALIZED'), { host: '127.0.0.1', port: 0, taskQueue: 'aeeis-test', buildId: 'test-build' });
    servers.push(server);
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('health server did not bind');
    expect((await request(address.port, '/health')).status).toBe(200);
    expect((await request(address.port, '/readyz')).status).toBe(503);
    expect((await request(address.port, '/readyz')).body).toMatchObject({ status: 'not_ready', workerState: 'INITIALIZED', buildId: 'test-build' });
    await closeWorkerHealthServer(server);
    servers.splice(servers.indexOf(server), 1);
  });

  it('reports running workers as ready and rejects unknown routes', async () => {
    const server = await startWorkerHealthServer(worker('RUNNING'), { host: '127.0.0.1', port: 0, taskQueue: 'aeeis-test', buildId: 'test-build' });
    servers.push(server);
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('health server did not bind');
    expect((await request(address.port, '/readyz')).body).toMatchObject({ protocol: 'aeeis-worker-readiness/1', status: 'ready', taskQueue: 'aeeis-test' });
    expect((await request(address.port, '/missing')).status).toBe(404);
  });

  it('lets the API distinguish a reachable worker from a stopped worker', async () => {
    const server = await startWorkerHealthServer(worker('RUNNING'), { host: '127.0.0.1', port: 0, taskQueue: 'aeeis-test', buildId: 'test-build' });
    servers.push(server);
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('health server did not bind');
    await expect(checkWorkerHealth(`http://127.0.0.1:${address.port}/readyz`)).resolves.toEqual({ ready: true, detail: 'Temporal Worker ready' });
    await closeWorkerHealthServer(server);
    servers.splice(servers.indexOf(server), 1);
    await expect(checkWorkerHealth(`http://127.0.0.1:${address.port}/readyz`, 100)).resolves.toMatchObject({ ready: false, detail: expect.stringContaining('unreachable') });
  });
});
