import type { PlanComparison } from '../runtime/graphs.js';

interface RunSummary { id: string; goal: string; goalId?: string; domainPlanId?: string; followUpPlanId?: string; taskExecution?: { domainPlanId: string; taskId: string }; status: string; updatedAt?: string }
interface RoomSummary { id: string; title: string; description?: string; status: string; createdAt: string; updatedAt: string }
interface RoomMemberSummary { id: string; roomId: string; principalId: string; role: 'editor' | 'viewer' | 'agent' | 'owner'; status: 'active' | 'revoked'; invitedBy: string; createdAt: string; updatedAt: string }
interface SessionEventSummary {
  schemaVersion: 'session-event/1'; id: string; roomId: string; goalId?: string; owner: string; tenantId: string;
  sequence: number; type: 'message' | 'canonical_response' | 'decision' | 'task_update' | 'system';
  actorId: string; actorType: 'principal' | 'agent' | 'system'; operation?: 'publish' | 'revise' | 'retract'; targetEventId?: string; revision?: number; retractionReason?: string; classification?: 'public' | 'internal' | 'confidential' | 'private'; contextManifestId: string; contextManifestHash: string;
  audienceSnapshot: { digest: string; members: Array<{ principalId: string; role: string; status: string }> };
  content: string; contentHash: string; evidenceRefs: string[]; idempotencyKey: string; createdAt: string;
}
interface SessionEventPage { items: SessionEventSummary[]; nextCursor?: string }
interface GoalSummary { id: string; title: string; status: string; createdAt: string; roomId?: string }
interface MemoryView { id: string; goalId?: string; kind: string; scope: string; classification?: string; content: string; source: string; confidence: number; version?: number; state?: string; evidenceRefs?: string[]; evidenceRunId?: string; supersedesId?: string; retractionReason?: string; updatedAt: string }
interface DomainPlanSummary { id: string; version: number; nodes: Array<{ id: string; title: string; instruction?: string; status: string; dependsOn: string[]; evidenceRefs?: string[]; evidenceRunId?: string }> }
interface TaskDispatchSummary { id: string; planId: string; taskId: string; runId: string; workflowId: string; runner: string; state: string; dispatchAttempts: number; updatedAt: string; lastRunStatus?: string; lastError?: string }
interface EvolutionSummary { id: string; target: string; proposedVersion: string; risk: string; status: string; proposalSignalId?: string; evaluations: Array<{ kind: string; passed: boolean }>; shadowObservations?: Array<{ id: string; passed: boolean; score: number }>; canaryObservations?: Array<{ id: string; passed: boolean; score: number }>; rolloutAttempts?: Array<{ id: string; phase: string; caseId: string; state: string; error?: string }> }
interface ImprovementSignalSummary { id: string; kind: string; runId: string; eventId: string; owner: string; tenantId: string; sourceRefs: string[]; reason: string; occurredAt: string; proposal?: unknown; candidateId?: string; synthesis?: { id: string; state: string; inputHash: string; idempotencyKey: string; usage?: { tokens?: number }; error?: string; settled?: boolean; hasProposal?: boolean } }
interface EvolutionView extends EvolutionSummary { baseVersion: string; change: string; reason: string; sourceReceiptRefs: string[]; approvalRef?: string; shadowStartedAt?: string; canaryStartedAt?: string; promotedAt?: string; rolledBackAt?: string }
interface EvolutionTrafficView { id: string; candidateId: string; target: string; baseCandidateId?: string; baseVersion: string; version: string; contentHash?: string; percentage: number; status: 'active' | 'paused' | 'stopped'; rolloutRef: string; lastReason?: string; observations?: Array<{ id: string; passed: boolean; score: number; evidenceRefs: string[]; recordedAt: string }>; startedAt: string; updatedAt: string }
interface CollaborationUsageView { calls: number; tokens: number; moneyUsd?: number; unreportedTokenCalls: number; unreportedMoneyCalls: number }
interface CollaborationBudgetView { calls?: number; tokens?: number; moneyUsd?: number }
interface CompetitionSummary { usage?: CollaborationUsageView; id: string; status: string; brief: { goal: string; participantAgentIds: string[]; blindEvaluation: boolean; modelBudget?: CollaborationBudgetView }; candidates: Array<{ agentId: string }>; scores: Array<{ agentId: string; score: number; accepted: boolean }>; attempts?: Array<{ id: string; participantAgentId: string; state: string; error?: string; result?: unknown; usage?: unknown; startedAt: string; endedAt?: string; reconciliationReason?: string }>; evaluatorAttempt?: { id: string; state: string; error?: string; scores?: unknown[]; usage?: unknown; startedAt: string; endedAt?: string; reconciliationReason?: string }; evaluatorAgentId?: string; selectedAgentId?: string; updatedAt: string; failureReason?: string }
interface DebateSummary { usage?: CollaborationUsageView; modelBudget?: CollaborationBudgetView; id: string; status: string; roles?: { moderatorAgentId?: string; adjudicatorAgentId?: string }; attempts?: Array<{ id: string; slot: string; agentId: string; state: string; output?: unknown; error?: string; usage?: unknown; startedAt: string; endedAt?: string; reconciliationReason?: string }>; room: { goal?: string; taskId: string; contextVersion: string; participantAgentIds: string[]; messages: Array<{ messageId: string; round: number; speakerAgentId: string; type: string; content: string; claimRefs: string[] }>; moderation?: Array<{ messageId: string; status: string; violations?: string[] }>; moderatorReviews?: Array<{ messageId: string; status: string }>; adjudication?: { status: string; decision?: string; rationale?: string; evidenceRefs?: string[] } }; updatedAt: string; closeReason?: string }
interface ProjectionSummary { id: string; channel: string; destination: string; aggregateType: string; aggregateId: string; status: string; attempts: number; updatedAt: string; lastError?: string }
interface TriggerPolicySummary { id: string; name: string; enabled: boolean; eventTypes: string[]; action: { type: string; participantAgentIds: string[]; dispatch: string }; cooldownMs: number; updatedAt: string }
interface TriggerDecisionSummary { id: string; policyId: string; eventId: string; state: string; actionType: string; resourceId?: string; dispatchState: string; dispatchError?: string; error?: string; startedAt: string; completedAt?: string }
interface AgentSummary { agentId: string; status: 'discovered' | 'admitted' | 'revoked'; card: { name: string; owner: string; capabilities: string[]; cardVersion: string; endpoint?: string }; discoveredAt: string; admittedAt?: string; revokedAt?: string; reputation: { samples: number; dimensions: Record<string, number> } }
interface AgentAuditEvent { id: string; agentId: string; action: string; actor: string; cardVersion: string; status: string; at: string }
interface GraphNodeView { id: string; type: string; label: string; status?: string; metadata?: Record<string, unknown> }
interface GraphEdgeView { from: string; to: string; type: string }
interface RunGraphsView {
  execution: { nodes: GraphNodeView[]; edges: GraphEdgeView[] };
  evidence: { nodes: GraphNodeView[]; edges: GraphEdgeView[] };
  planHistory?: Array<{ version: number; hash: string; nodes: GraphNodeView[]; edges: GraphEdgeView[] }>;
  planComparisons?: PlanComparison[];
}
interface RunView extends RunSummary {
  evolution?: Array<{ target: string; version: string }>;
  corrections?: Array<{ id: string; text: string; candidateId: string; sourceRefs: string[]; createdAt: string }>;
  revision: number; goalId?: string; domainPlanId?: string; followUpPlanId?: string; taskExecution?: { domainPlanId: string; taskId: string; requestHash?: string };
  privacy?: string; skillRuntime?: string; skillSelection?: { methodId?: string; version?: string; plan: unknown; receiptRef?: string }; skillOutcome?: { outcome: 'success' | 'failure'; receiptRef?: string; error?: string }; approvedTools?: Array<{ id: string; version: string; capabilities: string[]; description?: string }>; toolManifestDigest?: string; modelDecision?: { selected?: { model?: string; provider?: string }; catalogHash?: string; catalogRetrievedAt?: string; reason?: string }; context?: { id?: string; memoryManifestId?: string; memoryManifestHash?: string; memoryRefs?: string[]; sources: Array<{ id: string; title: string; content: string; source: string; hash: string; classification?: string; origin?: { runId: string; ref: string } }> };
  plans: Array<{ hash: string; version: number; summary: string; nodes: Array<{ id: string; title: string; dependsOn: string[]; evidenceRefs?: string[]; evidenceRunId?: string }> }>;
  steps: Array<{ taskId: string; status: string }>;
  artifacts: Array<{ id: string; title: string; content: string; evidenceRefs: string[]; artifactType?: string; structured?: unknown }>;
  events: Array<{ seq: number; type: string; at: string; data?: { validation?: { issues?: Array<{ path?: string; message?: string }> } } }>;
  calls: Array<{ phase: string; state: string; usage?: { inputTokens: number; outputTokens: number } }>;
  modelBudget?: { tokens?: number; moneyUsd?: number }; modelUsage?: { tokens: number; moneyUsd?: number; unreportedCalls: number };
  evolutionTraffic?: Array<{ routeId: string; target: string; candidateId: string; percentage: number; bucket: number; selected: boolean }>;
  externalBudget?: { calls?: number; tokens?: number; moneyUsd?: number };
  externalUsage?: { calls: number; tokens: number; moneyUsd?: number; unreportedTokenCalls: number; unreportedMoneyCalls: number };
  question?: { text: string }; error?: string;
  toolReceipts?: Array<{ receiptId: string; operation: string; provider: string; status: string; errorCode?: string; authorization?: { decision: 'authorized' | 'isolated'; reason: string } }>;
  pendingTool?: { taskId: string; toolId: string; receiptId?: string };
  pendingDelegation?: { agentId: string; taskBrief: { taskId: string }; receiptRef?: string };
  agentProgress?: Array<{ idempotencyKey: string; progress: { agentId: string; taskId: string; sequence: number; status: string; message: string; percent?: number; evidenceRefs: string[]; artifactRefs: string[]; at: string } }>;
  delegationOutcomes?: Array<{ agentId?: string; status: string; receiptRef: string }>;
  review?: { verdict: string; summary: string; issues: string[]; confidence?: number };
  graphs?: RunGraphsView;
}
type ProjectPulseItem = Record<string, unknown> & { evidenceRefs?: unknown };
type ProjectPulseArtifact = {
  schemaVersion: 'project-pulse/1';
  progress: ProjectPulseItem[];
  completedChanges: ProjectPulseItem[];
  blockers: ProjectPulseItem[];
  risks: ProjectPulseItem[];
  decisions: ProjectPulseItem[];
  owners: ProjectPulseItem[];
  deadlines: ProjectPulseItem[];
  nextActions: ProjectPulseItem[];
  unknowns: ProjectPulseItem[];
};
interface RuntimeStatus {
  executionProfile?: 'fixture' | 'unverified'; modelConfigured: boolean; model?: { model: string; endpoint: string } | null; modelRouting: string; runner: string;
  modelHealth?: { ready: boolean; detail?: string; catalog?: { ready: boolean; detail?: string }; provider?: { ready: boolean; detail?: string } }; skillGovernanceHealth?: { ready: boolean; detail?: string };
  rsiEvaluatorHealth?: { ready: boolean; detail?: string } | null;
  dispatcherHealth?: { ready: boolean; detail?: string } | null; knowledgeConfigured: boolean; brainSemanticSearchConfigured: boolean; brainSemanticIndexHealth?: { ready: boolean; detail?: string } | null;
  projectSourcesConfigured: boolean; evolutionConfigured: boolean; rsiEvaluatorConfigured: boolean; rsiProposalSynthesisConfigured: boolean; skillGovernanceConfigured: boolean;
  rsiAutomation?: { enabled: boolean; autoApproveLowRisk?: boolean; autoRollout?: boolean; autoActivate?: boolean; suiteVersion?: string; inFlight?: boolean; lastRunAt?: string; lastResult?: { inspected: number; evaluated: number; approved: number; shadowed: number; canaried: number; promoted: number; activated: number; skipped: number; failed: number } };
  collaborationConfigured: boolean; projectionConfigured: boolean; projectionSinkConfigured: boolean; domainConfigured: boolean;
  projectionSinkHealth?: { ready: boolean; detail?: string } | null;
  taskSchedulerConfigured: boolean; agentGatewayConfigured: boolean; agentRegistryConfigured: boolean; mode: string; principal?: string; tenantId?: string; roles?: string[];
}
interface RunPage { items: RunSummary[]; nextCursor?: string }
interface GoalPage { goals: GoalSummary[]; nextCursor?: string }
interface ReminderSummary { recurrence?: { intervalMs?: number; calendar?: { frequency: string; timeZone: string; time: string; daysOfWeek?: number[]; dayOfMonth?: number }; maxOccurrences?: number }; id: string; title: string; message: string; dueAt: string; delivery: { channel: string; destination: string }; privacy: string; status: string; occurrence: number; updatedAt: string; lastError?: string }
interface ReminderPage { items: ReminderSummary[]; nextCursor?: string }
interface RunExplanation {
  schemaVersion: 'run-explanation/1'; run: { id: string; status: string; privacy: string; updatedAt: string };
  attention: { kind: string; nextAction: string; blockers: Array<{ kind: string; detail: string; refs: string[] }> };
  plan: { version?: number; hash?: string; summary?: string; tasks: { total: number; pending: number; running: number; succeeded: number }; readyTaskIds: string[]; pendingTaskIds: string[] };
  execution: { eventCount: number; modelCalls: { total: number; started: number; completed: number; failed: number; unknown: number; discarded: number }; tools: { total: number; completed: number; failed: number; unknown: number }; delegations: { total: number; completed: number; failed: number; unknown: number } };
  evidence: { sourceCount: number; artifactCount: number; receiptCount: number; evidenceNodeCount: number; contextManifestId?: string; contextManifestHash?: string; memoryRefs: string[] };
  governance: { model?: { model: string; provider?: string; catalogHash?: string }; skill?: { methodId?: string; version?: string; outcome?: string }; tools: Array<{ id: string; version: string; capabilities: string[] }>; agents: string[] };
  budget: { model?: { limitTokens?: number; usedTokens: number; limitMoneyUsd?: number; usedMoneyUsd?: number; unreportedCalls: number }; external?: { limitCalls?: number; usedCalls: number; limitTokens?: number; usedTokens: number; limitMoneyUsd?: number; usedMoneyUsd?: number; unreportedCalls: number; unreportedTokenCalls: number; unreportedMoneyCalls: number } };
  review?: { verdict: string; confidence?: number; issueCount: number; summary: string };
}
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
let currentId = localStorage.getItem('aeeis.run') ?? '';
let selectedCandidateId = localStorage.getItem('aeeis.candidate') ?? '';
let current: RunView | undefined;
type InputPanelMode = 'answer' | 'reconcile' | 'reconcile-cancelled';
let inputPanelMode: InputPanelMode = 'answer';
let cancelArmedRunId = '';
const minimalMode = localStorage.getItem('aeeis.minimal-mode') !== '0';
document.body.classList.toggle('minimal-mode', minimalMode);
let quickRunReady = false;
let intentPresetsOpen = false;
let recentRunsOpen = false;
let attentionInboxOpen = false;
let currentRunOpen = !minimalMode;
let polling = false;
let goalViewSignature = '';
let modelConfigured = false;
let evolutionConfigured = false;
let taskSchedulerConfigured = false;
let eventStreamRunId = '';
let eventStreamAbort: AbortController | undefined;
let eventStreamCursor: string | undefined;
let eventStreamRefreshQueued = false;
let reminderNextCursor: string | undefined;
let reminderItems: ReminderSummary[] = [];
let reminderStatusFilter = '';
let runDockObserver: IntersectionObserver | undefined;
let runFilter = localStorage.getItem('aeeis.run-filter') ?? 'all';
let runSummaries: RunSummary[] = [];
let timelineFilter = localStorage.getItem('aeeis.timeline-filter') ?? 'all';
const ATTENTION_STATUSES = new Set(['needs_approval', 'needs_input', 'waiting_external', 'unknown', 'failed']);
const ACTIVE_STATUSES = new Set(['queued', 'planning', 'running', 'reviewing', 'paused']);
const DONE_STATUSES = new Set(['succeeded', 'cancelled']);
function runStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: '排队中', planning: '规划中', needs_approval: '待批准', running: '执行中', reviewing: '复核中',
    needs_input: '待补充', waiting_external: '待回执', unknown: '待核查', paused: '已暂停', succeeded: '已完成', failed: '失败', cancelled: '已取消',
    pending: '待处理', ready: '可执行', active: '进行中', in_progress: '进行中', completed: '已完成', done: '已完成', started: '执行中', accepted: '已接收',
    collecting: '收集中', held: '已暂停', approved: '已批准', evaluating: '评估中', shadowing: '影子验证中', canarying: '灰度验证中', promoted: '已晋升', rolled_back: '已回滚',
    scheduled: '已排程', firing: '触发中', projected: '已投影', discovered: '已发现', admitted: '已批准', revoked: '已撤销', archived: '已归档', stopped: '已停止',
    superseded: '已被替代', retracted: '已撤回', revoked_pending: '待撤销',
  };
  return labels[status] ?? status;
}
function privacyLabel(value: string | undefined): string {
  return ({ public: '公开', internal: '内部', confidential: '机密', private: '私人' } as Record<string, string>)[value ?? 'internal'] ?? value ?? '内部';
}
function roleLabel(value: string): string {
  return ({ owner: '所有者', editor: '编辑者', viewer: '查看者', agent: 'Agent' } as Record<string, string>)[value] ?? value;
}
function frequencyLabel(value: string): string {
  return ({ daily: '每天', weekly: '每周', monthly: '每月', once: '一次性', interval: '固定间隔' } as Record<string, string>)[value] ?? value;
}
function runtimeLabel(value: string): string {
  return ({ unconfigured: '未配置', local: '本地执行', temporal: 'Temporal 调度', fixture: 'Fixture 演示' } as Record<string, string>)[value] ?? value;
}
function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    'run.created': '已接收', 'run.updated': '状态更新', 'run.planned': '计划生成', 'run.approved': '计划已批准',
    'run.started': '开始执行', 'task.started': '任务开始', 'task.completed': '任务完成', 'run.reviewed': '审核完成',
    'run.completed': '运行完成', 'run.failed': '运行异常', 'run.cancelled': '运行已取消',
    'plan.proposed': '计划已生成', 'plan.approved': '计划已批准', 'plan.revised': '计划已更新',
    'model.selected': '模型已选择', 'model.started': '模型开始调用', 'model.completed': '模型调用完成', 'model.usage.recorded': '模型用量已记录',
    'skill.selected': '工作方式已选择', 'skill.completed': '工作方式已完成',
    'tool.requested': '等待工具回执', 'tool.completed': '工具已返回', 'tool.failed': '工具调用失败', 'tool.unknown': '工具结果待核查', 'tool.reconciled': '工具结果已核查',
    'agent.requested': '已请求外部 Agent', 'agent.progress': '外部 Agent 有进展', 'agent.completed': '外部 Agent 已完成', 'agent.failed': '外部 Agent 调用失败', 'agent.unknown': '外部 Agent 结果待核查',
    'external.usage.recorded': '外部用量已记录', 'external.usage_recorded': '外部用量已记录', 'external.budget_stopped': '外部预算已停止',
    'model.usage_recorded': '模型用量已记录',
    'task.execution.started': '任务开始执行', 'task.execution.completed': '任务执行完成', 'task.execution.failed': '任务执行失败',
  };
  const normalized = type.trim().replace(/\s+/g, '.');
  return labels[type] ?? labels[normalized] ?? normalized.replace(/^run\./, '').replace(/[._-]+/g, ' ');
}

// Keep the control rail useful at a glance. Advanced modules remain in the DOM
// (and keep their existing IDs/handlers) but can be opened on demand.
function setupAdvancedPanels(): void {
  const storageKey = 'aeeis.advanced-panels';
  let stored: Record<string, boolean> = {};
  try { stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, boolean>; }
  catch { stored = {}; }
  document.querySelectorAll<HTMLElement>('.advanced-panel').forEach((panel, index) => {
    const heading = panel.querySelector('h2');
    if (!heading || panel.querySelector('.panel-toggle')) return;
    const key = panel.id || `panel-${index}-${(heading.textContent ?? '').trim()}`;
    panel.dataset.panelKey = key;
    if (!panel.id) panel.id = `advanced-panel-${index}`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'panel-toggle';
    const expanded = stored[key] === true;
    toggle.textContent = expanded ? '收起' : '展开';
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-controls', panel.id);
    heading.insertAdjacentElement('afterend', toggle);
    panel.classList.toggle('collapsed', !expanded);
    toggle.addEventListener('click', () => {
      const isExpanded = !panel.classList.toggle('collapsed');
      toggle.textContent = isExpanded ? '收起' : '展开';
      toggle.setAttribute('aria-expanded', String(isExpanded));
      stored[key] = isExpanded;
      localStorage.setItem(storageKey, JSON.stringify(stored));
    });
  });
}

setupAdvancedPanels();
function setupMinimalSections(): void {
  const selectors = ['#execution-graph', '#evidence-graph', '#graph', '#sources', '#governance', '#external-effects', '#agent-progress', '#events', '#timeline'];
  for (const selector of selectors) document.querySelector(selector)?.closest('section')?.classList.add('minimal-detail-section');
  const secondarySelectors = ['#explanation-section', '#plan-summary', '#execution-graph', '#evidence-graph', '#sources', '#governance', '#external-effects', '#agent-progress', '#artifacts', '#timeline', '#events'];
  for (const selector of secondarySelectors) document.querySelector(selector)?.closest('section')?.classList.add('run-secondary');
}
setupMinimalSections();
let runDetailsMode = localStorage.getItem('aeeis.run-details-mode') === '1';
function syncRunDetailsToggleLabel(): void {
  const control = $('run-details-toggle') as HTMLButtonElement | null;
  if (!control) return;
  control.textContent = runDetailsMode ? '收起执行详情' : '展开执行详情';
  control.setAttribute('aria-expanded', String(runDetailsMode));
  control.title = runDetailsMode ? '收起证据、图表和事件记录' : '查看证据、图表和事件记录';
}
function setRunDetailsMode(enabled: boolean): void {
  runDetailsMode = enabled;
  document.body.classList.toggle('run-details-mode', enabled);
  syncRunDetailsToggleLabel();
  localStorage.setItem('aeeis.run-details-mode', enabled ? '1' : '0');
}
setRunDetailsMode(runDetailsMode);
($('run-details-toggle') as HTMLButtonElement | null)?.addEventListener('click', () => setRunDetailsMode(!runDetailsMode));
function syncCurrentRunToggle(run?: RunView): void {
  const control = $('current-run-toggle') as HTMLButtonElement | null;
  if (!control) return;
  const hasRun = Boolean(run ?? current ?? currentId);
  control.hidden = !hasRun;
  control.setAttribute('aria-expanded', String(currentRunOpen));
  control.textContent = currentRunOpen
    ? '收起当前运行'
    : `当前运行${run ? ` · ${runStatusLabel(run.status)}` : ''}`;
  control.title = currentRunOpen ? '收起当前运行工作区' : '查看当前运行、交付和下一步';
  control.dataset.state = currentRunOpen ? 'expanded' : 'ready';
}
function setCurrentRunOpen(enabled: boolean): void {
  currentRunOpen = enabled;
  if (!enabled && runDetailsMode) setRunDetailsMode(false);
  const detail = $('detail');
  const empty = $('empty');
  if (detail) detail.hidden = !enabled || !current;
  if (empty) empty.hidden = minimalMode || enabled || Boolean(current);
  syncCurrentRunToggle(current);
  if (!enabled) $('run-dock').hidden = true;
}
setCurrentRunOpen(currentRunOpen);
($('current-run-toggle') as HTMLButtonElement | null)?.addEventListener('click', () => {
  const next = !currentRunOpen;
  setCurrentRunOpen(next);
  if (next) window.requestAnimationFrame(() => $('run-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
});
function setupRunPhaseNavigation(): void {
  const targets: Record<string, string> = {
    goal: '#command-center',
    plan: '#graph',
    execute: '#execution-graph',
    proof: '#evidence-graph',
  };
  document.querySelectorAll<HTMLElement>('#run-phases [data-phase]').forEach(phase => {
    const key = phase.dataset.phase ?? '';
    const selector = targets[key];
    if (!selector) return;
    phase.setAttribute('role', 'button');
    phase.tabIndex = 0;
    phase.setAttribute('aria-controls', selector.slice(1));
    const jump = (): void => {
      if (key !== 'goal') setRunDetailsMode(true);
      const target = document.querySelector<HTMLElement>(selector);
      target?.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    phase.addEventListener('click', jump);
    phase.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(); }
    });
  });
}
setupRunPhaseNavigation();
function setupRunDock(): void {
  const workspace = $('run-workspace');
  const dock = $('run-dock');
  if (!workspace || !dock || !('IntersectionObserver' in window)) return;
  runDockObserver = new IntersectionObserver(([entry]) => {
    dock.hidden = Boolean(entry?.isIntersecting) || $('detail').hidden;
  }, { threshold: 0.08, rootMargin: '-72px 0px 0px' });
  runDockObserver.observe(workspace);
}
setupRunDock();
function updateRunDock(run: RunView): void {
  const dock = $('run-dock');
  if (!dock) return;
  $('run-dock-title').textContent = run.goal;
  $('run-dock-meta').textContent = `${runStatusLabel(run.status)} · ${run.events.length} 条事件 · ${run.artifacts.length} 个产物`;
  dock.dataset.status = run.status;
  if ($('detail').hidden) dock.hidden = true;
}
($('run-dock-jump') as HTMLButtonElement | null)?.addEventListener('click', () => {
  $('run-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
let focusMode = localStorage.getItem('aeeis.focus-mode') === '1';
function setFocusMode(enabled: boolean): void {
  focusMode = enabled;
  document.body.classList.toggle('focus-mode', enabled);
  const control = $('focus-toggle');
  if (control) control.textContent = enabled ? '退出专注模式' : '专注当前运行';
  localStorage.setItem('aeeis.focus-mode', enabled ? '1' : '0');
}
setFocusMode(focusMode);
($('focus-toggle') as HTMLButtonElement | null)?.addEventListener('click', () => setFocusMode(!focusMode));
let detailsMode = !minimalMode && localStorage.getItem('aeeis.details-mode') === '1';
function syncConfigurationNotice(): void {
  const notice = $('configuration');
  if (!notice.dataset.fullText) return;
  notice.textContent = minimalMode && !detailsMode ? (notice.dataset.minimalText ?? notice.dataset.fullText) : notice.dataset.fullText;
  notice.dataset.state = quickRunReady ? 'ready' : 'attention';
}
function syncDetailsToggleLabel(): void {
  const control = $('details-toggle') as HTMLButtonElement | null;
  if (!control) return;
  control.textContent = detailsMode ? '收起设置' : quickRunReady ? '更多设置' : '连接模型';
  control.title = detailsMode ? '收起运行配置' : quickRunReady ? '展开运行边界和治理设置' : '打开令牌和模型配置';
  control.dataset.state = detailsMode ? 'expanded' : quickRunReady ? 'ready' : 'attention';
  control.setAttribute('aria-expanded', String(detailsMode));
}
function setDetailsMode(enabled: boolean): void {
  detailsMode = enabled;
  document.body.classList.toggle('details-mode', enabled);
  if (!enabled && minimalMode) {
    // Returning to the minimal surface must clear every secondary disclosure.
    // Otherwise a previously opened run-details state can keep plan/evidence
    // sections visible after the settings rail has been hidden.
    setRunDetailsMode(false);
    setCurrentRunOpen(false);
    intentPresetsOpen = false;
    recentRunsOpen = false;
    attentionInboxOpen = false;
    const presets = $('intent-presets');
    if (presets) presets.hidden = true;
    const intentToggle = $('intent-toggle') as HTMLButtonElement | null;
    if (intentToggle) {
      intentToggle.textContent = '示例';
      intentToggle.setAttribute('aria-expanded', 'false');
    }
    const recentRuns = $('minimal-recent-runs');
    if (recentRuns) recentRuns.hidden = true;
    const recentToggle = $('recent-runs-toggle') as HTMLButtonElement | null;
    if (recentToggle) recentToggle.setAttribute('aria-expanded', 'false');
    const attentionInbox = $('attention-inbox');
    if (attentionInbox) attentionInbox.hidden = true;
    const attentionToggle = $('attention-toggle') as HTMLButtonElement | null;
    if (attentionToggle) attentionToggle.setAttribute('aria-expanded', 'false');
  }
  syncDetailsToggleLabel();
  localStorage.setItem('aeeis.details-mode', enabled ? '1' : '0');
  syncConfigurationNotice();
}
setDetailsMode(detailsMode);
($('details-toggle') as HTMLButtonElement | null)?.addEventListener('click', () => {
  if (!detailsMode && !quickRunReady) {
    openConfiguration();
    return;
  }
  setDetailsMode(!detailsMode);
  if (detailsMode) {
    setFocusMode(false);
    $('new-run-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
function openConfiguration(): void {
  setDetailsMode(true);
  setFocusMode(false);
  $('access-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.requestAnimationFrame(() => $<HTMLInputElement>('token')?.focus());
}
($('config-action') as HTMLButtonElement | null)?.addEventListener('click', () => {
  openConfiguration();
});
function setIntentPresetsOpen(enabled: boolean): void {
  intentPresetsOpen = enabled;
  const presets = $('intent-presets');
  const control = $('intent-toggle') as HTMLButtonElement | null;
  if (presets) presets.hidden = !enabled;
  if (control) {
    control.textContent = enabled ? '隐藏示例' : '示例';
    control.setAttribute('aria-expanded', String(enabled));
  }
}
setIntentPresetsOpen(false);
($('intent-toggle') as HTMLButtonElement | null)?.addEventListener('click', () => {
  const presets = $('intent-presets');
  setIntentPresetsOpen(Boolean(presets?.hidden));
});
function setRecentRunsOpen(enabled: boolean): void {
  recentRunsOpen = enabled;
  const list = $('minimal-recent-runs');
  const control = $('recent-runs-toggle') as HTMLButtonElement | null;
  if (list) list.hidden = !enabled;
  if (control) {
    control.textContent = enabled ? '隐藏最近运行' : '最近运行';
    control.setAttribute('aria-expanded', String(enabled));
  }
}
setRecentRunsOpen(false);
($('recent-runs-toggle') as HTMLButtonElement | null)?.addEventListener('click', () => {
  const list = $('minimal-recent-runs');
  setRecentRunsOpen(Boolean(list?.hidden));
});
function setAttentionInboxOpen(enabled: boolean): void {
  attentionInboxOpen = enabled;
  const panel = $('attention-inbox');
  const control = $('attention-toggle') as HTMLButtonElement | null;
  if (panel) panel.hidden = !enabled;
  if (control) {
    const count = control.dataset.count ?? '';
    control.textContent = enabled ? '收起待处理' : count ? `待处理 · ${count}` : '待处理';
    control.setAttribute('aria-expanded', String(enabled));
  }
}
setAttentionInboxOpen(false);
($('attention-toggle') as HTMLButtonElement | null)?.addEventListener('click', () => {
  const panel = $('attention-inbox');
  setAttentionInboxOpen(Boolean(panel?.hidden));
  if (attentionInboxOpen) {
    window.requestAnimationFrame(() => $('attention-inbox')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
});
let commandPaletteOpen = false;
let commandPaletteReturnFocus: HTMLElement | null = null;
function setCommandPalette(open: boolean, restoreFocus = true): void {
  if (open) commandPaletteReturnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  commandPaletteOpen = open;
  const palette = $('command-palette');
  if (!palette) return;
  palette.hidden = !open;
  if (open) {
    const search = $<HTMLInputElement>('command-search');
    search.value = '';
    filterCommandPalette('');
    window.requestAnimationFrame(() => search.focus());
  } else if (restoreFocus && commandPaletteReturnFocus) {
    const target = commandPaletteReturnFocus;
    commandPaletteReturnFocus = null;
    window.requestAnimationFrame(() => {
      if (document.contains(target) && !target.hasAttribute('disabled') && target.offsetParent !== null) target.focus();
      else ($<HTMLInputElement>('quick-goal')?.offsetParent !== null ? $<HTMLInputElement>('quick-goal') : $<HTMLButtonElement>('details-toggle'))?.focus();
    });
  } else if (!restoreFocus) {
    commandPaletteReturnFocus = null;
  }
}
function executePaletteCommand(command: string): void {
  // A command owns the next focus target. Do not let the palette's close
  // animation restore the element that opened it after the command runs.
  setCommandPalette(false, false);
  if (command === 'new-run') {
    $('command-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $<HTMLInputElement>('quick-goal').focus();
  } else if (command === 'attention') {
    if (!runSummaries.some(run => ATTENTION_STATUSES.has(run.status))) {
      runFilter = 'attention';
      localStorage.setItem('aeeis.run-filter', runFilter);
      renderRunQueue(runSummaries);
      $('run-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $<HTMLElement>('#runs button')?.focus({ preventScroll: true });
    } else {
      setAttentionInboxOpen(true);
      $('attention-inbox')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $<HTMLElement>('#attention-items .is-selected, #attention-items [role="button"]')?.focus({ preventScroll: true });
    }
  } else if (command === 'current') {
    setCurrentRunOpen(true);
    $('run-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $<HTMLElement>('#run-title')?.focus({ preventScroll: true });
  } else if (command === 'focus') {
    setFocusMode(!focusMode);
  } else if (command === 'details') {
    if (!quickRunReady) openConfiguration();
    else {
      setDetailsMode(true);
      setFocusMode(false);
      $('new-run-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}
function filterCommandPalette(query: string): void {
  const normalized = query.trim().toLocaleLowerCase();
  let visible = 0;
  document.querySelectorAll<HTMLButtonElement>('#command-list [data-command]').forEach(control => {
    const matches = !normalized || (control.textContent ?? '').toLocaleLowerCase().includes(normalized);
    control.hidden = !matches;
    if (matches) visible += 1;
  });
  const empty = $('command-empty');
  if (empty) empty.hidden = visible > 0;
}
function focusCommandItem(direction: 1 | -1): void {
  const items = [...document.querySelectorAll<HTMLButtonElement>('#command-list [data-command]:not([hidden])')];
  if (!items.length) return;
  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex = currentIndex < 0 ? (direction > 0 ? 0 : items.length - 1) : (currentIndex + direction + items.length) % items.length;
  items[nextIndex]?.focus();
}
document.querySelectorAll<HTMLButtonElement>('#command-list [data-command]').forEach(control => {
  control.addEventListener('click', () => executePaletteCommand(control.dataset.command ?? ''));
});
document.querySelector('[data-command-close]')?.addEventListener('click', () => setCommandPalette(false));
($('run-pulse-close') as HTMLButtonElement | null)?.addEventListener('click', () => { $('run-pulse').hidden = true; });
($('run-pulse-jump') as HTMLButtonElement | null)?.addEventListener('click', () => {
  $('run-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('run-pulse').hidden = true;
});
($('command-search') as HTMLInputElement | null)?.addEventListener('input', event => filterCommandPalette((event.target as HTMLInputElement).value));
document.querySelectorAll<HTMLButtonElement>('#run-filters [data-run-filter]').forEach(control => {
  control.addEventListener('click', () => {
    runFilter = control.dataset.runFilter ?? 'all';
    localStorage.setItem('aeeis.run-filter', runFilter);
    renderRunQueue(runSummaries);
  });
});
document.querySelectorAll<HTMLButtonElement>('#timeline-filters [data-timeline-filter]').forEach(control => {
  control.addEventListener('click', () => {
    timelineFilter = control.dataset.timelineFilter ?? 'all';
    localStorage.setItem('aeeis.timeline-filter', timelineFilter);
    renderTimelineFilterState();
    if (current) render(current);
  });
});
renderTimelineFilterState();
document.querySelectorAll<HTMLButtonElement>('.intent-presets [data-intent]').forEach(preset => {
  preset.addEventListener('click', () => {
    const intent = preset.dataset.intent?.trim();
    if (!intent) return;
    const quickGoal = $('quick-goal') as HTMLInputElement | null;
    const goal = $('goal') as HTMLTextAreaElement | null;
    if (quickGoal) quickGoal.value = intent;
    if (goal) goal.value = intent;
    const skill = preset.dataset.skill;
    const skillSelect = $('builtin-skill') as HTMLSelectElement | null;
    if (skill && skillSelect) skillSelect.value = skill;
    setIntentPresetsOpen(false);
    quickGoal?.focus();
  });
});
($('quick-goal') as HTMLInputElement | null)?.addEventListener('input', event => {
  $<HTMLTextAreaElement>('goal').value = (event.target as HTMLInputElement).value;
});
let quickRunStatusTimer: number | undefined;
function setQuickRunBusy(busy: boolean, text = ''): void {
  const form = $('quick-run');
  if (!form) return;
  if (quickRunStatusTimer !== undefined) {
    window.clearInterval(quickRunStatusTimer);
    quickRunStatusTimer = undefined;
  }
  form.dataset.busy = busy ? 'true' : 'false';
  form.setAttribute('aria-busy', String(busy));
  form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(control => {
    control.disabled = busy || (control instanceof HTMLButtonElement && control.type === 'submit' && !quickRunReady);
  });
  const status = $('quick-run-status');
  if (status) {
    status.textContent = text;
    status.dataset.busy = busy ? 'true' : 'false';
    if (busy) {
      const phases = ['正在接收目标…', '正在生成执行入口…', '正在准备 Agent 计划…'];
      let index = Math.max(0, phases.indexOf(text));
      quickRunStatusTimer = window.setInterval(() => {
        index = (index + 1) % phases.length;
        status.textContent = phases[index] ?? phases[0]!;
      }, 1400);
    }
  }
}
($('quick-run') as HTMLFormElement | null)?.addEventListener('submit', event => {
  event.preventDefault();
  const value = $<HTMLInputElement>('quick-goal').value.trim();
  if (!value) { $<HTMLInputElement>('quick-goal').focus(); return; }
  const submit = $('submit') as HTMLButtonElement;
  if (submit.disabled) { message('当前还没有可用的模型配置，请先连接运行服务。'); return; }
  setQuickRunBusy(true, '正在接收目标…');
  $<HTMLTextAreaElement>('goal').value = value;
  setCurrentRunOpen(true);
  submit.click();
  setFocusMode(true);
});
window.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); setCommandPalette(!commandPaletteOpen); return;
  }
  if (event.key === 'Escape' && commandPaletteOpen) {
    event.preventDefault(); setCommandPalette(false); return;
  }
  if (commandPaletteOpen && event.key === 'ArrowDown') {
    event.preventDefault(); focusCommandItem(1); return;
  }
  if (commandPaletteOpen && event.key === 'ArrowUp') {
    event.preventDefault(); focusCommandItem(-1); return;
  }
  if (commandPaletteOpen && event.key === 'Tab') {
    const palette = $('command-palette');
    const focusable = [...palette.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled]):not([hidden])')];
    if (focusable.length) {
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
        : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
      event.preventDefault();
      focusable[nextIndex]?.focus();
    }
    return;
  }
  if (commandPaletteOpen && event.key === 'Enter' && document.activeElement === $('command-search')) {
    const first = document.querySelector<HTMLButtonElement>('#command-list [data-command]:not([hidden])');
    if (first) { event.preventDefault(); first.click(); }
    return;
  }
  if (!commandPaletteOpen && !event.metaKey && !event.ctrlKey && !event.altKey && !event.repeat) {
    const target = event.target as HTMLElement | null;
    const typing = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));
    if (!typing) {
      const key = event.key.toLowerCase();
      if (key === 'n') { event.preventDefault(); executePaletteCommand('new-run'); }
      else if (key === 'r') { event.preventDefault(); executePaletteCommand('current'); }
      else if (key === 'f') { event.preventDefault(); executePaletteCommand('focus'); }
      else if (key === 'd') { event.preventDefault(); executePaletteCommand('details'); }
    }
  }
});
async function api<T>(path: string, body?: unknown, method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'): Promise<T> {
  const token = sessionStorage.getItem('aeeis.token');
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let value: (T & { error?: string }) | undefined;
  if (raw.trim()) {
    try { value = JSON.parse(raw) as T & { error?: string }; }
    catch {
      if (!response.ok) {
        const fallback = raw.replace(/\s+/g, ' ').trim();
        throw new Error(fallback && !fallback.startsWith('<') ? fallback.slice(0, 240) : `运行服务暂时不可用（HTTP ${response.status}）`);
      }
    }
  }
  if (!response.ok) throw new Error(value?.error ?? `运行服务请求失败（HTTP ${response.status}）`);
  return (value ?? {}) as T;
}
function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error || '运行服务暂时不可用');
}
let errorToastTimer: number | undefined;
function message(text: string): void {
  $('error').textContent = text;
  const toast = $('error-toast');
  const toastMessage = $('error-toast-message');
  if (!toast || !toastMessage) return;
  if (errorToastTimer !== undefined) window.clearTimeout(errorToastTimer);
  toastMessage.textContent = text;
  toast.hidden = !text;
  if (text) errorToastTimer = window.setTimeout(() => { toast.hidden = true; }, 8000);
}
($('error-toast-close') as HTMLButtonElement | null)?.addEventListener('click', () => {
  const toast = $('error-toast');
  if (toast) toast.hidden = true;
  if (errorToastTimer !== undefined) window.clearTimeout(errorToastTimer);
});
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
}
function button(label: string, action: () => Promise<void>): HTMLButtonElement {
  const b = element('button', label);
  b.onclick = () => {
    b.disabled = true;
    b.classList.add('is-busy');
    b.setAttribute('aria-busy', 'true');
    void action().catch(error => message(errorMessage(error))).finally(() => {
      b.disabled = false;
      b.classList.remove('is-busy');
      b.removeAttribute('aria-busy');
    });
  };
  return b;
}
function attentionCopy(status: string): [string, string] {
  const copy: Record<string, [string, string]> = {
    needs_approval: ['等待批准', '查看计划、预算和外部调用边界后批准执行'],
    needs_input: ['需要补充信息', '回答当前问题，Agent 会从原节点继续'],
    waiting_external: ['等待外部回执', '核查供应方结果，确认后再恢复运行'],
    unknown: ['结果需要核查', '确认原调用是否完成，再决定是否重试'],
    failed: ['运行失败', '查看错误后重试失败步骤，或重新规划'],
  };
  return copy[status] ?? ['需要关注', '打开运行查看下一步'];
}
async function openAttentionRun(run: RunSummary): Promise<void> {
  currentId = run.id;
  localStorage.setItem('aeeis.run', run.id);
  current = undefined;
  setCurrentRunOpen(true);
  await refresh();
  $('run-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (run.status === 'needs_input' || run.status === 'unknown') {
    openInputPanel(run.status === 'unknown' ? 'reconcile' : 'answer');
  } else if (run.status === 'needs_approval') {
    $('decision-review')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
function openInputPanel(mode: InputPanelMode): void {
  inputPanelMode = mode;
  const panel = $('input-panel');
  const heading = panel.querySelector('h2');
  const submit = panel.querySelector('button');
  if (heading) heading.textContent = mode === 'answer' ? '需要你的信息' : '核查外部结果';
  if (submit) submit.textContent = mode === 'answer' ? '提交并继续' : '提交核查并继续';
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $<HTMLTextAreaElement>('answer').focus();
}
function renderAttentionInbox(runs: RunSummary[]): void {
  const panel = $('attention-inbox');
  const list = $('attention-items');
  const count = $('attention-count');
  if (!panel || !list || !count) return;
  const attention = runs
    .filter(run => ATTENTION_STATUSES.has(run.status))
    .slice(0, 8);
  if (!attention.length) attentionInboxOpen = false;
  const attentionToggle = $('attention-toggle') as HTMLButtonElement | null;
  if (attentionToggle) {
    attentionToggle.hidden = attention.length === 0;
    attentionToggle.dataset.count = String(attention.length);
    attentionToggle.dataset.state = attention.length ? 'attention' : 'idle';
  }
  setAttentionInboxOpen(attentionInboxOpen);
  panel.hidden = attention.length === 0 || !attentionInboxOpen;
  count.textContent = attention.length ? `${attention.length} 项待处理` : '';
  const paletteCount = $('command-attention-count');
  if (paletteCount) paletteCount.textContent = attention.length ? `${attention.length} 项` : '暂无';
  list.replaceChildren();
  for (const run of attention) {
    const [label, next] = attentionCopy(run.status);
    const item = element('div', '', `attention-item ${run.status}${run.id === currentId ? ' is-selected' : ''}`);
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.onclick = () => void openAttentionRun(run).catch(error => message(errorMessage(error)));
    item.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openAttentionRun(run).catch(error => message(errorMessage(error))); }
    };
    item.className = `attention-item ${run.status}${run.id === currentId ? ' is-selected' : ''}`;
    item.setAttribute('aria-label', `${label}：${run.goal}`);
    const marker = element('span', '', 'attention-marker');
    const body = element('span', '', 'attention-body');
    const heading = element('span', '', 'attention-heading');
    heading.append(element('strong', label), element('small', runStatusLabel(run.status)));
    body.append(heading, element('span', run.goal.slice(0, 120), 'attention-goal'), element('small', `下一步 · ${next}`, 'attention-next'));
    const meta = run.updatedAt && Number.isFinite(Date.parse(run.updatedAt))
      ? new Date(run.updatedAt).toLocaleString()
      : '刚刚更新';
    const quickLabel = run.status === 'failed' ? '重试' : run.status === 'needs_input' ? '补充' : run.status === 'needs_approval' ? '查看计划' : '核查';
    const quickAction = button(quickLabel, async () => {
      if (run.status === 'failed') {
        currentId = run.id;
        localStorage.setItem('aeeis.run', run.id);
        current = undefined;
        await api(`/runs/${encodeURIComponent(run.id)}/retry`, {});
        await refresh();
        return;
      }
      await openAttentionRun(run);
    });
    quickAction.className = 'attention-quick-action';
    quickAction.addEventListener('click', event => event.stopPropagation(), { capture: true });
    item.append(marker, body, element('time', meta, 'attention-time'), quickAction, element('span', '↗', 'attention-arrow'));
    list.append(item);
  }
}
function runMatchesFilter(run: RunSummary): boolean {
  if (runFilter === 'active') return ACTIVE_STATUSES.has(run.status);
  if (runFilter === 'attention') return ATTENTION_STATUSES.has(run.status);
  if (runFilter === 'done') return DONE_STATUSES.has(run.status);
  return true;
}
function timelineMatchesFilter(type: string): boolean {
  return timelineFilter === 'all' || timelineTone(type) === timelineFilter;
}
function renderTimelineFilterState(): void {
  document.querySelectorAll<HTMLButtonElement>('#timeline-filters [data-timeline-filter]').forEach(control => {
    const active = control.dataset.timelineFilter === timelineFilter;
    control.classList.toggle('is-active', active);
    control.setAttribute('aria-pressed', String(active));
  });
}
function renderRunQueue(runs: RunSummary[]): void {
  const list = $('runs');
  if (!list) return;
  const visible = runs.filter(runMatchesFilter);
  list.replaceChildren();
  for (const run of visible) {
    const item = button(`${run.goal.slice(0, 60)} · ${runStatusLabel(run.status)}`, async () => {
      currentId = run.id;
      localStorage.setItem('aeeis.run', run.id);
      current = undefined;
      await refresh();
    });
    item.className = run.id === currentId ? 'selected' : '';
    list.append(item);
  }
  const count = $('run-count');
  if (count) count.textContent = `${visible.length} / ${runs.length} 个运行`;
  const empty = $('runs-empty');
  if (empty) {
    empty.hidden = visible.length > 0;
    empty.textContent = runs.length ? '当前筛选没有运行。' : '还没有运行记录。';
  }
  document.querySelectorAll<HTMLButtonElement>('#run-filters [data-run-filter]').forEach(control => {
    const active = control.dataset.runFilter === runFilter;
    control.classList.toggle('is-active', active);
    control.setAttribute('aria-pressed', String(active));
  });
}
function renderMinimalRecentRuns(runs: RunSummary[]): void {
  const container = $('minimal-recent-runs');
  const toggle = $('recent-runs-toggle') as HTMLButtonElement | null;
  if (!container) return;
  const recent = runs.slice(0, 5);
  if (!recent.length) {
    setRecentRunsOpen(false);
    if (toggle) toggle.hidden = true;
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  if (toggle) {
    toggle.hidden = false;
    toggle.textContent = recentRunsOpen ? '隐藏最近运行' : `最近运行 · ${recent.length}`;
  }
  container.hidden = !recentRunsOpen;
  container.replaceChildren();
  container.append(element('span', '最近运行', 'minimal-recent-label'));
  for (const run of recent) {
    const item = button('', async () => {
      if (currentId === run.id && current) {
        setCurrentRunOpen(true);
        $('run-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      setCurrentRunOpen(true);
      currentId = run.id;
      current = undefined;
      localStorage.setItem('aeeis.run', currentId);
      setRecentRunsOpen(false);
      await refresh();
      $('run-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    item.className = `minimal-run-chip${run.id === currentId ? ' is-selected' : ''}`;
    item.dataset.status = run.status;
    item.title = run.goal;
    item.append(element('strong', run.goal.slice(0, 44)), element('small', runStatusLabel(run.status)));
    container.append(item);
  }
}
function setLiveConnection(state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline'): void {
  const live = $('live-connection');
  if (!live) return;
  const labels: Record<typeof state, string> = {
    idle: '等待运行', connecting: '连接中…', connected: '实时同步', reconnecting: '重连中…', offline: '浏览器离线',
  };
  live.dataset.state = state;
  const label = live.querySelector('span');
  if (label) label.textContent = labels[state];
}
function setSystemSignal(state: 'loading' | 'connected' | 'attention' | 'offline'): void {
  const signal = $('system-signal');
  if (!signal) return;
  const labels: Record<typeof state, string> = {
    loading: '正在检查运行服务…',
    connected: '运行服务已连接 · 可以开始任务',
    attention: '运行服务未就绪 · 打开设置查看',
    offline: '无法连接运行服务 · 稍后重试',
  };
  signal.dataset.state = state;
  const label = signal.querySelector('span');
  if (label) label.textContent = labels[state];
}
async function refresh(): Promise<void> {
  const reminderQuery = reminderStatusFilter ? `&status=${encodeURIComponent(reminderStatusFilter)}` : '';
  const [runPage, goals, rooms, candidates, signals, competitions, debates, projections, agents, triggerPolicies, triggerDecisions, reminderPage] = await Promise.all([
    api<RunPage>('/runs/page?limit=50'), api<GoalPage>('/goals/page?limit=50').then(page => page.goals), api<RoomSummary[]>('/rooms?limit=50'), api<EvolutionSummary[]>('/evolution/candidates?limit=50'), api<ImprovementSignalSummary[]>('/evolution/signals?limit=50').catch(() => []),
    api<{ items: CompetitionSummary[] }>('/collaborations/competitions/page?limit=12').then(page => page.items), api<{ items: DebateSummary[] }>('/collaborations/debates/page?limit=12').then(page => page.items), api<ProjectionSummary[]>('/collaborations/projections?limit=12'), api<AgentSummary[]>('/agents?limit=50').catch(() => []),
    api<TriggerPolicySummary[]>('/collaborations/triggers/policies?limit=12').catch(() => []), api<TriggerDecisionSummary[]>('/collaborations/triggers/decisions?limit=20').catch(() => []), api<ReminderPage>(`/reminders/page?limit=20${reminderQuery}`).catch(() => ({ items: [] } as ReminderPage)),
  ]);
  const runs = runPage.items;
  runSummaries = runs;
  reminderItems = reminderPage.items; reminderNextCursor = reminderPage.nextCursor;
  renderAttentionInbox(runs);
  await renderRooms(rooms); await renderGoals(goals, runs, rooms); renderCandidates(candidates); renderImprovementSignals(signals); renderCollaborations(competitions, debates, projections, triggerPolicies, triggerDecisions); renderAgents(agents); renderReminders(reminderItems);
  if (selectedCandidateId) await renderCandidateDetail().catch(error => message(errorMessage(error)));
  renderRunQueue(runs);
  renderMinimalRecentRuns(runs);
  if (!currentId) { stopRunEventStream(); setCurrentRunOpen(false); $('run-dock').hidden = true; return; }
  let run: RunView;
  try { run = await api<RunView>(`/runs/${currentId}`); }
  catch (error) {
    // A local data directory or tenant can change between sessions. Do not
    // leave the workbench stuck on a stale selection when its Run disappeared.
    if (error instanceof Error && /Unknown run|HTTP 404/.test(error.message)) {
      currentId = ''; current = undefined; localStorage.removeItem('aeeis.run'); setCurrentRunOpen(false); $('run-dock').hidden = true; return;
    }
    throw error;
  }
  if (DONE_STATUSES.has(run.status)) stopRunEventStream();
  else ensureRunEventStream(currentId);
  const [graphs, explanation] = await Promise.all([
    api<RunGraphsView>(`/runs/${currentId}/graphs`),
    api<RunExplanation>(`/runs/${currentId}/explanation`),
  ]);
  if (current?.id === run.id && current.revision === run.revision) return;
  current = { ...run, graphs }; render(current); renderExplanation(explanation);
}

function reminderQueryString(cursor?: string): string {
  const params = new URLSearchParams({ limit: '20' });
  if (cursor) params.set('cursor', cursor);
  if (reminderStatusFilter) params.set('status', reminderStatusFilter);
  return `?${params}`;
}
function renderReminders(items: ReminderSummary[]): void {
  const list = $('reminders'); if (!list) return;
  list.replaceChildren(); $('reminders-empty').hidden = items.length > 0;
  for (const reminder of items) {
    const item = element('div', '', `fact-row reminder-${reminder.status}`);
    item.append(element('strong', `${runStatusLabel(reminder.status)} · ${reminder.title}`), element('small', `${new Date(reminder.dueAt).toLocaleString()} · ${reminder.delivery.channel} → ${reminder.delivery.destination} · ${privacyLabel(reminder.privacy)}`), element('small', reminder.message));
    if (reminder.recurrence) {
      const rule = reminder.recurrence.calendar;
      const schedule = rule ? `${frequencyLabel(rule.frequency)} · ${rule.timeZone} ${rule.time}${rule.daysOfWeek ? ` · 星期 ${rule.daysOfWeek.join(',')}` : ''}${rule.dayOfMonth ? ` · 每月 ${rule.dayOfMonth} 日` : ''}` : `每 ${reminder.recurrence.intervalMs! / 60_000} 分钟`;
      item.append(element('small', `${schedule} · 已投影 ${reminder.occurrence}${reminder.recurrence.maxOccurrences ? ` / ${reminder.recurrence.maxOccurrences}` : ''} 次`));
    }
    if (reminder.lastError) item.append(element('small', `错误：${reminder.lastError}`, 'failure'));
    const controls = element('div', '', 'collaboration-actions');
    if (['scheduled', 'failed'].includes(reminder.status)) controls.append(button('取消', async () => { await api(`/reminders/${encodeURIComponent(reminder.id)}/cancel`, {}); await refresh(); }));
    if (['failed', 'cancelled'].includes(reminder.status)) controls.append(button('重试', async () => { await api(`/reminders/${encodeURIComponent(reminder.id)}/retry`, {}); await refresh(); }));
    if (controls.childElementCount) item.append(controls);
    list.append(item);
  }
  const more = $('reminders-more') as HTMLButtonElement;
  if (more) { more.hidden = !reminderNextCursor; more.disabled = false; }
}
async function loadMoreReminders(): Promise<void> {
  if (!reminderNextCursor) return;
  const page = await api<ReminderPage>(`/reminders/page${reminderQueryString(reminderNextCursor)}`);
  reminderItems = [...reminderItems, ...page.items]; reminderNextCursor = page.nextCursor; renderReminders(reminderItems);
}

function queueEventStreamRefresh(): void {
  if (eventStreamRefreshQueued) return;
  eventStreamRefreshQueued = true;
  setTimeout(() => {
    eventStreamRefreshQueued = false;
    if (!document.hidden && currentId) void refresh().catch(error => message(errorMessage(error)));
  }, 0);
}

let runPulseTimer: number | undefined;
function showRunPulse(eventName: string): void {
  if (document.hidden) return;
  const labels: Record<string, string> = {
    'run.updated': '运行状态已更新',
    'run.planned': '执行计划已经生成',
    'run.approved': '计划已批准，准备执行',
    'run.started': 'Agent 已开始执行',
    'run.completed': '运行已完成，证据已保存',
    'run.failed': '运行遇到问题，需要关注',
    'tool.requested': 'Agent 正在等待工具回执',
    'tool.completed': '工具已返回，正在整理证据',
    'tool.failed': '工具调用失败，需要关注',
    'tool.unknown': '工具结果需要核查',
    'tool.reconciled': '工具结果已核查，运行可以继续',
    'agent.progress': '外部 Agent 有新的进展',
    'agent.completed': '外部 Agent 已完成委托',
    'agent.failed': '外部 Agent 调用失败',
    'agent.unknown': '外部 Agent 结果需要核查',
    'external.budget_stopped': '外部预算已触发安全停止',
  };
  const pulse = $('run-pulse');
  const text = $('run-pulse-message');
  if (!pulse || !text) return;
  text.textContent = labels[eventName] ?? eventLabel(eventName);
  pulse.hidden = false;
  if (runPulseTimer !== undefined) window.clearTimeout(runPulseTimer);
  runPulseTimer = window.setTimeout(() => { pulse.hidden = true; }, 5200);
}

function waitForOnline(signal: AbortSignal): Promise<void> {
  if (navigator.onLine) return Promise.resolve();
  return new Promise(resolve => {
    const onOnline = (): void => { cleanup(); resolve(); };
    const onAbort = (): void => { cleanup(); resolve(); };
    const cleanup = (): void => {
      window.removeEventListener('online', onOnline);
      signal.removeEventListener('abort', onAbort);
    };
    window.addEventListener('online', onOnline, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function consumeRunEventStream(runId: string, generation: number): Promise<void> {
  const controller = eventStreamAbort;
  if (!controller) return;
  setLiveConnection('connecting');
  let reconnectDelay = 500;
  let reconnectNoticeShown = false;
  while (!controller.signal.aborted && generation === eventStreamGeneration && currentId === runId) {
    const params = new URLSearchParams({ limit: '100', waitMs: '25000', heartbeatMs: '10000' });
    if (eventStreamCursor) params.set('cursor', eventStreamCursor);
    try {
      const token = sessionStorage.getItem('aeeis.token');
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/events/stream?${params}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('Run event stream has no response body');
      setLiveConnection('connected');
      reconnectDelay = 500;
      reconnectNoticeShown = false;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); boundary = buffer.indexOf('\n\n');
          let id: string | undefined; let name = 'message'; let data = '';
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('id: ')) id = line.slice(4).trim();
            else if (line.startsWith('event: ')) name = line.slice(7).trim();
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (id && /^\d+$/.test(id)) eventStreamCursor = btoa(JSON.stringify({ seq: Number(id) })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
          if (name !== 'heartbeat' && name !== 'timeout') {
            let eventName = name;
            try {
              const payload = data ? JSON.parse(data) as { type?: unknown; eventType?: unknown } : undefined;
              if (typeof payload?.type === 'string') eventName = payload.type;
              else if (typeof payload?.eventType === 'string') eventName = payload.eventType;
            } catch { /* the refresh still handles non-JSON event payloads */ }
            showRunPulse(eventName);
            queueEventStreamRefresh();
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted || generation !== eventStreamGeneration) return;
      if (!navigator.onLine) {
        setLiveConnection('offline');
        await waitForOnline(controller.signal);
        if (controller.signal.aborted || generation !== eventStreamGeneration) return;
        setLiveConnection('connecting');
        continue;
      }
      setLiveConnection('reconnecting');
      if (!reconnectNoticeShown && error instanceof Error && error.name !== 'AbortError') {
        reconnectNoticeShown = true;
        message(`Run 事件流暂时不可用，正在重连：${errorMessage(error)}`);
      }
      await new Promise(resolve => setTimeout(resolve, reconnectDelay));
      reconnectDelay = Math.min(5000, reconnectDelay * 2);
    }
  }
}

let eventStreamGeneration = 0;
function ensureRunEventStream(runId: string): void {
  if (eventStreamRunId === runId && eventStreamAbort && !eventStreamAbort.signal.aborted) return;
  eventStreamGeneration += 1;
  eventStreamAbort?.abort();
  eventStreamRunId = runId;
  eventStreamCursor = undefined;
  eventStreamAbort = new AbortController();
  const generation = eventStreamGeneration;
  void consumeRunEventStream(runId, generation);
}
function stopRunEventStream(): void {
  eventStreamGeneration += 1;
  eventStreamAbort?.abort(); eventStreamAbort = undefined; eventStreamRunId = ''; eventStreamCursor = undefined;
  setLiveConnection('idle');
}
let signalsRendered = '';
function renderImprovementSignals(signals: ImprovementSignalSummary[]): void {
  const list = $('improvement-signals'); if (!list) return;
  const signature = JSON.stringify(signals); if (signalsRendered === signature) return; signalsRendered = signature;
  list.replaceChildren(); $('improvement-signals-empty').hidden = signals.length > 0;
  for (const signal of signals) {
    const item = element('div', '', 'fact-row');
    item.append(element('strong', `${signal.kind} · ${signal.candidateId ? '已形成候选' : signal.proposal ? '待评测' : '待补全提案'}`), element('small', `${signal.reason} · ${new Date(signal.occurredAt).toLocaleString()}`), element('small', `Run ${signal.runId} · 证据 ${signal.sourceRefs.join(', ')}`));
    if (signal.synthesis) {
      const attempt = signal.synthesis;
      const label = attempt.error ? attempt.error : attempt.state === 'completed' ? (attempt.hasProposal ? '已生成提案' : '证据不足，未提出改动') : attempt.state === 'unknown' ? '结果不明，等待核查' : attempt.state === 'started' ? '已预留调用；执行中或中断待核查' : '提案生成失败';
      item.append(element('small', `提案器：${label} · Tokens ${attempt.usage?.tokens ?? '未报告'}`));
      if (['started', 'unknown'].includes(attempt.state)) {
        const details = element('details'); details.append(element('summary', '核查提案调用'));
        details.append(element('p', '填写供应商确认的结果和用量。此操作保存核查结果，不会重新调用模型。'));
        const form = element('form');
        const payload = element('textarea'); payload.rows = 10; payload.required = true;
        payload.value = JSON.stringify({ outcome: 'completed', output: { proposal: null }, usage: { inputTokens: null, outputTokens: null }, reconciliation: { source: 'provider', reference: '', reason: '' } }, null, 2);
        const field = element('label', '供应商核查回执（JSON；请填写真实用量）'); field.append(payload);
        const submit = element('button', '保存核查结果'); submit.type = 'submit';
        const status = element('p'); status.setAttribute('role', 'status'); form.append(field, submit, status);
        form.onsubmit = event => {
          event.preventDefault(); submit.disabled = true;
          void Promise.resolve().then(() => api(`/runs/${signal.runId}/rsi-proposal-synthesis-reconcile`, { ...JSON.parse(payload.value), attemptId: attempt.id, inputHash: attempt.inputHash, idempotencyKey: attempt.idempotencyKey })).then(() => refresh()).catch(error => { status.textContent = errorMessage(error); submit.disabled = false; });
        };
        details.append(form); item.append(details);
      }
    }
    if (signal.candidateId) item.append(button('查看候选', async () => { selectedCandidateId = signal.candidateId!; localStorage.setItem('aeeis.candidate', selectedCandidateId); await renderCandidateDetail(); $('candidate-detail').scrollIntoView({ block: 'center' }); }));
    list.append(item);
  }
}
function renderAgents(agents: AgentSummary[]): void {
  const list = $('agents'); list.replaceChildren(); $('agents-empty').hidden = agents.length > 0;
  for (const agent of agents) {
    const item = element('div', '', `fact-row agent-${agent.status}`);
    const reputation = Object.entries(agent.reputation.dimensions).map(([key, value]) => `${key} ${value.toFixed(2)}`).join(' · ');
    item.append(element('strong', `${runStatusLabel(agent.status)} · ${agent.card.name}`), element('small', `${agent.agentId} · ${agent.card.owner} · v${agent.card.cardVersion}`), element('small', `${agent.card.capabilities.join(', ') || '无声明能力'}${agent.card.endpoint ? ` · ${agent.card.endpoint}` : ''}`), element('small', `信誉样本 ${agent.reputation.samples} 条 · ${reputation}`));
    const controls = element('div');
    if (agent.status === 'discovered') controls.append(button('批准', async () => { await api(`/agents/${encodeURIComponent(agent.agentId)}/admit`, {}); await refresh(); }));
    if (agent.status === 'admitted') controls.append(button('撤销', async () => { await api(`/agents/${encodeURIComponent(agent.agentId)}/revoke`, {}); await refresh(); }));
    controls.append(button('查看审计', async () => {
      const events = await api<AgentAuditEvent[]>(`/agents/${encodeURIComponent(agent.agentId)}/audit`);
      const details = element('details', '', 'inline-inspection');
      details.open = true;
      details.append(element('summary', '审计记录'));
      if (events.length) {
        const list = element('ul');
        for (const event of events) list.append(element('li', `${event.action} · ${event.actor} · ${new Date(event.at).toLocaleString()}`));
        details.append(list);
      } else details.append(element('p', '没有审计事件。', 'muted'));
      item.querySelector(':scope > .inline-inspection')?.remove();
      item.append(details);
    }));
    item.append(controls); list.append(item);
  }
}
function collaborationCostText(usage: CollaborationUsageView | undefined, budget?: CollaborationBudgetView): string {
  if (!usage) return '尚无调用用量汇总';
  const limits = budget ? Object.entries(budget).map(([key, value]) => `${key}=${value}`).join(' / ') : '';
  return `${usage.calls} 次模型调用 · ${usage.tokens} 已报告 tokens${usage.moneyUsd === undefined ? '' : ` · 估算 USD $${usage.moneyUsd.toFixed(6)}`}${usage.unreportedTokenCalls ? ` · ${usage.unreportedTokenCalls} 次 token 未确认` : ''}${usage.unreportedMoneyCalls ? ` · ${usage.unreportedMoneyCalls} 次 USD 未确认` : ''}${limits ? ` · 阈值 ${limits}` : ''}`;
}
function renderRuntimeStatus(status: RuntimeStatus): void {
  const modelHealthDetail = status.modelHealth
    ? [status.modelHealth.detail, status.modelHealth.catalog ? `目录：${status.modelHealth.catalog.detail ?? (status.modelHealth.catalog.ready ? '可用' : '不可用')}` : '', status.modelHealth.provider ? `供应商：${status.modelHealth.provider.detail ?? (status.modelHealth.provider.ready ? '可用' : '不可用')}` : ''].filter(Boolean).join(' · ')
    : '';
  const items: Array<[string, boolean, string]> = [
    ['模型', Boolean(status.modelConfigured && status.modelHealth?.ready), status.model ? `${status.model.model}${modelHealthDetail ? ` · ${modelHealthDetail}` : ''}` : (status.modelRouting === 'catalog' ? `目录路由${modelHealthDetail ? ` · ${modelHealthDetail}` : ''}` : '未配置')],
    ['执行器', Boolean(status.dispatcherHealth?.ready), `${runtimeLabel(status.runner)}${status.dispatcherHealth?.detail ? ` · ${status.dispatcherHealth.detail}` : ''}`],
    ['Goal / Plan / Task', status.domainConfigured, status.domainConfigured ? '已启用' : '未启用'],
    ['DAG 调度', status.taskSchedulerConfigured, status.taskSchedulerConfigured ? '已启用' : '未启用'],
    ['Brain 语义检索', Boolean(status.brainSemanticSearchConfigured && status.brainSemanticIndexHealth?.ready), status.brainSemanticSearchConfigured ? (status.brainSemanticIndexHealth?.detail ?? 'pgvector / embedding，健康状态未验证') : '词法或未配置'],
    ['Knowledge', status.knowledgeConfigured, status.knowledgeConfigured ? '已启用' : '未启用'],
    ['项目源', status.projectSourcesConfigured, status.projectSourcesConfigured ? '已启用' : '未启用'],
    ['外部 Agent', status.agentGatewayConfigured, status.agentRegistryConfigured ? 'Gateway + Registry' : 'Gateway'],
    ['RSI 状态', status.evolutionConfigured, status.rsiAutomation?.enabled ? `内测自动进化${status.rsiAutomation.autoActivate ? ' · 自动激活' : ' · 等待激活'} · ${status.rsiAutomation.suiteVersion ?? 'suite'}` : status.rsiProposalSynthesisConfigured ? '信号 → 提案 → evaluator → Canary' : status.rsiEvaluatorConfigured ? '候选 + evaluator' : '候选存储'],
    ['RSI evaluator', Boolean(status.rsiEvaluatorConfigured && status.rsiEvaluatorHealth?.ready), status.rsiEvaluatorConfigured ? (status.rsiEvaluatorHealth?.detail ?? '已配置，健康状态未验证') : '未配置'],
    ['多 Agent 协作', status.collaborationConfigured, status.collaborationConfigured ? 'Competition / Debate' : '未启用'],
    ['Skill 治理', Boolean(status.skillGovernanceConfigured && status.skillGovernanceHealth?.ready), status.skillGovernanceConfigured ? `OwnHow${status.skillGovernanceHealth?.detail ? ` · ${status.skillGovernanceHealth.detail}` : ''}` : '未启用'],
    ['投影记录', status.projectionConfigured, status.projectionConfigured ? 'Outbox 已启用' : '未启用'],
    ['外部投递', Boolean(status.projectionSinkConfigured && status.projectionSinkHealth?.ready), status.projectionSinkConfigured ? (status.projectionSinkHealth?.detail ?? '已配置，健康状态未验证') : '未配置投递渠道'],
  ];
  const grid = $('system-status'); grid.replaceChildren();
  for (const [label, ready, detail] of items) {
    const card = element('div', '', `status-card ${ready ? 'ready' : 'off'}`);
    card.append(element('strong', `${ready ? '●' : '○'} ${label}`), element('small', detail)); grid.append(card);
  }
  $('system-status').setAttribute('data-mode', status.mode);
  $('system-status').setAttribute('data-profile', status.executionProfile ?? 'unverified');
}
function parsePromptJson(label: string, fallback: unknown = undefined): unknown {
  const value = window.prompt(label, fallback === undefined ? '' : JSON.stringify(fallback));
  if (value === null) return undefined;
  try { return JSON.parse(value); } catch { throw new Error(`${label}必须是有效 JSON`); }
}
function showCollaborationDetails(parent: HTMLElement, label: string, value: unknown): void {
  const details = element('details', '', 'inline-inspection');
  details.open = true;
  details.append(element('summary', label), element('pre', JSON.stringify(value, null, 2)));
  parent.querySelector(':scope > .inline-inspection')?.remove();
  parent.append(details);
}
async function reconcileCompetitionAttempt(competitionId: string, attempt: NonNullable<CompetitionSummary['attempts']>[number]): Promise<void> {
  const outcome = window.prompt(`核查 Competition 参与者 ${attempt.participantAgentId}：completed 或 failed`, 'completed');
  if (!outcome || !['completed', 'failed'].includes(outcome)) return;
  const reason = window.prompt('核查说明（必填）')?.trim(); if (!reason) return;
  const usage = parsePromptJson('provider usage（可选 JSON，例如 {"tokens":123,"moneyUsd":0.02}）');
  const result = outcome === 'completed' ? parsePromptJson('最终 Result Envelope（必填 JSON）') : undefined;
  await api(`/collaborations/competitions/${encodeURIComponent(competitionId)}/reconcile-attempt`, { attemptId: attempt.id, outcome, reason, ...(usage === undefined ? {} : { usage }), ...(result === undefined ? {} : { result }) });
  await refresh();
}
async function reconcileCompetitionEvaluator(competitionId: string, attempt: NonNullable<CompetitionSummary['evaluatorAttempt']>): Promise<void> {
  const outcome = window.prompt('核查 Competition evaluator：completed 或 failed', 'completed');
  if (!outcome || !['completed', 'failed'].includes(outcome)) return;
  const reason = window.prompt('核查说明（必填）')?.trim(); if (!reason) return;
  const usage = parsePromptJson('provider usage（可选 JSON，例如 {"tokens":123,"moneyUsd":0.02}）');
  const scores = outcome === 'completed' ? parsePromptJson('候选评分数组（必填 JSON）') : undefined;
  await api(`/collaborations/competitions/${encodeURIComponent(competitionId)}/reconcile-evaluator`, { attemptId: attempt.id, outcome, reason, ...(usage === undefined ? {} : { usage }), ...(scores === undefined ? {} : { scores }) });
  await refresh();
}
async function reconcileDebateAttempt(debateId: string, attempt: NonNullable<DebateSummary['attempts']>[number]): Promise<void> {
  const outcome = window.prompt(`核查 Debate 尝试 ${attempt.slot}：completed 或 failed`, 'completed');
  if (!outcome || !['completed', 'failed'].includes(outcome)) return;
  const reason = window.prompt('核查说明（必填）')?.trim(); if (!reason) return;
  const usage = parsePromptJson('provider usage（可选 JSON，例如 {"tokens":123,"moneyUsd":0.02}）');
  const output = outcome === 'completed' ? parsePromptJson('提供方输出（completed 时必填 JSON）') : undefined;
  await api(`/collaborations/debates/${encodeURIComponent(debateId)}/reconcile-attempt`, { attemptId: attempt.id, outcome, reason, ...(usage === undefined ? {} : { usage }), ...(output === undefined ? {} : { output }) });
  await refresh();
}
async function reconcileTriggerDecision(decision: TriggerDecisionSummary): Promise<void> {
  const hasResource = Boolean(decision.resourceId);
  const options = hasResource ? ['dispatch_completed', 'dispatch_failed'] : ['resource_created', 'failed'];
  const outcome = window.prompt(`核查 Trigger ${decision.id}：${options.join(' 或 ')}`, options[0]);
  if (!outcome || !options.includes(outcome)) return;
  const reason = window.prompt('核查说明（必填）')?.trim(); if (!reason) return;
  const resourceId = outcome === 'resource_created' ? window.prompt('已核实的 Competition/Debate ID（必填）')?.trim() : undefined;
  if (outcome === 'resource_created' && !resourceId) return;
  await api(`/collaborations/triggers/decisions/${encodeURIComponent(decision.id)}/reconcile`, { outcome, reason, ...(resourceId ? { resourceId } : {}) });
  await refresh();
}
function renderCollaborations(competitions: CompetitionSummary[], debates: DebateSummary[], projections: ProjectionSummary[], triggerPolicies: TriggerPolicySummary[], triggerDecisions: TriggerDecisionSummary[]): void {
  const competitionList = $('competitions'); competitionList.replaceChildren(); $('competitions-empty').hidden = competitions.length > 0;
  for (const competition of competitions.slice(0, 12)) {
    const item = element('div', '', `fact-row collaboration-${competition.status}`);
    item.append(element('strong', `${runStatusLabel(competition.status)} · ${competition.brief.goal.slice(0, 48)}`), element('small', `${competition.candidates.length}/${competition.brief.participantAgentIds.length} 个候选 · ${competition.scores.length} 个评分${competition.selectedAgentId ? ` · 已选 ${competition.selectedAgentId}` : ''}`), element('small', collaborationCostText(competition.usage, competition.brief.modelBudget)), element('small', competition.failureReason ?? ''), element('small', new Date(competition.updatedAt).toLocaleString()));
    item.append(button('查看详情', async () => { showCollaborationDetails(item, `Competition ${competition.id}`, await api(`/collaborations/competitions/${encodeURIComponent(competition.id)}`)); }));
    if (['collecting', 'running'].includes(competition.status)) item.append(button('运行 Competition', async () => { await api(`/collaborations/competitions/${encodeURIComponent(competition.id)}/run`, {}); await refresh(); }));
    for (const attempt of competition.attempts ?? []) if (['started', 'unknown'].includes(attempt.state)) item.append(button(`核查参与者 ${attempt.participantAgentId}`, () => reconcileCompetitionAttempt(competition.id, attempt)));
    if (competition.evaluatorAttempt && ['started', 'unknown'].includes(competition.evaluatorAttempt.state)) item.append(button('核查 evaluator', () => reconcileCompetitionEvaluator(competition.id, competition.evaluatorAttempt!)));
    competitionList.append(item);
  }
  const debateList = $('debates'); debateList.replaceChildren(); $('debates-empty').hidden = debates.length > 0;
  for (const debate of debates.slice(0, 12)) {
    const item = element('div', '', `fact-row debate-${debate.status}`);
    const flagged = debate.room.moderation?.filter(item => item.status === 'flagged').length ?? 0;
    const adjudication = debate.room.adjudication?.status ? ` · 裁决${runStatusLabel(debate.room.adjudication.status)}` : '';
    const unsettled = debate.attempts?.filter(item => ['started', 'unknown'].includes(item.state)).length ?? 0;
    item.append(element('strong', `${runStatusLabel(debate.status)} · ${(debate.room.goal ?? debate.room.taskId).slice(0, 48)}`), element('small', `${debate.room.messages.length} 条消息 · ${debate.room.participantAgentIds.length} 个 Agent${flagged ? ` · ${flagged} 条被标记` : ''}${unsettled ? ` · ${unsettled} 条待处理` : ''}${adjudication}`), element('small', collaborationCostText(debate.usage, debate.modelBudget)), element('small', debate.closeReason ?? ''), element('small', new Date(debate.updatedAt).toLocaleString()));
    item.append(button('查看消息与裁决', async () => { showCollaborationDetails(item, `Debate ${debate.id}`, await api(`/collaborations/debates/${encodeURIComponent(debate.id)}`)); }));
    if (debate.status === 'active') item.append(button('运行 Debate', async () => { await api(`/collaborations/debates/${encodeURIComponent(debate.id)}/run`, {}); await refresh(); }));
    for (const attempt of debate.attempts ?? []) if (['started', 'unknown'].includes(attempt.state)) item.append(button(`核查 ${attempt.slot}`, () => reconcileDebateAttempt(debate.id, attempt)));
    if (debate.status === 'active') item.append(button('关闭 Debate', async () => { const reason = window.prompt('关闭原因（必填）')?.trim(); if (reason) { await api(`/collaborations/debates/${encodeURIComponent(debate.id)}/close`, { reason }); await refresh(); } }));
    debateList.append(item);
  }
  const projectionList = $('projections'); projectionList.replaceChildren(); $('projections-empty').hidden = projections.length > 0;
  for (const projection of projections.slice(-12).reverse()) {
    const item = element('div', '', `fact-row projection-${projection.status}`);
    item.append(element('strong', `${runStatusLabel(projection.status)} · ${projection.aggregateType}:${projection.aggregateId}`), element('small', `${projection.channel} → ${projection.destination} · ${projection.attempts} 次尝试`), element('small', projection.lastError ?? new Date(projection.updatedAt).toLocaleString()));
    projectionList.append(item);
  }
  const policyList = $('trigger-policies'); policyList.replaceChildren(); $('trigger-policies-empty').hidden = triggerPolicies.length > 0;
  for (const policy of triggerPolicies.slice(0, 12)) {
    const item = element('div', '', `fact-row trigger-policy-${policy.enabled ? 'enabled' : 'disabled'}`);
    item.append(element('strong', `${policy.enabled ? '启用' : '停用'} · ${policy.name}`), element('small', `${policy.id} · ${policy.eventTypes.join(', ')} · ${policy.action.type}/${policy.action.dispatch}`), element('small', `participants: ${policy.action.participantAgentIds.join(', ')}`), element('small', new Date(policy.updatedAt).toLocaleString()));
    item.append(button(policy.enabled ? '停用' : '启用', async () => { await api(`/collaborations/triggers/policies/${encodeURIComponent(policy.id)}`, { enabled: !policy.enabled }, 'PATCH'); await refresh(); }));
    item.append(button('删除', async () => { if (window.confirm(`删除 Trigger Policy ${policy.name}？`)) { await api(`/collaborations/triggers/policies/${encodeURIComponent(policy.id)}`, undefined, 'DELETE'); await refresh(); } }));
    policyList.append(item);
  }
  const decisionList = $('trigger-decisions'); decisionList.replaceChildren(); $('trigger-decisions-empty').hidden = triggerDecisions.length > 0;
  for (const decision of triggerDecisions.slice(0, 20)) {
    const item = element('div', '', `fact-row trigger-decision-${decision.state}`);
    item.append(element('strong', `${runStatusLabel(decision.state)} · ${decision.actionType}`), element('small', `${decision.policyId} · ${decision.eventId}`), element('small', `${runStatusLabel(decision.dispatchState)}${decision.resourceId ? ` · ${decision.resourceId}` : ''}`), element('small', decision.error ?? decision.dispatchError ?? new Date(decision.startedAt).toLocaleString()));
    if (decision.state !== 'failed' && !['completed', 'failed'].includes(decision.dispatchState)) item.append(button('核查', () => reconcileTriggerDecision(decision)));
    decisionList.append(item);
  }
}
async function renderRooms(rooms: RoomSummary[]): Promise<void> {
  const list = $('rooms'); list.replaceChildren(); $('rooms-empty').hidden = rooms.length > 0;
  const roomData = await Promise.all(rooms.map(async room => {
    const [members, events] = await Promise.all([
      api<RoomMemberSummary[]>(`/rooms/${encodeURIComponent(room.id)}/members`).catch(() => undefined),
      api<SessionEventPage>(`/rooms/${encodeURIComponent(room.id)}/session-events?limit=20`).catch(() => undefined),
    ]);
    return { members, events };
  }));
  for (const [index, room] of rooms.entries()) {
    const item = element('div', '', 'fact-row room-' + room.status);
    item.append(element('strong', room.title + ' · ' + runStatusLabel(room.status)), element('small', room.id + ' · ' + new Date(room.updatedAt).toLocaleString()));
    if (room.description) item.append(element('small', room.description));
    if (room.status === 'active') item.append(button('归档 Room', async () => { await api(`/rooms/${encodeURIComponent(room.id)}`, { status: 'archived' }, 'PATCH'); await refresh(); }));
    const { members, events } = roomData[index]!;
    if (members !== undefined) {
      const memberList = element('div', '', 'room-members');
      memberList.append(element('small', `成员 ${members.length} 人`));
      for (const member of members) {
        const row = element('div', '', 'room-member');
        row.append(element('span', `${member.principalId} · ${roleLabel(member.role)} · ${runStatusLabel(member.status)}`));
        if (member.status === 'active') row.append(button('撤销', async () => { await api(`/rooms/${encodeURIComponent(room.id)}/members/${encodeURIComponent(member.principalId)}`, undefined, 'DELETE'); await refresh(); }));
        memberList.append(row);
      }
      const invite = document.createElement('form'); invite.className = 'room-invite';
      const principal = element('input') as HTMLInputElement; principal.placeholder = '成员 principalId'; principal.required = true; principal.maxLength = 200;
      const role = document.createElement('select'); for (const value of ['editor', 'viewer', 'agent'] as const) { const option = element('option', roleLabel(value)); option.value = value; role.append(option); }
      const submit = element('button', '邀请成员') as HTMLButtonElement; submit.type = 'submit';
      invite.append(principal, role, submit);
      invite.onsubmit = event => { event.preventDefault(); submit.disabled = true; void api(`/rooms/${encodeURIComponent(room.id)}/members`, { principalId: principal.value.trim(), role: role.value }).then(async () => { principal.value = ''; await refresh(); }).catch(error => message(errorMessage(error))).finally(() => { submit.disabled = false; }); };
      memberList.append(invite); item.append(memberList);
    }
    const session = element('div', '', 'room-session');
    session.append(element('strong', '规范事件时间线'));
    if (events === undefined) {
      session.append(element('small', '当前身份无法读取，或 Shared Session 尚未配置。'));
    } else if (events.items.length === 0) {
      session.append(element('small', '还没有 canonical event。消息、决策和任务更新会以事实事件写入这里。'));
    } else {
      const timeline = element('ol', '', 'session-timeline');
      for (const event of events.items) appendSessionEventRow(timeline, room.id, event, events.items);
      session.append(timeline);
      if (events.nextCursor) {
        let nextCursor = events.nextCursor;
        const more = button('加载后续事件', async () => {
          const page = await api<SessionEventPage>(`/rooms/${encodeURIComponent(room.id)}/session-events?limit=20&cursor=${encodeURIComponent(nextCursor)}`);
          const loadedEvents = [...events.items, ...page.items];
          for (const event of page.items) appendSessionEventRow(timeline, room.id, event, loadedEvents);
          if (page.nextCursor) nextCursor = page.nextCursor;
          else more.remove();
        });
        session.append(more);
      }
    }
    item.append(session);
    list.append(item);
  }
}
function appendSessionEventRow(timeline: HTMLOListElement, roomId: string, event: SessionEventSummary, visibleEvents: SessionEventSummary[]): void {
  const row = element('li', '', `session-event session-event-${event.type}`);
  const heading = element('div', '', 'session-event-heading');
  const revision = event.revision && event.revision > 1 ? ` · v${event.revision}` : '';
  const operation = event.operation && event.operation !== 'publish' ? ` · ${event.operation}` : '';
  heading.append(element('strong', `#${event.sequence} · ${event.type}${operation}${revision}`), element('small', `${event.actorId} · ${new Date(event.createdAt).toLocaleString()}`));
  row.append(heading, element('p', event.content));
  row.append(element('small', `${event.goalId ? `Goal ${event.goalId}` : 'Room 共享上下文'} · manifest ${event.contextManifestId} · ${privacyLabel(event.classification)} · audience ${event.audienceSnapshot.digest.slice(0, 12)}…`));
  if (event.targetEventId) row.append(element('small', `目标事件：${event.targetEventId}`));
  if (event.retractionReason) row.append(element('small', `撤回原因：${event.retractionReason}`));
  if (event.evidenceRefs.length > 0) row.append(element('small', `Evidence: ${event.evidenceRefs.join(', ')}`));
  const latest = !visibleEvents.some(candidate => candidate.targetEventId === event.id);
  if (event.type === 'canonical_response' && event.operation !== 'retract' && latest) {
    const actions = element('div', '', 'session-event-actions');
    actions.append(button('修订答复', async () => {
      const content = window.prompt('新的规范答复', event.content)?.trim();
      if (!content) return;
      const refs = window.prompt('Evidence 引用（逗号分隔，可留空）', event.evidenceRefs.join(','));
      await api(`/rooms/${encodeURIComponent(roomId)}/session-events/${encodeURIComponent(event.id)}/revise`, {
        content,
        ...(refs === null ? {} : { evidenceRefs: refs.split(',').map(value => value.trim()).filter(Boolean) }),
        idempotencyKey: `ui-revise-${event.id}-${crypto.randomUUID()}`,
      });
      await refresh();
    }));
    actions.append(button('撤回答复', async () => {
      const reason = window.prompt('撤回原因')?.trim();
      if (!reason) return;
      await api(`/rooms/${encodeURIComponent(roomId)}/session-events/${encodeURIComponent(event.id)}/retract`, {
        reason,
        idempotencyKey: `ui-retract-${event.id}-${crypto.randomUUID()}`,
      });
      await refresh();
    }));
    row.append(actions);
  }
  timeline.append(row);
}
async function openRun(id: string): Promise<void> {
  currentId = id; current = undefined; localStorage.setItem('aeeis.run', id); await refresh();
}
async function renderGoals(goals: GoalSummary[], runs: RunSummary[], rooms: RoomSummary[]): Promise<void> {
  const plans = await Promise.all(goals.map(async goal => {
    const goalPlans = (await api<{ plans: DomainPlanSummary[] }>(`/goals/${goal.id}/plans/page?limit=50`)).plans;
    const dispatches = taskSchedulerConfigured
      ? await Promise.all(goalPlans.map(async plan => ({ planId: plan.id, dispatches: await api<TaskDispatchSummary[]>(`/plans/${plan.id}/scheduler`).catch(() => []) })))
      : [];
    const memories = await api<MemoryView[]>(`/goals/${encodeURIComponent(goal.id)}/memories?limit=50`).catch(() => []);
    return { goalId: goal.id, plans: goalPlans, dispatches, memories };
  }));
  const signature = JSON.stringify({ goals, plans, runs, rooms, modelConfigured });
  if (goalViewSignature === signature) return;
  const opened = new Set(Array.from($('goals').querySelectorAll<HTMLDetailsElement>('details[open]')).map(item => item.dataset.planId));
  const list = $('goals'); list.replaceChildren(); $('goals-empty').hidden = goals.length > 0;
  const selector = $<HTMLSelectElement>('goal-id');
  const selected = selector.value;
  selector.replaceChildren(element('option', '不绑定，创建独立运行'));
  selector.options[0]!.value = '';
 for (const goal of goals) {
   const option = element('option', `${goal.title} · ${runStatusLabel(goal.status)}`);
   option.value = goal.id; selector.append(option);
 }
 if (goals.some(goal => goal.id === selected)) selector.value = selected;
  const roomSelector = $<HTMLSelectElement>('goal-room-id');
  const selectedRoom = roomSelector.value;
  roomSelector.replaceChildren(element('option', '不绑定 Room'));
  roomSelector.options[0]!.value = '';
  for (const room of rooms) {
    const option = element('option', `${room.title} · ${runStatusLabel(room.status)}`);
    option.value = room.id; roomSelector.append(option);
  }
  if (rooms.some(room => room.id === selectedRoom)) roomSelector.value = selectedRoom;
  const roomById = new Map(rooms.map(room => [room.id, room]));
 for (const goal of goals) {
   const item = element('div', '', 'fact-row');
    item.append(element('strong', goal.title), element('small', `${runStatusLabel(goal.status)} · ${new Date(goal.createdAt).toLocaleDateString()}${goal.roomId && roomById.has(goal.roomId) ? ` · Room: ${roomById.get(goal.roomId)!.title}` : ''}`));
    const goalData = plans.find(entry => entry.goalId === goal.id);
    if (goalData?.memories.length) {
      const memoryDetails = element('details');
      memoryDetails.append(element('summary', `Goal 记忆 · ${goalData.memories.length} 条（含历史版本）`));
      for (const memory of goalData.memories) {
        const row = element('div', '', `memory-row memory-${memory.state ?? 'active'}`);
        row.append(element('strong', `${runStatusLabel(memory.state ?? 'active')} · ${memory.kind} · v${memory.version ?? 1}`), element('small', `${privacyLabel(memory.classification)} · ${memory.source} · 置信度 ${memory.confidence.toFixed(2)}`), element('span', memory.content));
        if (memory.evidenceRefs?.length) row.append(element('small', `证据：${memory.evidenceRefs.join(', ')}`));
        if (memory.evidenceRunId) row.append(element('small', `证据来源 Run：${memory.evidenceRunId}`));
        if (memory.supersedesId) row.append(element('small', `修正自：${memory.supersedesId}`));
        if (memory.retractionReason) row.append(element('small', `撤回原因：${memory.retractionReason}`));
        if ((memory.state ?? 'active') === 'active') {
          row.append(button('修正', async () => {
            const content = window.prompt('新的记忆内容', memory.content)?.trim(); if (!content) return;
            const refs = window.prompt('证据引用（逗号分隔，可留空）', (memory.evidenceRefs ?? []).join(','));
            await api(`/goals/${encodeURIComponent(goal.id)}/memories/${encodeURIComponent(memory.id)}/correct`, { kind: memory.kind, content, scope: memory.scope, classification: memory.classification, source: memory.source, confidence: memory.confidence, ...(refs === null ? {} : { evidenceRefs: refs.split(',').map(value => value.trim()).filter(Boolean) }) });
            goalViewSignature = ''; await refresh();
          }));
          row.append(button('撤回', async () => { const reason = window.prompt('撤回原因')?.trim(); if (reason) { await api(`/goals/${encodeURIComponent(goal.id)}/memories/${encodeURIComponent(memory.id)}/retract`, { reason }); goalViewSignature = ''; await refresh(); } }));
        }
        memoryDetails.append(row);
      }
      item.append(memoryDetails);
    }
    for (const [index, plan] of (goalData?.plans ?? []).entries()) {
      const details = element('details'); details.dataset.planId = plan.id; details.open = opened.has(plan.id);
      details.append(element('summary', `${index === 0 ? '最新' : '历史'}计划 v${plan.version} · ${plan.nodes.length} 个任务`));
      const planDispatches = goalData?.dispatches.find(entry => entry.planId === plan.id)?.dispatches ?? [];
      if (index === 0 && goal.status === 'active' && modelConfigured && taskSchedulerConfigured) {
        details.append(button(planDispatches.length ? '继续调度 DAG' : '调度整张 DAG', async () => {
          await api(`/plans/${plan.id}/schedule`, runOptions(false)); await refresh();
        }));
      } else if (index === 0 && goal.status === 'active' && modelConfigured && !taskSchedulerConfigured) {
        details.append(element('small', 'DAG 调度器未启用；可直接执行单个任务。', 'muted'));
      }
      if (planDispatches.length) {
        details.append(button('核查调度状态', async () => {
          await api(`/plans/${plan.id}/scheduler/reconcile`, {}); goalViewSignature = ''; await refresh();
        }));
      }
      for (const node of plan.nodes) {
        const row = element('div', '', 'task-row');
        row.append(element('span', `${runStatusLabel(node.status)} · ${node.title}`));
        if (node.instruction && node.instruction !== node.title) row.append(element('small', node.instruction));
        if (node.dependsOn.length) row.append(element('small', `依赖：${node.dependsOn.join(', ')}`));
        const execution = runs.find(run => run.taskExecution?.domainPlanId === plan.id && run.taskExecution.taskId === node.id)
          ?? runs.find(run => run.domainPlanId === plan.id && !run.taskExecution);
        if (execution) row.append(button(`查看执行 · ${runStatusLabel(execution.status)}`, () => openRun(execution.id)));
        const dispatch = planDispatches.find(item => item.taskId === node.id);
        if (dispatch) {
          row.append(element('small', `调度：${runStatusLabel(dispatch.state)} · ${dispatch.lastRunStatus ? runStatusLabel(dispatch.lastRunStatus) : '尚未观察到运行'} · ${dispatch.runner}${dispatch.lastError ? ` · ${dispatch.lastError}` : ''}`));
          const control = async (action: string, body: unknown = {}): Promise<void> => {
            await api(`/plans/${plan.id}/tasks/${encodeURIComponent(node.id)}/control/${action}`, body);
            goalViewSignature = ''; await refresh();
          };
          const status = dispatch.lastRunStatus;
          if (['queued', 'planning', 'running', 'reviewing'].includes(status ?? '')) {
            row.append(button('暂停', () => control('pause')));
            row.append(button('取消', () => control('cancel')));
          } else if (status === 'paused') {
            row.append(button('继续', () => control('resume')));
            row.append(button('取消', () => control('cancel')));
          } else if (status === 'unknown' || status === 'waiting_external') {
            row.append(button('核查并继续', async () => {
              const reason = window.prompt('核查说明（必填）')?.trim();
              if (reason) await control('reconcile', { reason });
            }));
            row.append(button('取消', () => control('cancel')));
          } else if (status === 'needs_approval' || status === 'needs_input') {
            row.append(button('取消', () => control('cancel')));
          } else if (status === 'failed' && node.status === 'failed') {
            row.append(button('重试此任务', async () => {
              await api(`/plans/${plan.id}/tasks/${encodeURIComponent(node.id)}/transition`, { transition: 'retry', reason: '用户从调度器控制面发起重试' });
              await control('retry');
            }));
          }
        } else if (!execution && node.status === 'ready' && goal.status === 'active') {
          if (taskSchedulerConfigured) {
            const schedule = button('调度此任务', async () => {
              await api(`/plans/${plan.id}/tasks/${encodeURIComponent(node.id)}/schedule`, runOptions(false)); goalViewSignature = ''; await refresh();
            });
            schedule.disabled = !modelConfigured; row.append(schedule);
          } else {
            row.append(element('small', '调度器未启用', 'muted'));
          }
          const start = button('直接执行此任务', async () => {
            const created = await api<{ id: string }>(`/plans/${plan.id}/tasks/${encodeURIComponent(node.id)}/run`, runOptions(false));
            await openRun(created.id);
          });
          start.disabled = !modelConfigured; row.append(start);
        }
        if (node.evidenceRefs?.length) row.append(element('small', `证据：${node.evidenceRefs.join(', ')}`));
        if (node.evidenceRunId) row.append(button('查看来源运行', () => openRun(node.evidenceRunId!)));
        details.append(row);
      }
      details.append(button('查看任务回执', async () => {
        const snapshot = await api<{ receipts: Array<{ taskId: string; transition: string; occurredAt: string; reason?: string }> }>(`/plans/${plan.id}/snapshot`);
        const inspection = element('details', '', 'inline-inspection');
        inspection.open = true;
        inspection.append(element('summary', '任务回执'));
        if (snapshot.receipts.length) {
          const list = element('ul');
          for (const receipt of snapshot.receipts) list.append(element('li', `${receipt.taskId} · ${receipt.transition} · ${new Date(receipt.occurredAt).toLocaleString()}${receipt.reason ? ` · ${receipt.reason}` : ''}`));
          inspection.append(list);
        } else inspection.append(element('p', '尚无执行回执。', 'muted'));
        details.querySelector(':scope > .inline-inspection')?.remove();
        details.append(inspection);
      }));
      item.append(details);
    }
    list.append(item);
  }
  goalViewSignature = signature;
}
function runOptions(includeProjectQuery = true): Record<string, unknown> {
  const content = $<HTMLTextAreaElement>('materials').value.trim();
  const knowledgeQuery = $<HTMLInputElement>('knowledge-query').value.trim();
  const allowedAgents = [...new Set($<HTMLInputElement>('allowed-agents').value.split(',').map(value => value.trim()).filter(Boolean))];
  const brainScope = $<HTMLInputElement>('brain-scope').value.trim();
  const brainQuery = $<HTMLInputElement>('brain-query').value.trim();
  const memoryQuery = $<HTMLInputElement>('memory-query').value.trim();
  // A scheduled follow-up executes its task, rather than generating another report.
  const builtinSkill = includeProjectQuery ? $<HTMLSelectElement>('builtin-skill').value : '';
  const projectSourceQuery = includeProjectQuery ? $<HTMLInputElement>('project-source-query').value.trim() : '';
  const tokenField = $<HTMLInputElement>('model-budget-tokens');
  const moneyField = $<HTMLInputElement>('model-budget-usd');
  if (!tokenField.checkValidity() || !moneyField.checkValidity()) throw new Error('请填写有效的 token 或 USD 预算阈值');
  const externalBudget: { calls?: number; tokens?: number; moneyUsd?: number } = {};
  for (const [key, fieldId] of [['calls', 'external-budget-calls'], ['tokens', 'external-budget-tokens'], ['moneyUsd', 'external-budget-usd']] as const) {
    const field = $<HTMLInputElement>(fieldId);
    if (!field.checkValidity()) throw new Error('请填写有效的外部执行预算');
    if (field.value) externalBudget[key] = Number(field.value);
  }
  const modelBudget = { ...(tokenField.value ? { tokens: Number(tokenField.value) } : {}), ...(moneyField.value ? { moneyUsd: Number(moneyField.value) } : {}) };
  return { ...(builtinSkill ? { builtinSkill } : {}), materials: content ? [{ title: '用户提供的项目资料', source: 'user-input', content }] : [], privacy: $<HTMLSelectElement>('privacy').value, ...(allowedAgents.length ? { allowedAgents } : {}), ...(Object.keys(externalBudget).length ? { externalBudget } : {}), ...(modelBudget && Object.keys(modelBudget).length ? { modelBudget } : {}), ...(knowledgeQuery ? { knowledgeQuery } : {}), ...(memoryQuery ? { memoryQuery } : {}), ...(brainScope ? { brainScope } : {}), ...(brainQuery ? { brainQuery } : {}), ...(projectSourceQuery ? { projectSourceQuery } : {}) };
}
($('new-goal') as HTMLFormElement).onsubmit = event => {
  event.preventDefault(); message('');
  const form = $('new-goal') as HTMLFormElement;
  const submit = form.querySelector('button') as HTMLButtonElement; submit.disabled = true;
  const roomId = $<HTMLSelectElement>('goal-room-id').value;
  void api('/goals', { title: $<HTMLInputElement>('goal-title').value, description: $<HTMLTextAreaElement>('goal-description').value || undefined, ...(roomId ? { roomId } : {}) })
    .then(async () => { $<HTMLInputElement>('goal-title').value = ''; $<HTMLTextAreaElement>('goal-description').value = ''; await refresh(); })
    .catch(error => message(errorMessage(error))).finally(() => { submit.disabled = false; });
};
($('discover-agent') as HTMLFormElement).onsubmit = event => {
  event.preventDefault(); message('');
  const form = $('discover-agent') as HTMLFormElement; const submit = form.querySelector('button') as HTMLButtonElement; submit.disabled = true;
  let card: unknown;
  try { card = JSON.parse($<HTMLTextAreaElement>('agent-card').value); }
  catch { message('Agent Card 必须是有效 JSON'); submit.disabled = false; return; }
  void api('/agents/discover', card).then(async () => { $<HTMLTextAreaElement>('agent-card').value = ''; await refresh(); }).catch(error => message(errorMessage(error))).finally(() => { submit.disabled = false; });
};
($('discover-agent-url') as HTMLFormElement).onsubmit = event => {
  event.preventDefault(); message('');
  const form = $('discover-agent-url') as HTMLFormElement; const submit = form.querySelector('button') as HTMLButtonElement; submit.disabled = true;
  void api('/agents/discover-url', { url: $<HTMLInputElement>('agent-card-url').value.trim() })
    .then(async () => { $<HTMLInputElement>('agent-card-url').value = ''; await refresh(); })
    .catch(error => message(errorMessage(error))).finally(() => { submit.disabled = false; });
};
($('new-room') as HTMLFormElement).onsubmit = event => {
  event.preventDefault(); message('');
  const form = event.currentTarget as HTMLFormElement;
  const submit = form.querySelector('button') as HTMLButtonElement; submit.disabled = true;
  void api('/rooms', { title: $<HTMLInputElement>('room-title').value, description: $<HTMLTextAreaElement>('room-description').value || undefined })
    .then(async () => { $<HTMLInputElement>('room-title').value = ''; $<HTMLTextAreaElement>('room-description').value = ''; await refresh(); })
    .catch(error => message(errorMessage(error))).finally(() => { submit.disabled = false; });
};
function bindJsonForm(formId: string, fieldId: string, path: string, label: string): void {
  ($(formId) as HTMLFormElement).onsubmit = event => {
    event.preventDefault(); message('');
    const form = $(formId) as HTMLFormElement; const submit = form.querySelector('button') as HTMLButtonElement; submit.disabled = true;
    let body: unknown;
    try { body = JSON.parse($<HTMLTextAreaElement>(fieldId).value); }
    catch { message(`${label} 必须是有效 JSON`); submit.disabled = false; return; }
    void api(path, body).then(async () => { $<HTMLTextAreaElement>(fieldId).value = ''; await refresh(); }).catch(error => message(errorMessage(error))).finally(() => { submit.disabled = false; });
  };
}
bindJsonForm('new-competition', 'competition-brief', '/collaborations/competitions', 'Competition Brief');
bindJsonForm('new-debate', 'debate-brief', '/collaborations/debates', 'Debate Brief');
bindJsonForm('new-trigger-policy', 'trigger-policy', '/collaborations/triggers/policies', 'Trigger Policy');
function renderCandidates(candidates: EvolutionSummary[]): void {
  const list = $('candidates'); list.replaceChildren(); $('candidates-empty').hidden = candidates.length > 0;
  for (const candidate of candidates) {
    const passed = candidate.evaluations.filter(item => item.passed).length;
    const item = button('', async () => { selectedCandidateId = candidate.id; localStorage.setItem('aeeis.candidate', candidate.id); await renderCandidateDetail(); });
    item.className = `fact-row candidate-${candidate.status}${candidate.id === selectedCandidateId ? ' selected' : ''}`;
    item.append(element('strong', `${candidate.target} · ${candidate.proposedVersion}`), element('small', `${runStatusLabel(candidate.status)} · 风险 ${candidate.risk} · ${passed}/${candidate.evaluations.length} 个评估门${candidate.proposalSignalId ? ' · 自动发现' : ''}`)); list.append(item);
  }
}
async function candidateCommand(id: string, action: string, body: unknown = {}): Promise<void> {
  await api(`/evolution/candidates/${id}/${action}`, body); await refresh();
}
async function renderCandidateDetail(): Promise<void> {
  if (!selectedCandidateId) { $('candidate-detail').hidden = true; return; }
  const [candidate, traffic] = await Promise.all([
    api<EvolutionView>(`/evolution/candidates/${selectedCandidateId}`),
    api<EvolutionTrafficView[]>('/evolution/traffic').catch(() => [] as EvolutionTrafficView[]),
  ]);
  $('candidate-detail').hidden = false;
  $('candidate-title').textContent = `${candidate.target} · ${candidate.proposedVersion}`;
  $('candidate-status').textContent = `${runStatusLabel(candidate.status)} · 风险 ${candidate.risk}`;
  $('candidate-change').textContent = `${candidate.change}\n\n原因：${candidate.reason}\n基线：${candidate.baseVersion}`;
  const gates = $('candidate-gates'); gates.replaceChildren();
  for (const gate of candidate.evaluations) gates.append(element('li', `${gate.kind} · ${gate.passed ? '通过' : '未通过'}`));
  if (!candidate.evaluations.length) gates.append(element('li', '尚未运行评估门', 'muted'));
  const rollout = $('candidate-rollout'); rollout.replaceChildren();
  for (const observation of [...(candidate.shadowObservations ?? []).map(item => ({ ...item, phase: 'shadow' })), ...(candidate.canaryObservations ?? []).map(item => ({ ...item, phase: 'canary' }))]) {
    rollout.append(element('li', `${runStatusLabel(observation.phase)} · ${observation.id} · ${observation.passed ? '通过' : '未通过'} · ${observation.score}`));
  }
  for (const attempt of candidate.rolloutAttempts ?? []) {
    const row = element('li', `${runStatusLabel(attempt.phase)} · ${attempt.caseId} · ${runStatusLabel(attempt.state)}${attempt.error ? ` · ${attempt.error}` : ''}`, attempt.state === 'failed' ? 'failure' : '');
    rollout.append(row);
    if (attempt.state === 'started') {
      const reconcile = button('Reconcile this attempt', async () => {
        const reason = window.prompt('核查原因（必填）')?.trim(); if (!reason) return;
        const passed = window.confirm('外部 evaluator 是否确认通过？');
        const scoreText = window.prompt('分数（0 到 1）', passed ? '1' : '0')?.trim();
        const score = Number(scoreText);
        const evidence = window.prompt('证据引用，逗号分隔', attempt.id)?.split(',').map(value => value.trim()).filter(Boolean);
        if (!Number.isFinite(score) || score < 0 || score > 1 || !evidence?.length) throw new Error('需要有效分数和至少一个证据引用');
        await candidateCommand(candidate.id, 'reconcile-rollout', { attemptId: attempt.id, outcome: 'completed', passed, score, evidenceRefs: evidence, reason });
      });
      rollout.append(reconcile);
    }
  }
  if (!rollout.children.length) rollout.append(element('li', '尚未有 rollout observation 或 attempt', 'muted'));
  const trafficList = $('candidate-traffic'); trafficList.replaceChildren();
  const routes = traffic.filter(route => route.candidateId === candidate.id);
  for (const route of routes) {
    trafficList.append(element('li', `${runStatusLabel(route.status)} · ${route.percentage / 100}% · ${route.version} · ${route.rolloutRef}${route.lastReason ? ` · ${route.lastReason}` : ''}`));
    for (const observation of route.observations ?? []) trafficList.append(element('li', `观察 ${observation.id} · ${observation.passed ? '通过' : '失败'} · ${observation.score} · ${observation.evidenceRefs.join(', ')}`));
  }
  if (!routes.length) trafficList.append(element('li', '当前没有生产流量 route', 'muted'));
  const controls = $('candidate-controls'); controls.replaceChildren();
  const allRequiredPassed = ['replay', 'holdout', 'safety'].every(kind => candidate.evaluations.some(item => item.kind === kind && item.passed));
  if (['evaluating', 'held'].includes(candidate.status) && allRequiredPassed) controls.append(button('批准候选', async () => { const approvalRef = window.prompt('审批引用（必填）')?.trim(); if (approvalRef) await candidateCommand(candidate.id, 'approve', { approvalRef }); }));
  if (candidate.status === 'approved' && candidate.risk === 'low') controls.append(button('晋升低风险候选', () => candidateCommand(candidate.id, 'promote')));
  if (candidate.status === 'approved' && candidate.risk !== 'low') controls.append(button('开始 Shadow', () => candidateCommand(candidate.id, 'start-shadow')));
  const shadowReady = (candidate.shadowObservations?.length ?? 0) >= (candidate.risk === 'high' ? 5 : candidate.risk === 'medium' ? 3 : 1) && (candidate.shadowObservations ?? []).every(item => item.passed);
  if (candidate.status === 'shadowing' && shadowReady) controls.append(button('开始 Canary', () => candidateCommand(candidate.id, 'start-canary')));
  if (candidate.status === 'canarying' && (candidate.canaryObservations?.length ?? 0) > 0) controls.append(button('晋升 Canary 候选', () => candidateCommand(candidate.id, 'promote')));
  if (candidate.status === 'promoted' && ['profile', 'prompt'].includes(candidate.target)) controls.append(button('激活到新 Run', async () => { const activationRef = window.prompt('激活引用（必填）')?.trim(); if (activationRef) await candidateCommand(candidate.id, 'activate', { activationRef }); }));
  const route = routes.find(item => item.status === 'active' || item.status === 'paused');
  if (candidate.status === 'promoted' && !route) controls.append(button('开始生产流量 Canary', async () => {
    const percentage = Number(window.prompt('流量百分比（1 到 99.99）', '5'));
    const rolloutRef = window.prompt('发布引用（必填）')?.trim();
    if (Number.isInteger(Math.round(percentage * 100)) && percentage > 0 && percentage < 100 && rolloutRef) await candidateCommand(candidate.id, 'start-traffic', { percentage: Math.round(percentage * 100), rolloutRef });
  }));
  if (route?.status === 'active') {
    controls.append(button('调整流量比例', async () => {
      const percentage = Number(window.prompt('流量百分比（1 到 99.99）', String(route.percentage / 100)));
      const rolloutRef = window.prompt('变更引用（必填）')?.trim();
      if (Number.isInteger(Math.round(percentage * 100)) && percentage > 0 && percentage < 100 && rolloutRef) await candidateCommand(candidate.id, 'update-traffic', { percentage: Math.round(percentage * 100), rolloutRef });
    }));
    controls.append(button('暂停生产流量', async () => { const reason = window.prompt('暂停原因（必填）')?.trim(); if (reason) await candidateCommand(candidate.id, 'pause-traffic', { reason }); }));
  }
  if (route?.status === 'paused') controls.append(button('恢复生产流量', async () => { const rolloutRef = window.prompt('恢复引用（必填）')?.trim(); if (rolloutRef) await candidateCommand(candidate.id, 'resume-traffic', { rolloutRef }); }));
  if (route && route.status !== 'stopped') controls.append(button('停止生产流量', async () => { const reason = window.prompt('停止原因（必填）')?.trim(); if (reason) await candidateCommand(candidate.id, 'stop-traffic', { reason }); }));
  if (route && route.status !== 'stopped') controls.append(button('记录线上观察', async () => {
    const id = window.prompt('观察 ID（必填）')?.trim();
    const score = Number(window.prompt('分数（0 到 1）', '1'));
    const passed = window.confirm('这次线上观察是否通过？');
    const evidence = window.prompt('证据引用，逗号分隔')?.split(',').map(value => value.trim()).filter(Boolean);
    if (id && Number.isFinite(score) && score >= 0 && score <= 1 && evidence?.length) await candidateCommand(candidate.id, 'record-traffic', { id, passed, score, evidenceRefs: evidence });
  }));
  if (['approved', 'shadowing', 'canarying', 'held', 'promoted'].includes(candidate.status)) controls.append(button('回滚候选', async () => { const reason = window.prompt('回滚原因（必填）')?.trim(); if (reason) await candidateCommand(candidate.id, 'rollback', { reason }); }));
}
async function command(action: string, body: unknown = {}): Promise<void> {
  await api(`/runs/${currentId}/${action}`, body);
  await refresh();
  window.requestAnimationFrame(() => $<HTMLElement>('#decision-title')?.focus({ preventScroll: true }));
}
function updateRunActivity(run: RunView): void {
  const stage = $('activity-stage');
  const meta = $('activity-meta');
  const activity = $('run-activity');
  if (!stage || !meta || !activity) return;
  const copy: Record<string, [string, string]> = {
    queued: taskSchedulerConfigured ? ['已排队，准备启动', '调度器正在为这次运行分配入口'] : ['等待运行服务配置', '调度器尚未启用，配置后这次运行才能继续'],
    planning: ['正在拆解目标', 'Agent 正在把目标整理成可审批的任务图'],
    needs_approval: ['计划已准备好', '请查看执行图，批准后 Agent 才会继续'],
    running: ['Agent 正在推进', '任务、工具和证据会随着事件流逐步出现'],
    reviewing: ['正在做独立复核', '审核器正在检查结果和证据之间的关系'],
    needs_input: ['轮到你了', '补充信息后，Agent 会从当前节点继续'],
    waiting_external: ['等待外部回执', '调用已经留有凭证，核查后即可恢复'],
    unknown: ['结果需要核查', '这一步没有自动重试，保留原调用以避免重复副作用'],
    paused: ['运行已暂停', '状态和证据已保存，随时可以继续'],
    succeeded: ['交付已完成', '结果、产物和证据已经写入本次运行'],
    failed: ['运行遇到问题', '查看错误后可以重试失败步骤或重新规划'],
    cancelled: ['运行已取消', '已保存取消前的状态和外部调用边界'],
  };
  const [title, detail] = copy[run.status] ?? ['运行状态已更新', `当前状态：${run.status}`];
  if (stage.textContent !== title) stage.textContent = title;
  const latest = run.events.at(-1);
  const anchor = run.events.find(event => ['run.created', 'run.started', 'run.planned'].includes(event.type))?.at ?? run.updatedAt;
  const elapsedMs = anchor ? Date.now() - Date.parse(anchor) : 0;
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? formatElapsed(elapsedMs) : '';
  const activityMeta = `${detail}${elapsed ? ` · 已${['queued', 'planning'].includes(run.status) ? '等待' : '运行'} ${elapsed}` : ''}${latest ? ` · 最新事件 ${eventLabel(latest.type)}` : ''}`;
  if (meta.textContent !== activityMeta) meta.textContent = activityMeta;
  const trail = $('activity-trail');
  if (trail) {
    const trailEvents = run.events.slice(-3);
    const trailSignature = trailEvents.map(event => `${event.seq}:${event.type}:${event.at}`).join('|');
    if (trail.dataset.signature !== trailSignature) {
      trail.replaceChildren();
      for (const event of trailEvents) {
        const item = element('li', eventLabel(event.type));
        item.title = `${event.type} · ${new Date(event.at).toLocaleString()}`;
        trail.append(item);
      }
      trail.dataset.signature = trailSignature;
    }
  }
  activity.dataset.status = run.status;
  const phaseIndex = ['queued', 'planning'].includes(run.status) ? 0
    : run.status === 'needs_approval' ? 1
    : ['running', 'paused', 'needs_input', 'unknown', 'waiting_external'].includes(run.status) ? 2
    : ['reviewing'].includes(run.status) ? 3
    : run.status === 'succeeded' ? 4 : 2;
  document.querySelectorAll<HTMLElement>('#run-phases [data-phase]').forEach((item, index) => {
    const active = index === Math.min(phaseIndex, 3);
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    item.classList.toggle('is-done', index < phaseIndex || run.status === 'succeeded');
  });
}
function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
function renderRunDecision(run: RunView): void {
  const panel = $('run-decision');
  if (!panel) return;
  const labels: Record<string, [string, string]> = {
    queued: ['等待调度', '目标已接收，调度器会为它分配执行入口。'],
    planning: ['正在规划', 'Agent 正在把目标拆成可审批的任务。'],
    needs_approval: ['等待批准', '计划已经准备好，批准后才会产生执行副作用。'],
    running: ['执行中', 'Agent 正在推进当前任务，事件流会持续更新。'],
    reviewing: ['复核中', '审核器正在检查结果与证据之间的关系。'],
    needs_input: ['需要你补充', '回答一个问题后，Agent 会从当前节点继续。'],
    waiting_external: ['等待外部回执', '调用已有凭证，核查后可以恢复。'],
    unknown: ['需要核查', '外部结果不明确，先核查再决定是否继续。'],
    paused: ['已暂停', '状态和证据已保存，可以从当前节点继续。'],
    succeeded: ['已完成', '结果、产物和证据已经写入本次运行。'],
    failed: ['运行失败', '可以重试失败步骤，或让 Agent 重新规划。'],
    cancelled: ['已取消', '取消前的状态、证据和外部调用仍然可追溯。'],
  };
  const [badge, badgeDetail] = labels[run.status] ?? ['状态更新', `当前状态：${run.status}`];
  const plan = run.plans.at(-1);
  const total = plan?.nodes.length ?? run.steps.length;
  const doneStatuses = new Set(['succeeded', 'completed', 'done']);
  const activeStatuses = new Set(['running', 'active', 'in_progress']);
  const completed = run.steps.filter(step => doneStatuses.has(step.status)).length;
  const active = run.steps.find(step => activeStatuses.has(step.status));
  const pending = run.steps.find(step => !doneStatuses.has(step.status) && !activeStatuses.has(step.status));
  const node = plan?.nodes.find(item => item.id === (active?.taskId ?? pending?.taskId));
  const nodeLabel = node?.title ?? active?.taskId ?? pending?.taskId ?? (plan ? '等待任务状态' : '计划尚未生成');
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : run.status === 'succeeded' ? 100 : 0;
  const metrics = $('decision-metrics');
  const progressBar = $('decision-progress-bar');
  const title = $('decision-title');
  const decisionBadge = $('decision-badge');
  const nextAction = $('decision-next-action');
  const nextDetail = $('decision-next-detail');
  const nextButton = $('decision-next-button') as HTMLButtonElement | null;
  if (!metrics || !progressBar || !title || !decisionBadge || !nextAction || !nextDetail) return;
  panel.dataset.status = run.status;
  title.textContent = badgeDetail;
  decisionBadge.textContent = badge;
  decisionBadge.className = `decision-badge ${run.status}`;
  progressBar.style.width = `${percent}%`;
  const progress = $('decision-progress');
  progress.setAttribute('aria-valuenow', String(percent));
  progress.setAttribute('aria-valuetext', `${percent}% · ${completed}/${total || 0} 个任务`);
  metrics.replaceChildren();
  const metricValues: Array<[string, string]> = [
    ['进度', `${completed}/${total || '—'} 个任务`],
    ['当前节点', nodeLabel],
    ['证据', `${run.artifacts.length} 个产物 · ${(run.context?.sources ?? []).length} 个来源`],
    ['事件', `${run.events.length} 条`],
  ];
  for (const [label, value] of metricValues) {
    const metric = element('div', '', 'decision-metric');
    metric.append(element('small', label), element('strong', value));
    metrics.append(metric);
  }
  const review = $('decision-review');
  const reviewGrid = $('decision-review-grid');
  const reviewTasks = $('decision-review-tasks');
  const reviewActions = $('decision-review-actions');
  if (review && reviewGrid && reviewTasks && reviewActions) {
    const isReview = run.status === 'needs_approval';
    review.hidden = !isReview;
    reviewGrid.replaceChildren();
    reviewTasks.replaceChildren();
    reviewActions.replaceChildren();
    if (isReview && plan) {
      const modelBudget = run.modelBudget?.tokens !== undefined ? `${run.modelBudget.tokens.toLocaleString()} tokens` : run.modelBudget?.moneyUsd !== undefined ? `$${run.modelBudget.moneyUsd.toFixed(2)}` : '未设置';
      const externalBudget = run.externalBudget?.calls !== undefined ? `${run.externalBudget.calls} 次调用` : run.externalBudget?.tokens !== undefined ? `${run.externalBudget.tokens.toLocaleString()} tokens` : '未设置';
      const reviewValues: Array<[string, string]> = [
        ['计划', `v${plan.version} · ${plan.nodes.length} 个任务`],
        ['资料边界', `${(run.context?.sources ?? []).length} 个来源 · ${privacyLabel(run.privacy)}`],
        ['Tool / Agent', `${run.approvedTools?.length ?? 0} 个 Tool · ${run.pendingDelegation ? 1 : 0} 个 Agent`],
        ['预算上限', `模型 ${modelBudget} · 外部 ${externalBudget}`],
      ];
      for (const [label, value] of reviewValues) {
        const item = element('div', '', 'review-fact');
        item.append(element('small', label), element('strong', value));
        reviewGrid.append(item);
      }
      reviewTasks.append(element('small', '任务预览 · 点击查看依赖和证据要求', 'review-task-label'));
      for (const node of plan.nodes) {
        const task = element('details', '', 'review-task');
        task.append(element('summary', node.title));
        task.append(element('small', `任务 ID：${node.id}`));
        task.append(element('small', `依赖：${node.dependsOn.length ? node.dependsOn.join('、') : '无'}`));
        if (node.evidenceRefs?.length) task.append(element('small', `已有证据：${node.evidenceRefs.join('、')}`));
        else task.append(element('small', '已有证据：待执行后生成'));
        reviewTasks.append(task);
      }
      const viewPlan = button('展开任务图', async () => {
        setRunDetailsMode(true);
        $('graph')?.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      viewPlan.className = 'quiet-button';
      reviewActions.append(viewPlan);
      const approve = button('批准并执行', () => command('approve', { planHash: plan.hash }));
      approve.className = 'decision-primary';
      reviewActions.append(approve);
    }
  }
  const actions: Record<string, [string, string]> = {
    needs_approval: ['批准计划并执行', '先检查任务图、预算和外部调用边界。'],
    needs_input: ['补充信息', '回答上方问题即可从当前节点继续。'],
    waiting_external: ['核查外部结果', '确认供应方回执后再恢复，避免重复副作用。'],
    unknown: ['核查不明结果', '先确认原调用是否完成，再决定是否重试。'],
    failed: ['重试或重新规划', '查看错误和证据后选择恢复路径。'],
    paused: ['继续运行', '所有已产生的事实和证据都会被保留。'],
    succeeded: ['查看证据与产物', '交付已经完成，可以继续沉淀为长期目标。'],
  };
  let [action, detail] = actions[run.status] ?? (active ? [`等待「${nodeLabel}」完成`, 'Agent 正在执行，新的事件会自动出现。'] : ['等待下一步', '运行状态变化后，这里会给出可执行动作。']);
  if (run.status === 'queued' && !taskSchedulerConfigured) {
    action = '等待运行服务配置';
    detail = '调度器尚未启用；打开详细设置查看当前运行能力。';
  }
  nextAction.textContent = action;
  nextDetail.textContent = detail;
  if (nextButton) {
    nextButton.hidden = true;
    nextButton.disabled = false;
    nextButton.classList.remove('is-busy');
    nextButton.onclick = null;
    const installAction = (label: string, task: () => Promise<void>): void => {
      nextButton.hidden = false;
      nextButton.textContent = label;
      nextButton.onclick = () => {
        nextButton.disabled = true;
        nextButton.classList.add('is-busy');
        void task().catch(error => message(errorMessage(error))).finally(() => {
          nextButton.disabled = false;
          nextButton.classList.remove('is-busy');
        });
      };
    };
    if (run.status === 'queued' && taskSchedulerConfigured) installAction('恢复调度', () => command('dispatch'));
    else if (run.status === 'needs_approval' && plan) installAction('批准并执行', () => command('approve', { planHash: plan.hash }));
    else if (run.status === 'needs_input' || run.status === 'unknown') installAction(run.status === 'unknown' ? '填写核查说明' : '补充信息', async () => {
      openInputPanel(run.status === 'unknown' ? 'reconcile' : 'answer');
    });
    else if (run.status === 'waiting_external') installAction('核查外部结果', async () => {
      openInputPanel('reconcile');
    });
    else if (run.status === 'failed') installAction('重试失败步骤', () => command('retry'));
    else if (run.status === 'paused') installAction('继续运行', () => command('resume'));
    else if (run.status === 'succeeded') installAction('查看证据与产物', async () => {
      setRunDetailsMode(true);
      $('artifacts')?.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    else if (run.status === 'cancelled') installAction('查看外部回执', async () => {
      setRunDetailsMode(true);
      $('external-effects')?.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}
function render(run: RunView): void {
  $('run-title').textContent = run.goal;
  $('run-status').textContent = runStatusLabel(run.status);
  $('run-status').className = `status ${run.status}`;
  updateRunActivity(run);
  renderRunDecision(run);
  $('empty').hidden = minimalMode || currentRunOpen;
  $('detail').hidden = !currentRunOpen;
  syncCurrentRunToggle(run);
  updateRunDock(run);
  renderDeliverySummary(run);
  const validationEvent = [...run.events].reverse().find(event => event.type === 'run.failed' && event.data?.validation?.issues?.length);
  const validationText = validationEvent?.data?.validation?.issues?.slice(0, 3).map(issue => `${issue.path ?? '$'}：${issue.message ?? '格式不符合要求'}`).join('；');
  $('run-error').textContent = run.error ? `${run.error}${validationText ? ` · ${validationText}` : ''}` : '';
  const traffic = run.evolutionTraffic ?? [];
  $('evolution-traffic').textContent = traffic.length
    ? `RSI traffic：${traffic.map(item => `${item.target}=${item.selected ? item.candidateId : 'base'} (${item.percentage / 100}% · bucket ${item.bucket})`).join('；')}`
    : '';
  const effects = $('external-effects'); effects.replaceChildren();
  for (const receipt of run.toolReceipts ?? []) effects.append(element('li', `Tool ${receipt.operation} · ${runStatusLabel(receipt.status)} · ${receipt.authorization ? `接纳=${receipt.authorization.decision}(${receipt.authorization.reason}) · ` : ''}${receipt.receiptId}${receipt.errorCode ? ` · ${receipt.errorCode}` : ''}`));
  for (const outcome of run.delegationOutcomes ?? []) effects.append(element('li', `Agent ${outcome.agentId ?? 'external'} · ${runStatusLabel(outcome.status)} · ${outcome.receiptRef}`));
  if (run.pendingTool) effects.append(element('li', `等待 Tool reconcile：${run.pendingTool.toolId} · ${run.pendingTool.receiptId ?? '尚未生成 receipt'}`, 'failure'));
  if (run.pendingDelegation) effects.append(element('li', `等待 Agent reconcile：${run.pendingDelegation.agentId} · ${run.pendingDelegation.receiptRef ?? '尚未生成 receipt'}`, 'failure'));
  if (!effects.children.length) effects.append(element('li', '本次运行没有外部 Tool 或 Agent 调用记录', 'muted'));
  const progressList = $('agent-progress'); progressList.replaceChildren();
  const progress = [...(run.agentProgress ?? [])].sort((a, b) => a.progress.at.localeCompare(b.progress.at) || a.progress.sequence - b.progress.sequence);
  for (const item of progress) {
    const value = item.progress;
    const row = element('li', '', 'agent-progress-item');
    row.append(element('time', new Date(value.at).toLocaleString()), element('strong', `${runStatusLabel(value.status)} · ${value.agentId} · #${value.sequence}`), element('span', value.percent === undefined ? value.message : `${value.message} · ${value.percent}%`));
    if (value.evidenceRefs.length || value.artifactRefs.length) row.append(element('small', `引用：${[...value.evidenceRefs, ...value.artifactRefs].join(', ')}`));
    progressList.append(row);
  }
  if (!progressList.children.length) progressList.append(element('li', '当前没有外部 Agent 流式进度', 'muted'));
  const controls = $('controls'); controls.replaceChildren();
  if (['queued', 'planning', 'running', 'reviewing'].includes(run.status)) controls.append(button('暂停', () => command('pause')));
  if (run.status === 'paused') controls.append(button('继续', () => command('resume')));
  if (run.status === 'waiting_external') controls.append(button('核查外部 Agent 结果', async () => { openInputPanel('reconcile'); }));
  if (run.status === 'needs_input' || run.status === 'unknown') controls.append(button(run.status === 'unknown' ? '填写核查说明' : '填写补充信息', async () => {
    openInputPanel(run.status === 'unknown' ? 'reconcile' : 'answer');
  }));
  if (run.status === 'cancelled' && (run.pendingTool?.receiptId || run.pendingDelegation?.receiptRef)) controls.append(button('核查已取消运行的外部调用', async () => {
    openInputPanel('reconcile-cancelled');
  }));
  if (run.status === 'failed') controls.append(button('重试失败步骤', () => command('retry')));
  if (run.status === 'failed' && !run.taskExecution) controls.append(button('重新规划', () => command('replan', { reason: '根据审核或失败信息生成新的计划版本' })));
  if (!['succeeded', 'cancelled'].includes(run.status)) {
    const cancel = button(cancelArmedRunId === run.id ? '再次点击确认取消' : '取消运行', async () => {
      if (cancelArmedRunId !== run.id) {
        cancelArmedRunId = run.id;
        cancel.textContent = '再次点击确认取消';
        cancel.dataset.state = 'attention';
        window.setTimeout(() => {
          if (cancelArmedRunId !== run.id) return;
          cancelArmedRunId = '';
          if (cancel.isConnected) { cancel.textContent = '取消运行'; delete cancel.dataset.state; }
        }, 5000);
        return;
      }
      cancel.disabled = true;
      cancel.textContent = '正在取消…';
      cancelArmedRunId = '';
      await command('cancel');
    });
    cancel.className = 'quiet-button';
    if (cancelArmedRunId === run.id) cancel.dataset.state = 'attention';
    controls.append(cancel);
  }
  if (run.status === 'queued' && taskSchedulerConfigured) controls.append(button('恢复调度', () => command('dispatch')));
  const reconcileMode: InputPanelMode | undefined = run.status === 'waiting_external'
    ? 'reconcile'
    : run.status === 'cancelled' && (run.pendingTool?.receiptId || run.pendingDelegation?.receiptRef)
      ? 'reconcile-cancelled'
      : run.status === 'unknown' ? 'reconcile' : run.status === 'needs_input' ? 'answer' : undefined;
  if (reconcileMode) inputPanelMode = reconcileMode;
  $('input-panel').hidden = reconcileMode === undefined;
  const inputHeading = $('input-panel').querySelector('h2');
  const inputSubmit = $('input-panel').querySelector('button');
  if (inputHeading) inputHeading.textContent = inputPanelMode === 'answer' ? '需要你的信息' : '核查外部结果';
  if (inputSubmit) inputSubmit.textContent = inputPanelMode === 'answer' ? '提交并继续' : '提交核查并继续';
  $('question').textContent = inputPanelMode === 'answer'
    ? (run.question?.text ?? 'Agent 需要一条补充信息才能继续。')
    : inputPanelMode === 'reconcile-cancelled'
      ? '运行已经取消，但外部调用仍需核查。请说明已确认的回执或后续处理。'
      : '请说明你确认的外部结果；核查后 AEEIS 才会决定是否恢复，避免重复副作用。';
  const plan = run.plans.at(-1);
  $('plan-summary').textContent = plan
    ? `计划 v${plan.version} · ${plan.summary}${run.plans.length > 1 ? ` · 历史版本：${run.plans.slice(0, -1).map(item => `v${item.version}`).join('、')}` : ''}`
    : '正在等待模型生成任务计划';
  const sources = $('sources'); sources.replaceChildren();
  $('memory-context').textContent = run.context?.memoryManifestId
    ? `Goal Memory Manifest：${run.context.memoryManifestId} · hash ${run.context.memoryManifestHash ?? 'legacy'} · 冻结 ${run.context.memoryRefs?.length ?? 0} 条记忆引用`
    : '本次 Run 没有绑定 Goal Memory Manifest。';
  for (const source of run.context?.sources ?? []) {
    const box = element('details');
    box.append(element('summary', `${source.title} · ${privacyLabel(source.classification ?? run.privacy)}`), element('small', `${source.source} · ${source.id} · sha256 ${source.hash}${source.origin ? ` · 来源 Run ${source.origin.runId}` : ''}`), element('pre', source.content));
    sources.append(box);
  }
  if (!sources.children.length) sources.append(element('p', '本次运行没有读取外部项目源或知识记录。', 'muted'));
  renderGovernance(run);
  const graph = $('graph'); graph.replaceChildren();
  if (plan) {
    const levels = new Map<string, number>();
    function level(id: string): number {
      if (levels.has(id)) return levels.get(id)!;
      const node = plan!.nodes.find(n => n.id === id)!;
      const value = node.dependsOn.length ? 1 + Math.max(...node.dependsOn.map(level)) : 0; levels.set(id, value); return value;
    }
    plan.nodes.forEach(n => level(n.id));
    const positions = new Map<string, { x: number; y: number }>();
    const rows = new Map<number, number>();
    for (const node of plan.nodes) {
      const l = levels.get(node.id)!, row = rows.get(l) ?? 0; rows.set(l, row + 1);
      positions.set(node.id, { x: l * 268 + 8, y: row * 128 + 8 });
    }
    const canvas = element('div', '', 'canvas');
    const width = (Math.max(...levels.values()) + 1) * 268, height = Math.max(...rows.values()) * 128;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
    for (const node of plan.nodes) for (const dependency of node.dependsOn) {
      const a = positions.get(dependency)!, b = positions.get(node.id)!;
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', `M${a.x+236} ${a.y+48} C${a.x+253} ${a.y+48} ${b.x-17} ${b.y+48} ${b.x} ${b.y+48}`);
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#5378a5'); path.setAttribute('stroke-width', '2'); svg.append(path);
    }
    canvas.append(svg);
    for (const node of plan.nodes) {
      const p = positions.get(node.id)!; const status = run.steps.find(s => s.taskId === node.id)?.status ?? 'pending';
      const card = element('article', '', `node ${status}`); card.style.left = `${p.x}px`; card.style.top = `${p.y}px`;
      card.append(element('small', runStatusLabel(status)), element('strong', node.title), element('small', node.id));
      if (node.evidenceRefs?.length) card.append(element('small', `证据：${node.evidenceRefs.join(', ')}${node.evidenceRunId ? ` · Run ${node.evidenceRunId}` : ''}`));
      canvas.append(card);
    }
    graph.append(canvas);
  }
  renderGraphList($('execution-graph'), run.graphs?.execution, '执行图尚无节点');
  renderGraphList($('evidence-graph'), run.graphs?.evidence, '证据图尚无节点');
  renderPlanHistory(run);
  const artifacts = $('artifacts'); artifacts.replaceChildren();
  for (const artifact of run.artifacts) {
    const box = element('details'); box.open = true;
    box.append(element('summary', `${artifact.title}${artifact.artifactType ? ` · ${artifact.artifactType}` : ''}`), element('pre', artifact.content));
    if (isProjectPulseArtifact(artifact.structured)) appendProjectPulse(box, artifact.structured, run);
    else if (artifact.structured) box.append(element('small', '结构化产物'), element('pre', JSON.stringify(artifact.structured, null, 2)));
    box.append(element('small', `证据：${artifact.evidenceRefs.join(', ') || '无外部来源引用'}`)); artifacts.append(box);
    if (run.goalId && artifact.evidenceRefs.length) box.append(memoryWritebackForm(run, artifact));
    if (evolutionConfigured) box.append(correctionForm(run, artifact));
    for (const correction of run.corrections ?? []) {
      if (!correction.sourceRefs.includes(artifact.id)) continue;
      const history = element('div', '', 'correction-history');
      history.append(element('p', correction.text), button('查看改进候选', async () => {
        selectedCandidateId = correction.candidateId;
        localStorage.setItem('aeeis.candidate', selectedCandidateId);
        await renderCandidateDetail(); $('candidate-detail').scrollIntoView({ block: 'center' });
      }));
      box.append(history);
    }
  }
  if (!run.artifacts.length) artifacts.append(element('p', '实际执行后，报告和其他产物会出现在这里。', 'muted'));
  $('review').textContent = run.review ? `${run.review.verdict}: ${run.review.summary}\n${run.review.issues.join('\n')}` : '';
  const timeline = $('timeline'); timeline.replaceChildren();
  renderTimelineFilterState();
  const timelineEvents = run.events.slice(-80).filter(event => timelineMatchesFilter(event.type)).sort((a, b) => a.seq - b.seq);
  if (!timelineEvents.length) timeline.append(element('li', '尚无执行事件', 'muted'));
  for (const e of timelineEvents) {
    const item = element('li', '', `timeline-item timeline-${timelineTone(e.type)}`);
    item.title = e.type;
    item.append(element('time', new Date(e.at).toLocaleString()), element('strong', eventLabel(e.type)), element('small', `#${e.seq}`));
    timeline.append(item);
  }
  const events = $('events'); events.replaceChildren();
  for (const e of run.events.slice(-60).reverse()) {
    const item = element('li', `${new Date(e.at).toLocaleTimeString()} · ${eventLabel(e.type)}`);
    item.title = e.type;
    events.append(item);
  }
  const reportedTokens = run.modelUsage?.tokens ?? run.calls.reduce((sum,c) => sum+(c.usage?.inputTokens ?? 0)+(c.usage?.outputTokens ?? 0),0);
  const budget = run.modelBudget ? ` · 预算 ${run.modelBudget.tokens === undefined ? '' : `${run.modelBudget.tokens} tokens`}${run.modelBudget.tokens !== undefined && run.modelBudget.moneyUsd !== undefined ? ' / ' : ''}${run.modelBudget.moneyUsd === undefined ? '' : `$${run.modelBudget.moneyUsd.toFixed(4)}`}` : '';
  const spent = run.modelUsage?.moneyUsd !== undefined ? ` · 目录价估算 $${run.modelUsage.moneyUsd.toFixed(4)}` : '';
  const external = run.externalUsage;
  const externalLimits = Object.entries(run.externalBudget ?? {}).map(([key, value]) => `${key}=${value}`).join(' / ');
  $('external-usage').textContent = external ? `外部执行：${external.calls} 次调用 · ${external.tokens} 已报告 tokens${external.moneyUsd === undefined ? '' : ` · 已报告 USD $${external.moneyUsd.toFixed(4)}`}${externalLimits ? ` · 阈值 ${externalLimits}` : ''}${external.unreportedTokenCalls ? ` · ${external.unreportedTokenCalls} 次 token 未报告` : ''}${external.unreportedMoneyCalls ? ` · ${external.unreportedMoneyCalls} 次 USD 未确认` : ''}` : '历史运行未汇总外部用量';
  $('usage').textContent = `${run.calls.length} 次模型请求 · ${reportedTokens} 已报告 tokens${spent}${budget}${run.modelUsage?.unreportedCalls ? ` · ${run.modelUsage.unreportedCalls} 次用量未确认` : ''}`;
}

function renderExplanation(explanation: RunExplanation): void {
  const panel = $('run-explanation');
  if (!panel) return;
  panel.replaceChildren();
  const attention = element('div', '', `explanation-attention ${explanation.attention.kind === 'none' ? 'clear' : 'needs-attention'}`);
  attention.append(element('strong', explanation.attention.kind === 'none' ? '当前没有待处理阻塞' : `需要关注：${explanation.attention.kind}`), element('span', explanation.attention.nextAction));
  for (const blocker of explanation.attention.blockers) attention.append(element('small', `${blocker.detail}${blocker.refs.length ? ` · ${blocker.refs.join(', ')}` : ''}`));
  panel.append(attention);
  const plan = element('div', '', 'explanation-grid');
  const task = explanation.plan.tasks;
  const planFact = element('div', '', 'fact-row');
  planFact.append(element('strong', '计划'), element('span', explanation.plan.version === undefined ? '尚未生成' : `v${explanation.plan.version} · ${task.total} 个任务`), element('small', `${task.succeeded} 已完成 · ${task.running} 执行中 · ${task.pending} 待处理`));
  plan.append(planFact);
  const execution = element('div', '', 'fact-row');
  const calls = explanation.execution.modelCalls;
  execution.append(element('strong', '执行'), element('span', `${calls.total} 次模型调用 · ${explanation.execution.eventCount} 条事件`), element('small', `Tool ${explanation.execution.tools.total} · Agent ${explanation.execution.delegations.total}`));
  plan.append(execution);
  const evidence = element('div', '', 'fact-row');
  evidence.append(element('strong', '证据'), element('span', `${explanation.evidence.sourceCount} 个来源 · ${explanation.evidence.artifactCount} 个产物 · ${explanation.evidence.receiptCount} 个回执`), element('small', `Evidence Graph ${explanation.evidence.evidenceNodeCount} 个节点`));
  if (explanation.evidence.contextManifestId) evidence.append(element('small', `Context Manifest：${explanation.evidence.contextManifestId}`));
  plan.append(evidence);
  const governance = element('div', '', 'fact-row');
  governance.append(element('strong', '治理冻结'));
  governance.append(element('span', explanation.governance.model ? `模型：${explanation.governance.model.provider ? `${explanation.governance.model.provider}/` : ''}${explanation.governance.model.model}` : '模型：未记录'));
  if (explanation.governance.skill) governance.append(element('small', `Skill：${explanation.governance.skill.methodId ?? '未命名'} ${explanation.governance.skill.version ?? ''}`));
  governance.append(element('small', `Tool ${explanation.governance.tools.length} 个 · Agent ${explanation.governance.agents.length} 个`));
  plan.append(governance);
  panel.append(plan);
  if (explanation.review) panel.append(element('p', `审核：${explanation.review.verdict} · ${explanation.review.summary}${explanation.review.confidence === undefined ? '' : ` · 置信度 ${(explanation.review.confidence * 100).toFixed(0)}%`}`, 'muted'));
}

function renderGovernance(run: RunView): void {
  const container = $('governance');
  container.replaceChildren();
  const skill = element('div', '', 'fact-row');
  skill.append(element('strong', 'Skill 治理'));
  if (run.skillSelection) {
    skill.append(element('span', `${run.skillSelection.methodId ?? '未命名方法'} · ${run.skillSelection.version ?? '未版本化'}`));
    if (run.skillRuntime) skill.append(element('small', `runtime：${run.skillRuntime}`));
    if (run.skillSelection.receiptRef) skill.append(element('small', `resolve receipt：${run.skillSelection.receiptRef}`));
    const skillDetails = element('details');
    skillDetails.append(element('summary', '查看冻结的 Skill plan'), element('pre', JSON.stringify(run.skillSelection.plan, null, 2)));
    skill.append(skillDetails);
    if (run.skillOutcome) skill.append(element('small', `结果：${run.skillOutcome.outcome}${run.skillOutcome.receiptRef ? ` · ${run.skillOutcome.receiptRef}` : ''}${run.skillOutcome.error ? ` · ${run.skillOutcome.error}` : ''}`));
  } else skill.append(element('span', '本次运行没有绑定外部 Skill 治理。', 'muted'));
  container.append(skill);

  const model = element('div', '', 'fact-row');
  model.append(element('strong', 'Model 决策'));
  if (run.modelDecision?.selected) {
    model.append(element('span', `${run.modelDecision.selected.provider ?? 'provider'} / ${run.modelDecision.selected.model ?? 'model'}`));
    if (run.modelDecision.catalogHash) model.append(element('small', `catalog hash：${run.modelDecision.catalogHash}`));
    if (run.modelDecision.catalogRetrievedAt) model.append(element('small', `目录读取：${new Date(run.modelDecision.catalogRetrievedAt).toLocaleString()}`));
    if (run.modelDecision.reason) model.append(element('small', run.modelDecision.reason));
  } else model.append(element('span', '固定模型或旧 Run 未保存目录决策。', 'muted'));
  container.append(model);

  const tools = element('div', '', 'fact-row');
  tools.append(element('strong', 'Tool 版本冻结'));
  if (run.approvedTools?.length) {
    tools.append(element('small', `manifest digest：${run.toolManifestDigest ?? '未记录'}`));
    for (const tool of run.approvedTools) tools.append(element('span', `${tool.id}@${tool.version} · ${tool.capabilities.join(', ')}`));
  } else tools.append(element('span', '本次运行没有获准的外部 Tool。', 'muted'));
  container.append(tools);
}

function memoryWritebackForm(run: RunView, artifact: RunView['artifacts'][number]): HTMLElement {
  const details = element('details', '', 'artifact-memory');
  details.append(element('summary', '保存为 Goal 记忆'));
  const form = element('form');
  const label = (text: string, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): void => {
    const wrapper = element('label', text); wrapper.append(control); form.append(wrapper);
  };
  const kind = element('select');
  for (const [value, text] of [['note', '笔记'], ['fact', '事实'], ['decision', '决策'], ['preference', '偏好']] as const) {
    const option = element('option', text); option.value = value; kind.append(option);
  }
  label('记忆类型', kind);
  const scope = element('select');
  for (const [value, text] of [['project', '项目'], ['session', '本次会话'], ['private', '私人']] as const) {
    const option = element('option', text); option.value = value; scope.append(option);
  }
  label('记忆范围', scope);
  const classification = element('select');
  for (const value of ['public', 'internal', 'confidential', 'private'] as const) {
    const option = element('option', value === run.privacy ? `${privacyLabel(value)}（本次运行）` : privacyLabel(value)); option.value = value; classification.append(option);
  }
  classification.value = run.privacy ?? 'internal';
  label('隐私分类', classification);
  const content = element('textarea'); content.rows = 4; content.required = true; content.maxLength = 30000; content.value = artifact.content;
  label('写入内容', content);
  form.append(element('small', `证据将绑定到 ${artifact.evidenceRefs.join(', ')}，来源 Run 为 ${run.id}。写入后会进入该 Goal 的下一次上下文检索。`));
  const submit = element('button', '保存记忆'); submit.type = 'submit';
  const status = element('p'); status.setAttribute('role', 'status'); form.append(submit, status);
  form.onsubmit = event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    submit.disabled = true; status.textContent = '正在保存…';
    void api(`/goals/${encodeURIComponent(run.goalId!)}/memories/from-run`, {
      runId: run.id, kind: kind.value, scope: scope.value, classification: classification.value,
      content: content.value.trim(), source: `artifact:${artifact.id}`, evidenceRefs: artifact.evidenceRefs,
    }).then(async () => { status.textContent = '已保存到 Goal 记忆。'; await refresh(); }).catch(error => { status.textContent = errorMessage(error); submit.disabled = false; });
  };
  details.append(form); return details;
}

function renderDeliverySummary(run: RunView): void {
  const messages: Record<string, string> = {
    queued: '已接收目标，等待开始规划。',
    planning: '正在把目标拆解为可审批的任务计划。',
    needs_approval: '计划已生成，等待你确认后执行。',
    running: 'Agent 正在推进任务；新的事件会自动出现在时间线。',
    reviewing: '任务已执行，正在进行独立审核。',
    needs_input: 'Agent 需要你的补充信息才能继续。',
    paused: '运行已暂停，可以在确认边界后继续。',
    waiting_external: '外部 Agent 已接收任务，等待带证据的回执。',
    unknown: '有一次外部调用结果不明确，需要先核查再继续。',
    succeeded: '本次目标已完成，下面是交付结果和证据。',
    failed: '运行未完成，可以查看原因并重试或重新规划。',
    cancelled: '运行已取消；已有产物和证据仍可查看。',
  };
  $('delivery-message').textContent = messages[run.status] ?? `当前状态：${runStatusLabel(run.status)}`;
  const metrics = $('delivery-metrics'); metrics.replaceChildren();
  const plan = run.plans.at(-1);
  const values = [
    ['状态', runStatusLabel(run.status)],
    ['计划', plan ? `v${plan.version}` : '尚未生成'],
    ['任务', `${run.steps.length} 个`],
    ['产物', `${run.artifacts.length} 个`],
    ['事件', `${run.events.length} 条`],
    ['审核', run.review?.verdict ?? '尚未审核'],
  ];
  for (const [label, value] of values) {
    const card = element('div', '', 'delivery-metric');
    card.append(element('small', label), element('strong', value)); metrics.append(card);
  }
  renderFollowUpPlan(run);
}

function renderFollowUpPlan(run: RunView): void {
  const box = $('follow-up-plan');
  box.replaceChildren();
  box.hidden = !run.followUpPlanId;
  if (!run.followUpPlanId) return;
  box.append(
    element('strong', '已生成后续计划'),
    element('small', `Plan ${run.followUpPlanId} · 下一步行动已从本次交付的证据中冻结`),
  );
  const status = element('p', '后续计划尚未展开。');
  const details = element('div', '', 'follow-up-plan-details');
  const open = button('查看后续任务', async () => {
    const plan = await api<DomainPlanSummary>(`/plans/${encodeURIComponent(run.followUpPlanId!)}/snapshot`);
    details.replaceChildren(
      element('p', `计划 v${plan.version} · ${plan.nodes.length} 个任务`),
      ...plan.nodes.map(node => {
        const row = element('div', '', 'follow-up-task');
        row.append(element('span', `${runStatusLabel(node.status)} · ${node.title}`));
        if (node.dependsOn.length) row.append(element('small', `依赖：${node.dependsOn.join(', ')}`));
        if (node.evidenceRefs?.length) row.append(element('small', `证据：${node.evidenceRefs.join(', ')}`));
        return row;
      }),
    );
    status.textContent = '后续任务已经从领域计划读取。可以在“长期目标”区域继续调度。';
    open.hidden = true;
  });
  box.append(status, open, details);
}

function isProjectPulseArtifact(value: unknown): value is ProjectPulseArtifact {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const sections = ['progress', 'completedChanges', 'blockers', 'risks', 'decisions', 'owners', 'deadlines', 'nextActions', 'unknowns'];
  return item.schemaVersion === 'project-pulse/1' && sections.every(section => Array.isArray(item[section]) && item[section].every(row => row && typeof row === 'object' && Array.isArray(row.evidenceRefs) && row.evidenceRefs.every((ref: unknown) => typeof ref === 'string')));
}

function appendProjectPulse(container: HTMLElement, pulse: ProjectPulseArtifact, run: RunView): void {
  const sectionLabels: Array<[keyof Omit<ProjectPulseArtifact, 'schemaVersion'>, string]> = [
    ['progress', '当前进展'], ['completedChanges', '已完成变更'], ['blockers', '阻塞'], ['risks', '风险'],
    ['decisions', '决策'], ['owners', '负责人'], ['deadlines', '截止日期'], ['nextActions', '下一步'], ['unknowns', '未知信息'],
  ];
  const panel = element('div', '', 'project-pulse');
  panel.append(element('strong', 'Project Pulse'));
  for (const [key, label] of sectionLabels) {
    const items = pulse[key];
    const group = element('section', '', 'pulse-group');
    group.append(element('h4', `${label} · ${items.length}`));
    if (!items.length) group.append(element('p', '暂无记录', 'muted'));
    for (const item of items) {
      const row = element('article', '', 'pulse-item');
      const copy = key === 'owners' ? `${item.name} · ${item.responsibility}` : key === 'deadlines' ? `${item.date} · ${item.text}` : String(item.text ?? '');
      row.append(element('span', copy || '结构化条目'));
      if (Array.isArray(item.evidenceRefs)) for (const ref of item.evidenceRefs) row.append(evidenceDetail(run, String(ref)));
      group.append(row);
    }
    panel.append(group);
  }
  container.append(element('small', '结构化产物 · project-pulse/1'), panel);
}

function renderPlanHistory(run: RunView): void {
  const container = $('plan-history'); container.replaceChildren();
  const comparisons = run.graphs?.planComparisons ?? [];
  if (comparisons.length === 0) return;
  const heading = element('h3', '计划版本差异');
  const note = element('p', '对比相邻版本的说明、任务、执行要求和依赖。展开后可查看修改前后的内容。', 'muted');
  container.append(heading, note);
  for (const comparison of comparisons) {
    const details = element('details');
    const count = comparison.changes.length + (comparison.summary ? 1 : 0);
    details.append(element('summary', `v${comparison.fromVersion} → v${comparison.toVersion} · ${count} 项变化`));
    const pair = (parent: HTMLElement, label: string, before: string, after: string): void => {
      parent.append(element('strong', label), element('small', '修改前'), element('pre', before), element('small', '修改后'), element('pre', after));
    };
    if (comparison.summary) pair(details, '计划说明', comparison.summary.before, comparison.summary.after);
    for (const change of comparison.changes) {
      const item = element('div', '', 'fact-row');
      item.append(element('strong', `${change.kind === 'added' ? '新增' : change.kind === 'removed' ? '移除' : '修改'}任务 · ${change.taskId}`));
      if (change.kind === 'modified' && change.before && change.after) {
        for (const field of change.fields) {
          const label = { title: '标题', instruction: '执行要求', dependsOn: '依赖' }[field];
          const display = (value: string | string[]) => Array.isArray(value) ? value.join('、') || '无' : value;
          pair(item, label, display(change.before[field]), display(change.after[field]));
        }
      } else {
        const node = change.after ?? change.before;
        if (node) item.append(element('p', node.title), element('pre', node.instruction), element('small', `依赖：${node.dependsOn.join('、') || '无'}`));
      }
      details.append(item);
    }
    if (!count) details.append(element('p', '计划说明、任务定义和依赖没有变化。', 'muted'));
    container.append(details);
  }
}

function timelineTone(type: string): 'success' | 'failure' | 'waiting' | 'neutral' {
  if (/succeed|complete|accepted|finished|artifact|review.accepted|goal.completed/i.test(type)) return 'success';
  if (/fail|error|reject|cancel|unknown|blocked/i.test(type)) return 'failure';
  if (/wait|pause|approval|question|input|reconcile/i.test(type)) return 'waiting';
  return 'neutral';
}

function renderGraphList(container: HTMLElement, graph: { nodes: GraphNodeView[]; edges: GraphEdgeView[] } | undefined, emptyText: string): void {
  container.replaceChildren();
  if (!graph || graph.nodes.length === 0) { container.append(element('p', emptyText, 'muted')); return; }
  const nodes = element('div', '', 'graph-list');
  for (const node of graph.nodes) {
    const row = element('div', '', `graph-item ${node.status ?? ''}`);
    row.append(element('strong', node.label), element('small', `${node.type} · ${node.id}${node.status ? ` · ${runStatusLabel(node.status)}` : ''}`));
    if (node.metadata && Object.keys(node.metadata).length) row.append(element('small', JSON.stringify(node.metadata)));
    nodes.append(row);
  }
  container.append(nodes);
  if (graph.edges.length) {
    const edges = element('details'); edges.append(element('summary', `${graph.edges.length} 条关系`));
    const list = element('ul');
    for (const edge of graph.edges) list.append(element('li', `${edge.from} → ${edge.to} · ${edge.type}`));
    edges.append(list); container.append(edges);
  }
}
($('reminder-status-filter') as HTMLSelectElement | null)?.addEventListener('change', event => {
  reminderStatusFilter = (event.target as HTMLSelectElement).value;
  void refresh().catch(error => message(errorMessage(error)));
});
($('reminders-more') as HTMLButtonElement | null)?.addEventListener('click', event => {
  const button = event.currentTarget as HTMLButtonElement; button.disabled = true;
  void loadMoreReminders().catch(error => message(errorMessage(error))).finally(() => { button.disabled = false; });
});
function updateReminderFields(): void {
  const repeat = $<HTMLSelectElement>('reminder-repeat').value;
  $('reminder-interval-fields').hidden = repeat !== 'interval';
  $('reminder-calendar-fields').hidden = !['daily', 'weekly', 'monthly'].includes(repeat);
  $('reminder-weekly-fields').hidden = repeat !== 'weekly';
  $('reminder-monthly-fields').hidden = repeat !== 'monthly';
}
$('reminder-repeat')?.addEventListener('change', updateReminderFields);
($('new-reminder') as HTMLFormElement | null)?.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const submit = form.querySelector('button') as HTMLButtonElement;
  submit.disabled = true; message('');
  void Promise.resolve().then(() => {
    const repeat = $<HTMLSelectElement>('reminder-repeat').value;
    const max = $<HTMLInputElement>('reminder-max-occurrences').value;
    const limit = max ? { maxOccurrences: Number(max) } : {};
    const recurrence = repeat === 'once' ? undefined : repeat === 'interval'
      ? { intervalMs: Number($<HTMLInputElement>('reminder-interval').value) * 60_000, ...limit }
      : { calendar: { frequency: repeat, timeZone: $<HTMLInputElement>('reminder-time-zone').value.trim(), time: $<HTMLInputElement>('reminder-local-time').value,
          ...(repeat === 'weekly' ? { daysOfWeek: $<HTMLInputElement>('reminder-weekdays').value.split(',').map(value => Number(value.trim())) } : {}),
          ...(repeat === 'monthly' ? { dayOfMonth: Number($<HTMLInputElement>('reminder-month-day').value) } : {}),
        }, ...limit };
    return api('/reminders', { title: $<HTMLInputElement>('reminder-title').value, message: $<HTMLTextAreaElement>('reminder-message').value, dueAt: new Date($<HTMLInputElement>('reminder-due-at').value).toISOString(), channel: $<HTMLInputElement>('reminder-channel').value, destination: $<HTMLInputElement>('reminder-destination').value, privacy: $<HTMLSelectElement>('reminder-privacy').value, ...(recurrence ? { recurrence } : {}) });
  }).then(async () => { form.reset(); updateReminderFields(); await refresh(); })
    .catch(error => message(errorMessage(error))).finally(() => { submit.disabled = false; });
});
$('new-run').onsubmit = event => {
  event.preventDefault(); const submit = $('submit') as HTMLButtonElement; submit.disabled = true; submit.classList.add('is-busy'); submit.setAttribute('aria-busy', 'true'); message('');
  const goalId = $<HTMLSelectElement>('goal-id').value;
  let quickRunOutcome = '';
  void Promise.resolve().then(() => api<{ id: string }>('/runs', { goal: $<HTMLTextAreaElement>('goal').value, ...(goalId ? { goalId } : {}), ...runOptions() }))
    .then(async result => {
      setCurrentRunOpen(true);
      currentId = result.id;
      current = undefined;
      localStorage.setItem('aeeis.run', currentId);
      quickRunOutcome = '已启动，正在生成计划…';
      await refresh();
      window.requestAnimationFrame(() => $('run-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    })
    .catch(error => { quickRunOutcome = '启动失败，请检查输入'; message(errorMessage(error)); })
    .finally(() => { submit.disabled = false; submit.classList.remove('is-busy'); submit.removeAttribute('aria-busy'); setQuickRunBusy(false, quickRunOutcome); });
};
$('answer-form').onsubmit = event => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const submit = form.querySelector('button') as HTMLButtonElement;
  const answer = $<HTMLTextAreaElement>('answer').value.trim();
  if (!answer) return;
  submit.disabled = true;
  submit.classList.add('is-busy');
  submit.setAttribute('aria-busy', 'true');
  message('');
  const action = inputPanelMode === 'answer' ? 'answer' : inputPanelMode === 'reconcile-cancelled' ? 'reconcile-cancelled' : 'reconcile';
  void command(action, inputPanelMode === 'answer' ? { answer } : { reason: answer })
    .then(() => { $<HTMLTextAreaElement>('answer').value = ''; })
    .catch(error => message(errorMessage(error)))
    .finally(() => { submit.disabled = false; submit.classList.remove('is-busy'); submit.removeAttribute('aria-busy'); });
};
$('connect').onclick = () => {
  const token = $<HTMLInputElement>('token').value;
  if (token) sessionStorage.setItem('aeeis.token', token); else sessionStorage.removeItem('aeeis.token');
  const connect = $('connect') as HTMLButtonElement;
  connect.disabled = true;
  connect.classList.add('is-busy');
  setSystemSignal('loading');
  void initialize().finally(() => { connect.disabled = false; connect.classList.remove('is-busy'); });
};
async function initialize(): Promise<void> {
  try {
    const status = await api<RuntimeStatus>('/status');
    const mode = $('instance-mode');
    const modeLabels: Record<string, string> = { 'single-owner-local': '开发版 · 单用户本地模式', 'static-principal-scoped': '开发版 · Principal / Tenant 隔离', 'oidc-principal-scoped': '开发版 · OIDC Principal / Tenant 隔离', 'principal-scoped': '开发版 · Principal / Tenant 隔离' };
    mode.textContent = modeLabels[status.mode] ?? `开发版 · ${status.mode}`;
    mode.dataset.state = status.modelConfigured && status.modelHealth?.ready !== false ? 'ready' : 'attention';
    mode.title = status.principal ? `当前身份：${status.principal} · 租户：${status.tenantId ?? 'default'} · 角色：${(status.roles ?? []).join(', ') || '未声明'}` : '';
    renderRuntimeStatus(status);
    const profile = status.executionProfile === 'fixture' ? '当前为 Fixture 演示环境：流程可验证，但结果不代表真实模型能力。' : '当前依赖被标记为未验证；请确认已接入真实模型和生产治理服务。';
    const fullConfiguration = status.modelConfigured
      ? `${profile} ${status.model ? `${status.model.model} · ${status.runner}` : `模型目录路由 · ${status.runner}`}。${status.modelHealth?.ready === false ? `模型探测失败：${status.modelHealth.detail ?? '未知原因'}。` : ''}${status.skillGovernanceConfigured && status.skillGovernanceHealth?.ready === false ? ` OwnHow 探测失败：${status.skillGovernanceHealth.detail ?? '未知原因'}。` : ''}${status.knowledgeConfigured ? 'Knowledge 已启用；' : ''}${status.evolutionConfigured ? 'RSI 候选存储已启用；' : ''}${status.collaborationConfigured ? '协作平面已启用。' : ''}`
      : '尚未配置模型。请在服务端设置 AEEIS_MODEL_BASE_URL、AEEIS_MODEL，或配置 AEEIS_PLANPRICE_URL 后重启；Knowledge、RSI 和协作状态仍可查看，但不会生成模拟结果。';
    const minimalConfiguration = status.modelConfigured
      ? `已连接 · ${status.model ? `${status.model.model} · ${status.runner}` : '模型目录路由'}`
      : '模型尚未连接；点击“连接模型”打开运行配置。';
    const configuration = $('configuration');
    configuration.dataset.fullText = fullConfiguration;
    configuration.dataset.minimalText = minimalConfiguration;
    syncConfigurationNotice();
    const configAction = $('config-action') as HTMLButtonElement | null;
    if (configAction) {
      configAction.hidden = status.modelConfigured && status.modelHealth?.ready !== false;
      configAction.textContent = status.modelConfigured ? '检查运行配置' : '打开运行配置';
    }
    evolutionConfigured = status.evolutionConfigured;
    modelConfigured = status.modelConfigured;
    taskSchedulerConfigured = status.taskSchedulerConfigured;
    quickRunReady = status.modelConfigured && status.modelHealth?.ready !== false;
    syncConfigurationNotice();
    syncDetailsToggleLabel();
    setSystemSignal(quickRunReady ? 'connected' : 'attention');
    ($('submit') as HTMLButtonElement).disabled = !quickRunReady;
    const quickSubmit = document.querySelector<HTMLButtonElement>('#quick-run button[type="submit"]');
    if (quickSubmit) {
      quickSubmit.disabled = !quickRunReady;
      quickSubmit.title = quickRunReady ? '启动任务' : '请先连接模型';
      const label = quickSubmit.querySelector('span');
      if (!quickRunReady) quickSubmit.childNodes[0]!.textContent = '等待连接 ';
      else if (label) quickSubmit.childNodes[0]!.textContent = '启动任务 ';
    }
    await refresh(); message('');
    if (minimalMode && !currentId) window.requestAnimationFrame(() => {
      if (quickRunReady) $<HTMLInputElement>('quick-goal').focus();
      else ($('details-toggle') as HTMLButtonElement | null)?.focus();
    });
  } catch (e) {
    modelConfigured = false;
    quickRunReady = false;
    syncDetailsToggleLabel();
    ($('submit') as HTMLButtonElement | null)?.setAttribute('disabled', 'true');
    const quickSubmit = document.querySelector<HTMLButtonElement>('#quick-run button[type="submit"]');
    if (quickSubmit) {
      quickSubmit.disabled = true;
      quickSubmit.title = '运行服务暂时不可用';
      quickSubmit.childNodes[0]!.textContent = '等待连接 ';
    }
    const configAction = $('config-action') as HTMLButtonElement | null;
    if (configAction) { configAction.hidden = false; configAction.textContent = '检查运行配置'; }
    setSystemSignal('offline');
    const mode = $('instance-mode');
    if (mode) { mode.dataset.state = 'offline'; mode.textContent = '运行服务不可达'; }
    message(errorMessage(e));
  }
}
void initialize();
setInterval(() => { if (polling || document.hidden) return; polling = true; void refresh().catch(error => message(errorMessage(error))).finally(() => { polling = false; }); }, 2000);
window.setInterval(() => {
  if (!document.hidden && current && !DONE_STATUSES.has(current.status)) updateRunActivity(current);
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !currentId || polling) return;
  polling = true;
  void refresh().catch(error => message(errorMessage(error))).finally(() => { polling = false; });
});
window.addEventListener('offline', () => { setLiveConnection('offline'); setSystemSignal('offline'); });
window.addEventListener('online', () => {
  setSystemSignal('loading');
  void initialize();
});

function evidenceDetail(run: RunView, ref: string): HTMLElement {
  const source = run.context?.sources.find(item => item.id === ref);
  const artifact = run.artifacts.find(item => item.id === ref);
  const box = element('details', '', 'pulse-evidence');
  box.append(element('summary', source?.title ?? artifact?.title ?? `证据 ${ref}`));
  box.append(element('small', ref), element('pre', source?.content ?? artifact?.content ?? '调用回执可在本次运行的证据图和外部调用记录中核查。'));
  return box;
}

function correctionForm(run: RunView, artifact: RunView['artifacts'][number]): HTMLElement {
  const details = element('details', '', 'artifact-correction');
  details.append(element('summary', '提出改进建议'));
  const form = element('form');
  const label = (text: string, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => {
    const wrapper = element('label', text); wrapper.append(control); form.append(wrapper);
  };
  const target = element('select');
  for (const [value, text] of [['profile', '个人偏好'], ['prompt', '工作方法']] as const) {
    const option = element('option', text); option.value = value; target.append(option);
  }
  label('希望改进什么', target);
  const base = element('input'); base.readOnly = true;
  const updateBase = () => { base.value = run.evolution?.find(item => item.target === target.value)?.version ?? `${target.value}/1`; };
  target.onchange = updateBase; updateBase(); label('本次运行使用的版本', base);
  const reason = element('textarea'); reason.required = true; reason.maxLength = 4000; reason.rows = 3;
  reason.placeholder = '这份结果哪里需要改进？'; label('问题与原因', reason);
  const change = element('textarea'); change.required = true; change.maxLength = 8000; change.rows = 3;
  change.placeholder = '例如：先列出阻塞和下一步，再提供详细背景。'; label('以后应该怎样做', change);
  const risk = element('select');
  for (const [value, text] of [['medium', '中：影响工作方式'], ['low', '低：仅格式和措辞偏好'], ['high', '高：需要更严格评估']] as const) {
    const option = element('option', text); option.value = value; risk.append(option);
  }
  label('影响范围', risk);
  form.append(element('small', '绑定当前产物作为证据。提交后生成候选，须经过评测、审批和激活才会影响后续运行。'));
  const status = element('p'); status.setAttribute('role', 'status');
  const submit = element('button', '提交改进候选'); submit.type = 'submit'; form.append(submit, status);
  form.onsubmit = event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    const proposedVersion = `${target.value}/${crypto.randomUUID()}`;
    submit.disabled = true; status.textContent = '正在保存…';
    void api<{ candidate: EvolutionView }>(`/runs/${encodeURIComponent(run.id)}/corrections`, {
      target: target.value, baseVersion: base.value, proposedVersion, change: change.value.trim(), reason: reason.value.trim(), risk: risk.value,
      sourceReceiptRefs: [artifact.id],
    }).then(async result => {
      selectedCandidateId = result.candidate.id; localStorage.setItem('aeeis.candidate', result.candidate.id);
      form.replaceChildren(element('p', '改进候选已保存，等待评测。')); await refresh();
    }).catch(error => { status.textContent = errorMessage(error); submit.disabled = false; });
  };
  details.append(form); return details;
}
