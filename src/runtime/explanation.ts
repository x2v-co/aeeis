import type { AgentRun, RunStatus } from './contracts.js';
import { projectRunGraphs } from './graphs.js';

/**
 * A compact, read-only explanation of a Run.  The Run aggregate remains the
 * source of truth; this projection only gathers facts that a person needs to
 * decide what happens next.  In particular, it never includes source or
 * artifact contents, model prompts, or provider credentials.
 */
export interface RunExplanation {
  schemaVersion: 'run-explanation/1';
  run: {
    id: string;
    goal: string;
    status: RunStatus;
    privacy: AgentRun['privacy'];
    owner: string;
    tenantId?: string;
    createdAt: string;
    updatedAt: string;
  };
  attention: {
    kind: 'none' | 'approve_plan' | 'provide_input' | 'reconcile_external' | 'resume' | 'review' | 'inspect_failure';
    nextAction: string;
    blockers: Array<{ kind: string; detail: string; refs: string[] }>;
  };
  plan: {
    version?: number;
    hash?: string;
    summary?: string;
    tasks: { total: number; pending: number; running: number; succeeded: number };
    readyTaskIds: string[];
    pendingTaskIds: string[];
  };
  execution: {
    eventCount: number;
    modelCalls: { total: number; started: number; completed: number; failed: number; unknown: number; discarded: number };
    tools: { total: number; completed: number; failed: number; unknown: number };
    delegations: { total: number; completed: number; failed: number; unknown: number };
  };
  evidence: {
    sourceCount: number;
    artifactCount: number;
    receiptCount: number;
    evidenceNodeCount: number;
    contextManifestId?: string;
    contextManifestHash?: string;
    memoryRefs: string[];
  };
  governance: {
    model?: { model: string; provider?: string; catalogHash?: string; catalogRetrievedAt?: string };
    skill?: { methodId?: string; version?: string; outcome?: 'success' | 'failure'; receiptRef?: string };
    tools: Array<{ id: string; version: string; capabilities: string[] }>;
    agents: string[];
  };
  budget: {
    model?: { limitTokens?: number; usedTokens: number; limitMoneyUsd?: number; usedMoneyUsd?: number; unreportedCalls: number };
    external?: { limitCalls?: number; usedCalls: number; limitTokens?: number; usedTokens: number; limitMoneyUsd?: number; usedMoneyUsd?: number; unreportedCalls: number; unreportedTokenCalls: number; unreportedMoneyCalls: number };
  };
  review?: { verdict: string; confidence?: number; issueCount: number; summary: string };
}

type Counter = { total: number; completed: number; failed: number; unknown: number };
function emptyCounter(): Counter { return { total: 0, completed: 0, failed: 0, unknown: 0 }; }
function countState(counter: Counter, state: string): void {
  counter.total += 1;
  if (state === 'completed' || state === 'succeeded' || state === 'accepted') counter.completed += 1;
  else if (state === 'failed' || state === 'rejected') counter.failed += 1;
  else if (state === 'unknown') counter.unknown += 1;
}

function attentionFor(run: AgentRun): RunExplanation['attention'] {
  if (run.status === 'needs_approval') return { kind: 'approve_plan', nextAction: '核对并批准当前计划的精确 hash 后继续执行。', blockers: [{ kind: 'approval', detail: run.approval ? `等待批准计划 ${run.approval.planHash}` : '当前计划尚未批准', refs: run.approval?.planHash ? [run.approval.planHash] : [] }] };
  if (run.status === 'needs_input') return { kind: 'provide_input', nextAction: '回答 Agent 的问题，提供继续执行所需的信息。', blockers: [{ kind: 'input', detail: run.question?.text ?? '等待用户输入', refs: run.question?.taskId ? [run.question.taskId] : [] }] };
  if (run.status === 'waiting_external' || run.status === 'unknown') return { kind: 'reconcile_external', nextAction: '核查外部 Tool、Agent 或模型的最终结果；不明结果不会被盲目重试。', blockers: [{ kind: run.status, detail: run.pendingTool ? `等待 Tool ${run.pendingTool.toolId} 的核查` : run.pendingDelegation?.failure ? `Agent 返回被拒绝（${run.pendingDelegation.failure.kind}）：${run.pendingDelegation.failure.message}` : run.pendingDelegation ? `等待 Agent ${run.pendingDelegation.agentId} 的核查` : '存在需要显式核查的外部结果', refs: [ ...(run.pendingTool?.receiptId ? [run.pendingTool.receiptId] : []), ...(run.pendingDelegation?.receiptRef ? [run.pendingDelegation.receiptRef] : []) ] }] };
  if (run.status === 'paused') return { kind: 'resume', nextAction: '确认边界后恢复运行，或取消本次 Run。', blockers: [{ kind: 'paused', detail: 'Run 已暂停，外部结果不会自动唤醒它。', refs: [] }] };
  if (run.status === 'reviewing') return { kind: 'review', nextAction: '等待独立审核完成，或检查审核输入和证据。', blockers: [{ kind: 'review', detail: '产物已生成，正在等待独立 Reviewer。', refs: [] }] };
  if (run.status === 'failed') return { kind: 'inspect_failure', nextAction: '检查失败原因和证据，再决定重试、纠正或重新规划。', blockers: [{ kind: 'failure', detail: run.error ?? 'Run 执行失败', refs: [] }] };
  return { kind: 'none', nextAction: run.status === 'succeeded' ? '查看交付并决定是否创建后续计划。' : '继续观察执行时间线。', blockers: [] };
}

export function explainRun(run: AgentRun): RunExplanation {
  const plan = run.plans.at(-1);
  const statuses = new Map(run.steps.map(step => [step.taskId, step.status]));
  const readyTaskIds = plan?.nodes.filter(node => (statuses.get(node.id) ?? 'pending') === 'pending' && node.dependsOn.every(dep => statuses.get(dep) === 'succeeded')).map(node => node.id) ?? [];
  const pendingTaskIds = plan?.nodes.filter(node => (statuses.get(node.id) ?? 'pending') === 'pending').map(node => node.id) ?? [];
  const modelCalls = { total: run.calls.length, started: 0, completed: 0, failed: 0, unknown: 0, discarded: 0 };
  for (const call of run.calls) modelCalls[call.state] += 1;
  const tools = emptyCounter(); for (const receipt of run.toolReceipts ?? []) countState(tools, receipt.status);
  const delegations = emptyCounter(); for (const outcome of run.delegationOutcomes ?? []) countState(delegations, outcome.status);
  const modelDecision = run.modelDecision && typeof run.modelDecision === 'object' ? run.modelDecision : undefined;
  const selected = modelDecision && typeof modelDecision.selected === 'object' && modelDecision.selected !== null ? modelDecision.selected as Record<string, unknown> : undefined;
  const planprice = modelDecision && typeof modelDecision.catalogHash === 'string' ? modelDecision : undefined;
  return {
    schemaVersion: 'run-explanation/1',
    run: { id: run.id, goal: run.goal, status: run.status, privacy: run.privacy, owner: run.owner, ...(run.tenantId ? { tenantId: run.tenantId } : {}), createdAt: run.createdAt, updatedAt: run.updatedAt },
    attention: attentionFor(run),
    plan: { ...(plan ? { version: plan.version, hash: plan.hash, summary: plan.summary } : {}), tasks: { total: plan?.nodes.length ?? 0, pending: pendingTaskIds.length, running: run.steps.filter(step => step.status === 'running').length, succeeded: run.steps.filter(step => step.status === 'succeeded').length }, readyTaskIds, pendingTaskIds },
    execution: { eventCount: run.events.length, modelCalls, tools, delegations },
  evidence: { sourceCount: run.context.sources.length, artifactCount: run.artifacts.length, receiptCount: (run.toolReceipts ?? []).filter(receipt => receipt.authorization?.decision !== 'isolated').length + (run.delegationOutcomes ?? []).filter(outcome => outcome.disposition !== 'isolated').length, evidenceNodeCount: projectRunGraphs(run).evidence.nodes.length, ...(run.context.memoryManifestId ? { contextManifestId: run.context.memoryManifestId } : {}), ...(run.context.memoryManifestHash ? { contextManifestHash: run.context.memoryManifestHash } : {}), memoryRefs: [...(run.context.memoryRefs ?? [])] },
    governance: { ...(selected && typeof selected.model === 'string' ? { model: { model: selected.model, ...(typeof selected.provider === 'string' ? { provider: selected.provider } : {}), ...(planprice && typeof planprice.catalogHash === 'string' ? { catalogHash: planprice.catalogHash } : {}), ...(planprice && typeof planprice.catalogRetrievedAt === 'string' ? { catalogRetrievedAt: planprice.catalogRetrievedAt } : {}) } } : { model: { model: run.model.model, ...(run.model.provider ? { provider: run.model.provider } : {}) } }), ...(run.skillSelection ? { skill: { ...(run.skillSelection.methodId ? { methodId: run.skillSelection.methodId } : {}), ...(run.skillSelection.version ? { version: run.skillSelection.version } : {}), ...(run.skillOutcome?.outcome ? { outcome: run.skillOutcome.outcome } : {}), ...(run.skillSelection.receiptRef ? { receiptRef: run.skillSelection.receiptRef } : {}) } } : {}), tools: (run.approvedTools ?? []).map(tool => ({ id: tool.id, version: tool.version, capabilities: [...tool.capabilities] })), agents: (run.approvedAgents ?? []).map(agent => agent.agentId) },
    budget: { ...(run.modelBudget || run.modelUsage ? { model: { ...(run.modelBudget?.tokens === undefined ? {} : { limitTokens: run.modelBudget.tokens }), usedTokens: run.modelUsage?.tokens ?? 0, ...(run.modelBudget?.moneyUsd === undefined ? {} : { limitMoneyUsd: run.modelBudget.moneyUsd }), ...(run.modelUsage?.moneyUsd === undefined ? {} : { usedMoneyUsd: run.modelUsage.moneyUsd }), unreportedCalls: run.modelUsage?.unreportedCalls ?? 0 } } : {}), ...(run.externalBudget || run.externalUsage ? { external: { ...(run.externalBudget?.calls === undefined ? {} : { limitCalls: run.externalBudget.calls }), usedCalls: run.externalUsage?.calls ?? 0, ...(run.externalBudget?.tokens === undefined ? {} : { limitTokens: run.externalBudget.tokens }), usedTokens: run.externalUsage?.tokens ?? 0, ...(run.externalBudget?.moneyUsd === undefined ? {} : { limitMoneyUsd: run.externalBudget.moneyUsd }), ...(run.externalUsage?.moneyUsd === undefined ? {} : { usedMoneyUsd: run.externalUsage.moneyUsd }), unreportedCalls: run.externalUsage?.unreportedCalls ?? 0, unreportedTokenCalls: run.externalUsage?.unreportedTokenCalls ?? 0, unreportedMoneyCalls: run.externalUsage?.unreportedMoneyCalls ?? 0 } } : {}) },
    ...(run.review ? { review: { verdict: run.review.verdict, ...(run.review.confidence === undefined ? {} : { confidence: run.review.confidence }), issueCount: run.review.issues.length, summary: run.review.summary } } : {}),
  };
}
