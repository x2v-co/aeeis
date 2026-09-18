import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentDirectory, AgentGateway, HttpAgentTransport, OAuthClientCredentialsProvider } from '../src/agent-gateway.js';
import { FileGrantLedger } from '../src/agent-ledger.js';
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
function acknowledgement() {
  return { schemaVersion: 'context-ack/1' as const, taskId: 'task.external', contextVersion: 'ctx.external', understoodGoal: true, missingInformation: [], assumptions: [], conflicts: [], ready: true };
}

describe('external Agent gateway', () => {
  it('enforces context/grant boundaries and caches completed idempotent delegation', async () => {
    let calls = 0;
    const transport: AgentTransport = { submit: async () => { calls++; return { status: 'completed', receiptRef: 'receipt.external', acknowledgement: acknowledgement(), result: result() }; } };
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
      reconcile: async () => { reconciles++; return { status: 'completed', receiptRef: 'receipt.reconciled', acknowledgement: acknowledgement(), result: result() }; },
    };
    const directory = new AgentDirectory(); directory.register(card);
    const gateway = new AgentGateway(directory, transport);
    const request: DelegationRequest = { agentId: card.agentId, taskBrief: brief, contextPack: context, grant, mode: 'async', idempotencyKey: 'delegation-unknown' };
    expect((await gateway.delegate(request)).status).toBe('unknown');
    expect((await gateway.reconcile(request.idempotencyKey)).status).toBe('completed');
    expect(submits).toBe(1); expect(reconciles).toBe(1);
  });

  it('keeps asynchronously accepted work until explicit reconciliation', async () => {
    let submits = 0; let reconciles = 0;
    const transport: AgentTransport = {
      submit: async () => { submits++; return { status: 'accepted', receiptRef: 'receipt.accepted', acknowledgement: acknowledgement() }; },
      reconcile: async (_card, request) => { reconciles++; return { status: 'completed', receiptRef: 'receipt.async-complete', acknowledgement: acknowledgement(), result: { ...result(), receiptRef: 'receipt.async-complete', taskId: request.taskBrief.taskId } }; },
    };
    const directory = new AgentDirectory(); directory.register(card);
    const gateway = new AgentGateway(directory, transport);
    const request: DelegationRequest = { agentId: card.agentId, taskBrief: brief, contextPack: context, grant: { ...grant, budget: { calls: 1 } }, mode: 'async', idempotencyKey: 'delegation-accepted' };
    expect((await gateway.delegate(request)).status).toBe('accepted');
    expect((await gateway.reconcile(request, { receiptRef: 'receipt.accepted', agentId: card.agentId, taskId: brief.taskId, idempotencyKey: request.idempotencyKey, status: 'accepted', contextVersion: context.id, acknowledgedAt: new Date().toISOString() })).status).toBe('completed');
    expect(submits).toBe(1); expect(reconciles).toBe(1);
  });

  it('signs requests and verifies signed responses for signed Agent Cards', async () => {
    const key = 'test-signing-secret-0123456789';
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8'); const timestamp = request.headers['x-aeeis-timestamp']; const signature = request.headers['x-aeeis-signature'];
      expect(typeof timestamp).toBe('string'); expect(signature).toBe(createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex'));
      const output = JSON.stringify({ status: 'completed', receiptRef: 'receipt.signed', acknowledgement: acknowledgement(), result: result() }); const responseTimestamp = String(Date.now());
      response.setHeader('content-type', 'application/json'); response.setHeader('x-aeeis-timestamp', responseTimestamp); response.setHeader('x-aeeis-signature', createHmac('sha256', key).update(`${responseTimestamp}.${output}`).digest('hex')); response.end(output);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Server did not bind');
    const signedCard: AgentCard = { ...card, auth: ['signed_request'], endpoint: `http://127.0.0.1:${address.port}` };
    const transport = new HttpAgentTransport(5_000, undefined, { [signedCard.agentId]: key });
    const request: DelegationRequest = { agentId: signedCard.agentId, taskBrief: brief, contextPack: context, grant, mode: 'sync', idempotencyKey: 'delegation-signed' };
    expect((await transport.submit(signedCard, request)).status).toBe('completed');
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('enforces context expiry, grant budgets and concurrent idempotency', async () => {
    let calls = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const transport: AgentTransport = { submit: async (_card, request) => { calls += 1; await gate; return { status: 'completed', receiptRef: 'receipt.budget', acknowledgement: { schemaVersion: 'context-ack/1', taskId: request.taskBrief.taskId, contextVersion: request.contextPack.id, understoodGoal: true, missingInformation: [], assumptions: [], conflicts: [], ready: true }, result: { ...result(), receiptRef: 'receipt.budget' } }; } };
    const directory = new AgentDirectory(); directory.register(card);
    const gateway = new AgentGateway(directory, transport);
    const request: DelegationRequest = { agentId: card.agentId, taskBrief: brief, contextPack: context, grant: { ...grant, budget: { calls: 1 } }, mode: 'sync', idempotencyKey: 'same-key' };
    const first = gateway.delegate(request); const second = gateway.delegate(request); release();
    await Promise.all([first, second]); expect(calls).toBe(1);
    await expect(gateway.delegate({ ...request, idempotencyKey: 'second-key' })).rejects.toThrow('budget');
    await expect(gateway.delegate({ ...request, idempotencyKey: 'expired-context', contextPack: { ...context, expiresAt: '2020-01-01T00:00:00.000Z' } })).rejects.toThrow('expired');
  });

  it('delegates through OAuth and still enforces the Gateway acknowledgement boundary', async () => {
    let tokenCalls = 0; const authorizations: Array<string | undefined> = [];
    let includeAcknowledgement = true;
    const tokenServer = createServer(async (_request, response) => { tokenCalls += 1; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ access_token: 'oauth-token', token_type: 'Bearer', expires_in: 300 })); });
    const agentServer = createServer(async (request, response) => {
      authorizations.push(request.headers.authorization);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'completed', receiptRef: 'receipt.external', ...(includeAcknowledgement ? { acknowledgement: acknowledgement() } : {}), result: result() }));
    });
    await new Promise<void>(resolve => tokenServer.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => agentServer.listen(0, '127.0.0.1', resolve));
    try {
      const tokenAddress = tokenServer.address(); const agentAddress = agentServer.address();
      if (!tokenAddress || typeof tokenAddress === 'string' || !agentAddress || typeof agentAddress === 'string') throw new Error('Servers did not bind');
      const oauthCard: AgentCard = { ...card, auth: ['oauth'], endpoint: `http://127.0.0.1:${agentAddress.port}` };
      const directory = new AgentDirectory(); directory.register(oauthCard);
      const provider = new OAuthClientCredentialsProvider({ [oauthCard.agentId]: { tokenUrl: `http://127.0.0.1:${tokenAddress.port}/token`, clientId: 'client', clientSecret: 'secret' } });
      const gateway = new AgentGateway(directory, new HttpAgentTransport(5_000, undefined, {}, provider));
      const request: DelegationRequest = { agentId: oauthCard.agentId, taskBrief: brief, contextPack: context, grant: { ...grant, budget: { calls: 2 } }, mode: 'sync', idempotencyKey: 'delegation-oauth' };
      expect((await gateway.delegate(request)).status).toBe('completed');
      includeAcknowledgement = false;
      await expect(gateway.delegate({ ...request, idempotencyKey: 'delegation-oauth-2' })).rejects.toThrow('Context Acknowledgement');
      expect(tokenCalls).toBe(1);
      expect(authorizations).toEqual(['Bearer oauth-token', 'Bearer oauth-token']);
    } finally {
      await new Promise<void>(resolve => tokenServer.close(() => resolve()));
      await new Promise<void>(resolve => agentServer.close(() => resolve()));
    }
  });

  it('persists grant reservations across gateway restart and reconciles without a second submit', async () => {
    const directoryPath = await mkdtemp(join('/tmp', 'aeeis-agent-ledger-'));
    const ledgerPath = join(directoryPath, 'ledger.json');
    let submits = 0; let reconciles = 0;
    const transport: AgentTransport = {
      submit: async () => { submits++; return { status: 'unknown', receiptRef: 'receipt.persisted-unknown' }; },
      reconcile: async (_card, request) => {
        reconciles++;
        return { status: 'completed', receiptRef: 'receipt.persisted-complete', acknowledgement: { ...acknowledgement(), taskId: request.taskBrief.taskId }, result: { ...result(), receiptRef: 'receipt.persisted-complete', cost: { tokens: 40 } } };
      },
    };
    try {
      const ledger1 = new FileGrantLedger(ledgerPath); await ledger1.init();
      const directory = new AgentDirectory(); directory.register(card);
      const request: DelegationRequest = { agentId: card.agentId, taskBrief: brief, contextPack: context, grant: { ...grant, budget: { calls: 1, tokens: 100 } }, mode: 'async', idempotencyKey: 'persisted-delegation' };
      const first = await new AgentGateway(directory, transport, ledger1).delegate(request);
      expect(first.status).toBe('unknown');
      await ledger1.close();

      const ledger2 = new FileGrantLedger(ledgerPath); await ledger2.init();
      const recovered = new AgentGateway(directory, transport, ledger2);
      await expect(recovered.delegate(request)).rejects.toThrow('reconcile');
      expect((await recovered.reconcile(request, first.receipt)).status).toBe('completed');
      expect(submits).toBe(1); expect(reconciles).toBe(1);
      await expect(recovered.delegate({ ...request, idempotencyKey: 'second-delegation' })).rejects.toThrow('budget');
      await ledger2.close();
    } finally { await rm(directoryPath, { recursive: true, force: true }); }
  });

  it('settles cumulative token usage atomically against a durable grant budget', async () => {
    const directoryPath = await mkdtemp(join('/tmp', 'aeeis-agent-ledger-'));
    const ledger = new FileGrantLedger(join(directoryPath, 'ledger.json')); await ledger.init();
    let calls = 0;
    const transport: AgentTransport = { submit: async (_card, request) => {
      calls++;
      const tokens = calls === 1 ? 60 : 50;
      return { status: 'completed', receiptRef: `receipt.cost-${calls}`, acknowledgement: acknowledgement(), result: { ...result(), receiptRef: `receipt.cost-${calls}`, cost: { tokens } } };
    } };
    const directory = new AgentDirectory(); directory.register(card);
    const gateway = new AgentGateway(directory, transport, ledger);
    const baseRequest: DelegationRequest = { agentId: card.agentId, taskBrief: brief, contextPack: context, grant: { ...grant, budget: { calls: 2, tokens: 100 } }, mode: 'sync', idempotencyKey: 'cost-1' };
    try {
      await gateway.delegate(baseRequest);
      await expect(gateway.delegate({ ...baseRequest, idempotencyKey: 'cost-2' })).rejects.toThrow('token budget');
      expect(calls).toBe(2);
    } finally { await ledger.close(); await rm(directoryPath, { recursive: true, force: true }); }
  });
});
