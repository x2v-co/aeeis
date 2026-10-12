import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { AgentEngine } from '../src/runtime/engine.js';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository, PostgresRunRepository } from '../src/runtime/repository.js';
import { activeShare, hashShareToken, InMemoryRunShareStore, newRunShare, runSharesMigration, shareTtlConfig } from '../src/runtime/run-shares.js';
import { capDebugField, debugBundle, MAX_DEBUG_FIELD_BYTES, redactRunData } from '../src/runtime/run-debug.js';
import { ModelResponseRejected, type ModelAdapter } from '../src/runtime/model.js';
import { isolatedPostgres } from './support/postgres.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const close of cleanup.splice(0).reverse()) await close(); });
const plan = { summary: 'Investigate', nodes: [{ id: 'investigate', title: 'Investigate failure', instruction: 'Read evidence', dependsOn: [] }] };
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test/1' };
const model: ModelAdapter = { pin, complete: async () => ({ value: plan }) };
async function setup(adapter = model) {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-share-'));
  const repo = new FileRunRepository(directory); await repo.init();
  cleanup.push(async () => { await repo.close(); await rm(directory, { recursive: true, force: true }); });
  const engine = new AgentEngine(repo, adapter);
  const run = await engine.create({ goal: 'Investigate failure' }, 'alice', 'team-a');
  const other = await engine.create({ goal: 'OTHER RUN PRIVATE CONTENT' }, 'bob', 'team-b');
  const app = buildApp({ repository: repo, engine, principalTokens: {
    alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
    bob: { id: 'bob', tenantId: 'team-b', roles: ['owner'] },
  } });
  cleanup.push(() => app.close());
  const auth = { authorization: 'Bearer alice' };
  return { app, repo, engine, directory, run, other, auth };
}

describe('run sharing HTTP boundary', () => {
  it('serves deep links, requires owner auth to manage shares, and stores only hashes durably', async () => {
    const { app, run, other, auth, directory, repo } = await setup();
    expect((await app.inject({ url: `/runs/${run.id}` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/runs/${run.id}` })).body).toContain('copy-run-link');
    expect((await app.inject({ url: `/runs/${run.id}`, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/runs/${run.id}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/runs/${run.id}/share` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/runs/${other.id}/share`, headers: auth })).statusCode).toBe(404);
    const response = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/share`, headers: auth });
    expect(response.statusCode).toBe(200);
    const share = response.json();
    expect(Buffer.from(share.token, 'base64url')).toHaveLength(32);
    expect(share.url).toBe(`/share/${share.token}`);
    expect(Date.parse(share.expiresAt) - Date.now()).toBeGreaterThan(7 * 86400000 - 10000);
    const disk = await readFile(join(directory, '.run-shares.json'), 'utf8');
    expect(disk).not.toContain(share.token);
    expect(JSON.parse(disk)[0]).toMatchObject({ tokenHash: hashShareToken(share.token), runId: run.id, revokedAt: null });
    // A new adapter instance reads the same durable capabilities.
    const { FileRunShareStore } = await import('../src/runtime/run-shares.js');
    expect(activeShare(await new FileRunShareStore(directory).find(hashShareToken(share.token)))).toBe(true);
    const list = await app.inject({ url: `/api/runs/${run.id}/shares`, headers: auth });
    expect(list.json()).toEqual([expect.objectContaining({ id: share.id, runId: run.id })]);
    expect(list.body).not.toContain(share.token);
    expect(list.body).not.toContain('tokenHash');
    expect((await repo.shares.list(other.id))).toEqual([]);
  });

  it('limits a share to one run, never authenticates mutations, and revokes both JSON and HTML', async () => {
    const { app, run, other, auth } = await setup();
    const share = (await app.inject({ method: 'POST', url: `/api/runs/${run.id}/share`, headers: auth, payload: {} })).json();
    const view = await app.inject({ url: `/api/share/${share.token}` });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ id: run.id, graphs: {}, explanation: {} });
    expect(view.body).not.toContain(other.id);
    expect(view.body).not.toContain('OTHER RUN PRIVATE CONTENT');
    expect((await app.inject({ url: share.url })).statusCode).toBe(200);
    expect((await app.inject({ url: share.url, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })).statusCode).toBe(200);
    expect((await app.inject({ url: share.url, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/share/${share.token}`, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/runs/${other.id}`, headers: { authorization: `Bearer ${share.token}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel`, headers: { authorization: `Bearer ${share.token}` }, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/share/${share.token}`, payload: { action: 'cancel' } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/share/${share.token}/runs/${other.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/runs/${other.id}/share/${share.id}`, headers: { authorization: 'Bearer bob' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/runs/${run.id}/share/${share.id}`, headers: auth })).statusCode).toBe(204);
    for (const url of [share.url, `/api/share/${share.token}`, `/api/share/${share.token}/debug-bundle`]) expect((await app.inject({ url })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/runs/${run.id}/shares`, headers: auth })).json()[0].revokedAt).toEqual(expect.any(String));
  });

  it('enforces expiry, bounded TTL configuration and invalid token handling', async () => {
    vi.stubEnv('AEEIS_SHARE_MAX_TTL_SECONDS', '60'); vi.stubEnv('AEEIS_SHARE_TTL_SECONDS', '30');
    const { app, run, auth } = await setup();
    for (const ttlSeconds of [0, -1, 61, 1.5, '10']) expect((await app.inject({ method: 'POST', url: `/api/runs/${run.id}/share`, headers: auth, payload: { ttlSeconds } })).statusCode).toBe(400);
    const share = (await app.inject({ method: 'POST', url: `/api/runs/${run.id}/share`, headers: auth, payload: { ttlSeconds: 1 } })).json();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(share.expiresAt));
    for (const url of [share.url, `/api/share/${share.token}`, `/api/share/${share.token}/debug-bundle`]) expect((await app.inject({ url })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/share/invalid' })).statusCode).toBe(404);
    expect(shareTtlConfig()).toEqual({ defaultSeconds: 30, maxSeconds: 60 });
    vi.stubEnv('AEEIS_SHARE_TTL_SECONDS', 'invalid'); expect(shareTtlConfig).toThrow('AEEIS_SHARE_TTL_SECONDS');
  });

  it('redacts and caps shared JSON and both debug bundle routes', async () => {
    vi.stubEnv('AEEIS_GIT_COMMIT', 'test-commit');
    const { app, run, auth, repo, other } = await setup();
    await repo.mutate(run.id, current => {
      current.context.sources.push({ id: 'source_1', title: 'Evidence', source: 'local', hash: 'hash', content: 'x'.repeat(20000) });
      current.artifacts.push({ id: 'artifact_1', taskId: 'investigate', title: 'Failure', content: 'Bearer bearer-secret api_key=api-secret sk-123456789abcdef', evidenceRefs: ['source_1'], hash: 'hash', createdAt: current.createdAt });
      current.modelDecision = { apiKey: 'copied-secret', env: { CUSTOM: 'hidden-environment' }, nested: { password: 'db-secret', note: 'copied-secret hidden-environment db-secret' } };
      current.events.push({ id: 'event_1', seq: 1, type: 'run.failed', at: current.createdAt, data: { secret: 'event-secret', rawOutput: '{"authorization":"embedded-secret","env":{"CUSTOM":"nested-env"},"answer":"safe"}', validation: { issues: [{ path: '$', code: 'invalid', message: 'invalid output' }] } } });
    });
    const share = (await app.inject({ method: 'POST', url: `/api/runs/${run.id}/share`, headers: auth })).json();
    for (const url of [`/api/share/${share.token}`, `/api/share/${share.token}/debug-bundle`, `/api/runs/${run.id}/debug-bundle`]) {
      const response = await app.inject({ url, ...(url.startsWith('/api/runs') ? { headers: auth } : {}) });
      expect(response.statusCode).toBe(200);
      for (const secret of ['copied-secret', 'hidden-environment', 'db-secret', 'event-secret', 'embedded-secret', 'nested-env', 'bearer-secret', 'api-secret', 'sk-123456789abcdef', other.id]) expect(response.body).not.toContain(secret);
      const value = response.json().run ?? response.json();
      expect(Buffer.byteLength(value.context.sources[0].content)).toBeLessThanOrEqual(MAX_DEBUG_FIELD_BYTES);
      expect(value.context.sources[0].content).toContain('[truncated]');
      expect(value.modelDecision.nested).not.toHaveProperty('password');
      expect(response.headers['cache-control']).toBe('no-store');
      if (url.endsWith('debug-bundle')) expect(response.json()).toMatchObject({ appVersion: '0.1.0', gitCommit: 'test-commit', run: { id: run.id }, plans: [], taskAttempts: [], events: expect.any(Array) });
    }
    expect((await app.inject({ url: `/api/runs/${run.id}/debug-bundle` })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/runs/${other.id}/debug-bundle`, headers: auth })).statusCode).toBe(404);
  });
});

describe('durable model failure diagnostics', () => {
  it('persists planning schema errors, raw output and bundle diagnostics across restart', async () => {
    const bad: ModelAdapter = { pin, complete: async () => ({ value: { summary: 'Invalid plan', apiKey: 'planning-secret', extra: 'a'.repeat(20000) }, rawOutput: '{"summary":"Invalid plan","apiKey":"planning-secret"}' }) };
    const { engine, run, repo, directory } = await setup(bad);
    // The first invalid plan schedules one durable repair attempt.
    let status = await engine.advance(run.id);
    for (let i = 0; i < 3 && status !== 'failed'; i++) status = await engine.advance(run.id);
    expect(status).toBe('failed');
    const persisted = JSON.parse(await readFile(join(directory, `${run.id}.json`), 'utf8'));
    expect(persisted.calls[0].validationErrors).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'nodes' })]));
    expect(persisted.calls[0].rawOutput).toContain('Invalid plan');
    expect(persisted.calls[0].rawOutput).not.toContain('planning-secret');
    expect(persisted.events.find((e: any) => e.type === 'run.failed').data).toHaveProperty('rawOutput');
    await repo.close(); await repo.init();
    expect(debugBundle(await repo.get(run.id)).validationErrors).toHaveLength(2);
  });
  it('records invalid JSON provider output and validation errors', async () => {
    const bad: ModelAdapter = { pin, complete: async () => { throw new ModelResponseRejected('Model response did not contain valid JSON', { inputTokens: 1, outputTokens: 2 }, 'Not JSON api_key=provider-secret'); } };
    const { engine, run, repo } = await setup(bad);
    expect(await engine.advance(run.id)).toBe('failed');
    const call = (await repo.get(run.id)).calls[0]!;
    expect(call.rawOutput).toContain('Not JSON'); expect(call.rawOutput).not.toContain('provider-secret');
    expect(call.validationErrors?.[0]?.message).toContain('valid JSON');
  });
  it('records missing structured finish data on repair and final failure', async () => {
    const bad: ModelAdapter = { pin, complete: async request => ({ value: request.system.includes('Plan a real deliverable') ? plan : { type: 'finish', title: 'Pulse', content: 'No structured data api_key=finish-secret', evidenceRefs: [], artifactType: 'project-pulse/1' } }) };
    const { engine, repo } = await setup(bad);
    const run = await engine.create({ goal: 'Project Pulse', builtinSkill: 'project-pulse/1' }, 'alice', 'team-a');
    await engine.advance(run.id);
    await engine.command(run.id, 'approve', { planHash: (await repo.get(run.id)).plans[0]!.hash });
    expect(await engine.advance(run.id)).toBe('running');
    const repairing = await repo.get(run.id);
    expect(repairing.calls.at(-1)?.validationErrors?.[0]?.message).toContain('finish.structured');
    expect(repairing.events.find(e => e.type === 'model.validation_failed')?.data.rawOutput).toContain('No structured data');
    expect(await engine.advance(run.id)).toBe('failed');
    const failed = await repo.get(run.id);
    expect(failed.steps[0]?.failureReason).toContain('repair failed');
    const bundle = debugBundle(failed);
    expect(bundle.graphs.execution.nodes.find(node => node.type === 'step')).toMatchObject({ status: 'failed', metadata: { failureReason: expect.stringContaining('repair failed') } });
    expect(bundle.modelRawOutput).toHaveLength(3);
    expect(bundle.validationErrors).toHaveLength(2);
    expect(JSON.stringify(bundle)).not.toContain('finish-secret');
  });
});

describe('share storage and redaction helpers', () => {
  it('keeps in-memory capabilities isolated and revokes idempotently', async () => {
    const store = new InMemoryRunShareStore(); const { token, share } = newRunShare('run_one', 60);
    await store.create(share); share.revokedAt = 'changed';
    expect(activeShare(await store.find(hashShareToken(token)))).toBe(true);
    expect(await store.list('run_other')).toEqual([]);
    expect(await store.revoke('run_other', share.id, new Date().toISOString())).toBe(false);
    expect(await store.revoke('run_one', share.id, new Date().toISOString())).toBe(true);
    expect(activeShare(await store.find(hashShareToken(token)))).toBe(false);
    expect(JSON.stringify(await store.list('run_one'))).not.toContain(token);
  });
  it('scrubs free-text credentials and nested JSON without losing usage counters', () => {
    const result = redactRunData({ usage: { inputTokens: 2, outputTokens: 3 }, ACCESS_TOKEN: 'hidden-value', environment: { CUSTOM: 'env-value' }, note: 'hidden-value env-value Bearer abcdefgh ?token=query-secret https://user:pass@example.com', blob: '{"api_key":"json-secret","ok":true}', text: 'a'.repeat(20000) });
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
    for (const secret of ['hidden-value', 'env-value', 'abcdefgh', 'query-secret', 'user:pass', 'json-secret']) expect(JSON.stringify(result)).not.toContain(secret);
    expect(Buffer.byteLength(capDebugField('😀'.repeat(9000)))).toBeLessThanOrEqual(MAX_DEBUG_FIELD_BYTES);
  });
  it('scrubs short credentials, private keys and fenced or incomplete JSON environment data', () => {
    const result = redactRunData({ password: 'pin', note: 'password was pin',
      output: '```json\n{"env":{"CUSTOM":"fenced-secret"},"note":"fenced-secret"}\n```',
      incomplete: '{"env":{"CUSTOM":"partial-secret"},"answer":',
      text: 'private_key=private-value API key: key-value',
    });
    for (const secret of ['pin', 'fenced-secret', 'partial-secret', 'private-value', 'key-value']) expect(JSON.stringify(result)).not.toContain(secret);
    let deep: unknown = { apiKey: 'deep-secret' };
    for (let i = 0; i < 100; i++) deep = { nested: deep };
    expect(JSON.stringify(redactRunData(deep))).not.toContain('deep-secret');
  });
  it('ships the SQL migration used by locked adapter bootstrap', async () => {
    expect((await readFile(new URL('../src/adapters/migrations/001-run-shares.sql', import.meta.url), 'utf8')).trim()).toBe(runSharesMigration);
  });
  it.skipIf(!process.env.AEEIS_TEST_DATABASE_URL)('persists hashed shares and revocation across Postgres instances', async () => {
    const db = await isolatedPostgres(process.env.AEEIS_TEST_DATABASE_URL!);
    const repo = new PostgresRunRepository(db.url), second = new PostgresRunRepository(db.url), pool = new pg.Pool({ connectionString: db.url });
    try {
      await Promise.all([repo.init(), second.init()]);
      const run = await new AgentEngine(repo, model).create({ goal: 'Share Postgres' });
      const { token, share } = newRunShare(run.id, 60); await repo.shares.create(share);
      expect(activeShare(await second.shares.find(hashShareToken(token)))).toBe(true);
      expect(JSON.stringify((await pool.query('SELECT * FROM aeeis_run_shares')).rows)).not.toContain(token);
      expect(await second.shares.revoke(run.id, share.id, new Date().toISOString())).toBe(true);
      expect(activeShare(await repo.shares.find(hashShareToken(token)))).toBe(false);
    } finally { await pool.end(); await repo.close(); await second.close(); await db.close(); }
  });
});

describe('debug redaction hardening', () => {
  it('scrubs cookies, auth headers, capability URLs, tk_ tokens and nested env blocks', () => {
    const share = 'b'.repeat(43);
    const text = [
      'Cookie: sid=COOKIESECRET1', 'Set-Cookie: s=SETCOOKIESECRET', 'X-Auth-Token: XAUTHSECRET',
      `see https://aeeis.example/share/${share} and /api/share/${share}/debug-bundle`,
      'https://bucket.example/o?X-Amz-Signature=AMZSIG123&sig=SIGSECRET&code=OAUTHCODE',
      'tool token tk_live_ABCDEFGHIJKL',
      '{"env": {"A": {"B": "x"}, "LEAK": "NESTEDENVSECRET"} trailing',
    ].join('\n');
    const out = JSON.stringify(redactRunData({ rawOutput: text, headers: { cookie: 'HDRCOOKIE', 'x-auth': 'HDRXAUTH' } }));
    for (const secret of ['COOKIESECRET1', 'SETCOOKIESECRET', 'XAUTHSECRET', share, 'AMZSIG123', 'SIGSECRET', 'OAUTHCODE', 'tk_live_ABCDEFGHIJKL', 'NESTEDENVSECRET', 'HDRCOOKIE', 'HDRXAUTH'])
      expect(out).not.toContain(secret);
    expect(out).toContain('trailing');
  });
  it('bounds arrays so a share holder cannot force unbounded export work', () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({ i, text: `item ${i}` }));
    const out = redactRunData({ events: items }) as { events: unknown[] };
    expect(out.events.length).toBe(501);
    expect(out.events[0]).toContain('4500 earlier items truncated');
    expect(out.events.at(-1)).toMatchObject({ i: 4999 });
  });
});
