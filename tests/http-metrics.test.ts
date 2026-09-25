import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter } from '../src/runtime/model.js';

describe('HTTP metrics', () => {
  it('bounds labels, enforces scrape permissions, and exports valid cumulative histograms', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-metrics-'))); await repo.init();
    const app = buildApp({ repository: repo, principalTokens: {
      secret: { id: 'private-operator', tenantId: 'private-tenant', roles: ['operator'] },
      owner: { id: 'owner', tenantId: 'private-tenant', roles: ['owner'] },
    } });
    try {
      expect((await app.inject('/metrics')).statusCode).toBe(401);
      expect((await app.inject({ url: '/metrics', headers: { authorization: 'Bearer owner' } })).statusCode).toBe(403);
      for (const id of ['private-one', 'private-two']) {
        expect((await app.inject(`/api/runs/${id}?token=private-query`)).statusCode).toBe(401);
        expect((await app.inject(`/missing/${id}`)).statusCode).toBe(404);
      }
      const metrics = await app.inject({ url: '/metrics', headers: { authorization: 'Bearer secret', 'x-request-id': 'private-request' } });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.body).not.toContain('private-');
      expect(metrics.body).toContain('aeeis_http_requests_total{method="GET",route="/api/runs/:id",status="401"} 2');
      expect(metrics.body).toContain('aeeis_http_requests_total{method="GET",route="unmatched",status="404"} 2');
      const buckets = metrics.body.split('\n').filter(line => line.startsWith('aeeis_http_request_duration_seconds_bucket{method="GET",route="/api/runs/:id",'));
      const counts = buckets.map(line => Number(line.split(' ').at(-1)));
      expect(counts).toHaveLength(12);
      expect(counts.at(-1)).toBe(2);
      expect(counts.every((count, index) => count >= 0 && count <= 2 && (index === 0 || count >= counts[index - 1]!))).toBe(true);
      expect(metrics.body).toContain('aeeis_http_request_duration_seconds_count{method="GET",route="/api/runs/:id"} 2');
      expect(metrics.body).toContain('aeeis_http_requests_in_flight 1');
    } finally { await app.close(); await repo.close(); }
  });

  it('releases disconnected requests once without counting a later handler result as success', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-metrics-abort-'))); await repo.init();
    const app = buildApp({ repository: repo });
    let entered!: () => void, disconnected!: () => void, release!: () => void, finished!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const disconnectedPromise = new Promise<void>(resolve => { disconnected = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const finishedPromise = new Promise<void>(resolve => { finished = resolve; });
    app.get('/test-held', async (_request, reply) => {
      reply.raw.once('close', disconnected);
      entered();
      await held;
      finished();
      return { ok: true };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind');
    const client = httpRequest(`http://127.0.0.1:${address.port}/test-held`);
    client.on('error', () => {});
    try {
      client.end();
      await enteredPromise;
      expect((await app.inject('/metrics')).body).toContain('aeeis_http_requests_in_flight 2');
      client.destroy();
      await disconnectedPromise;
      release();
      await finishedPromise;
      await new Promise<void>(resolve => setImmediate(resolve));
      const metrics = (await app.inject('/metrics')).body;
      expect(metrics).toContain('aeeis_http_requests_in_flight 1');
      expect(metrics).toContain('aeeis_http_requests_total{method="GET",route="/test-held",status="aborted"} 1');
      expect(metrics).not.toContain('route="/test-held",status="200"');
      expect(metrics).toContain('aeeis_http_request_duration_seconds_count{method="GET",route="/test-held"} 1');
    } finally { client.destroy(); release(); await app.close(); await repo.close(); }
  });

  it('coalesces concurrent readiness probes across health and metrics requests', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-metrics-readiness-'))); await repo.init();
    const fullHistory = vi.spyOn(repo, 'list');
    let healthCalls = 0;
    const model: ModelAdapter = {
      pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat', promptVersion: 'fixture/1' },
      complete: async () => ({ value: {} }),
      health: async () => { healthCalls += 1; await new Promise(resolve => setTimeout(resolve, 30)); return { ready: true, detail: 'fixture ready', checkedAt: new Date().toISOString() }; },
    };
    const app = buildApp({ repository: repo, engine: new AgentEngine(repo, model) });
    try {
      const [ready, metrics] = await Promise.all([
        app.inject('/readyz'),
        app.inject('/metrics'),
      ]);
      expect(ready.statusCode).toBe(503);
      expect(metrics.statusCode).toBe(200);
      expect(healthCalls).toBe(1);
      expect(metrics.body).toContain('aeeis_readiness_check{check="model",required="true"} 1');
      expect(fullHistory).toHaveBeenCalledTimes(1); // metrics collector only; /readyz uses the lightweight repository probe
    } finally { await app.close(); await repo.close(); }
  });
});
