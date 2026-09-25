import { describe, expect, it } from 'vitest';
import { explainRun } from '../src/runtime/explanation.js';
import type { AgentRun } from '../src/runtime/contracts.js';

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    schemaVersion: 1, id: 'run_explanation', revision: 1, owner: 'alice', tenantId: 'team-a', goal: 'Ship the release', status: 'needs_approval',
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:01:00.000Z', privacy: 'internal',
    context: { id: 'ctx_1', audience: ['alice'], memoryManifestId: 'manifest_1', memoryManifestHash: 'm'.repeat(64), memoryRefs: ['memory_1'], sources: [{ id: 'source_1', title: 'Brief', content: 'private source content', source: 'user', hash: 's'.repeat(64) }] },
    model: { model: 'fixture', provider: 'local', endpoint: 'http://127.0.0.1/chat/completions', promptVersion: 'fixture/1' }, modelDecision: { selected: { model: 'fixture', provider: 'local' }, catalogHash: 'catalog_1' },
    maxModelCalls: 10, calls: [{ id: 'call_1', phase: 'planner', state: 'completed', inputHash: 'i'.repeat(64), startedAt: '2026-09-21T00:00:01.000Z', endedAt: '2026-09-21T00:00:02.000Z' }],
    allowedTools: [], allowedAgents: [], approvedTools: [{ id: 'search', version: '2', capabilities: ['read'] }], approvedAgents: [{ agentId: 'agent.research', name: 'Research', cardVersion: '1', capabilities: [], inputSchemas: [], outputSchemas: [], privacy: { dataRetention: 'none', regions: ['local'] }, pricing: { unit: 'run' }, cardDigest: 'a'.repeat(64) }], toolReceipts: [], delegationOutcomes: [],
    plans: [{ summary: 'Release plan', nodes: [{ id: 'research', title: 'Research', instruction: 'Research', dependsOn: [] }, { id: 'ship', title: 'Ship', instruction: 'Ship', dependsOn: ['research'] }], version: 1, hash: 'p'.repeat(64), createdAt: '2026-09-21T00:00:00.000Z' }],
    steps: [{ taskId: 'research', status: 'succeeded', attempts: 1, observations: [] }, { taskId: 'ship', status: 'pending', attempts: 0, observations: [] }], artifacts: [], events: [], answers: [],
    modelBudget: { tokens: 1000 }, modelUsage: { tokens: 10, unreportedCalls: 0 },
    ...overrides,
  };
}

describe('run explanation projection', () => {
  it('explains the next human action and preserves only bounded facts', () => {
    const explanation = explainRun(makeRun());
    expect(explanation.schemaVersion).toBe('run-explanation/1');
    expect(explanation.attention.kind).toBe('approve_plan');
    expect(explanation.plan.readyTaskIds).toEqual(['ship']);
    expect(explanation.evidence).toMatchObject({ sourceCount: 1, artifactCount: 0, contextManifestId: 'manifest_1', memoryRefs: ['memory_1'] });
    expect(JSON.stringify(explanation)).not.toContain('private source content');
    expect(explanation.governance.tools).toEqual([{ id: 'search', version: '2', capabilities: ['read'] }]);
  });

  it('turns unknown external results into an explicit reconcile action', () => {
    const explanation = explainRun(makeRun({ status: 'unknown', pendingTool: { taskId: 'research', toolId: 'search', requestedAt: '2026-09-21T00:00:03.000Z', idempotencyKey: 'tool:1', receiptId: 'receipt_1' } }));
    expect(explanation.attention).toMatchObject({ kind: 'reconcile_external' });
    expect(explanation.attention.blockers[0]?.refs).toEqual(['receipt_1']);
  });

  it('surfaces a rejected Agent response without exposing its payload', () => {
    const explanation = explainRun(makeRun({ status: 'unknown', pendingDelegation: {
      agentId: 'agent.research', taskBrief: { schemaVersion: 'task-brief/1', taskId: 'task.external', goal: 'Research', nonGoals: [], contextManifestId: 'ctx_1', knownFacts: [], constraints: [], expectedOutput: 'research/1', budget: {}, allowedCapabilities: [] },
      contextPack: { schemaVersion: 'context-pack/1', id: 'ctx_1', taskId: 'task.external', version: 1, audience: ['agent.research'], classification: 'internal', expiresAt: '2027-01-01T00:00:00.000Z', sourceRefs: [], artifactRefs: [], claims: [], redactions: [], digest: 'c'.repeat(64) },
      grant: { schemaVersion: 'delegation-grant/1', grantId: 'grant_1', subjectAgentId: 'agent.research', issuerAgentId: 'aeeis.owner', taskId: 'task.external', purpose: 'Research', actions: ['return_result'], resourceRefs: [], dataScope: 'internal', issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', budget: {}, delegationChain: [], revocationRef: 'revoke_1', nonce: 'nonce-1234567890123456' },
      mode: 'sync', idempotencyKey: 'agent:1', failure: { kind: 'protocol', message: 'schema mismatch', responseRejected: true },
    } }));
    expect(explanation.attention.blockers[0]?.detail).toContain('protocol');
    expect(explanation.attention.blockers[0]?.detail).toContain('schema mismatch');
  });
});
