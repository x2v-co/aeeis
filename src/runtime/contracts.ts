import { z } from 'zod';
import { contextDecisionSchema, workingMemoryOptionSchema, type WorkingMemory } from './working-memory.js';
import { csvQueryDecisionSchema } from './csv-query.js';
import { structuredSourceDecisionSchemas } from './source-readers.js';
import { pdfDecisionSchemas, pdfValueSchema, type PdfOutput } from './fillable-pdf.js';
import { decodePdfMaterial, isBinaryPdf, MAX_PDF_CONTENT_CHARS } from './pdf-material.js';
import type { ThreadHistory } from './thread-history.js';
import type { Receipt, ToolInvocation } from '../integrations.js';
import type { ProjectSourceSyncReceipt } from '../project-sources.js';
import type { AgentFailure, AgentProgressEvent, ApprovedAgent, DelegationReceipt, DelegationRequest } from '../agent-gateway.js';
import type { ActiveEvolution } from '../evolution-activation.js';
import { actionOriginSchema, actionPolicySchema, type ActionDecision, type ActionOrigin, type ActionPolicy } from './action-policy.js';

export const materialSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(MAX_PDF_CONTENT_CHARS).superRefine((content, context) => {
    if (!isBinaryPdf(content)) { if (content.length > 30000) context.addIssue({ code: 'custom', message: 'Text material exceeds 30000 characters' }); return; }
    try { decodePdfMaterial(content); } catch (error) { context.addIssue({ code: 'custom', message: (error as Error).message }); }
  }),
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
const resourceVersionSchema = z.string().trim().min(1).max(100);
const resourceDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const resourceRefSchema = z.object({
  /** Registry release identity. Optional for legacy callers that provide an
   * already-resolved reference without a Registry connection. */
  releaseId: z.string().trim().min(1).max(200).optional(),
  id: z.string().trim().min(1).max(200),
  version: resourceVersionSchema,
  /** Optional semver range accepted at the Registry boundary. Resolved Run
   * snapshots always replace it with the concrete manifest version. */
  range: z.string().trim().min(1).max(100).optional(),
  digest: resourceDigestSchema,
  interface: z.string().trim().min(1).max(100),
  channel: z.enum(['dev', 'canary', 'beta', 'stable']).optional(),
}).strict();
export const resourceSelectionSchema = z.object({
  plugin: resourceRefSchema.optional(),
  skill: resourceRefSchema.optional(),
  workflow: resourceRefSchema.optional(),
  tools: z.array(resourceRefSchema).max(100).optional(),
  lockfileDigest: resourceDigestSchema.optional(),
  policyDigest: resourceDigestSchema.optional(),
}).strict();
export const requestSchema = z.object({
  goal: z.string().trim().min(1).max(8000),
  goalId: z.string().trim().min(1).max(200).optional(),
  taskExecution: z.object({ domainPlanId: z.string().trim().min(1).max(200), taskId: z.string().trim().min(1).max(200) }).strict().optional(),
  materials: z.array(materialSchema).max(20).default([]),
  /** Built-in output contract, independent of external source connectors. */
  builtinSkill: z.enum(['project-pulse/1', 'website-builder/1', 'fillable-pdf/1']).optional(),
  /** Optional compatibility declaration. The Runtime resolves concrete versions
   * and records them in the Run; callers cannot change an approved tool version. */
  resources: resourceSelectionSchema.optional(),
  maxModelCalls: z.number().int().min(3).max(100).default(20),
  workingMemory: workingMemoryOptionSchema.optional(),
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
  /** Plan-review gate chosen by the owner when this Run is created. Missing means required. */
  executionReview: z.enum(['required', 'auto', 'yolo']).optional(),
  /** Who proposes the first plan. Missing means the planner. `direct` is admitted only for one read-only deliverable. */
  planning: z.enum(['direct', 'dag']).optional(),
  /** Owner-selected model for this task kind. The runtime accepts it only when that model is already selectable. */
  preferredModel: z.object({
    model: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/),
    provider: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/).optional(),
  }).strict().optional(),
  /** Owner's exact allow and block refs for external side effects, frozen on the Run. */
  actionPolicy: actionPolicySchema.optional(),
  /** Who started this Run. Missing means the owner. A non-owner origin only adds review. */
  origin: actionOriginSchema.optional(),
}).strict();
export const nodeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  title: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(4000),
  evidenceRequirements: z.string().trim().min(1).max(4000).optional(),
  dependsOn: z.array(z.string()).max(20).default([]),
}).strip();
// Model planning metadata is not part of the executable plan. Strip it before
// graph validation and hashing; request/authorization schemas stay strict.
export const planSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  nodes: z.array(nodeSchema).min(1).max(12),
}).strip();
const planVersionSchema = z.number().int().positive();
export const approvalBudgetsSchema = z.object({
  planVersion: planVersionSchema,
  modelBudget: modelBudgetSchema.nullable().optional(),
  externalBudget: externalBudgetSchema.nullable().optional(),
}).strict();
export const approvePlanSchema = approvalBudgetsSchema.extend({ planHash: z.string().min(1), duration: z.enum(['task', 'once']).optional() });
export const revisePlanSchema = z.object({ planVersion: planVersionSchema, feedback: z.string().trim().min(1).max(8000) }).strict();
export const editPlanSchema = z.object({
  planVersion: planVersionSchema,
  plan: planSchema.extend({ nodes: z.array(nodeSchema.strict()).min(1).max(12) }).strict(),
}).strict();
export const decisionSchema = z.discriminatedUnion('type', [
  z.discriminatedUnion('tool', [
    z.object({ type: z.literal('tool'), tool: z.enum(['sources.search', 'sources.read']), argument: z.string().min(1).max(1000), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), limit: z.number().int().min(1).max(100).optional(), characterOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strip(),
    csvQueryDecisionSchema,
    contextDecisionSchema,
    ...structuredSourceDecisionSchemas,
    ...pdfDecisionSchemas,
  ]),
  z.object({ type: z.literal('capability'), toolId: z.string().trim().min(1).max(200), toolVersion: z.string().trim().min(1).max(100), input: z.unknown(), purpose: z.string().trim().min(1).max(2000) }).strip(),
  z.object({ type: z.literal('delegate'), agentId: z.string().trim().min(1).max(200), goal: z.string().trim().min(1).max(4000), expectedOutput: z.string().trim().min(1).max(200), mode: z.enum(['sync', 'async', 'stream']).default('sync') }).strip(),
  z.object({ type: z.literal('question'), question: z.string().min(1).max(2000), missing: z.array(z.string().trim().min(1).max(200)).max(30).optional() }).strip(),
  z.object({ type: z.literal('finish'), title: z.string().min(1).max(200), content: z.string().min(1).max(30000), evidenceRefs: z.array(z.string()).max(100).default([]), artifactType: z.enum(['project-pulse/1', 'website-builder/1', 'fillable-pdf/1']).optional(), structured: z.unknown().optional(), limitations: z.array(z.string().trim().min(1).max(2000)).max(50).optional() }).strip(),
]);
export const reviewSchema = z.object({
  verdict: z.enum(['accepted', 'needs_revision']),
  summary: z.string().min(1).max(4000),
  issues: z.preprocess(value => typeof value === 'string' ? [value] : value, z.array(z.string().min(1).max(2000)).max(20).default([])),
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
  }).strip().optional(),
}).strip();
const projectPulseItemSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
  derived: z.literal(true).optional(),
}).strip();
const projectPulseOwnerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  responsibility: z.string().trim().min(1).max(1000),
  derived: z.literal(true).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
}).strip();
const projectPulseDeadlineSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  date: z.string().trim().min(1).max(100),
  derived: z.literal(true).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
}).strip();
const workspacePathSchema = z.string().trim().min(1).max(1000).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => part === '' || part === '.' || part === '..'), 'path must be relative to the Run workspace');
const websiteBuilderEvidenceItemSchema = z.object({ text: z.string().trim().min(1).max(2000), evidenceRefs: z.array(z.string().trim().min(1).max(50)).min(1) }).strip();
export const websiteBuilderArtifactSchema = z.object({
  schemaVersion: z.literal('website-builder/1'),
  changedFiles: z.array(workspacePathSchema).max(500),
  preview: z.object({ url: z.string().url().optional(), status: z.enum(['started', 'ready', 'failed', 'unknown']), evidenceRefs: z.array(z.string().trim().min(1).max(50)).min(1) }).strip().optional(),
  validation: z.array(z.object({ name: z.string().trim().min(1).max(200), status: z.enum(['passed', 'failed', 'skipped', 'unknown']), evidenceRefs: z.array(z.string().trim().min(1).max(50)).min(1) }).strip()).max(100),
  artifacts: z.array(z.object({ path: workspacePathSchema, kind: z.string().trim().min(1).max(100).optional(), evidenceRefs: z.array(z.string().trim().min(1).max(50)).min(1) }).strip()).max(100),
  blockers: z.array(websiteBuilderEvidenceItemSchema).max(50),
  unknowns: z.array(websiteBuilderEvidenceItemSchema).max(50),
}).strip();
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
}).strip();
export const fillablePdfArtifactSchema = z.object({
  schemaVersion: z.literal('fillable-pdf/1'),
  form: z.object({ sourceRef: z.string().trim().min(1).max(200), fieldCount: z.number().int().min(1).max(200) }).strip(),
  filledFields: z.array(z.object({ name: z.string().min(1).max(200), value: pdfValueSchema, evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(50) }).strip()).max(200),
  inferences: z.array(z.object({ field: z.string().min(1).max(200), value: pdfValueSchema, text: z.string().trim().min(1).max(2000), evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(50) }).strip()).max(200).optional(),
  unknowns: z.array(z.object({ field: z.string().min(1).max(200).optional(), text: z.string().trim().min(1).max(2000), evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(50) }).strip()).max(250),
  output: z.object({ filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,190}\.pdf$/), sha256: resourceDigestSchema, sizeBytes: z.number().int().positive(), ref: z.string().min(1).max(200) }).strip(),
  blockers: z.array(projectPulseItemSchema).max(50),
}).strip();
export type TaskRequest = z.infer<typeof requestSchema>;
export type PlanDraft = z.infer<typeof planSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type ProjectPulseArtifact = z.infer<typeof projectPulseArtifactSchema>;
export type WebsiteBuilderArtifact = z.infer<typeof websiteBuilderArtifactSchema>;
export type FillablePdfArtifact = z.infer<typeof fillablePdfArtifactSchema>;
export type ExternalToolInvocation = ToolInvocation & { requestedAt: string; receiptId?: string; globalBudgetAccountKey?: string; /** Durable attempt fence shared by independent Engines. Recovery invalidates it before reconciliation. */ executionToken?: string; /** Durable single-flight marker for cancelled reconciliation. */ reconcileInFlight?: boolean };
export type PendingDelegation = DelegationRequest & { reconcileRequested?: boolean; receiptRef?: string; globalBudgetAccountKey?: string; /** Durable provider-attempt fence shared by independent Engines. */ executionToken?: string; /** Diagnostic for an unknown attempt; the provider result remains untrusted. */ failure?: AgentFailure; /** Durable single-flight marker for cancelled reconciliation. */ reconcileInFlight?: boolean };
export type RunStatus = 'queued' | 'planning' | 'needs_approval' | 'running' | 'needs_input' | 'waiting_external' | 'paused' | 'reviewing' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface Source {
  id: string; title: string; content: string; source: string; hash: string;
  /** Hash of the exact content presented to a model. */
  contentHash?: string;
  /** Identifies the source family in the evidence graph. */
  kind?: 'material' | 'knowledge' | 'project-source' | 'memory' | 'brain' | 'run-evidence' | 'unknown';
  /** User/connector material is data, never an instruction channel. */
  untrusted?: boolean;
  classification?: TaskRequest['privacy']; origin?: { runId: string; ref: string }
}
export type ResourceRef = z.infer<typeof resourceRefSchema>;
export type ResourceSelection = z.infer<typeof resourceSelectionSchema>;
export interface ResourceSnapshot extends ResourceSelection {
  resolvedAt: string;
  resolverVersion: 'aeeis-resource-resolver/1';
  /** Revision of the Registry used to resolve this Run. It is audit metadata;
   * old Runs continue to use their immutable release digests after promotion. */
  registryRevision?: string;
}
export interface Artifact { id: string; taskId: string; title: string; content: string; evidenceRefs: string[]; partial?: boolean; limitations?: string[]; artifactType?: 'project-pulse/1' | 'website-builder/1' | 'fillable-pdf/1'; structured?: ProjectPulseArtifact | WebsiteBuilderArtifact | FillablePdfArtifact;
  /** Runtime-only attachment for a completed PDF whose field evidence is unverified. */
  retainedPdfOutput?: FillablePdfArtifact['output'] & { sourceRef: string };
  hash: string; createdAt: string }
/**
 * The transport fields are retained for compatibility with static providers.
 * Catalog-routed runs additionally carry the complete aeeis-model-pin/1
 * identity and pricing snapshot so a restart cannot silently remap a run.
 */
export interface ModelPin {
  model: string; endpoint: string; promptVersion: string; provider?: string;
  /** Catalog input/output prices cannot price this adapter's usage. */
  usageAccounting?: 'tokens-only';
  /** Initial output allowance and, when known, the provider's output limit. */
  maxTokens?: number; maxOutputTokens?: number;
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
export interface ModelCallUsage {
  /** Total input includes cache reads/writes exactly once. */
  inputTokens: number;
  outputTokens: number;
  details?: {
    source: 'pi-ai/1.3.0';
    accounting: 'tokens-only';
    reported: {
      input_tokens: number; output_tokens: number; total_tokens?: number;
      input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
    /** Absent fields are unknown, not zero. */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    normalized: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
  };
}
export interface ExternalBudget { calls?: number; tokens?: number; moneyUsd?: number }
export interface ExternalUsage { calls: number; tokens: number; moneyUsd?: number; unreportedCalls: number; unreportedTokenCalls: number; unreportedMoneyCalls: number }
export interface ModelCall {
  /** Exact logical request reserved for this call, before transport callbacks/options. */
  modelRequest?: { system: string; input: unknown; maxTokens?: number; maxResponseBytes?: number; timeoutMs?: number; disableRetries?: boolean; thinking?: 'enabled' | 'disabled' | 'auto' | null; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | null };
  rawOutput?: string;
  validationErrors?: Array<{ path: string; code: string; message: string }>;
  id: string; phase: 'planner' | 'executor' | 'reviewer' | 'compaction'; taskId?: string;
  /** Compaction attempt fence; a reconciled retry must reject an older in-flight response. */
  executionToken?: string;
  /** Provider idempotency key. Unknown calls reuse this key after reconcile. */
  idempotencyKey?: string;
  /** Recorded transport variants; the original logical request/hash stays intact. */
  thinkingUnsupported?: boolean;
  midstreamRetries?: number;
  /** Shared tenant budget account pinned when this call was reserved. */
  globalBudgetAccountKey?: string;
  state: 'started' | 'completed' | 'failed' | 'unknown' | 'discarded';
  inputHash: string; outputHash?: string; startedAt: string; endedAt?: string;
  usage?: ModelCallUsage;
}
/** A provider-confirmed result waiting for the normal Runtime phase handler.
 * It is deliberately short-lived: `advance` consumes it exactly once and
 * still applies the planner/executor/reviewer schema and evidence checks. */
export interface ReconciledModelCall { callId: string; value: unknown; usage?: ModelCallUsage }
export interface Event { id: string; seq: number; type: string; at: string; data: Record<string, unknown> }
export interface RunCorrection { id: string; text: string; candidateId?: string; sourceRefs: string[]; createdAt: string }
export interface Step {
  limitReason?: string;
  finalCallId?: string;
  error?: string; failureReason?: string;
  taskId: string; status: 'pending' | 'running' | 'succeeded';
  attempts: number; observations: Array<{ tool: string; argument: string; result: unknown; sourcePageCost?: 0; requestHash?: string }>;
  /** One bounded, durable model attempt to repair a candidate finish object. */
  finishRepair?: { reason: string; candidate: unknown; problems?: Array<{ path: string; code: string; message: string }>; discarded?: string };
  /** Bounded corrective turns, independent of the exhausted ordinary allowance. */
  outputRecovery?: { reason: string; candidate: unknown; problems: Array<{ path: string; code: string; message: string }>; toolsAllowed: boolean; callOffset: number; exhausted?: boolean };
  outputRecoveryAttempts?: number;
  /** r74: the task's executor call already timed out once with nothing retained and was retried. */
  timeoutRetried?: boolean;
  /** r78: index of the retry call that may borrow time after a share-limited overall timeout. */
  timeoutBoostCallIndex?: number;
}
export interface AgentRun {
  /** Private runtime originals and derived summaries; never project into debug/share views. */
  workingMemory?: WorkingMemory;
  /** r81: plans.length at the planning round whose planner call already got its one stall/idle timeout retry. */
  plannerTimeoutRetryRound?: number;
  executionLimits?: import('./execution-limits.js').ExecutionLimits;
  sourceReadUsage?: { pages: number; chars: number };
  partial?: boolean;
  limitations?: string[];
  schemaVersion: 1; id: string; revision: number; owner: string; tenantId?: string;
  /** Optional cross-run conversation membership, assigned by the repository. */
  threadId?: string; parentRunId?: string; threadSequence?: number;
  goal: string; goalId?: string; domainPlanId?: string;
  /** When present, this Run is the execution receipt for one existing domain task. */
  taskExecution?: { domainPlanId: string; taskId: string; requestHash: string };
  followUpPlanId?: string;
  status: RunStatus; createdAt: string; updatedAt: string;
  /** Manual entry-task rank for local scheduling. 1 starts first. Missing sorts after every ranked Run.
   * The number does not approve, pause, resume, or cancel this Run. */
  schedulingPriority?: number;
  cancellation?: { reason: string; actor: string; at: string; source: 'api' };
  reconciliation?: { workflowStatus: string; previousStatus: RunStatus; actor: string; at: string; reason: string };
  context: { id: string; audience: string[]; sources: Source[]; manifestHash?: string; threadHistory?: ThreadHistory; projectSourceSync?: ProjectSourceSyncReceipt; memoryManifestId?: string; memoryManifestHash?: string; memoryRefs?: string[] };
  privacy: TaskRequest['privacy'];
  skillRuntime?: string;
  builtinSkill?: TaskRequest['builtinSkill'];
  /** PDF bytes stay in existing Run JSON persistence, outside model context. */
  pdfOutputs?: PdfOutput[];
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
  /** Concrete Plugin/Skill/Workflow/Tool versions used by this Run. */
  resourceSnapshot?: ResourceSnapshot;
  toolManifestDigest?: string;
  skillSelection?: { methodId?: string; version?: string; plan: unknown; receiptRef?: string };
  skillOutcome?: { outcome: 'success' | 'failure'; receiptRef?: string; error?: string };
  toolReceipts: Receipt[]; pendingTool?: ExternalToolInvocation; pendingDelegation?: PendingDelegation;
  /** Validated external-Agent progress, keyed by the durable delegation. */
  agentProgress?: Array<{ idempotencyKey: string; progress: AgentProgressEvent }>;
  delegationOutcomes?: Array<{ idempotencyKey: string; status: string; receiptRef: string; contextVersion: string; receipt: DelegationReceipt; result?: unknown; disposition?: 'isolated'; isolatedCost?: { tokens?: number | undefined; money?: number | undefined; currency?: string | undefined } }>;
  plans: Array<PlanDraft & { version: number; hash: string; createdAt: string;
    author?: { type: 'user' | 'model' | 'policy'; actor?: string; provenanceRef?: string };
    /** Number of model calls already reserved when this revision was proposed. */
    modelCallOffset?: number;
  }>;
  planProvenance?: Array<{ id: string; source: 'user'; actor: string; kind: 'feedback' | 'edit' | 'budget'; basePlanVersion: number; planVersion?: number; planHash?: string; feedback?: string; createdAt: string }>;
  /** One durable schema repair per proposed plan, also used after restart. */
  plannerRepair?: { rawOutput: string; validationError: string };
  /** One corrective reviewer retry: redacted zod issues from the rejected review. */
  /** r62: one independent review of output retained after an early stop (timeout/unknown outcome). */
  stopReview?: 'pending' | 'done';
  reviewRepair?: { issues: Array<{ path: string; code: string; message: string }> };
  steps: Step[]; artifacts: Artifact[]; events: Event[];
  corrections?: RunCorrection[];
  /** Frozen at creation. Missing means every plan waits for the owner. */
  executionReview?: 'required' | 'auto' | 'yolo';
  /** Frozen at creation. Missing means the planner proposes the task graph. */
  planning?: 'direct' | 'dag';
  approval?: { planHash: string; planVersion?: number; approved: boolean; actor?: string; at?: string; mode?: 'required' | 'auto' | 'yolo'; reason?: string; grant?: 'once' };
  /** Frozen at creation and widened only by this Run's own action decisions. */
  actionPolicy?: ActionPolicy;
  /** Frozen at creation. Missing means the owner started the Run. */
  origin?: ActionOrigin;
  /** One external side effect waiting for, or settled by, an owner decision. It is separate from plan approval. */
  actionApproval?: {
    status: 'pending' | 'approved' | 'denied'; kind: 'tool' | 'agent'; ref: string; taskId: string;
    idempotencyKey: string; inputHash: string; reason: string; requestedAt: string;
    decision?: ActionDecision; actor?: string; decidedAt?: string;
  };
  question?: { taskId: string; text: string; kind?: 'missing_source' | 'missing_capability' | 'clarification' | 'external_clarification'; missing?: string[] };
  answers: Array<{ taskId: string; question: string; answer: string }>;
  review?: Review;
  error?: string;
  resumeStatus?: RunStatus;
  resumeModelCallId?: string;
  /** How an interrupted model call should be handled after provider reconciliation. */
  reconcileDisposition?: 'running' | 'paused' | 'cancelled';
  reconciledModelCall?: ReconciledModelCall;
}

/** Decode model transport formatting without changing executable semantics. */
export function normalizeModelJson(value: unknown, wrapper?: string, discriminator?: string): unknown {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (typeof value === 'string') {
      const text = value.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1');
      try { value = JSON.parse(text); continue; } catch { return value; }
    }
    if (wrapper && value && typeof value === 'object' && !Array.isArray(value)
      && (!discriminator || !(discriminator in value)) && wrapper in value) {
      value = (value as Record<string, unknown>)[wrapper]; continue;
    }
    return value;
  }
  return value;
}

export function validatePlan(value: unknown): PlanDraft {
  const plan = planSchema.parse(normalizePlanOutput(value));
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

/** Extract transport formatting only; the schema and DAG checks still apply. */
export function normalizePlanOutput(value: unknown): unknown {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (typeof value === 'string') {
      const text = value.trim().replace(/^\s*```(?:json)?\s*$/gim, '').trim();
      try { value = JSON.parse(text); continue; } catch { /* prose or markdown around JSON */ }
      const object = firstBalancedObject(text);
      if (!object) return value;
      try { value = JSON.parse(object); continue; } catch { return value; }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const candidate = value as Record<string, unknown>;
    const keys = Object.keys(candidate);
    // Preserve the previously supported plan envelope with extra metadata.
    if (!('nodes' in candidate) && 'plan' in candidate) { value = candidate.plan; continue; }
    if (!('summary' in candidate) && !('nodes' in candidate) && keys.length === 1
      && ['plan', 'result', 'output', 'data', 'response'].includes(keys[0]!)) {
      value = candidate[keys[0]!]; continue;
    }
    if (!Array.isArray(candidate.nodes)) return value;
    return { ...candidate, nodes: candidate.nodes.map(node => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
      const item = node as Record<string, unknown>;
      if (item.instruction !== undefined && item.instruction !== null
        && (typeof item.instruction !== 'string' || item.instruction.trim())) return node;
      const instruction = [item.description, item.goal, item.title, item.name]
        .find(field => typeof field === 'string' && field.trim());
      return instruction === undefined ? node : { ...item, instruction };
    }) };
  }
  return value;
}

function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}
