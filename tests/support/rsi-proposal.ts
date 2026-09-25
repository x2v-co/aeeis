import type { AgentRun } from '../../src/runtime/contracts.js';

export function runWithSignals(): AgentRun {
  return {
    schemaVersion: 1, id: 'run_00000000-0000-4000-8000-000000000011', revision: 1, owner: 'alice', tenantId: 'team-a',
    goal: 'Improve reports', status: 'succeeded', createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:01.000Z',
    context: { id: 'ctx_1', audience: ['alice'], sources: [{ id: 'source_1', title: 'brief', content: 'brief', source: 'test', hash: 'a'.repeat(64) }] },
    privacy: 'internal', model: { model: 'fixture', endpoint: 'http://127.0.0.1', promptVersion: 'fixture/1' }, maxModelCalls: 10,
    modelUsage: { tokens: 0, unreportedCalls: 0 }, calls: [], allowedTools: [], allowedAgents: [], knowledgeMaxItems: 8, brainMaxItems: 20, toolReceipts: [],
    delegationOutcomes: [], plans: [], steps: [], artifacts: [{ id: 'artifact_1', taskId: 'task_1', title: 'report', content: 'report', evidenceRefs: ['source_1'], hash: 'b'.repeat(64), createdAt: '2026-09-20T00:00:01.000Z' }],
    events: [
      { id: 'evt_low', seq: 1, type: 'review.completed', at: '2026-09-20T00:00:01.000Z', data: { reviewConfidence: 0.2 } },
      { id: 'evt_proposal', seq: 2, type: 'review.completed', at: '2026-09-20T00:00:02.000Z', data: { reviewConfidence: 0.2, proposal: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Cite evidence first', reason: 'Review confidence was low', risk: 'low', sourceReceiptRefs: ['artifact_1'] } } },
    ], answers: [],
  };
}

