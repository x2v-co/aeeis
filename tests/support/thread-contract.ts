import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRun } from '../../src/runtime/contracts.js';
import { NotFound, type RunRepository } from '../../src/runtime/repository.js';
import { ThreadConflict, type Thread } from '../../src/runtime/threads.js';
import { runWithSignals } from './rsi-proposal.js';
import { buildThreadHistory } from '../../src/runtime/thread-history.js';

export const threadScope = { owner: 'alice', tenantId: 'team-a' };
export function threadRecord(): Thread {
  return { id: `thread_${randomUUID()}`, ...threadScope, title: 'Reports', createdAt: '2026-10-13T00:00:00.000Z' };
}
export function threadRun(): AgentRun {
  const run = runWithSignals();
  run.id = `run_${randomUUID()}`;
  run.events = run.events.map(event => ({ ...event, id: `evt_${randomUUID()}` }));
  return run;
}
export function threadContract(name: string, setup: () => Promise<{ repository: RunRepository; close(): Promise<void> }>, skip = false): void {
  describe.skipIf(skip)(name, () => {
    let repository: RunRepository;
    let close: () => Promise<void>;
    let thread: Thread;
    beforeEach(async () => {
      const fixture = await setup(); repository = fixture.repository; close = () => fixture.close();
      thread = threadRecord(); await repository.createThread(thread);
    });
    afterEach(async () => { await close?.(); });

    it('creates empty threads, returns copies and rejects duplicate IDs', async () => {
      const loaded = await repository.getThread(thread.id, threadScope);
      loaded.title = 'changed'; thread.title = 'caller changed';
      expect((await repository.getThread(thread.id, threadScope)).title).toBe('Reports');
      expect(await repository.listRunsByThread(thread.id, threadScope)).toEqual([]);
      await expect(repository.createThread(thread)).rejects.toThrow(ThreadConflict);
    });
    it('creates a thread and attaches its root atomically, including competing requests', async () => {
      const root = threadRun(); await repository.create(root);
      const choices = [threadRecord(), threadRecord()];
      const results = await Promise.allSettled(choices.map(candidate => repository.createThread(candidate, root.id)));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const attached = await repository.get(root.id);
      expect(attached.threadSequence).toBe(1);
      expect(attached.parentRunId).toBeUndefined();
      for (const candidate of choices) {
        if (candidate.id === attached.threadId) expect(await repository.getThread(candidate.id)).toEqual(candidate);
        else await expect(repository.getThread(candidate.id)).rejects.toThrow(NotFound);
      }
      const inaccessible = threadRecord();
      await expect(repository.createThread({ ...inaccessible, owner: 'bob' }, root.id)).rejects.toThrow(NotFound);
      await expect(repository.getThread(inaccessible.id)).rejects.toThrow(NotFound);
    });
    it('commits new runs with their membership and rejects stale or live parents without leaving a run', async () => {
      const root = threadRun(); await repository.create(root); await repository.attachRunToThread(root.id, thread.id);
      const parent = await repository.get(root.id), child = threadRun();
      const committed = await repository.createRunInThread(child, thread.id, root.id, threadScope, parent.revision);
      expect(committed).toMatchObject({ threadId: thread.id, parentRunId: root.id, threadSequence: 2 });
      expect(await repository.get(child.id)).toEqual(committed);
      const rejected = threadRun();
      await repository.mutate(root.id, run => { run.goal = 'changed'; });
      await expect(repository.createRunInThread(rejected, thread.id, root.id, threadScope, parent.revision)).rejects.toThrow(ThreadConflict);
      await expect(repository.get(rejected.id)).rejects.toThrow(NotFound);
      await repository.mutate(root.id, run => { run.status = 'needs_input'; });
      await expect(repository.createRunInThread(rejected, thread.id, root.id, threadScope)).rejects.toThrow(ThreadConflict);
      await expect(repository.get(rejected.id)).rejects.toThrow(NotFound);
      await expect(repository.createRunInThread(threadRun(), thread.id, undefined, threadScope)).rejects.toThrow(ThreadConflict);
    });
    it('selects sequence pages and the latest member in storage, scoped even for empty threads', async () => {
      expect(await repository.latestRunByThread(thread.id, threadScope)).toBeUndefined();
      const root = threadRun(); await repository.createRunInThread(root, thread.id, undefined, threadScope);
      const children = [threadRun(), threadRun(), threadRun()];
      for (const child of children) await repository.createRunInThread(child, thread.id, root.id, threadScope);
      expect((await repository.listRunsByThread(thread.id, threadScope, 2, 1)).map(run => run.threadSequence)).toEqual([2, 3]);
      expect((await repository.latestRunByThread(thread.id, threadScope))?.id).toBe(children[2]!.id);
      for (const scope of [{ ...threadScope, owner: 'bob' }, { ...threadScope, tenantId: 'other' }]) {
        await expect(repository.listRunsByThread(thread.id, scope, 2, 1)).rejects.toThrow(NotFound);
        await expect(repository.latestRunByThread(thread.id, scope)).rejects.toThrow(NotFound);
      }
      for (const cursor of [-1, 0.5, NaN, 2147483648]) await expect(repository.listRunsByThread(thread.id, threadScope, 2, cursor)).rejects.toThrow(RangeError);
    });
    it('preserves the frozen history through normal mutations and refuses replacing, editing or removing it', async () => {
      const initial = threadRun(); initial.goalId = 'restricted-goal';
      const root = await repository.createRunInThread(initial, thread.id, undefined, threadScope);
      const child = threadRun();
      child.context.threadHistory = await buildThreadHistory(repository, thread.id, root, threadScope, 'internal', 32768);
      const attached = await repository.createRunInThread(child, thread.id, root.id, threadScope);
      await repository.mutate(child.id, run => { run.status = 'failed'; });
      expect((await repository.get(child.id)).context.threadHistory).toEqual(attached.context.threadHistory);
      for (const change of [
        (run: AgentRun) => { delete run.context.threadHistory; },
        (run: AgentRun) => { run.context.threadHistory!.entries[0]!.excerpts[0]!.text = 'changed'; },
        (run: AgentRun) => { run.context.threadHistory!.accessProvenance!.pop(); },
      ]) await expect(repository.mutate(child.id, change)).rejects.toThrow(ThreadConflict);
      expect((await repository.get(child.id)).context.threadHistory).toEqual(attached.context.threadHistory);
    });
    it('hides missing threads and wrong owner/tenant, even when empty', async () => {
      for (const scope of [{ ...threadScope, owner: 'bob' }, { ...threadScope, tenantId: 'team-b' }]) {
        await expect(repository.getThread(thread.id, scope)).rejects.toThrow(NotFound);
        await expect(repository.listRunsByThread(thread.id, scope, 1)).rejects.toThrow(NotFound);
      }
      for (const id of [threadRecord().id, '../run.json']) {
        await expect(repository.getThread(id)).rejects.toThrow(NotFound);
        await expect(repository.listRunsByThread(id)).rejects.toThrow(NotFound);
      }
    });
    it('leaves standalone runs unchanged and validates collection limits', async () => {
      const run = threadRun(); await repository.create(run);
      expect(await repository.get(run.id)).toEqual(run);
      expect(await repository.list(threadScope)).toEqual([run]);
      expect(await repository.listRunsByThread(thread.id)).toEqual([]);
      for (const limit of [0, -1, 1.5, NaN]) await expect(repository.listRunsByThread(thread.id, threadScope, limit)).rejects.toThrow(RangeError);
    });
    it('allocates immutable sequences, supports branches and orders by sequence', async () => {
      const runs = [threadRun(), threadRun(), threadRun()];
      for (const run of runs) await repository.create(run);
      const root = await repository.attachRunToThread(runs[0]!.id, thread.id, undefined, threadScope);
      const second = await repository.attachRunToThread(runs[1]!.id, thread.id, root.id, threadScope);
      const third = await repository.attachRunToThread(runs[2]!.id, thread.id, root.id, threadScope);
      expect(root).toMatchObject({ threadId: thread.id, threadSequence: 1, revision: runs[0]!.revision + 1 });
      expect(root.parentRunId).toBeUndefined();
      expect(second).toMatchObject({ parentRunId: root.id, threadSequence: 2 });
      expect(third).toMatchObject({ parentRunId: root.id, threadSequence: 3 });
      const events = root.events;
      await repository.mutate(root.id, run => { run.status = 'paused'; });
      expect((await repository.get(root.id)).events).toEqual(events);
      expect((await repository.listRunsByThread(thread.id)).map(run => run.id)).toEqual(runs.map(run => run.id));
      expect((await repository.listRunsByThread(thread.id, threadScope, 2)).map(run => run.threadSequence)).toEqual([1, 2]);
    });
    it('retries attachment without spending a sequence or changing the run', async () => {
      const root = threadRun(), child = threadRun(); await repository.create(root); await repository.create(child);
      const attachedRoot = await repository.attachRunToThread(root.id, thread.id);
      const attachedChild = await repository.attachRunToThread(child.id, thread.id, root.id);
      expect(await repository.attachRunToThread(root.id, thread.id)).toEqual(attachedRoot);
      expect(await repository.attachRunToThread(child.id, thread.id, root.id)).toEqual(attachedChild);
      await expect(repository.attachRunToThread(child.id, thread.id)).rejects.toThrow(ThreadConflict);
      expect(await repository.listRunsByThread(thread.id)).toHaveLength(2);
    });
    it('serializes concurrent root reservations and concurrent child appends', async () => {
      const runs = Array.from({ length: 7 }, () => threadRun());
      await Promise.all(runs.map(run => repository.create(run)));
      const roots = await Promise.allSettled(runs.slice(0, 2).map(run => repository.attachRunToThread(run.id, thread.id)));
      expect(roots.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(roots.filter(result => result.status === 'rejected')).toHaveLength(1);
      const root = (await repository.listRunsByThread(thread.id))[0]!;
      await Promise.all(runs.filter(run => run.id !== root.id).map(run => repository.attachRunToThread(run.id, thread.id, root.id)));
      expect((await repository.listRunsByThread(thread.id)).map(run => run.threadSequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
    it('requires existing same-thread parents and does not consume sequence on failure', async () => {
      const root = threadRun(), child = threadRun(), outsider = threadRun();
      for (const run of [root, child, outsider]) await repository.create(run);
      await expect(repository.attachRunToThread(root.id, thread.id, root.id)).rejects.toThrow(ThreadConflict);
      await expect(repository.attachRunToThread(root.id, thread.id, outsider.id)).rejects.toThrow(ThreadConflict);
      await expect(repository.attachRunToThread(root.id, thread.id, threadRun().id)).rejects.toThrow(NotFound);
      await repository.attachRunToThread(root.id, thread.id);
      await expect(repository.attachRunToThread(child.id, thread.id)).rejects.toThrow(ThreadConflict);
      const other = threadRecord(); await repository.createThread(other);
      await repository.attachRunToThread(outsider.id, other.id);
      await expect(repository.attachRunToThread(child.id, thread.id, outsider.id)).rejects.toThrow(ThreadConflict);
      expect(await repository.get(child.id)).toEqual(child);
      expect((await repository.attachRunToThread(child.id, thread.id, root.id)).threadSequence).toBe(2);
      await expect(repository.attachRunToThread(root.id, other.id, outsider.id)).rejects.toThrow(ThreadConflict);
    });
    it('rejects foreign runs, parents and attaching scopes', async () => {
      const root = threadRun(); await repository.create(root); await repository.attachRunToThread(root.id, thread.id);
      for (const foreignScope of [{ ...threadScope, owner: 'bob' }, { ...threadScope, tenantId: 'team-b' }]) {
        const foreign = { ...threadRun(), ...foreignScope }; await repository.create(foreign);
        await expect(repository.attachRunToThread(foreign.id, thread.id, root.id)).rejects.toThrow(NotFound);
        const child = threadRun(); await repository.create(child);
        await expect(repository.attachRunToThread(child.id, thread.id, foreign.id)).rejects.toThrow(NotFound);
        await expect(repository.attachRunToThread(child.id, thread.id, root.id, foreignScope)).rejects.toThrow(NotFound);
        expect((await repository.get(child.id)).threadId).toBeUndefined();
      }
      await expect(repository.attachRunToThread(threadRun().id, thread.id, root.id)).rejects.toThrow(NotFound);
    });
    it('cannot bypass membership validation through create or mutate', async () => {
      const forged = { ...threadRun(), threadId: thread.id, threadSequence: 1 };
      await expect(repository.create(forged)).rejects.toThrow(ThreadConflict);
      const run = threadRun(); await repository.create(run);
      await expect(repository.mutate(run.id, current => { current.parentRunId = run.id; })).rejects.toThrow(ThreadConflict);
      await repository.attachRunToThread(run.id, thread.id);
      const before = await repository.get(run.id);
      for (const change of [
        (current: AgentRun) => { delete current.threadId; },
        (current: AgentRun) => { current.threadSequence = 50; },
        (current: AgentRun) => { current.parentRunId = run.id; },
      ]) {
        await expect(repository.mutate(run.id, change)).rejects.toThrow(ThreadConflict);
        expect(await repository.get(run.id)).toEqual(before);
      }
    });
    it('accepts legacy local runs with missing tenantId', async () => {
      const local = { ...threadRecord(), owner: 'owner', tenantId: 'local' }; await repository.createThread(local);
      const run = threadRun(); run.owner = 'owner'; delete run.tenantId; await repository.create(run);
      expect((await repository.attachRunToThread(run.id, local.id)).threadSequence).toBe(1);
      expect(await repository.listRunsByThread(local.id, local)).toHaveLength(1);
    });
    it('validates new thread records before writing', async () => {
      for (const value of [{ ...threadRecord(), id: '../unsafe' }, { ...threadRecord(), owner: '' }, { ...threadRecord(), createdAt: 'invalid' }]) {
        await expect(repository.createThread(value)).rejects.toThrow();
      }
    });
  });
}
