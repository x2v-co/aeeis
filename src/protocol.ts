import { createHash } from 'node:crypto';
import { z } from 'zod';

export const protocolVersion = 'aeeis/1';

const id = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const isoDate = z.string().datetime({ offset: true });
const refs = z.array(id).max(1000);

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
  claims: z.array(z.object({ id, text: z.string().min(1).max(4000), evidenceRefs: refs }).strict()).max(500),
  redactions: z.array(z.string().max(500)).max(100), digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const acknowledgementSchema = z.object({
  schemaVersion: z.literal('context-ack/1'), taskId: id, contextVersion: id, understoodGoal: z.boolean(), missingInformation: z.array(z.string().max(2000)).max(50),
  assumptions: z.array(z.string().max(2000)).max(50), conflicts: z.array(z.string().max(2000)).max(50), ready: z.boolean(),
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
export type DelegationGrant = z.infer<typeof delegationGrantSchema>;
export type ResultEnvelope = z.infer<typeof resultEnvelopeSchema>;

export function digestProtocol(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function validateResultForGrant(result: ResultEnvelope, grant: DelegationGrant): void {
  if (result.taskId !== grant.taskId) throw new Error('Result task does not match delegation grant');
  if (result.agentId !== grant.subjectAgentId) throw new Error('Result agent does not match delegation grant');
  if (!grant.actions.includes('return_result')) throw new Error('Grant does not permit returning a result');
  if (new Date(grant.expiresAt).getTime() <= Date.now()) throw new Error('Delegation grant has expired');
  const forbidden = result.capabilitiesUsed.filter(capability => !grant.actions.includes('use_tool') && capability.startsWith('tool:'));
  if (forbidden.length > 0) throw new Error('Result claims capabilities outside its delegation grant');
}

export function createContextPack(input: Omit<ContextPack, 'digest'>): ContextPack {
  return { ...input, digest: digestProtocol(input) };
}
