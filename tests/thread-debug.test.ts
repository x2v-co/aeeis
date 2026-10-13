import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/runtime/http.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { MAX_THREAD_BUNDLE_BYTES, readThreadBundleRuns, threadDebugBundle, ThreadBundleTooLarge } from '../src/runtime/thread-debug.js';
import { newThreadShare } from '../src/runtime/thread-shares.js';
import { threadRecord, threadRun, threadScope } from './support/thread-contract.js';

afterEach(() => vi.restoreAllMocks());

describe('thread debug exports', () => {
  it('pages storage, preserves more than 500 members and respects the captured share cutoff', async () => {
    const repository = new InMemoryRunRepository(), thread = threadRecord(); await repository.createThread(thread);
    const runs = [];
    for (let i = 0; i < 501; i++) runs.push(await repository.createRunInThread(threadRun(), thread.id, runs[0]?.id, threadScope));
    const read = vi.spyOn(repository, 'listRunsByThread');
    const app = buildApp({ repository, principalTokens: { alice: { id: threadScope.owner, tenantId: threadScope.tenantId, roles: ['owner'] } } });
    try {
      const owner = await app.inject({ url: `/api/threads/${thread.id}/debug-bundle`, headers: { authorization: 'Bearer alice' } });
      expect(owner.statusCode).toBe(200);
      expect(owner.json()).toMatchObject({ kind: 'thread', access: 'owner', throughSequence: 501 });
      expect(owner.json().runs.map((run: { id: string }) => run.id)).toEqual(runs.map(run => run.id));
      expect(read.mock.calls.map(call => call.slice(2))).toEqual([0, 100, 200, 300, 400, 500].map(cursor => [100, cursor]));
      const shared = newThreadShare(thread.id, 201, 60); await repository.threadShares.create(shared.share);
      read.mockClear();
      const response = await app.inject({ url: `/api/share/${shared.token}/debug-bundle` });
      expect(response.statusCode).toBe(200);
      expect(response.json().runs.map((run: { id: string }) => run.id)).toEqual(runs.slice(0, 201).map(run => run.id));
      expect(response.json()).toMatchObject({ access: 'share', throughSequence: 201 });
      expect(read.mock.calls.map(call => call.slice(2))).toEqual([0, 100, 200].map(cursor => [100, cursor]));
      expect(response.headers).toMatchObject({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      expect((await app.inject({ url: `/api/threads/${thread.id}/debug-bundle` })).statusCode).toBe(401);
    } finally { await app.close(); await repository.close(); }
  });

  it('scrubs credentials across members and thread metadata, including credentials on omitted private members', async () => {
    const thread = threadRecord(), root = threadRun(), privateRun = threadRun();
    root.threadId = privateRun.threadId = thread.id; root.threadSequence = 1; privateRun.threadSequence = 2;
    privateRun.privacy = 'private'; privateRun.modelDecision = { credentials: { apiKey: 'opaque-private-credential' } };
    root.goal = 'Copied opaque-private-credential'; thread.title = 'Copied opaque-private-credential';
    for (const access of ['owner', 'share'] as const) {
      const bundle = threadDebugBundle(thread, 2, [root, privateRun], access);
      expect(bundle.thread.title).toBe('Copied [REDACTED]');
      expect(bundle.runs[0]!.goal).toBe('Copied [REDACTED]');
      expect(bundle.runs).toHaveLength(access === 'share' ? 1 : 2);
      expect(JSON.stringify(bundle)).not.toContain('opaque-private-credential');
    }
  });

  it('exports an empty cutoff without reading later runs and rejects oversized exports before returning partial data', async () => {
    const repository = new InMemoryRunRepository(), thread = threadRecord(); await repository.createThread(thread);
    const root = await repository.createRunInThread(threadRun(), thread.id, undefined, threadScope);
    const read = vi.spyOn(repository, 'listRunsByThread');
    expect(await readThreadBundleRuns(repository, thread, 0)).toEqual([]); expect(read).not.toHaveBeenCalled();
    expect(threadDebugBundle(thread, 0, [], 'share')).toMatchObject({ throughSequence: 0, runs: [] });
    root.artifacts[0]!.content = 'x'.repeat(MAX_THREAD_BUNDLE_BYTES);
    read.mockResolvedValue([root]);
    const app = buildApp({ repository, token: 'owner' });
    try {
      await expect(readThreadBundleRuns(repository, thread, 1)).rejects.toThrow(ThreadBundleTooLarge);
      const shared = newThreadShare(thread.id, 1, 60); await repository.threadShares.create(shared.share);
      const response = await app.inject({ url: `/api/share/${shared.token}/debug-bundle` });
      expect(response.statusCode).toBe(413); expect(response.body).not.toContain(root.id);
    } finally { await app.close(); await repository.close(); }
  });
});
