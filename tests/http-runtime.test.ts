import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { FileBrainStore } from '../src/brain.js';

describe('AEEIS HTTP boundary', () => {
  it('does not pretend to execute when no model is configured', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-')));
    await repo.init();
    const app = buildApp({ repository: repo });
    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { goal: 'Do real work' } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain('Configure');
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json()).toMatchObject({ modelConfigured: false });
    expect((await app.inject({ method: 'POST', url: '/api/runs/run_bad/finish', payload: {} })).statusCode).toBe(503);
    await app.close(); await repo.close();
  });
  it('requires the configured bearer token and rejects cross-origin requests', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-auth-')));
    await repo.init();
    const app = buildApp({ repository: repo, token: 'local-secret' });
    expect((await app.inject({ method: 'GET', url: '/api/runs' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/runs', headers: { authorization: 'Bearer local-secret', origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/runs', headers: { authorization: 'Bearer local-secret' } })).statusCode).toBe(200);
    await app.close(); await repo.close();
  });

  it('exposes owner Brain operations through the local API and persists them', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-brain-runs-'))); await repo.init();
    const brainStore = new FileBrainStore(await mkdtemp(join(tmpdir(), 'aeeis-http-brain-'))); await brainStore.init();
    const brain = await brainStore.load(); const app = buildApp({ repository: repo, brain, brainStore });
    const created = await app.inject({ method: 'POST', url: '/api/brain/claims', payload: { owner: 'owner', scope: 'project', scopeRef: 'p1', classification: 'internal', kind: 'decision', content: 'Use durable execution', sourceRefs: ['src1'], confidence: 1 } });
    expect(created.statusCode).toBe(200);
    const listed = await app.inject({ method: 'GET', url: '/api/brain/p1?classification=internal' });
    expect(listed.json().claims).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: '/api/brain/p1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/brain/p1?classification=internal' })).json().claims).toHaveLength(0);
    await app.close(); await brainStore.close(); await repo.close();
  });
});
