import { describe, expect, it } from 'vitest';
import { AgentDirectory, AgentGateway } from '../src/agent-gateway.js';
import { createContextPack, type AgentCard, type DelegationGrant, type TaskBrief } from '../src/protocol.js';
import type { AgentTransport, AgentTransportResponse, DelegationRequest } from '../src/agent-gateway.js';

const date = '2030-01-01T00:00:00.000Z';
const card: AgentCard = {
  schemaVersion: 'agent-card/1', agentId: 'agent.external', name: 'External Researcher', owner: 'partner',
  protocols: ['aeeis-task/1'], capabilities: ['research'], inputSchemas: ['task-brief/1'], outputSchemas: ['result-envelope/1'],
  auth: ['local'], privacy: { dataRetention: 'session', regions: ['local'] }, pricing: { unit: 'run' }, cardVersion: '1',
};
const brief: TaskBrief = {
  schemaVersion: 'task-brief/1', taskId: 'task.external', goal: 'Research a bounded question', nonGoals: [], contextManifestId: 'ctx.external',
  knownFacts: [], constraints: [], expectedOutput: 'research/1', budget: {}, allowedCapabilities: ['research'],
};
const context = createContextPack({ schemaVersion: 'context-pack/1', id: 'ctx.external', taskId: 'task.external', version: 1, audience: ['agent.external'], classification: 'public', expiresAt: date, sourceRefs: [], artifactRefs: [], claims: [], redactions: [] });
const grant: DelegationGrant = {
  schemaVersion: 'delegation-grant/1', grantId: 'grant.external', subjectAgentId: 'agent.external', issuerAgentId: 'aeeis.owner', taskId: 'task.external',
  purpose: 'Return a research candidate', actions: ['return_result'], resourceRefs: [], dataScope: 'public', issuedAt: '2029-01-01T00:00:00.000Z', expiresAt: date,
  budget: { calls: 1 }, delegationChain: [], revocationRef: 'revoke.external', nonce: 'nonce-1234567890123456',
};

function result(status: 'completed' | 'unknown' = 'completed') {
  return {
    schemaVersion: 'result-envelope/1' as const, taskId: 'task.external', agentId: 'agent.external', status, resultType: 'research/1', summary: status === 'completed' ? 'done' : '',
    claims: [], artifacts: [], unresolved: [], requestedFollowups: [], cost: {}, capabilitiesUsed: [], contextVersion: 'ctx.external', receiptRef: 'receipt.external',
  };
}

describe('external Agent gateway', () => {
  it('enforces context/grant boundaries and caches completed idempotent delegation', async () => {
    let calls = 0;
    const transport: AgentTransport = { submit: async () => { calls++; return { status: 'completed', receiptRef: 'receipt.external', result: result() }; } };
    const directory = new AgentDirectory(); directory.register(card);
    const gateway = new AgentGateway(directory, transport);
    const request: DelegationRequest = { agentId: card.agentId, taskBrief: brief, contextPack: context, grant, mode: 'sync', idempotencyKey: 'delegation-1' };
    expect((await gateway.delegate(request)).result?.summary).toBe('done');
    expect((await gateway.delegate(request)).result?.summary).toBe('done');
    expect(calls).toBe(1);
    const privateContext = createContextPack({ ...context, classification: 'private' });
    await expect(gateway.delegate({ ...request, idempotencyKey: 'delegation-2', contextPack: privateContext })).rejects.toThrow('scope');
  });

  it('keeps unknown external work until explicit reconciliation', async () => {
    let submits = 0; let reconciles = 0;
    const transport: AgentTransport = {
      submit: async () => { submits++; return { status: 'unknown', receiptRef: 'receipt.unknown' }; },
      reconcile: async () => { reconciles++; return { status: 'completed', receiptRef: 'receipt.reconciled', result: result() }; },
    };
    const directory = new AgentDirectory(); directory.register(card);
    const gateway = new AgentGateway(directory, transport);
    const request: DelegationRequest = { agentId: card.agentId, taskBrief: brief, contextPack: context, grant, mode: 'async', idempotencyKey: 'delegation-unknown' };
    expect((await gateway.delegate(request)).status).toBe('unknown');
    expect((await gateway.reconcile(request.idempotencyKey)).status).toBe('completed');
    expect(submits).toBe(1); expect(reconciles).toBe(1);
  });
});
