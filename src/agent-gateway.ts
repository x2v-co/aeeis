import { randomUUID } from 'node:crypto';
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
  private readonly inFlight = new Map<string, { request: DelegationRequest; card: AgentCard; outcome?: DelegationOutcome }>();

  constructor(private readonly directory: AgentDirectory, private readonly transport: AgentTransport) {}

  async delegate(input: DelegationRequest): Promise<DelegationOutcome> {
    const request = validateRequest(input);
    const card = this.directory.get(request.agentId);
    const cached = this.inFlight.get(request.idempotencyKey);
    if (cached?.outcome && cached.outcome.status !== 'unknown') return cached.outcome;
    if (cached && !sameRequest(cached.request, request)) throw new Error('Idempotency key is bound to a different delegation request');
    this.inFlight.set(request.idempotencyKey, { request, card });
    const response = await this.transport.submit(card, request);
    const outcome = validateResponse(request, response);
    this.inFlight.set(request.idempotencyKey, { request, card, outcome });
    return outcome;
  }

  async reconcile(idempotencyKey: string): Promise<DelegationOutcome> {
    const entry = this.inFlight.get(idempotencyKey);
    if (!entry) throw new Error('Unknown delegation idempotency key');
    if (!entry.outcome || entry.outcome.status !== 'unknown') throw new Error('Delegation does not require reconciliation');
    if (!this.transport.reconcile) throw new Error('Agent transport does not support reconciliation');
    const response = await this.transport.reconcile(entry.card, entry.request, entry.outcome.receipt);
    const outcome = validateResponse(entry.request, response);
    this.inFlight.set(idempotencyKey, { ...entry, outcome });
    return outcome;
  }
}

export class HttpAgentTransport implements AgentTransport {
  constructor(private readonly timeoutMs = 60_000, private readonly bearerToken?: string) {}

  async submit(card: AgentCard, request: DelegationRequest): Promise<AgentTransportResponse> {
    if (!card.endpoint) throw new Error('Agent Card has no endpoint');
    this.checkAuth(card);
    return this.send(card.endpoint, { schemaVersion: 'agent-task/1', ...request });
  }

  async reconcile(card: AgentCard, request: DelegationRequest, receipt: DelegationReceipt): Promise<AgentTransportResponse> {
    if (!card.endpoint) throw new Error('Agent Card has no endpoint');
    this.checkAuth(card);
    return this.send(card.endpoint, { schemaVersion: 'agent-reconcile/1', ...request, receipt });
  }

  private checkAuth(card: AgentCard): void {
    if (card.auth.includes('signed_request') || card.auth.includes('oauth')) throw new Error('HTTP Agent transport requires a dedicated signed/OAuth adapter for this Agent Card');
    if (card.auth.includes('bearer') && !this.bearerToken) throw new Error('Agent Card requires a bearer token');
  }

  private async send(endpoint: string, body: unknown): Promise<AgentTransportResponse> {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('External Agent endpoint must use HTTPS except loopback');
    if (url.username || url.password || url.hash) throw new Error('External Agent endpoint must not contain credentials or fragments');
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { 'content-type': 'application/json', ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}) }, body: JSON.stringify(body) });
    } catch {
      return { status: 'unknown', receiptRef: 'receipt_' + randomUUID() };
    }
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) return { status: 'unknown', receiptRef: 'receipt_' + randomUUID() };
      throw new Error('External Agent rejected the delegation with HTTP ' + response.status);
    }
    const parsed = responseSchema.parse(await response.json());
    return { status: parsed.status, receiptRef: parsed.receiptRef, ...(parsed.acknowledgement ? { acknowledgement: parsed.acknowledgement } : {}), ...(parsed.result ? { result: parsed.result } : {}) };
  }
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
  if (status.result) {
    validateResultForGrant(status.result, request.grant);
    if (status.result.contextVersion !== request.contextPack.id) throw new Error('Agent result context version does not match the delegated Context Pack');
    if (status.result.status !== status.status) throw new Error('Agent result status does not match transport status');
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
