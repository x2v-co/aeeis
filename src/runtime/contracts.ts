import { z } from 'zod';
import type { Receipt, ToolInvocation } from '../integrations.js';
import type { ProjectSourceSyncReceipt } from '../project-sources.js';
import type { AgentFailure, AgentProgressEvent, ApprovedAgent, DelegationReceipt, DelegationRequest } from '../agent-gateway.js';
import type { ActiveEvolution } from '../evolution-activation.js';

export const materialSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(30000),
  source: z.string().trim().min(1).max(1000),
}).strict();
export const modelBudgetSchema = z.object({ tokens: z.number().int().positive().optional(), moneyUsd: z.number().nonnegative().optional() }).strict().refine(value => value.tokens !== undefined || value.moneyUsd !== undefined, 'modelBudget must specify tokens or moneyUsd');
/** Budget for billable capabilities invoked by a Run. Calls are counted from
 * durable receipts; token/money limits require the provider to report usage. */
export const externalBudgetSchema = z.object({
  calls: z.number().int().positive().optional(),
  tokens: z.number().int().positive().optional(),
  moneyUsd: z.number().nonnegative().optional(),
}).strict().refine(value => value.calls !== undefined || value.tokens !== undefined || value.moneyUsd !== undefined, 'externalBudget must specify calls, tokens or moneyUsd');
export const requestSchema = z.object({
  goal: z.string().trim().min(1).max(8000),
  goalId: z.string().trim().min(1).max(200).optional(),
  taskExecution: z.object({ domainPlanId: z.string().trim().min(1).max(200), taskId: z.string().trim().min(1).max(200) }).strict().optional(),
  materials: z.array(materialSchema).max(20).default([]),
  /** Built-in output contract, independent of external source connectors. */
  builtinSkill: z.literal('project-pulse/1').optional(),
  maxModelCalls: z.number().int().min(3).max(100).default(20),
  /** Optional per-Run model budget. Money is normalized to USD by Planprice. */
  modelBudget: modelBudgetSchema.optional(),
  externalBudget: externalBudgetSchema.optional(),
  allowedTools: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  allowedAgents: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  knowledgeQuery: z.string().trim().min(1).max(2000).optional(),
  knowledgeMaxItems: z.number().int().min(1).max(20).default(8),
  projectSourceQuery: z.string().trim().min(1).max(2000).optional(),
  projectSourceMaxItems: z.number().int().min(1).max(20).default(8),
  projectSourceCursor: z.string().trim().min(1).max(1000).optional(),
  /** Goal-linked durable memory retrieval. A missing query uses the Run goal. */
  memoryQuery: z.string().trim().min(1).max(2000).optional(),
  memoryMaxItems: z.number().int().min(1).max(50).default(12),
  memoryClassifications: z.array(z.enum(['public', 'internal', 'confidential', 'private'])).max(4).optional(),
  brainScope: z.string().trim().min(1).max(200).optional(),
  brainQuery: z.string().trim().min(1).max(2000).optional(),
  brainMaxItems: z.number().int().min(1).max(100).default(20),
  skillRuntime: z.string().trim().min(1).max(100).optional(),
  privacy: z.enum(['public', 'internal', 'confidential', 'private']).default('internal'),
}).strict();
export const nodeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  title: z.string().min(1).max(200),
  instruction: z.string().min(1).max(4000),
  dependsOn: z.array(z.string()).max(20),
}).strict();
export const planSchema = z.object({
  summary: z.string().min(1).max(4000),
  nodes: z.array(nodeSchema).min(1).max(12),
}).strict();
export const decisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool'), tool: z.enum(['sources.search', 'sources.read']), argument: z.string().min(1).max(1000) }).strict(),
  z.object({ type: z.literal('capability'), toolId: z.string().trim().min(1).max(200), toolVersion: z.string().trim().min(1).max(100), input: z.unknown(), purpose: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('delegate'), agentId: z.string().trim().min(1).max(200), goal: z.string().trim().min(1).max(4000), expectedOutput: z.string().trim().min(1).max(200), mode: z.enum(['sync', 'async', 'stream']).default('sync') }).strict(),
  z.object({ type: z.literal('question'), question: z.string().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('finish'), title: z.string().min(1).max(200), content: z.string().min(1).max(30000), evidenceRefs: z.array(z.string()).max(100), artifactType: z.literal('project-pulse/1').optional(), structured: z.unknown().optional() }).strict(),
]);
export const reviewSchema = z.object({
  verdict: z.enum(['accepted', 'needs_revision']),
  summary: z.string().min(1).max(4000),
  issues: z.array(z.string().min(1).max(2000)).max(20),
  /** Optional calibrated confidence used by governed collaboration triggers. */
  confidence: z.number().min(0).max(1).optional(),
  /** Optional concrete, evidence-backed RSI proposal. A reviewer may surface
   * an opportunity, but the Proposal Pump still verifies every evidence ref
   * against the Run before creating a candidate. */
  improvement: z.object({
    target: z.enum(['profile', 'skill', 'prompt', 'workflow', 'tool-policy', 'model-policy']),
    baseVersion: z.string().trim().min(1).max(200), proposedVersion: z.string().trim().min(1).max(200),
    change: z.string().trim().min(1).max(8000), reason: z.string().trim().min(1).max(4000),
    risk: z.enum(['low', 'medium', 'high']), sourceReceiptRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  }).strict().optional(),
}).strict();
const projectPulseItemSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
}).strict();
const projectPulseOwnerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  responsibility: z.string().trim().min(1).max(1000),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
}).strict();
const projectPulseDeadlineSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  date: z.string().trim().min(1).max(100),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
}).strict();
/** Machine-readable Project Pulse output. Empty sections are valid; every
 * asserted entry must carry at least one source, receipt or artifact ref. */
export const projectPulseArtifactSchema = z.object({
  schemaVersion: z.literal('project-pulse/1'),
  progress: z.array(projectPulseItemSchema).max(30),
  completedChanges: z.array(projectPulseItemSchema).max(30),
  blockers: z.array(projectPulseItemSchema).max(30),
  risks: z.array(projectPulseItemSchema).max(30),
  decisions: z.array(projectPulseItemSchema).max(30),
  owners: z.array(projectPulseOwnerSchema).max(30),
  deadlines: z.array(projectPulseDeadlineSchema).max(30),
  nextActions: z.array(projectPulseItemSchema).max(30),
  unknowns: z.array(projectPulseItemSchema).max(30),
}).strict();
export type TaskRequest = z.infer<typeof requestSchema>;
export type PlanDraft = z.infer<typeof planSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type ProjectPulseArtifact = z.infer<typeof projectPulseArtifactSchema>;
export type ExternalToolInvocation = ToolInvocation & { requestedAt: string; receiptId?: string; globalBudgetAccountKey?: string; /** Durable attempt fence shared by independent Engines. Recovery invalidates it before reconciliation. */ executionToken?: string; /** Durable single-flight marker for cancelled reconciliation. */ reconcileInFlight?: boolean };
export type PendingDelegation = DelegationRequest & { reconcileRequested?: boolean; receiptRef?: string; globalBudgetAccountKey?: string; /** Durable provider-attempt fence shared by independent Engines. */ executionToken?: string; /** Diagnostic for an unknown attempt; the provider result remains untrusted. */ failure?: AgentFailure; /** Durable single-flight marker for cancelled reconciliation. */ reconcileInFlight?: boolean };
export type RunStatus = 'queued' | 'planning' | 'needs_approval' | 'running' | 'needs_input' | 'waiting_external' | 'paused' | 'reviewing' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface Source { id: string; title: string; content: string; source: string; hash: string; classification?: TaskRequest['privacy']; origin?: { runId: string; ref: string } }
export interface Artifact { id: string; taskId: string; title: string; content: string; evidenceRefs: string[]; artifactType?: 'project-pulse/1'; structured?: ProjectPulseArtifact; hash: string; createdAt: string }
/**
 * The transport fields are retained for compatibility with static providers.
 * Catalog-routed runs additionally carry the complete aeeis-model-pin/1
 * identity and pricing snapshot so a restart cannot silently remap a run.
 */
export interface ModelPin {
  model: string; endpoint: string; promptVersion: string; provider?: string;
  schemaVersion?: 'aeeis-model-pin/1'; routingMode?: 'catalog' | 'compatibility' | 'static';
  offeringId?: string | null; modelId?: string | null; modelVersion?: string | null;
  versionStatus?: 'pinned' | 'rolling' | 'unknown'; providerId?: string | null;
  channelId?: string | null; regionSetId?: string | null; pricingVariantId?: string | null;
  catalogVersion?: string | null; catalogDigest?: string | null; catalogHash?: string;
  candidateOfferings?: Array<{ offeringId: string; offeringHash: string }>;
  catalogRetrievedAt?: string; catalogArtifactRef?: string | null; endpointRef?: string;
  requestModel?: string; mappingVersion?: string; resolvedEndpointHash?: string;
  routingPolicyVersion?: string; selectedAt?: string; pricingSnapshot?: unknown;
}
export interface ModelBudget { tokens?: number; moneyUsd?: number }
export interface ModelUsage { tokens: number; moneyUsd?: number; unreportedCalls: number }
export interface ExternalBudget { calls?: number; tokens?: number; moneyUsd?: number }
export interface ExternalUsage { calls: number; tokens: number; moneyUsd?: number; unreportedCalls: number; unreportedTokenCalls: number; unreportedMoneyCalls: number }
export interface ModelCall {
  id: string; phase: 'planner' | 'executor' | 'reviewer'; taskId?: string;
  /** Provider idempotency key. Unknown calls reuse this key after reconcile. */
  idempotencyKey?: string;
  /** Shared tenant budget account pinned when this call was reserved. */
  globalBudgetAccountKey?: string;
  state: 'started' | 'completed' | 'failed' | 'unknown' | 'discarded';
  inputHash: string; outputHash?: string; startedAt: string; endedAt?: string;
  usage?: { inputTokens: number; outputTokens: number };
}
/** A provider-confirmed result waiting for the normal Runtime phase handler.
 * It is deliberately short-lived: `advance` consumes it exactly once and
 * still applies the planner/executor/reviewer schema and evidence checks. */
export interface ReconciledModelCall { callId: string; value: unknown; usage?: { inputTokens: number; outputTokens: number } }
export interface Event { id: string; seq: number; type: string; at: string; data: Record<string, unknown> }
export interface RunCorrection { id: string; text: string; candidateId?: string; sourceRefs: string[]; createdAt: string }
export interface Step {
  taskId: string; status: 'pending' | 'running' | 'succeeded';
  attempts: number; observations: Array<{ tool: string; argument: string; result: unknown }>;
}
export interface AgentRun {
  schemaVersion: 1; id: string; revision: number; owner: string; tenantId?: string;
  goal: string; goalId?: string; domainPlanId?: string;
  /** When present, this Run is the execution receipt for one existing domain task. */
  taskExecution?: { domainPlanId: string; taskId: string; requestHash: string };
  followUpPlanId?: string;
  status: RunStatus; createdAt: string; updatedAt: string;
  context: { id: string; audience: string[]; sources: Source[]; projectSourceSync?: ProjectSourceSyncReceipt; memoryManifestId?: string; memoryManifestHash?: string; memoryRefs?: string[] };
  privacy: TaskRequest['privacy'];
  skillRuntime?: string;
  builtinSkill?: TaskRequest['builtinSkill'];
  model: ModelPin; modelDecision?: Record<string, unknown>; maxModelCalls: number; modelBudget?: ModelBudget; modelUsage?: ModelUsage; externalBudget?: ExternalBudget; externalUsage?: ExternalUsage; calls: ModelCall[];
  evolution?: ActiveEvolution[];
  evolutionTraffic?: Array<{ routeId: string; target: ActiveEvolution['target']; candidateId: string; percentage: number; bucket: number; selected: boolean }>;
  allowedTools: string[];
  allowedAgents: string[];
  knowledgeQuery?: string;
  knowledgeMaxItems: number;
  projectSourceQuery?: string;
  projectSourceMaxItems: number;
  projectSourceCursor?: string;
  memoryQuery?: string;
  memoryMaxItems?: number;
  memoryClassifications?: Array<'public' | 'internal' | 'confidential' | 'private'>;
  brainScope?: string;
  brainQuery?: string;
  brainMaxItems: number;
  approvedTools?: Array<{ id: string; version: string; capabilities: string[]; description?: string; inputSchema?: unknown; outputSchema?: unknown }>;
  approvedAgents?: ApprovedAgent[];
  /** Versioned model context, preserved for older unknown-call reconciliation. */
  capabilityCatalogVersion?: 1;
  toolManifestDigest?: string;
  skillSelection?: { methodId?: string; version?: string; plan: unknown; receiptRef?: string };
  skillOutcome?: { outcome: 'success' | 'failure'; receiptRef?: string; error?: string };
  toolReceipts: Receipt[]; pendingTool?: ExternalToolInvocation; pendingDelegation?: PendingDelegation;
  /** Validated external-Agent progress, keyed by the durable delegation. */
  agentProgress?: Array<{ idempotencyKey: string; progress: AgentProgressEvent }>;
  delegationOutcomes?: Array<{ idempotencyKey: string; status: string; receiptRef: string; contextVersion: string; receipt: DelegationReceipt; result?: unknown; disposition?: 'isolated'; isolatedCost?: { tokens?: number | undefined; money?: number | undefined; currency?: string | undefined } }>;
  plans: Array<PlanDraft & { version: number; hash: string; createdAt: string }>;
  steps: Step[]; artifacts: Artifact[]; events: Event[];
  corrections?: RunCorrection[];
  approval?: { planHash: string; approved: boolean; actor?: string; at?: string };
  question?: { taskId: string; text: string };
  answers: Array<{ taskId: string; question: string; answer: string }>;
  review?: Review;
  error?: string;
  resumeStatus?: RunStatus;
  resumeModelCallId?: string;
  /** How an interrupted model call should be handled after provider reconciliation. */
  reconcileDisposition?: 'running' | 'paused' | 'cancelled';
  reconciledModelCall?: ReconciledModelCall;
}

export function validatePlan(value: unknown): PlanDraft {
  const plan = planSchema.parse(value);
  const byId = new Map(plan.nodes.map(n => [n.id, n]));
  if (byId.size !== plan.nodes.length) throw new Error('Duplicate task ID');
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error('Plan graph contains a cycle');
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) throw new Error('Plan references a missing dependency');
    if (new Set(node.dependsOn).size !== node.dependsOn.length) throw new Error('Duplicate dependency');
    visiting.add(id);
    for (const dependency of node.dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  return plan;
}
