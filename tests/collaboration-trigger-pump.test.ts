import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileRunScanCursorStore } from '../src/run-scan-cursor.js';
import { CollaborationTriggerPump, runEventToCollaborationTrigger } from '../src/collaboration-trigger-pump.js';
import { CollaborationTriggerService, FileCollaborationTriggerStore } from '../src/collaboration-triggers.js';
import { CollaborationService, FileCollaborationRepository } from '../src/collaboration-service.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { AgentRun } from '../src/runtime/contracts.js';

function fixtureRun(): AgentRun {
  return {
    schemaVersion: 1, id: 'run_00000000-0000-4000-8000-000000000001', revision: 1,
    owner: 'alice', tenantId: 'team-a', goal: 'Choose a release plan', status: 'succeeded',
    createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:01.000Z',
    context: { id: 'ctx_1', audience: ['alice@team-a'], sources: [{ id: 'source_1', title: 'Brief', content: 'Release constraints', source: 'fixture', hash: 'a'.repeat(64), classification: 'internal' }] },
    privacy: 'internal', model: { model: 'fixture', endpoint: 'http://127.0.0.1:4399', promptVersion: 'fixture/1' },
    maxModelCalls: 10, modelUsage: { tokens: 0, unreportedCalls: 0 }, calls: [],
    allowedTools: [], allowedAgents: ['agent.one', 'agent.two'], knowledgeMaxItems: 8,
    brainMaxItems: 20, toolReceipts: [], delegationOutcomes: [], plans: [],
    steps: [{ taskId: 'task_release', status: 'succeeded', attempts: 1, observations: [] }],
    artifacts: [{ id: 'artifact_1', taskId: 'task_release', title: 'Plan', content: 'Use staged rollout', evidenceRefs: ['source_1'], hash: 'b'.repeat(64), createdAt: '2026-09-20T00:00:01.000Z' }],
    events: [{ id: 'evt_completed_1', seq: 1, type: 'task.execution.completed', at: '2026-09-20T00:00:01.000Z', data: { taskId: 'task_release', evidenceRefs: ['artifact_1'] } }],
    answers: [],
  };
}

describe('durable collaboration trigger pump', () => {
  it('replays legacy Runs without inventing admission or reducing privacy', () => {
    const run = fixtureRun();
    Reflect.deleteProperty(run, 'allowedAgents');
    Reflect.deleteProperty(run, 'privacy');
    expect(runEventToCollaborationTrigger(run, run.events[0]!)).toMatchObject({
      allowedAgentIds: [], context: { classification: 'private' },
    });
  });

  it.each([false, true])('replays Run lifecycle events into idempotent collaboration resources (durable scan: %s)', async durable => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-trigger-pump-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const collaborations = new FileCollaborationRepository(join(directory, 'collaboration')); await collaborations.init();
    const triggerStore = new FileCollaborationTriggerStore(join(directory, 'triggers')); await triggerStore.init();
    const scanCursors = new FileRunScanCursorStore(join(directory, 'scans.json')); await scanCursors.init();
    try {
      await runs.create(fixtureRun());
      await runs.create({ ...fixtureRun(), id: 'run_00000000-0000-4000-8000-000000000002', events: [{ id: 'evt_completed_2', seq: 1, type: 'task.execution.completed', at: '2026-09-20T00:00:02.000Z', data: { taskId: 'task_release', evidenceRefs: ['artifact_1'] } }] });
      const collaboration = new CollaborationService(collaborations);
      const triggers = new CollaborationTriggerService(triggerStore, collaboration);
      await triggers.createPolicy({
        name: 'Compare completed task outputs', enabled: true, eventTypes: ['task.completed'],
        action: { type: 'competition', participantAgentIds: ['agent.one', 'agent.two'], evaluatorAgentId: 'agent.evaluator', expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: true, dispatch: 'create' },
        id: 'policy_task_compete', cooldownMs: 0,
      }, { owner: 'alice', tenantId: 'team-a' });
      const fullScan = durable ? vi.spyOn(runs, 'list').mockRejectedValue(new Error('Full scan forbidden')) : undefined;
      const pump = new CollaborationTriggerPump(runs, triggers, { maxEventsPerPass: 1, ...(durable ? { scanCursorStore: scanCursors, scanPageSize: 1 } : {}) });
      expect((await pump.pump()).evaluated).toBe(1);
      expect((await pump.pump()).evaluated).toBe(1);
      expect(await collaboration.listCompetitions({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(2);
      expect(await triggerStore.listDecisions({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(2);
      await pump.pump(); await pump.pump();
      expect(await collaboration.listCompetitions({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(2);
      if (fullScan) expect(fullScan).not.toHaveBeenCalled();
    } finally {
      await scanCursors.close(); await triggerStore.close(); await collaborations.close(); await runs.close();
    }
  });

  it('maps a failed Run to task.failed and preserves the admitted-agent boundary', () => {
    const run = fixtureRun();
    const failed = runEventToCollaborationTrigger(run, { id: 'evt_failed_1', seq: 2, type: 'run.failed', at: '2026-09-20T00:00:02.000Z', data: { reason: 'provider error' } });
    expect(failed).toMatchObject({ eventType: 'task.failed', taskId: 'task_release', allowedAgentIds: ['agent.one', 'agent.two'] });
    expect(failed?.context?.claims[0]).toMatchObject({ id: 'source_1', evidenceRefs: ['source_1'] });
    const review = runEventToCollaborationTrigger(run, { id: 'evt_review_1', seq: 3, type: 'review.completed', at: '2026-09-20T00:00:03.000Z', data: { verdict: 'needs_revision', reviewConfidence: 0.2 } });
    expect(review).toMatchObject({ eventType: 'review.completed', reviewConfidence: 0.2 });
  });
});
