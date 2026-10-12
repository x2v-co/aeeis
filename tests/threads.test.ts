import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { prepareAttachment, threadsMigration } from '../src/runtime/threads.js';
import { NotFound } from '../src/runtime/repository.js';
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
  it('loads only the selected canonical files for warm sequence pages and latest parent lookup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-thread-page-selection-'));
    const repository = new FileRunRepository(directory); await repository.init();
    try {
      const thread = threadRecord(); await repository.createThread(thread);
      const root = await repository.createRunInThread(threadRun(), thread.id);
      for (let index = 0; index < 8; index++) await repository.createRunInThread(threadRun(), thread.id, root.id);
      const get = vi.spyOn(repository, 'get');
      const page = await repository.listRunsByThread(thread.id, threadScope, 2, 5);
      expect(page.map(run => run.threadSequence)).toEqual([6, 7]);
      expect(get).toHaveBeenCalledTimes(2);
      get.mockClear();
      expect((await repository.latestRunByThread(thread.id, threadScope))?.threadSequence).toBe(9);
      expect(get).toHaveBeenCalledTimes(1);
      get.mockRestore();
    } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('rolls back both root creation files on a write failure and hides in-progress membership from readers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-thread-create-failure-'));
    const repository = new FileRunRepository(directory); await repository.init();
    try {
      const root = threadRun(), thread = threadRecord(); await repository.create(root);
      const writer = repository as unknown as { replaceJson(path: string, value: unknown): Promise<void> };
      const replace = writer.replaceJson.bind(repository);
      let fail = true;
      const spy = vi.spyOn(writer, 'replaceJson').mockImplementation(async (path, value) => {
        if (path === join(directory, `${thread.id}.json`) && fail) { fail = false; throw new Error('metadata write failed'); }
        await replace(path, value);
      });
      await expect(repository.createThread(thread, root.id)).rejects.toThrow('metadata write failed');
      expect(await repository.get(root.id)).toEqual(root);
      await expect(repository.getThread(thread.id)).rejects.toThrow(NotFound);
      let unblock!: () => void, entered!: () => void;
      const blocked = new Promise<void>(resolve => { unblock = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      spy.mockImplementation(async (path, value) => {
        if (path === join(directory, `${thread.id}.json`)) { entered(); await blocked; }
        await replace(path, value);
      });
      const creation = repository.createThread(thread, root.id);
      await started;
      let readFinished = false;
      const read = repository.get(root.id).then(run => { readFinished = true; return run; });
      await Promise.resolve(); expect(readFinished).toBe(false);
      unblock(); await creation;
      expect(await read).toMatchObject({ threadId: thread.id, threadSequence: 1 });
      expect(await repository.getThread(thread.id)).toEqual(thread);
      spy.mockRestore();
    } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('recovers root creation commit and rollback journals before serving runs, without replacing newer committed root data', async () => {
    for (const state of ['commit', 'rollback'] as const) {
      const directory = await mkdtemp(join(tmpdir(), 'aeeis-thread-create-recovery-'));
      let repository = new FileRunRepository(directory); await repository.init();
      try {
        const root = threadRun(), thread = threadRecord(); await repository.create(root); await repository.close();
        const run = structuredClone(root); prepareAttachment(run, thread, undefined, 0);
        await writeFile(join(directory, `.thread-create-${thread.id}.json`), JSON.stringify({ thread, run, before: root, state }));
        // Simulate a crash after publishing the linked canonical Run.
        await writeFile(join(directory, `${run.id}.json`), JSON.stringify(run));
        repository = new FileRunRepository(directory); await repository.init();
        if (state === 'commit') {
          expect(await repository.getThread(thread.id)).toEqual(thread);
          expect(await repository.get(root.id)).toEqual(run);
          await repository.mutate(run.id, record => { record.goal = 'newer data'; });
          await repository.close();
          await writeFile(join(directory, `.thread-create-${thread.id}.json`), JSON.stringify({ thread, run, before: root, state }));
          repository = new FileRunRepository(directory); await repository.init();
          expect((await repository.get(run.id)).goal).toBe('newer data');
          expect((await repository.listRunsByThread(thread.id)).map(record => record.id)).toEqual([root.id]);
        } else {
          expect(await repository.get(root.id)).toEqual(root);
          await expect(repository.getThread(thread.id)).rejects.toThrow(NotFound);
        }
      } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
    }
  });
  it('keeps the migration file identical to adapter bootstrap SQL', async () => {
    expect((await readFile(new URL('../src/adapters/migrations/002-threads.sql', import.meta.url), 'utf8')).trim()).toBe(threadsMigration);
  });
  it('preserves committed membership and advances sequences after an event projection write fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-threads-partial-save-'));
    let repository = new FileRunRepository(directory); await repository.init();
    try {
      const thread = threadRecord(), root = threadRun(), child = threadRun(), third = threadRun();
      await repository.createThread(thread); await repository.create(root); await repository.create(child);
      await repository.attachRunToThread(root.id, thread.id);
      // A directory at the projection path makes its replacement fail after
      // the canonical Run JSON has already committed the attachment.
      const projectionPath = join(directory, `${child.id}.events.json`);
      await rm(projectionPath); await mkdir(projectionPath);
      await expect(repository.attachRunToThread(child.id, thread.id, root.id)).rejects.toMatchObject({ code: 'EISDIR' });
      await rm(projectionPath, { recursive: true });
      const committed = await repository.get(child.id);
      expect(committed).toMatchObject({ threadId: thread.id, parentRunId: root.id, threadSequence: 2, revision: child.revision + 1 });
      expect(await repository.attachRunToThread(child.id, thread.id, root.id)).toEqual(committed);
      await repository.create(third);
      expect((await repository.attachRunToThread(third.id, thread.id, root.id)).threadSequence).toBe(3);
      const runs = [root, child, third];
      expect((await Promise.all(runs.map(run => repository.get(run.id)))).map(run => run.threadSequence)).toEqual([1, 2, 3]);
      expect((await repository.listRunsByThread(thread.id)).map(run => run.id)).toEqual(runs.map(run => run.id));
      await repository.close(); repository = new FileRunRepository(directory); await repository.init();
      const restored = await repository.listRunsByThread(thread.id);
      expect(restored.map(run => run.id)).toEqual(runs.map(run => run.id));
      expect(restored.map(run => run.threadSequence)).toEqual([1, 2, 3]);
    } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
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
