import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { ThreadService } from '../src/application/thread-service.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { followupHash, threadFollowupsMigration } from '../src/runtime/thread-followups.js';
import { threadRecord, threadRun, threadScope } from './support/thread-contract.js';
import { followupModel, threadFollowupContract } from './support/thread-followup-contract.js';

threadFollowupContract('in-memory follow-up reservations', async () => {
  const repository = new InMemoryRunRepository(); return { repository, close: () => repository.close() };
});
threadFollowupContract('file follow-up reservations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-followups-'));
  const repository = new FileRunRepository(directory); await repository.init();
  return { repository, async close() { await repository.close(); await rm(directory, { recursive: true, force: true }); } };
});

describe('follow-up file commit recovery', () => {
  it.each(['canonical', 'reservation'])('recovers a crash at %s publication before serving runs', async boundary => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-followup-journal-'));
    let repository = new FileRunRepository(directory); await repository.init();
    try {
      const parent = threadRun(), thread = threadRecord(); await repository.create(parent); await repository.createThread(thread, parent.id);
      const service = new ThreadService(repository, new AgentEngine(repository, followupModel()));
      const writer = repository as unknown as { replaceJson(path: string, value: any): Promise<void> };
      const replace = writer.replaceJson.bind(repository);
      const spy = vi.spyOn(writer, 'replaceJson').mockImplementation(async (path, value) => {
        if ((boundary === 'canonical' && value.threadId && value.id?.startsWith('run_')) || (boundary === 'reservation' && value.state === 'completed')) throw new Error('publication interrupted');
        await replace(path, value);
      });
      const input = { request: { goal: 'next' }, idempotencyKey: 'restart-key' };
      await expect(service.followUp(thread.id, input, threadScope)).rejects.toThrow('publication interrupted');
      await expect(repository.list()).rejects.toThrow('publication interrupted');
      spy.mockRestore(); await repository.close();
      repository = new FileRunRepository(directory); await repository.init();
      const engine = new AgentEngine(repository, followupModel()), create = vi.spyOn(engine, 'create');
      const retry = await new ThreadService(repository, engine).followUp(thread.id, input, threadScope);
      expect(retry).toMatchObject({ threadId: thread.id, parentRunId: parent.id, threadSequence: 2 });
      expect(create).not.toHaveBeenCalled();
      expect((await repository.getThreadFollowup(thread.id, followupHash(input.idempotencyKey), threadScope))?.state).toBe('completed');
      expect((await repository.listRunsByThread(thread.id)).map(run => run.threadSequence)).toEqual([1, 2]);
      // A key replay remains stable through index rebuild and later run progress.
      await repository.mutate(retry.id, run => { run.status = 'succeeded'; });
      await repository.close(); await rm(join(directory, '.runs.index.json'), { force: true });
      repository = new FileRunRepository(directory); await repository.init();
      const replay = await new ThreadService(repository, new AgentEngine(repository, followupModel())).followUp(thread.id, input, threadScope);
      expect(replay.id).toBe(retry.id); expect(replay.status).toBe('succeeded');
    } finally { vi.restoreAllMocks(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('keeps migration SQL identical to bootstrap', async () => {
    expect((await readFile(new URL('../src/adapters/migrations/003-thread-followups.sql', import.meta.url), 'utf8')).trim()).toBe(threadFollowupsMigration);
  });
});
