import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollaborationService, FileCollaborationRepository } from '../src/collaboration-service.js';
import { CollaborationTriggerService, FileCollaborationTriggerStore } from '../src/collaboration-triggers.js';

const scope = { owner: 'alice', tenantId: 'team-a' };
const event = {
  schemaVersion: 'collaboration-trigger-event/1' as const,
  eventId: 'review:run_123:v1', eventType: 'review.completed' as const, source: 'system' as const,
  owner: scope.owner, tenantId: scope.tenantId, taskId: 'task.release', contextVersion: 'ctx.1',
  goal: 'Choose the safest release plan', risk: 'high' as const, reviewConfidence: 0.42,
  requiredDiversity: 2, allowedAgentIds: ['agent.one', 'agent.two'],
  occurredAt: new Date().toISOString(), evidenceRefs: ['artifact.release'],
};

describe('durable collaboration triggers', () => {
  it('serializes different events through one cooldown window', async () => {
    const collaborationRepository = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-trigger-concurrent-collab-')));
    const triggerStore = new FileCollaborationTriggerStore(await mkdtemp(join(tmpdir(), 'aeeis-trigger-concurrent-store-')));
    await collaborationRepository.init(); await triggerStore.init();
    try {
      const collaboration = new CollaborationService(collaborationRepository);
      const first = new CollaborationTriggerService(triggerStore, collaboration);
      const second = new CollaborationTriggerService(triggerStore, collaboration);
      await first.createPolicy({
        id: 'policy.concurrent', name: 'One review window', enabled: true,
        eventTypes: ['review.completed'],
        action: { type: 'debate', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1 },
        cooldownMs: 60_000,
      }, scope);
      const occurredAt = new Date().toISOString();
      const eventA = { ...event, eventId: 'review:concurrent:a', occurredAt, requiredDiversity: undefined };
      const eventB = { ...event, eventId: 'review:concurrent:b', occurredAt, requiredDiversity: undefined };
      const history = vi.spyOn(triggerStore, 'listDecisions');
      const results = await Promise.all([first.evaluate(eventA, scope), second.evaluate(eventB, scope)]);
      expect(history).not.toHaveBeenCalled();
      expect(results.flat().filter(item => item.created)).toHaveLength(1);
      expect(await collaboration.listDebates(scope)).toHaveLength(1);
      expect(await triggerStore.listDecisions(scope, 'policy.concurrent')).toHaveLength(1);

      // A producer clock that is ahead of the store clock cannot bypass the
      // existing window by making eventTime appear newer than admission.
      const future = { ...event, eventId: 'review:concurrent:future', occurredAt: '2999-01-01T00:00:00.000Z', requiredDiversity: undefined };
      expect(await first.evaluate(future, scope)).toEqual([]);
    } finally { await triggerStore.close(); await collaborationRepository.close(); }
  });

  it('matches governed event conditions and creates an idempotent Competition', async () => {
    const collaborationRepository = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-trigger-collab-')));
    const triggerStore = new FileCollaborationTriggerStore(await mkdtemp(join(tmpdir(), 'aeeis-trigger-store-')));
    await collaborationRepository.init(); await triggerStore.init();
    try {
      const collaboration = new CollaborationService(collaborationRepository);
      let dispatched = 0;
      const triggers = new CollaborationTriggerService(triggerStore, collaboration, {
        runCompetition: async () => { dispatched += 1; },
        runDebate: async () => { dispatched += 1; },
      });
      await triggers.createPolicy({
        id: 'policy.release', name: 'Independent release review', enabled: true,
        eventTypes: ['review.completed'], riskAtLeast: 'high', reviewConfidenceAtMost: 0.6,
        requiredDiversityAtLeast: 2,
        action: { type: 'competition', participantAgentIds: ['agent.one', 'agent.two'], evaluatorAgentId: 'agent.evaluator', expectedResultType: 'plan/1', maxRounds: 2, blindEvaluation: true, dispatch: 'run' }, cooldownMs: 60_000,
      }, scope);
      const first = await triggers.evaluate(event, scope);
      expect(first).toHaveLength(1); expect(first[0]!.created).toBe(true); expect(first[0]!.decision.state).toBe('triggered'); expect(first[0]!.decision.dispatchState).toBe('completed'); expect(dispatched).toBe(1);
      const competitions = await collaboration.listCompetitions(scope);
      expect(competitions).toHaveLength(1);
      expect(competitions[0]!.brief.participantAgentIds).toEqual(['agent.one', 'agent.two']);

      const duplicate = await triggers.evaluate(event, scope);
      expect(duplicate[0]!.created).toBe(false); expect(duplicate[0]!.decision.resourceId).toBe(competitions[0]!.id);
      expect(await triggers.evaluate({ ...event, eventId: 'review:run_124:v1' }, scope)).toEqual([]);
      expect(await collaboration.listCompetitions(scope)).toHaveLength(1);
      expect((await triggers.listDecisions(scope)).map(item => item.state)).toEqual(['triggered']);
    } finally { await triggerStore.close(); await collaborationRepository.close(); }
  });

  it('does not cross tenant boundaries and ignores events that do not meet policy conditions', async () => {
    const collaborationRepository = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-trigger-scope-collab-')));
    const triggerStore = new FileCollaborationTriggerStore(await mkdtemp(join(tmpdir(), 'aeeis-trigger-scope-store-')));
    await collaborationRepository.init(); await triggerStore.init();
    try {
      const triggers = new CollaborationTriggerService(triggerStore, new CollaborationService(collaborationRepository));
      await triggers.createPolicy({ id: 'policy.debate', name: 'Low confidence debate', enabled: true, eventTypes: ['review.completed'], reviewConfidenceAtMost: 0.5, action: { type: 'debate', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1 } }, scope);
      expect(await triggers.evaluate({ ...event, eventId: 'review:run_123:v2', reviewConfidence: 0.9 }, scope)).toEqual([]);
      await expect(triggers.evaluate({ ...event, owner: 'bob' }, scope)).rejects.toThrow('ownership');
      expect(await triggers.evaluate({ ...event, eventId: 'review:run_456:v1', owner: 'bob', tenantId: 'team-b', reviewConfidence: 0.2 })).toEqual([]);
      expect(await triggers.listPolicies({ owner: 'bob', tenantId: 'team-b' })).toEqual([]);
    } finally { await triggerStore.close(); await collaborationRepository.close(); }
  });

  it('reconciles a crash window by binding a created resource or recording an explicit failure', async () => {
    const collaborationRepository = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-trigger-reconcile-collab-')));
    const triggerStore = new FileCollaborationTriggerStore(await mkdtemp(join(tmpdir(), 'aeeis-trigger-reconcile-store-')));
    await collaborationRepository.init(); await triggerStore.init();
    try {
      const triggers = new CollaborationTriggerService(triggerStore, new CollaborationService(collaborationRepository));
      await triggers.createPolicy({ id: 'policy.reconcile', name: 'Reconcile', enabled: true, eventTypes: ['review.completed'], action: { type: 'debate', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1 } }, scope);
      const started = await triggerStore.claimDecision({ schemaVersion: 1, id: 'trigger_reconcile_resource', policyId: 'policy.reconcile', eventId: 'review:reconcile:resource', owner: scope.owner, tenantId: scope.tenantId, state: 'started', actionType: 'debate', dispatchState: 'not_requested', startedAt: new Date().toISOString() });
      const bound = await triggers.reconcileDecision(started.decision.id, { outcome: 'resource_created', resourceId: 'debate.confirmed', reason: 'Operator confirmed the resource in the collaboration store' }, scope);
      expect(bound).toMatchObject({ state: 'triggered', resourceId: 'debate.confirmed', dispatchState: 'not_requested' });
      await expect(triggers.reconcileDecision(started.decision.id, { outcome: 'failed', reason: 'duplicate attempt' }, scope)).rejects.toThrow('Creation failure reconciliation');

      const failed = await triggerStore.claimDecision({ schemaVersion: 1, id: 'trigger_reconcile_failed', policyId: 'policy.reconcile', eventId: 'review:reconcile:failed', owner: scope.owner, tenantId: scope.tenantId, state: 'started', actionType: 'debate', dispatchState: 'not_requested', startedAt: new Date().toISOString() });
      const marked = await triggers.reconcileDecision(failed.decision.id, { outcome: 'failed', reason: 'Resource creation was verified absent' }, scope);
      expect(marked).toMatchObject({ state: 'failed', dispatchState: 'failed', error: 'Resource creation was verified absent' });
    } finally { await triggerStore.close(); await collaborationRepository.close(); }
  });

  it('keeps dispatch unknown until an explicit completed or failed reconciliation', async () => {
    const collaborationRepository = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-trigger-dispatch-collab-')));
    const triggerStore = new FileCollaborationTriggerStore(await mkdtemp(join(tmpdir(), 'aeeis-trigger-dispatch-store-')));
    await collaborationRepository.init(); await triggerStore.init();
    try {
      const collaboration = new CollaborationService(collaborationRepository);
      const triggers = new CollaborationTriggerService(triggerStore, collaboration, { runCompetition: async () => { throw new Error('provider response lost'); }, runDebate: async () => { throw new Error('provider response lost'); } });
      await triggers.createPolicy({ id: 'policy.dispatch', name: 'Dispatch', enabled: true, eventTypes: ['review.completed'], action: { type: 'debate', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1, dispatch: 'run' } }, scope);
      const [created] = await triggers.evaluate({ ...event, eventId: 'review:dispatch:unknown', requiredDiversity: undefined }, scope);
      expect(created!.decision.dispatchState).toBe('unknown');
      const completed = await triggers.reconcileDecision(created!.decision.id, { outcome: 'dispatch_completed', reason: 'Provider receipt confirmed execution' }, scope);
      expect(completed.dispatchState).toBe('completed');
    } finally { await triggerStore.close(); await collaborationRepository.close(); }
  });
});
