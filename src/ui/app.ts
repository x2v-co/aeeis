import type { PlanComparison } from '../runtime/graphs.js';
import { planningDecision, planningRefusal } from '../runtime/planning-shape.js';
import { conversationTaskOrder } from '../conversations.js';
import { planReview } from './plan-review.js';
import { artifactDownloadLink, releaseArtifactDownloads, renderArtifactMarkdown } from './artifact-markdown.js';
import { isFillablePdfArtifact, renderFillablePdf } from './fillable-pdf.js';

window.addEventListener('pagehide', releaseArtifactDownloads);

interface RunSummary { id: string; goal: string; goalId?: string; domainPlanId?: string; followUpPlanId?: string; taskExecution?: { domainPlanId: string; taskId: string }; status: string; updatedAt?: string; threadId?: string; parentRunId?: string; threadSequence?: number }
interface ThreadRun extends RunSummary { threadSequence: number; privacy?: string; outputExcerpt?: string }
interface ThreadPage { id: string; title?: string; runs: ThreadRun[]; nextAfterSequence?: number }
interface ThreadShareView { kind: 'thread'; thread: { id: string; title?: string }; throughSequence: number; runs: Array<RunView & { explanation: RunExplanation }> }
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
  workingMemoryEnabled?: boolean;
  canEdit?: boolean;
  evolution?: Array<{ target: string; version: string }>;
  corrections?: Array<{ id: string; text: string; candidateId: string; sourceRefs: string[]; createdAt: string }>;
  revision: number; goalId?: string; domainPlanId?: string; followUpPlanId?: string; taskExecution?: { domainPlanId: string; taskId: string; requestHash?: string };
  privacy?: string; skillRuntime?: string; skillSelection?: { methodId?: string; version?: string; plan: unknown; receiptRef?: string }; skillOutcome?: { outcome: 'success' | 'failure'; receiptRef?: string; error?: string }; approvedTools?: Array<{ id: string; version: string; capabilities: string[]; description?: string }>; toolManifestDigest?: string; resourceSnapshot?: { plugin?: { id: string; version: string; interface: string; digest: string; channel?: string }; skill?: { id: string; version: string; interface: string; digest: string; channel?: string }; workflow?: { id: string; version: string; interface: string; digest: string; channel?: string }; tools?: Array<{ id: string; version: string; interface: string; digest: string; channel?: string }>; lockfileDigest: string; policyDigest: string; resolvedAt: string; resolverVersion: string }; modelDecision?: { selected?: { model?: string; provider?: string }; catalogHash?: string; catalogRetrievedAt?: string; reason?: string }; context?: { id?: string; manifestHash?: string; memoryManifestId?: string; memoryManifestHash?: string; memoryRefs?: string[]; sources: Array<{ id: string; title: string; content: string; source: string; hash: string; contentHash?: string; kind?: string; untrusted?: boolean; classification?: string; origin?: { runId: string; ref: string } }> };
  plans: Array<{ hash: string; version: number; summary: string; author?: { type: 'user' | 'model' | 'policy' }; nodes: Array<{ id: string; title: string; instruction?: string; evidenceRequirements?: string; dependsOn: string[]; evidenceRefs?: string[]; evidenceRunId?: string }> }>;
  steps: Array<{ taskId: string; status: string; error?: string; failureReason?: string }>;
  artifacts: Array<{ id: string; title: string; content: string; evidenceRefs: string[]; artifactType?: string; structured?: unknown }>;
  model?: { model?: string; provider?: string; endpoint?: string; promptVersion?: string; routingMode?: string };
  events: Array<{ seq: number; type: string; at: string; data?: { phase?: string; reason?: string; validation?: { issues?: Array<{ path?: string; message?: string }> } } }>;
  calls: Array<{ phase: string; state: string; usage?: { inputTokens: number; outputTokens: number } }>;
  modelBudget?: { tokens?: number; moneyUsd?: number }; modelUsage?: { tokens: number; moneyUsd?: number; unreportedCalls: number };
  evolutionTraffic?: Array<{ routeId: string; target: string; candidateId: string; percentage: number; bucket: number; selected: boolean }>;
  externalBudget?: { calls?: number; tokens?: number; moneyUsd?: number };
  externalUsage?: { calls: number; tokens: number; moneyUsd?: number; unreportedTokenCalls: number; unreportedMoneyCalls: number };
  question?: { text: string }; error?: string;
  toolReceipts?: Array<{ receiptId: string; operation: string; provider: string; status: string; errorCode?: string; cost?: { credits?: number }; costStatus?: 'reported' | 'unreported' | 'interrupted'; authorization?: { decision: 'authorized' | 'isolated'; reason: string } }>;
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
interface ConversationTaskView { id: string; threadId: string; title: string; latestRunId?: string; runId?: string; pendingMessageId?: string; priority?: number; status: string; memory?: { originals: number; activeSummaries: number }; pendingApproval?: { planVersion: number; planHash: string; summary: string }; pendingQuestion?: { text: string } }
interface ConversationMessageView {
  id: string; role: 'user' | 'notification'; speaker?: { role: 'user' | 'agent'; id: string }; text: string; createdAt: string; replyTo?: string; notificationRunId?: string;
  correctsMessageId?: string; effectiveTaskIds?: string[];
  route: { status: 'routed' | 'clarify' | 'general'; reason: string; taskIds: string[]; candidateTaskIds: string[]; focusEffect: 'keep' | 'switch' };
  execution?: { runId: string; taskId: string; state: string };
}
interface ConversationSummary { id: string; title: string; revision: number; focusTaskId?: string; taskCount?: number; agentId?: string; standingInstruction?: string }
interface LastDelivery { taskId: string; taskTitle: string; runId: string; planSummary?: string; artifactTitles?: string[] }
interface AcceptedPractice { claimId: string; text: string; runId: string; evidenceRefs: string[] }
interface SkillProfileView { claimId: string; taskKind: string; methodId: string; version: string; runId: string; evidenceRefs: string[] }
interface TaskModelView { claimId: string; taskKind: string; model: string; provider?: string }
interface TaskKindComparison {
  taskKind: string; runId: string; taskTitle: string;
  methodId?: string; version?: string; model?: string; provider?: string;
  profileMethodId?: string; profileVersion?: string; profileRunId?: string; profileModel?: string; profileProvider?: string;
  differs: boolean; kept: boolean;
  proposal?: { candidateId: string; status: string };
}
interface TaskSettingsView { skills: SkillProfileView[]; models: TaskModelView[]; comparisons?: TaskKindComparison[] }
interface ConversationView extends ConversationSummary { tasks: ConversationTaskView[]; messages: ConversationMessageView[]; hasEarlierMessages?: boolean; lastDelivery?: LastDelivery; acceptedPractice?: AcceptedPractice; taskSettings?: TaskSettingsView }
interface ConversationAttempt { conversationId: string; scope: string; key: string; body: string }
interface ConversationPost { conversation: ConversationView; message: ConversationMessageView; response: string; runId?: string }
interface RuntimeStatus {
  conversationRouting?: boolean;
  executionProfile?: 'fixture' | 'unverified'; modelConfigured: boolean; model?: { model: string; endpoint: string } | null; modelRouting: string; runner: string;
  modelHealth?: { ready: boolean; detail?: string; catalog?: { ready: boolean; detail?: string }; provider?: { ready: boolean; detail?: string } }; skillGovernanceHealth?: { ready: boolean; detail?: string };
  rsiEvaluatorHealth?: { ready: boolean; detail?: string } | null;
  dispatcherHealth?: { ready: boolean; detail?: string } | null; knowledgeConfigured: boolean; brainSemanticSearchConfigured: boolean; brainSemanticIndexHealth?: { ready: boolean; detail?: string } | null;
  toolsConfigured: boolean; toolsHealth?: { ready: boolean; detail?: string } | null;
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
const shareToken = window.location.pathname.match(/^\/share\/([A-Za-z0-9_-]{43})\/?$/)?.[1];
const linkedRunId = window.location.pathname.match(/^\/runs\/(run_[a-f0-9-]{36})\/?$/)?.[1];
const linkedThreadId = window.location.pathname.match(/^\/threads\/(thread_[a-f0-9-]{36})\/?$/)?.[1];
const readOnlyShare = Boolean(shareToken);
document.body.classList.toggle('shared-run', readOnlyShare);
let currentId = linkedRunId ?? (readOnlyShare || linkedThreadId ? '' : localStorage.getItem('aeeis.run') ?? '');
document.body.classList.toggle('thread-page', Boolean(linkedThreadId));
let threadPagesAfter = [0];
let threadNextAfter: number | undefined;
let threadRuns: ThreadRun[] = [];
let pendingFollowup: { key: string; body: unknown; signature: string } | undefined;
let followupSubmitting = false;
let conversationEnabled = false;
let conversationScope = '';
let conversationEpoch = 0;
let conversation: ConversationView | undefined;
let conversationList: ConversationSummary[] = [];
let conversationBusy = false;
let conversationRefreshing = false;
let conversationNeedsRefresh = false;
let conversationReplyId: string | undefined;
let conversationCorrectionId: string | undefined;
let conversationAttempt: ConversationAttempt | undefined;
let conversationRenderSignature = '';
let standingBoundId = '';
let practiceBoundRunId = '';
const CONVERSATION_SELECTION = 'aeeis.conversation';
const CONVERSATION_SCOPE = 'aeeis.conversation-scope';
const CONVERSATION_PENDING = 'aeeis.conversation-pending';
const LIFE_HOME = 'aeeis.life.aeeis';
let aeeisConversationId = linkedRunId || linkedThreadId || readOnlyShare ? '' : (localStorage.getItem(LIFE_HOME) ?? '');
const lifeOpening = new Set<string>();
let selectedCandidateId = localStorage.getItem('aeeis.candidate') ?? '';
let current: RunView | undefined;
type InputPanelMode = 'answer' | 'reconcile' | 'reconcile-cancelled';
let inputPanelMode: InputPanelMode = 'answer';
let cancelArmedRunId = '';
const minimalMode = !readOnlyShare && !linkedThreadId && localStorage.getItem('aeeis.minimal-mode') !== '0';
document.body.classList.toggle('minimal-mode', minimalMode);
let quickRunReady = false;
let intentPresetsOpen = false;
let recentRunsOpen = false;
let attentionInboxOpen = false;
let currentRunOpen = !minimalMode;
let polling = false;
let goalViewSignature = '';
let modelConfigured = false;
let runtimeModel = '';
let taskModelBound = '';
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
interface BotGroups { groups: Array<{ id: string; name: string }>; placement: Record<string, string> }
interface RosterBot { id: string; name: string; note: string; demo: boolean }
const DEMO_BOTS: RosterBot[] = [
  { id: 'demo.release', name: '发布', note: '对照发布清单', demo: true },
  { id: 'demo.research', name: '研究', note: '整理公开资料', demo: true },
  { id: 'demo.brief', name: '纪要', note: '把讨论收成纪要', demo: true },
];
let agentSummaries: AgentSummary[] = [];
let agentsLoaded = false;
let roomSummaries: RoomSummary[] = [];
let botGroups: BotGroups | undefined;
let selectedBotId = linkedRunId || linkedThreadId || readOnlyShare ? 'aeeis' : (localStorage.getItem('aeeis.bot') || 'aeeis');
let openGroupId = '';
let groupDraftOpen = false;
let groupMembers: RoomMemberSummary[] = [];
let groupEvents: SessionEventSummary[] = [];
const draftAgents = new Set<string>();
let draftPeople: string[] = [];
const directMembers = new Map<string, string>();
const directOpening = new Set<string>();
let directIndexKey = '';
let directIndexPromise: Promise<void> = Promise.resolve();
let timelineFilter = localStorage.getItem('aeeis.timeline-filter') ?? 'all';
const MAX_MATERIAL_FILES = 8;
const MAX_MATERIAL_FILE_BYTES = 1_000_000;
const MAX_MATERIAL_CONTENT_LENGTH = 30_000;
let materialFilesLoading = false;
let selectedMaterialFiles: Array<{ name: string; content: string; size: number }> = [];
let materialFileReadSequence = 0;
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
    'plan.budgets_updated': '预算已更新', 'plan.proposed': '计划已生成', 'plan.approved': '计划已批准', 'plan.revised': '计划已更新',
    'plan.auto_approved': '计划已按审核档自动放行', 'plan.approval_requested': '模型请求批准',
    'model.selected': '模型已选择', 'model.started': '模型开始调用', 'model.completed': '模型调用完成', 'model.usage.recorded': '模型用量已记录',
    'skill.selected': '工作方式已选择', 'skill.completed': '工作方式已完成',
    'tool.requested': '等待工具回执', 'tool.completed': '工具已返回', 'tool.failed': '工具调用失败', 'tool.unknown': '工具结果待核查', 'tool.reconciled': '工具结果已核查',
    'agent.requested': '已请求外部 Agent', 'agent.progress': '外部 Agent 有进展', 'agent.completed': '外部 Agent 已完成', 'agent.failed': '外部 Agent 调用失败', 'agent.unknown': '外部 Agent 结果待核查',
    'external.usage.recorded': '外部用量已记录', 'external.usage_recorded': '外部用量已记录', 'external.budget_stopped': '外部预算已停止',
    'model.usage_recorded': '模型用量已记录',
    'input.requested': '等待补充信息', 'input.received': '已收到补充信息', 'review.requested': '开始独立审核', 'review.completed': '审核完成',
    'plan.repair_requested': '计划格式修复中', 'plan.revision_requested': '已请求修改计划', 'run.paused': '运行已暂停', 'run.resumed': '运行已继续',
    'run.retry_requested': '已请求重试', 'run.reconciled': '状态已对齐', 'run.interrupted': '运行中断', 'run.cancel.workflow_failed': '取消后台任务失败',
    'run.cancelled_reconcile_requested': '已请求核查取消前的调用', 'run.cancelled_reconcile_failed': '取消前的调用核查失败', 'artifact.created': '产物已生成',
    'model.unknown': '模型结果待核查', 'model.reconciled': '模型结果已核查', 'model.validation_failed': '模型输出校验失败', 'model.budget_stopped': '模型预算已停止',
    'task.execution.started': '任务开始执行', 'task.execution.completed': '任务执行完成', 'task.execution.failed': '任务执行失败',
    'context.summary_active': '压缩摘要已写入', 'context.summary_rejected': '压缩摘要未采用',
    'context.summary_discarded': '压缩摘要已丢弃', 'context.summary_failed': '压缩摘要未生成',
  };
  const normalized = type.trim().replace(/\s+/g, '.');
  return labels[type] ?? labels[normalized] ?? normalized.replace(/^run\./, '').replace(/[._-]+/g, ' ');
}
function describeEvent(type: string, data?: { phase?: string; reason?: string; source?: string; actor?: string }, verbose = false): string {
  if (type === 'plan.proposed' && data?.source === 'direct') return '直接计划已写入';
  if (type === 'plan.auto_approved' && data?.actor === 'policy:direct') return '直接计划已按边界放行';
  const compaction = data?.phase === 'compaction' || (typeof data?.reason === 'string' && data.reason.startsWith('compaction'));
  if (compaction) {
    const short: Record<string, string> = {
      'model.started': '整理任务记忆', 'model.completed': '记忆整理完成', 'model.failed': '记忆整理失败',
      'model.unknown': '记忆整理待核查', 'model.result_discarded': '记忆整理已丢弃',
    };
    const full: Record<string, string> = {
      'model.started': '开始整理任务记忆（摘要不是证据）', 'model.completed': '任务记忆整理完成（摘要不是证据）',
      'model.failed': '任务记忆整理失败（未写入摘要）', 'model.unknown': '任务记忆整理结果待核查（未写入摘要）',
      'model.result_discarded': '过期的任务记忆整理已丢弃（不是证据）',
    };
    if (short[type]) return verbose ? full[type]! : short[type]!;
  }
  if (verbose && type.startsWith('context.summary_')) {
    const full: Record<string, string> = {
      'context.summary_active': '已写入压缩摘要（不是证据，不改变讨论焦点）',
      'context.summary_rejected': '压缩摘要未采用（不是证据）',
      'context.summary_discarded': '压缩摘要已丢弃（不是证据）',
      'context.summary_failed': '压缩摘要未生成（不是证据）',
    };
    if (full[type]) return full[type];
  }
  return eventLabel(type);
}
function compactionProgress(event: { type: string; data?: { phase?: string; reason?: string } } | undefined): [string, string] | undefined {
  if (!event) return;
  const compaction = event.data?.phase === 'compaction' || (typeof event.data?.reason === 'string' && event.data.reason.startsWith('compaction')) || event.type.startsWith('context.summary_');
  if (!compaction) return;
  const detail = '压缩摘要只留给该任务后续引用。它不是证据，也不改变讨论焦点。';
  if (event.type === 'context.summary_active' || event.type === 'model.completed') return ['已整理任务记忆', detail];
  if (event.type === 'model.started') return ['正在整理任务记忆', detail];
  return ['任务记忆未写入', detail];
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
  document.body.classList.toggle('run-open', enabled && Boolean(current || currentId));
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
  control.textContent = detailsMode ? '收起设置' : quickRunReady ? '更多设置' : authRequired ? '输入令牌' : '连接模型';
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
    if (conversationEnabled) $<HTMLTextAreaElement>('conversation-text').focus();
    else $<HTMLInputElement>('quick-goal').focus();
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
class ApiError extends Error { constructor(message: string, readonly status: number, readonly retrySameRequest = false) { super(message); } }
async function api<T>(path: string, body?: unknown, method?: 'GET' | 'POST' | 'PATCH' | 'DELETE', idempotencyKey?: string): Promise<T> {
  if (readOnlyShare && (path !== `/share/${shareToken}` || body !== undefined || (method && method !== 'GET'))) throw new Error('Shared runs are read-only');
  const token = readOnlyShare ? null : sessionStorage.getItem('aeeis.token');
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  if (!readOnlyShare && token !== sessionStorage.getItem('aeeis.token')) throw new Error('身份已更改，请重新连接');
  let value: (T & { error?: string; retrySameRequest?: unknown }) | undefined;
  if (raw.trim()) {
    try { value = JSON.parse(raw) as T & { error?: string; retrySameRequest?: unknown }; }
    catch {
      if (!response.ok) {
        const fallback = raw.replace(/\s+/g, ' ').trim();
        throw new ApiError(fallback && !fallback.startsWith('<') ? fallback.slice(0, 240) : `运行服务暂时不可用（HTTP ${response.status}）`, response.status);
      }
    }
  }
  if (!response.ok) throw new ApiError(value?.error ?? `运行服务请求失败（HTTP ${response.status}）`, response.status, value?.retrySameRequest === true);
  return (value ?? {}) as T;
}
let authRequired = false;
const SERVER_ERROR_LABELS: Record<string, string> = {
  'Local access token required': '需要访问令牌：点击“输入令牌”，填写本地访问令牌后连接。',
  'Invalid local access token': '访问令牌无效，请重新输入。',
  'Shared runs are read-only': '只读分享页不能执行操作。',
};
function errorMessage(error: unknown): string {
  const text = error instanceof Error && error.message ? error.message : String(error || '运行服务暂时不可用');
  if (/access token/i.test(text)) { authRequired = true; syncDetailsToggleLabel(); }
  return SERVER_ERROR_LABELS[text] ?? text;
}
function formatTime(value: string | number | Date): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}
const REVIEW_VERDICT_LABELS: Record<string, string> = { accepted: '通过', revise: '需修改', rejected: '未通过', needs_revision: '需修改' };
// Keep the raw verdict next to non-passing labels so operators can grep logs and debug bundles for it.
function reviewVerdictLabel(verdict: string): string { const label = REVIEW_VERDICT_LABELS[verdict]; return !label ? verdict : verdict === 'accepted' ? label : `${label}（${verdict}）`; }
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
function dashboardButton(label: string, action: () => Promise<void>): HTMLButtonElement {
  const control = element('button', label); control.type = 'button';
  control.addEventListener('click', () => { if (!control.disabled) void action(); });
  return control;
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
function resetConversation(clearStorage = true): void {
  conversationEpoch++; conversation = undefined; conversationList = []; conversationAttempt = undefined;
  conversationReplyId = undefined; conversationCorrectionId = undefined; conversationBusy = false; conversationRefreshing = false; conversationNeedsRefresh = false; conversationRenderSignature = '';
  $('conversation-messages').replaceChildren(); $('conversation-tasks').replaceChildren();
  $<HTMLFormElement>('conversation-composer').reset();
  $('conversation-status').textContent = ''; $('conversation-error').textContent = ''; $('conversation-reply-label').textContent = ''; $('conversation-correction-label').textContent = '';
  $('working-memory-content').replaceChildren(); delete $('working-memory-content').dataset.signature; $('working-memory-panel').hidden = true;
  if (clearStorage) {
    localStorage.removeItem(CONVERSATION_SELECTION); localStorage.removeItem(CONVERSATION_SCOPE); localStorage.removeItem(LIFE_HOME); sessionStorage.removeItem(CONVERSATION_PENDING);
    aeeisConversationId = '';
  }
  renderConversation();
}
function saveConversationAttempt(): void {
  if (conversationAttempt) sessionStorage.setItem(CONVERSATION_PENDING, JSON.stringify(conversationAttempt));
  else sessionStorage.removeItem(CONVERSATION_PENDING);
}
function conversationTaskName(id: string): string { return conversation?.tasks.find(task => task.id === id)?.title ?? id; }
function conversationTargetTask(): ConversationTaskView | undefined {
  const target = $<HTMLSelectElement>('conversation-target').value;
  const reply = conversation?.messages.find(item => item.id === conversationReplyId);
  const replyTasks = reply?.effectiveTaskIds ?? reply?.route.taskIds;
  const id = target || (replyTasks?.length === 1 ? replyTasks[0] : reply ? undefined : conversation?.focusTaskId);
  return conversation?.tasks.find(task => task.id === id);
}
function openConversationRoute(): void {
  const route = document.querySelector<HTMLDetailsElement>('#conversation-route');
  if (route) route.open = true;
}
function updateConversationControls(): void {
  const locked = conversationBusy || Boolean(conversationAttempt);
  const target = $<HTMLSelectElement>('conversation-target').value;
  const task = conversationTargetTask();
  const preparing = Boolean(task && task.status === 'preparing' && !task.runId && !task.latestRunId);
  const active = task && !preparing && (task.pendingMessageId || !['discussion', 'succeeded', 'failed', 'cancelled'].includes(task.status));
  $('conversation-panel').setAttribute('aria-busy', String(conversationBusy));
  $('conversation-new-task-fields').hidden = target !== '__new';
  $<HTMLInputElement>('conversation-task-title').required = target === '__new';
  $('conversation-reply').hidden = !conversationReplyId;
  $('conversation-retry-panel').hidden = !conversationAttempt;
  $<HTMLButtonElement>('conversation-retry').disabled = conversationBusy;
  $('conversation-composer').querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input, button, select, textarea').forEach(control => { control.disabled = locked || !conversation; });
  const correcting = Boolean(conversationCorrectionId);
  $('conversation-correction').hidden = !correcting;
  $<HTMLTextAreaElement>('conversation-text').readOnly = correcting;
  $<HTMLSelectElement>('conversation-focus-effect').disabled ||= correcting;
  for (const option of $<HTMLSelectElement>('conversation-target').options) option.disabled = correcting && (!option.value || option.value === '__new');
  $<HTMLButtonElement>('conversation-send').textContent = correcting ? '保存归属纠正' : '发送讨论';
  $<HTMLButtonElement>('conversation-send').disabled = locked || !conversation || conversationNeedsRefresh || (correcting && !conversation?.tasks.some(task => task.id === target));
  $<HTMLButtonElement>('conversation-execute').disabled = locked || !conversation || conversationNeedsRefresh || !quickRunReady || Boolean(active) || preparing || correcting;
  restoreExecutionReview();
  $('conversation-execution-note').textContent = correcting ? '请明确选择任务。纠正以新记录追加，仅影响后续消息和新执行上下文；已有执行记录不变，不启动执行，也不切换焦点。' : preparing ? '执行尚未创建。请等待回执；确认失败后再重新发送。' : active ? '此任务已有未结束的 Run。请查看运行，使用原有的批准、回答或取消控件。' : !quickRunReady ? '模型尚未就绪；可以记录讨论，但不能创建执行。' : executionReviewNote();
  for (const id of ['conversation-new', 'conversation-select', 'conversation-clear-focus']) ($<HTMLButtonElement | HTMLSelectElement>(id)).disabled = locked;
  for (const id of ['conversation-refresh', 'conversation-sync']) $<HTMLButtonElement>(id).disabled = conversationBusy || conversationRefreshing || !conversation;
  $<HTMLButtonElement>('conversation-clear-focus').disabled ||= !conversation?.focusTaskId;
  $('conversation-tasks').querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button[data-change-focus], button[data-priority], button[data-approve], button[data-answer-submit], button[data-retry], textarea[data-answer]').forEach(control => {
    control.disabled = control.dataset.boundary === 'true' || locked || (Boolean(control.dataset.priority) && conversationNeedsRefresh);
  });
  const surface = rosterView();
  if (surface === 'group' || surface === 'draft' || surface === 'direct') {
    $<HTMLButtonElement>('conversation-send').disabled = true;
    $<HTMLButtonElement>('conversation-execute').disabled = true;
    if (surface === 'direct' && !conversationCorrectionId) {
      $<HTMLButtonElement>('conversation-send').textContent = '先回到这个人';
      $('conversation-execution-note').textContent = '这间私聊只保留会话记录。执行回到这个人的对话里，明确创建 Run。它不会自己回复。';
    }
  }
  syncEntrySurface();
  syncStandingInstruction();
}
function syncStandingInstruction(): void {
  const section = $('standing-instruction');
  if (!section) return;
  const life = rosterView() === 'entry' || rosterView() === 'bot';
  section.hidden = !life;
  const field = $<HTMLTextAreaElement>('standing-text');
  const locked = conversationBusy || Boolean(conversationAttempt) || !conversation || !life;
  const nextId = conversation?.id ?? '';
  if (field) {
    const focused = document.activeElement === field;
    if (!conversation || nextId !== standingBoundId || !focused) {
      field.value = conversation?.standingInstruction ?? '';
      standingBoundId = nextId;
    }
    field.disabled = locked;
  }
  $<HTMLButtonElement>('standing-save').disabled = locked;
  $<HTMLButtonElement>('standing-clear').disabled = locked || !conversation?.standingInstruction;
  syncLastDelivery();
}
function deliveryDraft(delivery: LastDelivery): string {
  const parts = [delivery.taskTitle.trim()];
  if (delivery.planSummary?.trim()) parts.push(delivery.planSummary.trim());
  if (delivery.artifactTitles?.length) parts.push(delivery.artifactTitles.join('、'));
  const text = parts.join('。');
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}
function syncLastDelivery(): void {
  const section = $('last-delivery');
  if (!section) return;
  const life = rosterView() === 'entry' || rosterView() === 'bot';
  const delivery = life ? conversation?.lastDelivery : undefined;
  section.hidden = !delivery;
  const copy = $('last-delivery-copy');
  if (copy) copy.textContent = delivery ? deliveryDraft(delivery) : '';
  const pin = $<HTMLButtonElement>('last-delivery-pin');
  if (pin) pin.disabled = !delivery || conversationBusy || Boolean(conversationAttempt);
  syncPracticeDraft(delivery);
  syncAcceptedPractice();
}
function syncPracticeDraft(delivery: LastDelivery | undefined): void {
  const field = $<HTMLTextAreaElement>('practice-text');
  const accept = $<HTMLButtonElement>('practice-accept');
  const locked = !delivery || conversationBusy || Boolean(conversationAttempt);
  if (field) {
    const nextRun = delivery?.runId ?? '';
    const focused = document.activeElement === field;
    if (!delivery || nextRun !== practiceBoundRunId || !focused) {
      field.value = delivery ? deliveryDraft(delivery) : '';
      practiceBoundRunId = nextRun;
    }
    field.disabled = locked;
  }
  if (accept) accept.disabled = locked;
}
function syncAcceptedPractice(): void {
  const section = $('accepted-practice');
  if (!section) return;
  const life = rosterView() === 'entry' || rosterView() === 'bot';
  const practice = life ? conversation?.acceptedPractice : undefined;
  section.hidden = !practice;
  const copy = $('accepted-practice-copy');
  if (copy) copy.textContent = practice?.text ?? '';
  const retract = $<HTMLButtonElement>('accepted-practice-retract');
  if (retract) retract.disabled = !practice || conversationBusy || Boolean(conversationAttempt);
  syncTaskSettings();
}
function currentTaskKind(): string {
  return $<HTMLInputElement>('task-kind')?.value.trim() ?? '';
}
function syncTaskSettings(): void {
  const section = $('task-settings');
  if (!section) return;
  const life = rosterView() === 'entry' || rosterView() === 'bot';
  section.hidden = !life;
  const kind = currentTaskKind();
  const settings = life ? conversation?.taskSettings : undefined;
  const skill = kind ? settings?.skills.find(item => item.taskKind === kind) : undefined;
  const model = kind ? settings?.models.find(item => item.taskKind === kind) : undefined;
  const copy = $('skill-profile-copy');
  if (copy) {
    if (skill) copy.textContent = `${skill.methodId} · ${skill.version}，引用 ${skill.runId}`;
    else if (!kind && settings?.skills.length) copy.textContent = settings.skills.map(item => `${item.taskKind}：${item.methodId} · ${item.version}`).join('；');
    else copy.textContent = kind ? '这个种类还没有技能档案。' : '这个人还没有按任务种类留下技能档案。';
  }
  const modelCopy = $('task-model-copy');
  if (modelCopy) {
    if (model) modelCopy.textContent = model.provider ? `${model.model} · ${model.provider}` : model.model;
    else if (!kind && settings?.models.length) modelCopy.textContent = settings.models.map(item => `${item.taskKind}：${item.model}`).join('；');
    else modelCopy.textContent = kind ? '这个种类沿用当前运行时。' : '还没有哪个种类单独选了模型。';
  }
  const runtime = $('task-runtime-model');
  if (runtime) runtime.textContent = runtimeModel ? `当前运行时：${runtimeModel}。留空就用它。` : '当前按目录选择模型。留空就继续按目录。';
  const modelField = $<HTMLInputElement>('task-model');
  const providerField = $<HTMLInputElement>('task-model-provider');
  const bound = `${conversation?.id ?? ''}:${kind}`;
  if (modelField && document.activeElement !== modelField && bound !== taskModelBound) {
    modelField.value = model?.model ?? '';
    if (providerField && document.activeElement !== providerField) providerField.value = model?.provider ?? '';
    taskModelBound = bound;
  }
  const locked = !life || !conversation || conversationBusy || Boolean(conversationAttempt);
  const kindLocked = locked || !kind;
  $<HTMLInputElement>('task-kind').disabled = locked;
  if (modelField) modelField.disabled = locked;
  if (providerField) providerField.disabled = locked;
  const compare = kind ? settings?.comparisons?.find(item => item.taskKind === kind) : undefined;
  const compareCopy = $('task-kind-compare');
  if (compareCopy) {
    compareCopy.hidden = !compare;
    compareCopy.textContent = compare ? taskKindCompareText(compare) : '';
  }
  $<HTMLButtonElement>('skill-promote').disabled = kindLocked || !promotionRunId();
  $<HTMLButtonElement>('task-kind-keep').disabled = kindLocked || !compare?.differs || compare.kept;
  $<HTMLButtonElement>('task-kind-propose').disabled = kindLocked || !skillLineup(compare) || Boolean(compare?.proposal);
  $<HTMLButtonElement>('skill-rollback').disabled = kindLocked || !skill;
  $<HTMLButtonElement>('skill-retract').disabled = kindLocked || !skill;
  $<HTMLInputElement>('skill-rollback-reason').disabled = kindLocked || !skill;
  $<HTMLButtonElement>('task-model-save').disabled = kindLocked;
  $<HTMLButtonElement>('task-model-clear').disabled = kindLocked || !model;
}
function skillLineup(compare: TaskKindComparison | undefined): boolean {
  return Boolean(compare?.methodId && compare.profileMethodId && compare.version && compare.profileVersion && (compare.methodId !== compare.profileMethodId || compare.version !== compare.profileVersion));
}
function taskKindCompareText(compare: TaskKindComparison): string {
  const usedSkill = compare.methodId ? `${compare.methodId} · ${compare.version}` : '没有技能版本';
  const usedModel = compare.model ?? '当前运行时';
  const used = `这次做成：${usedSkill}，模型 ${usedModel}，引用 ${compare.runId}`;
  const sent = compare.proposal?.status === 'proposed'
    ? '已送去评测。候选停在 proposed。'
    : compare.proposal
      ? `已送去评测。候选状态：${compare.proposal.status}。`
      : '';
  if (!compare.profileMethodId && !compare.profileModel) return `${sent}${used}。这个种类还没有档案。`;
  const profileSkill = compare.profileMethodId ? `${compare.profileMethodId} · ${compare.profileVersion}` : '没有技能档案';
  const profileModel = compare.profileModel ?? '未指定模型';
  if (compare.kept) return `${sent}已留下这份档案。${used}。档案：${profileSkill}，模型 ${profileModel}。`;
  if (!compare.differs) return `${sent}这次做成和档案一致：${profileSkill}，模型 ${profileModel}。`;
  const offer = skillLineup(compare) ? '技能版本不同，可以送去评测。' : '';
  return `${sent}${used}。档案：${profileSkill}，模型 ${profileModel}。可以晋升这次技能，也可以留下档案。${offer}不点就不动。`;
}
function promotionRunId(): string {
  const kind = currentTaskKind();
  const compare = kind ? conversation?.taskSettings?.comparisons?.find(item => item.taskKind === kind) : undefined;
  if (compare) return compare.methodId ? compare.runId : '';
  return conversation?.lastDelivery?.runId ?? '';
}
function pinLastDelivery(): void {
  const surface = rosterView();
  const delivery = conversation?.lastDelivery;
  if ((surface !== 'entry' && surface !== 'bot') || !conversation || !delivery || conversationBusy || conversationAttempt) return;
  const field = $<HTMLTextAreaElement>('standing-text');
  const draft = deliveryDraft(delivery);
  const current = field.value.trim();
  if (current && current !== draft && !current.includes(draft)) {
    const combined = `${current}\n${draft}`;
    if (combined.length > 500) {
      $('conversation-error').textContent = '这句话已经写满。先删短，再放上次的做法。';
      field.focus();
      return;
    }
    field.value = combined;
  } else field.value = draft;
  standingBoundId = conversation.id;
  field.focus();
  $('conversation-status').textContent = '已放进嘱咐草稿。还没记住。要点「记住这句」才会留下。';
  $('conversation-error').textContent = '';
  updateConversationControls();
}
function usingDemoBots(): boolean {
  return agentsLoaded && !agentSummaries.some(agent => agent.status === 'admitted');
}
function rosterBots(): RosterBot[] {
  const admitted = agentSummaries.filter(agent => agent.status === 'admitted').map(agent => ({
    id: agent.agentId, name: agent.card.name, note: '已准入', demo: false,
  }));
  return [{ id: 'aeeis', name: 'AEEIS', note: '', demo: false }, ...(admitted.length ? admitted : (usingDemoBots() ? DEMO_BOTS : []))];
}
function loadBotGroups(): BotGroups {
  const raw = localStorage.getItem('aeeis.bot-groups');
  if (!raw) return usingDemoBots() ? {
    groups: [{ id: 'work', name: '工作' }, { id: 'research', name: '研究' }],
    placement: { aeeis: 'work', 'demo.release': 'work', 'demo.research': 'research', 'demo.brief': 'research' },
  } : { groups: [], placement: {} };
  try {
    const parsed = JSON.parse(raw) as BotGroups;
    if (!parsed || !Array.isArray(parsed.groups) || !parsed.placement || typeof parsed.placement !== 'object') throw new Error('bad');
    return {
      groups: parsed.groups.filter(group => group && typeof group.id === 'string' && typeof group.name === 'string' && group.name.trim()).slice(0, 8),
      placement: Object.fromEntries(Object.entries(parsed.placement).filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')),
    };
  } catch {
    return { groups: [], placement: {} };
  }
}
function ensureBotGroups(): BotGroups {
  if (!agentsLoaded) return botGroups ?? { groups: [], placement: {} };
  botGroups ??= loadBotGroups();
  return botGroups;
}
function saveBotGroups(): void {
  if (!botGroups) return;
  localStorage.setItem('aeeis.bot-groups', JSON.stringify(botGroups));
}
function botById(id: string): RosterBot | undefined {
  return rosterBots().find(bot => bot.id === id);
}
function activeBotId(): string {
  return rosterBots().some(bot => bot.id === selectedBotId) ? selectedBotId : 'aeeis';
}
function chatRoom(): RoomSummary | undefined {
  return roomSummaries.find(room => room.id === openGroupId);
}
function isManagedChat(room: RoomSummary): boolean {
  return room.status === 'active' && (room.description === '私聊' || room.description === '群聊');
}
function rosterView(): 'entry' | 'bot' | 'group' | 'draft' | 'direct' {
  if (groupDraftOpen) return 'draft';
  const room = chatRoom();
  if (room?.description === '私聊') return 'direct';
  if (room?.description === '群聊' || openGroupId) return openGroupId ? 'group' : 'entry';
  return activeBotId() === 'aeeis' ? 'entry' : 'bot';
}
function directRoomId(principalId: string): string {
  for (const [roomId, memberId] of directMembers) {
    if (memberId !== principalId) continue;
    const room = roomSummaries.find(item => item.id === roomId);
    if (room && isManagedChat(room) && room.description === '私聊') return roomId;
  }
  return '';
}
function lifeAgent(view: { id: string; agentId?: string } | undefined): string {
  if (!view) return '';
  if (view.agentId) return view.agentId;
  return view.id === aeeisConversationId ? 'aeeis' : '';
}
function lifeSummary(agentId: string): ConversationSummary | undefined {
  const stamped = conversationList.find(item => item.agentId === agentId);
  if (stamped) return stamped;
  if (agentId === 'aeeis' && aeeisConversationId) return conversationList.find(item => item.id === aeeisConversationId) ?? (conversation?.id === aeeisConversationId ? conversation : undefined);
  return undefined;
}
function taskCountOf(item: ConversationSummary | undefined): number | undefined {
  if (!item) return undefined;
  if (typeof item.taskCount === 'number') return item.taskCount;
  const tasks = (item as ConversationView).tasks;
  return Array.isArray(tasks) ? tasks.length : undefined;
}
function lifeTaskCount(agentId: string): number | undefined {
  if (conversation && lifeAgent(conversation) === agentId) return conversation.tasks.length;
  return taskCountOf(lifeSummary(agentId));
}
function lifePresenceLabel(agentId: string): string {
  const count = lifeTaskCount(agentId);
  return count ? `${count} 件事` : '在';
}
function lifeAvatarState(agentId: string): string {
  if (!conversation || lifeAgent(conversation) !== agentId) return 'idle';
  const statuses = conversation.tasks.map(task => task.status);
  if (statuses.some(status => status === 'running' || status === 'queued' || status === 'preparing')) return 'working';
  if (statuses.some(status => status === 'planning' || status === 'reviewing')) return 'thinking';
  if (statuses.some(status => ATTENTION_STATUSES.has(status) || status === 'paused')) return 'waiting';
  return 'idle';
}
function rememberAeeisHome(list: ConversationSummary[], loaded?: ConversationSummary): void {
  const stamped = list.find(item => item.agentId === 'aeeis');
  if (stamped) {
    aeeisConversationId = stamped.id;
    localStorage.setItem(LIFE_HOME, stamped.id);
    return;
  }
  if (aeeisConversationId && list.some(item => item.id === aeeisConversationId && !item.agentId)) return;
  const unscoped = loaded && !loaded.agentId ? loaded : list.find(item => !item.agentId);
  if (!unscoped) return;
  aeeisConversationId = unscoped.id;
  localStorage.setItem(LIFE_HOME, unscoped.id);
}
function aeeisThread(): { id: string; revision: number } | undefined {
  const stamped = conversationList.find(item => item.agentId === 'aeeis');
  if (stamped) return stamped;
  if (aeeisConversationId) {
    const remembered = conversationList.find(item => item.id === aeeisConversationId);
    if (remembered) return remembered;
    if (conversation?.id === aeeisConversationId) return conversation;
  }
  if (conversationList.length <= 1) return conversation ?? conversationList[0];
  return conversation;
}
function participantLabel(principalId: string): string {
  return botById(principalId)?.name ?? agentSummaries.find(agent => agent.agentId === principalId)?.card.name ?? principalId;
}
function eventAuthor(event: SessionEventSummary): string {
  if (event.type === 'system') return '记录';
  if (event.actorType === 'agent') return participantLabel(event.actorId);
  if (groupMembers.some(member => member.principalId === event.actorId)) return participantLabel(event.actorId);
  return '你';
}
function lifePersonId(): string {
  const view = rosterView();
  if (view === 'entry') return lifeAgent(conversation) || 'aeeis';
  if (view === 'bot') return lifeAgent(conversation) || activeBotId();
  return '';
}
function messageAuthor(item: ConversationMessageView): string {
  if (item.role === 'notification') return '任务通知';
  const person = lifePersonId();
  const personLabel = person ? participantLabel(person) : '';
  if (item.speaker?.role === 'agent') {
    const who = participantLabel(item.speaker.id);
    if (person && item.speaker.id !== person) return `${who} · 对${personLabel}`;
    return who;
  }
  if (item.speaker && person && item.speaker.id !== person) return `你 · 对${personLabel}`;
  return '你';
}
function selectedLifeSpeaker(): { role: 'agent'; id: string } | undefined {
  const view = rosterView();
  if (view !== 'entry' && view !== 'bot') return;
  const id = $<HTMLSelectElement>('life-speaker')?.value.trim() ?? '';
  const person = lifePersonId();
  if (!id || id !== person || !/^[A-Za-z0-9._-]+$/.test(id)) return;
  return { role: 'agent', id };
}
function syncLifeSpeaker(): void {
  const select = $<HTMLSelectElement>('life-speaker');
  if (!select) return;
  const view = rosterView();
  const person = lifePersonId();
  const valid = /^[A-Za-z0-9._-]+$/.test(person);
  const previous = select.value;
  select.replaceChildren();
  const you = document.createElement('option');
  you.value = '';
  you.textContent = '你';
  select.append(you);
  if (valid) {
    const option = document.createElement('option');
    option.value = person;
    option.textContent = participantLabel(person);
    select.append(option);
  }
  select.value = valid && previous === person ? previous : '';
  select.hidden = view !== 'entry' && view !== 'bot';
}
function speakerChoices(): Array<{ id: string; label: string; type: 'agent' | 'principal' }> {
  const view = rosterView();
  if (view === 'group') {
    return groupMembers.filter(member => member.role === 'agent' && member.status === 'active').map(member => ({ id: member.principalId, label: participantLabel(member.principalId), type: 'agent' as const }));
  }
  if (view === 'direct') {
    return groupMembers.filter(member => member.status === 'active').map(member => ({
      id: member.principalId,
      label: participantLabel(member.principalId),
      type: member.role === 'agent' ? 'agent' as const : 'principal' as const,
    }));
  }
  return [];
}
function selectedRoomSpeaker(): { type: 'agent' | 'principal'; id: string } | undefined {
  const view = rosterView();
  if (view !== 'group' && view !== 'direct') return;
  const id = $<HTMLSelectElement>('group-speaker')?.value.trim() ?? '';
  if (!id) return;
  const choice = speakerChoices().find(item => item.id === id);
  if (!choice) return;
  return { type: choice.type, id: choice.id };
}
function syncGroupSpeaker(): void {
  const select = $<HTMLSelectElement>('group-speaker');
  if (!select) return;
  const previous = select.value;
  const choices = speakerChoices();
  select.replaceChildren();
  const you = document.createElement('option');
  you.value = '';
  you.textContent = '你';
  select.append(you);
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.id;
    option.textContent = choice.label;
    select.append(option);
  }
  select.value = choices.some(choice => choice.id === previous) ? previous : '';
  const view = rosterView();
  select.hidden = view !== 'group' && view !== 'direct';
}
function groupOccupancy(): number {
  return 1 + draftAgents.size + draftPeople.length;
}
function clearOpenGroup(): void {
  openGroupId = '';
  groupMembers = [];
  groupEvents = [];
  localStorage.removeItem('aeeis.group');
}
function showRoster(focused: boolean): void {
  document.body.classList.toggle('roster-focus', focused);
}
function syncEntrySurface(): void {
  const view = rosterView();
  const life = view === 'entry' || view === 'bot';
  const messages = $('conversation-messages');
  const earlier = $('conversation-earlier');
  const empty = $('conversation-empty');
  const composer = $('conversation-composer');
  const note = $('bot-note');
  const placement = $('bot-placement');
  const draft = $('group-draft');
  const panel = $('group-panel');
  if (messages) messages.hidden = !life;
  if (earlier) earlier.hidden = !life || !conversation?.hasEarlierMessages;
  if (empty) empty.hidden = !life || Boolean(conversation?.messages.length);
  if (composer) composer.hidden = view === 'group' || view === 'draft' || view === 'direct';
  if (note) note.hidden = view !== 'bot';
  if (placement) placement.hidden = view !== 'bot' && view !== 'direct';
  if (draft) draft.hidden = view !== 'draft';
  if (panel) panel.hidden = view !== 'group' && view !== 'direct';
  const room = chatRoom();
  const directPrincipal = directMembers.get(room?.id ?? '') ?? '';
  const counterpart = view === 'direct' ? (botById(directPrincipal) ?? botById(activeBotId())) : botById(activeBotId());
  if (view === 'bot') {
    const title = $('bot-note-title');
    const copy = $('bot-note-copy');
    if (title) title.textContent = counterpart?.name ?? '成员';
    if (copy) copy.textContent = '这是这个人。对话会留在这里，做完以后人还在。它不会自己回复。要执行，仍在这里明确创建 Run，用的是同一套执行。';
  }
  const chatNote = $('chat-note');
  const rename = $('group-rename');
  const send = document.querySelector<HTMLButtonElement>('#group-composer button[type="submit"]');
  const groupText = $<HTMLTextAreaElement>('group-text');
  if (chatNote) chatNote.textContent = view === 'direct'
    ? '这间私聊只保留会话记录。选说话人只是标明这句话是谁说的，对方不会自己回复，也不会执行。@AEEIS 会记到 AEEIS 的对话里，不执行。归档后从成员列表里撤下，不会改讨论焦点，也不会停下任务。'
    : '这是群聊。选一位 bot，只是标明这句话是它说的；它不会自己回复，也不会执行。@AEEIS 会记到 AEEIS 的对话里，不执行。点名册里的人会打开这个人的对话；点不在名册上的成员，只打开会话记录。归档后从群聊列表撤下。';
  if (rename) rename.hidden = view === 'direct';
  if (send) send.textContent = view === 'direct' ? '发给这位' : '发到群里';
  if (groupText) groupText.placeholder = view === 'direct' ? '写给这一位。@AEEIS 会记到 AEEIS 的对话里，不执行，也不调用模型。' : '用 @ 点名。@AEEIS 会记到 AEEIS 的对话里，不执行，也不调用模型。';
  syncGroupSpeaker();
  syncLifeSpeaker();
  const directName = botById(directPrincipal)?.name ?? room?.title ?? directPrincipal;
  const personName = view === 'direct' ? (directName || '成员') : (counterpart?.name ?? '成员');
  const entryTitle = $('entry-title');
  const entryPresence = $('entry-presence');
  if (entryTitle) entryTitle.textContent = view === 'group' ? (room?.title || '群聊') : view === 'draft' ? '新建群聊' : (view === 'direct' || view === 'bot') ? personName : 'AEEIS';
  if (entryPresence) entryPresence.textContent = view === 'group' ? '群聊' : view === 'direct' ? '私聊' : view === 'draft' ? '选择成员' : lifePresenceLabel(view === 'bot' ? activeBotId() : 'aeeis');
  renderBotPlacement();
}
function renderBotRoster(): void {
  const list = $('bots');
  if (!list) return;
  const bots = rosterBots();
  const groups = ensureBotGroups();
  list.replaceChildren();
  const renderRow = (bot: RosterBot) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'bot-row';
    item.dataset.botId = bot.id;
    if (bot.id === 'aeeis') item.id = 'gb-bot';
    const avatar = element('span', bot.name.slice(0, 1) || 'B', 'roster-avatar');
    avatar.dataset.state = lifeAvatarState(bot.id);
    const copy = element('span', '', 'roster-copy');
    const presence = element('small', lifePresenceLabel(bot.id));
    copy.append(element('strong', bot.name), presence);
    item.append(avatar, copy);
    list.append(item);
  };
  const known = new Set(groups.groups.map(group => group.id));
  for (const group of groups.groups) {
    const members = bots.filter(bot => groups.placement[bot.id] === group.id);
    const heading = document.createElement('button');
    heading.type = 'button';
    heading.className = 'bot-group-label';
    heading.dataset.groupId = group.id;
    heading.textContent = `${group.name} · ${members.length}`;
    list.append(heading);
    for (const bot of members) renderRow(bot);
  }
  const loose = bots.filter(bot => !known.has(groups.placement[bot.id] ?? ''));
  if (loose.length && groups.groups.length) list.append(element('p', '未分组', 'bot-group-label'));
  for (const bot of loose) renderRow(bot);
  for (const room of roomSummaries.filter(item => item.status === 'active' && item.description === '私聊')) {
    const principalId = directMembers.get(room.id);
    if (principalId && rosterBots().some(bot => bot.id === principalId)) continue;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'bot-row';
    item.dataset.roomId = room.id;
    const avatar = element('span', room.title.slice(0, 1) || '成', 'roster-avatar');
    const copy = element('span', '', 'roster-copy');
    copy.append(element('strong', room.title), element('small', '私聊'));
    item.append(avatar, copy);
    list.append(item);
  }
  const viewingBot = rosterView() === 'entry' || rosterView() === 'bot' || rosterView() === 'direct';
  const visible = activeBotId();
  list.querySelectorAll<HTMLButtonElement>('[data-bot-id]').forEach(row => {
    row.setAttribute('aria-pressed', String(viewingBot && row.dataset.botId === visible));
  });
}
function renderBotPlacement(): void {
  const host = $('bot-placement');
  if (!host || host.hidden) return;
  host.replaceChildren();
  const groups = ensureBotGroups();
  const botId = activeBotId();
  const current = groups.groups.some(group => group.id === groups.placement[botId]) ? groups.placement[botId] : '';
  host.append(element('span', '分组', 'bot-placement-label'));
  const none = document.createElement('button');
  none.type = 'button';
  none.textContent = '未分组';
  none.setAttribute('aria-pressed', String(!current));
  none.addEventListener('click', () => placeBot(botId, ''));
  host.append(none);
  for (const group of groups.groups) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = group.name;
    chip.setAttribute('aria-pressed', String(current === group.id));
    chip.addEventListener('click', () => placeBot(botId, group.id));
    host.append(chip);
  }
}
function placeBot(botId: string, groupId: string): void {
  const groups = ensureBotGroups();
  if (!agentsLoaded) return;
  if (groupId && !groups.groups.some(group => group.id === groupId)) return;
  if (groupId) groups.placement[botId] = groupId;
  else delete groups.placement[botId];
  saveBotGroups();
  renderBotRoster();
  updateConversationControls();
}
function createBotGroup(event: Event): void {
  event.preventDefault();
  const input = $<HTMLInputElement>('bot-group-name');
  const name = input?.value.trim().slice(0, 40) ?? '';
  if (!name) { input?.focus(); return; }
  const groups = ensureBotGroups();
  if (!agentsLoaded) return;
  if (groups.groups.length >= 8) { message('最多 8 个分组。'); return; }
  if (groups.groups.some(group => group.name === name)) { message('已经有这个分组。'); return; }
  groups.groups.push({ id: `group_${Date.now().toString(36)}`, name });
  saveBotGroups();
  if (input) input.value = '';
  const draft = $('bot-group-draft');
  if (draft) draft.hidden = true;
  renderBotRoster();
  updateConversationControls();
}
function renameBotGroup(id: string): void {
  const groups = ensureBotGroups();
  const group = groups.groups.find(item => item.id === id);
  if (!group) return;
  const next = window.prompt('分组名称。留空则解散这一组。', group.name);
  if (next === null) return;
  const name = next.trim().slice(0, 40);
  if (!name) {
    groups.groups = groups.groups.filter(item => item.id !== id);
    for (const [botId, groupId] of Object.entries(groups.placement)) if (groupId === id) delete groups.placement[botId];
  } else if (groups.groups.some(item => item.id !== id && item.name === name)) {
    message('已经有这个分组。');
    return;
  } else group.name = name;
  saveBotGroups();
  renderBotRoster();
  updateConversationControls();
}
function selectBot(id: string): void {
  if (!rosterBots().some(bot => bot.id === id)) return;
  void openLifeThread(id).catch(error => message(errorMessage(error)));
}
async function openLifeThread(agentId: string): Promise<void> {
  if (!conversationEnabled || conversationBusy || conversationAttempt || lifeOpening.has(agentId)) return;
  const bot = botById(agentId);
  if (!bot) return;
  if (conversation && lifeAgent(conversation) === agentId && !openGroupId && !groupDraftOpen) {
    selectedBotId = agentId;
    localStorage.setItem('aeeis.bot', agentId);
    showRoster(false);
    renderBotRoster();
    renderGroups(roomSummaries);
    updateConversationControls();
    return;
  }
  lifeOpening.add(agentId);
  const epoch = conversationEpoch;
  conversationBusy = true;
  updateConversationControls();
  try {
    let summary = lifeSummary(agentId);
    let view: ConversationView;
    if (!summary) view = await api<ConversationView>('/conversations', { title: bot.name, agentId });
    else if (agentId === 'aeeis' && !summary.agentId) view = await api<ConversationView>('/conversations', { title: 'AEEIS', agentId: 'aeeis', claimId: summary.id });
    else if (conversation && conversation.id === summary.id) view = conversation;
    else view = await api<ConversationView>(`/conversations/${encodeURIComponent(summary.id)}`);
    if (epoch !== conversationEpoch) return;
    groupDraftOpen = false;
    clearOpenGroup();
    showRoster(false);
    if (conversation?.id !== view.id) {
      conversationReplyId = undefined;
      conversationCorrectionId = undefined;
      conversationNeedsRefresh = false;
      $<HTMLFormElement>('conversation-composer').reset();
      $('conversation-status').textContent = '';
      $('conversation-error').textContent = '';
    }
    selectedBotId = agentId;
    localStorage.setItem('aeeis.bot', agentId);
    if (agentId === 'aeeis') {
      aeeisConversationId = view.id;
      localStorage.setItem(LIFE_HOME, view.id);
    }
    acceptConversation(view);
    renderBotRoster();
    renderGroups(roomSummaries);
  } finally {
    lifeOpening.delete(agentId);
    if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); }
  }
}
function indexDirectRooms(rooms: RoomSummary[]): void {
  const directs = rooms.filter(room => room.status === 'active' && room.description === '私聊');
  const key = directs.map(room => room.id).join('|');
  if (key === directIndexKey) return;
  directIndexKey = key;
  directIndexPromise = Promise.all(directs.map(async room => {
    if (directMembers.has(room.id)) return;
    const members = await api<RoomMemberSummary[]>(`/rooms/${encodeURIComponent(room.id)}/members`).catch(() => [] as RoomMemberSummary[]);
    const other = members.find(member => member.status === 'active');
    if (other) directMembers.set(room.id, other.principalId);
  })).then(() => { if (directIndexKey === key && $('bots')) renderBotRoster(); });
}
async function openDirect(principalId: string): Promise<void> {
  if (!principalId) return;
  if (botById(principalId)) { await openLifeThread(principalId); return; }
  if (directOpening.has(principalId)) return;
  groupDraftOpen = false;
  showRoster(false);
  renderBotRoster();
  updateConversationControls();
  directOpening.add(principalId);
  try {
    await directIndexPromise;
    const existing = directRoomId(principalId);
    if (existing) { await openGroup(existing); return; }
    const room = await api<RoomSummary>('/rooms', { title: principalId, description: '私聊' });
    try {
      await api(`/rooms/${encodeURIComponent(room.id)}/members`, { principalId, role: 'editor' });
    } catch (error) {
      await api(`/rooms/${encodeURIComponent(room.id)}`, { status: 'archived' }, 'PATCH').catch(() => undefined);
      throw error;
    }
    directMembers.set(room.id, principalId);
    directIndexKey = '';
    roomSummaries = [room, ...roomSummaries.filter(item => item.id !== room.id)];
    message('');
    await openGroup(room.id);
  } finally { directOpening.delete(principalId); }
}
async function archiveOpenChat(): Promise<void> {
  const id = openGroupId;
  const room = chatRoom();
  if (!id || !room || !isManagedChat(room)) return;
  const updated = await api<RoomSummary>(`/rooms/${encodeURIComponent(id)}`, { status: 'archived' }, 'PATCH');
  roomSummaries = roomSummaries.map(item => item.id === id ? { ...item, ...updated, status: 'archived' } : item);
  directMembers.delete(id);
  directIndexKey = '';
  clearOpenGroup();
  selectedBotId = 'aeeis';
  localStorage.setItem('aeeis.bot', 'aeeis');
  message('');
  renderBotRoster();
  renderGroups(roomSummaries);
  updateConversationControls();
}
function renderGroupCandidates(): void {
  const host = $('group-candidates');
  const people = $('group-people');
  const live = $('group-count-live');
  if (!host || !people || !live) return;
  host.replaceChildren();
  for (const bot of rosterBots().filter(item => item.id !== 'aeeis')) {
    const row = element('label', '', 'group-candidate');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = draftAgents.has(bot.id);
    box.addEventListener('change', () => {
      if (box.checked) {
        if (groupOccupancy() >= 6) { box.checked = false; message('一个群聊最多 6 人。'); return; }
        draftAgents.add(bot.id);
      } else draftAgents.delete(bot.id);
      renderGroupCandidates();
    });
    row.append(box, document.createTextNode(` ${bot.name}`));
    host.append(row);
  }
  people.replaceChildren();
  for (const person of draftPeople) {
    const row = element('div', '', 'group-person');
    row.append(element('span', person));
    const remove = element('button', '移除') as HTMLButtonElement;
    remove.type = 'button';
    remove.className = 'quiet-button';
    remove.addEventListener('click', () => { draftPeople = draftPeople.filter(item => item !== person); renderGroupCandidates(); });
    row.append(remove);
    people.append(row);
  }
  const names = [...draftAgents].map(participantLabel).concat(draftPeople);
  live.textContent = `${groupOccupancy()} / 6 · AEEIS${names.length ? `、${names.join('、')}` : ''}`;
}
function showGroupDraft(): void {
  clearOpenGroup();
  showRoster(false);
  draftAgents.clear();
  draftPeople = [];
  groupDraftOpen = true;
  renderGroupCandidates();
  renderBotRoster();
  updateConversationControls();
  const title = $<HTMLInputElement>('group-title');
  if (title) { title.value = ''; title.focus(); }
  const person = $<HTMLInputElement>('group-person');
  if (person) person.value = '';
}
function addDraftPerson(): void {
  const input = $<HTMLInputElement>('group-person');
  const person = input?.value.trim() ?? '';
  if (!person) { input?.focus(); return; }
  if (draftPeople.includes(person) || draftAgents.has(person) || person === 'aeeis') { message('这位已经在群里。'); return; }
  if (groupOccupancy() >= 6) { message('一个群聊最多 6 人。'); return; }
  draftPeople = [...draftPeople, person];
  if (input) input.value = '';
  renderGroupCandidates();
}
async function createGroup(event: Event): Promise<void> {
  event.preventDefault();
  const title = $<HTMLInputElement>('group-title')?.value.trim() ?? '';
  if (!title) return;
  if (groupOccupancy() < 2) { message('群聊至少要 AEEIS 和另外一位。'); return; }
  if (groupOccupancy() > 6) { message('一个群聊最多 6 人。'); return; }
  const room = await api<RoomSummary>('/rooms', { title, description: '群聊' });
  try {
    for (const agentId of draftAgents) await api(`/rooms/${encodeURIComponent(room.id)}/members`, { principalId: agentId, role: 'agent' });
    for (const person of draftPeople) await api(`/rooms/${encodeURIComponent(room.id)}/members`, { principalId: person, role: 'editor' });
  } catch (error) {
    await api(`/rooms/${encodeURIComponent(room.id)}`, { status: 'archived' }, 'PATCH').catch(() => undefined);
    throw error;
  }
  roomSummaries = [room, ...roomSummaries.filter(item => item.id !== room.id)];
  groupDraftOpen = false;
  message('');
  await openGroup(room.id);
  await refresh();
}
function renderGroups(rooms: RoomSummary[]): void {
  roomSummaries = rooms;
  indexDirectRooms(rooms);
  if (!openGroupId && !groupDraftOpen) {
    const saved = localStorage.getItem('aeeis.group') ?? '';
    const savedRoom = rooms.find(room => room.id === saved);
    if (savedRoom && isManagedChat(savedRoom)) openGroupId = saved;
    else if (saved) localStorage.removeItem('aeeis.group');
  }
  const list = $('groups');
  if (!list) return;
  const visible = rooms.filter(room => room.status === 'active' && room.description === '群聊');
  if (openGroupId && !rooms.some(room => room.id === openGroupId && isManagedChat(room))) {
    openGroupId = '';
    groupMembers = [];
    groupEvents = [];
    localStorage.removeItem('aeeis.group');
  }
  list.replaceChildren();
  for (const room of visible) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `group-row${room.id === openGroupId ? ' selected' : ''}`;
    item.addEventListener('click', () => { void openGroup(room.id).catch(error => message(errorMessage(error))); });
    const avatar = element('span', room.title.slice(0, 1) || '群', 'roster-avatar');
    const copy = element('span', '', 'roster-copy');
    copy.append(element('strong', room.title), element('small', '群聊'));
    item.append(avatar, copy);
    list.append(item);
  }
  const empty = $('groups-empty');
  if (empty) empty.hidden = visible.length > 0;
  if (openGroupId) void loadGroup(openGroupId);
  renderBotRoster();
  syncEntrySurface();
}
async function openGroup(id: string): Promise<void> {
  const room = roomSummaries.find(item => item.id === id);
  if (room && room.status !== 'active') { message('这个群聊已经归档。'); return; }
  if (openGroupId !== id) { groupMembers = []; groupEvents = []; }
  openGroupId = id;
  groupDraftOpen = false;
  showRoster(false);
  localStorage.setItem('aeeis.group', id);
  renderGroups(roomSummaries);
  $<HTMLTextAreaElement>('group-text')?.focus();
}
async function loadGroup(id: string): Promise<void> {
  const [members, events] = await Promise.all([
    api<RoomMemberSummary[]>(`/rooms/${encodeURIComponent(id)}/members`).catch(() => [] as RoomMemberSummary[]),
    api<SessionEventPage>(`/rooms/${encodeURIComponent(id)}/session-events?limit=50`).catch(() => ({ items: [] as SessionEventSummary[] })),
  ]);
  if (openGroupId !== id) return;
  groupMembers = members.filter(member => member.status === 'active');
  groupEvents = events.items ?? [];
  renderGroupTranscript();
}
function renderGroupTranscript(): void {
  const list = $('group-transcript');
  const empty = $('group-thread-empty');
  const members = $('group-members');
  if (!list) return;
  if (members) {
    members.replaceChildren(document.createTextNode('AEEIS'));
    for (const member of groupMembers) {
      members.append(document.createTextNode('、'));
      const openMember = document.createElement('button');
      openMember.type = 'button';
      openMember.className = 'quiet-button';
      openMember.textContent = participantLabel(member.principalId);
      openMember.addEventListener('click', () => { void openDirect(member.principalId).catch(error => message(errorMessage(error))); });
      members.append(openMember);
    }
  }
  list.replaceChildren();
  for (const event of groupEvents) {
    if (event.operation === 'retract') continue;
    const item = element('li', '', 'group-message');
    item.dataset.type = event.type;
    const heading = element('header');
    heading.append(element('strong', eventAuthor(event)), element('small', formatTime(event.createdAt)));
    item.append(heading, element('p', event.content));
    list.append(item);
  }
  if (empty) empty.hidden = groupEvents.some(event => event.operation !== 'retract');
  syncGroupSpeaker();
  renderMentions();
}
function mentionTargets(): Array<{ label: string }> {
  return [{ label: 'AEEIS' }, { label: '所有人' }, ...groupMembers.map(member => ({ label: participantLabel(member.principalId) }))];
}
function renderMentions(): void {
  const box = $('group-mentions');
  const input = $<HTMLTextAreaElement>('group-text');
  if (!box || !input) return;
  const match = input.value.match(/(?:^|\s)@([^\s@]*)$/);
  const query = match?.[1]?.toLowerCase();
  box.replaceChildren();
  if (query === undefined) { box.hidden = true; return; }
  const hits = mentionTargets().filter(target => target.label.toLowerCase().includes(query));
  box.hidden = hits.length === 0;
  for (const hit of hits) {
    const choice = element('button', `@${hit.label}`) as HTMLButtonElement;
    choice.type = 'button';
    choice.addEventListener('click', () => {
      input.value = input.value.replace(/(?:^|\s)@([^\s@]*)$/, token => /^\s/.test(token) ? ` @${hit.label} ` : `@${hit.label} `);
      box.hidden = true;
      input.focus();
    });
    box.append(choice);
  }
}
const AEEIS_MENTION = /(?:^|[^\p{L}\p{N}_])@aeeis(?=$|[^\p{L}\p{N}_])/giu;
function mentionsAeeis(text: string): boolean {
  AEEIS_MENTION.lastIndex = 0;
  return AEEIS_MENTION.test(text.normalize('NFKC'));
}
function clipEntryText(value: string, max: number): string {
  const sliced = value.slice(0, max);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xD800 && last <= 0xDBFF ? sliced.slice(0, -1) : sliced;
}
function entryMentionTitle(text: string, roomTitle: string, kind: string): string {
  AEEIS_MENTION.lastIndex = 0;
  const stripped = text.normalize('NFKC').replace(AEEIS_MENTION, ' ').replace(/\s+/g, ' ').trim();
  const title = clipEntryText(stripped || `来自${kind}「${roomTitle || kind}」`, 80).trim();
  return title.length >= 2 ? title : '入口请求';
}
function groupIdempotencyKey(): string {
  return `group-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`}`;
}
async function submitGroupMessage(event: Event): Promise<void> {
  event.preventDefault();
  const input = $<HTMLTextAreaElement>('group-text');
  const text = input?.value.trim() ?? '';
  const roomId = openGroupId;
  if (!text || !roomId) { input?.focus(); return; }
  const room = roomSummaries.find(item => item.id === roomId);
  if (room && room.status !== 'active') { message('这个群聊已经归档。'); return; }
  const listed = await api<GoalSummary[] | { goals?: GoalSummary[] }>(`/rooms/${encodeURIComponent(roomId)}/goals`);
  const goals = Array.isArray(listed) ? listed : (listed.goals ?? []);
  let goal = goals.find(item => item.status === 'active') ?? goals[0];
  if (!goal) goal = await api<GoalSummary>('/goals', { title: room?.title || '群聊', roomId });
  const manifest = await api<{ id: string }>(`/goals/${encodeURIComponent(goal.id)}/context-manifests`, { purpose: room?.description === '私聊' ? '私聊消息' : '群聊消息', audienceMode: 'room' });
  const spoken = selectedRoomSpeaker();
  const postSession = (type: 'message' | 'system', content: string) => api(`/rooms/${encodeURIComponent(roomId)}/session-events`, {
    goalId: goal.id, type, content, contextManifestId: manifest.id, idempotencyKey: groupIdempotencyKey(),
    ...(type === 'message' && spoken ? { actor: spoken } : {}),
  });
  await postSession('message', text);
  if (input) input.value = '';
  let handoffError = '';
  if (mentionsAeeis(text)) {
    const kind = room?.description === '私聊' ? '私聊' : '群聊';
    const title = entryMentionTitle(text, room?.title || kind, kind);
    const target = aeeisThread();
    if (!conversationEnabled || !target) handoffError = '这条点名了 AEEIS，入口讨论还没打开，所以只留在会话里。';
    else if (conversationBusy || conversationAttempt) handoffError = '入口正在发送另一条讨论，这条点名只留在会话里。';
    else {
      const epoch = conversationEpoch;
      const id = target.id;
      const expectedRevision = conversation?.id === id ? conversation.revision : target.revision;
      conversationBusy = true;
      updateConversationControls();
      try {
        const result = await api<ConversationPost>(`/conversations/${encodeURIComponent(id)}/messages`, {
          text: clipEntryText(`来自${kind}「${room?.title || kind}」：${text}`, 7000),
          expectedRevision,
          newTask: { title },
          focus: 'keep',
          intent: 'discuss',
          ...(spoken?.type === 'agent' ? { speaker: { role: 'agent' as const, id: spoken.id } } : {}),
        }, 'POST', groupIdempotencyKey());
        if (epoch === conversationEpoch && result.conversation?.id === id) {
          if (conversation?.id === id) acceptConversation(result.conversation);
          else rememberLifeSummary(result.conversation);
        }
      } catch (error) {
        handoffError = `会话已留下，入口讨论没有记上。${errorMessage(error)}`;
      } finally {
        if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); }
      }
      if (!handoffError) {
        try {
          await postSession('system', `已记为入口讨论「${title}」。未执行，讨论焦点不变。`);
        } catch (error) {
          handoffError = `入口讨论已记下，回执没有写进会话。${errorMessage(error)}`;
        }
      }
    }
  }
  await loadGroup(roomId);
  message(handoffError);
}
async function renameGroup(): Promise<void> {
  if (!openGroupId) return;
  const room = roomSummaries.find(item => item.id === openGroupId);
  const title = window.prompt('群聊名称', room?.title ?? '')?.trim();
  if (!title) return;
  const updated = await api<RoomSummary>(`/rooms/${encodeURIComponent(openGroupId)}`, { title }, 'PATCH');
  roomSummaries = roomSummaries.map(item => item.id === updated.id ? { ...item, ...updated } : item);
  renderGroups(roomSummaries);
}
function renderConversation(): void {
  $('conversation-panel').hidden = !conversationEnabled;
  document.body.classList.toggle('conversation-mode', conversationEnabled);
  if (!conversationEnabled) return;
  const select = $<HTMLSelectElement>('conversation-select');
  const choicesSignature = JSON.stringify(conversationList.map(item => [item.id, item.title]));
  if (select.dataset.signature !== choicesSignature) {
    select.dataset.signature = choicesSignature; select.replaceChildren();
    if (!conversationList.length) { const option = element('option', '还没有对话，请新建'); option.value = ''; select.append(option); }
    for (const item of conversationList) { const option = element('option', item.title); option.value = item.id; select.append(option); }
  }
  select.value = conversation?.id ?? '';
  $('conversation-focus').textContent = `讨论焦点：${conversation?.focusTaskId ? conversationTaskName(conversation.focusTaskId) : '未选择任务（一般讨论）'}`;
  const signature = JSON.stringify(conversation);
  if (signature !== conversationRenderSignature) {
    conversationRenderSignature = signature ?? '';
    const target = $<HTMLSelectElement>('conversation-target'), previousTarget = target.value;
    target.replaceChildren();
    for (const [value, text] of [['', '自动识别 / 当前讨论焦点'], ['__new', '新建任务（独立 Thread）'], ...(conversation?.tasks ?? []).map(task => [task.id, task.title])]) {
      const option = element('option', text); option.value = value!; target.append(option);
    }
    target.value = [...target.options].some(option => option.value === previousTarget) ? previousTarget : '';
    const taskBody = $('conversation-tasks').querySelector('tbody');
    const answerDrafts = new Map<string, string>();
    taskBody?.querySelectorAll<HTMLTextAreaElement>('textarea[data-answer]').forEach(field => {
      if (field.dataset.answer) answerDrafts.set(field.dataset.answer, field.value);
    });
    taskBody?.replaceChildren();
    const ordered = conversationTaskOrder(conversation?.tasks ?? []);
    ordered.forEach((task, index) => {
      const row = document.createElement('tr'); row.className = 'conversation-task'; row.dataset.focused = String(task.id === conversation?.focusTaskId); row.dataset.taskId = task.id;
      const rank = document.createElement('td'); rank.append(element('strong', String(index + 1)));
      const name = document.createElement('td'); name.append(element('strong', task.title));
      if (task.memory) {
        const memoryText = task.memory.activeSummaries
          ? `工作记忆：${task.memory.activeSummaries} 份压缩摘要，${task.memory.originals} 份原文。摘要不是证据，也不改变讨论焦点。`
          : `工作记忆：${task.memory.originals} 份原文，尚未压缩。`;
        name.append(element('small', memoryText, 'conversation-memory'));
      }
      if (task.pendingApproval) {
        const preview = element('small', `待批计划：${task.pendingApproval.summary}`, 'conversation-plan');
        preview.title = task.pendingApproval.summary;
        name.append(preview);
      }
      if (task.pendingQuestion) name.append(element('small', `待回答：${task.pendingQuestion.text}`, 'conversation-question'));
      const status = document.createElement('td');
      status.append(element('span', task.status === 'discussion' ? '仅讨论，未执行' : task.status === 'preparing' ? '正在准备执行' : runStatusLabel(task.status)));
      const actions = document.createElement('td');
      const raise = dashboardButton('提高优先级', () => changeConversationPriority(task.id, 'higher'));
      raise.dataset.priority = 'higher'; raise.dataset.boundary = String(index === 0); raise.title = index === 0 ? '已经是最高优先级' : '把这项任务提前一位';
      const lower = dashboardButton('降低优先级', () => changeConversationPriority(task.id, 'lower'));
      lower.dataset.priority = 'lower'; lower.dataset.boundary = String(index === ordered.length - 1); lower.title = index === ordered.length - 1 ? '已经是最低优先级' : '把这项任务后移一位';
      const focus = button('设为讨论焦点', async () => changeConversationFocus(task.id)); focus.type = 'button'; focus.dataset.changeFocus = task.id;
      actions.append(raise, lower, focus);
      const runId = task.runId ?? task.latestRunId;
      if (runId && task.pendingApproval) {
        const approve = dashboardButton('批准并执行', () => approveConversationTask(task));
        approve.dataset.approve = task.id; approve.className = 'decision-primary';
        actions.append(approve);
      }
      if (runId && task.status === 'needs_input' && task.pendingQuestion) {
        const field = document.createElement('textarea');
        field.className = 'conversation-answer'; field.maxLength = 8000; field.rows = 2;
        field.placeholder = '回答后从当前节点继续'; field.dataset.answer = task.id;
        field.setAttribute('aria-label', `回答「${task.title}」`);
        const draft = answerDrafts.get(task.id);
        if (draft) field.value = draft;
        const submit = dashboardButton('提交回答', () => answerConversationTask(task, field.value));
        submit.dataset.answerSubmit = task.id;
        actions.append(field, submit);
      }
      if (runId && task.status === 'failed') {
        const retry = dashboardButton('重试', () => retryConversationTask(task));
        retry.dataset.retry = task.id;
        actions.append(retry);
      }
      if (runId) { const view = button('查看运行', async () => openConversationRun(runId)); view.type = 'button'; actions.append(view); }
      if (runId && task.memory?.activeSummaries) { const memory = button('查看任务记忆', async () => openConversationMemory(runId)); memory.type = 'button'; actions.append(memory); }
      row.append(rank, name, status, actions); taskBody?.append(row);
    });
    $('conversation-tasks').hidden = ordered.length === 0;
    const messages = $('conversation-messages'); messages.replaceChildren();
    for (const item of conversation?.messages ?? []) {
      const row = element('li', '', 'conversation-message'); row.dataset.role = item.role; row.dataset.messageId = item.id;
      if (item.speaker) { row.dataset.speaker = item.speaker.role; row.dataset.speakerId = item.speaker.id; }
      row.append(element('small', `${messageAuthor(item)} · ${formatTime(item.createdAt)}`), element('p', item.text));
      if (item.replyTo) row.append(element('small', `回复：${conversation?.messages.find(message => message.id === item.replyTo)?.text.slice(0, 100) ?? item.replyTo}`));
      const corrected = Boolean(item.effectiveTaskIds && (JSON.stringify(item.effectiveTaskIds) !== JSON.stringify(item.route.taskIds) || conversation?.messages.some(message => message.correctsMessageId === item.id)));
      if (corrected) row.append(element('small', `当前有效归属（已纠正）：${item.effectiveTaskIds!.map(conversationTaskName).join('、')}。仅影响后续消息和新执行上下文。`));
      if (item.correctsMessageId) row.append(element('small', `归属纠正记录：${item.correctsMessageId}；原始路由和已有执行记录不变。`));
      const routeLabel = item.route.status === 'clarify' ? '待澄清：未执行，请明确选择任务' : item.route.status === 'general' ? '一般讨论：已记录，未调用模型' : `${corrected ? '原始关联任务（审计）' : '关联任务'}：${item.route.taskIds.map(conversationTaskName).join('、')}`;
      row.append(element('small', `${routeLabel} · 路由：${item.route.reason} · ${item.route.focusEffect === 'switch' && item.route.status === 'routed' ? '已切换讨论焦点' : '保持讨论焦点'}`));
      if (item.execution?.state === 'cancelled') row.append(element('small', '这次执行没有创建，请重新发送。'));
      else if (item.execution) row.append(element('small', `执行请求：${item.execution.state} · ${item.execution.runId}（不代表计划已批准）`));
      else if (item.role === 'user' && item.route.status === 'routed') row.append(element('small', '已记录讨论，未调用模型。'));
      const reply = button('回复这条消息', async () => prepareConversationReply(item)); reply.type = 'button'; row.append(reply);
      if (item.role === 'user' && !item.execution && !item.correctsMessageId) {
        const correct = button('纠正归属', async () => {
          if (conversationBusy || conversationAttempt) return;
          conversationCorrectionId = item.id; conversationReplyId = undefined;
          $<HTMLSelectElement>('conversation-target').value = '';
          $<HTMLSelectElement>('conversation-focus-effect').value = 'keep';
          $<HTMLTextAreaElement>('conversation-text').value = '纠正这条讨论的任务归属';
          $('conversation-correction-label').textContent = `纠正归属：${item.text.slice(0, 160)}`;
          updateConversationControls(); openConversationRoute(); $<HTMLSelectElement>('conversation-target').focus();
        }); correct.type = 'button'; row.append(correct);
      }
      if (item.route.status === 'clarify' && !corrected) {
        for (const id of item.route.candidateTaskIds) {
          const choice = button(`选择任务：${conversationTaskName(id)}`, async () => {
            if (conversationBusy || conversationAttempt) return;
            prepareConversationReply(item); $<HTMLSelectElement>('conversation-target').value = id;
            $<HTMLTextAreaElement>('conversation-text').value = item.text; openConversationRoute(); updateConversationControls();
            $('conversation-status').textContent = '已选择任务。请检查内容，再点击“发送讨论”或“创建执行 Run”；尚未执行。';
          }); choice.type = 'button'; row.append(choice);
        }
      }
      const runId = item.notificationRunId ?? item.execution?.runId;
      if (runId) { const view = button('查看此次运行', async () => openConversationRun(runId)); view.type = 'button'; row.append(view); }
      messages.append(row);
    }
    $('conversation-earlier').hidden = !conversation?.hasEarlierMessages;
    $('conversation-empty').hidden = Boolean(conversation?.messages.length);
    $('conversation-tasks-empty').hidden = Boolean(conversation?.tasks.length);
  }
  updateConversationControls();
}
function rememberLifeSummary(view: ConversationView): void {
  const index = conversationList.findIndex(item => item.id === view.id);
  if (index < 0) conversationList.unshift(view); else conversationList[index] = view;
  if (view.agentId === 'aeeis') {
    aeeisConversationId = view.id;
    localStorage.setItem(LIFE_HOME, view.id);
  }
  renderBotRoster();
}
function acceptConversation(view: ConversationView): void {
  if (conversation?.id === view.id && conversation.revision > view.revision) return;
  conversation = view;
  rememberLifeSummary(view);
  localStorage.setItem(CONVERSATION_SELECTION, view.id); localStorage.setItem(CONVERSATION_SCOPE, conversationScope);
  renderConversation();
}
async function initializeConversations(status: RuntimeStatus): Promise<void> {
  conversationEnabled = status.conversationRouting === true && !linkedRunId && !linkedThreadId && !readOnlyShare;
  if (!conversationEnabled) { renderConversation(); return; }
  const scope = JSON.stringify([status.mode, status.tenantId ?? '', status.principal ?? '']);
  if (conversationScope && conversationScope !== scope || localStorage.getItem(CONVERSATION_SCOPE) && localStorage.getItem(CONVERSATION_SCOPE) !== scope) resetConversation();
  conversationScope = scope;
  const epoch = conversationEpoch;
  try {
    const list = await api<ConversationSummary[]>('/conversations');
    if (epoch !== conversationEpoch) return;
    conversationList = list;
    const selectedId = conversation?.id ?? localStorage.getItem(CONVERSATION_SELECTION);
    const selected = list.find(item => item.id === selectedId) ?? list[0];
    if (selected) {
      const view = await api<ConversationView>(`/conversations/${encodeURIComponent(selected.id)}`);
      if (epoch !== conversationEpoch) return;
      acceptConversation(view);
      rememberAeeisHome(conversationList, view);
      if (!conversationAttempt) {
        try {
          const saved = JSON.parse(sessionStorage.getItem(CONVERSATION_PENDING) ?? 'null') as ConversationAttempt | null;
          if (saved?.scope === scope && saved.conversationId === view.id && typeof saved.key === 'string' && typeof saved.body === 'string') {
            const body = JSON.parse(saved.body); conversationAttempt = saved;
            conversationCorrectionId = body.correctsMessageId; conversationReplyId = body.replyTo;
            $<HTMLTextAreaElement>('conversation-text').value = body.text ?? '';
            $<HTMLSelectElement>('conversation-target').value = body.newTask ? '__new' : body.taskIds?.[0] ?? '';
            $<HTMLInputElement>('conversation-task-title').value = body.newTask?.title ?? '';
            $<HTMLSelectElement>('conversation-focus-effect').value = body.focus ?? 'keep';
            if (conversationCorrectionId) $('conversation-correction-label').textContent = `纠正归属：${view.messages.find(item => item.id === conversationCorrectionId)?.text.slice(0, 160) ?? conversationCorrectionId}`;
            if (conversationReplyId) $('conversation-reply-label').textContent = `回复：${view.messages.find(item => item.id === conversationReplyId)?.text.slice(0, 160) ?? conversationReplyId}`;
            $('conversation-status').textContent = '已恢复尚未确认的请求。请重试原请求以确认结果。';
          }
        } catch { sessionStorage.removeItem(CONVERSATION_PENDING); }
      }
    } else {
      const view = await api<ConversationView>('/conversations', {});
      if (epoch !== conversationEpoch) return;
      acceptConversation(view);
      rememberAeeisHome(conversationList, view);
    }
    renderConversation();
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) resetConversation();
    $('conversation-error').textContent = `无法读取对话：${errorMessage(error)}。请重新连接。`; renderConversation();
  }
}
async function refreshConversation(sync = false, force = false): Promise<void> {
  if (!conversationEnabled || !conversation || conversationRefreshing || (!force && conversationBusy)) return;
  const epoch = conversationEpoch, id = conversation.id;
  conversationRefreshing = true; updateConversationControls();
  try {
    const view = await api<ConversationView>(`/conversations/${encodeURIComponent(id)}${sync ? '/notifications/sync' : ''}`, sync ? {} : undefined);
    if (epoch !== conversationEpoch || conversation?.id !== id) return;
    acceptConversation(view);
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) resetConversation();
    throw error;
  } finally { if (epoch === conversationEpoch) { conversationRefreshing = false; updateConversationControls(); } }
}
function prepareConversationReply(item: ConversationMessageView): void {
  if (conversationBusy || conversationAttempt) return;
  if (conversationCorrectionId) $<HTMLTextAreaElement>('conversation-text').value = '';
  conversationReplyId = item.id; conversationCorrectionId = undefined;
  $<HTMLSelectElement>('conversation-target').value = '';
  $<HTMLSelectElement>('conversation-focus-effect').value = 'keep';
  $('conversation-reply-label').textContent = `回复：${item.text.slice(0, 160)}`;
  updateConversationControls(); $<HTMLTextAreaElement>('conversation-text').focus();
}
async function changeConversationPriority(taskId: string, direction: 'higher' | 'lower'): Promise<void> {
  if (!conversation || conversationBusy || conversationAttempt || conversationNeedsRefresh) return;
  const epoch = conversationEpoch, id = conversation.id, focus = conversation.focusTaskId;
  conversationBusy = true; updateConversationControls();
  try {
    const view = await api<ConversationView>(`/conversations/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/priority`, { expectedRevision: conversation.revision, direction });
    if (epoch === conversationEpoch) {
      acceptConversation(view);
      $('conversation-status').textContent = '任务优先级已更新。讨论焦点和运行状态都没有改变；几个任务都能推进时，排在前面的先走一步。';
      if (conversation?.focusTaskId !== focus) $('conversation-error').textContent = '优先级更新后讨论焦点发生变化，请刷新核对。';
    }
  } catch (error) {
    if (epoch === conversationEpoch) {
      conversationNeedsRefresh = error instanceof ApiError && error.status === 409 && /刷新/.test(errorMessage(error));
      $('conversation-error').textContent = `${errorMessage(error)}${conversationNeedsRefresh ? '。请先刷新对话，再调整优先级。' : ''}`;
    }
  } finally { if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); } }
}
async function answerConversationTask(task: ConversationTaskView, answer: string): Promise<void> {
  const text = answer.trim();
  if (!conversation || !task.runId || !text || conversationBusy || conversationAttempt) {
    if (conversation && !text) $('conversation-error').textContent = '请先写下回答，再提交。';
    return;
  }
  const epoch = conversationEpoch, id = conversation.id, focus = conversation.focusTaskId, runId = task.runId;
  conversationBusy = true; updateConversationControls();
  try {
    await api(`/runs/${encodeURIComponent(runId)}/answer`, { answer: text });
    if (epoch !== conversationEpoch) return;
    await refreshConversation(false, true);
    if (epoch !== conversationEpoch) return;
    if (currentId === runId) await refresh();
    if (epoch !== conversationEpoch) return;
    $('conversation-status').textContent = `已回答「${task.title}」。讨论焦点没有改变。`;
    $('conversation-error').textContent = conversation?.id === id && conversation.focusTaskId !== focus ? '回答后讨论焦点发生变化，请刷新核对。' : '';
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    $('conversation-error').textContent = errorMessage(error);
    if (error instanceof ApiError && error.status === 409) await refreshConversation(false, true).catch(() => undefined);
  } finally { if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); } }
}
async function retryConversationTask(task: ConversationTaskView): Promise<void> {
  if (!conversation || !task.runId || task.status !== 'failed' || conversationBusy || conversationAttempt) return;
  const epoch = conversationEpoch, id = conversation.id, focus = conversation.focusTaskId, runId = task.runId;
  conversationBusy = true; updateConversationControls();
  try {
    await api(`/runs/${encodeURIComponent(runId)}/retry`, {});
    if (epoch !== conversationEpoch) return;
    await refreshConversation(false, true);
    if (epoch !== conversationEpoch) return;
    if (currentId === runId) await refresh();
    if (epoch !== conversationEpoch) return;
    $('conversation-status').textContent = `已请求重试「${task.title}」。讨论焦点没有改变。`;
    $('conversation-error').textContent = conversation?.id === id && conversation.focusTaskId !== focus ? '重试后讨论焦点发生变化，请刷新核对。' : '';
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    $('conversation-error').textContent = errorMessage(error);
    if (error instanceof ApiError && error.status === 409) await refreshConversation(false, true).catch(() => undefined);
  } finally { if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); } }
}
async function approveConversationTask(task: ConversationTaskView): Promise<void> {
  if (!conversation || !task.runId || !task.pendingApproval || conversationBusy || conversationAttempt) return;
  const epoch = conversationEpoch, id = conversation.id, focus = conversation.focusTaskId, runId = task.runId;
  conversationBusy = true; updateConversationControls();
  try {
    await api(`/runs/${encodeURIComponent(runId)}/approve`, { planHash: task.pendingApproval.planHash, planVersion: task.pendingApproval.planVersion });
    if (epoch !== conversationEpoch) return;
    await refreshConversation(false, true);
    if (epoch !== conversationEpoch) return;
    if (currentId === runId) await refresh();
    if (epoch !== conversationEpoch) return;
    $('conversation-status').textContent = `已批准「${task.title}」的当前计划并开始执行。讨论焦点没有改变。`;
    $('conversation-error').textContent = conversation?.id === id && conversation.focusTaskId !== focus ? '批准后讨论焦点发生变化，请刷新核对。' : '';
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    $('conversation-error').textContent = errorMessage(error);
    if (error instanceof ApiError && error.status === 409) await refreshConversation(false, true).catch(() => undefined);
  } finally { if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); } }
}
async function changeConversationFocus(taskId: string | null): Promise<void> {
  if (!conversation || conversationBusy || conversationAttempt) return;
  const epoch = conversationEpoch, id = conversation.id;
  conversationBusy = true; updateConversationControls();
  try {
    const view = await api<ConversationView>(`/conversations/${encodeURIComponent(id)}/focus`, { taskId, expectedRevision: conversation.revision });
    if (epoch === conversationEpoch) { acceptConversation(view); $('conversation-status').textContent = '讨论焦点已更新；没有启动或切换运行。'; }
  } catch (error) { if (epoch === conversationEpoch) { conversationNeedsRefresh = error instanceof ApiError && error.status === 409; $('conversation-error').textContent = `${errorMessage(error)}${conversationNeedsRefresh ? '。请先刷新对话，再明确选择焦点。' : ''}`; } }
  finally { if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); } }
}
let openMemoryForRunId = '';
async function openConversationMemory(runId: string): Promise<void> {
  openMemoryForRunId = runId;
  await openConversationRun(runId);
}
async function openConversationRun(runId: string): Promise<void> {
  const epoch = conversationEpoch;
  const run = await api<RunView>(`/runs/${encodeURIComponent(runId)}`);
  const [graphs, explanation] = await Promise.all([api<RunGraphsView>(`/runs/${encodeURIComponent(runId)}/graphs`), api<RunExplanation>(`/runs/${encodeURIComponent(runId)}/explanation`)]);
  if (epoch !== conversationEpoch) return;
  currentId = runId; current = { ...run, graphs }; localStorage.setItem('aeeis.run', runId);
  setCurrentRunOpen(true); render(current); renderExplanation(explanation);
  if (!['succeeded', 'failed', 'cancelled'].includes(run.status)) ensureRunEventStream(run.id);
  $('run-workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('run-title').focus({ preventScroll: true });
}
async function acceptPractice(text: string): Promise<void> {
  const surface = rosterView();
  if (surface !== 'entry' && surface !== 'bot') return;
  const delivery = conversation?.lastDelivery;
  if (!conversation || !delivery || conversationBusy || conversationAttempt) return;
  const trimmed = text.trim();
  if (!trimmed) {
    $('conversation-error').textContent = '先写下这句做法。';
    return;
  }
  if (trimmed.length > 500) {
    $('conversation-error').textContent = '这句话最多 500 字。';
    return;
  }
  const epoch = conversationEpoch;
  const id = conversation.id;
  conversationBusy = true;
  updateConversationControls();
  try {
    const view = await api<ConversationView>(`/conversations/${encodeURIComponent(id)}/practice`, { expectedRevision: conversation.revision, text: trimmed, runId: delivery.runId });
    if (epoch !== conversationEpoch || !view || view.id !== id) return;
    acceptConversation(view);
    $('conversation-status').textContent = '已收下这句做法。讨论不会改它。下一次明确创建 Run 时，会作为不可信材料带进去。';
    $('conversation-error').textContent = '';
    conversationNeedsRefresh = false;
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    conversationNeedsRefresh = error instanceof ApiError && error.status === 409;
    $('conversation-error').textContent = `${errorMessage(error)}${conversationNeedsRefresh ? '。请先刷新，再收下这句。' : ''}`;
  } finally {
    if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); }
  }
}
async function retractPractice(): Promise<void> {
  const surface = rosterView();
  if (surface !== 'entry' && surface !== 'bot') return;
  const practice = conversation?.acceptedPractice;
  if (!conversation || !practice || conversationBusy || conversationAttempt) return;
  const epoch = conversationEpoch;
  const id = conversation.id;
  conversationBusy = true;
  updateConversationControls();
  try {
    const view = await api<ConversationView>(`/conversations/${encodeURIComponent(id)}/practice/retract`, { expectedRevision: conversation.revision, claimId: practice.claimId });
    if (epoch !== conversationEpoch || !view || view.id !== id) return;
    acceptConversation(view);
    $('conversation-status').textContent = '已撤回这句做法。之后的 Run 不再带上它。';
    $('conversation-error').textContent = '';
    conversationNeedsRefresh = false;
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    conversationNeedsRefresh = error instanceof ApiError && error.status === 409;
    $('conversation-error').textContent = `${errorMessage(error)}${conversationNeedsRefresh ? '。请先刷新，再撤回这句。' : ''}`;
  } finally {
    if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); }
  }
}
async function postTaskSetting(path: string, body: Record<string, unknown>, success: string, refreshHint: string): Promise<void> {
  const surface = rosterView();
  if (surface !== 'entry' && surface !== 'bot') return;
  if (!conversation || conversationBusy || conversationAttempt) return;
  const epoch = conversationEpoch;
  const id = conversation.id;
  conversationBusy = true;
  updateConversationControls();
  try {
    const view = await api<ConversationView>(`/conversations/${encodeURIComponent(id)}/${path}`, { expectedRevision: conversation.revision, ...body });
    if (epoch !== conversationEpoch || !view || view.id !== id) return;
    taskModelBound = '';
    acceptConversation(view);
    $('conversation-status').textContent = success;
    $('conversation-error').textContent = '';
    conversationNeedsRefresh = false;
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    conversationNeedsRefresh = error instanceof ApiError && error.status === 409;
    $('conversation-error').textContent = `${errorMessage(error)}${conversationNeedsRefresh ? `。${refreshHint}` : ''}`;
  } finally {
    if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); }
  }
}
async function saveTaskModel(): Promise<void> {
  const taskKind = currentTaskKind();
  if (!taskKind) {
    $('conversation-error').textContent = '先写任务种类。';
    return;
  }
  const model = $<HTMLInputElement>('task-model').value.trim();
  const provider = $<HTMLInputElement>('task-model-provider').value.trim();
  if (!model) {
    $('conversation-error').textContent = '先写下这种任务要用的模型，或改回默认。';
    return;
  }
  await postTaskSetting('task-model', { taskKind, model, ...(provider ? { provider } : {}) }, '已记下这个任务种类的模型。讨论不会改它。下一次明确创建这种任务的 Run 时，会冻进那次模型决定。', '请先刷新，再改这个模型。');
}
async function clearTaskModel(): Promise<void> {
  const taskKind = currentTaskKind();
  if (!taskKind) return;
  await postTaskSetting('task-model', { taskKind }, '已改回默认。这个任务种类不再指定模型。', '请先刷新，再改这个模型。');
}
async function promoteSkillProfile(): Promise<void> {
  const taskKind = currentTaskKind();
  const runId = promotionRunId();
  if (!taskKind) {
    $('conversation-error').textContent = '先写任务种类。';
    return;
  }
  if (!runId) return;
  await postTaskSetting('skill-profile', { taskKind, runId }, '已晋升这次技能。讨论不会改它。下一次明确创建这种任务的 Run 时，会作为不可信材料带进去。', '请先刷新，再晋升。');
}
async function keepTaskProfile(): Promise<void> {
  const taskKind = currentTaskKind();
  if (!taskKind) return;
  await postTaskSetting('task-kind/keep', { taskKind }, '已留下这份档案。这次做成不会替换它。讨论不会改它。', '请先刷新，再留下这份档案。');
}
async function proposeTaskKind(): Promise<void> {
  const taskKind = currentTaskKind();
  if (!taskKind) return;
  await postTaskSetting('task-kind/propose', { taskKind }, '已送去评测。这次只建立了 proposed 候选。后面还有评估、批准和晋升。', '请先刷新，再送去评测。');
}
async function rollbackSkillProfile(): Promise<void> {
  const taskKind = currentTaskKind();
  const reason = $<HTMLInputElement>('skill-rollback-reason').value.trim();
  if (!taskKind) return;
  if (!reason) {
    $('conversation-error').textContent = '先写下回滚原因。';
    return;
  }
  await postTaskSetting('skill-profile/rollback', { taskKind, reason }, '已回滚到上一版技能。之后这种任务带上的是上一版。', '请先刷新，再回滚。');
}
async function retractSkillProfile(): Promise<void> {
  const taskKind = currentTaskKind();
  const skill = conversation?.taskSettings?.skills.find(item => item.taskKind === taskKind);
  if (!taskKind || !skill) return;
  await postTaskSetting('skill-profile/retract', { taskKind, claimId: skill.claimId }, '已撤回这份技能档案。之后这种任务不再带上它。', '请先刷新，再撤回这份档案。');
}
async function saveStandingInstruction(text: string): Promise<void> {
  const surface = rosterView();
  if (surface !== 'entry' && surface !== 'bot') return;
  if (!conversation || conversationBusy || conversationAttempt) return;
  const trimmed = text.trim();
  if (trimmed.length > 500) {
    $('conversation-error').textContent = '这句话最多 500 字。';
    return;
  }
  const epoch = conversationEpoch;
  const id = conversation.id;
  conversationBusy = true;
  updateConversationControls();
  try {
    const view = await api<ConversationView>(`/conversations/${encodeURIComponent(id)}/standing`, { expectedRevision: conversation.revision, text: trimmed });
    if (epoch !== conversationEpoch || !view || view.id !== id) return;
    acceptConversation(view);
    const field = $<HTMLTextAreaElement>('standing-text');
    if (field) field.value = view.standingInstruction ?? '';
    standingBoundId = view.id;
    $('conversation-status').textContent = trimmed ? '已记住这句话。讨论不会改它。下一次明确创建 Run 时，它会作为不可信材料带进去。' : '已忘掉这句话。之后的 Run 不再带上它。';
    $('conversation-error').textContent = '';
    conversationNeedsRefresh = false;
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    conversationNeedsRefresh = error instanceof ApiError && error.status === 409;
    $('conversation-error').textContent = `${errorMessage(error)}${conversationNeedsRefresh ? '。请先刷新，再改这句话。' : ''}`;
  } finally {
    if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); }
  }
}
async function sendConversation(intent: 'discuss' | 'execute', retry = false): Promise<void> {
  const surface = rosterView();
  if (surface !== 'entry' && surface !== 'bot') return;
  if (!conversation || conversationBusy || (!retry && (conversationAttempt || conversationNeedsRefresh))) return;
  if (!retry) {
    const form = $<HTMLFormElement>('conversation-composer');
    if (!form.reportValidity()) return;
    if (intent === 'execute' && $<HTMLButtonElement>('conversation-execute').disabled) return;
    const target = $<HTMLSelectElement>('conversation-target').value;
    if (conversationCorrectionId && (intent !== 'discuss' || !conversation.tasks.some(task => task.id === target))) return;
    const lifeSpeaker = selectedLifeSpeaker();
    const body = conversationCorrectionId
      ? { text: '纠正这条讨论的任务归属', expectedRevision: conversation.revision, taskIds: [target], correctsMessageId: conversationCorrectionId, intent: 'discuss', focus: 'keep' }
      : { text: $<HTMLTextAreaElement>('conversation-text').value.trim(), expectedRevision: conversation.revision,
        ...(lifeSpeaker ? { speaker: lifeSpeaker } : {}),
        ...(target === '__new' ? { newTask: { title: $<HTMLInputElement>('conversation-task-title').value.trim() } } : { ...(target ? { taskIds: [target] } : intent === 'execute' && !conversationReplyId && conversation.focusTaskId ? { taskIds: [conversation.focusTaskId] } : {}), ...(conversationReplyId ? { replyTo: conversationReplyId } : {}) }),
        focus: $<HTMLSelectElement>('conversation-focus-effect').value, intent, ...(intent === 'execute' ? { ...(currentTaskKind() ? { taskKind: currentTaskKind() } : {}), runOptions: runOptions(true, conversationExecutionGoal()) } : {}) };
    if (!body.text) return;
    conversationAttempt = { conversationId: conversation.id, scope: conversationScope, key: crypto.randomUUID(), body: JSON.stringify(body) };
    saveConversationAttempt();
  }
  const attempt = conversationAttempt;
  if (!attempt) return;
  const epoch = conversationEpoch;
  conversationBusy = true; $('conversation-error').textContent = ''; $('conversation-status').textContent = '正在发送…'; updateConversationControls();
  try {
    const result = await api<ConversationPost>(`/conversations/${encodeURIComponent(attempt.conversationId)}/messages`, JSON.parse(attempt.body), 'POST', attempt.key);
    if (epoch !== conversationEpoch) return;
    if (!result.conversation || result.conversation.id !== attempt.conversationId || !Array.isArray(result.conversation.messages) || !result.message || typeof result.response !== 'string') throw new Error('服务端回执不完整');
    conversationAttempt = undefined; saveConversationAttempt(); conversationReplyId = undefined; conversationCorrectionId = undefined;
    $<HTMLFormElement>('conversation-composer').reset();
    acceptConversation(result.conversation);
    $('conversation-status').textContent = `系统回执：${result.response}`;
    // A Run is only opened on a separate explicit view action. Receiving a notification never steals focus.
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && !error.retrySameRequest) {
      conversationAttempt = undefined; saveConversationAttempt();
      conversationNeedsRefresh = error.status === 409;
      if ([401, 403].includes(error.status)) { resetConversation(); $('conversation-status').textContent = '身份或权限已变化，请重新连接。'; }
    }
    $('conversation-error').textContent = `${errorMessage(error)}${conversationNeedsRefresh ? '。请点击“刷新对话”，核对焦点后再明确发送；不会自动执行。' : conversationAttempt ? '。结果尚未确认，请重试原请求。' : ''}`;
    $('conversation-status').textContent = '';
  } finally { if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); } }
}
$('conversation-composer').addEventListener('submit', event => { event.preventDefault(); void sendConversation('discuss').catch(error => { $('conversation-error').textContent = errorMessage(error); }); });
$('standing-form')?.addEventListener('submit', event => {
  event.preventDefault();
  void saveStandingInstruction($<HTMLTextAreaElement>('standing-text').value).catch(error => { $('conversation-error').textContent = errorMessage(error); });
});
$('standing-clear')?.addEventListener('click', () => {
  void saveStandingInstruction('').catch(error => { $('conversation-error').textContent = errorMessage(error); });
});
$('last-delivery-pin')?.addEventListener('click', () => pinLastDelivery());
$('practice-accept')?.addEventListener('click', () => {
  void acceptPractice($<HTMLTextAreaElement>('practice-text').value).catch(error => { $('conversation-error').textContent = errorMessage(error); });
});
$('task-kind')?.addEventListener('change', () => { taskModelBound = ''; syncTaskSettings(); });
$('task-kind')?.addEventListener('input', () => { taskModelBound = ''; syncTaskSettings(); });
$('task-model-save')?.addEventListener('click', () => { void saveTaskModel().catch(error => { $('conversation-error').textContent = errorMessage(error); }); });
$('task-model-clear')?.addEventListener('click', () => { void clearTaskModel().catch(error => { $('conversation-error').textContent = errorMessage(error); }); });
$('skill-promote')?.addEventListener('click', () => { void promoteSkillProfile().catch(error => { $('conversation-error').textContent = errorMessage(error); }); });
$('task-kind-keep')?.addEventListener('click', () => { void keepTaskProfile().catch(error => { $('conversation-error').textContent = errorMessage(error); }); });
$('task-kind-propose')?.addEventListener('click', () => { void proposeTaskKind().catch(error => { $('conversation-error').textContent = errorMessage(error); }); });
$('skill-rollback')?.addEventListener('click', () => { void rollbackSkillProfile().catch(error => { $('conversation-error').textContent = errorMessage(error); }); });
$('skill-retract')?.addEventListener('click', () => { void retractSkillProfile().catch(error => { $('conversation-error').textContent = errorMessage(error); }); });
$('accepted-practice-retract')?.addEventListener('click', () => {
  void retractPractice().catch(error => { $('conversation-error').textContent = errorMessage(error); });
});
$('conversation-execute').addEventListener('click', () => { void sendConversation('execute').catch(error => { $('conversation-error').textContent = errorMessage(error); }); });
$('execution-review')?.addEventListener('change', () => {
  localStorage.setItem('aeeis.execution-review', executionReviewValue());
  updateConversationControls();
});
for (const id of ['conversation-text', 'conversation-task-title', 'allowed-tools', 'allowed-agents', 'builtin-skill', 'external-budget-calls', 'external-budget-tokens', 'external-budget-usd']) {
  $(id)?.addEventListener('input', () => updateConversationControls());
  $(id)?.addEventListener('change', () => updateConversationControls());
}
$('conversation-retry').addEventListener('click', () => { void sendConversation('discuss', true).catch(error => { $('conversation-error').textContent = errorMessage(error); }); });
$('conversation-target').addEventListener('change', () => {
  if ($<HTMLSelectElement>('conversation-target').value === '__new') { conversationReplyId = undefined; openConversationRoute(); }
  updateConversationControls();
});
$('conversation-cancel-correction').addEventListener('click', () => {
  if (conversationBusy || conversationAttempt) return;
  conversationCorrectionId = undefined; $<HTMLTextAreaElement>('conversation-text').value = ''; updateConversationControls();
});
$('conversation-cancel-reply').addEventListener('click', () => { conversationReplyId = undefined; updateConversationControls(); });
$('conversation-clear-focus').addEventListener('click', () => { void changeConversationFocus(null); });
for (const [id, sync] of [['conversation-refresh', false], ['conversation-sync', true]] as const) {
  $(id).addEventListener('click', () => {
    void refreshConversation(sync).then(() => {
      conversationNeedsRefresh = false; $('conversation-error').textContent = '';
      $('conversation-status').textContent = sync ? '任务通知已同步；讨论焦点由服务端保留。' : '已刷新。请核对讨论焦点和任务，再明确发送。'; updateConversationControls();
    }).catch(error => { $('conversation-error').textContent = errorMessage(error); });
  });
}
$('conversation-select').addEventListener('change', async () => {
  if (conversationBusy || conversationAttempt) return;
  const id = $<HTMLSelectElement>('conversation-select').value, epoch = ++conversationEpoch;
  conversationBusy = true; updateConversationControls();
  try {
    const view = await api<ConversationView>(`/conversations/${encodeURIComponent(id)}`);
    if (epoch !== conversationEpoch) return;
    conversation = undefined; conversationReplyId = undefined; conversationCorrectionId = undefined; conversationNeedsRefresh = false;
    $<HTMLFormElement>('conversation-composer').reset(); $('conversation-status').textContent = ''; $('conversation-error').textContent = ''; acceptConversation(view);
  } catch (error) { if (epoch === conversationEpoch) $('conversation-error').textContent = errorMessage(error); }
  finally { if (epoch === conversationEpoch) { conversationBusy = false; renderConversation(); } }
});
$('conversation-new').addEventListener('click', async () => {
  if (!conversationEnabled || conversationBusy || conversationAttempt) return;
  const epoch = conversationEpoch; conversationBusy = true; updateConversationControls();
  try {
    const view = await api<ConversationView>('/conversations', {});
    if (epoch !== conversationEpoch) return;
    conversationReplyId = undefined; conversationCorrectionId = undefined; conversationNeedsRefresh = false; $<HTMLFormElement>('conversation-composer').reset();
    $('conversation-status').textContent = '新对话已建立。普通发送只记录讨论。'; $('conversation-error').textContent = ''; acceptConversation(view);
  } catch (error) { if (epoch === conversationEpoch) $('conversation-error').textContent = errorMessage(error); }
  finally { if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); } }
});
$('bots')?.addEventListener('click', event => {
  const target = (event.target as HTMLElement | null)?.closest('button');
  if (!target || !$('bots')?.contains(target)) return;
  if (target.dataset.botId) selectBot(target.dataset.botId);
  else if (target.dataset.roomId) void openGroup(target.dataset.roomId).catch(error => message(errorMessage(error)));
  else if (target.dataset.groupId) renameBotGroup(target.dataset.groupId);
});
$('bot-group-draft')?.addEventListener('submit', createBotGroup);
$('gb-new-bot-group')?.addEventListener('click', () => {
  const draft = $('bot-group-draft');
  if (draft) draft.hidden = !draft.hidden;
});
$('gb-new-group')?.addEventListener('click', () => showGroupDraft());
$('group-add-person')?.addEventListener('click', () => addDraftPerson());
$('group-create')?.addEventListener('submit', event => { void createGroup(event).catch(error => message(errorMessage(error))); });
$('group-composer')?.addEventListener('submit', event => { void submitGroupMessage(event).catch(error => message(errorMessage(error))); });
$('group-text')?.addEventListener('input', () => renderMentions());
$('group-rename')?.addEventListener('click', () => { void renameGroup().catch(error => message(errorMessage(error))); });
$('chat-archive')?.addEventListener('click', () => { void archiveOpenChat().catch(error => message(errorMessage(error))); });
$('entry-back')?.addEventListener('click', () => showRoster(true));
$('entry-computer')?.addEventListener('click', () => {
  const open = document.body.classList.toggle('computer-open');
  const button = $<HTMLButtonElement>('entry-computer');
  button.setAttribute('aria-pressed', String(open));
  button.textContent = open ? '关上工作台' : '打开它的工作台';
});

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
  const answer = $<HTMLTextAreaElement>('answer');
  if (heading) heading.textContent = mode === 'answer' ? '需要你的信息' : '核查外部结果';
  if (submit) submit.textContent = mode === 'answer' ? '提交并继续' : '提交核查并继续';
  if (answer) answer.placeholder = mode === 'answer' ? '可直接粘贴资料、约束、链接或补充说明…' : '说明外部调用是否已经完成，或提供核查依据…';
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  answer.focus();
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
      ? formatTime(run.updatedAt)
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
function renderThreadTimeline(page: ThreadPage, throughSequence?: number): void {
  $('thread-panel').hidden = false;
  $('thread-title').textContent = page.title ?? '对话 Thread';
  $('thread-meta').textContent = throughSequence === undefined ? page.id : `只读分享 · 截至运行 #${throughSequence}`;
  const list = $('thread-timeline'); list.replaceChildren();
  for (const run of page.runs) {
    const item = element('li', '', 'fact-row');
    item.append(element('strong', `#${run.threadSequence} · ${runStatusLabel(run.status)} · ${run.goal}`));
    if (run.outputExcerpt) item.append(element('pre', run.outputExcerpt.slice(0, 1000)));
    if (run.parentRunId) {
      if (readOnlyShare) item.append(element('small', `父运行 #${page.runs.find(parent => parent.id === run.parentRunId)?.threadSequence ?? ''}`));
      else { const link = element('a', '父运行'); link.href = `/runs/${run.parentRunId}`; item.append(link); }
    }
    if (!readOnlyShare) { const link = element('a', '打开运行'); link.href = `/runs/${run.id}`; item.append(link); }
    item.append(button(run.status === 'needs_input' && !readOnlyShare ? '回答当前问题' : '查看运行', async () => {
      currentId = run.id; await refresh();
      if (run.status === 'needs_input' && !readOnlyShare) openInputPanel('answer');
      else $('run-title').focus();
    }));
    list.append(item);
  }
  if (!page.runs.length) list.append(element('li', '还没有可显示的运行。', 'muted'));
  $('thread-followup').hidden = readOnlyShare;
  $('thread-share-controls').hidden = readOnlyShare;
  $('thread-more').hidden = readOnlyShare || page.nextAfterSequence === undefined;
  if (readOnlyShare) return;
  // Preserve the parent's selection while an ambiguous POST can be retried,
  // including a root POST whose run has appeared since its response was lost.
  if (pendingFollowup) { $<HTMLButtonElement>('thread-submit').disabled = followupSubmitting; return; }
  const select = $<HTMLSelectElement>('thread-parent'), previous = select.value;
  const parents = page.runs.filter(run => ['succeeded', 'failed', 'cancelled'].includes(run.status));
  select.replaceChildren(...parents.map(run => { const option = element('option', `#${run.threadSequence} · ${run.goal}`); option.value = run.id; return option; }));
  if (parents.some(run => run.id === previous)) select.value = previous;
  else if (parents.length) {
    select.value = parents.at(-1)!.id;
    $<HTMLSelectElement>('thread-privacy').value = parents.at(-1)!.privacy ?? 'internal';
  }
  select.disabled = !parents.length;
  $<HTMLButtonElement>('thread-submit').disabled = Boolean(page.runs.length && !parents.length);
  $('thread-followup-note').textContent = !page.runs.length ? '提交后创建第一个运行。' : parents.length ? '后续消息会创建新运行。' : '运行结束后可以继续；当前问题请使用「回答当前问题」。';
}
async function refreshThread(): Promise<void> {
  try {
    const pages = await Promise.all(threadPagesAfter.map(after => api<ThreadPage>(`/threads/${linkedThreadId}?limit=50&afterSequence=${after}`)));
    threadRuns = pages.flatMap(page => page.runs);
    threadNextAfter = pages.at(-1)!.nextAfterSequence;
    renderThreadTimeline({ ...pages[0]!, runs: threadRuns, ...(threadNextAfter === undefined ? {} : { nextAfterSequence: threadNextAfter }) });
    currentId ||= threadRuns.at(-1)?.id ?? '';
    if (!currentId) { stopRunEventStream(); $('detail').hidden = true; return; }
    const run = await api<RunView>(`/runs/${currentId}`);
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) stopRunEventStream(); else ensureRunEventStream(run.id);
    const [graphs, explanation] = await Promise.all([api<RunGraphsView>(`/runs/${run.id}/graphs`), api<RunExplanation>(`/runs/${run.id}/explanation`)]);
    current = { ...run, graphs }; setCurrentRunOpen(true); render(current); renderExplanation(explanation);
  } catch (error) {
    stopRunEventStream(); current = undefined; $('detail').hidden = true; $('thread-panel').hidden = true;
    throw error;
  }
}
async function refresh(): Promise<void> {
  if (readOnlyShare) {
    try {
      const view = await api<(RunView & { explanation: RunExplanation }) | ThreadShareView>(`/share/${shareToken}`);
      if ('kind' in view && view.kind === 'thread') {
        document.body.classList.add('thread-page');
        renderThreadTimeline({ ...view.thread, runs: view.runs.map(run => ({ ...run, threadSequence: run.threadSequence!, outputExcerpt: run.artifacts.at(-1)?.content ?? '' })) }, view.throughSequence);
        const run = view.runs.find(run => run.id === currentId) ?? view.runs.at(-1);
        if (!run) { current = undefined; currentId = ''; $('detail').hidden = true; return; }
        currentId = run.id; current = run;
        setCurrentRunOpen(true); setRunDetailsMode(true); render(run); renderExplanation(run.explanation);
      } else {
        const run = view as RunView & { explanation: RunExplanation };
        currentId = run.id; current = run;
        setCurrentRunOpen(true); setRunDetailsMode(true);
        render(run); renderExplanation(run.explanation);
      }
      $('controls').replaceChildren();
      $('decision-review-actions').replaceChildren();
      $('decision-next-button').hidden = true;
      $('input-panel').hidden = true;
    } catch (error) {
      current = undefined; $('detail').hidden = true; $('thread-panel').hidden = true;
      throw error;
    }
    return;
  }
  if (linkedThreadId) { await refreshThread(); return; }
  if (conversationEnabled) await refreshConversation().catch(error => { $('conversation-error').textContent = errorMessage(error); });
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
  agentSummaries = agents;
  agentsLoaded = true;
  roomSummaries = rooms;
  await renderRooms(rooms); await renderGoals(goals, runs, rooms); renderCandidates(candidates); renderImprovementSignals(signals); renderCollaborations(competitions, debates, projections, triggerPolicies, triggerDecisions); renderAgents(agents); renderReminders(reminderItems);
  renderBotRoster();
  renderGroups(rooms);
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
    item.append(element('strong', `${runStatusLabel(reminder.status)} · ${reminder.title}`), element('small', `${formatTime(reminder.dueAt)} · ${reminder.delivery.channel} → ${reminder.delivery.destination} · ${privacyLabel(reminder.privacy)}`), element('small', reminder.message));
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
function showRunPulse(eventName: string, data?: { phase?: string; reason?: string }): void {
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
  text.textContent = labels[eventName] ?? describeEvent(eventName, data, true);
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
            let phase: string | undefined;
            try {
              const payload = data ? JSON.parse(data) as { type?: unknown; eventType?: unknown; data?: { phase?: unknown } } : undefined;
              if (typeof payload?.type === 'string') eventName = payload.type;
              else if (typeof payload?.eventType === 'string') eventName = payload.eventType;
              if (typeof payload?.data?.phase === 'string') phase = payload.data.phase;
            } catch { /* the refresh still handles non-JSON event payloads */ }
            showRunPulse(eventName, phase ? { phase } : undefined);
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
    item.append(element('strong', `${signal.kind} · ${signal.candidateId ? '已形成候选' : signal.proposal ? '待评测' : '待补全提案'}`), element('small', `${signal.reason} · ${formatTime(signal.occurredAt)}`), element('small', `Run ${signal.runId} · 证据 ${signal.sourceRefs.join(', ')}`));
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
        for (const event of events) list.append(element('li', `${event.action} · ${event.actor} · ${formatTime(event.at)}`));
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
    ['工具', Boolean(status.toolsConfigured && status.toolsHealth?.ready), status.toolsConfigured ? status.toolsHealth?.detail ?? '已配置，健康状态未验证' : '未配置'],
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
    item.append(element('strong', `${runStatusLabel(competition.status)} · ${competition.brief.goal.slice(0, 48)}`), element('small', `${competition.candidates.length}/${competition.brief.participantAgentIds.length} 个候选 · ${competition.scores.length} 个评分${competition.selectedAgentId ? ` · 已选 ${competition.selectedAgentId}` : ''}`), element('small', collaborationCostText(competition.usage, competition.brief.modelBudget)), element('small', competition.failureReason ?? ''), element('small', formatTime(competition.updatedAt)));
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
    item.append(element('strong', `${runStatusLabel(debate.status)} · ${(debate.room.goal ?? debate.room.taskId).slice(0, 48)}`), element('small', `${debate.room.messages.length} 条消息 · ${debate.room.participantAgentIds.length} 个 Agent${flagged ? ` · ${flagged} 条被标记` : ''}${unsettled ? ` · ${unsettled} 条待处理` : ''}${adjudication}`), element('small', collaborationCostText(debate.usage, debate.modelBudget)), element('small', debate.closeReason ?? ''), element('small', formatTime(debate.updatedAt)));
    item.append(button('查看消息与裁决', async () => { showCollaborationDetails(item, `Debate ${debate.id}`, await api(`/collaborations/debates/${encodeURIComponent(debate.id)}`)); }));
    if (debate.status === 'active') item.append(button('运行 Debate', async () => { await api(`/collaborations/debates/${encodeURIComponent(debate.id)}/run`, {}); await refresh(); }));
    for (const attempt of debate.attempts ?? []) if (['started', 'unknown'].includes(attempt.state)) item.append(button(`核查 ${attempt.slot}`, () => reconcileDebateAttempt(debate.id, attempt)));
    if (debate.status === 'active') item.append(button('关闭 Debate', async () => { const reason = window.prompt('关闭原因（必填）')?.trim(); if (reason) { await api(`/collaborations/debates/${encodeURIComponent(debate.id)}/close`, { reason }); await refresh(); } }));
    debateList.append(item);
  }
  const projectionList = $('projections'); projectionList.replaceChildren(); $('projections-empty').hidden = projections.length > 0;
  for (const projection of projections.slice(-12).reverse()) {
    const item = element('div', '', `fact-row projection-${projection.status}`);
    item.append(element('strong', `${runStatusLabel(projection.status)} · ${projection.aggregateType}:${projection.aggregateId}`), element('small', `${projection.channel} → ${projection.destination} · ${projection.attempts} 次尝试`), element('small', projection.lastError ?? formatTime(projection.updatedAt)));
    projectionList.append(item);
  }
  const policyList = $('trigger-policies'); policyList.replaceChildren(); $('trigger-policies-empty').hidden = triggerPolicies.length > 0;
  for (const policy of triggerPolicies.slice(0, 12)) {
    const item = element('div', '', `fact-row trigger-policy-${policy.enabled ? 'enabled' : 'disabled'}`);
    item.append(element('strong', `${policy.enabled ? '启用' : '停用'} · ${policy.name}`), element('small', `${policy.id} · ${policy.eventTypes.join(', ')} · ${policy.action.type}/${policy.action.dispatch}`), element('small', `participants: ${policy.action.participantAgentIds.join(', ')}`), element('small', formatTime(policy.updatedAt)));
    item.append(button(policy.enabled ? '停用' : '启用', async () => { await api(`/collaborations/triggers/policies/${encodeURIComponent(policy.id)}`, { enabled: !policy.enabled }, 'PATCH'); await refresh(); }));
    item.append(button('删除', async () => { if (window.confirm(`删除 Trigger Policy ${policy.name}？`)) { await api(`/collaborations/triggers/policies/${encodeURIComponent(policy.id)}`, undefined, 'DELETE'); await refresh(); } }));
    policyList.append(item);
  }
  const decisionList = $('trigger-decisions'); decisionList.replaceChildren(); $('trigger-decisions-empty').hidden = triggerDecisions.length > 0;
  for (const decision of triggerDecisions.slice(0, 20)) {
    const item = element('div', '', `fact-row trigger-decision-${decision.state}`);
    item.append(element('strong', `${runStatusLabel(decision.state)} · ${decision.actionType}`), element('small', `${decision.policyId} · ${decision.eventId}`), element('small', `${runStatusLabel(decision.dispatchState)}${decision.resourceId ? ` · ${decision.resourceId}` : ''}`), element('small', decision.error ?? decision.dispatchError ?? formatTime(decision.startedAt)));
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
    item.append(element('strong', room.title + ' · ' + runStatusLabel(room.status)), element('small', room.id + ' · ' + formatTime(room.updatedAt)));
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
  heading.append(element('strong', `#${event.sequence} · ${event.type}${operation}${revision}`), element('small', `${event.actorId} · ${formatTime(event.createdAt)}`));
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
          for (const receipt of snapshot.receipts) list.append(element('li', `${receipt.taskId} · ${receipt.transition} · ${formatTime(receipt.occurredAt)}${receipt.reason ? ` · ${receipt.reason}` : ''}`));
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
function formatMaterialFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function renderMaterialFiles(status?: string): void {
  const list = $('material-file-list');
  const label = $('material-files-status');
  const clear = $('clear-material-files') as HTMLButtonElement | null;
  if (!list || !label) return;
  list.replaceChildren();
  for (const file of selectedMaterialFiles) {
    const item = element('li');
    item.append(element('span', file.name), element('small', formatMaterialFileSize(file.size)));
    list.append(item);
  }
  if (clear) clear.hidden = selectedMaterialFiles.length === 0 && !materialFilesLoading;
  if (status) label.textContent = status;
  else if (materialFilesLoading) label.textContent = '正在读取资料…';
  else if (selectedMaterialFiles.length) label.textContent = `${selectedMaterialFiles.length} 个文件已绑定到本次 Run`;
  else label.textContent = '支持 TXT、Markdown、CSV、JSON 和 AcroForm PDF（最多 512 KB）；文件只绑定当前 Run。';
}
async function readMaterialFiles(files: FileList | null): Promise<void> {
  const sequence = ++materialFileReadSequence;
  const incoming = [...(files ?? [])];
  if (!incoming.length) return;
  materialFilesLoading = true;
  renderMaterialFiles();
  const accepted = incoming.slice(0, MAX_MATERIAL_FILES);
  const skipped: string[] = incoming.length > MAX_MATERIAL_FILES ? incoming.slice(MAX_MATERIAL_FILES).map(file => file.name) : [];
  const loaded: Array<{ name: string; content: string; size: number }> = [];
  for (const file of accepted) {
    const extension = file.name.toLocaleLowerCase().split('.').pop() ?? '';
    const pdf = extension === 'pdf' || file.type === 'application/pdf';
    const supported = pdf || ['txt', 'md', 'markdown', 'csv', 'json'].includes(extension) || ['text/plain', 'text/markdown', 'text/csv', 'application/json'].includes(file.type);
    if (!supported) { skipped.push(`${file.name}（不支持的文件格式）`); continue; }
    if (pdf && file.size > 512 * 1024) { skipped.push(`${file.name}（PDF 超过 512 KB）`); continue; }
    if (file.size > MAX_MATERIAL_FILE_BYTES) { skipped.push(`${file.name}（超过 1 MB）`); continue; }
    try {
      let content: string;
      if (pdf) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        content = `data:application/pdf;base64,${btoa(binary)}`;
      } else content = (await file.text()).slice(0, MAX_MATERIAL_CONTENT_LENGTH).trim();
      if (!content) { skipped.push(`${file.name}（内容为空）`); continue; }
      loaded.push({ name: file.name.slice(0, 200), content, size: file.size });
    } catch { skipped.push(`${file.name}（读取失败）`); }
  }
  if (sequence !== materialFileReadSequence) return;
  selectedMaterialFiles = loaded;
  materialFilesLoading = false;
  renderMaterialFiles(skipped.length ? `已载入 ${loaded.length} 个文件；跳过 ${skipped.join('、')}` : undefined);
}
($('material-files') as HTMLInputElement | null)?.addEventListener('change', event => {
  void readMaterialFiles((event.target as HTMLInputElement).files).catch(error => {
    materialFilesLoading = false;
    renderMaterialFiles('资料读取失败，请重新选择文本文件');
    message(errorMessage(error));
  });
});
($('clear-material-files') as HTMLButtonElement | null)?.addEventListener('click', () => {
  materialFileReadSequence += 1;
  materialFilesLoading = false;
  selectedMaterialFiles = [];
  const input = $<HTMLInputElement>('material-files');
  if (input) input.value = '';
  renderMaterialFiles();
});
renderMaterialFiles();
function listedIds(id: string): string[] {
  return [...new Set($<HTMLInputElement>(id).value.split(',').map(value => value.trim()).filter(Boolean))];
}
function externalBudgetPresent(): boolean {
  return ['external-budget-calls', 'external-budget-tokens', 'external-budget-usd'].some(id => $<HTMLInputElement>(id).value.trim());
}
function conversationExecutionGoal(): string {
  const text = $<HTMLTextAreaElement>('conversation-text').value.trim();
  const target = $<HTMLSelectElement>('conversation-target').value;
  const title = target === '__new' ? $<HTMLInputElement>('conversation-task-title').value.trim() : (conversationTargetTask()?.title ?? '当前任务');
  return `任务：${title || '当前任务'}\n当前请求：${text}`;
}
function currentPlanningDecision(goal = conversationExecutionGoal()) {
  const builtinSkill = $<HTMLSelectElement>('builtin-skill').value;
  return planningDecision({
    goal,
    ...(builtinSkill ? { builtinSkill } : {}),
    allowedTools: listedIds('allowed-tools'),
    allowedAgents: listedIds('allowed-agents'),
    ...(externalBudgetPresent() ? { externalBudget: { calls: 1 } } : {}),
  });
}
function executionReviewValue(): 'required' | 'auto' | 'yolo' {
  const value = $<HTMLSelectElement>('execution-review')?.value;
  return value === 'auto' || value === 'yolo' ? value : 'required';
}
function restoreExecutionReview(): void {
  const saved = localStorage.getItem('aeeis.execution-review');
  const select = $<HTMLSelectElement>('execution-review');
  if (!select) return;
  select.value = saved === 'auto' || saved === 'yolo' ? saved : 'required';
}
function executionReviewNote(): string {
  const mode = executionReviewValue();
  const decision = currentPlanningDecision();
  const gate = mode === 'yolo'
    ? '自动执行：计划生成后直接执行，不再停下来等批准。讨论焦点不会因此改变。'
    : mode === 'auto'
      ? (decision.shape === 'direct'
        ? '自动：这次只有一个只读步骤，由边界放行，不调用规划模型。讨论焦点不会因此改变。'
        : '自动：模型判断要不要请你批准。它不能扩大工具或权限。判断缺失时仍等待批准。')
      : '需要审批：创建执行后请在任务行核对计划，再明确批准。';
  const shape = decision.shape === 'direct'
    ? '这次直接执行：跳过规划模型，写入一个步骤，仍按上面的审核档放行。'
    : `这次先出任务图：${planningRefusal(decision.reason)}。`;
  return `${gate}${shape}`;
}
function runOptions(includeProjectQuery = true, goal = ''): Record<string, unknown> {
  const content = $<HTMLTextAreaElement>('materials').value.trim();
  const knowledgeQuery = $<HTMLInputElement>('knowledge-query').value.trim();
  const allowedTools = listedIds('allowed-tools');
  const allowedAgents = listedIds('allowed-agents');
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
  if (materialFilesLoading) throw new Error('资料仍在读取，请稍候再启动 Run');
  const materials = [
    ...(content ? [{ title: '用户提供的项目资料', source: 'user-input', content }] : []),
    ...selectedMaterialFiles.map(file => ({ title: file.name, source: `browser-file:${file.name}`, content: file.content })),
  ];
  const planning = includeProjectQuery ? currentPlanningDecision(goal || conversationExecutionGoal()).shape : undefined;
  return { executionReview: executionReviewValue(), ...(planning ? { planning } : {}), ...(builtinSkill ? { builtinSkill } : {}), materials, privacy: $<HTMLSelectElement>('privacy').value, allowedTools, ...(allowedAgents.length ? { allowedAgents } : {}), ...(Object.keys(externalBudget).length ? { externalBudget } : {}), ...(modelBudget && Object.keys(modelBudget).length ? { modelBudget } : {}), ...(knowledgeQuery ? { knowledgeQuery } : {}), ...(memoryQuery ? { memoryQuery } : {}), ...(brainScope ? { brainScope } : {}), ...(brainQuery ? { brainQuery } : {}), ...(projectSourceQuery ? { projectSourceQuery } : {}) };
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
  const latest = run.events.at(-1);
  const compacting = ['running', 'reviewing'].includes(run.status) ? compactionProgress(latest) : undefined;
  const [title, detail] = compacting ?? copy[run.status] ?? ['运行状态已更新', `当前状态：${run.status}`];
  if (stage.textContent !== title) stage.textContent = title;
  const anchor = run.events.find(event => ['run.created', 'run.started', 'run.planned'].includes(event.type))?.at ?? run.updatedAt;
  const elapsedMs = anchor ? Date.now() - Date.parse(anchor) : 0;
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? formatElapsed(elapsedMs) : '';
  const activityMeta = `${detail}${elapsed ? ` · 已${['queued', 'planning'].includes(run.status) ? '等待' : '运行'} ${elapsed}` : ''}${latest ? ` · 最新事件 ${describeEvent(latest.type, latest.data, true)}` : ''}`;
  if (meta.textContent !== activityMeta) meta.textContent = activityMeta;
  const trail = $('activity-trail');
  if (trail) {
    const trailEvents = run.events.slice(-3);
    const trailSignature = trailEvents.map(event => `${event.seq}:${event.type}:${event.at}`).join('|');
    if (trail.dataset.signature !== trailSignature) {
      trail.replaceChildren();
      for (const event of trailEvents) {
        const item = element('li', describeEvent(event.type, event.data));
        item.title = `${describeEvent(event.type, event.data, true)} · ${event.type} · ${formatTime(event.at)}`;
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
      const modelBudget = [run.modelBudget?.tokens === undefined ? '' : `${run.modelBudget.tokens.toLocaleString()} tokens`, run.modelBudget?.moneyUsd === undefined ? '' : `$${run.modelBudget.moneyUsd.toFixed(2)}`].filter(Boolean).join(' / ') || '未设置';
      const externalBudget = [run.externalBudget?.calls === undefined ? '' : `${run.externalBudget.calls} 次调用`, run.externalBudget?.tokens === undefined ? '' : `${run.externalBudget.tokens.toLocaleString()} tokens`, run.externalBudget?.moneyUsd === undefined ? '' : `$${run.externalBudget.moneyUsd.toFixed(2)}`].filter(Boolean).join(' / ') || '未设置';
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
      const writable = !readOnlyShare && run.canEdit !== false;
      const editor = planReview(run, command, writable);
      reviewTasks.append(editor.root);
      if (writable) {
        const approve = button('批准并执行', editor.approve);
        approve.className = 'decision-primary';
        reviewActions.append(approve);
      }
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
    else if (run.status === 'needs_approval' && plan && !readOnlyShare && run.canEdit !== false) installAction('批准并执行', planReview(run, command, true).approve);
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
  if (nextButton && (readOnlyShare || run.canEdit === false)) { nextButton.hidden = true; nextButton.onclick = null; }
}
interface MemoryOriginalSummary { id?: string; originalId?: string; locator?: string; phase?: string; totalChars?: number; excerpt?: string }
function renderWorkingMemory(run: RunView): void {
  const panel = $('working-memory-panel'), content = $('working-memory-content');
  panel.hidden = readOnlyShare || run.canEdit !== true || !run.workingMemoryEnabled;
  if (panel.hidden) { content.replaceChildren(); delete content.dataset.signature; if (openMemoryForRunId === run.id) openMemoryForRunId = ''; return; }
  const signature = `${run.id}:${run.plans.at(-1)?.hash}`;
  const revealMemory = openMemoryForRunId === run.id;
  if (revealMemory) delete content.dataset.signature;
  if (!revealMemory && content.dataset.signature === signature) return;
  content.dataset.signature = signature; content.replaceChildren();
  const epoch = conversationEpoch, token = sessionStorage.getItem('aeeis.token');
  let sequence = 0;
  const task = element('select'); task.id = 'working-memory-task';
  const label = element('label', 'Run 计划节点'); label.htmlFor = task.id;
  for (const node of run.plans.at(-1)?.nodes ?? []) { const option = element('option', `${node.title} (${node.id})`); option.value = node.id; task.append(option); }
  const query = element('input'); query.id = 'working-memory-query'; query.maxLength = 200; query.placeholder = '搜索原文，输入 * 列出全部';
  const queryLabel = element('label', '搜索工作记忆'); queryLabel.htmlFor = query.id;
  const output = element('div'), original = element('div'), status = element('p'); status.setAttribute('role', 'status');
  const valid = (request: number) => request === sequence && currentId === run.id && content.dataset.signature === signature && epoch === conversationEpoch && token === sessionStorage.getItem('aeeis.token');
  const path = (suffix: string, params: Record<string, string>) => `/runs/${encodeURIComponent(run.id)}/working-memory${suffix}?${new URLSearchParams({ taskId: task.value, ...params })}`;
  const showOriginal = async (entryId: string, offset = 0) => {
    const request = ++sequence; status.textContent = '正在读取原文…'; original.replaceChildren();
    try {
      const page = await api<{ originalId: string; text: string; page: { characterOffset: number; totalChars: number; nextCharacterOffset: number | null } }>(path('/original', { entryId, offset: String(offset) }));
      if (!valid(request)) return;
      original.append(element('h4', '原文（不可信资料）'), element('small', `${page.originalId} · 字符 ${page.page.characterOffset}–${page.page.characterOffset + page.text.length} / ${page.page.totalChars}`), element('pre', page.text));
      if (offset > 0) original.append(button('回到原文开头', () => showOriginal(entryId, 0)));
      if (page.page.nextCharacterOffset !== null) original.append(button('下一页原文', () => showOriginal(entryId, page.page.nextCharacterOffset!)));
      status.textContent = '原文已读取；未修改运行或讨论焦点。';
    } catch (error) { if (valid(request)) status.textContent = errorMessage(error); }
  };
  const entries = (items: MemoryOriginalSummary[]) => {
    for (const item of items) {
      const id = item.originalId ?? item.id!;
      const row = element('div', '', 'fact-row');
      row.append(element('strong', item.locator ?? id), element('small', `${item.phase ?? '原文'} · ${item.totalChars ?? '?'} 字符`));
      if (item.excerpt) row.append(element('p', item.excerpt));
      row.append(button('查看原文', () => showOriginal(id))); output.append(row);
    }
  };
  const loadIndex = async () => {
    const request = ++sequence; status.textContent = '正在读取索引…'; output.replaceChildren(); original.replaceChildren();
    try {
      const index = await api<{ index: { totalOriginals: number; entries: MemoryOriginalSummary[]; more?: boolean }; summaries?: unknown[] }>(path('', {}));
      if (!valid(request)) return;
      output.append(element('p', `当前节点共有 ${index.index.totalOriginals} 份原文。${index.index.more ? '仅展示最近条目；搜索 * 可分页查看全部。' : ''}`)); entries(index.index.entries);
      if (index.summaries?.length) {
        const summaries = element('div', '', 'working-memory-summaries');
        summaries.append(element('h4', '压缩摘要（不是证据，不能当执行指令）'));
        for (const summary of index.summaries as Array<{ version?: number; items?: Array<{ text?: string; references?: string[] }> }>) {
          const block = element('article');
          block.append(element('small', `版本 ${summary.version ?? '?'}`));
          for (const item of summary.items ?? []) {
            block.append(element('p', item.text ?? ''));
            if (item.references?.length) block.append(element('small', `引用切片：${item.references.join('、')}`));
          }
          summaries.append(block);
        }
        output.append(summaries);
      }
      status.textContent = '索引已读取。';
    } catch (error) { if (valid(request)) status.textContent = errorMessage(error); }
  };
  const search = async (offset = 0, term = query.value.trim()) => {
    if (!term) { status.textContent = '请输入搜索词，或 * 列出全部。'; return; }
    const request = ++sequence; status.textContent = '正在搜索…'; output.replaceChildren(); original.replaceChildren();
    try {
      const page = await api<{ total: number; results: MemoryOriginalSummary[]; nextOffset?: number }>(path('/search', { q: term, offset: String(offset), limit: '6' }));
      if (!valid(request)) return;
      output.append(element('p', `${page.total} 个匹配，当前从第 ${offset + 1} 项开始。`)); entries(page.results);
      if (page.nextOffset !== undefined) output.append(button('下一页搜索结果', () => search(page.nextOffset, term)));
      status.textContent = page.total ? '搜索完成。' : '没有匹配的原文。';
    } catch (error) { if (valid(request)) status.textContent = errorMessage(error); }
  };
  task.onchange = () => { sequence++; output.replaceChildren(); original.replaceChildren(); status.textContent = '已选择节点，请读取索引或搜索。'; };
  const searchForm = element('form'); searchForm.append(queryLabel, query);
  const submit = element('button', '搜索原文'); submit.type = 'submit'; searchForm.append(submit);
  searchForm.onsubmit = event => { event.preventDefault(); void search(); };
  content.append(label, task, button('读取节点索引', loadIndex), searchForm, status, output, original);
  if (revealMemory) {
    openMemoryForRunId = '';
    const details = $<HTMLDetailsElement>('working-memory-details');
    details.open = true;
    details.scrollIntoView({ behavior: 'smooth', block: 'start' });
    void loadIndex();
  }
}
function render(run: RunView): void {
  renderWorkingMemory(run);
  document.body.classList.toggle('run-open', currentRunOpen);
  const shareResult = $('run-share-result');
  if (shareResult.dataset.runId !== run.id) { shareResult.replaceChildren(); shareResult.dataset.runId = run.id; }
  if (!readOnlyShare && !linkedThreadId && !conversationEnabled && window.location.pathname !== `/runs/${run.id}`) window.history.replaceState(null, '', `/runs/${run.id}`);
  $('create-run-share').hidden = readOnlyShare || run.canEdit === false;
  const threadLink = $<HTMLAnchorElement>('run-thread-link');
  threadLink.hidden = readOnlyShare || !run.threadId;
  if (run.threadId && !readOnlyShare) threadLink.href = `/threads/${run.threadId}`;
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
  const creditTotal = (run.toolReceipts ?? []).reduce((sum, receipt) => sum + (receipt.cost?.credits ?? 0), 0);
  const unsettled = (run.toolReceipts ?? []).filter(receipt => receipt.costStatus === 'interrupted' || receipt.costStatus === 'unreported').length;
  if (run.toolReceipts?.length) effects.append(element('li', `工具费用合计 ${creditTotal} credits${unsettled ? ` · ${unsettled} 次未结算` : ''}`));
  for (const receipt of run.toolReceipts ?? []) effects.append(element('li', `Tool ${receipt.operation} · ${runStatusLabel(receipt.status)} · ${receipt.cost?.credits !== undefined ? `${receipt.cost.credits} credits · ` : receipt.costStatus === 'interrupted' ? '费用未结算(中断) · ' : ''}${receipt.authorization ? `接纳=${receipt.authorization.decision}(${receipt.authorization.reason}) · ` : ''}${receipt.receiptId}${receipt.errorCode ? ` · ${receipt.errorCode}` : ''}`));
  for (const outcome of run.delegationOutcomes ?? []) effects.append(element('li', `Agent ${outcome.agentId ?? 'external'} · ${runStatusLabel(outcome.status)} · ${outcome.receiptRef}`));
  if (run.pendingTool) effects.append(element('li', `等待 Tool reconcile：${run.pendingTool.toolId} · ${run.pendingTool.receiptId ?? '尚未生成 receipt'}`, 'failure'));
  if (run.pendingDelegation) effects.append(element('li', `等待 Agent reconcile：${run.pendingDelegation.agentId} · ${run.pendingDelegation.receiptRef ?? '尚未生成 receipt'}`, 'failure'));
  if (!effects.children.length) effects.append(element('li', '本次运行没有外部 Tool 或 Agent 调用记录', 'muted'));
  const progressList = $('agent-progress'); progressList.replaceChildren();
  const progress = [...(run.agentProgress ?? [])].sort((a, b) => a.progress.at.localeCompare(b.progress.at) || a.progress.sequence - b.progress.sequence);
  for (const item of progress) {
    const value = item.progress;
    const row = element('li', '', 'agent-progress-item');
    row.append(element('time', formatTime(value.at)), element('strong', `${runStatusLabel(value.status)} · ${value.agentId} · #${value.sequence}`), element('span', value.percent === undefined ? value.message : `${value.message} · ${value.percent}%`));
    if (value.evidenceRefs.length || value.artifactRefs.length) row.append(element('small', `引用：${[...value.evidenceRefs, ...value.artifactRefs].join(', ')}`));
    progressList.append(row);
  }
  if (!progressList.children.length) progressList.append(element('li', '当前没有外部 Agent 流式进度', 'muted'));
  const controls = $('controls'); controls.replaceChildren();
  controls.hidden = readOnlyShare || run.canEdit === false;
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
  const contextSummary: string[] = [];
  if (run.context?.manifestHash) contextSummary.push(`Context Manifest hash ${run.context.manifestHash}`);
  if (run.context?.memoryManifestId) contextSummary.push(`Goal Memory Manifest：${run.context.memoryManifestId} · hash ${run.context.memoryManifestHash ?? 'legacy'} · 冻结 ${run.context.memoryRefs?.length ?? 0} 条记忆引用`);
  $('memory-context').textContent = contextSummary.length ? contextSummary.join(' · ') : '本次 Run 没有绑定 Context Manifest。';
  for (const source of run.context?.sources ?? []) {
    const box = element('details');
    box.append(element('summary', `${source.title} · ${privacyLabel(source.classification ?? run.privacy)}`), element('small', `${source.kind ?? 'source'}${source.untrusted ? ' · 外部资料' : ''} · ${source.source} · ${source.id} · sha256 ${source.hash}${source.contentHash ? ` · content ${source.contentHash}` : ''}${source.origin ? ` · 来源 Run ${source.origin.runId}` : ''}`), element('pre', source.content));
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
      const p = positions.get(node.id)!; const step = run.steps.find(s => s.taskId === node.id); const status = step?.error ? 'failed' : step?.status ?? 'pending';
      const card = element('article', '', `node ${status}`); card.style.left = `${p.x}px`; card.style.top = `${p.y}px`;
      card.append(element('small', runStatusLabel(status)), element('strong', node.title), element('small', node.id));
      if (node.evidenceRefs?.length) card.append(element('small', `证据：${node.evidenceRefs.join(', ')}${node.evidenceRunId ? ` · Run ${node.evidenceRunId}` : ''}`));
      if (step?.error) card.title = `${step.error} · ${step.failureReason ?? step.error}`;
      canvas.append(card);
    }
    graph.append(canvas);
    const failures = element('div', '', 'task-failures');
    for (const step of run.steps.filter(step => step.error)) failures.append(element('p', `${step.taskId} · 失败 · ${step.error} · 原因：${step.failureReason ?? step.error}`, 'failure'));
    graph.append(failures);
  }
  renderGraphList($('execution-graph'), run.graphs?.execution, '执行图尚无节点');
  renderGraphList($('evidence-graph'), run.graphs?.evidence, '证据图尚无节点');
  renderPlanHistory(run);
  const artifacts = $('artifacts'); artifacts.replaceChildren();
  for (const artifact of run.artifacts) {
    const box = element('details'); box.open = true;
    const actions = element('div', '', 'artifact-actions');
    if (!readOnlyShare) actions.append(artifactDownloadLink(run.id, artifact, { getToken: () => sessionStorage.getItem('aeeis.token'), onError: message }));
    box.append(element('summary', `${artifact.title}${artifact.artifactType ? ` · ${artifact.artifactType}` : ''}`), actions, renderArtifactMarkdown(artifact.content));
    if (isProjectPulseArtifact(artifact.structured)) appendProjectPulse(box, artifact.structured, run);
    else if (isFillablePdfArtifact(artifact.structured)) box.append(renderFillablePdf(artifact.structured, ref => evidenceDetail(run, ref)));
    else if (artifact.structured) box.append(element('small', '结构化产物'), element('pre', JSON.stringify(artifact.structured, null, 2)));
    box.append(element('small', `证据：${artifact.evidenceRefs.join(', ') || '无外部来源引用'}`)); artifacts.append(box);
    if (!readOnlyShare && run.goalId && artifact.evidenceRefs.length) box.append(memoryWritebackForm(run, artifact));
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
  $('review').textContent = run.review
    ? `审核${reviewVerdictLabel(run.review.verdict)}：${run.review.summary}${run.review.issues.length ? `\n${run.review.verdict === 'accepted' ? '提示（不影响通过）' : '问题'}：\n${run.review.issues.map(issue => `· ${issue}`).join('\n')}` : ''}`
    : '';
  $('review').dataset.state = run.review?.verdict === 'accepted' ? (run.review.issues.length ? 'warning' : 'ok') : run.review ? 'attention' : '';
  const timeline = $('timeline'); timeline.replaceChildren();
  renderTimelineFilterState();
  const timelineEvents = run.events.filter(event => timelineMatchesFilter(event.type)).sort((a, b) => a.seq - b.seq);
  if (!timelineEvents.length) timeline.append(element('li', '尚无执行事件', 'muted'));
  for (const e of timelineEvents) {
    const item = element('li', '', `timeline-item timeline-${timelineTone(e.type)}`);
    item.title = e.type;
    item.append(element('time', formatTime(e.at)), element('strong', describeEvent(e.type, e.data, true)), element('small', `#${e.seq}`));
    const details = element('details'); details.append(element('summary', '事件详情'), element('pre', JSON.stringify(e.data ?? {}, null, 2))); item.append(details);
    timeline.append(item);
  }
  const events = $('events'); events.replaceChildren();
  for (const e of run.events.slice(-60).reverse()) {
    const item = element('li', `${new Date(e.at).toLocaleTimeString()} · ${describeEvent(e.type, e.data, true)}`);
    item.title = e.type;
    const details = element('details'); details.append(element('summary', '事件详情'), element('pre', JSON.stringify(e.data ?? {}, null, 2))); item.append(details);
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
  if (explanation.review) panel.append(element('p', `审核：${reviewVerdictLabel(explanation.review.verdict)} · ${explanation.review.summary}${explanation.review.confidence === undefined ? '' : ` · 置信度 ${(explanation.review.confidence * 100).toFixed(0)}%`}`, 'muted'));
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
    if (run.modelDecision.catalogRetrievedAt) model.append(element('small', `目录读取：${formatTime(run.modelDecision.catalogRetrievedAt)}`));
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

  if (run.resourceSnapshot) {
    const resources = element('div', '', 'fact-row');
    resources.append(element('strong', '资源快照'));
    const refs = [run.resourceSnapshot.plugin, run.resourceSnapshot.skill, run.resourceSnapshot.workflow].filter(Boolean) as Array<{ id: string; version: string; interface: string; channel?: string }>;
    for (const ref of refs) resources.append(element('span', `${ref.id}@${ref.version} · ${ref.interface}${ref.channel ? ` · ${ref.channel}` : ''}`));
    resources.append(element('small', `lockfile：${run.resourceSnapshot.lockfileDigest} · policy：${run.resourceSnapshot.policyDigest}`));
    const resourceDetails = element('details'); resourceDetails.append(element('summary', '查看资源 digest'), element('pre', JSON.stringify(run.resourceSnapshot, null, 2))); resources.append(resourceDetails);
    container.append(resources);
  }
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
  renderDeliveryArtifact(run);
  renderFollowUpPlan(run);
}

function renderDeliveryArtifact(run: RunView): void {
  const box = $('delivery-artifact');
  if (!box) return;
  box.replaceChildren();
  box.hidden = true;
  const artifact = run.artifacts.at(-1);
  if (!artifact) {
    const completedCalls = run.calls.filter(call => call.state === 'completed').length;
    const model = run.model?.model ?? run.modelDecision?.selected?.model ?? '固定模型';
    const isFixture = /fixture|local/i.test(`${model} ${run.model?.endpoint ?? ''}`);
    if (run.calls.length || run.status === 'succeeded') {
      box.hidden = false;
      box.append(element('strong', run.status === 'succeeded' ? '运行已完成，但没有生成可展示的产物。' : '运行没有生成产物。'));
      if (run.calls.length) box.append(element('small', `已发起 ${run.calls.length} 次模型请求，${completedCalls} 次完成 · ${model}`, 'delivery-runtime-ok'));
      box.append(element('p', isFixture
        ? '当前连接的是本地固定协议桩：它会返回预置 JSON 来验证 AEEIS 流程，不代表真实 LLM 推理。要验证真实模型，需要配置实际 provider endpoint 和 key。'
        : '请展开执行详情查看模型调用和事件记录。', 'delivery-artifact-warning'));
    }
    return;
  }
  box.hidden = false;
  const completedCalls = run.calls.filter(call => call.state === 'completed').length;
  const failedCalls = run.calls.filter(call => call.state === 'failed' || call.state === 'unknown').length;
  const model = run.model?.model ?? run.modelDecision?.selected?.model ?? '固定模型';
  const isFixture = /fixture|local/i.test(`${model} ${run.model?.endpoint ?? ''}`);
  const runtimeText = run.calls.length
    ? `Agent runtime 已执行：${run.calls.length} 次模型请求，${completedCalls} 次完成${failedCalls ? `，${failedCalls} 次异常` : ''} · ${model}`
    : '未记录模型调用；当前产物可能来自恢复或历史导入。';
  const runtime = element('small', runtimeText, completedCalls === run.calls.length && run.calls.length ? 'delivery-runtime-ok' : 'delivery-runtime-warning');
  const content = renderArtifactMarkdown(artifact.content);
  content.classList.add('delivery-artifact-content');
  const evidence = element('small', `证据引用：${artifact.evidenceRefs.length ? artifact.evidenceRefs.join('、') : '无外部来源引用'}`, 'delivery-artifact-evidence');
  box.append(element('div', '最终产物', 'delivery-artifact-kicker'), element('h3', artifact.title), runtime, content, evidence);
  if (isFixture) box.append(element('p', run.toolReceipts?.length
    ? '编排使用的是本地固定协议桩；上面的外部资料来自已授权 Tool，模型本身没有进行真实推理。'
    : '当前使用本地固定协议桩，仅验证 AEEIS 的规划、执行和交付协议；这份内容不能替代真实资料报告。', 'delivery-artifact-warning'));
  const open = button('打开完整产物与证据', async () => {
    setRunDetailsMode(true);
    $('artifacts')?.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  open.className = 'quiet-button delivery-artifact-open';
  const actions = element('div', '', 'artifact-actions');
  if (!readOnlyShare) actions.append(artifactDownloadLink(run.id, artifact, { getToken: () => sessionStorage.getItem('aeeis.token'), onError: message }));
  actions.append(open);
  box.insertBefore(actions, content);
}

function renderFollowUpPlan(run: RunView): void {
  const box = $('follow-up-plan');
  box.replaceChildren();
  box.hidden = !run.followUpPlanId;
  if (readOnlyShare || !run.followUpPlanId) { box.hidden = true; return; }
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
  const note = element('p', '对比相邻版本的说明、任务、目标、证据要求、依赖和顺序。展开后可查看修改前后的内容。', 'muted');
  container.append(heading, note);
  for (const comparison of comparisons) {
    const details = element('details');
    const count = comparison.changes.length + (comparison.summary ? 1 : 0) + (comparison.order ? 1 : 0);
    details.append(element('summary', `v${comparison.fromVersion} → v${comparison.toVersion} · ${count} 项变化`));
    const pair = (parent: HTMLElement, label: string, before: string, after: string): void => {
      parent.append(element('strong', label), element('small', '修改前'), element('pre', before), element('small', '修改后'), element('pre', after));
    };
    if (comparison.summary) pair(details, '计划说明', comparison.summary.before, comparison.summary.after);
    if (comparison.order) pair(details, '任务顺序', comparison.order.before.join(' → '), comparison.order.after.join(' → '));
    for (const change of comparison.changes) {
      const item = element('div', '', 'fact-row');
      item.append(element('strong', `${change.kind === 'added' ? '新增' : change.kind === 'removed' ? '移除' : '修改'}任务 · ${change.taskId}`));
      if (change.kind === 'modified' && change.before && change.after) {
        for (const field of change.fields) {
          const label = { title: '标题', instruction: '执行要求', dependsOn: '依赖', evidenceRequirements: '证据要求' }[field];
          const display = (value: string | string[] | undefined) => Array.isArray(value) ? value.join('、') || '无' : value ?? '未设置';
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
  if (type.startsWith('context.summary_')) return type.endsWith('_active') ? 'neutral' : 'failure';
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
  const goal = $<HTMLTextAreaElement>('goal').value;
  let quickRunOutcome = '';
  void Promise.resolve().then(() => {
    const options = runOptions(true, goal);
    quickRunOutcome = options.planning === 'direct' ? '已启动，正在准备直接执行…' : '已启动，正在生成计划…';
    return api<{ id: string }>('/runs', { goal, ...(goalId ? { goalId } : {}), ...options });
  })
    .then(async result => {
      setCurrentRunOpen(true);
      currentId = result.id;
      current = undefined;
      localStorage.setItem('aeeis.run', currentId);
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
  if (token !== (sessionStorage.getItem('aeeis.token') ?? '')) {
    resetConversation(); conversationScope = '';
    stopRunEventStream(); current = undefined; currentId = ''; pendingFollowup = undefined;
    localStorage.removeItem('aeeis.run'); $('detail').hidden = true; $('thread-panel').hidden = true;
    $('run-share-result').replaceChildren(); $('thread-share-result').replaceChildren();
  }
  if (token) sessionStorage.setItem('aeeis.token', token); else sessionStorage.removeItem('aeeis.token');
  const connect = $('connect') as HTMLButtonElement;
  connect.disabled = true;
  connect.classList.add('is-busy');
  setSystemSignal('loading');
  void initialize().finally(() => { connect.disabled = false; connect.classList.remove('is-busy'); });
};
async function initialize(): Promise<void> {
  if (linkedThreadId) { await refresh().catch(error => message(errorMessage(error))); return; }
  if (readOnlyShare) {
    $('instance-mode').textContent = '只读分享 · Read-only';
    await refresh().catch(error => message(errorMessage(error)));
    return;
  }
  try {
    const status = await api<RuntimeStatus>('/status');
    const toolHelp = $('tool-config-summary');
    try {
      const toolCatalog = await api<{ tools: { id: string }[]; defaultAllowedTools: string[] }>('/tools');
      const allowedTools = $<HTMLInputElement>('allowed-tools');
      if (!allowedTools.dataset.initialized) {
        if (!allowedTools.value.trim()) allowedTools.value = toolCatalog.defaultAllowedTools.join(', ');
        allowedTools.dataset.initialized = 'true';
      }
      if (toolHelp) toolHelp.textContent = toolCatalog.tools.length
        ? `已连接：${toolCatalog.tools.map(tool => tool.id).join('、')}。默认选择来自服务端配置；清空可禁用本次运行的外部工具。`
        : '尚未配置工具；本次运行只能使用提供的资料。';
    } catch (error) {
      if (toolHelp) toolHelp.textContent = `工具暂不可用：${status.toolsHealth?.detail ?? errorMessage(error)}。恢复后重新连接以加载工具。`;
    }

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
      ? `已连接 · ${status.model ? `${status.model.model} · ${status.runner}` : '模型目录路由'}${status.toolsConfigured && status.toolsHealth?.ready === false ? ' · 工具暂不可用，请查看设置' : ''}`
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
    runtimeModel = status.model?.model ?? '';
    taskSchedulerConfigured = status.taskSchedulerConfigured;
    authRequired = false;
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
    await initializeConversations(status);
    await refresh(); message('');
    if (minimalMode && !currentId) window.requestAnimationFrame(() => {
      if (conversationEnabled) $<HTMLTextAreaElement>('conversation-text').focus();
      else if (quickRunReady) $<HTMLInputElement>('quick-goal').focus();
      else ($('details-toggle') as HTMLButtonElement | null)?.focus();
    });
  } catch (e) {
    if (e instanceof ApiError && [401, 403].includes(e.status)) resetConversation();
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
if (linkedRunId || linkedThreadId || readOnlyShare) { setCurrentRunOpen(true); setRunDetailsMode(true); }
($('thread-more') as HTMLButtonElement).addEventListener('click', event => {
  if (threadNextAfter === undefined) return;
  const control = event.currentTarget as HTMLButtonElement; control.disabled = true;
  threadPagesAfter.push(threadNextAfter);
  void refresh().catch(error => { threadPagesAfter.pop(); message(errorMessage(error)); }).finally(() => { control.disabled = false; });
});
$('thread-parent').addEventListener('change', () => {
  $<HTMLSelectElement>('thread-privacy').value = threadRuns.find(run => run.id === $<HTMLSelectElement>('thread-parent').value)?.privacy ?? 'internal';
});
($('thread-followup') as HTMLFormElement).addEventListener('input', () => { if (!followupSubmitting) pendingFollowup = undefined; });
($('thread-followup') as HTMLFormElement).addEventListener('submit', event => {
  event.preventDefault();
  if (!linkedThreadId || readOnlyShare || followupSubmitting) return;
  const goal = $<HTMLTextAreaElement>('thread-message').value.trim();
  if (!goal) return;
  const parentRunId = $<HTMLSelectElement>('thread-parent').value;
  const body = { request: { goal, privacy: $<HTMLSelectElement>('thread-privacy').value }, ...(parentRunId ? { parentRunId } : {}) };
  const signature = JSON.stringify(body);
  if (pendingFollowup?.signature !== signature) pendingFollowup = { key: crypto.randomUUID(), body, signature };
  const attempt = pendingFollowup;
  const submit = $<HTMLButtonElement>('thread-submit'); submit.disabled = true; followupSubmitting = true;
  void api<RunView>(`/threads/${linkedThreadId}/runs`, attempt.body, 'POST', attempt.key).then(async run => {
    pendingFollowup = undefined; currentId = run.id; $<HTMLTextAreaElement>('thread-message').value = ''; await refresh();
  }).catch(error => message(errorMessage(error))).finally(() => { followupSubmitting = false; submit.disabled = !pendingFollowup && Boolean(threadRuns.length && !threadRuns.some(run => ['succeeded', 'failed', 'cancelled'].includes(run.status))); });
});
($('create-thread-share') as HTMLButtonElement).addEventListener('click', async event => {
  if (!linkedThreadId || readOnlyShare) return;
  const control = event.currentTarget as HTMLButtonElement; control.disabled = true;
  try {
    const share = await api<{ url: string; id: string; expiresAt: string; throughSequence: number }>(`/threads/${linkedThreadId}/share`, {});
    const url = new URL(share.url, window.location.origin).href, link = element('a', url); link.href = url;
    const revoke = button('撤销分享', async () => { await api(`/threads/${linkedThreadId}/share/${share.id}`, undefined, 'DELETE'); $('thread-share-result').replaceChildren(element('span', '分享已撤销')); });
    $('thread-share-result').replaceChildren(link, element('small', `截至 #${share.throughSequence} · 到期：${new Date(share.expiresAt).toLocaleString()}`), revoke);
    await copyRunLink(url).catch(() => undefined);
  } catch (error) { message(errorMessage(error)); }
  finally { control.disabled = false; }
});
($('copy-run-link') as HTMLButtonElement | null)?.addEventListener('click', () => {
  const url = readOnlyShare ? window.location.href : new URL(`/runs/${currentId}`, window.location.origin).href;
  void copyRunLink(url).then(() => message('链接已复制')).catch(() => {
    const link = element('a', url); link.href = url;
    $('run-share-result').replaceChildren(link);
    message('请选择并复制链接');
  });
});
async function copyRunLink(url: string): Promise<void> { await navigator.clipboard.writeText(url); }
($('create-run-share') as HTMLButtonElement | null)?.addEventListener('click', async event => {
  const button = event.currentTarget as HTMLButtonElement;
  const runId = currentId;
  button.disabled = true;
  try {
    const share = await api<{ url: string; expiresAt: string }>(`/runs/${runId}/share`, {});
    const url = new URL(share.url, window.location.origin).href;
    if (currentId !== runId) return;
    const result = $('run-share-result');
    result.replaceChildren();
    const link = element('a', url); link.href = url;
    result.append(link, element('small', ` · 到期：${formatTime(share.expiresAt)}`));
    await copyRunLink(url).catch(() => undefined);
  } catch (error) { message(errorMessage(error)); }
  finally { button.disabled = false; }
});
if (!readOnlyShare) $<HTMLInputElement>('token').value = sessionStorage.getItem('aeeis.token') ?? '';
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
