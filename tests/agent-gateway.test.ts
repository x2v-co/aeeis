import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentDirectory, AgentGateway, AgentOutcomeUnknown, HttpAgentCardDiscovery, HttpAgentTransport, OAuthClientCredentialsProvider } from '../src/agent-gateway.js';
import { FileGrantLedger, InMemoryGrantLedger } from '../src/agent-ledger.js';
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
const context = createContextPack({ schemaVersion: 'context-pack/1', id: 'ctx.external', taskId: 'task.external', version: 1, audience: ['agent.external'], classification: 'public', expiresAt: date, sourceRefs: ['source.external'], artifactRefs: ['artifact.external'], claims: [], redactions: [] });
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
  it.each(['remote', 'settlement', 'reputation'] as const)('linearizes Grant authorization when revoked during %s while settling exactly once', async phase => {
    const ledger = new InMemoryGrantLedger();
    const directory = new AgentDirectory(); directory.register(card);
    const revoke = () => ledger.revokeGrant(grant.grantId, { actor: 'ops', reason: 'withdrawn' });
    if (phase === 'settlement') {
      const settle = ledger.settle.bind(ledger);
      ledger.settle = async (...args) => { await settle(...args); await revoke(); };
    }
    if (phase === 'reputation') {
      const record = directory.recordReputation.bind(directory);
      directory.recordReputation = (...args) => {
        // Queue withdrawal before the Gateway's post-observation check.
        void revoke();
        return record(...args);
      };
    }
    const gateway = new AgentGateway(directory, { submit: async () => {
      if (phase === 'remote') await revoke();
      return { status: 'completed', receiptRef: 'receipt.external', acknowledgement: acknowledgement(), result: { ...result(), summary: 'QUARANTINED', cost: { tokens: 30, money: 0.5, currency: 'USD' } } };
    } }, ledger);
    const outcome = await gateway.delegate({ agentId: card.agentId, taskBrief: brief, contextPack: context, grant, mode: 'sync', idempotencyKey: 'withdrawn' });
    if (phase === 'remote') {
      expect(outcome).toMatchObject({ status: 'completed', disposition: 'isolated', isolatedCost: { tokens: 30, money: 0.5 } });
      expect(outcome.result).toBeUndefined(); expect(outcome.progress).toBeUndefined();
      expect(JSON.stringify(outcome)).not.toContain('QUARANTINED');
    } else if (phase === 'reputation') {
      expect(outcome).toMatchObject({ status: 'completed', result: { summary: 'QUARANTINED' }, receipt: { authorization: { decision: 'authorized' } } });
    } else {
      expect(outcome).toMatchObject({ status: 'completed', disposition: 'isolated', isolatedCost: { tokens: 30, money: 0.5 }, receipt: { authorization: { decision: 'isolated' } } });
    }
    // Settlement of an already tracked call must remain possible after revoke.
    if (phase === 'settlement') await expect(ledger.settle(grant.grantId, 'withdrawn', { tokens: 30, money: 0.5 })).resolves.toBeUndefined();
    else await expect(ledger.settle(grant.grantId, 'withdrawn', { tokens: 30, money: 0.5 })).resolves.toMatchObject({ decision: phase === 'reputation' ? 'authorized' : 'isolated' });
    await expect(ledger.reserve(grant.grantId, 'new-call', grant.budget)).rejects.toThrow('revoked');
  });

  it('isolates a result when the Grant expires during provider execution while settling usage', async () => {
    const ledger = new InMemoryGrantLedger();
    const directory = new AgentDirectory(); directory.register(card);
    const expiresAt = new Date(Date.now() + 50).toISOString();
    const shortGrant = { ...grant, grantId: 'grant.expiring', revocationRef: 'revoke.expiring', nonce: 'nonce-expiring-123456', issuedAt: new Date(Date.now() - 10).toISOString(), expiresAt };
    const shortContext = createContextPack({ ...context, id: 'ctx.expiring', expiresAt });
    const shortBrief = { ...brief, contextManifestId: shortContext.id };
    const gateway = new AgentGateway(directory, {
      submit: async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return { status: 'completed', receiptRef: 'receipt.expiring', acknowledgement: { ...acknowledgement(), contextVersion: shortContext.id }, result: { ...result(), receiptRef: 'receipt.expiring', contextVersion: shortContext.id, cost: { tokens: 4, money: 0.2, currency: 'USD' } } };
      },
    }, ledger);
    const outcome = await gateway.delegate({ agentId: card.agentId, taskBrief: shortBrief, contextPack: shortContext, grant: shortGrant, mode: 'sync', idempotencyKey: 'expiring-call' });
    expect(outcome).toMatchObject({ status: 'completed', disposition: 'isolated', isolatedCost: { tokens: 4, money: 0.2 } });
    expect(outcome.result).toBeUndefined();
    await ledger.settle(shortGrant.grantId, 'expiring-call', { tokens: 4, money: 0.2 });
  });

  it('discovers a bounded Agent Card over loopback HTTP without admitting it', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(card));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Server did not bind');
    try {
      const discovered = await new HttpAgentCardDiscovery(2_000).fetch(`http://127.0.0.1:${address.port}/.well-known/aeeis-agent.json`);
      expect(discovered).toEqual(card);
      await expect(new HttpAgentCardDiscovery(2_000, false, 256_000, ['agents.example.com']).fetch(`http://127.0.0.1:${address.port}/.well-known/aeeis-agent.json`)).rejects.toThrow('allowlist');
      await expect(new HttpAgentCardDiscovery().fetch('http://example.com/card.json')).rejects.toThrow('must use HTTPS');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('rejects oversized or malformed Agent Card discovery responses', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json'); response.end('{"schemaVersion":"agent-card/1"}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Server did not bind');
    try { await expect(new HttpAgentCardDiscovery().fetch(`http://127.0.0.1:${address.port}`)).rejects.toThrow(); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('keeps accepted work reserved and settles reported currency costs on the final callback', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'aeeis-accepted-ledger-'));
    const path = join(folder, 'ledger.json');
    const ledger = new FileGrantLedger(path); await ledger.init();
    try {
      const directory = new AgentDirectory(); directory.register(card);
      const gateway = new AgentGateway(directory, { submit: async () => ({ status: 'accepted', receiptRef: 'receipt.accepted', acknowledgement: acknowledgement() }) }, ledger);
      const request: DelegationRequest = { agentId: card.agentId, taskBrief: brief, contextPack: context, grant, mode: 'async', idempotencyKey: 'accepted-cost' };
      await gateway.delegate(request);
      let persisted = JSON.parse(await readFile(path, 'utf8')).grants[grant.grantId];
      expect(persisted.entries['accepted-cost'].state).toBe('unknown');
      const response: AgentTransportResponse = { status: 'completed', receiptRef: 'receipt.final', acknowledgement: acknowledgement(), result: { ...result(), receiptRef: 'receipt.final', cost: { tokens: 30, money: 0.5, currency: 'USD' } } };
      expect((await gateway.acceptCallback(request, response)).status).toBe('completed');
      await gateway.acceptCallback(request, response);
      persisted = JSON.parse(await readFile(path, 'utf8')).grants[grant.grantId];
      expect(persisted).toMatchObject({ usedCalls: 1, usedTokens: 30, usedMoney: 0.5 });
      expect(persisted.entries['accepted-cost']).toMatchObject({ state: 'settled', usage: { tokens: 30, money: 0.5 } });
    } finally { await ledger.close(); await rm(folder, { recursive: true, force: true }); }
  });

  it('persists Grant revocation, blocks new submit, and isolates later reconciliation/callbacks', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'aeeis-grant-revocation-'));
    const path = join(folder, 'ledger.json');
    const ledger = new FileGrantLedger(path); await ledger.init();
    let submits = 0; let reconciles = 0;
    const transport: AgentTransport = {
      submit: async () => { submits++; return { status: 'accepted', receiptRef: 'receipt.revocable', acknowledgement: acknowledgement() }; },
      reconcile: async () => { reconciles++; return { status: 'completed', receiptRef: 'receipt.should-not-run', acknowledgement: acknowledgement(), result: { ...result(), receiptRef: 'receipt.should-not-run' } }; },
    };
    const directory = new AgentDirectory(); directory.register(card);
    const request: DelegationRequest = { agentId: card.agentId, taskBrief: brief, contextPack: context, grant: { ...grant, budget: { calls: 2 } }, mode: 'async', idempotencyKey: 'revocable-delegation' };
    try {
      const gateway = new AgentGateway(directory, transport, ledger);
      const accepted = await gateway.delegate(request);
      expect(submits).toBe(1);
      const revoked = await ledger.revokeGrant(grant.grantId, { actor: 'operator', reason: 'Agent suspended' });
      expect(revoked).toMatchObject({ status: 'revoked', revokedBy: 'operator', revocationReason: 'Agent suspended' });
      await expect(gateway.delegate({ ...request, idempotencyKey: 'revoked-new-call' })).rejects.toThrow('revoked');
      const reconciled = await gateway.reconcile(request, accepted.receipt);
      expect(reconciled).toMatchObject({ status: 'completed', disposition: 'isolated' });
      const callback = await gateway.acceptCallback(request, { status: 'completed', receiptRef: 'receipt.late', acknowledgement: acknowledgement(), result: { ...result(), receiptRef: 'receipt.late' } });
      expect(callback).toMatchObject({ status: 'completed', disposition: 'isolated' });
      expect(reconciles).toBe(1);
      await ledger.close();
      const recovered = new FileGrantLedger(path); await recovered.init();
      expect(await recovered.getGrant(grant.grantId)).toMatchObject({ status: 'revoked', history: expect.arrayContaining([expect.objectContaining({ status: 'revoked' })]) });
      await recovered.close();
    } finally { await rm(folder, { recursive: true, force: true }); }
  });

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

  it('rejects result citations and artifacts that are outside the frozen Context Pack', async () => {
    const directory = new AgentDirectory(); directory.register(card);
    const gateway = new AgentGateway(directory, { submit: async () => ({
      status: 'completed', receiptRef: 'receipt.untrusted', acknowledgement: acknowledgement(),
      result: { ...result(), receiptRef: 'receipt.untrusted', artifacts: ['artifact.injected'], claims: [{ text: 'unsupported', confidence: 1, evidenceRefs: ['source.injected'] }] },
    }) });
    const request: DelegationRequest = { agentId: card.agentId, taskBrief: brief, contextPack: context, grant, mode: 'sync', idempotencyKey: 'delegation-untrusted-evidence' };
    await expect(gateway.delegate(request)).rejects.toThrow('outside the Context Pack');
  });

  it('rejects an unbound claim already present in a directly supplied Context Pack', async () => {
    const directory = new AgentDirectory(); directory.register(card);
    const gateway = new AgentGateway(directory, { submit: async () => { throw new Error('must not dispatch'); } });
    const unsafeContext = { ...context, claims: [{ id: 'claim.injected', text: 'untrusted', evidenceRefs: ['source.injected'] }] };
    const request: DelegationRequest = { agentId: card.agentId, taskBrief: brief, contextPack: unsafeContext, grant, mode: 'sync', idempotencyKey: 'delegation-unsafe-context' };
    await expect(gateway.delegate(request)).rejects.toThrow('outside the Context Pack');
  });

  it('labels a rejected remote response while retaining the ambiguous external boundary', async () => {
    const directory = new AgentDirectory(); directory.register(card);
    const gateway = new AgentGateway(directory, { submit: async () => ({ status: 'completed', receiptRef: 'receipt.bad', acknowledgement: acknowledgement(), result: { ...result(), receiptRef: 'receipt.bad', artifacts: ['artifact.injected'] } }) });
    const request: DelegationRequest = { agentId: card.agentId, taskBrief: brief, contextPack: context, grant, mode: 'sync', idempotencyKey: 'delegation-rejected-response' };
    try { await gateway.delegate(request); throw new Error('expected rejection'); }
    catch (error) {
      expect(error).toBeInstanceOf(AgentOutcomeUnknown);
      expect((error as AgentOutcomeUnknown).failure).toMatchObject({ kind: 'protocol', responseRejected: true });
    }
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

  it('requires a fresh HMAC callback signature for signed asynchronous Agents and keeps callbacks idempotent', async () => {
    const key = 'callback-signing-secret-0123456789';
    const signedCard: AgentCard = { ...card, auth: ['signed_request'] };
    const directory = new AgentDirectory(); directory.register(signedCard);
    const gateway = new AgentGateway(directory, { submit: async () => ({ status: 'accepted', receiptRef: 'receipt.accepted', acknowledgement: acknowledgement() }) }, undefined, { [signedCard.agentId]: key });
    const request: DelegationRequest = { agentId: signedCard.agentId, taskBrief: brief, contextPack: context, grant: { ...grant, budget: { calls: 1 } }, mode: 'async', idempotencyKey: 'delegation-callback' };
    const response: AgentTransportResponse = { status: 'completed', receiptRef: 'receipt.callback', acknowledgement: acknowledgement(), result: { ...result(), receiptRef: 'receipt.callback' } };
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', key).update(`${timestamp}.${JSON.stringify(response)}`).digest('hex');
    await expect(gateway.acceptCallback(request, response, { timestamp, signature: 'bad' })).rejects.toThrow('failed verification');
    const accepted = await gateway.acceptCallback(request, response, { timestamp, signature });
    expect(accepted.status).toBe('completed');
    expect((await gateway.acceptCallback(request, response, { timestamp, signature })).status).toBe('completed');
    await expect(gateway.acceptCallback(request, response, { timestamp: String(Date.now() - 6 * 60_000), signature })).rejects.toThrow('missing or expired');
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

  it('consumes bounded NDJSON streaming progress and returns the final envelope', async () => {
    const server = createServer(async (_request, response) => {
      response.setHeader('content-type', 'application/x-ndjson');
      const progress = {
        schemaVersion: 'agent-progress/1', taskId: brief.taskId, agentId: card.agentId, contextVersion: context.id,
        sequence: 1, status: 'running', message: 'retrieving sources', percent: 25, evidenceRefs: [], artifactRefs: [], at: new Date().toISOString(),
      };
      response.write(JSON.stringify(progress) + '\n');
      response.write(JSON.stringify({ status: 'completed', receiptRef: 'receipt.stream', acknowledgement: acknowledgement(), result: { ...result(), receiptRef: 'receipt.stream' } }) + '\n');
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Server did not bind');
    const streamedCard: AgentCard = { ...card, endpoint: `http://127.0.0.1:${address.port}` };
    const progress: number[] = [];
    const transport = new HttpAgentTransport(5_000);
    try {
      const outcome = await transport.submit(streamedCard, { agentId: card.agentId, taskBrief: brief, contextPack: context, grant, mode: 'stream', idempotencyKey: 'delegation-stream', onProgress: event => progress.push(event.sequence) });
      expect(outcome.status).toBe('completed');
      expect(outcome.receiptRef).toBe('receipt.stream');
      expect(progress).toEqual([1]);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
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

  it('keeps discovery, admission and revocation durable and prevents rediscovery bypass', async () => {
    const directoryPath = join(await mkdtemp(join(tmpdir(), 'aeeis-agent-registry-')), 'registry.json');
    const discovered = new AgentDirectory(directoryPath);
    expect(discovered.health()).toMatchObject({ ready: true, detail: 'file Agent Registry ready (empty)' });
    discovered.discover(card);
    expect(discovered.entriesSnapshot()).toEqual([expect.objectContaining({ agentId: card.agentId, status: 'discovered' })]);
    expect(() => discovered.get(card.agentId)).toThrow('not admitted');

    const restarted = new AgentDirectory(directoryPath);
    restarted.admit(card.agentId);
    expect(restarted.get(card.agentId)).toEqual(card);
    expect(restarted.discover(card)).toEqual(card);
    restarted.revoke(card.agentId);
    expect(() => restarted.get(card.agentId)).toThrow('not admitted');
    expect(() => restarted.discover(card)).toThrow('explicit re-admission');
    restarted.recordReputation(card.agentId, { source: 'operator', outcome: 'completed', evidenceRefs: ['receipt.external'], dimensions: { quality: 1, evidence: 0.8 } });
    const restored = new AgentDirectory(directoryPath);
    expect(restored.health()).toMatchObject({ ready: true, detail: 'file Agent Registry readable' });
    expect(restored.entriesSnapshot()).toEqual([expect.objectContaining({ agentId: card.agentId, status: 'revoked', reputation: expect.objectContaining({ samples: 1 }) })]);
    expect(restored.auditSnapshot(card.agentId).map(event => event.action)).toEqual(['discovered', 'admitted', 'revoked']);
    expect(restored.reputationSnapshot(card.agentId).dimensions).toMatchObject({ quality: 1, evidence: 0.8 });
  });

  it('records completed delegation reputation from result evidence and keeps duplicate callbacks idempotent', async () => {
    const directory = new AgentDirectory(); directory.register(card);
    const gateway = new AgentGateway(directory, { submit: async () => ({ status: 'accepted', receiptRef: 'receipt.accepted', acknowledgement: acknowledgement() }) });
    const request: DelegationRequest = { agentId: card.agentId, taskBrief: brief, contextPack: context, grant: { ...grant, budget: { calls: 1 } }, mode: 'async', idempotencyKey: 'delegation-reputation' };
    const response: AgentTransportResponse = { status: 'completed', receiptRef: 'receipt.reputation', acknowledgement: acknowledgement(), result: { ...result(), receiptRef: 'receipt.reputation', artifacts: ['artifact.external'], claims: [{ text: 'supported', confidence: 1, evidenceRefs: ['source.external'] }] } };
    await gateway.acceptCallback(request, response);
    await gateway.acceptCallback(request, response);
    expect(directory.reputationSnapshot(card.agentId)).toMatchObject({ samples: 1, dimensions: { quality: 1, evidence: 1 } });
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
