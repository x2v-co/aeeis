import { describe, expect, it } from 'vitest';
import { CollaborationService } from '../src/collaboration-service.js';
import { PostgresCollaborationRepository } from '../src/collaboration-service.js';
import { CollaborationTriggerService, PostgresCollaborationTriggerStore } from '../src/collaboration-triggers.js';
import { CollaborationTriggerPump } from '../src/collaboration-trigger-pump.js';
import { PostgresRunRepository } from '../src/runtime/repository.js';
import type { AgentRun } from '../src/runtime/contracts.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

function fixtureRun(id: string, owner: string, tenantId: string, eventId: string): AgentRun {
  return {
    schemaVersion: 1,
    id,
    revision: 1,
    owner,
    tenantId,
    goal: 'Select a safe release plan',
    status: 'succeeded',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:01.000Z',
    context: {
      id: 'ctx_release',
      audience: [`${owner}@${tenantId}`],
      sources: [{
        id: 'source_release',
        title: 'Release brief',
        content: 'The release must be staged.',
        source: 'fixture',
        hash: 'a'.repeat(64),
        classification: 'internal',
      }],
    },
    privacy: 'internal',
    model: { model: 'fixture', endpoint: 'http://127.0.0.1:4399', promptVersion: 'fixture/1' },
    maxModelCalls: 10,
    modelUsage: { tokens: 0, unreportedCalls: 0 },
    calls: [],
    allowedTools: [],
    allowedAgents: ['agent.one', 'agent.two'],
    knowledgeMaxItems: 8,
    brainMaxItems: 20,
    toolReceipts: [],
    delegationOutcomes: [],
    plans: [],
    steps: [{ taskId: 'task_release', status: 'succeeded', attempts: 1, observations: [] }],
    artifacts: [{
      id: 'artifact_release',
      taskId: 'task_release',
      title: 'Release plan',
      content: 'Use a staged rollout.',
      evidenceRefs: ['source_release'],
      hash: 'b'.repeat(64),
      createdAt: '2026-09-20T00:00:01.000Z',
    }],
    events: [{
      id: eventId,
      seq: 1,
      type: 'task.completed',
      at: '2026-09-20T00:00:01.000Z',
      data: { taskId: 'task_release', evidenceRefs: ['artifact_release'] },
    }],
    answers: [],
  };
}

describe('PostgreSQL collaboration trigger pump', () => {
  it.skipIf(!databaseUrl).each([0, 60_000])('is idempotent across concurrent pumps and restart with cooldown=%i while isolating owner and tenant', async (cooldownMs) => {
    const db = await isolatedPostgres(databaseUrl!);
    const runStoreA = new PostgresRunRepository(db.url);
    const runStoreB = new PostgresRunRepository(db.url);
    const collaborationStoreA = new PostgresCollaborationRepository(db.url);
    const collaborationStoreB = new PostgresCollaborationRepository(db.url);
    const triggerStoreA = new PostgresCollaborationTriggerStore(db.url);
    const triggerStoreB = new PostgresCollaborationTriggerStore(db.url);
    try {
      // Both API processes may bootstrap a fresh schema at the same time.
      // Each adapter's transaction advisory migration lock must serialize its
      // own DDL and backfill path.
      await Promise.all([
        runStoreA.init(), runStoreB.init(),
        collaborationStoreA.init(), collaborationStoreB.init(),
        triggerStoreA.init(), triggerStoreB.init(),
      ]);

      await runStoreA.create(fixtureRun('run_00000000-0000-4000-8000-000000000101', 'alice', 'team-a', 'evt_alice'));
      await runStoreA.create(fixtureRun('run_00000000-0000-4000-8000-000000000102', 'bob', 'team-b', 'evt_bob'));
      if (cooldownMs > 0) {
        await runStoreA.create(fixtureRun('run_00000000-0000-4000-8000-000000000103', 'alice', 'team-a', 'evt_alice_second'));
      }

      const collaborationA = new CollaborationService(collaborationStoreA);
      const collaborationB = new CollaborationService(collaborationStoreB);
      const triggersA = new CollaborationTriggerService(triggerStoreA, collaborationA);
      const triggersB = new CollaborationTriggerService(triggerStoreB, collaborationB);
      const policy = {
        id: 'policy.release.competition',
        name: 'Compare release plans',
        enabled: true,
        eventTypes: ['task.completed' as const],
        action: {
          type: 'competition' as const,
          participantAgentIds: ['agent.one', 'agent.two'],
          evaluatorAgentId: 'agent.evaluator',
          expectedResultType: 'plan/1',
          maxRounds: 1,
          blindEvaluation: true,
          dispatch: 'create' as const,
        },
        cooldownMs,
      };
      await triggersA.createPolicy(policy, { owner: 'alice', tenantId: 'team-a' });

      // Two API processes can discover the same durable Run event concurrently.
      // The trigger store's unique (policy_id, event_id) claim must leave one
      // decision and one Competition aggregate.
      const pumpErrors: unknown[] = [];
      const [first, second] = await Promise.all([
        new CollaborationTriggerPump(runStoreA, triggersA, { onError: error => pumpErrors.push(error) }).pump(),
        new CollaborationTriggerPump(runStoreB, triggersB, { onError: error => pumpErrors.push(error) }).pump(),
      ]);
      expect(first.failed + second.failed, JSON.stringify(pumpErrors)).toBe(0);
      expect(first.evaluated + second.evaluated).toBeGreaterThan(0);
      expect(await collaborationA.listCompetitions({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(1);
      expect(await collaborationA.listCompetitions({ owner: 'bob', tenantId: 'team-b' })).toHaveLength(0);
      expect(await triggersA.listDecisions({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(1);
      expect(await triggersA.listDecisions({ owner: 'bob', tenantId: 'team-b' })).toHaveLength(0);

      // Recreate the repositories to model a process restart. Replaying the
      // Run event must return the existing decision/resource without creating
      // another Competition.
      await Promise.all([runStoreA.close(), runStoreB.close(), collaborationStoreA.close(), collaborationStoreB.close(), triggerStoreA.close(), triggerStoreB.close()]);
      const runStoreAfterRestart = new PostgresRunRepository(db.url);
      const collaborationStoreAfterRestart = new PostgresCollaborationRepository(db.url);
      const triggerStoreAfterRestart = new PostgresCollaborationTriggerStore(db.url);
      await Promise.all([runStoreAfterRestart.init(), collaborationStoreAfterRestart.init(), triggerStoreAfterRestart.init()]);
      try {
        const collaborationAfterRestart = new CollaborationService(collaborationStoreAfterRestart);
        const triggersAfterRestart = new CollaborationTriggerService(triggerStoreAfterRestart, collaborationAfterRestart);
        const replay = await new CollaborationTriggerPump(runStoreAfterRestart, triggersAfterRestart).pump();
        expect(replay.failed).toBe(0);
        expect(await collaborationAfterRestart.listCompetitions({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(1);
        expect(await triggersAfterRestart.listDecisions({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(1);
      } finally {
        await Promise.all([runStoreAfterRestart.close(), collaborationStoreAfterRestart.close(), triggerStoreAfterRestart.close()]);
      }
    } finally {
      // The restart branch closes these stores before reaching here. The
      // close methods are intentionally idempotent for test cleanup.
      await Promise.allSettled([runStoreA.close(), runStoreB.close(), collaborationStoreA.close(), collaborationStoreB.close(), triggerStoreA.close(), triggerStoreB.close()]);
      await db.close();
    }
  });
});
