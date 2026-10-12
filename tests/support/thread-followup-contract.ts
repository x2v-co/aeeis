import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadService } from '../../src/application/thread-service.js';
import { AgentEngine, event } from '../../src/runtime/engine.js';
import type { AgentRun } from '../../src/runtime/contracts.js';
import { StaticModelResolver } from '../../src/runtime/model-router.js';
import { GovernedBrain } from '../../src/brain.js';
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
    it.each(['retry', 'recovery'])('retries a failed model selection through %s with the same reservation', async path => {
      const model = followupModel(), resolver = new StaticModelResolver(model);
      const resolve = vi.spyOn(resolver, 'resolve').mockRejectedValueOnce(new Error('catalog temporarily unavailable'));
      service = new ThreadService(repository, new AgentEngine(repository, { resolver }));
      await expect(service.followUp(thread.id, body, threadScope)).rejects.toThrow('catalog temporarily unavailable');
      const reservation = (await repository.getThreadFollowup(thread.id, followupHash(key), threadScope))!;
      expect(reservation.contextSnapshot.preparation?.['model-selection']).toEqual({ state: 'failed' });
      expect(reservation.contextSnapshot.run).toBeUndefined();
      await expect(repository.get(reservation.runId)).rejects.toThrow(NotFound);
      await expect(service.followUp(thread.id, { ...body, request: { goal: 'changed' } }, threadScope)).rejects.toThrow('different input');
      service = new ThreadService(repository, new AgentEngine(repository, { resolver }));
      if (path === 'recovery') await service.recover();
      const run = await service.followUp(thread.id, body, threadScope);
      expect(run).toMatchObject({ id: reservation.runId, parentRunId: parent.id, threadSequence: 2 });
      expect(run.context.threadHistory).toEqual(reservation.contextSnapshot.history);
      await service.recover(); await service.followUp(thread.id, body, threadScope);
      expect(resolve).toHaveBeenCalledTimes(2); expect(model.complete).not.toHaveBeenCalled();
      expect(await repository.listRunsByThread(thread.id)).toHaveLength(2);
    });
    it.each(['skill.recorded', 'run.cancel.workflow_failed'])('commits despite late %s bookkeeping at the commit boundary', async type => {
      const commit = repository.createRunInThread.bind(repository);
      vi.spyOn(repository, 'createRunInThread').mockImplementationOnce(async (run, ...args) => {
        await repository.mutate(parent.id, current => {
          if (type === 'skill.recorded') current.skillOutcome = { outcome: 'success', receiptRef: 'receipt.late' };
          event(current, type, { receiptRef: 'receipt.late' });
        });
        return commit(run, ...args);
      });
      const run = await service.followUp(thread.id, body, threadScope);
      expect(run.threadSequence).toBe(2);
      const reservation = (await repository.getThreadFollowup(thread.id, followupHash(key), threadScope))!;
      expect((await repository.get(parent.id)).revision).toBeGreaterThan(reservation.parentRevision!);
      expect(reservation.state).toBe('completed');
    });
    it.each([
      ['skill.recorded', 'retry'], ['skill.recorded', 'recovery'],
      ['run.cancel.workflow_failed', 'retry'], ['run.cancel.workflow_failed', 'recovery'],
    ])('resumes a prepared child after %s through %s', async (type, path) => {
      const commit = vi.spyOn(repository, 'createRunInThread').mockRejectedValueOnce(new Error('interrupted before commit'));
      await expect(service.followUp(thread.id, body, threadScope)).rejects.toThrow('interrupted before commit');
      const reservation = (await repository.getThreadFollowup(thread.id, followupHash(key), threadScope))!;
      await repository.mutate(parent.id, current => {
        if (type === 'skill.recorded') current.skillOutcome = { outcome: 'success', receiptRef: 'receipt.late' };
        event(current, type, { receiptRef: 'receipt.late' });
      });
      commit.mockRestore();
      const recoveredEngine = new AgentEngine(repository, followupModel()), create = vi.spyOn(recoveredEngine, 'create');
      service = new ThreadService(repository, recoveredEngine);
      if (path === 'recovery') await service.recover();
      const run = await service.followUp(thread.id, body, threadScope);
      expect(run).toMatchObject({ id: reservation.runId, parentRunId: parent.id, threadSequence: 2 });
      expect(run.context.threadHistory).toEqual(reservation.contextSnapshot.history);
      expect(create).not.toHaveBeenCalled();
      expect(await repository.listRunsByThread(thread.id)).toHaveLength(2);
    });
    it.each([
      ['goal', (run: AgentRun) => { run.goal = 'changed historical content'; }],
      ['artifact', (run: AgentRun) => { run.artifacts[0]!.content = 'changed evidence'; }],
      ['classification', (run: AgentRun) => { run.context.sources[0]!.classification = 'private'; }],
      ['audience', (run: AgentRun) => { run.context.audience = ['bob']; }],
      ['credential redaction', (run: AgentRun) => { run.modelDecision = { credential: 'report' }; }],
    ] as const)('rejects changed parent %s at commit and on recovery', async (_field, change) => {
      const commit = repository.createRunInThread.bind(repository);
      const interrupted = vi.spyOn(repository, 'createRunInThread').mockImplementationOnce(async (run, ...args) => {
        await repository.mutate(parent.id, change);
        return commit(run, ...args);
      });
      await expect(service.followUp(thread.id, body, threadScope)).rejects.toThrow('unchanged since the history snapshot');
      interrupted.mockRestore();
      const reservation = (await repository.getThreadFollowup(thread.id, followupHash(key), threadScope))!;
      // The stored content hash, not a caller's replacement token, guards commit.
      await expect(repository.createRunInThread(reservation.contextSnapshot.run!, thread.id, parent.id, threadScope, undefined, reservation)).rejects.toThrow('unchanged since the history snapshot');
      await expect(service.followUp(thread.id, body, threadScope)).rejects.toThrow('unchanged since the history snapshot');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await service.recover();
      expect(await repository.listRunsByThread(thread.id)).toHaveLength(1);
      await expect(repository.get(reservation.runId)).rejects.toThrow(NotFound);
    });
    it('keeps the parent history hash immutable across checkpoint writes', async () => {
      vi.spyOn(repository, 'createRunInThread').mockRejectedValueOnce(new Error('interrupted before commit'));
      await expect(service.followUp(thread.id, body, threadScope)).rejects.toThrow('interrupted before commit');
      const reservation = (await repository.getThreadFollowup(thread.id, followupHash(key), threadScope))!;
      reservation.contextSnapshot.parentHistoryHash = '0'.repeat(64);
      await expect(repository.saveThreadFollowup(reservation, threadScope)).rejects.toThrow('Parent history hash is immutable');
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
    it('retries a failed connector preparation before any Run is committed', async () => {
      const search = vi.fn(async () => []).mockRejectedValueOnce(new Error('provider unavailable'));
      const resolver = new StaticModelResolver(followupModel()), resolve = vi.spyOn(resolver, 'resolve');
      service = new ThreadService(repository, new AgentEngine(repository, { resolver, knowledge: { search } }));
      const input = { ...body, request: { goal: 'next', knowledgeQuery: 'evidence' } };
      await expect(service.followUp(thread.id, input, threadScope)).rejects.toThrow('provider unavailable');
      expect(await repository.listRunsByThread(thread.id)).toHaveLength(1);
      const reservation = (await repository.getThreadFollowup(thread.id, followupHash(key), threadScope))!;
      expect(reservation.contextSnapshot.preparation?.knowledge).toEqual({ state: 'failed' });
      await new ThreadService(repository, new AgentEngine(repository, { resolver, knowledge: { search } })).recover();
      const run = await service.followUp(thread.id, input, threadScope);
      expect(run.id).toBe(reservation.runId); expect(search).toHaveBeenCalledTimes(2);
      await service.recover(); await service.followUp(thread.id, input, threadScope);
      expect(search).toHaveBeenCalledTimes(2);
      expect(resolve).toHaveBeenCalledOnce();
      expect(await repository.listRunsByThread(thread.id)).toHaveLength(2);
    });
    it.each(['read', 'semantic'])('freezes Brain %s results before the prepared Run checkpoint', async mode => {
      const brain = new GovernedBrain(), principal = { id: threadScope.owner, tenantId: threadScope.tenantId, roles: ['owner'] };
      const addClaim = (content: string) => brain.addClaim({ ...threadScope, scope: 'project', scopeRef: 'project', classification: 'internal', kind: 'fact', content, sourceRefs: [], confidence: 1 }, principal);
      const first = addClaim('Original evidence');
      let hits = [{ claimId: first.id, score: 1 }];
      const search = vi.fn(async () => hits), read = vi.spyOn(brain, 'read');
      const persistence = { init: vi.fn(), load: vi.fn(), save: vi.fn(async () => undefined), close: vi.fn() };
      const services = { model: followupModel(), brain, brainPersistence: persistence, brainSemanticSearcher: { search } };
      service = new ThreadService(repository, new AgentEngine(repository, services));
      const input = { ...body, request: { goal: 'next', brainScope: 'project', ...(mode === 'semantic' ? { brainQuery: 'evidence' } : {}) } };
      const save = repository.saveThreadFollowup.bind(repository);
      const checkpoint = vi.spyOn(repository, 'saveThreadFollowup').mockImplementation(async (record, scope) => {
        if (record.contextSnapshot.run) throw new Error('interrupted before prepared checkpoint');
        return save(record, scope);
      });
      await expect(service.followUp(thread.id, input, threadScope)).rejects.toThrow('interrupted before prepared checkpoint');
      const reservation = (await repository.getThreadFollowup(thread.id, followupHash(key), threadScope))!;
      expect(reservation.contextSnapshot.run).toBeUndefined();
      expect(reservation.contextSnapshot.preparation?.brain).toEqual({ state: 'completed', value: { claims: [first], audit: brain.auditLog().filter(entry => entry.action === 'read') } });
      await expect(repository.get(reservation.runId)).rejects.toThrow(NotFound);
      const later = addClaim('Evidence added between attempts'); hits = [...hits, { claimId: later.id, score: 0.9 }];
      checkpoint.mockRestore();
      service = new ThreadService(repository, new AgentEngine(repository, services));
      await service.recover();
      const run = await service.followUp(thread.id, input, threadScope);
      expect(run.context.sources.filter(source => source.kind === 'brain')).toMatchObject([{ id: first.id, content: first.content }]);
      expect(run.context.sources.some(source => source.id === later.id)).toBe(false);
      await service.recover(); await service.followUp(thread.id, input, threadScope);
      expect(mode === 'semantic' ? search : read).toHaveBeenCalledOnce();
      expect(persistence.save).toHaveBeenCalledOnce();
      expect(await repository.listRunsByThread(thread.id)).toHaveLength(2);
    });
    it.each([
      ['read', 'retry'], ['read', 'recovery'], ['semantic', 'retry'], ['semantic', 'recovery'],
    ])('preserves Brain %s retrieval and audit after a persistence failure through %s', async (mode, path) => {
      const brain = new GovernedBrain(), principal = { id: threadScope.owner, tenantId: threadScope.tenantId, roles: ['owner'] };
      const claimInput = { ...threadScope, scope: 'project' as const, scopeRef: 'project', classification: 'internal' as const, kind: 'fact' as const, content: 'Original evidence', sourceRefs: [], confidence: 1 };
      const first = brain.addClaim(claimInput, principal);
      let persisted = brain.state(), hits = [{ claimId: first.id, score: 1 }];
      const search = vi.fn(async () => hits), read = vi.spyOn(brain, 'read');
      const persistence = {
        init: vi.fn(), load: vi.fn(async () => GovernedBrain.fromState(persisted)), close: vi.fn(),
        save: vi.fn(async (current: GovernedBrain) => { persisted = current.state(); }).mockRejectedValueOnce(new Error('Brain persistence unavailable')),
      };
      const services = { model: followupModel(), brain, brainPersistence: persistence, brainSemanticSearcher: { search } };
      service = new ThreadService(repository, new AgentEngine(repository, services));
      const input = { ...body, request: { goal: 'next', brainScope: 'project', ...(mode === 'semantic' ? { brainQuery: 'evidence' } : {}) } };
      await expect(service.followUp(thread.id, input, threadScope)).rejects.toThrow('Brain persistence unavailable');
      const reservation = (await repository.getThreadFollowup(thread.id, followupHash(key), threadScope))!;
      await expect(repository.get(reservation.runId)).rejects.toThrow(NotFound);
      const audit = brain.auditLog().filter(entry => entry.action === 'read');
      expect(audit).toHaveLength(1);
      // Simulate boot from durable Brain state, where the failed save left no read audit.
      const restored = await persistence.load(), restoredRead = vi.spyOn(restored, 'read');
      const later = restored.addClaim({ ...claimInput, content: 'Evidence added between attempts' }, principal);
      persisted = restored.state(); hits = [...hits, { claimId: later.id, score: 0.9 }];
      service = new ThreadService(repository, new AgentEngine(repository, { ...services, brain: restored }));
      if (path === 'recovery') await service.recover();
      const run = await service.followUp(thread.id, input, threadScope);
      expect(mode === 'semantic' ? search : read).toHaveBeenCalledOnce();
      expect(restoredRead).not.toHaveBeenCalled();
      expect(run.context.sources.filter(source => source.kind === 'brain')).toMatchObject([{ id: first.id, content: first.content }]);
      expect(persisted.audit.filter(entry => entry.action === 'read')).toEqual(audit);
      expect(persisted.claims.map(claim => claim.id)).toEqual([first.id, later.id]);
      await service.recover(); await service.followUp(thread.id, input, threadScope);
      expect(persistence.save).toHaveBeenCalledTimes(2);
      expect(await repository.listRunsByThread(thread.id)).toHaveLength(2);
    });
    it('reuses legacy claim-only Brain checkpoints without another read or audit save', async () => {
      const brain = new GovernedBrain(), principal = { id: threadScope.owner, tenantId: threadScope.tenantId, roles: ['owner'] };
      const first = brain.addClaim({ ...threadScope, scope: 'project', scopeRef: 'project', classification: 'internal', kind: 'fact', content: 'Original evidence', sourceRefs: [], confidence: 1 }, principal);
      const input = { ...body, request: { goal: 'next', brainScope: 'project' } };
      await expect(new ThreadService(repository).followUp(thread.id, input, threadScope)).rejects.toThrow('Model runtime is not configured');
      const reservation = (await repository.getThreadFollowup(thread.id, followupHash(key), threadScope))!;
      reservation.contextSnapshot.preparation = { brain: { state: 'completed', value: [first] } };
      await repository.saveThreadFollowup(reservation, threadScope);
      brain.addClaim({ ...threadScope, scope: 'project', scopeRef: 'project', classification: 'internal', kind: 'fact', content: 'Later evidence', sourceRefs: [], confidence: 1 }, principal);
      const read = vi.spyOn(brain, 'read'), persistence = { init: vi.fn(), load: vi.fn(), save: vi.fn(), close: vi.fn() };
      service = new ThreadService(repository, new AgentEngine(repository, { model: followupModel(), brain, brainPersistence: persistence }));
      await service.recover();
      const run = await service.followUp(thread.id, input, threadScope);
      expect(run.context.sources.filter(source => source.kind === 'brain')).toMatchObject([{ id: first.id, content: first.content }]);
      expect(read).not.toHaveBeenCalled(); expect(persistence.save).not.toHaveBeenCalled();
    });
    it('keeps an unpublished connector result reserved and never automatically resends it', async () => {
      const search = vi.fn(async () => []);
      service = new ThreadService(repository, new AgentEngine(repository, { model: followupModel(), knowledge: { search } }));
      const input = { ...body, request: { goal: 'next', knowledgeQuery: 'evidence' } };
      const save = repository.saveThreadFollowup.bind(repository);
      const checkpoint = vi.spyOn(repository, 'saveThreadFollowup').mockImplementation(async (record, scope) => {
        if (record.contextSnapshot.preparation?.knowledge?.state === 'completed') throw new Error('checkpoint publication failed');
        return save(record, scope);
      });
      await expect(service.followUp(thread.id, input, threadScope)).rejects.toThrow('checkpoint publication failed');
      checkpoint.mockRestore();
      await expect(service.followUp(thread.id, input, threadScope)).rejects.toThrow('unknown outcome');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await service.recover();
      expect(search).toHaveBeenCalledOnce();
      expect(await repository.listRunsByThread(thread.id)).toHaveLength(1);
    });
  });
}
