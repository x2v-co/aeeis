import type { AgentRun } from './contracts.js';

export interface GraphNode { id: string; type: string; label: string; status?: string; metadata?: Record<string, unknown> }
export interface GraphEdge { from: string; to: string; type: string }
export interface PlanGraph { kind: 'plan'; runId: string; version: number; hash: string; nodes: GraphNode[]; edges: GraphEdge[] }
export interface ExecutionGraph { kind: 'execution'; runId: string; nodes: GraphNode[]; edges: GraphEdge[] }
export interface EvidenceGraph { kind: 'evidence'; runId: string; nodes: GraphNode[]; edges: GraphEdge[] }
export interface RunGraphs { plan: PlanGraph | undefined; planHistory: PlanGraph[]; execution: ExecutionGraph; evidence: EvidenceGraph }

/** Stable projections for the UI, audit tools, and external task projections. */
export function projectRunGraphs(run: AgentRun): RunGraphs {
  const toPlanGraph = (plan: AgentRun['plans'][number]): PlanGraph => ({
    kind: 'plan' as const, runId: run.id, version: plan.version, hash: plan.hash,
    nodes: plan.nodes.map(node => ({ id: node.id, type: 'task', label: node.title, status: run.steps.find(step => step.taskId === node.id)?.status ?? 'pending' })),
    edges: plan.nodes.flatMap(node => node.dependsOn.map(dependency => ({ from: dependency, to: node.id, type: 'depends_on' }))),
  });
  const planHistory = run.plans.map(toPlanGraph);
  const planGraph = planHistory.at(-1);

  const executionNodes: GraphNode[] = run.steps.map(step => ({ id: `step:${step.taskId}`, type: 'step', label: step.taskId, status: step.status, metadata: { attempts: step.attempts } }));
  const executionEdges: GraphEdge[] = [];
  for (const call of run.calls) {
    const nodeId = `call:${call.id}`;
    executionNodes.push({ id: nodeId, type: 'model_call', label: call.phase, status: call.state, metadata: { taskId: call.taskId ?? null, startedAt: call.startedAt, endedAt: call.endedAt ?? null, idempotencyKey: call.idempotencyKey ?? null } });
    if (call.taskId) executionEdges.push({ from: nodeId, to: `step:${call.taskId}`, type: 'attempt_for' });
  }
  for (const event of run.events) {
    if (event.type === 'tool.requested' || event.type === 'tool.completed' || event.type === 'tool.unknown' || event.type === 'tool.reconciled') {
      const taskId = typeof event.data.taskId === 'string' ? event.data.taskId : undefined;
      const receiptId = typeof event.data.receiptId === 'string' ? event.data.receiptId : undefined;
      if (taskId && receiptId && !executionNodes.some(node => node.id === `receipt:${receiptId}`)) {
        executionNodes.push({ id: `receipt:${receiptId}`, type: 'receipt', label: String(event.data.tool ?? 'tool'), status: String(event.data.outcome ?? event.type) });
        executionEdges.push({ from: `receipt:${receiptId}`, to: `step:${taskId}`, type: 'external_effect' });
      }
    }
  }

  const evidenceNodes: GraphNode[] = [];
  const evidenceEdges: GraphEdge[] = [];
  for (const source of run.context.sources) evidenceNodes.push({ id: source.id, type: 'source', label: source.title, metadata: { source: source.source, hash: source.hash } });
  for (const receipt of run.toolReceipts ?? []) evidenceNodes.push({ id: receipt.receiptId, type: 'tool_receipt', label: receipt.operation, status: receipt.status, metadata: { provider: receipt.provider, responseHash: receipt.responseHash ?? null } });
  for (const outcome of run.delegationOutcomes ?? []) evidenceNodes.push({ id: outcome.receiptRef, type: 'delegation_receipt', label: `agent:${outcome.receipt.agentId}`, status: outcome.status, metadata: { contextVersion: outcome.contextVersion } });
  for (const call of run.calls) evidenceNodes.push({ id: call.id, type: 'model_receipt', label: `model:${call.phase}`, status: call.state, metadata: { inputHash: call.inputHash, outputHash: call.outputHash ?? null } });
  for (const artifact of run.artifacts) {
    evidenceNodes.push({ id: artifact.id, type: 'artifact', label: artifact.title, status: 'created', metadata: { taskId: artifact.taskId, hash: artifact.hash } });
    for (const ref of artifact.evidenceRefs) if (evidenceNodes.some(node => node.id === ref)) evidenceEdges.push({ from: ref, to: artifact.id, type: 'supports' });
    const event = run.events.find(item => item.type === 'artifact.created' && item.data.artifactId === artifact.id);
    const modelCallId = event && typeof event.data.modelCallId === 'string' ? event.data.modelCallId : undefined;
    if (modelCallId && evidenceNodes.some(node => node.id === modelCallId)) evidenceEdges.push({ from: modelCallId, to: artifact.id, type: 'generated' });
  }
  return { plan: planGraph, planHistory, execution: { kind: 'execution', runId: run.id, nodes: executionNodes, edges: executionEdges }, evidence: { kind: 'evidence', runId: run.id, nodes: evidenceNodes, edges: evidenceEdges } };
}
