import { z } from 'zod';
import type { Receipt, ToolInvocation } from '../integrations.js';
import type { DelegationReceipt, DelegationRequest } from '../agent-gateway.js';
import type { ActiveEvolution } from '../evolution-activation.js';

export const materialSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(30000),
  source: z.string().trim().min(1).max(1000),
}).strict();
export const requestSchema = z.object({
  goal: z.string().trim().min(1).max(8000),
  goalId: z.string().trim().min(1).max(200).optional(),
  materials: z.array(materialSchema).max(20).default([]),
  maxModelCalls: z.number().int().min(3).max(100).default(20),
  allowedTools: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  allowedAgents: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  knowledgeQuery: z.string().trim().min(1).max(2000).optional(),
  knowledgeMaxItems: z.number().int().min(1).max(20).default(8),
  brainScope: z.string().trim().min(1).max(200).optional(),
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
  z.object({ type: z.literal('delegate'), agentId: z.string().trim().min(1).max(200), goal: z.string().trim().min(1).max(4000), expectedOutput: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal('question'), question: z.string().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('finish'), title: z.string().min(1).max(200), content: z.string().min(1).max(30000), evidenceRefs: z.array(z.string()).max(100) }).strict(),
]);
export const reviewSchema = z.object({
  verdict: z.enum(['accepted', 'needs_revision']),
  summary: z.string().min(1).max(4000),
  issues: z.array(z.string().min(1).max(2000)).max(20),
}).strict();
export type TaskRequest = z.infer<typeof requestSchema>;
export type PlanDraft = z.infer<typeof planSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type ExternalToolInvocation = ToolInvocation & { requestedAt: string; receiptId?: string };
export type PendingDelegation = DelegationRequest & { reconcileRequested?: boolean; receiptRef?: string };
export type RunStatus = 'queued' | 'planning' | 'needs_approval' | 'running' | 'needs_input' | 'waiting_external' | 'paused' | 'reviewing' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface Source { id: string; title: string; content: string; source: string; hash: string }
export interface Artifact { id: string; taskId: string; title: string; content: string; evidenceRefs: string[]; hash: string; createdAt: string }
export interface ModelPin { model: string; endpoint: string; promptVersion: string; provider?: string }
export interface ModelCall {
  id: string; phase: 'planner' | 'executor' | 'reviewer'; taskId?: string;
  /** Provider idempotency key. Unknown calls reuse this key after reconcile. */
  idempotencyKey?: string;
  state: 'started' | 'completed' | 'failed' | 'unknown' | 'discarded';
  inputHash: string; outputHash?: string; startedAt: string; endedAt?: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface Event { id: string; seq: number; type: string; at: string; data: Record<string, unknown> }
export interface RunCorrection { id: string; text: string; candidateId?: string; sourceRefs: string[]; createdAt: string }
export interface Step {
  taskId: string; status: 'pending' | 'running' | 'succeeded';
  attempts: number; observations: Array<{ tool: string; argument: string; result: unknown }>;
}
export interface AgentRun {
  schemaVersion: 1; id: string; revision: number; owner: string; tenantId?: string;
  goal: string; goalId?: string; domainPlanId?: string; status: RunStatus; createdAt: string; updatedAt: string;
  context: { id: string; audience: string[]; sources: Source[] };
  privacy: TaskRequest['privacy'];
  skillRuntime?: string;
  model: ModelPin; modelDecision?: Record<string, unknown>; maxModelCalls: number; calls: ModelCall[];
  evolution?: ActiveEvolution[];
  allowedTools: string[];
  allowedAgents: string[];
  knowledgeQuery?: string;
  knowledgeMaxItems: number;
  brainScope?: string;
  approvedTools?: Array<{ id: string; version: string; capabilities: string[] }>;
  toolManifestDigest?: string;
  skillSelection?: { methodId?: string; version?: string; plan: unknown; receiptRef?: string };
  skillOutcome?: { outcome: 'success' | 'failure'; receiptRef?: string; error?: string };
  toolReceipts: Receipt[]; pendingTool?: ExternalToolInvocation; pendingDelegation?: PendingDelegation;
  delegationOutcomes?: Array<{ idempotencyKey: string; status: string; receiptRef: string; contextVersion: string; receipt: DelegationReceipt; result?: unknown }>;
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
