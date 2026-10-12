import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadService } from '../../src/application/thread-service.js';
import { AgentEngine } from '../../src/runtime/engine.js';
import type { ModelAdapter } from '../../src/runtime/model.js';
import { NotFound, type RunRepository } from '../../src/runtime/repository.js';
import { followupHash } from '../../src/runtime/thread-followups.js';
import { threadRecord, threadRun, threadScope } from './thread-contract.js';

export const followupModel = (): ModelAdapter => ({ pin: { model: 'fixture', endpoint: 'http://127.0.0.1', promptVersion: 'fixture/1' }, complete: vi.fn() });
export function threadFollowupContract(name: string, setup: () => Promise<{ repository: RunRepository; close(): Promise<void> }>, skip = false): void {
  describe.skipIf(skip)(name, () => {
    let repository: RunRepository, close: () => Promise<void>, engine: AgentEngine, service: ThreadService;
    let thread: ReturnType<typeof threadRecord>, parent: ReturnType<typeof threadRun>;
    const key = 'opaque-followup-key', body = { request: { goal: 'next' }, idempotencyKey: key };
    beforeEach(async () => {
      ({ repository, close } = await setup());
      thread = threadRecord(); parent = threadRun();
      await repository.create(parent); await repository.createThread(thread, parent.id);
      engine = new AgentEngine(repository, followupModel()); service = new ThreadService(repository, engine);
    });
    afterEach(async () => { vi.restoreAllMocks(); await close?.(); });
    it('initializes once under concurrent retries and compares canonical normalized inputs', async () => {
      const create = vi.spyOn(engine, 'create');
      const runs = await Promise.all(Array.from({ length: 6 }, () => service.followUp(thread.id, body, threadScope)));
      expect(new Set(runs.map(run => run.id)).size).toBe(1); expect(create).toHaveBeenCalledOnce();
      const retry = await service.followUp(thread.id, { request: { materials: [], maxModelCalls: 20, privacy: 'internal', goal: ' next ' } }, threadScope, key);
      expect(retry).toEqual(runs[0]);
      const reservation = await repository.getThreadFollowup(thread.id, followupHash(key), threadScope);
      expect(reservation).toMatchObject({ state: 'completed', runId: retry.id, parentRunId: parent.id });
      expect(JSON.stringify(reservation)).not.toContain(key);
      expect(await repository.listRunsByThread(thread.id)).toHaveLength(2);
    });
    it('rejects changed goals, parent intent, privacy and budget for the same key', async () => {
      await service.followUp(thread.id, body, threadScope);
      for (const changed of [
        { ...body, request: { goal: 'different' } },
        { ...body, parentRunId: parent.id },
        { ...body, contextBudgetBytes: 4096 },
        { ...body, request: { goal: 'next', privacy: 'private' } },
      ]) await expect(service.followUp(thread.id, changed, threadScope)).rejects.toThrow('different input');
      for (const scope of [{ ...threadScope, owner: 'bob' }, { ...threadScope, tenantId: 'team-b' }]) {
        await expect(service.followUp(thread.id, body, scope)).rejects.toThrow(NotFound);
        await expect(repository.getThreadFollowup(thread.id, followupHash(key), scope)).rejects.toThrow(NotFound);
      }
      expect(await repository.listRunsByThread(thread.id)).toHaveLength(2);
    });
    it('recovers a prepared reservation before dispatch without fetching or preparing again', async () => {
      const commit = vi.spyOn(repository, 'createRunInThread').mockRejectedValueOnce(new Error('crash before commit'));
      await expect(service.followUp(thread.id, body, threadScope)).rejects.toThrow('crash before commit');
      const reservation = (await repository.getThreadFollowup(thread.id, followupHash(key), threadScope))!;
      expect(reservation.state).toBe('reserved'); expect(reservation.contextSnapshot.run?.id).toBe(reservation.runId);
      await expect(repository.get(reservation.runId)).rejects.toThrow(NotFound);
      expect((await repository.list()).map(run => run.id)).toEqual([parent.id]);
      // JSONB may reorder every object's keys on a storage roundtrip.
      const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reorder(nested)])) : value;
      await repository.saveThreadFollowup(reorder(reservation), threadScope);
      commit.mockRestore(); const create = vi.spyOn(engine, 'create');
      await service.recover();
      const run = await service.followUp(thread.id, body, threadScope);
      expect(run).toMatchObject({ id: reservation.runId, threadId: thread.id, threadSequence: 2, parentRunId: parent.id });
      expect(run.context.threadHistory).toEqual(reservation.contextSnapshot.history);
      expect(create).not.toHaveBeenCalled();
      expect((await repository.getThreadFollowup(thread.id, followupHash(key), threadScope))?.state).toBe('completed');
    });
    it('reuses checkpointed connector results after interrupted preparation', async () => {
      const search = vi.fn(async () => []);
      engine = new AgentEngine(repository, { model: followupModel(), knowledge: { search } }); service = new ThreadService(repository, engine);
      const input = { ...body, request: { goal: 'next', knowledgeQuery: 'evidence' } };
      const save = repository.saveThreadFollowup.bind(repository);
      const checkpoint = vi.spyOn(repository, 'saveThreadFollowup').mockImplementation(async (record, scope) => {
        if (record.contextSnapshot.run) throw new Error('crash before prepared checkpoint');
        await save(record, scope);
      });
      await expect(service.followUp(thread.id, input, threadScope)).rejects.toThrow('crash before prepared checkpoint');
      expect(search).toHaveBeenCalledOnce(); checkpoint.mockRestore();
      await new ThreadService(repository, new AgentEngine(repository, { model: followupModel(), knowledge: { search } })).recover();
      const run = await service.followUp(thread.id, input, threadScope);
      expect(run.threadSequence).toBe(2); expect(search).toHaveBeenCalledOnce();
    });
    it('keeps an ambiguous connector outcome reserved and never automatically resends it', async () => {
      const search = vi.fn(async () => { throw new Error('lost provider response'); });
      service = new ThreadService(repository, new AgentEngine(repository, { model: followupModel(), knowledge: { search } }));
      const input = { ...body, request: { goal: 'next', knowledgeQuery: 'evidence' } };
      await expect(service.followUp(thread.id, input, threadScope)).rejects.toThrow('lost provider response');
      await expect(service.followUp(thread.id, input, threadScope)).rejects.toThrow('unknown outcome');
      expect(search).toHaveBeenCalledOnce();
      expect(await repository.listRunsByThread(thread.id)).toHaveLength(1);
    });
  });
}
