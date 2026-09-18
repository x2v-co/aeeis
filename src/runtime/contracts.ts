import { z } from 'zod';

export const materialSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(30000),
  source: z.string().trim().min(1).max(1000),
}).strict();
export const requestSchema = z.object({
  goal: z.string().trim().min(1).max(8000),
  materials: z.array(materialSchema).max(20).default([]),
  maxModelCalls: z.number().int().min(3).max(100).default(20),
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
export type RunStatus = 'queued' | 'planning' | 'needs_approval' | 'running' | 'needs_input' | 'paused' | 'reviewing' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface Source { id: string; title: string; content: string; source: string; hash: string }
export interface Artifact { id: string; taskId: string; title: string; content: string; evidenceRefs: string[]; hash: string; createdAt: string }
export interface ModelPin { model: string; endpoint: string; promptVersion: string }
export interface ModelCall {
  id: string; phase: 'planner' | 'executor' | 'reviewer'; taskId?: string;
  state: 'started' | 'completed' | 'failed' | 'unknown' | 'discarded';
  inputHash: string; outputHash?: string; startedAt: string; endedAt?: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface Event { id: string; seq: number; type: string; at: string; data: Record<string, unknown> }
export interface Step {
  taskId: string; status: 'pending' | 'running' | 'succeeded';
  attempts: number; observations: Array<{ tool: string; argument: string; result: unknown }>;
}
export interface AgentRun {
  schemaVersion: 1; id: string; revision: number; owner: string;
  goal: string; status: RunStatus; createdAt: string; updatedAt: string;
  context: { id: string; audience: string[]; sources: Source[] };
  model: ModelPin; maxModelCalls: number; calls: ModelCall[];
  plans: Array<PlanDraft & { version: number; hash: string; createdAt: string }>;
  steps: Step[]; artifacts: Artifact[]; events: Event[];
  approval?: { planHash: string; approved: boolean; actor?: string; at?: string };
  question?: { taskId: string; text: string };
  answers: Array<{ taskId: string; question: string; answer: string }>;
  review?: Review;
  error?: string;
  resumeStatus?: RunStatus;
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
