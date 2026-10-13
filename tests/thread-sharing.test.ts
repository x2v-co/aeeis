import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository, PostgresRunRepository } from '../src/runtime/repository.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { activeShare, hashShareToken } from '../src/runtime/run-shares.js';
import { FileThreadShareStore, newThreadShare, sharedThreadView, threadSharesMigration } from '../src/runtime/thread-shares.js';
import { buildThreadHistory } from '../src/runtime/thread-history.js';
import { threadHistorySources } from '../src/runtime/thread-context.js';
import { materialForModel } from '../src/runtime/materials.js';
import { threadRecord, threadRun, threadScope } from './support/thread-contract.js';
import { isolatedPostgres } from './support/postgres.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const close of cleanup.splice(0).reverse()) await close(); });
const auth = { authorization: 'Bearer alice' };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-thread-share-'));
  const repo = new FileRunRepository(directory); await repo.init();
  cleanup.push(async () => { await repo.close(); await rm(directory, { recursive: true, force: true }); });
  const thread = threadRecord(), root = threadRun(); await repo.create(root); await repo.createThread(thread, root.id);
  const app = buildApp({ repository: repo, principalTokens: {
    alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
    bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
    outsider: { id: 'alice', tenantId: 'team-b', roles: ['owner'] },
    reader: { id: 'alice', tenantId: 'team-a', roles: ['operator'] },
  } });
  cleanup.push(() => app.close());
  const share = async (payload: unknown = {}) => app.inject({ method: 'POST', url: `/api/threads/${thread.id}/share`, headers: auth, payload });
  return { repo, app, thread, root, directory, share };
}

describe('thread shares', () => {
  it('omits raw provider text from all public thread runs and bundles, preserving authenticated debug bundles', async () => {
    const { repo, app, thread, root, share } = await setup();
    const child = threadRun(); await repo.createRunInThread(child, thread.id, root.id, threadScope);
    for (const id of [root.id, child.id]) await repo.mutate(id, run => {
      run.calls.push({ id: `model_${id}`, phase: 'executor', taskId: 'task', state: 'completed', inputHash: 'hash', startedAt: run.createdAt, rawOutput: 'PRIVATE_CALL', modelRequest: { system: 'Saved provider prompt', input: { threadHistory: 'PRIVATE_SNAPSHOT_HISTORY', sources: [{ content: 'PRIVATE_SNAPSHOT_SOURCE' }] } } });
      run.plannerRepair = { rawOutput: 'PRIVATE_PLANNER', validationError: 'Schema mismatch' };
      run.steps.push({ taskId: 'task', status: 'running', attempts: 1, observations: [{ tool: 'lookup', argument: 'x', result: [{ raw_output: 'PRIVATE_NESTED', providerResponse: 'PRIVATE_RESPONSE', safe: 'RETAINED_RESULT' },
        `Observation: \`\`\`json\n${JSON.stringify({ rawOutput: 'PRIVATE_FENCED', safe: 'RETAINED_FENCED', padding: 'x'.repeat(10000) })}\n\`\`\``] }], finishRepair: { reason: 'Incomplete finish', candidate: 'PRIVATE_CANDIDATE' } });
      run.events.push({ id: `evt_${id}`, seq: run.events.length + 1, type: 'model.validation_failed', at: run.createdAt, data: { validation: { rawOutput: 'PRIVATE_VALIDATION', issues: [{ rawText: 'PRIVATE_TEXT', message: 'Schema mismatch' }] } } });
    });
    const token = (await share()).json();
    for (const suffix of ['', '/debug-bundle']) {
      const response = await app.inject({ url: `/api/share/${token.token}${suffix}` });
      expect(response.statusCode).toBe(200);
      expect(response.json().runs).toHaveLength(2);
      expect(response.body).not.toContain('PRIVATE_');
      for (const key of ['rawOutput', 'raw_output', 'providerResponse', 'rawText', 'plannerRepair', 'finishRepair', 'modelRequest']) expect(response.body).not.toContain(key);
      expect(response.body).toContain('RETAINED_RESULT');
      expect(response.body).toContain('RETAINED_FENCED');
      expect(response.body).toContain('Schema mismatch');
    }
    const owner = await app.inject({ url: `/api/threads/${thread.id}/debug-bundle`, headers: auth });
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toContain('PRIVATE_CALL');
    expect(owner.body).toContain('PRIVATE_CANDIDATE');
    expect(owner.body).toContain('PRIVATE_SNAPSHOT_HISTORY');
    expect(owner.body).toContain('PRIVATE_SNAPSHOT_SOURCE');
    expect((await app.inject({ url: `/api/runs/${child.id}/debug-bundle`, headers: auth })).body).toContain('PRIVATE_CALL');
  });
  it('redacts every run and cross-run copied credentials, omits history/private runs, and freezes the sequence cutoff', async () => {
    const { repo, app, thread, root, share } = await setup();
    await repo.mutate(root.id, run => { run.modelDecision = { credentials: { key: 'opaque-root-secret' } }; run.artifacts[0]!.content = 'Root output Bearer root-token'; });
    const child = threadRun();
    child.modelDecision = { environment: { CUSTOM: 'opaque-child-secret' } };
    child.artifacts[0]!.content = 'Child output opaque-root-secret and opaque-child-secret';
    child.context.sources.push({ id: 'private-source', title: 'Private source', content: 'PRIVATE SOURCE CONTENT', classification: 'private', source: 'local', hash: 'hash' });
    child.context.threadHistory = await buildThreadHistory(repo, thread.id, await repo.get(root.id), threadScope, 'internal', 4096);
    await repo.createRunInThread(child, thread.id, root.id, threadScope);
    // A credential stored on another member must also be scrubbed from the root.
    await repo.mutate(root.id, run => { run.goal = 'Root repeats opaque-child-secret'; });
    const privateRun = threadRun(); privateRun.privacy = 'private'; privateRun.goal = 'PRIVATE THREAD CONTENT';
    await repo.createRunInThread(privateRun, thread.id, child.id, threadScope);
    const confidential = threadRun(); confidential.privacy = 'confidential'; confidential.goal = 'CONFIDENTIAL THREAD CONTENT';
    await repo.createRunInThread(confidential, thread.id, privateRun.id, threadScope);
    const token = (await share()).json(); expect(token.throughSequence).toBe(4);
    const later = threadRun(); later.goal = 'FUTURE FOLLOWUP'; await repo.createRunInThread(later, thread.id, root.id, threadScope);
    await repo.mutate(child.id, run => { run.status = 'failed'; });
    const view = await app.inject({ url: `/api/share/${token.token}` });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ kind: 'thread', thread: { id: thread.id }, throughSequence: 4, runs: [{ id: root.id }, { id: child.id, status: 'failed' }] });
    for (const value of ['opaque-root-secret', 'opaque-child-secret', 'root-token', 'PRIVATE THREAD CONTENT', 'PRIVATE SOURCE CONTENT', 'CONFIDENTIAL THREAD CONTENT', 'FUTURE FOLLOWUP', privateRun.id, confidential.id, later.id, 'threadHistory']) expect(view.body).not.toContain(value);
    expect(view.json().runs[1].artifacts[0].content).toContain('Child output [REDACTED]');
    expect(view.headers).toMatchObject({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    const fresh = (await share()).json();
    expect((await app.inject({ url: `/api/share/${fresh.token}` })).json().runs.map((run: { id: string }) => run.id)).toEqual([root.id, child.id, later.id]);
    // Current privacy changes apply to previously shared runs too.
    await repo.mutate(root.id, run => { run.privacy = 'private'; });
    const hidden = await app.inject({ url: `/api/share/${token.token}` });
    expect(hidden.json().runs.map((run: { id: string }) => run.id)).toEqual([child.id]);
    expect(hidden.body).not.toContain(root.id);
  });

  it.each(['private', 'confidential'] as const)('omits historical and restricted source observations when the parent becomes %s', async privacy => {
    const { repo, app, thread, root, share } = await setup();
    const parentText = 'PRIVATE PARENT ARTIFACT TEXT brief';
    await repo.mutate(root.id, run => { run.artifacts[0]!.content = parentText; });
    const child = threadRun();
    child.context.threadHistory = await buildThreadHistory(repo, thread.id, await repo.get(root.id), threadScope, 'internal', 4096);
    const historySource = threadHistorySources(child).find(source => source.origin?.ref === root.artifacts[0]!.id)!;
    const visibleSource = child.context.sources[0]!;
    const hiddenSources = [
      historySource,
      { ...historySource, id: 'origin-source' },
      { ...visibleSource, id: `history:${root.id}:legacy`, content: 'LEGACY HISTORY TEXT brief' },
      { ...visibleSource, id: 'private-source', classification: 'private' as const, content: 'PRIVATE SOURCE TEXT brief' },
      { ...visibleSource, id: 'confidential-source', classification: 'confidential' as const, content: 'CONFIDENTIAL SOURCE TEXT brief' },
    ];
    child.context.sources.push(...hiddenSources.slice(1));
    // Search returns refs and excerpts without the read result's origin metadata.
    const searchResults = [visibleSource, ...hiddenSources].map(source => ({
      id: source.id, sourceRef: source.id, title: source.title, source: source.source, hash: source.hash,
      excerpt: materialForModel(source).content, ...(source.classification ? { classification: source.classification } : {}),
    }));
    const visibleRead = { tool: 'sources.read', argument: visibleSource.id, result: materialForModel(visibleSource) };
    const otherObservation = { tool: 'example.lookup', argument: 'current', result: { content: 'CURRENT TOOL RESULT' } };
    child.steps = [{ taskId: 'task_1', status: 'succeeded', attempts: 1, observations: [
      visibleRead,
      ...hiddenSources.map(source => ({ tool: 'sources.read', argument: source.id, result: materialForModel(source) })),
      { tool: 'sources.search', argument: 'brief', result: searchResults },
      otherObservation,
    ] }, { taskId: 'task_2', status: 'succeeded', attempts: 1, observations: [
      { tool: 'sources.search', argument: 'parent', result: searchResults.slice(1, 3) },
    ] }];
    await repo.createRunInThread(child, thread.id, root.id, threadScope);
    await repo.mutate(root.id, run => { run.privacy = privacy; });
    const original = await repo.get(child.id);
    const token = (await share()).json();

    const view = await app.inject({ url: `/api/share/${token.token}` });
    expect(view.statusCode).toBe(200);
    expect(view.json().runs.map((run: { id: string }) => run.id)).toEqual([child.id]);
    for (const value of [root.id, parentText, 'LEGACY HISTORY TEXT', 'PRIVATE SOURCE TEXT', 'CONFIDENTIAL SOURCE TEXT', 'threadHistory', 'origin-source']) expect(view.body).not.toContain(value);
    const shared = view.json().runs[0];
    expect(shared.context.sources).toEqual([visibleSource]);
    expect(shared.steps[0].observations).toEqual([
      visibleRead, { tool: 'sources.search', argument: 'brief', result: [searchResults[0]] }, otherObservation,
    ]);
    expect(shared.steps[1].observations).toEqual([]);

    const debug = await app.inject({ url: `/api/share/${token.token}/debug-bundle` });
    expect(debug.statusCode).toBe(200);
    expect(debug.json()).toMatchObject({ schemaVersion: 'aeeis-thread-debug-bundle/1', kind: 'thread', access: 'share', runs: [{ id: child.id }] });
    for (const value of ['LEGACY HISTORY TEXT', 'PRIVATE SOURCE TEXT', 'CONFIDENTIAL SOURCE TEXT', 'threadHistory', 'origin-source']) expect(debug.body).not.toContain(value);
    expect(debug.body).not.toContain(parentText);
    expect(debug.body).not.toContain(root.id);
    expect((await app.inject({ url: `/api/runs/${child.id}/debug-bundle` })).statusCode).toBe(401);
    const ownerDebug = await app.inject({ url: `/api/runs/${child.id}/debug-bundle`, headers: auth });
    expect(ownerDebug.statusCode).toBe(200);
    expect(ownerDebug.json().taskAttempts[0].observations).toEqual(original.steps[0]!.observations);
    expect(await repo.get(child.id)).toEqual(original);
  });

  it('serves thread deep links and shares with the existing SPA and security headers', async () => {
    const { app, thread, share } = await setup();
    const token = (await share()).json();
    for (const url of [`/threads/${thread.id}`, token.url]) {
      const response = await app.inject({ url, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
      expect(response.statusCode).toBe(200); expect(response.body).toContain('thread-followup'); expect(response.body).toContain('src="/app.js"');
      expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect((await app.inject({ url, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } })).statusCode).toBe(403);
    }
    expect((await app.inject({ url: `/api/threads/${thread.id}` })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/share/${token.token}`, headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
  });

  it('checks owner and tenant on all management routes; tokens grant only the shared read', async () => {
    const { app, repo, thread, root, share } = await setup();
    const token = (await share()).json();
    const routes = [
      { method: 'POST' as const, url: `/api/threads/${thread.id}/share`, payload: {} },
      { method: 'GET' as const, url: `/api/threads/${thread.id}/shares` },
      { method: 'DELETE' as const, url: `/api/threads/${thread.id}/share/${token.id}` },
    ];
    for (const route of routes) {
      expect((await app.inject(route)).statusCode).toBe(401);
      expect((await app.inject({ ...route, headers: { authorization: 'Bearer reader' } })).statusCode).toBe(403);
      for (const other of ['bob', 'outsider']) expect((await app.inject({ ...route, headers: { authorization: `Bearer ${other}` } })).statusCode).toBe(404);
    }
    for (const url of [`/api/threads/${thread.id}`, `/api/runs/${root.id}`, `/api/runs/${root.id}/artifacts/${root.artifacts[0]!.id}/download`]) expect((await app.inject({ url, headers: { authorization: `Bearer ${token.token}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/threads/${thread.id}/runs`, headers: { authorization: `Bearer ${token.token}` }, payload: { request: { goal: 'unauthorized' } } })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/share/${token.token}/debug-bundle` })).statusCode).toBe(200);
    const otherThread = threadRecord(); await repo.createThread(otherThread);
    expect((await app.inject({ method: 'DELETE', url: `/api/threads/${otherThread.id}/share/${token.id}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/share/${token.token}` })).statusCode).toBe(200);
  });

  it('persists only hashes, lists and revokes shares, caps TTLs, and expires to 404', async () => {
    vi.stubEnv('AEEIS_SHARE_MAX_TTL_SECONDS', '60'); vi.stubEnv('AEEIS_SHARE_TTL_SECONDS', '30');
    const { app, thread, directory, share } = await setup();
    for (const ttlSeconds of [0, -1, 61, 1.5, '10']) expect((await share({ ttlSeconds })).statusCode).toBe(400);
    const token = (await share()).json();
    expect(Buffer.from(token.token, 'base64url')).toHaveLength(32);
    expect(Date.parse(token.expiresAt) - Date.now()).toBeGreaterThan(29000);
    const disk = await readFile(join(directory, '.thread-shares.json'), 'utf8');
    expect(disk).not.toContain(token.token); expect(JSON.parse(disk)[0]).toMatchObject({ tokenHash: hashShareToken(token.token), throughSequence: 1 });
    expect(activeShare(await new FileThreadShareStore(directory).find(hashShareToken(token.token)))).toBe(true);
    const list = await app.inject({ url: `/api/threads/${thread.id}/shares`, headers: auth });
    expect(list.json()[0]).toMatchObject({ id: token.id, threadId: thread.id }); expect(list.body).not.toContain('tokenHash');
    expect((await app.inject({ method: 'DELETE', url: `/api/threads/${thread.id}/share/${token.id}`, headers: auth })).statusCode).toBe(204);
    for (const url of [token.url, `/api/share/${token.token}`]) expect((await app.inject({ url })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/threads/${thread.id}/shares`, headers: auth })).json()[0].revokedAt).toEqual(expect.any(String));
    const expired = (await share({ ttlSeconds: 1 })).json(); vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expired.expiresAt));
    for (const url of [expired.url, `/api/share/${expired.token}`, '/api/share/invalid']) expect((await app.inject({ url })).statusCode).toBe(404);
  });

  it('reads all sequence pages and preserves more runs than the debug array cap', async () => {
    const repo = new InMemoryRunRepository(), thread = threadRecord(); await repo.createThread(thread);
    const runs = [];
    for (let i = 0; i < 501; i++) runs.push(await repo.createRunInThread(threadRun(), thread.id, runs[0]?.id, threadScope));
    const { token, share } = newThreadShare(thread.id, 501, 60); await repo.threadShares.create(share);
    const app = buildApp({ repository: repo }); cleanup.push(() => app.close());
    const response = await app.inject({ url: `/api/share/${token}` });
    expect(response.statusCode).toBe(200); expect(response.json().runs).toHaveLength(501);
    expect(response.json().runs.map((run: { threadSequence: number }) => run.threadSequence)).toEqual(Array.from({ length: 501 }, (_, i) => i + 1));
    const empty = threadRecord(); await repo.createThread(empty);
    const emptyToken = newThreadShare(empty.id, 0, 60); await repo.threadShares.create(emptyToken.share);
    await repo.createRunInThread(threadRun(), empty.id, undefined, threadScope);
    expect((await app.inject({ url: `/api/share/${emptyToken.token}` })).json()).toMatchObject({ kind: 'thread', throughSequence: 0, runs: [] });
    expect(sharedThreadView(empty, 0, []).runs).toEqual([]);
  });

  it('ships the additive migration used by bootstrap', async () => {
    expect((await readFile('src/adapters/migrations/004-thread-shares.sql', 'utf8')).trim()).toBe(threadSharesMigration);
  });

  it.skipIf(!process.env.AEEIS_TEST_DATABASE_URL)('persists thread capabilities across Postgres adapters and enforces separate tables', async () => {
    const db = await isolatedPostgres(process.env.AEEIS_TEST_DATABASE_URL!);
    const repo = new PostgresRunRepository(db.url), second = new PostgresRunRepository(db.url), pool = new pg.Pool({ connectionString: db.url });
    try {
      await Promise.all([repo.init(), second.init()]);
      const thread = threadRecord(); await repo.createThread(thread);
      const { token, share } = newThreadShare(thread.id, 0, 60); await repo.threadShares.create(share);
      expect(activeShare(await second.threadShares.find(hashShareToken(token)))).toBe(true);
      expect(await second.shares.find(hashShareToken(token))).toBeUndefined();
      expect(JSON.stringify((await pool.query('SELECT * FROM aeeis_thread_shares')).rows)).not.toContain(token);
      expect(await second.threadShares.revoke(thread.id, share.id, new Date().toISOString())).toBe(true);
      expect(activeShare(await repo.threadShares.find(hashShareToken(token)))).toBe(false);
    } finally { await pool.end(); await repo.close(); await second.close(); await db.close(); }
  });
});
