import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { threadsMigration } from '../src/runtime/threads.js';
import { threadContract, threadRecord, threadRun, threadScope } from './support/thread-contract.js';

threadContract('in-memory threads', async () => {
  const repository = new InMemoryRunRepository(); return { repository, close: () => repository.close() };
});
threadContract('file threads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-threads-'));
  const repository = new FileRunRepository(directory); await repository.init();
  return { repository, async close() { await repository.close(); await rm(directory, { recursive: true, force: true }); } };
});

describe('thread durability and migration source', () => {
  it('keeps the migration file identical to adapter bootstrap SQL', async () => {
    expect((await readFile(new URL('../src/adapters/migrations/002-threads.sql', import.meta.url), 'utf8')).trim()).toBe(threadsMigration);
  });
  it('restores membership and sequence after restart and disposable index loss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-threads-restart-'));
    let repository = new FileRunRepository(directory); await repository.init();
    try {
      const thread = threadRecord(), root = threadRun(), child = threadRun();
      await repository.createThread(thread); await repository.create(root); await repository.create(child);
      await repository.attachRunToThread(root.id, thread.id);
      const attached = await repository.attachRunToThread(child.id, thread.id, root.id);
      await repository.close(); repository = new FileRunRepository(directory); await repository.init();
      expect(await repository.getThread(thread.id, threadScope)).toEqual(thread);
      expect((await repository.listRunsByThread(thread.id)).map(run => run.threadSequence)).toEqual([1, 2]);
      expect(await repository.attachRunToThread(child.id, thread.id, root.id)).toEqual(attached);
      await repository.close();
      // Version 2 indexes and corrupt projections are rebuilt from canonical runs.
      for (const index of ['{"version":2,"entries":[]}', '{corrupt']) {
        await writeFile(join(directory, '.runs.index.json'), index);
        repository = new FileRunRepository(directory); await repository.init();
        expect((await repository.listRunsByThread(thread.id)).map(run => run.threadSequence)).toEqual([1, 2]);
        await repository.close();
      }
      repository = new FileRunRepository(directory); await repository.init();
      const third = threadRun(); await repository.create(third);
      expect((await repository.attachRunToThread(third.id, thread.id, child.id)).threadSequence).toBe(3);
    } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
