import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  acknowledgementSchema,
  agentCardSchema,
  contextPackSchema,
  delegationGrantSchema,
  resultEnvelopeSchema,
  taskBriefSchema,
  validateResultForGrant,
  type AgentCard,
  type ContextAcknowledgement,
  type ContextPack,
  type DelegationGrant,
  type ResultEnvelope,
  type TaskBrief,
} from './protocol.js';

export type DelegationMode = 'sync' | 'async' | 'stream';
export type DelegationStatus = ResultEnvelope['status'] | 'accepted';

export interface DelegationRequest {
  agentId: string;
  taskBrief: TaskBrief;
  contextPack: ContextPack;
  grant: DelegationGrant;
  mode: DelegationMode;
  idempotencyKey: string;
}

export interface DelegationReceipt {
  receiptRef: string;
  agentId: string;
  taskId: string;
  idempotencyKey: string;
  status: DelegationStatus;
  contextVersion: string;
  acknowledgedAt: string;
}

export interface DelegationOutcome {
  status: DelegationStatus;
  receipt: DelegationReceipt;
  acknowledgement?: ContextAcknowledgement;
  result?: ResultEnvelope;
}

export interface AgentTransportResponse {
  status: DelegationStatus;
  receiptRef: string;
  acknowledgement?: ContextAcknowledgement;
  result?: ResultEnvelope;
}

export interface AgentTransport {
  submit(card: AgentCard, request: DelegationRequest): Promise<AgentTransportResponse>;
  reconcile?(card: AgentCard, request: DelegationRequest, receipt: DelegationReceipt): Promise<AgentTransportResponse>;
}

interface RegisteredAgent {
  card: AgentCard;
  revokedAt?: string;
}

/** A local, auditable directory. Agent Cards describe capability; grants authorize a task. */
export class AgentDirectory {
  private readonly entries = new Map<string, RegisteredAgent>();

  register(input: AgentCard): AgentCard {
    const card = agentCardSchema.parse(input);
    if (card.expiresAt && new Date(card.expiresAt).getTime() <= Date.now()) throw new Error('Cannot register an expired Agent Card');
    const existing = this.entries.get(card.agentId);
    if (existing?.card.cardVersion === card.cardVersion && !existing.revokedAt) throw new Error('Agent Card version is already registered');
    this.entries.set(card.agentId, { card });
    return card;
  }

  revoke(agentId: string, at = new Date().toISOString()): void {
    const entry = this.entries.get(agentId);
    if (!entry) throw new Error('Unknown agent');
    entry.revokedAt = at;
  }

  get(agentId: string): AgentCard {
    const entry = this.entries.get(agentId);
    if (!entry || entry.revokedAt) throw new Error('Agent is not admitted');
    if (entry.card.expiresAt && new Date(entry.card.expiresAt).getTime() <= Date.now()) throw new Error('Agent Card has expired');
    return entry.card;
  }

  list(): AgentCard[] {
    return [...this.entries.values()].filter(entry => !entry.revokedAt).map(entry => entry.card);
  }
}

/**
 * Delegates through a transport while enforcing Context Pack, grant, acknowledgement,
 * idempotency and Result Envelope boundaries. The gateway never writes canonical Brain
 * or Task state on behalf of the remote Agent.
 */
export class AgentGateway {
  private readonly inFlight = new Map<string, { request: DelegationRequest; card: AgentCard; outcome?: DelegationOutcome; promise?: Promise<DelegationOutcome> }>();
  private readonly grantCalls = new Map<string, number>();

  constructor(private readonly directory: AgentDirectory, private readonly transport: AgentTransport) {}

  async delegate(input: DelegationRequest): Promise<DelegationOutcome> {
    const request = validateRequest(input);
    const card = this.directory.get(request.agentId);
    if (!card.protocols.includes('aeeis-task/1')) throw new Error('Agent does not support the AEEIS task protocol');
    const unsupported = request.taskBrief.allowedCapabilities.filter(capability => !card.capabilities.includes(capability));
    if (unsupported.length) throw new Error('Agent does not advertise required capabilities: ' + unsupported.join(', '));
    if (request.contextPack.classification === 'private' && card.privacy.dataRetention !== 'none') throw new Error('Private Context Pack requires an Agent with no data retention');
    const cached = this.inFlight.get(request.idempotencyKey);
    if (cached?.outcome && cached.outcome.status !== 'unknown') return cached.outcome;
    if (cached?.outcome?.status === 'unknown') throw new Error('Delegation outcome is unknown; reconcile before submitting again');
    if (cached && !sameRequest(cached.request, request)) throw new Error('Idempotency key is bound to a different delegation request');
    if (cached?.promise) return cached.promise;
    const usedCalls = this.grantCalls.get(request.grant.grantId) ?? 0;
    if (request.grant.budget.calls !== undefined && usedCalls >= request.grant.budget.calls) throw new Error('Delegation grant call budget is exhausted');
    this.grantCalls.set(request.grant.grantId, usedCalls + 1);
    const promise = (async () => {
      const response = await this.transport.submit(card, request);
      const outcome = validateResponse(request, response);
      this.inFlight.set(request.idempotencyKey, { request, card, outcome });
      return outcome;
    })();
    this.inFlight.set(request.idempotencyKey, { request, card, promise });
    void promise.catch(() => { const current = this.inFlight.get(request.idempotencyKey); if (current?.promise === promise) this.inFlight.delete(request.idempotencyKey); });
    return promise;
  }

  async reconcile(idempotencyKey: string): Promise<DelegationOutcome>;
  async reconcile(request: DelegationRequest, persistedReceipt?: DelegationReceipt): Promise<DelegationOutcome>;
  async reconcile(input: string | DelegationRequest, persistedReceipt?: DelegationReceipt): Promise<DelegationOutcome> {
    const entry = typeof input === 'string' ? this.inFlight.get(input) : undefined;
    const request = typeof input === 'string' ? entry?.request : validateRequest(input);
    if (!request) throw new Error('Unknown delegation idempotency key');
    const card = typeof input === 'string' ? entry?.card : this.directory.get(request.agentId);
    if (!card) throw new Error('Agent is not admitted');
    const receipt = persistedReceipt ?? entry?.outcome?.receipt;
    if (!receipt || receipt.status !== 'unknown') throw new Error('Delegation does not require reconciliation');
    if (!this.transport.reconcile) throw new Error('Agent transport does not support reconciliation');
    const response = await this.transport.reconcile(card, request, receipt);
    const outcome = validateResponse(request, response);
    this.inFlight.set(request.idempotencyKey, { request, card, outcome });
    return outcome;
  }
}

export class HttpAgentTransport implements AgentTransport {
  constructor(private readonly timeoutMs = 60_000, private readonly bearerToken?: string, private readonly signingKeys: Readonly<Record<string, string>> = {}) {}

  async submit(card: AgentCard, request: DelegationRequest): Promise<AgentTransportResponse> {
    if (!card.endpoint) throw new Error('Agent Card has no endpoint');
    this.checkAuth(card);
    return this.send(card, { schemaVersion: 'agent-task/1', ...request });
  }

  async reconcile(card: AgentCard, request: DelegationRequest, receipt: DelegationReceipt): Promise<AgentTransportResponse> {
    if (!card.endpoint) throw new Error('Agent Card has no endpoint');
    this.checkAuth(card);
    return this.send(card, { schemaVersion: 'agent-reconcile/1', ...request, receipt });
  }

  private checkAuth(card: AgentCard): void {
    if (card.auth.includes('signed_request') && !this.signingKeys[card.agentId]) throw new Error('Agent Card requires a signing key');
    if (card.auth.includes('oauth')) throw new Error('HTTP Agent transport requires a dedicated OAuth adapter for this Agent Card');
    if (card.auth.includes('bearer') && !this.bearerToken) throw new Error('Agent Card requires a bearer token');
  }

  private async send(card: AgentCard, body: unknown): Promise<AgentTransportResponse> {
    if (!card.endpoint) throw new Error('Agent Card has no endpoint');
    const url = new URL(card.endpoint);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('External Agent endpoint must use HTTPS except loopback');
    if (url.username || url.password || url.hash) throw new Error('External Agent endpoint must not contain credentials or fragments');
    const serialized = JSON.stringify(body);
    const timestamp = String(Date.now());
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;
    if (card.auth.includes('signed_request')) {
      const key = this.signingKeys[card.agentId]!;
      headers['x-aeeis-timestamp'] = timestamp;
      headers['x-aeeis-signature'] = sign(key, timestamp, serialized);
    }
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers, body: serialized });
    } catch {
      return { status: 'unknown', receiptRef: 'receipt_' + randomUUID() };
    }
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) return { status: 'unknown', receiptRef: 'receipt_' + randomUUID() };
      throw new Error('External Agent rejected the delegation with HTTP ' + response.status);
    }
    const raw = await response.text();
    if (card.auth.includes('signed_request')) verifySignature(this.signingKeys[card.agentId]!, response.headers, raw);
    const parsed = responseSchema.parse(JSON.parse(raw));
    return { status: parsed.status, receiptRef: parsed.receiptRef, ...(parsed.acknowledgement ? { acknowledgement: parsed.acknowledgement } : {}), ...(parsed.result ? { result: parsed.result } : {}) };
  }
}

function sign(key: string, timestamp: string, body: string): string {
  return createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex');
}

function verifySignature(key: string, headers: Headers, body: string): void {
  const timestamp = headers.get('x-aeeis-timestamp'); const received = headers.get('x-aeeis-signature');
  if (!timestamp || !received || Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000 || !/^\d+$/.test(timestamp)) throw new Error('Signed Agent response is missing or expired');
  const expected = sign(key, timestamp, body); const left = Buffer.from(expected); const right = Buffer.from(received);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('Signed Agent response failed verification');
}

const responseSchema = z.object({
  status: z.enum(['accepted', 'completed', 'partial', 'blocked', 'needs_clarification', 'needs_approval', 'failed', 'rejected', 'unknown']),
  receiptRef: z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/),
  acknowledgement: acknowledgementSchema.optional(),
  result: resultEnvelopeSchema.optional(),
}).strict();

function validateRequest(input: DelegationRequest): DelegationRequest {
  const taskBrief = taskBriefSchema.parse(input.taskBrief);
  const contextPack = contextPackSchema.parse(input.contextPack);
  const grant = delegationGrantSchema.parse(input.grant);
  if (input.agentId !== grant.subjectAgentId) throw new Error('Delegation agent does not match the grant subject');
  if (taskBrief.taskId !== grant.taskId || contextPack.taskId !== grant.taskId) throw new Error('Task, context and grant IDs must match');
  if (taskBrief.contextManifestId !== contextPack.id) throw new Error('Task Brief does not bind to the Context Pack');
  if (!contextPack.audience.includes(input.agentId)) throw new Error('Context Pack audience does not include the delegated agent');
  if (!grant.actions.includes('return_result')) throw new Error('Delegation grant does not permit a result');
  if (classificationRank(contextPack.classification) > classificationRank(grant.dataScope)) throw new Error('Grant data scope is narrower than the Context Pack');
  if (new Date(grant.expiresAt).getTime() <= Date.now()) throw new Error('Delegation grant has expired');
  if (new Date(contextPack.expiresAt).getTime() <= Date.now()) throw new Error('Context Pack has expired');
  if (!input.idempotencyKey.trim()) throw new Error('Delegation idempotency key is required');
  return { ...input, taskBrief, contextPack, grant };
}

function validateResponse(request: DelegationRequest, response: AgentTransportResponse): DelegationOutcome {
  const status = responseSchema.parse(response);
  const receipt: DelegationReceipt = {
    receiptRef: status.receiptRef, agentId: request.agentId, taskId: request.taskBrief.taskId,
    idempotencyKey: request.idempotencyKey, status: status.status, contextVersion: request.contextPack.id, acknowledgedAt: new Date().toISOString(),
  };
  if (status.acknowledgement) validateAcknowledgement(request, status.acknowledgement);
  else if (status.status !== 'unknown') throw new Error('Agent response must include a Context Acknowledgement');
  if (status.result) {
    validateResultForGrant(status.result, request.grant);
    if (status.result.contextVersion !== request.contextPack.id) throw new Error('Agent result context version does not match the delegated Context Pack');
    if (status.result.resultType !== request.taskBrief.expectedOutput) throw new Error('Agent result type does not match the Task Brief');
    if (status.result.status !== status.status) throw new Error('Agent result status does not match transport status');
    if (request.grant.budget.tokens !== undefined && status.result.cost.tokens !== undefined && status.result.cost.tokens > request.grant.budget.tokens) throw new Error('Agent result exceeds the delegation token budget');
    if (request.grant.budget.money !== undefined && status.result.cost.money !== undefined && status.result.cost.money > request.grant.budget.money) throw new Error('Agent result exceeds the delegation money budget');
  } else if (status.status === 'completed' || status.status === 'partial' || status.status === 'failed' || status.status === 'rejected') {
    throw new Error('Completed Agent response must include a Result Envelope');
  }
  return { status: status.status, receipt, ...(status.acknowledgement ? { acknowledgement: status.acknowledgement } : {}), ...(status.result ? { result: status.result } : {}) };
}

function validateAcknowledgement(request: DelegationRequest, acknowledgement: ContextAcknowledgement): void {
  if (acknowledgement.taskId !== request.taskBrief.taskId || acknowledgement.contextVersion !== request.contextPack.id) throw new Error('Agent acknowledgement is bound to another task or context');
  if (!acknowledgement.ready && request.mode === 'sync') throw new Error('Agent is not ready for synchronous delegation');
}

function sameRequest(left: DelegationRequest, right: DelegationRequest): boolean {
  return left.agentId === right.agentId && left.taskBrief.taskId === right.taskBrief.taskId && left.contextPack.digest === right.contextPack.digest && left.grant.grantId === right.grant.grantId;
}

function classificationRank(value: ContextPack['classification'] | DelegationGrant['dataScope']): number {
  return { public: 0, internal: 1, confidential: 2, private: 3 }[value];
}
