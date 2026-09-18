import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';

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
});
