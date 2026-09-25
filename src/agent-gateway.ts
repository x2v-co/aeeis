import { validateCollectionLimit } from './adapters/collection-query.js';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { OAuthTokenProvider } from './oauth.js';
import { InMemoryGrantLedger } from './agent-ledger.js';
import type { GrantAuthorizationReceipt, GrantLedger } from './agent-ledger.js';
export interface AgentFailure {
  kind: 'transport' | 'protocol' | 'authentication' | 'http_rejection' | 'budget' | 'accounting';
  message: string;
  /** A local response rejection does not prove the remote work had no effects. */
  responseRejected: boolean;
}

/** Dispatch began, but the provider's final result cannot be verified. */
export class AgentOutcomeUnknown extends Error {
  readonly failure: AgentFailure;
  constructor(message: string, options?: ErrorOptions, failure?: AgentFailure) {
    super(message, options);
    this.failure = failure ?? { kind: 'transport', message: message.slice(0, 1000), responseRejected: false };
  }
}

/** Locally rejected data; it must never enter the task's evidence/observations. */
export class AgentResponseRejected extends Error {
  constructor(readonly kind: Exclude<AgentFailure['kind'], 'transport' | 'accounting'>, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

function validateAgentData<T>(kind: AgentResponseRejected['kind'], validate: () => T): T {
  try { return validate(); }
  catch (error) {
    if (error instanceof AgentResponseRejected) throw error;
    // Schema/JSON errors can contain fragments of untrusted response bodies.
    const message = error instanceof z.ZodError || error instanceof SyntaxError ? 'Agent response does not match the expected schema or JSON encoding' : error instanceof Error ? error.message : 'Invalid Agent response';
    throw new AgentResponseRejected(kind, message.slice(0, 1000), { cause: error });
  }
}

function unknownAgentFailure(error: unknown, fallback: AgentFailure['kind'] = 'transport'): AgentOutcomeUnknown {
  if (error instanceof AgentOutcomeUnknown) return error;
  const message = (error instanceof Error ? error.message : 'Agent outcome could not be verified').slice(0, 1000);
  return new AgentOutcomeUnknown(message, { cause: error }, { kind: error instanceof AgentResponseRejected ? error.kind : fallback, message, responseRejected: error instanceof AgentResponseRejected });
}
export { OAuthClientCredentialsProvider } from './oauth.js';
import {
  acknowledgementSchema,
  agentCardSchema,
  contextPackSchema,
  delegationGrantSchema,
  digestProtocol,
  agentProgressEventSchema,
  resultEnvelopeSchema,
  taskBriefSchema,
  validateResultForGrant,
  validateResultForContext,
  validateProgressForGrant,
  type AgentCard,
  type AgentProgressEvent,
  type ContextAcknowledgement,
  type ContextPack,
  type DelegationGrant,
  type ResultEnvelope,
  type TaskBrief,
  validateContextPackEvidence,
} from './protocol.js';
export type { AgentProgressEvent } from './protocol.js';

export type DelegationMode = 'sync' | 'async' | 'stream';
export type DelegationStatus = ResultEnvelope['status'] | 'accepted';
export type AgentProgressHandler = (progress: AgentProgressEvent) => void | Promise<void>;

export interface DelegationRequest {
  agentId: string;
  /** Pins the approved Card, including transport and privacy metadata. */
  cardDigest?: string;
  taskBrief: TaskBrief;
  contextPack: ContextPack;
  grant: DelegationGrant;
  mode: DelegationMode;
  idempotencyKey: string;
  /** Local callback used by the runtime for validated streaming telemetry.
   * It is never serialized into the remote protocol or persisted in a Run. */
  onProgress?: AgentProgressHandler;
}

export type ApprovedAgent = Pick<AgentCard, 'agentId' | 'name' | 'cardVersion' | 'capabilities' | 'inputSchemas' | 'outputSchemas' | 'privacy' | 'pricing'> & { cardDigest: string };

export interface DelegationReceipt {
  receiptRef: string;
  agentId: string;
  taskId: string;
  idempotencyKey: string;
  status: DelegationStatus;
  contextVersion: string;
  acknowledgedAt: string;
  /** Durable local decision that linearized accounting and canonical commit. */
  authorization?: GrantAuthorizationReceipt;
}

export interface DelegationOutcome {
  status: DelegationStatus;
  receipt: DelegationReceipt;
  acknowledgement?: ContextAcknowledgement;
  result?: ResultEnvelope;
  progress?: AgentProgressEvent[];
  /** Local diagnostic, never accepted from the remote response schema. */
  failure?: AgentFailure;
  /** The remote result was received after the Grant was revoked/expired. It
   * remains an accounting/audit receipt but must not be applied to AEEIS. */
  disposition?: 'isolated';
  /** Verified usage retained without carrying quarantined result text. */
  isolatedCost?: ResultEnvelope['cost'];
}

export interface AgentTransportResponse {
  status: DelegationStatus;
  receiptRef: string;
  acknowledgement?: ContextAcknowledgement;
  result?: ResultEnvelope;
  progress?: AgentProgressEvent[];
}

export interface AgentCallbackAuthentication {
  timestamp?: string;
  signature?: string;
  /** Exact bytes received by the webhook. JSON.stringify(response) remains a
   * backwards-compatible fallback for in-process callers and older clients. */
  body?: string;
}

export class AgentCallbackAuthenticationError extends Error {}

export interface AgentTransport {
  submit(card: AgentCard, request: DelegationRequest): Promise<AgentTransportResponse>;
  reconcile?(card: AgentCard, request: DelegationRequest, receipt: DelegationReceipt): Promise<AgentTransportResponse>;
}

interface RegisteredAgent {
  card: AgentCard;
  status: 'discovered' | 'admitted' | 'revoked';
  discoveredAt: string;
  admittedAt?: string;
  revokedAt?: string;
}

export interface AgentRegistryEntry { agentId: string; status: RegisteredAgent['status']; card: AgentCard; discoveredAt: string; admittedAt?: string; revokedAt?: string; reputation: AgentReputation }
export interface AgentRegistryAuditEvent {
  id: string;
  agentId: string;
  action: 'discovered' | 'registered' | 'admitted' | 'revoked';
  actor: string;
  cardVersion: string;
  status: RegisteredAgent['status'];
  at: string;
}
export const agentReputationObservationSchema = z.object({
  source: z.enum(['operator', 'delegation', 'evaluator']), taskId: z.string().min(1).max(200).optional(),
  outcome: z.enum(['completed', 'partial', 'blocked', 'failed', 'rejected', 'unknown']), evidenceRefs: z.array(z.string().min(1).max(200)).max(100),
  dimensions: z.object({ identity: z.number().min(0).max(1).optional(), quality: z.number().min(0).max(1).optional(), evidence: z.number().min(0).max(1).optional(), safety: z.number().min(0).max(1).optional(), latency: z.number().min(0).max(1).optional(), cost: z.number().min(0).max(1).optional(), privacy: z.number().min(0).max(1).optional(), revocation: z.number().min(0).max(1).optional() }).strict(),
  note: z.string().max(2000).optional(),
}).strict();
export type AgentReputationObservation = z.infer<typeof agentReputationObservationSchema> & { id: string; actor: string; at: string };
export interface AgentReputation { agentId: string; samples: number; dimensions: Record<'identity' | 'quality' | 'evidence' | 'safety' | 'latency' | 'cost' | 'privacy' | 'revocation', number>; observations: AgentReputationObservation[]; updatedAt: string }

export type MaybePromise<T> = T | Promise<T>;

/** The registry boundary is deliberately usable by both the synchronous local
 * JSON directory and the transactional PostgreSQL directory. */
export interface AgentDirectoryPort {
  /** Optional read-only registry/dependency probe. It must not mutate lifecycle state. */
  health?(): MaybePromise<{ ready: boolean; detail: string; checkedAt?: string }>;
  get(agentId: string): MaybePromise<AgentCard>;
  list(status?: RegisteredAgent['status']): MaybePromise<AgentCard[]>;
  entriesSnapshot(limit?: number): MaybePromise<AgentRegistryEntry[]>;
  auditSnapshot(agentId?: string): MaybePromise<AgentRegistryAuditEvent[]>;
  reputationSnapshot(agentId: string): MaybePromise<AgentReputation>;
  recordReputation(agentId: string, input: unknown, actor?: string, at?: string): MaybePromise<AgentReputation>;
  discover(input: AgentCard, at?: string, actor?: string): MaybePromise<AgentCard>;
  register(input: AgentCard, actor?: string): MaybePromise<AgentCard>;
  admit(agentId: string, at?: string, actor?: string): MaybePromise<AgentCard>;
  revoke(agentId: string, at?: string, actor?: string): MaybePromise<void>;
}

/** A local, auditable directory. Discovery never implies admission: only an
 * admitted card can receive a task grant. The optional file is a small local
 * registry for restarts; it contains cards and lifecycle timestamps, never
 * bearer tokens or OAuth client secrets. */
export class AgentDirectory implements AgentDirectoryPort {
  private readonly entries = new Map<string, RegisteredAgent>();
  private readonly auditEvents: AgentRegistryAuditEvent[] = [];
  private readonly reputations = new Map<string, AgentReputation>();
  constructor(private readonly persistencePath?: string) { if (persistencePath) this.load(); }

  health(): { ready: boolean; detail: string; checkedAt: string } {
    const checkedAt = new Date().toISOString();
    try {
      if (this.persistencePath) {
        // The registry is loaded during construction; a read probe confirms
        // the durable path remains readable without touching lifecycle state.
        if (!existsSync(this.persistencePath)) return { ready: true, detail: 'file Agent Registry ready (empty)', checkedAt };
        readFileSync(this.persistencePath, 'utf8');
        return { ready: true, detail: 'file Agent Registry readable', checkedAt };
      }
      return { ready: true, detail: 'in-memory Agent Registry ready', checkedAt };
    } catch (error) {
      return { ready: false, detail: `file Agent Registry unavailable: ${error instanceof Error ? error.message : 'unknown error'}`.slice(0, 500), checkedAt };
    }
  }

  private load(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return;
    const parsed: unknown = JSON.parse(readFileSync(this.persistencePath, 'utf8'));
    const records = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries) ? (parsed as { entries: unknown[] }).entries : undefined);
    if (!records) throw new Error('Agent registry must contain an entries array');
    if (!Array.isArray(parsed) && parsed && typeof parsed === 'object' && Array.isArray((parsed as { audit?: unknown }).audit)) {
      for (const item of (parsed as { audit: unknown[] }).audit) {
        const value = item as Record<string, unknown>;
        if (typeof value.id === 'string' && typeof value.agentId === 'string' && typeof value.action === 'string' && typeof value.actor === 'string' && typeof value.cardVersion === 'string' && typeof value.status === 'string' && typeof value.at === 'string' && ['discovered', 'registered', 'admitted', 'revoked'].includes(value.action) && ['discovered', 'admitted', 'revoked'].includes(value.status)) {
          this.auditEvents.push({ id: value.id, agentId: value.agentId, action: value.action as AgentRegistryAuditEvent['action'], actor: value.actor, cardVersion: value.cardVersion, status: value.status as RegisteredAgent['status'], at: value.at });
        }
      }
    }
    if (!Array.isArray(parsed) && parsed && typeof parsed === 'object' && (parsed as { reputation?: unknown }).reputation && typeof (parsed as { reputation?: unknown }).reputation === 'object') {
      for (const [agentId, item] of Object.entries((parsed as { reputation: Record<string, unknown> }).reputation)) {
        const value = item as Record<string, unknown>;
        const dimensions = value.dimensions as Record<string, unknown> | undefined;
        if (typeof value.samples === 'number' && dimensions && typeof value.updatedAt === 'string' && Object.values(dimensions).every(score => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1)) {
          this.reputations.set(agentId, { agentId, samples: value.samples, dimensions: defaultDimensions(dimensions), observations: Array.isArray(value.observations) ? value.observations as AgentReputationObservation[] : [], updatedAt: value.updatedAt });
        }
      }
    }
    for (const item of records) {
      const value = item as Record<string, unknown>;
      const card = agentCardSchema.parse(value.card);
      if (value.agentId !== card.agentId || !['discovered', 'admitted', 'revoked'].includes(String(value.status)) || typeof value.discoveredAt !== 'string') throw new Error('Invalid Agent registry entry');
      this.entries.set(card.agentId, { card, status: value.status as RegisteredAgent['status'], discoveredAt: value.discoveredAt, ...(typeof value.admittedAt === 'string' ? { admittedAt: value.admittedAt } : {}), ...(typeof value.revokedAt === 'string' ? { revokedAt: value.revokedAt } : {}) });
    }
  }

  private save(): void {
    if (!this.persistencePath) return;
    mkdirSync(dirname(this.persistencePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.persistencePath}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ entries: [...this.entries.values()].map(entry => ({ agentId: entry.card.agentId, ...entry })), audit: this.auditEvents, reputation: Object.fromEntries(this.reputations) })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.persistencePath);
    const directory = openSync(dirname(this.persistencePath), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  discover(input: AgentCard, at = new Date().toISOString(), actor = 'operator'): AgentCard {
    const card = agentCardSchema.parse(input);
    if (card.expiresAt && new Date(card.expiresAt).getTime() <= Date.now()) throw new Error('Cannot discover an expired Agent Card');
    const existing = this.entries.get(card.agentId);
    if (existing && Number(existing.card.cardVersion) > Number(card.cardVersion)) throw new Error('Discovery cannot replace a newer Agent Card');
    if (existing?.status === 'revoked') throw new Error('Revoked Agent requires explicit re-admission');
    if (existing?.status === 'admitted' && existing.card.cardVersion === card.cardVersion) return existing.card;
    this.entries.set(card.agentId, { card, status: 'discovered', discoveredAt: existing?.discoveredAt ?? at });
    this.record(card, 'discovered', actor, at);
    this.save(); return card;
  }

  register(input: AgentCard, actor = 'system'): AgentCard {
    const card = agentCardSchema.parse(input);
    if (card.expiresAt && new Date(card.expiresAt).getTime() <= Date.now()) throw new Error('Cannot register an expired Agent Card');
    const existing = this.entries.get(card.agentId);
    if (existing?.card.cardVersion === card.cardVersion && existing.status === 'admitted') return card;
    if (existing?.status === 'revoked') throw new Error('Revoked Agent requires explicit re-admission');
    const now = new Date().toISOString();
    this.entries.set(card.agentId, { card, status: 'admitted', discoveredAt: existing?.discoveredAt ?? now, admittedAt: existing?.admittedAt ?? now });
    this.record(card, 'registered', actor, now);
    this.save();
    return card;
  }

  admit(agentId: string, at = new Date().toISOString(), actor = 'operator'): AgentCard {
    const entry = this.entries.get(agentId);
    if (!entry || entry.status !== 'discovered') throw new Error('Agent is not awaiting admission');
    if (entry.card.expiresAt && new Date(entry.card.expiresAt).getTime() <= Date.now()) throw new Error('Agent Card has expired');
    entry.status = 'admitted'; entry.admittedAt = at; this.record(entry.card, 'admitted', actor, at); this.save(); return entry.card;
  }

  revoke(agentId: string, at = new Date().toISOString(), actor = 'operator'): void {
    const entry = this.entries.get(agentId);
    if (!entry) throw new Error('Unknown agent');
    entry.status = 'revoked';
    entry.revokedAt = at;
    this.record(entry.card, 'revoked', actor, at);
    this.save();
  }

  get(agentId: string): AgentCard {
    const entry = this.entries.get(agentId);
    if (!entry || entry.status !== 'admitted') throw new Error('Agent is not admitted');
    if (entry.card.expiresAt && new Date(entry.card.expiresAt).getTime() <= Date.now()) throw new Error('Agent Card has expired');
    return entry.card;
  }

  list(status: RegisteredAgent['status'] = 'admitted'): AgentCard[] {
    return [...this.entries.values()].filter(entry => entry.status === status).map(entry => entry.card);
  }

  entriesSnapshot(limit?: number): AgentRegistryEntry[] {
    validateCollectionLimit(limit);
    return [...this.entries.values()].slice(0, limit).map(entry => ({ agentId: entry.card.agentId, status: entry.status, card: structuredClone(entry.card), discoveredAt: entry.discoveredAt, ...(entry.admittedAt ? { admittedAt: entry.admittedAt } : {}), ...(entry.revokedAt ? { revokedAt: entry.revokedAt } : {}), reputation: this.reputationSnapshot(entry.card.agentId) }));
  }

  auditSnapshot(agentId?: string): AgentRegistryAuditEvent[] {
    return this.auditEvents.filter(event => agentId === undefined || event.agentId === agentId).map(event => structuredClone(event));
  }

  reputationSnapshot(agentId: string): AgentReputation {
    if (!this.entries.has(agentId)) throw new Error('Unknown agent');
    const current = this.reputations.get(agentId) ?? { agentId, samples: 0, dimensions: defaultDimensions(), observations: [], updatedAt: new Date(0).toISOString() };
    return structuredClone(current);
  }

  recordReputation(agentId: string, input: unknown, actor = 'operator', at = new Date().toISOString()): AgentReputation {
    if (!this.entries.has(agentId)) throw new Error('Unknown agent');
    const observation = agentReputationObservationSchema.parse(input);
    const current = this.reputationSnapshot(agentId);
    const nextSamples = current.samples + 1;
    const dimensions = { ...current.dimensions };
    for (const key of Object.keys(dimensions) as Array<keyof AgentReputation['dimensions']>) {
      const score = observation.dimensions[key];
      if (score !== undefined) dimensions[key] = (dimensions[key] * current.samples + score) / nextSamples;
    }
    const next: AgentReputation = { agentId, samples: nextSamples, dimensions, observations: [...current.observations, { ...observation, id: `agent_observation_${randomUUID()}`, actor, at }].slice(-100), updatedAt: at };
    this.reputations.set(agentId, next); this.save(); return structuredClone(next);
  }

  private record(card: AgentCard, action: AgentRegistryAuditEvent['action'], actor: string, at: string): void {
    this.auditEvents.push({ id: `agent_audit_${randomUUID()}`, agentId: card.agentId, action, actor, cardVersion: card.cardVersion, status: action === 'registered' || action === 'admitted' ? 'admitted' : action === 'revoked' ? 'revoked' : 'discovered', at });
  }
}

function defaultDimensions(input: Record<string, unknown> = {}): AgentReputation['dimensions'] {
  return { identity: score(input.identity), quality: score(input.quality), evidence: score(input.evidence), safety: score(input.safety), latency: score(input.latency), cost: score(input.cost), privacy: score(input.privacy), revocation: score(input.revocation) };
}
function score(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.5; }

/**
 * Delegates through a transport while enforcing Context Pack, grant, acknowledgement,
 * idempotency and Result Envelope boundaries. The gateway never writes canonical Brain
 * or Task state on behalf of the remote Agent.
 */
export class AgentGateway {
  private readonly inFlight = new Map<string, { request: DelegationRequest; card: AgentCard; outcome?: DelegationOutcome; promise?: Promise<DelegationOutcome> }>();

  constructor(
    private readonly directory: AgentDirectoryPort,
    private readonly transport: AgentTransport,
    private readonly ledger: GrantLedger = new InMemoryGrantLedger(),
    private readonly callbackSigningKeys: Readonly<Record<string, string>> = {},
  ) {}

  async describeApproved(agentIds: string[], classification: ContextPack['classification']): Promise<ApprovedAgent[]> {
    const approved: ApprovedAgent[] = [];
    for (const agentId of new Set(agentIds)) {
      const card = agentCardSchema.parse(await this.directory.get(agentId));
      if (!card.protocols.includes('aeeis-task/1')) throw new Error('Agent does not support the AEEIS task protocol');
      if (classification === 'private' && card.privacy.dataRetention !== 'none') throw new Error('Private Context Pack requires an Agent with no data retention');
      const { name, cardVersion, capabilities, inputSchemas, outputSchemas, privacy, pricing } = card;
      approved.push({ agentId, name, cardVersion, capabilities, inputSchemas, outputSchemas, privacy, pricing, cardDigest: digestProtocol(card) });
    }
    return structuredClone(approved);
  }

  private async resolveCard(request: DelegationRequest): Promise<AgentCard> {
    const card = agentCardSchema.parse(await this.directory.get(request.agentId));
    if (request.cardDigest !== undefined && request.cardDigest !== digestProtocol(card)) throw new Error('Agent Card changed after Run approval; create a new Run to approve the new Card');
    return card;
  }

  async delegate(input: DelegationRequest): Promise<DelegationOutcome> {
    const request = validateRequest(input);
    await this.assertGrantActive(request);
    const card = await this.resolveCard(request);
    if (!card.protocols.includes('aeeis-task/1')) throw new Error('Agent does not support the AEEIS task protocol');
    const unsupported = request.taskBrief.allowedCapabilities.filter(capability => !card.capabilities.includes(capability));
    if (unsupported.length) throw new Error('Agent does not advertise required capabilities: ' + unsupported.join(', '));
    if (request.contextPack.classification === 'private' && card.privacy.dataRetention !== 'none') throw new Error('Private Context Pack requires an Agent with no data retention');
    const cached = this.inFlight.get(request.idempotencyKey);
    if (cached?.outcome && cached.outcome.status !== 'unknown') return cached.outcome;
    if (cached?.outcome?.status === 'unknown') throw new Error('Delegation outcome is unknown; reconcile before submitting again');
    if (cached && !sameRequest(cached.request, request)) throw new Error('Idempotency key is bound to a different delegation request');
    if (cached?.promise) return cached.promise;
    const promise = (async () => {
      await this.ledger.reserve(request.grant.grantId, request.idempotencyKey, request.grant.budget);
      try {
        const transportRequest = request.onProgress ? {
          ...request,
          onProgress: async (progress: AgentProgressEvent) => {
            await this.assertGrantActive(request);
            validateAgentData('protocol', () => validateProgressForGrant(progress, request.grant, request.contextPack));
            await request.onProgress!(progress);
          },
        } : request;
        const response = await this.transport.submit(card, transportRequest);
        // The grant may expire while the provider is executing. Validate the
        // immutable task/context binding, but permit the already-issued result
        // through the accounting path so it can be charged and isolated.
        const responseGrant = await this.ledger.getGrant(request.grant.grantId);
        const outcome = validateResponse(request, response, { allowExpiredGrant: responseGrant?.status !== 'active' });
        let authorization: GrantAuthorizationReceipt | undefined;
        try { authorization = await this.accountOutcome(request, outcome); }
        catch (error) { throw unknownAgentFailure(error, 'accounting'); }
        if (authorization?.decision === 'isolated') {
          const isolated = isolateOutcome(outcome);
          this.inFlight.set(request.idempotencyKey, { request, card, outcome: isolated });
          return isolated;
        }
        await this.observeOutcome(request, outcome);
        this.inFlight.set(request.idempotencyKey, { request, card, outcome });
        return outcome;
      } catch (error) {
        await this.ledger.markUnknown(request.grant.grantId, request.idempotencyKey).catch(() => undefined);
        throw unknownAgentFailure(error);
      }
    })();
    this.inFlight.set(request.idempotencyKey, { request, card, promise });
    void promise.catch(() => { const current = this.inFlight.get(request.idempotencyKey); if (current?.promise === promise) this.inFlight.delete(request.idempotencyKey); });
    return promise;
  }

  async reconcile(idempotencyKey: string): Promise<DelegationOutcome>;
  async reconcile(request: DelegationRequest, persistedReceipt?: DelegationReceipt): Promise<DelegationOutcome>;
  async reconcile(input: string | DelegationRequest, persistedReceipt?: DelegationReceipt): Promise<DelegationOutcome> {
    const entry = typeof input === 'string' ? this.inFlight.get(input) : undefined;
    const request = typeof input === 'string' ? entry?.request : validateRequest(input, { allowExpired: true });
    if (!request) throw new Error('Unknown delegation idempotency key');
    const grantRecord = await this.assertGrantRegistered(request);
    const card = await this.resolveCard(request);
    if (!card) throw new Error('Agent is not admitted');
    const receipt = persistedReceipt ?? entry?.outcome?.receipt;
    if (!receipt || !['unknown', 'accepted'].includes(receipt.status)) throw new Error('Delegation does not require reconciliation');
    if (!this.transport.reconcile) throw new Error('Agent transport does not support reconciliation');
    await this.ledger.ensureUnknown(request.grant.grantId, request.idempotencyKey, request.grant.budget);
    try {
      const response = await this.transport.reconcile(card, request, receipt);
      const outcome = validateResponse(request, response, { allowExpiredGrant: grantRecord.status !== 'active' });
      let authorization: GrantAuthorizationReceipt | undefined;
      try { authorization = await this.accountOutcome(request, outcome); }
      catch (error) { throw unknownAgentFailure(error, 'accounting'); }
      if (authorization?.decision === 'isolated') {
        const isolated = isolateOutcome(outcome);
        this.inFlight.set(request.idempotencyKey, { request, card, outcome: isolated });
        return isolated;
      }
      await this.observeOutcome(request, outcome);
      this.inFlight.set(request.idempotencyKey, { request, card, outcome });
      return outcome;
    } catch (error) {
      throw unknownAgentFailure(error);
    }
  }

  /** Accepts a callback delivered by an asynchronous Agent. The callback is
   * validated against the original task, context, grant and result schema;
   * it never grants the remote Agent a write path into AEEIS state. */
  async acceptCallback(requestInput: DelegationRequest, response: AgentTransportResponse, authentication?: AgentCallbackAuthentication): Promise<DelegationOutcome> {
    const request = validateRequest(requestInput, { allowExpired: true });
    const grantRecord = await this.assertGrantRegistered(request);
    const card = await this.resolveCard(request);
    if (!card.protocols.includes('aeeis-task/1')) throw new Error('Agent does not support the AEEIS task protocol');
    verifyCallbackAuthentication(card, response, authentication, this.callbackSigningKeys);
    const cached = this.inFlight.get(request.idempotencyKey);
    if (cached?.outcome && !['unknown', 'accepted'].includes(cached.outcome.status)) return cached.outcome;
    const outcome = validateResponse(request, response, { allowExpiredGrant: grantRecord.status !== 'active' });
    await this.ledger.ensureUnknown(request.grant.grantId, request.idempotencyKey, request.grant.budget);
    const authorization = await this.accountOutcome(request, outcome);
    if (authorization?.decision === 'isolated') {
      const isolated = isolateOutcome(outcome);
      this.inFlight.set(request.idempotencyKey, { request, card, outcome: isolated });
      return isolated;
    }
    await this.observeOutcome(request, outcome);
    this.inFlight.set(request.idempotencyKey, { request, card, outcome });
    return outcome;
  }

  /** Register the immutable Grant binding before any budget reservation. A
   * revoked or expired Grant is rejected here, including after a process
   * restart; a late callback therefore cannot write a result back. */
  private async assertGrantActive(request: DelegationRequest): Promise<void> {
    const record = await this.assertGrantRegistered(request);
    if (record.status !== 'active') throw new Error(`Delegation grant is ${record.status}`);
    if (new Date(record.expiresAt).getTime() <= Date.now()) throw new Error('Delegation grant has expired');
  }

  private async assertGrantRegistered(request: DelegationRequest) {
    const record = await this.ledger.ensureGrant({ grant: request.grant, digest: digestProtocol(request.grant) });
    if (record.subjectAgentId !== request.agentId || record.taskId !== request.taskBrief.taskId) throw new Error('Delegation grant binding does not match the request');
    return record;
  }

  private async accountOutcome(request: DelegationRequest, outcome: DelegationOutcome): Promise<GrantAuthorizationReceipt | undefined> {
    if (['unknown', 'accepted'].includes(outcome.status)) {
      await this.ledger.markUnknown(request.grant.grantId, request.idempotencyKey);
      return undefined;
    } else {
      const cost = outcome.result?.cost;
      const settled = await this.ledger.settle(request.grant.grantId, request.idempotencyKey, {
        ...(cost?.tokens === undefined ? {} : { tokens: cost.tokens }),
        ...(cost?.money === undefined ? {} : { money: cost.money }),
      });
      // Older/custom ledgers may still implement the historical void return;
      // retain a conservative compatibility fallback. Built-in File and
      // PostgreSQL ledgers always return the durable receipt above.
      const current = settled ? undefined : await this.ledger.getGrant(request.grant.grantId);
      const authorization: GrantAuthorizationReceipt = settled ?? {
        grantId: request.grant.grantId, idempotencyKey: request.idempotencyKey,
        decision: current?.status === 'active' ? 'authorized' : 'isolated',
        grantStatus: current?.status ?? 'unregistered', settledAt: new Date().toISOString(),
        ...(current?.digest ? { grantDigest: current.digest } : {}),
      };
      outcome.receipt = { ...outcome.receipt, authorization };
      return authorization;
    }
  }

  private async observeOutcome(request: DelegationRequest, outcome: DelegationOutcome): Promise<void> {
    if (outcome.status === 'accepted') return;
    const result = outcome.result;
    const evidenceRefs = result ? [...new Set([...result.artifacts, ...result.claims.flatMap(claim => claim.evidenceRefs), outcome.receipt.receiptRef])] : [outcome.receipt.receiptRef];
    const quality = outcome.status === 'completed' ? 1 : outcome.status === 'partial' ? 0.6 : 0;
    const evidence = result ? (result.claims.length > 0 || result.artifacts.length > 0 ? 1 : 0.5) : 0;
    try {
      await this.directory.recordReputation(request.agentId, { source: 'delegation', taskId: request.taskBrief.taskId, outcome: normalizeObservationOutcome(outcome.status), evidenceRefs, dimensions: { quality, evidence }, note: `gateway outcome: ${outcome.status}` }, 'aeeis-gateway');
    } catch { /* Reputation is secondary telemetry; delegation truth remains in its receipt. */ }
  }
}

export class HttpAgentTransport implements AgentTransport {
  constructor(private readonly timeoutMs = 60_000, private readonly bearerToken?: string, private readonly signingKeys: Readonly<Record<string, string>> = {}, private readonly oauthProvider?: OAuthTokenProvider, private readonly allowInsecureHttp = false, private readonly allowedHosts: readonly string[] = []) {}

  async submit(card: AgentCard, request: DelegationRequest): Promise<AgentTransportResponse> {
    if (!card.endpoint) throw new Error('Agent Card has no endpoint');
    this.checkAuth(card);
    return this.send(card, { schemaVersion: 'agent-task/1', ...request }, request);
  }

  async reconcile(card: AgentCard, request: DelegationRequest, receipt: DelegationReceipt): Promise<AgentTransportResponse> {
    if (!card.endpoint) throw new Error('Agent Card has no endpoint');
    this.checkAuth(card);
    return this.send(card, { schemaVersion: 'agent-reconcile/1', ...request, receipt }, request);
  }

  private checkAuth(card: AgentCard): void {
    if (card.auth.includes('signed_request') && !this.signingKeys[card.agentId]) throw new Error('Agent Card requires a signing key');
    if (card.auth.includes('oauth') && !this.oauthProvider) throw new Error('Agent Card requires an OAuth token provider');
    if (card.auth.includes('bearer') && !this.bearerToken) throw new Error('Agent Card requires a bearer token');
  }

  private async send(card: AgentCard, body: unknown, request: DelegationRequest): Promise<AgentTransportResponse> {
    if (!card.endpoint) throw new Error('Agent Card has no endpoint');
    const url = safeHttpUrl(card.endpoint, this.allowInsecureHttp, 'External Agent endpoint', this.allowedHosts);
    const serialized = JSON.stringify(body);
    const timestamp = String(Date.now());
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (card.auth.includes('oauth')) headers.authorization = `Bearer ${await this.oauthProvider!.token(card.agentId, card)}`;
    else if (card.auth.includes('bearer') && this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;
    if (card.auth.includes('signed_request')) {
      const key = this.signingKeys[card.agentId]!;
      headers['x-aeeis-timestamp'] = timestamp;
      headers['x-aeeis-signature'] = sign(key, timestamp, serialized);
    }
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers, body: serialized });
    } catch (error) {
      throw new AgentOutcomeUnknown('External Agent transport failed before a verifiable response was received', { cause: error });
    }
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) throw new AgentOutcomeUnknown('External Agent returned HTTP ' + response.status + '; remote execution is unverified');
      throw new AgentResponseRejected('http_rejection', 'External Agent rejected the request with HTTP ' + response.status);
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const streamed = request.mode === 'stream' || contentType.includes('application/x-ndjson') || contentType.includes('text/event-stream');
    if (streamed && response.body) {
      if (card.auth.includes('signed_request')) throw new AgentResponseRejected('authentication', 'Signed streaming Agent responses are not supported; use a final signed JSON response or callback');
      return this.readStream(response, request);
    }
    const raw = await response.text();
    if (card.auth.includes('signed_request')) validateAgentData('authentication', () => verifySignature(this.signingKeys[card.agentId]!, response.headers, raw));
    const parsed = validateAgentData('protocol', () => responseSchema.parse(JSON.parse(raw)));
    return toTransportResponse(parsed);
  }

  /** Reads newline-delimited JSON or SSE data frames. Each progress frame is
   * bounded and delivered only through the local callback; the final frame is
   * still the normal AgentTransportResponse and goes through Gateway validation. */
  private async readStream(response: Response, request: DelegationRequest): Promise<AgentTransportResponse> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalBytes = 0;
    let progressCount = 0;
    let lastSequence = 0;
    let final: unknown;
    const consume = async (line: string): Promise<void> => {
      const value = line.trim();
      if (!value || value.startsWith(':') || value === '[DONE]') return;
      const payload = value.startsWith('data:') ? value.slice(5).trim() : value;
      if (!payload || payload === '[DONE]') return;
      let parsed: unknown;
      parsed = validateAgentData('protocol', () => JSON.parse(payload));
      const object = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
      const candidate = object?.type === 'progress' && object.progress && typeof object.progress === 'object' ? object.progress : parsed;
      if (candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).schemaVersion === 'agent-progress/1') {
        progressCount++;
        if (progressCount > 1000) throw new AgentResponseRejected('protocol', 'Streaming Agent response exceeded the progress event limit');
        const progress = validateAgentData('protocol', () => agentProgressEventSchema.parse(candidate));
        if (progress.sequence <= lastSequence) throw new AgentResponseRejected('protocol', 'Streaming Agent progress sequence must increase monotonically');
        lastSequence = progress.sequence;
        validateAgentData('protocol', () => validateProgressForGrant(progress, request.grant, request.contextPack));
        await request.onProgress?.(progress);
        return;
      }
      if (object?.type === 'result' && object.response !== undefined) final = object.response;
      else final = parsed;
    };
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        totalBytes += next.value.byteLength;
        if (totalBytes > 5_000_000) throw new AgentResponseRejected('protocol', 'Streaming Agent response exceeds the size limit');
        buffer += decoder.decode(next.value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
          await consume(line);
        }
        if (buffer.length > 256_000) throw new AgentResponseRejected('protocol', 'Streaming Agent response line exceeds the size limit');
      }
      buffer += decoder.decode();
      if (buffer.trim()) await consume(buffer);
    } finally { reader.releaseLock(); }
    if (final === undefined) throw new Error('Streaming Agent response did not contain a final result');
    return toTransportResponse(validateAgentData('protocol', () => responseSchema.parse(final)));
  }
}

/** Fetches a remote Agent Card for the discovery phase. Discovery never
 * implies admission: callers must still approve the returned card through the
 * registry before it can receive a delegation grant. The response is bounded,
 * redirects are rejected, and non-TLS HTTP is limited to loopback or an
 * explicit development override. */
export class HttpAgentCardDiscovery {
  constructor(private readonly timeoutMs = 10_000, private readonly allowInsecureHttp = false, private readonly maxBytes = 256_000, private readonly allowedHosts: readonly string[] = []) {}

  async fetch(urlInput: string): Promise<AgentCard> {
    const url = safeHttpUrl(urlInput, this.allowInsecureHttp, 'Agent Card URL', this.allowedHosts);
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } });
    } catch (error) {
      throw new Error(`Agent Card discovery failed: ${error instanceof Error ? error.message : 'network error'}`);
    }
    if (!response.ok) throw new Error(`Agent Card discovery returned HTTP ${response.status}`);
    const raw = await readBoundedResponseText(response, this.maxBytes);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('Agent Card discovery returned invalid JSON'); }
    return agentCardSchema.parse(parsed);
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('Agent Card response exceeds the discovery size limit');
    return raw;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error('Agent Card response exceeds the discovery size limit');
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally { reader.releaseLock(); }
}

function safeHttpUrl(input: string, allowInsecureHttp: boolean, label: string, allowedHosts: readonly string[] = []): URL {
  const url = new URL(input);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (allowInsecureHttp || loopback))) throw new Error(`${label} must use HTTPS except loopback or explicit development override`);
  if (url.username || url.password || url.hash) throw new Error(`${label} must not contain credentials or fragments`);
  if (allowedHosts.length > 0) {
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const allowed = allowedHosts.map(value => value.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
    if (!allowed.includes(hostname)) throw new Error(`${label} host is not in the configured Agent endpoint allowlist`);
  }
  return url;
}

function sign(key: string, timestamp: string, body: string): string {
  return createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex');
}

function verifySignature(key: string, headers: Headers, body: string): void {
  const timestamp = headers.get('x-aeeis-timestamp') ?? undefined; const received = headers.get('x-aeeis-signature') ?? undefined;
  verifySignatureValues(key, timestamp, received, body, 'Signed Agent response');
}

function verifyCallbackAuthentication(card: AgentCard, response: AgentTransportResponse, authentication: AgentCallbackAuthentication | undefined, keys: Readonly<Record<string, string>>): void {
  if (!card.auth.includes('signed_request')) {
    if (card.auth.includes('oauth') || card.auth.includes('bearer')) throw new Error('Asynchronous Agent callbacks require signed_request authentication');
    return;
  }
  const key = keys[card.agentId];
  if (!key) throw new Error('Agent Card requires a callback signing key');
  verifySignatureValues(key, authentication?.timestamp, authentication?.signature, authentication?.body ?? JSON.stringify(response), 'Signed Agent callback');
}

function verifySignatureValues(key: string, timestamp: string | undefined, received: string | undefined, body: string, label: string): void {
  if (!timestamp || !received || !/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) throw new AgentCallbackAuthenticationError(`${label} is missing or expired`);
  const expected = sign(key, timestamp, body); const left = Buffer.from(expected); const right = Buffer.from(received);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new AgentCallbackAuthenticationError(`${label} failed verification`);
}

const responseSchema = z.object({
  status: z.enum(['accepted', 'completed', 'partial', 'blocked', 'needs_clarification', 'needs_approval', 'failed', 'rejected', 'unknown']),
  receiptRef: z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/),
  acknowledgement: acknowledgementSchema.optional(),
  result: resultEnvelopeSchema.optional(),
  progress: z.array(agentProgressEventSchema).max(1000).optional(),
}).strict();

function toTransportResponse(parsed: z.infer<typeof responseSchema>): AgentTransportResponse {
  return {
    status: parsed.status,
    receiptRef: parsed.receiptRef,
    ...(parsed.acknowledgement === undefined ? {} : { acknowledgement: parsed.acknowledgement }),
    ...(parsed.result === undefined ? {} : { result: parsed.result }),
    ...(parsed.progress === undefined ? {} : { progress: parsed.progress }),
  };
}

function validateRequest(input: DelegationRequest, options: { allowExpired?: boolean } = {}): DelegationRequest {
  if (input.cardDigest !== undefined) z.string().regex(/^[a-f0-9]{64}$/).parse(input.cardDigest);
  const taskBrief = taskBriefSchema.parse(input.taskBrief);
  const contextPack = contextPackSchema.parse(input.contextPack);
  validateContextPackEvidence(contextPack);
  const grant = delegationGrantSchema.parse(input.grant);
  if (input.agentId !== grant.subjectAgentId) throw new Error('Delegation agent does not match the grant subject');
  if (taskBrief.taskId !== grant.taskId || contextPack.taskId !== grant.taskId) throw new Error('Task, context and grant IDs must match');
  if (taskBrief.contextManifestId !== contextPack.id) throw new Error('Task Brief does not bind to the Context Pack');
  if (!contextPack.audience.includes(input.agentId)) throw new Error('Context Pack audience does not include the delegated agent');
  if (!grant.actions.includes('return_result')) throw new Error('Delegation grant does not permit a result');
  if (classificationRank(contextPack.classification) > classificationRank(grant.dataScope)) throw new Error('Grant data scope is narrower than the Context Pack');
  if (!options.allowExpired && new Date(grant.expiresAt).getTime() <= Date.now()) throw new Error('Delegation grant has expired');
  if (!options.allowExpired && new Date(contextPack.expiresAt).getTime() <= Date.now()) throw new Error('Context Pack has expired');
  if (!input.idempotencyKey.trim()) throw new Error('Delegation idempotency key is required');
  return { ...input, taskBrief, contextPack, grant };
}

function validateResponse(request: DelegationRequest, response: AgentTransportResponse, options: { allowExpiredGrant?: boolean } = {}): DelegationOutcome {
  return validateAgentData('protocol', () => validateResponseData(request, response, options));
}

function validateResponseData(request: DelegationRequest, response: AgentTransportResponse, options: { allowExpiredGrant?: boolean } = {}): DelegationOutcome {
  const status = responseSchema.parse(response);
  if (status.progress) {
    let previous = 0;
    for (const progress of status.progress) {
      if (progress.sequence <= previous) throw new Error('Agent progress sequence must increase monotonically');
      previous = progress.sequence;
      validateProgressForGrant(progress, request.grant, request.contextPack);
    }
  }
  const receipt: DelegationReceipt = {
    receiptRef: status.receiptRef, agentId: request.agentId, taskId: request.taskBrief.taskId,
    idempotencyKey: request.idempotencyKey, status: status.status, contextVersion: request.contextPack.id, acknowledgedAt: new Date().toISOString(),
  };
  if (status.acknowledgement) validateAcknowledgement(request, status.acknowledgement);
  else if (status.status !== 'unknown') throw new Error('Agent response must include a Context Acknowledgement');
  if (status.result) {
    validateResultForGrant(status.result, request.grant, ...(options.allowExpiredGrant === undefined ? [] : [{ allowExpired: options.allowExpiredGrant }]));
    validateResultForContext(status.result, request.contextPack);
    if (status.result.contextVersion !== request.contextPack.id) throw new Error('Agent result context version does not match the delegated Context Pack');
    if (status.result.resultType !== request.taskBrief.expectedOutput) throw new Error('Agent result type does not match the Task Brief');
    if (status.result.status !== status.status) throw new Error('Agent result status does not match transport status');
    if (request.grant.budget.tokens !== undefined && status.result.cost.tokens !== undefined && status.result.cost.tokens > request.grant.budget.tokens) throw new AgentResponseRejected('budget', 'Agent result exceeds the delegation token budget');
    if (request.grant.budget.money !== undefined && status.result.cost.money !== undefined && status.result.cost.money > request.grant.budget.money) throw new AgentResponseRejected('budget', 'Agent result exceeds the delegation money budget');
  } else if (status.status === 'completed' || status.status === 'partial' || status.status === 'failed' || status.status === 'rejected') {
    throw new Error('Completed Agent response must include a Result Envelope');
  }
  return { status: status.status, receipt, ...(status.acknowledgement ? { acknowledgement: status.acknowledgement } : {}), ...(status.result ? { result: status.result } : {}), ...(status.progress ? { progress: status.progress } : {}) };
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

function normalizeObservationOutcome(status: DelegationStatus): 'completed' | 'partial' | 'blocked' | 'failed' | 'rejected' | 'unknown' {
  if (status === 'completed') return 'completed';
  if (status === 'partial') return 'partial';
  if (status === 'blocked' || status === 'needs_clarification' || status === 'needs_approval') return 'blocked';
  if (status === 'rejected') return 'rejected';
  if (status === 'unknown') return 'unknown';
  return 'failed';
}

function isolateOutcome(outcome: DelegationOutcome): DelegationOutcome {
  return { status: outcome.status, receipt: outcome.receipt, disposition: 'isolated',
    ...(outcome.result?.cost ? { isolatedCost: outcome.result.cost } : {}),
  };
}
