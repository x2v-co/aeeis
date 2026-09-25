import { createHash } from 'node:crypto';
import { z } from 'zod';

export const protocolVersion = 'aeeis/1';

const id = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const isoDate = z.string().datetime({ offset: true });
// Evidence references use the Runtime source namespace (including Git and
// connector IDs). Principal/Agent/task identities keep their stricter grammar.
const evidenceId = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{1,199}$/);
const refs = z.array(evidenceId).max(1000);

export const agentCardSchema = z.object({
  schemaVersion: z.literal('agent-card/1'), agentId: id, name: z.string().min(1).max(200), owner: z.string().min(1).max(200),
  protocols: z.array(z.string().min(1).max(100)).min(1).max(20), capabilities: z.array(z.string().min(1).max(100)).max(100),
  inputSchemas: z.array(z.string().min(1).max(200)).max(100), outputSchemas: z.array(z.string().min(1).max(200)).max(100),
  auth: z.array(z.enum(['signed_request', 'oauth', 'bearer', 'local'])).max(10),
  privacy: z.object({ dataRetention: z.enum(['none', 'session', 'declared']), regions: z.array(z.string().max(100)).max(20) }).strict(),
  pricing: z.object({ unit: z.string().min(1).max(100), amount: z.number().nonnegative().optional(), currency: z.string().max(10).optional() }).strict(),
  cardVersion: z.string().regex(/^\d+$/), endpoint: z.string().url().optional(), expiresAt: isoDate.optional(),
}).strict();

export const taskBriefSchema = z.object({
  schemaVersion: z.literal('task-brief/1'), taskId: id, goal: z.string().min(1).max(8000), nonGoals: z.array(z.string().max(1000)).max(50),
  contextManifestId: id, knownFacts: z.array(z.object({ claim: z.string().min(1).max(4000), evidenceRefs: refs }).strict()).max(200),
  constraints: z.array(z.string().max(2000)).max(100), expectedOutput: z.string().min(1).max(200), deadline: isoDate.optional(),
  budget: z.object({ tokens: z.number().int().positive().optional(), money: z.number().nonnegative().optional(), currency: z.string().max(10).optional() }).strict(),
  allowedCapabilities: z.array(z.string().max(100)).max(100),
}).strict();

export const contextPackSchema = z.object({
  schemaVersion: z.literal('context-pack/1'), id, taskId: id, version: z.number().int().positive(), audience: z.array(id).min(1).max(50),
  classification: z.enum(['public', 'internal', 'confidential', 'private']), expiresAt: isoDate, sourceRefs: refs, artifactRefs: refs,
  claims: z.array(z.object({ id: evidenceId, text: z.string().min(1).max(4000), evidenceRefs: refs }).strict()).max(500),
  redactions: z.array(z.string().max(500)).max(100), digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const acknowledgementSchema = z.object({
  schemaVersion: z.literal('context-ack/1'), taskId: id, contextVersion: id, understoodGoal: z.boolean(), missingInformation: z.array(z.string().max(2000)).max(50),
  assumptions: z.array(z.string().max(2000)).max(50), conflicts: z.array(z.string().max(2000)).max(50), ready: z.boolean(),
}).strict();

/**
 * Bounded, non-authoritative progress emitted while an external Agent is
 * working. Progress is telemetry only: it cannot mutate AEEIS state, grant a
 * capability, or replace the final Result Envelope. The task/context binding
 * lets the Gateway reject a late event from another delegation.
 */
export const agentProgressEventSchema = z.object({
  schemaVersion: z.literal('agent-progress/1'),
  taskId: id,
  agentId: id,
  contextVersion: id,
  sequence: z.number().int().positive().max(100_000),
  status: z.enum(['started', 'running', 'waiting', 'checkpoint', 'completed', 'failed']),
  message: z.string().max(4000),
  percent: z.number().finite().min(0).max(100).optional(),
  evidenceRefs: refs,
  artifactRefs: refs,
  at: isoDate,
}).strict();

export const delegationGrantSchema = z.object({
  schemaVersion: z.literal('delegation-grant/1'), grantId: id, subjectAgentId: id, issuerAgentId: id, taskId: id,
  purpose: z.string().min(1).max(2000), actions: z.array(z.enum(['read_context', 'read_source', 'use_tool', 'return_result', 'write_artifact', 'write_brain', 'modify_task', 'send_message', 'act_as_aeeis'])).min(1).max(20),
  resourceRefs: refs, dataScope: z.enum(['public', 'internal', 'confidential', 'private']), issuedAt: isoDate, expiresAt: isoDate,
  budget: z.object({ calls: z.number().int().positive().optional(), tokens: z.number().int().positive().optional(), money: z.number().nonnegative().optional() }).strict(),
  delegationChain: z.array(id).max(20), revocationRef: id, nonce: z.string().min(16).max(200),
}).strict();

export const resultEnvelopeSchema = z.object({
  schemaVersion: z.literal('result-envelope/1'), taskId: id, agentId: id,
  status: z.enum(['accepted', 'completed', 'partial', 'blocked', 'needs_clarification', 'needs_approval', 'failed', 'rejected', 'unknown']),
  resultType: z.string().min(1).max(200), summary: z.string().max(4000),
  claims: z.array(z.object({ text: z.string().min(1).max(4000), confidence: z.number().min(0).max(1), evidenceRefs: refs }).strict()).max(500),
  artifacts: refs, unresolved: z.array(z.string().max(2000)).max(100), requestedFollowups: z.array(z.string().max(2000)).max(100),
  cost: z.object({ tokens: z.number().int().nonnegative().optional(), money: z.number().nonnegative().optional(), currency: z.string().max(10).optional() }).strict(),
  capabilitiesUsed: z.array(z.string().max(100)).max(100), contextVersion: id, receiptRef: id,
}).strict();

export type AgentCard = z.infer<typeof agentCardSchema>;
export type TaskBrief = z.infer<typeof taskBriefSchema>;
export type ContextPack = z.infer<typeof contextPackSchema>;
export type ContextAcknowledgement = z.infer<typeof acknowledgementSchema>;
export type AgentProgressEvent = z.infer<typeof agentProgressEventSchema>;
export type DelegationGrant = z.infer<typeof delegationGrantSchema>;
export type ResultEnvelope = z.infer<typeof resultEnvelopeSchema>;

/**
 * A Context Pack is already a narrowed evidence boundary.  Validate its
 * claims before a remote Agent sees it so a claim cannot act as an alias for
 * an arbitrary, unbound evidence ID.  Claims may cite sources, artifacts, or
 * other claims in the same frozen pack, but never themselves.
 */
export function validateContextPackEvidence(context: ContextPack): void {
  const claimIds = new Set<string>();
  for (const claim of context.claims) {
    if (claimIds.has(claim.id)) throw new Error('Context Pack contains duplicate claim IDs');
    claimIds.add(claim.id);
  }
  const allowed = new Set([...context.sourceRefs, ...context.artifactRefs, ...claimIds]);
  for (const claim of context.claims) {
    if (claim.evidenceRefs.length === 0) throw new Error(`Context Pack claim ${claim.id} must cite evidence`);
    if (claim.evidenceRefs.some(ref => ref === claim.id)) throw new Error(`Context Pack claim ${claim.id} cannot cite itself`);
    if (claim.evidenceRefs.some(ref => !allowed.has(ref))) throw new Error(`Context Pack claim ${claim.id} cites evidence outside the Context Pack`);
  }
}

/**
 * Result claims are suggestions until AEEIS can bind every citation to the
 * delegated Context Pack.  A remote Agent cannot introduce a new source or
 * artifact reference merely by naming it in a Result Envelope; a future
 * artifact upload protocol can add the reference to the pack first.
 */
export function validateResultForContext(result: ResultEnvelope, context: ContextPack): void {
  validateContextPackEvidence(context);
  const allowedClaims = new Set(context.claims.map(claim => claim.id));
  const allowedSources = new Set(context.sourceRefs);
  const allowedArtifacts = new Set(context.artifactRefs);
  const allowedEvidence = new Set([...allowedClaims, ...allowedSources, ...allowedArtifacts]);
  for (const claim of result.claims) {
    if (claim.evidenceRefs.length === 0) throw new Error('Result claim must cite at least one Context Pack evidence reference');
    if (claim.evidenceRefs.some(ref => !allowedEvidence.has(ref))) throw new Error('Result claim cites evidence outside the Context Pack');
  }
  if (result.artifacts.some(ref => !allowedArtifacts.has(ref))) throw new Error('Result artifact is outside the Context Pack');
}

export function digestProtocol(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonicalize(nested)]));
  return value;
}

export function validateResultForGrant(result: ResultEnvelope, grant: DelegationGrant, options: { allowExpired?: boolean } = {}): void {
  if (result.taskId !== grant.taskId) throw new Error('Result task does not match delegation grant');
  if (result.agentId !== grant.subjectAgentId) throw new Error('Result agent does not match delegation grant');
  if (!grant.actions.includes('return_result')) throw new Error('Grant does not permit returning a result');
  if (!options.allowExpired && new Date(grant.expiresAt).getTime() <= Date.now()) throw new Error('Delegation grant has expired');
  const forbidden = result.capabilitiesUsed.filter(capability => !grant.actions.includes('use_tool') && capability.startsWith('tool:'));
  if (forbidden.length > 0) throw new Error('Result claims capabilities outside its delegation grant');
}

export function validateProgressForGrant(progress: AgentProgressEvent, grant: DelegationGrant, context: ContextPack): void {
  agentProgressEventSchema.parse(progress);
  if (progress.taskId !== grant.taskId || progress.taskId !== context.taskId) throw new Error('Agent progress is bound to another task');
  if (progress.agentId !== grant.subjectAgentId || !context.audience.includes(progress.agentId)) throw new Error('Agent progress is bound to another Agent');
  if (progress.contextVersion !== context.id) throw new Error('Agent progress context version does not match the delegated Context Pack');
  if (new Date(progress.at).getTime() > Date.now() + 5 * 60_000) throw new Error('Agent progress timestamp is too far in the future');
  const allowed = new Set([...context.sourceRefs, ...context.artifactRefs]);
  if (progress.evidenceRefs.some(ref => !allowed.has(ref)) || progress.artifactRefs.some(ref => !allowed.has(ref))) throw new Error('Agent progress cites a resource outside the Context Pack');
}

export function createContextPack(input: Omit<ContextPack, 'digest'>): ContextPack {
  const candidate = { ...input, digest: digestProtocol(input) };
  const context = contextPackSchema.parse(candidate);
  validateContextPackEvidence(context);
  return context;
}
