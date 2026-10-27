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
  actorId: string; actorType: 'principal' | 'agent' | 'system'; recordedBy?: { id: string; type: 'principal' | 'agent' | 'system' }; operation?: 'publish' | 'revise' | 'retract'; targetEventId?: string; revision?: number; retractionReason?: string; classification?: 'public' | 'internal' | 'confidential' | 'private'; contextManifestId: string; contextManifestHash: string;
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
  actionApproval?: { status: 'pending' | 'approved' | 'denied'; kind: 'tool' | 'agent'; ref: string; taskId: string; idempotencyKey: string; reason: string; decision?: string };
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
interface ConversationTaskView { id: string; threadId: string; title: string; createdAt?: string; latestRunId?: string; runId?: string; pendingMessageId?: string; priority?: number; status: string; memory?: { originals: number; activeSummaries: number }; pendingApproval?: { planVersion: number; planHash: string; summary: string }; pendingQuestion?: { text: string }; pendingAction?: { kind: 'tool' | 'agent'; ref: string; reason: string; idempotencyKey: string; step?: string }; machine?: { state: 'absent' | 'present' | 'released' | 'unknown'; ready: boolean }; execution?: { steps: Array<{ title: string; state: 'done' | 'current' | 'waiting' }>; evidence?: string[] } }
interface ConversationMessageView {
  id: string; role: 'user' | 'notification'; speaker?: { role: 'user' | 'agent'; id: string }; text: string; createdAt: string; replyTo?: string; notificationRunId?: string;
  correctsMessageId?: string; effectiveTaskIds?: string[];
  route: { status: 'routed' | 'clarify' | 'general'; reason: string; taskIds: string[]; candidateTaskIds: string[]; focusEffect: 'keep' | 'switch' };
  execution?: { runId: string; taskId: string; state: string };
}
interface LifePresence { state: 'idle' | 'working' | 'thinking' | 'waiting' | 'paused' | 'blocked' | 'unknown'; label: string; taskId?: string; taskTitle?: string }
interface ConversationSummary { id: string; title: string; revision: number; focusTaskId?: string; taskCount?: number; agentId?: string; standingInstruction?: string; presence?: LifePresence }
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
let entryEpoch = 0;
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
let currentRunOpen = !minimalMode || Boolean(currentId);
let polling = false;
let goalViewSignature = '';
let modelConfigured = false;
let runtimeModel = '';
let taskModelBound = '';
let evolutionConfigured = false;
let taskSchedulerConfigured = false;
let sessionPrincipal = '';
let eventStreamRunId = '';
let eventStreamAbort: AbortController | undefined;
let eventStreamCursor: string | undefined;
let eventStreamRefreshQueued = false;
let reminderNextCursor: string | undefined;
let reminderItems: ReminderSummary[] = [];
let reminderStatusFilter = '';
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
let laterChannelEvents: SessionEventSummary[] = [];
let liveChannelEvents: SessionEventSummary[] = [];
let groupEventCursor: string | undefined;
let channelLoadedRoomId = '';
let channelEventsCaughtUp = false;
let channelReadEpoch = 0;
const CHANNEL_TRANSCRIPT_PAGE = 50;
let channelHistoryPages = 1;
let channelTranscriptKey = '';
let channelReadQueue: Promise<void> = Promise.resolve();
let channelReadFlight: Promise<void> | undefined;
const handoffViews = new Map<string, ConversationView>();
let channelBoardOpen = false;
let channelBoardEpoch = 0;
type StudioView = 'floor' | 'graph' | 'timeline';
type DigestWindow = 'day' | 'week';
let studioView: StudioView = 'floor';
let studioPrivacy = false;
let studioIndex = -1;
let studioPlaying = false;
let studioSpeed: 1 | 2 = 1;
let studioTimer: number | undefined;
let studioKey = '';
let digestWindow: DigestWindow = 'week';
let handoffEpoch = 0;
const CITATION_ID = /^[a-z][a-z0-9_.-]{1,127}$/;
const draftAgents = new Set<string>();
let draftPeople: string[] = [];
const directMembers = new Map<string, string>();
const directOpening = new Set<string>();
let directIndexKey = '';
let directIndexPromise: Promise<void> = Promise.resolve();
const AEEIS_EMPTY_COPY = '这是一个 Bot，可以同时推进多项任务。点开左侧任务只是查看这次执行，其他任务不会因此停掉。';
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
    needs_input: '待补充', waiting_external: '待回执', unknown: '待核查', unreadable: '读不到', paused: '已暂停', succeeded: '已完成', failed: '失败', cancelled: '已取消',
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
type ComputerTab = 'run' | 'setup' | 'goals' | 'govern' | 'status';
let computerOpen = false;
let computerTab: ComputerTab = 'setup';
const COMPUTER_TITLES: Record<ComputerTab, string> = {
  run: '这次运行', setup: '设置', goals: '目标与提醒', govern: '治理', status: '运行状态',
};
function presenceOf(status?: string): { state: string; label: string } {
  if (!status) return { state: 'idle', label: '空闲' };
  if (status === 'planning' || status === 'reviewing') return { state: 'thinking', label: '思考中' };
  if (status === 'running' || status === 'queued') return { state: 'working', label: status === 'queued' ? '排队' : '执行中' };
  if (status === 'needs_approval' || status === 'needs_input' || status === 'waiting_external' || status === 'paused') return { state: 'waiting', label: '等你' };
  if (status === 'succeeded') return { state: 'done', label: '完成' };
  if (status === 'failed' || status === 'unknown' || status === 'cancelled') return { state: 'blocked', label: runStatusLabel(status) };
  return { state: 'idle', label: runStatusLabel(status) };
}
function botPresence(runs: RunSummary[]): { state: string; label: string } {
  const statuses = runs.map(run => run.status);
  if (statuses.some(status => status === 'running' || status === 'queued')) return presenceOf('running');
  if (statuses.some(status => status === 'planning' || status === 'reviewing')) return presenceOf('planning');
  if (statuses.some(status => status === 'needs_approval' || status === 'needs_input' || status === 'waiting_external' || status === 'paused')) return presenceOf('needs_approval');
  if (statuses.some(status => status === 'failed' || status === 'unknown')) return presenceOf('failed');
  if (statuses.some(status => status === 'succeeded')) return presenceOf('succeeded');
  return presenceOf(undefined);
}
function entryShowsBot(): boolean {
  return !currentRunOpen && !openGroupId && !document.body.classList.contains('group-draft') && !readOnlyShare && !linkedThreadId;
}
function syncBotRow(): void {
  if (conversationEnabled) return;
  const state = botPresence(runSummaries);
  const label = $('gb-bot-presence');
  if (label) label.textContent = runSummaries.length ? `${state.label} · ${runSummaries.length} 项任务` : state.label;
  const avatar = document.querySelector<HTMLElement>('#gb-bot .roster-avatar');
  if (avatar) avatar.dataset.state = state.state;
  const pressed = entryShowsBot();
  const visible = activeBotId();
  document.querySelectorAll<HTMLButtonElement>('#bots [data-bot-id]').forEach(row => {
    row.setAttribute('aria-pressed', String(pressed && row.dataset.botId === visible));
  });
  syncComposerForBot();
}
function syncEmptyCopy(): void {
  const empty = $('empty');
  const heading = empty?.querySelector('h2');
  const copy = empty?.querySelector('p');
  const bot = botById(activeBotId());
  if (heading) heading.textContent = entryShowsBot() && bot ? bot.name : 'AEEIS';
  if (copy) {
    copy.textContent = !entryShowsBot() || !bot || bot.id === 'aeeis'
      ? AEEIS_EMPTY_COPY
      : bot.demo
        ? '这是演示里的一位 Bot。它不会单独执行任务，也不会自己回复。任务仍交给 AEEIS。'
        : '这位已经准入。单独对话还没有接上，可以在群聊里点名。';
  }
}
function syncComposerForBot(): void {
  const other = entryShowsBot() && activeBotId() !== 'aeeis';
  const form = $('quick-run');
  const input = $<HTMLInputElement>('quick-goal');
  const submit = document.querySelector<HTMLButtonElement>('#quick-run button[type="submit"]');
  const busy = form?.dataset.busy === 'true';
  if (input) {
    if (!busy) input.disabled = other;
    input.placeholder = other ? '任务仍交给 AEEIS' : '写下要这个 Bot 推进的结果，然后发送';
  }
  if (!submit || busy) return;
  if (other) {
    submit.disabled = true;
    submit.title = '先点回 AEEIS';
    if (submit.childNodes[0]) submit.childNodes[0].textContent = '先选 AEEIS ';
    return;
  }
  submit.disabled = !quickRunReady;
  submit.title = quickRunReady ? '发送' : '请先连接模型';
  if (submit.childNodes[0]) submit.childNodes[0].textContent = quickRunReady ? '发送 ' : '等待连接 ';
}
function syncComposerHeading(): void {
  const heading = document.querySelector('.command-context h2');
  if (!heading) return;
  if (openGroupId) heading.textContent = '发到群里';
  else if (entryShowsBot() && activeBotId() !== 'aeeis') heading.textContent = '任务交给 AEEIS';
  else heading.textContent = '给 AEEIS 发消息';
}
function mirrorShell(titleText: string, presenceText: string, state?: string): void {
  const title = $('gb-title');
  const presence = $('gb-presence');
  const entryTitle = $('entry-title');
  const entryPresence = $('entry-presence');
  if (title) title.textContent = titleText;
  if (entryTitle) entryTitle.textContent = titleText;
  if (presence) {
    if (state) presence.dataset.state = state;
    presence.textContent = presenceText;
  }
  if (entryPresence) entryPresence.textContent = presenceText;
}
function syncPresence(run?: RunView): void {
  const title = $('gb-title');
  const presence = $('gb-presence');
  syncBotRow();
  syncComposerHeading();
  if (conversationEnabled) { syncEntrySurface(); return; }
  if (!title || !presence) return;
  if (document.body.classList.contains('group-draft') || groupDraftOpen) {
    mirrorShell('新建群聊', '2 到 6 人 · AEEIS 始终在场', 'idle');
    return;
  }
  if (openGroupId) {
    const room = roomSummaries.find(item => item.id === openGroupId);
    const names = ['AEEIS', ...groupMembers.map(member => participantLabel(member.principalId))];
    mirrorShell(room?.title ?? '群聊', `${names.length} 人 · ${names.join('、')}`, 'idle');
    return;
  }
  const bot = botById(activeBotId());
  if (entryShowsBot() && bot && bot.id !== 'aeeis') {
    mirrorShell(bot.name, bot.demo ? '演示 · 不会单独执行' : '已准入 · 单独对话还没接上', 'idle');
    syncEmptyCopy();
    renderBotPlacement();
    syncShellClasses();
    return;
  }
  const active = Boolean(run && currentRunOpen);
  const state = presenceOf(active ? run?.status : undefined);
  const presenceState = active ? state.state : botPresence(runSummaries).state;
  mirrorShell('AEEIS', active && run ? `${state.label} · ${run.goal}` : (runSummaries.length ? '入口 · 任务都还在跑' : '空闲 · 可以同时交给它几件事'), presenceState);
  syncEmptyCopy();
  renderBotPlacement();
}
function syncTranscriptEmpty(): void {
  const empty = $('empty');
  if (!empty) return;
  empty.hidden = readOnlyShare || Boolean(linkedThreadId) || currentRunOpen || Boolean(current) || Boolean(openGroupId) || document.body.classList.contains('group-draft');
  syncEmptyCopy();
  renderBotPlacement();
}
function setComputerOpen(open: boolean, tab?: ComputerTab): void {
  if (tab) computerTab = tab;
  computerOpen = open;
  const panel = $('gb-computer');
  if (panel) {
    panel.hidden = !open;
    panel.dataset.tab = computerTab;
  }
  document.body.classList.toggle('computer-open', open);
  const toggle = $('gb-computer-toggle') as HTMLButtonElement | null;
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(open));
    toggle.textContent = open ? '收起工作台' : '打开它的工作台';
  }
  const entryComputer = $('entry-computer') as HTMLButtonElement | null;
  if (entryComputer) {
    entryComputer.setAttribute('aria-pressed', String(open));
    entryComputer.textContent = open ? '关上工作台' : '打开它的工作台';
  }
  const title = $('gb-computer-title');
  if (title) title.textContent = COMPUTER_TITLES[computerTab];
  document.querySelectorAll<HTMLButtonElement>('[data-computer-tab]').forEach(button => {
    const selected = open && button.dataset.computerTab === computerTab;
    button.setAttribute('aria-pressed', String(selected));
    button.classList.toggle('is-selected', selected);
  });
}
function closeComputer(): void {
  const tab = computerTab;
  setComputerOpen(false);
  if (tab === 'run' && runDetailsMode) setRunDetailsMode(false);
  if (tab === 'setup' && detailsMode) setDetailsMode(false);
}
let runDetailsMode = localStorage.getItem('aeeis.run-details-mode') === '1';
function syncRunDetailsToggleLabel(): void {
  const control = $('run-details-toggle') as HTMLButtonElement | null;
  if (!control) return;
  control.textContent = runDetailsMode ? '收起工作台' : '打开它的工作台';
  control.setAttribute('aria-expanded', String(runDetailsMode));
  control.title = runDetailsMode ? '收起图、证据和事件' : '打开它的工作台，查看图、证据和事件';
}
function setRunDetailsMode(enabled: boolean): void {
  runDetailsMode = enabled;
  document.body.classList.toggle('run-details-mode', enabled);
  syncRunDetailsToggleLabel();
  localStorage.setItem('aeeis.run-details-mode', enabled ? '1' : '0');
  if (enabled) setComputerOpen(true, 'run');
}
setRunDetailsMode(runDetailsMode);
($('run-details-toggle') as HTMLButtonElement | null)?.addEventListener('click', () => {
  const next = !runDetailsMode;
  setRunDetailsMode(next);
  if (!next && computerTab === 'run') setComputerOpen(false);
});
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
  const opening = enabled && !currentRunOpen;
  currentRunOpen = enabled;
  if (!enabled && runDetailsMode) setRunDetailsMode(false);
  if (!enabled && computerTab === 'run') setComputerOpen(false);
  const detail = $('detail');
  if (detail) detail.hidden = !enabled || !current;
  document.body.classList.toggle('run-open', enabled && Boolean(current || currentId));
  if (opening) document.body.classList.remove('roster-focus');
  syncTranscriptEmpty();
  syncCurrentRunToggle(current);
  syncPresence(current);
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
function setDetailsMode(enabled: boolean, options?: { reveal?: boolean }): void {
  detailsMode = enabled;
  document.body.classList.toggle('details-mode', enabled);
  if (enabled && options?.reveal) setComputerOpen(true, 'setup');
  if (!enabled && options?.reveal && computerTab === 'setup' && !runDetailsMode) setComputerOpen(false);
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
  setDetailsMode(!detailsMode, { reveal: true });
  if (detailsMode) {
    setFocusMode(false);
    $('new-run-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
function openConfiguration(): void {
  setDetailsMode(true, { reveal: true });
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
setIntentPresetsOpen(!currentId && !readOnlyShare && !linkedThreadId);
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
function showEntry(): void {
  selectedBotId = 'aeeis';
  localStorage.setItem('aeeis.bot', 'aeeis');
  entryEpoch += 1;
  leaveGroup();
  stopRunEventStream();
  currentId = '';
  current = undefined;
  localStorage.removeItem('aeeis.run');
  document.body.classList.remove('roster-focus');
  document.body.classList.add('draft-open');
  setCurrentRunOpen(false);
  if (!readOnlyShare && !linkedThreadId && window.location.pathname !== '/') window.history.replaceState(null, '', '/');
  setIntentPresetsOpen(true);
  renderBotRoster();
  renderRunQueue(runSummaries);
}
document.querySelectorAll<HTMLButtonElement>('[data-computer-tab]').forEach(button => {
  button.addEventListener('click', () => {
    const tab = button.dataset.computerTab as ComputerTab | undefined;
    if (!tab) return;
    if (computerOpen && computerTab === tab) {
      closeComputer();
      return;
    }
    if (tab === 'run') {
      if (!current && !currentId) return;
      setRunDetailsMode(true);
      return;
    }
    if (tab === 'setup') setDetailsMode(true, { reveal: true });
    else setComputerOpen(true, tab);
  });
});
($('gb-computer-toggle') as HTMLButtonElement | null)?.addEventListener('click', () => {
  if (computerOpen) closeComputer();
  else if (current || currentId) setRunDetailsMode(true);
  else setComputerOpen(true, 'setup');
});
($('gb-computer-close') as HTMLButtonElement | null)?.addEventListener('click', () => closeComputer());
($('group-person') as HTMLInputElement | null)?.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  addDraftPerson();
});
($('gb-back') as HTMLButtonElement | null)?.addEventListener('click', () => showRoster());
document.querySelectorAll<HTMLAnchorElement>('nav.workbench-nav a').forEach(link => {
  link.addEventListener('click', event => {
    const href = link.getAttribute('href') ?? '';
    const tabs: Record<string, ComputerTab | 'conversation'> = {
      '#new-run-panel': 'setup',
      '#run-workspace': 'conversation',
      '#goals-panel': 'goals',
      '#reminders-panel': 'goals',
      '#rsi-panel': 'govern',
      '#collaboration-panel': 'govern',
      '#system-status': 'status',
    };
    const target = tabs[href];
    if (!target) return;
    event.preventDefault();
    if (target === 'conversation') {
      if (current || currentId) setCurrentRunOpen(true);
      $('run-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (target === 'setup') setDetailsMode(true, { reveal: true });
    else setComputerOpen(true, target);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(href)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  });
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
  if (command === 'new-group') {
    showGroupDraft();
  } else if (command === 'new-run') {
    showEntry();
    $('command-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (conversationEnabled) $<HTMLTextAreaElement>('conversation-text').focus();
    else $<HTMLInputElement>('quick-goal').focus();
  } else if (command === 'attention') {
    if (!runSummaries.some(run => ATTENTION_STATUSES.has(run.status))) {
      runFilter = 'attention';
      localStorage.setItem('aeeis.run-filter', runFilter);
      renderRunQueue(runSummaries);
      $('run-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.querySelector<HTMLElement>('#runs button')?.focus({ preventScroll: true });
    } else {
      setAttentionInboxOpen(true);
      $('attention-inbox')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $<HTMLElement>('#attention-items .is-selected, #attention-items [role="button"]')?.focus({ preventScroll: true });
    }
  } else if (command === 'current') {
    leaveGroup();
    setCurrentRunOpen(true);
    $('run-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $<HTMLElement>('#run-title')?.focus({ preventScroll: true });
  } else if (command === 'focus') {
    setFocusMode(!focusMode);
  } else if (command === 'details') {
    if (!quickRunReady) openConfiguration();
    else {
      setDetailsMode(true, { reveal: true });
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
  if (entryShowsBot() && activeBotId() !== 'aeeis') { message('任务交给 AEEIS。先点回左边的 AEEIS。'); return; }
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
      else if (key === 'g') { event.preventDefault(); executePaletteCommand('new-group'); }
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
/** What the main send button does now: start work when a Run can start, otherwise only record the message. */
function conversationSendIntent(): 'discuss' | 'execute' {
  // Only AEEIS runs work; another Bot's conversation keeps a record and the task still goes to AEEIS.
  if (!conversation || conversationCorrectionId || !quickRunReady || selectedLifeSpeaker() || rosterView() !== 'entry') return 'discuss';
  const task = conversationTargetTask();
  const preparing = Boolean(task && task.status === 'preparing' && !task.runId && !task.latestRunId);
  const active = task && !preparing && (task.pendingMessageId || !['discussion', 'succeeded', 'failed', 'cancelled'].includes(task.status));
  return preparing || active ? 'discuss' : 'execute';
}
/** A new task named after the message, for a send that names no task. Titles need at least two characters. */
function autoTaskTitle(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(Boolean) ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
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
  $<HTMLButtonElement>('conversation-send').textContent = correcting ? '保存归属纠正' : conversationSendIntent() === 'execute' ? '发送' : '记下来';
  $<HTMLButtonElement>('conversation-send').disabled = locked || !conversation || conversationNeedsRefresh || (correcting && !conversation?.tasks.some(task => task.id === target));
  $<HTMLButtonElement>('conversation-note').disabled = locked || !conversation || conversationNeedsRefresh || correcting;
  restoreExecutionReview();
  $('conversation-execution-note').textContent = correcting ? '请明确选择任务。纠正以新记录追加，仅影响后续消息和新执行上下文；已有执行记录不变，不启动执行，也不切换焦点。' : preparing ? '执行尚未创建。请等待回执；确认失败后再重新发送。' : active ? '此任务已有未结束的 Run。这条消息只记下来；批准、回答或取消在计划卡片和运行里。' : !quickRunReady ? '模型尚未就绪；发送只记下来，不会执行。' : selectedLifeSpeaker() ? '以别人的口吻说的话只记下来，不会启动执行。' : rosterView() !== 'entry' ? '这位 Bot 不会单独执行，发送只记下来。要它做事，回到 AEEIS 说。' : executionReviewNote();
  for (const id of ['conversation-new', 'conversation-select', 'conversation-clear-focus']) ($<HTMLButtonElement | HTMLSelectElement>(id)).disabled = locked;
  for (const id of ['conversation-refresh', 'conversation-sync']) $<HTMLButtonElement>(id).disabled = conversationBusy || conversationRefreshing || !conversation;
  $<HTMLButtonElement>('conversation-clear-focus').disabled ||= !conversation?.focusTaskId;
  document.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('#conversation-tasks button[data-change-focus], #conversation-tasks button[data-priority], #conversation-tasks button[data-approve], #conversation-tasks button[data-approve-once], #conversation-tasks button[data-reject-submit], #conversation-tasks button[data-answer-submit], #conversation-tasks button[data-retry], #conversation-tasks button[data-run-pause], #conversation-tasks button[data-run-resume], #conversation-tasks button[data-reconcile-submit], #conversation-tasks textarea[data-answer], #conversation-tasks textarea[data-reconcile], #conversation-tasks textarea[data-reject], #group-transcript button[data-approve], #group-transcript button[data-approve-once], #group-transcript button[data-reject-submit], #group-transcript button[data-answer-submit], #group-transcript textarea[data-reject], #group-transcript textarea[data-answer], #conversation-messages button[data-plan-start], #conversation-messages button[data-plan-revise], #conversation-messages button[data-plan-cancel], #conversation-messages button[data-plan-revise-submit], #conversation-messages textarea[data-plan-feedback], #conversation-messages button[data-card-decision], #conversation-messages button[data-question-submit], #conversation-messages textarea[data-question-answer]').forEach(control => {
    control.disabled = control.dataset.boundary === 'true' || locked || (Boolean(control.dataset.priority) && conversationNeedsRefresh);
  });
  const surface = rosterView();
  if (surface === 'group' || surface === 'draft' || surface === 'direct') {
    $<HTMLButtonElement>('conversation-send').disabled = true;
    $<HTMLButtonElement>('conversation-note').disabled = true;
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
function presenceFromTasks(tasks: Array<{ id: string; title: string; status: string }>): LifePresence {
  const rank = (status: string) => status === 'needs_approval' || status === 'needs_input' || status === 'waiting_external' ? 0
    : status === 'unknown' ? 1
    : status === 'failed' ? 2
    : status === 'paused' ? 3
    : status === 'planning' || status === 'reviewing' ? 4
    : status === 'running' || status === 'queued' || status === 'preparing' ? 5
    : 9;
  const lead = tasks.filter(task => rank(task.status) < 9).sort((left, right) => rank(left.status) - rank(right.status))[0];
  if (!lead) return { state: 'idle', label: '空闲' };
  const ranked = rank(lead.status);
  const state = ranked === 0 ? 'waiting' as const : ranked === 1 ? 'unknown' as const : ranked === 2 ? 'blocked' as const : ranked === 3 ? 'paused' as const : ranked === 4 ? 'thinking' as const : 'working' as const;
  const label = state === 'waiting' ? '等你' : state === 'unknown' ? '待核查' : state === 'blocked' ? '卡住' : state === 'paused' ? '已暂停' : state === 'thinking' ? '思考中' : '执行中';
  return { state, label, taskId: lead.id, taskTitle: lead.title };
}
function lifePresence(agentId: string): LifePresence {
  const open = conversation && lifeAgent(conversation) === agentId ? conversation.tasks : undefined;
  const listed = lifeSummary(agentId);
  const tasks = open ?? (listed && 'tasks' in listed ? (listed as ConversationView).tasks : undefined);
  if (tasks?.length) {
    const derived = presenceFromTasks(tasks);
    if (derived.state !== 'idle') return derived;
    return { state: 'idle', label: `空闲 · ${tasks.length} 件事` };
  }
  if (listed?.presence && listed.presence.state !== 'idle') return listed.presence;
  const count = taskCountOf(listed);
  if (count) return { state: 'idle', label: `空闲 · ${count} 件事` };
  return { state: 'idle', label: '空闲' };
}
function lifePresenceLabel(agentId: string): string {
  const presence = lifePresence(agentId);
  return presence.state === 'idle' || !presence.taskTitle ? presence.label : `${presence.label} · ${presence.taskTitle}`;
}
function lifeAvatarState(agentId: string): string {
  const state = lifePresence(agentId).state;
  if (state === 'paused') return 'waiting';
  if (state === 'unknown' || state === 'blocked') return 'blocked';
  return state;
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
function eventWriter(event: SessionEventSummary): { id: string; type: 'principal' | 'agent' | 'system' } {
  return event.recordedBy ?? { id: event.actorId, type: event.actorType };
}
function roomOwnerWrote(event: SessionEventSummary): boolean {
  const writer = eventWriter(event);
  if (writer.type !== 'principal') return false;
  if (event.owner) return writer.id === event.owner;
  return Boolean(sessionPrincipal) && writer.id === sessionPrincipal;
}
function eventAuthor(event: SessionEventSummary): string {
  if (event.type === 'system') {
    const writer = eventWriter(event);
    if (writer.type === 'system' || roomOwnerWrote(event)) return '记录';
    return participantLabel(writer.id);
  }
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
  syncGroupHandoff();
}
function handoffChoices(): RosterBot[] {
  const members = new Set(groupMembers.filter(member => member.role === 'agent' && member.status === 'active').map(member => member.principalId));
  return rosterBots().filter(bot => bot.id === 'aeeis' || members.has(bot.id));
}
function syncGroupHandoff(): void {
  const select = $<HTMLSelectElement>('group-handoff');
  if (!select) return;
  const previous = select.value;
  const choices = handoffChoices();
  select.replaceChildren();
  const stay = document.createElement('option');
  stay.value = '';
  stay.textContent = '只留在会话里';
  select.append(stay);
  for (const bot of choices) {
    const option = document.createElement('option');
    option.value = bot.id;
    option.textContent = `交给${bot.name}`;
    select.append(option);
  }
  select.value = choices.some(bot => bot.id === previous) ? previous : '';
  select.hidden = rosterView() !== 'group';
}
function handoffCitation(event: SessionEventSummary): { conversationId: string; taskId: string; agentId?: string } | undefined {
  if (!roomOwnerWrote(event)) return;
  const refs = event.evidenceRefs ?? [];
  const conversationId = refs.find(id => id.startsWith('conv_') && CITATION_ID.test(id));
  const taskId = refs.find(id => id.startsWith('task_') && CITATION_ID.test(id));
  if (!conversationId || !taskId) return;
  const agentId = refs.find(id => id !== conversationId && id !== taskId && CITATION_ID.test(id) && botById(id));
  return agentId ? { conversationId, taskId, agentId } : { conversationId, taskId };
}
type BoardColumn = 'capture' | 'ready' | 'doing' | 'blocked' | 'review' | 'done';
const BOARD_COLUMNS: Array<{ id: BoardColumn; title: string }> = [
  { id: 'capture', title: '待整理' },
  { id: 'ready', title: '待领取' },
  { id: 'doing', title: '进行中' },
  { id: 'blocked', title: '阻塞' },
  { id: 'review', title: '待验收' },
  { id: 'done', title: '完成' },
];
interface BoardDecision { assigneeId?: string; conflicts: string[]; accepted: boolean; revision?: string; blockedNote?: string; cancelReason?: string; cancelled: boolean; lines: string[] }
function channelLog(): SessionEventSummary[] {
  if (!laterChannelEvents.length && !liveChannelEvents.length) return groupEvents;
  return [...groupEvents, ...laterChannelEvents, ...liveChannelEvents];
}
function channelReadableEvents(): SessionEventSummary[] {
  return channelLog().filter(event => event.operation !== 'retract');
}
function earlierChannelCount(): number {
  return Math.max(0, channelReadableEvents().length - channelHistoryPages * CHANNEL_TRANSCRIPT_PAGE);
}
function visibleChannelEvents(): SessionEventSummary[] {
  const readable = channelReadableEvents();
  const keep = channelHistoryPages * CHANNEL_TRANSCRIPT_PAGE;
  return readable.length > keep ? readable.slice(-keep) : readable;
}
function citedTaskSignature(event: SessionEventSummary): string {
  const cite = handoffCitation(event);
  if (!cite) return '';
  const view = handoffViews.get(cite.conversationId);
  const task = view?.tasks.find(item => item.id === cite.taskId);
  if (!view || !task) return 'pending';
  const delivery = view.lastDelivery?.taskId === task.id ? view.lastDelivery : undefined;
  return JSON.stringify({
    person: cite.agentId ?? view.agentId ?? '',
    title: task.title,
    status: task.status,
    runId: task.runId ?? '',
    latestRunId: task.latestRunId ?? '',
    approval: task.pendingApproval?.summary ?? '',
    question: task.pendingQuestion?.text ?? '',
    steps: (task.execution?.steps ?? []).map(step => `${step.state}:${step.title}`),
    evidence: task.execution?.evidence ?? [],
    plan: delivery?.planSummary ?? '',
    artifacts: delivery?.artifactTitles ?? [],
    deliveryRun: delivery?.runId ?? '',
  });
}
function channelTranscriptSignature(): string {
  const members = groupMembers.map(member => `${member.principalId}:${member.status}:${participantLabel(member.principalId)}`).join('\n');
  const events = visibleChannelEvents().map(event => [
    event.id,
    event.operation ?? '',
    event.type,
    eventAuthor(event),
    event.content,
    (event.evidenceRefs ?? []).join(' '),
    citedTaskSignature(event),
  ].join('\u001f')).join('\u001e');
  return `${channelHistoryPages}\u0000${earlierChannelCount()}\u0000${members}\u0000${events}`;
}
function eventCursor(event: SessionEventSummary | undefined): string | undefined {
  const sequence = event?.sequence;
  return typeof sequence === 'number' && Number.isInteger(sequence) && sequence > 0 ? String(sequence) : undefined;
}
function noteEventPage(page: SessionEventPage, requestedCursor: string | undefined): void {
  const next = page.nextCursor;
  if (next && next !== requestedCursor) {
    groupEventCursor = next;
    channelEventsCaughtUp = false;
    return;
  }
  const sequence = eventCursor(page.items?.at(-1));
  groupEventCursor = sequence ?? requestedCursor;
  channelEventsCaughtUp = true;
}
function resetChannelLog(): void {
  groupEvents = [];
  laterChannelEvents = [];
  liveChannelEvents = [];
  groupEventCursor = undefined;
  channelLoadedRoomId = '';
  channelEventsCaughtUp = false;
  channelHistoryPages = 1;
  channelTranscriptKey = '';
  channelReadEpoch += 1;
}
function appendUnseen(items: SessionEventSummary[] | undefined, into: SessionEventSummary[]): void {
  const seen = new Set(channelLog().map(event => event.id));
  for (const item of items ?? []) if (!seen.has(item.id)) { into.push(item); seen.add(item.id); }
}
function boardDecision(conversationId: string, taskId: string): BoardDecision {
  const decision: BoardDecision = { conflicts: [], accepted: false, cancelled: false, lines: [] };
  for (const event of channelLog()) {
    if (event.operation === 'retract' || event.type !== 'task_update' || !roomOwnerWrote(event)) continue;
    const refs = event.evidenceRefs ?? [];
    if (!refs.includes(conversationId) || !refs.includes(taskId)) continue;
    const content = event.content.trim();
    const agentId = refs.find(id => id !== conversationId && id !== taskId && CITATION_ID.test(id) && Boolean(botById(id)));
    if (content.startsWith('领取：')) {
      if (!agentId) continue;
      if (decision.assigneeId && decision.assigneeId !== agentId) decision.conflicts.push(agentId);
      else decision.assigneeId = agentId;
      decision.lines.push(content);
    } else if (content.startsWith('分派给 ') || content.startsWith('转交给 ')) {
      if (!agentId) continue;
      decision.assigneeId = agentId;
      decision.cancelled = false;
      decision.lines.push(content);
    } else if (content.startsWith('拒绝领取：')) {
      delete decision.assigneeId;
      decision.lines.push(content);
    } else if (content === '验收通过') {
      decision.accepted = true;
      decision.lines.push('验收通过');
    } else if (content.startsWith('要求修改：')) {
      decision.revision = content.slice('要求修改：'.length).trim();
      decision.accepted = false;
      decision.lines.push(content);
    } else if (content.startsWith('阻塞：')) {
      decision.blockedNote = content.slice('阻塞：'.length).trim();
      decision.lines.push(content);
    } else if (content.startsWith('解除阻塞')) {
      delete decision.blockedNote;
      decision.lines.push(content);
    } else if (content.startsWith('取消：')) {
      decision.cancelled = true;
      decision.cancelReason = content.slice('取消：'.length).trim();
      decision.lines.push(content);
    } else if (content.startsWith('撤回取消：')) {
      decision.cancelled = false;
      delete decision.cancelReason;
      decision.lines.push(content);
    }
  }
  return decision;
}
function taskRunId(task: ConversationTaskView): string | undefined {
  return task.runId ?? task.latestRunId;
}
function blockPausesRun(task: ConversationTaskView): boolean {
  return Boolean(taskRunId(task) && ['queued', 'planning', 'running', 'reviewing'].includes(task.status));
}
function blockNoteCurrent(status: string, decision: BoardDecision): string | undefined {
  if (!decision.blockedNote) return;
  if (['planning', 'running', 'reviewing', 'preparing', 'queued', 'succeeded', 'failed', 'cancelled', 'unreadable'].includes(status)) return;
  return decision.blockedNote;
}
function channelCancelHolds(task: ConversationTaskView, decision: BoardDecision): boolean {
  if (!decision.cancelled || taskRunId(task)) return false;
  return task.status === 'discussion' || task.status === 'preparing' || task.status === 'queued';
}
function boardColumn(status: string, decision?: BoardDecision, runId?: string): BoardColumn | 'failed' {
  if (decision?.cancelled && !runId && (status === 'discussion' || status === 'preparing' || status === 'queued')) return 'failed';
  if (status === 'failed' || status === 'cancelled' || status === 'unreadable') return 'failed';
  if (decision && blockNoteCurrent(status, decision)) return 'blocked';
  if (status === 'discussion') return 'capture';
  if (status === 'preparing' || status === 'queued') return 'ready';
  if (status === 'planning' || status === 'running' || status === 'reviewing') return 'doing';
  if (status === 'needs_approval' || status === 'needs_input' || status === 'waiting_external' || status === 'paused' || status === 'unknown') return 'blocked';
  if (status === 'succeeded') return decision?.accepted ? 'done' : 'review';
  return 'capture';
}
function taskAgeLabel(createdAt: string | undefined): string | undefined {
  if (!createdAt) return;
  const hours = (Date.now() - Date.parse(createdAt)) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 24) return;
  return `从记下起已停留 ${Math.floor(hours / 24)} 天`;
}
function blockedCaption(status: string): string {
  if (status === 'waiting_external') return '等外部';
  if (status === 'unknown') return '待核查';
  if (status === 'needs_approval' || status === 'needs_input' || status === 'paused') return '需要你';
  return '';
}
function taskStateLabel(task: ConversationTaskView): string {
  if (task.status === 'discussion') return '仅讨论，未执行';
  if (task.status === 'preparing') return '正在准备执行';
  return runStatusLabel(task.status);
}
function hideChannelBoard(): void {
  channelBoardOpen = false;
  channelBoardEpoch += 1;
  const board = $('channel-board');
  const task = $('channel-task');
  const transcript = $('group-transcript');
  if (board) board.hidden = true;
  if (task) task.hidden = true;
  $('channel-task-body')?.replaceChildren();
  if (transcript) transcript.hidden = false;
}
function channelCitations(): Array<{ conversationId: string; taskId: string; agentId?: string }> {
  const seen = new Set<string>();
  const citations: Array<{ conversationId: string; taskId: string; agentId?: string }> = [];
  for (const event of channelLog()) {
    if (event.type === 'task_update') continue;
    const cite = handoffCitation(event);
    if (!cite || seen.has(`${cite.conversationId}\0${cite.taskId}`)) continue;
    seen.add(`${cite.conversationId}\0${cite.taskId}`);
    citations.push(cite);
  }
  return citations;
}
function channelBoardIds(): string[] {
  return [...new Set(channelCitations().map(cite => cite.conversationId))];
}
async function absorbLaterEventsNow(roomId: string, epoch: number): Promise<void> {
  for (let page = 0; page < 20 && groupEventCursor && !channelEventsCaughtUp && openGroupId === roomId && channelLoadedRoomId === roomId && epoch === channelReadEpoch; page += 1) {
    const cursor = groupEventCursor;
    const next = await api<SessionEventPage>(`/rooms/${encodeURIComponent(roomId)}/session-events?limit=50&cursor=${encodeURIComponent(cursor)}`).catch(() => undefined);
    if (!next || openGroupId !== roomId || channelLoadedRoomId !== roomId || epoch !== channelReadEpoch) return;
    appendUnseen(next.items, laterChannelEvents);
    noteEventPage(next, cursor);
  }
}
function absorbLaterEvents(roomId: string, epoch: number): Promise<void> {
  const run = channelReadQueue.then(() => absorbLaterEventsNow(roomId, epoch));
  channelReadQueue = run.then(() => undefined, () => undefined);
  return run;
}
async function showChannelBoard(): Promise<void> {
  const roomId = openGroupId;
  if (!roomId) return;
  channelBoardOpen = true;
  const epoch = ++channelBoardEpoch;
  await absorbLaterEvents(roomId, channelReadEpoch);
  if (epoch !== channelBoardEpoch || openGroupId !== roomId || !channelBoardOpen) return;
  renderChannelBoard();
  const loaded = await Promise.all(channelBoardIds().map(async id => {
    try { return await api<ConversationView>(`/conversations/${encodeURIComponent(id)}`); }
    catch { return handoffViews.get(id); }
  }));
  if (epoch !== channelBoardEpoch || openGroupId !== roomId || !channelBoardOpen) return;
  for (const view of loaded) if (view) handoffViews.set(view.id, view);
  renderChannelBoard();
}
function renderChannelBoard(): void {
  const board = $('channel-board');
  const columns = $('channel-board-columns');
  const failures = $('channel-board-failures');
  const note = $('channel-board-note');
  const transcript = $('group-transcript');
  const empty = $('group-thread-empty');
  if (board) board.hidden = !channelBoardOpen;
  if (transcript) transcript.hidden = channelBoardOpen;
  if (empty) empty.hidden = channelBoardOpen || visibleChannelEvents().some(event => event.operation !== 'retract');
  if (!channelBoardOpen || !columns || !failures) return;
  const cards = channelCitations().flatMap(cite => {
    const view = handoffViews.get(cite.conversationId);
    const task = view?.tasks.find(item => item.id === cite.taskId);
    if (!view || !task) return [];
    const ownerId = cite.agentId ?? view.agentId ?? '';
    const owner = botById(ownerId)?.name ?? (ownerId || '这个人');
    return [{ view, task, owner, ownerId, decision: boardDecision(cite.conversationId, task.id) }];
  });
  const placed = cards.map(card => ({ ...card, column: boardColumn(card.task.status, card.decision, taskRunId(card.task)) }));
  const failed = placed.filter(card => card.column === 'failed');
  failures.replaceChildren();
  failures.append(document.createTextNode(failed.length ? `有 ${failed.length} 件失败或读不到` : '没有失败或读不到的事'));
  for (const card of failed) failures.append(boardCard(card.view, card.task, card.owner, 'channel-failure-card', card.decision));
  const doing = placed.filter(card => card.column === 'doing');
  const loads = new Map<string, { name: string; count: number }>();
  for (const card of doing) {
    const current = loads.get(card.ownerId) ?? { name: card.owner, count: 0 };
    current.count += 1;
    loads.set(card.ownerId, current);
  }
  const wip = [...loads.values()].filter(item => item.count > 3).map(item => `${item.name}进行中已有 ${item.count} 件。先完成或转交。`);
  const more = !channelEventsCaughtUp && groupEventCursor ? '还有没读到的交接。' : '';
  if (note) note.textContent = ['这六列只列出这个频道交接过的事。看一眼不会执行，也不会改讨论焦点。', ...wip, more].filter(Boolean).join(' ');
  const moreButton = $('channel-board-more');
  if (moreButton) moreButton.hidden = channelEventsCaughtUp || !groupEventCursor;
  columns.replaceChildren();
  for (const column of BOARD_COLUMNS) {
    const section = element('section', '', 'channel-board-column');
    section.dataset.column = column.id;
    const items = placed.filter(card => card.column === column.id);
    section.append(element('h3', `${column.title} ${items.length}`));
    if (!items.length) section.append(element('small', '这一列还空着'));
    for (const card of items) section.append(boardCard(card.view, card.task, card.owner, 'channel-board-card', card.decision));
    columns.append(section);
  }
  if (!cards.length) columns.append(element('p', '这个频道还没有记下的事。'));
}
function boardCard(view: ConversationView, task: ConversationTaskView, owner: string, className: string, decision: BoardDecision): HTMLButtonElement {
  const button = element('button', '', className) as HTMLButtonElement;
  button.type = 'button';
  button.dataset.boardTask = task.id;
  button.dataset.boardOwner = view.agentId ?? '';
  button.append(element('strong', task.title), element('small', owner), element('small', taskStateLabel(task)));
  const blocked = blockedCaption(task.status);
  if (blocked) button.append(element('small', blocked));
  const blockNote = blockNoteCurrent(task.status, decision);
  if (blockNote) button.append(element('small', `阻塞：${blockNote}`));
  if (decision.assigneeId) button.append(element('small', `${botById(decision.assigneeId)?.name ?? decision.assigneeId}已领取`));
  if (decision.conflicts.length) button.append(element('small', '已被领取'));
  if (decision.accepted) button.append(element('small', '已验收'));
  if (decision.revision) button.append(element('small', `要求修改：${decision.revision}`));
  if (channelCancelHolds(task, decision)) button.append(element('small', '已在频道里取消'));
  const age = taskAgeLabel(task.createdAt);
  if (age) button.append(element('small', age));
  button.addEventListener('click', () => openChannelTask(view, task, owner));
  return button;
}
function channelOwnerName(view: ConversationView, task: ConversationTaskView): string {
  const cite = channelCitations().find(item => item.conversationId === view.id && item.taskId === task.id);
  return botById(cite?.agentId ?? view.agentId ?? '')?.name ?? cite?.agentId ?? view.agentId ?? '这个人';
}
function doingCount(agentId: string): number {
  return channelCitations().filter(cite => {
    const view = handoffViews.get(cite.conversationId);
    const task = view?.tasks.find(item => item.id === cite.taskId);
    if (!view || !task) return false;
    const ownerId = cite.agentId ?? view.agentId ?? '';
    return ownerId === agentId && boardColumn(task.status, boardDecision(cite.conversationId, task.id), taskRunId(task)) === 'doing';
  }).length;
}
function handoffChain(conversationId: string, taskId: string): string[] {
  const lines: string[] = [];
  for (const event of channelLog()) {
    if (event.operation === 'retract' || event.type === 'task_update') continue;
    const cite = handoffCitation(event);
    if (!cite || cite.conversationId !== conversationId || cite.taskId !== taskId) continue;
    const name = cite.agentId ? (botById(cite.agentId)?.name ?? cite.agentId) : '这个人';
    lines.push(`交给${name}`);
  }
  return [...lines, ...boardDecision(conversationId, taskId).lines];
}
function spendLine(run: RunView): string {
  const tokens = run.modelUsage?.tokens ?? run.calls.reduce((sum, call) => sum + (call.usage?.inputTokens ?? 0) + (call.usage?.outputTokens ?? 0), 0);
  const credits = (run.toolReceipts ?? []).reduce((sum, receipt) => sum + (receipt.cost?.credits ?? 0), 0);
  const money = run.modelUsage?.moneyUsd;
  if (!tokens && !credits && money === undefined) return '还没有记下花费。';
  return `花费：${tokens} 已报告 tokens${money === undefined ? '' : ` · 估算 $${money.toFixed(4)}`}${credits ? ` · ${credits} credits` : ''}。看一眼不会改预算。`;
}
function stopLine(task: ConversationTaskView, decision: BoardDecision): string {
  if (task.pendingQuestion) return `停在这里：${task.pendingQuestion.text}`;
  if (task.pendingApproval) return `停在批准：${task.pendingApproval.summary}`;
  const blocked = blockNoteCurrent(task.status, decision);
  if (blocked) return `阻塞：${blocked}`;
  if (channelCancelHolds(task, decision)) return '已在频道里取消';
  if (task.status === 'cancelled' && decision.cancelReason) return `取消原因：${decision.cancelReason}`;
  return blockedCaption(task.status);
}
async function roomWriteContext(roomId: string): Promise<{ goalId: string; manifestId: string }> {
  const room = roomSummaries.find(item => item.id === roomId);
  const listed = await api<GoalSummary[] | { goals?: GoalSummary[] }>(`/rooms/${encodeURIComponent(roomId)}/goals`);
  const goals = Array.isArray(listed) ? listed : (listed.goals ?? []);
  let goal = goals.find(item => item.status === 'active') ?? goals[0];
  if (!goal) goal = await api<GoalSummary>('/goals', { title: room?.title || '群聊', roomId });
  const manifest = await api<{ id: string }>(`/goals/${encodeURIComponent(goal.id)}/context-manifests`, { purpose: room?.description === '私聊' ? '私聊消息' : '群聊消息', audienceMode: 'room' });
  return { goalId: goal.id, manifestId: manifest.id };
}
async function postRoomUpdate(content: string, evidenceRefs: string[]): Promise<void> {
  const roomId = openGroupId;
  if (!roomId) return;
  const ctx = await roomWriteContext(roomId);
  const refs = [...new Set(evidenceRefs.filter(id => CITATION_ID.test(id)))];
  await api(`/rooms/${encodeURIComponent(roomId)}/session-events`, {
    goalId: ctx.goalId, type: 'task_update', content, contextManifestId: ctx.manifestId, idempotencyKey: groupIdempotencyKey(), ...(refs.length ? { evidenceRefs: refs } : {}),
  });
}
async function channelPostSession(type: 'message' | 'system', content: string, evidenceRefs?: string[]): Promise<unknown> {
  const roomId = openGroupId;
  if (!roomId) return;
  const ctx = await roomWriteContext(roomId);
  const refs = [...new Set((evidenceRefs ?? []).filter(id => CITATION_ID.test(id)))];
  return api(`/rooms/${encodeURIComponent(roomId)}/session-events`, {
    goalId: ctx.goalId, type, content, contextManifestId: ctx.manifestId, idempotencyKey: groupIdempotencyKey(), ...(refs.length ? { evidenceRefs: refs } : {}),
  });
}
async function afterChannelWrite(view: ConversationView, taskId: string): Promise<void> {
  const roomId = openGroupId;
  if (!roomId) return;
  const boardWasOpen = channelBoardOpen;
  await loadGroup(roomId);
  if (openGroupId !== roomId) return;
  if (boardWasOpen) await showChannelBoard();
  const fresh = handoffViews.get(view.id);
  const task = fresh?.tasks.find(item => item.id === taskId);
  if (fresh && task && !($('channel-task')?.hidden)) openChannelTask(fresh, task, channelOwnerName(fresh, task));
}
function citeRefs(view: ConversationView, task: ConversationTaskView, agentId?: string): string[] {
  return [view.id, task.id, ...(agentId ? [agentId] : [])];
}
async function claimChannelTask(view: ConversationView, task: ConversationTaskView, agentId: string): Promise<void> {
  const decision = boardDecision(view.id, task.id);
  const name = botById(agentId)?.name ?? agentId;
  if (decision.assigneeId && decision.assigneeId !== agentId) {
    message(`${botById(decision.assigneeId)?.name ?? '这位'}已领取。`);
    return;
  }
  if (decision.assigneeId === agentId) { message(`${name}已经领取这件事。`); return; }
  await postRoomUpdate(`领取：${name}`, citeRefs(view, task, agentId));
  message(`已记下${name}领取「${task.title}」。还没有执行。`);
  await afterChannelWrite(view, task.id);
}
async function handChannelTask(view: ConversationView, task: ConversationTaskView, agentId: string, kind: '分派' | '转交'): Promise<void> {
  const bot = botById(agentId);
  if (!bot) { message('先从名单里选一位。'); return; }
  const load = doingCount(agentId);
  if (load >= 3) { message(`${bot.name}进行中已有 ${load} 件。先完成或转交。`); return; }
  const room = roomSummaries.find(item => item.id === openGroupId);
  const verb = kind === '分派' ? '分派' : '转交';
  const note = await recordRosterHandoff(bot, `${verb}「${task.title}」`, room, undefined, channelPostSession, title => kind === '分派'
    ? `已分派给${bot.name}，记成讨论「${title}」。未执行。`
    : `已转交给${bot.name}，记成讨论「${title}」。原来的事还在，未执行。`);
  if (note) { message(note); return; }
  await postRoomUpdate(`${kind === '分派' ? '分派给' : '转交给'} ${bot.name}`, citeRefs(view, task, bot.id));
  message(kind === '分派' ? `已分派给${bot.name}。记成一条新的讨论，未执行。` : `已转交给${bot.name}。原来的事还在，未执行。`);
  await afterChannelWrite(view, task.id);
}
async function refuseChannelTask(view: ConversationView, task: ConversationTaskView, reason: string): Promise<void> {
  const text = reason.trim();
  if (!text) { message('请先写下拒绝原因。'); return; }
  await postRoomUpdate(`拒绝领取：${text}`, citeRefs(view, task, boardDecision(view.id, task.id).assigneeId));
  message(`已记下拒绝领取「${task.title}」。还没有执行。`);
  await afterChannelWrite(view, task.id);
}
async function blockChannelTask(view: ConversationView, task: ConversationTaskView, reason: string): Promise<void> {
  const text = reason.trim();
  if (!text) { message('请先写下阻塞原因。'); return; }
  const pauses = blockPausesRun(task);
  const runId = taskRunId(task);
  if (pauses && runId) {
    await api(`/runs/${encodeURIComponent(runId)}/pause`, {});
    task.status = 'paused';
  }
  await postRoomUpdate(`阻塞：${text}`, citeRefs(view, task));
  message(pauses
    ? `已暂停「${task.title}」这件 Run，并记下阻塞。讨论焦点没有改变。`
    : `已记下「${task.title}」的阻塞。这次只记在频道里。讨论焦点没有改变。`);
  await afterChannelWrite(view, task.id);
}
async function unblockChannelTask(view: ConversationView, task: ConversationTaskView, reason: string): Promise<void> {
  const text = reason.trim();
  if (!text) { message('请先写下解除原因。'); return; }
  const runId = taskRunId(task);
  const still = task.status === 'paused' && runId
    ? `这件 Run 仍是已暂停。`
    : runId && ['planning', 'running', 'reviewing'].includes(task.status)
      ? `这件 Run 仍在执行。`
      : `这次只改频道记录。`;
  await postRoomUpdate(`解除阻塞：${text}`, citeRefs(view, task));
  message(`已解除「${task.title}」的阻塞说明。${still}讨论焦点没有改变。`);
  await afterChannelWrite(view, task.id);
}
async function cancelChannelTask(view: ConversationView, task: ConversationTaskView, reason: string): Promise<void> {
  const text = reason.trim();
  if (!text) { message('请先写下取消原因。'); return; }
  const runId = task.runId ?? task.latestRunId;
  if (runId && !['succeeded', 'failed', 'cancelled'].includes(task.status)) {
    await api(`/runs/${encodeURIComponent(runId)}/cancel`, { reason: text });
    task.status = 'cancelled';
  }
  await postRoomUpdate(`取消：${text}`, citeRefs(view, task));
  message(runId ? `已取消「${task.title}」这件 Run。讨论焦点没有改变。` : `已在频道里取消「${task.title}」。这件还没有 Run。`);
  await afterChannelWrite(view, task.id);
}
async function restoreChannelTask(view: ConversationView, task: ConversationTaskView, reason: string): Promise<void> {
  const text = reason.trim();
  if (!text) { message('请先写下撤回原因。'); return; }
  await postRoomUpdate(`撤回取消：${text}`, citeRefs(view, task));
  message(task.status === 'cancelled'
    ? `已撤回「${task.title}」在频道里的取消说明。这件 Run 仍是已取消。讨论焦点没有改变。`
    : `已撤回「${task.title}」在频道里的取消。这次只改频道记录。讨论焦点没有改变。`);
  await afterChannelWrite(view, task.id);
}
async function acceptChannelTask(view: ConversationView, task: ConversationTaskView): Promise<void> {
  if (task.status !== 'succeeded' || boardDecision(view.id, task.id).accepted) return;
  await postRoomUpdate('验收通过', citeRefs(view, task));
  message(`已验收「${task.title}」。原来的产物还在，未另开 Run。`);
  await afterChannelWrite(view, task.id);
}
async function reviseChannelTask(view: ConversationView, task: ConversationTaskView, raw: string): Promise<void> {
  const text = raw.trim();
  if (!text) { message('请先写下要改的地方。'); return; }
  const bot = view.agentId ? botById(view.agentId) : undefined;
  if (!bot) { message('这件还没有可以承接修改的人。'); return; }
  const load = doingCount(bot.id);
  if (load >= 3) { message(`${bot.name}进行中已有 ${load} 件。先完成或转交。`); return; }
  const room = roomSummaries.find(item => item.id === openGroupId);
  const note = await recordRosterHandoff(bot, `要求修改「${task.title}」：${text}`, room, undefined, channelPostSession, title => `已另开修改讨论「${title}」。原来的产物还在，未执行。`);
  if (note) { message(note); return; }
  await postRoomUpdate(`要求修改：${text}`, citeRefs(view, task, bot.id));
  message(`已为「${task.title}」另开一条修改讨论。原来的产物还在。`);
  await afterChannelWrite(view, task.id);
}
function openChannelTask(view: ConversationView, task: ConversationTaskView, owner: string): void {
  const panel = $('channel-task');
  const title = $('channel-task-title');
  const body = $('channel-task-body');
  if (!panel || !body) return;
  if (title) title.textContent = task.title;
  body.dataset.task = task.id;
  body.replaceChildren();
  const decision = boardDecision(view.id, task.id);
  const column = boardColumn(task.status, decision, taskRunId(task));
  body.append(element('p', `${owner} · ${taskStateLabel(task)}`));
  const stopped = stopLine(task, decision);
  if (stopped) body.append(element('small', stopped));
  if (!blockNoteCurrent(task.status, decision) && decision.blockedNote) body.append(element('small', `频道里还留着阻塞说明：${decision.blockedNote}`));
  if (decision.assigneeId) body.append(element('small', `${botById(decision.assigneeId)?.name ?? decision.assigneeId}已领取`));
  if (decision.conflicts.length) body.append(element('small', '已被领取'));
  const steps = task.execution?.steps ?? [];
  body.append(element('small', steps.length ? steps.map(step => `${step.title}（${step.state === 'done' ? '已完成' : step.state === 'current' ? '正在做' : '还没开始'}）`).join('、') : '还没有执行步骤。'));
  const evidence = task.execution?.evidence ?? (view.lastDelivery?.taskId === task.id ? view.lastDelivery.artifactTitles : undefined) ?? [];
  body.append(element('small', evidence.length ? `证据：${evidence.join('、')}` : '未验证'));
  const chain = handoffChain(view.id, task.id);
  body.append(element('small', chain.length ? `交接：${chain.join(' → ')}` : '还没有交接记录。'));
  const spend = element('small', '还没有记下花费。');
  spend.dataset.spend = task.id;
  body.append(spend);
  body.append(element('small', '看一眼不会执行，也不会改讨论焦点。'));
  const runId = task.runId ?? task.latestRunId ?? (view.lastDelivery?.taskId === task.id ? view.lastDelivery.runId : undefined);
  if (runId) {
    const read = dashboardButton('阅读全文', () => openChannelArtifact(runId));
    read.dataset.readArtifact = runId;
    body.append(read);
    void api<RunView>(`/runs/${encodeURIComponent(runId)}`).then(run => {
      if (body.dataset.task === task.id) spend.textContent = spendLine(run);
    }).catch(() => { if (body.dataset.task === task.id) spend.textContent = '花费暂时读不到。'; });
  }
  const people = handoffChoices();
  const picker = document.createElement('select');
  picker.dataset.channelOwner = task.id;
  picker.setAttribute('aria-label', '交给谁');
  for (const bot of people) {
    const option = document.createElement('option');
    option.value = bot.id;
    option.textContent = bot.name;
    picker.append(option);
  }
  if (view.agentId && people.some(bot => bot.id === view.agentId)) picker.value = view.agentId;
  if (column === 'ready') {
    const claim = dashboardButton('领取', () => claimChannelTask(view, task, picker.value));
    claim.dataset.claimTask = task.id;
    body.append(picker, claim);
  }
  if (column === 'capture' || column === 'ready' || column === 'doing' || column === 'blocked') {
    const assign = dashboardButton('分派', () => handChannelTask(view, task, picker.value, '分派'));
    assign.dataset.assignTask = task.id;
    const transfer = dashboardButton('转交', () => handChannelTask(view, task, picker.value, '转交'));
    transfer.dataset.transferTask = task.id;
    if (column !== 'ready') body.append(picker);
    body.append(assign, transfer);
  }
  if (decision.assigneeId) {
    const reason = document.createElement('textarea');
    reason.dataset.refuseTask = task.id;
    reason.setAttribute('aria-label', '拒绝领取的原因');
    reason.maxLength = 500;
    reason.rows = 2;
    reason.placeholder = '写下拒绝领取的原因';
    const refuse = dashboardButton('拒绝领取', () => refuseChannelTask(view, task, reason.value));
    refuse.dataset.refuseSubmit = task.id;
    body.append(reason, refuse);
  }
  const pauses = blockPausesRun(task);
  const blockReason = document.createElement('textarea');
  blockReason.dataset.blockTask = task.id;
  blockReason.setAttribute('aria-label', pauses ? '阻塞原因，提交后会暂停这件 Run' : '阻塞原因，这次只记在频道里');
  blockReason.maxLength = 500;
  blockReason.rows = 2;
  blockReason.placeholder = pauses ? '写下阻塞原因。这会暂停这件 Run。' : '写下阻塞原因。这次只记在频道里。';
  const block = dashboardButton(pauses ? '暂停并标成阻塞' : '标成阻塞', () => blockChannelTask(view, task, blockReason.value));
  block.dataset.blockSubmit = task.id;
  const cancelReason = document.createElement('textarea');
  cancelReason.dataset.cancelTask = task.id;
  cancelReason.setAttribute('aria-label', '取消原因');
  cancelReason.maxLength = 500;
  cancelReason.rows = 2;
  cancelReason.placeholder = runId ? '写下取消原因。这会停下这件已经存在的 Run。' : '写下取消原因。这件还没有 Run，只记在频道里。';
  const cancel = dashboardButton(runId ? '取消这件 Run' : '在频道里取消', () => cancelChannelTask(view, task, cancelReason.value));
  cancel.dataset.cancelSubmit = task.id;
  if (column !== 'failed' && column !== 'done') body.append(blockReason, block, cancelReason, cancel);
  if (decision.blockedNote) {
    const unblockReason = document.createElement('textarea');
    unblockReason.dataset.unblockTask = task.id;
    unblockReason.setAttribute('aria-label', '解除阻塞的原因');
    unblockReason.maxLength = 500;
    unblockReason.rows = 2;
    unblockReason.placeholder = task.status === 'paused' && taskRunId(task)
      ? '写下解除原因。这只清掉频道里的阻塞说明。这件 Run 仍是已暂停。'
      : '写下解除原因。这只清掉频道里的阻塞说明。';
    const unblock = dashboardButton('解除阻塞', () => unblockChannelTask(view, task, unblockReason.value));
    unblock.dataset.unblockSubmit = task.id;
    body.append(unblockReason, unblock);
  }
  if (decision.cancelled) {
    const restoreReason = document.createElement('textarea');
    restoreReason.dataset.restoreTask = task.id;
    restoreReason.setAttribute('aria-label', '撤回取消的原因');
    restoreReason.maxLength = 500;
    restoreReason.rows = 2;
    restoreReason.placeholder = task.status === 'cancelled'
      ? '写下撤回原因。这次只清掉频道里的说明。这件 Run 仍是已取消。'
      : '写下撤回原因。这次只改频道记录。';
    const restore = dashboardButton('撤回频道里的取消', () => restoreChannelTask(view, task, restoreReason.value));
    restore.dataset.restoreSubmit = task.id;
    body.append(restoreReason, restore);
  }
  if (task.status === 'succeeded' && !decision.accepted) {
    const accept = dashboardButton('验收', () => acceptChannelTask(view, task));
    accept.dataset.acceptTask = task.id;
    const reviseText = document.createElement('textarea');
    reviseText.dataset.reviseTask = task.id;
    reviseText.maxLength = 500;
    reviseText.rows = 2;
    reviseText.placeholder = '写下要改的地方。会另开一条讨论，原来的产物还在。';
    const revise = dashboardButton('要求修改', () => reviseChannelTask(view, task, reviseText.value));
    revise.dataset.reviseSubmit = task.id;
    body.append(accept, reviseText, revise);
  }
  if (decision.accepted) body.append(element('small', '已验收。原来的产物还在。'));
  panel.hidden = false;
}
function hideChannelArtifact(): void {
  const panel = $('channel-artifact');
  const body = $('channel-artifact-body');
  if (panel) panel.hidden = true;
  if (body) body.replaceChildren();
}
async function openChannelArtifact(runId: string): Promise<void> {
  const panel = $('channel-artifact');
  const body = $('channel-artifact-body');
  const roomId = openGroupId;
  if (!panel || !body || !roomId) return;
  body.replaceChildren(element('p', '正在读取产物。看一眼不会执行。'));
  panel.hidden = false;
  try {
    const run = await api<RunView>(`/runs/${encodeURIComponent(runId)}`);
    if (openGroupId !== roomId) return;
    body.replaceChildren();
    const artifacts = (run.artifacts ?? []).slice(0, 8);
    if (!artifacts.length) {
      body.append(element('p', '这件 Run 还没有写下产物。'));
      return;
    }
    for (const artifact of artifacts) {
      const block = element('article', '', 'channel-artifact-item');
      block.append(element('strong', artifact.title.trim() || '未命名产物'));
      const text = artifact.content.trim();
      block.append(element('p', text ? (text.length > 4000 ? `${text.slice(0, 4000)}…` : text) : '这篇产物还没有正文。'));
      if (artifact.evidenceRefs?.length) block.append(element('small', `证据：${artifact.evidenceRefs.slice(0, 8).join('、')}`));
      body.append(block);
    }
  } catch (error) {
    body.replaceChildren(element('p', errorMessage(error)));
  }
}
function appendHandoffCard(item: HTMLElement, event: SessionEventSummary, drafts: { answer: Map<string, string>; reject: Map<string, string> } = { answer: new Map(), reject: new Map() }): void {
  const cite = handoffCitation(event);
  if (!cite) return;
  const view = handoffViews.get(cite.conversationId);
  const task = view?.tasks.find(candidate => candidate.id === cite.taskId);
  const card = element('div', '', 'group-run-card');
  card.dataset.card = 'handoff';
  card.dataset.handoff = cite.taskId;
  const named = cite.agentId ? botById(cite.agentId) : undefined;
  const viewed = !named && view?.agentId ? botById(view.agentId) : undefined;
  const person = named?.name ?? cite.agentId ?? viewed?.name ?? view?.agentId ?? '这个人';
  card.append(element('strong', `交给${person}`));
  if (!view) card.append(element('small', '正在读取这件事。看一眼不会执行。'));
  else if (!task) card.append(element('small', '这条讨论不在这个人的对话里。'));
  else card.append(element('small', task.title));
  const bot = named ?? viewed;
  if (bot) {
    const open = element('button', `打开${bot.name}`) as HTMLButtonElement;
    open.type = 'button';
    open.dataset.openLife = bot.id;
    open.addEventListener('click', () => { void openLifeThread(bot.id).catch(error => message(errorMessage(error))); });
    card.append(open);
  }
  item.append(card);
  if (!task) return;
  const taskCard = element('div', '', 'group-run-card');
  taskCard.dataset.card = 'task';
  taskCard.dataset.handoff = cite.taskId;
  const state = task.status === 'discussion' ? '仅讨论，未执行' : task.status === 'preparing' ? '正在准备执行' : runStatusLabel(task.status);
  taskCard.append(element('strong', '任务'), element('small', task.title), element('small', state));
  if (task.execution?.steps.length) taskCard.append(element('small', executionLine(task.execution), 'conversation-steps'));
  taskCard.append(element('small', '这张卡只描述这件事。看一眼不会执行。'));
  item.append(taskCard);
  const delivery = view?.lastDelivery?.taskId === task.id ? view.lastDelivery : undefined;
  const artifactTitles = task.execution?.evidence?.length ? task.execution.evidence : (delivery?.artifactTitles ?? []);
  if (artifactTitles.length || delivery?.planSummary) {
    const artifact = element('div', '', 'group-run-card');
    artifact.dataset.card = 'artifact';
    artifact.dataset.handoff = cite.taskId;
    artifact.append(element('strong', '产物'));
    if (delivery?.planSummary) artifact.append(element('small', `结论：${delivery.planSummary}`));
    if (artifactTitles.length) artifact.append(element('small', artifactTitles.join('、')));
    artifact.append(element('small', '在频道里阅读。不会改讨论焦点，也不会另开一件 Run。'));
    const artifactRunId = task.runId ?? task.latestRunId ?? delivery?.runId;
    if (artifactRunId) {
      const read = dashboardButton('阅读全文', () => openChannelArtifact(artifactRunId));
      read.dataset.readArtifact = artifactRunId;
      artifact.append(read);
    }
    if (view && task.status === 'succeeded') {
      const decision = boardDecision(cite.conversationId, task.id);
      if (decision.accepted) artifact.append(element('small', '已验收。原来的产物还在。'));
      else {
        const accept = dashboardButton('验收', () => acceptChannelTask(view, task));
        accept.dataset.acceptTask = task.id;
        const reviseText = document.createElement('textarea');
        reviseText.dataset.reviseTask = task.id;
        reviseText.maxLength = 500;
        reviseText.rows = 2;
        reviseText.placeholder = '写下要改的地方。会另开一条讨论，原来的产物还在。';
        const revise = dashboardButton('要求修改', () => reviseChannelTask(view, task, reviseText.value));
        revise.dataset.reviseSubmit = task.id;
        artifact.append(accept, reviseText, revise);
      }
    }
    item.append(artifact);
  }
  const decision = (kind: string, title: string, copy: string) => {
    const extra = element('div', '', 'group-run-card');
    extra.dataset.card = kind;
    extra.dataset.handoff = cite.taskId;
    extra.append(element('strong', title), element('small', copy), element('small', '在这个人的对话里处理。这里只读，不会执行。'));
    item.append(extra);
  };
  if (task.pendingApproval && task.runId) {
    const extra = element('div', '', 'group-run-card');
    extra.dataset.card = 'approval';
    extra.dataset.handoff = cite.taskId;
    extra.append(element('strong', '审批'), element('small', `待批准：${task.pendingApproval.summary}`), element('small', '在这里批准或拒绝。不会改讨论焦点，也不会另开一件 Run。'));
    const approve = dashboardButton('批准并执行', () => approveConversationTask(task, 'task'));
    approve.dataset.approve = task.id;
    const once = dashboardButton('仅这一次', () => approveConversationTask(task, 'once'));
    once.dataset.approveOnce = task.id;
    once.title = '记在这次批准记录上。这次仍按当前计划执行，以后的计划仍要再批。';
    const field = document.createElement('textarea');
    field.className = 'conversation-answer'; field.maxLength = 8000; field.rows = 2;
    field.placeholder = '写下拒绝原因。拒绝后重新规划，新计划仍停在等待批准，不会按这份计划执行。';
    field.dataset.reject = task.id;
    const rejectDraft = drafts.reject.get(task.id);
    if (rejectDraft) field.value = rejectDraft;
    const reject = dashboardButton('拒绝并说明', () => rejectConversationTask(task, field.value));
    reject.dataset.rejectSubmit = task.id;
    extra.append(approve, once, field, reject);
    item.append(extra);
  } else if (task.pendingApproval) decision('approval', '审批', `待批准：${task.pendingApproval.summary}`);
  if (task.pendingQuestion && task.runId) {
    const extra = element('div', '', 'group-run-card');
    extra.dataset.card = 'question';
    extra.dataset.handoff = cite.taskId;
    extra.append(element('strong', '提问'), element('small', `待回答：${task.pendingQuestion.text}`), element('small', '在这里回答。不会改讨论焦点，也不会另开一件 Run。'));
    const field = document.createElement('textarea');
    field.className = 'conversation-answer'; field.maxLength = 8000; field.rows = 2;
    field.placeholder = '回答后从当前节点继续';
    field.dataset.answer = task.id;
    field.setAttribute('aria-label', `回答「${task.title}」`);
    const answerDraft = drafts.answer.get(task.id);
    if (answerDraft) field.value = answerDraft;
    const submit = dashboardButton('提交回答', () => answerConversationTask(task, field.value));
    submit.dataset.answerSubmit = task.id;
    extra.append(field, submit);
    item.append(extra);
  } else if (task.pendingQuestion) decision('question', '提问', `待回答：${task.pendingQuestion.text}`);
  if (task.status === 'unknown' || task.status === 'waiting_external') decision('reconcile', '核查', task.status === 'unknown' ? '结果需要核查。' : '还在等外部回执。');
  if (task.status === 'failed') decision('blocked', '卡住', '这件工作失败了。先看原因，再决定是否重试。');
}
async function refreshHandoffViews(): Promise<void> {
  const epoch = ++handoffEpoch;
  const roomId = openGroupId;
  const ids = [...new Set(visibleChannelEvents().flatMap(event => {
    const cite = handoffCitation(event);
    return cite ? [cite.conversationId] : [];
  }))];
  if (!ids.length || !roomId) return;
  const views = await Promise.all(ids.map(async id => {
    try { return await api<ConversationView>(`/conversations/${encodeURIComponent(id)}`); }
    catch { return undefined; }
  }));
  if (epoch !== handoffEpoch || openGroupId !== roomId) return;
  ids.forEach((id, index) => {
    const view = views[index];
    if (view) handoffViews.set(id, view);
  });
  renderGroupTranscript();
  if (!$('channel-studio')?.hidden) renderStudio();
}
function groupOccupancy(): number {
  return 1 + draftAgents.size + draftPeople.length;
}

function hideChannelSurfaces(): void {
  hideChannelArtifact();
  hideChannelBoard();
  stopStudioPlay();
  studioIndex = -1;
  studioKey = '';
  const memory = $('channel-memory');
  const profile = $('channel-bot');
  const studio = $('channel-studio');
  const digest = $('channel-digest');
  const teach = $('channel-teach');
  if (memory) memory.hidden = true;
  if (profile) profile.hidden = true;
  if (studio) studio.hidden = true;
  if (digest) digest.hidden = true;
  if (teach) teach.hidden = true;
}
function leaveGroup(): void {
  openGroupId = '';
  groupMembers = [];
  resetChannelLog();
  handoffViews.clear();
  groupDraftOpen = false;
  hideChannelSurfaces();
  localStorage.removeItem('aeeis.group');
  document.body.classList.remove('group-open', 'group-draft');
  const panel = $('group-panel');
  const draft = $('group-draft');
  const composer = $('group-composer');
  if (panel) panel.hidden = true;
  if (draft) draft.hidden = true;
  if (composer) composer.hidden = true;
  syncComposerHeading();
}
function clearOpenGroup(): void {
  openGroupId = '';
  groupMembers = [];
  resetChannelLog();
  handoffViews.clear();
  hideChannelSurfaces();
  localStorage.removeItem('aeeis.group');
}
function showRoster(focused = true): void {
  document.body.classList.toggle('roster-focus', focused);
  if (focused) document.body.classList.remove('draft-open');
}
function syncShellClasses(): void {
  const view = rosterView();
  document.body.classList.toggle('group-draft', view === 'draft');
  document.body.classList.toggle('group-open', view === 'group' || view === 'direct');
  if (view === 'bot' || view === 'draft' || view === 'group' || view === 'direct') {
    document.body.classList.remove('roster-focus');
    document.body.classList.add('draft-open');
  }
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
    const role = $('bot-profile-role');
    if (role) role.textContent = counterpart?.note ? `职责：${counterpart.note}` : '职责：入口。讨论从这里记下，执行要明确创建 Run。';
  }
  const botStatus = $('bot-status');
  if (botStatus) {
    const personId = view === 'bot' ? activeBotId() : '';
    const presence = personId ? lifePresence(personId) : undefined;
    botStatus.hidden = view !== 'bot';
    botStatus.textContent = presence ? (presence.taskTitle && presence.state !== 'idle' ? `${presence.label} · ${presence.taskTitle}。看一眼不会执行。` : `${presence.label}。看一眼不会执行。`) : '';
  }
  const chatNote = $('chat-note');
  const rename = $('group-rename');
  const send = document.querySelector<HTMLButtonElement>('#group-composer button[type="submit"]');
  const groupText = $<HTMLTextAreaElement>('group-text');
  if (chatNote) chatNote.textContent = view === 'direct'
    ? '这间私聊只保留会话记录。选说话人只是标明这句话是谁说的，对方不会自己回复，也不会执行。@AEEIS 会记到 AEEIS 的对话里，不执行。归档后从成员列表里撤下，不会改讨论焦点，也不会停下任务。'
    : '这是群聊。每句话都留在这间房里，入口收下并记成一条讨论。@群里的一个人，是请那个人回应，这句话仍留在入口。@所有人或点到多个人时，入口只记一条，不拆开。选一位说话人，只是标明这句话是谁说的，入口同样收下。选「交给」会再请那个人回应。都不会执行，也不会调用模型。频道里可以批准或拒绝已经摆出来的计划，也可以阅读已经写下的产物。归档后从群聊列表撤下。';
  if (rename) rename.hidden = view === 'direct';
  if (send) send.textContent = view === 'direct' ? '发给这位' : '发到群里';
  if (groupText) groupText.placeholder = view === 'direct' ? '写给这一位。@AEEIS 会记到 AEEIS 的对话里，不执行，也不调用模型。' : '写到这间群里。@AEEIS、没点名，入口都会收下。@群里的一个人是请他回应。@所有人仍记成一条。不执行，也不调用模型。';
  const sendNote = $('group-send-note');
  if (sendNote) sendNote.textContent = view === 'direct'
    ? '批准、登录和密钥仍留在和 AEEIS 的单独对话。发送先写入这个 Room 的会话记录。选一位说话人，只是标明这句话是谁说的。'
    : '批准、登录和密钥仍留在和 AEEIS 的单独对话。发送先写入这个 Room 的会话记录。入口收下这句话。@到群里的一个人时，再记一条请他回应的讨论，不执行。选一位说话人，只是标明这句话是谁说的。';
  syncGroupSpeaker();
  syncLifeSpeaker();
  const directName = botById(directPrincipal)?.name ?? room?.title ?? directPrincipal;
  const personName = view === 'direct' ? (directName || '成员') : (counterpart?.name ?? '成员');
  const entryTitle = $('entry-title');
  const entryPresence = $('entry-presence');
  const titleText = view === 'group' ? (room?.title || '群聊') : view === 'draft' ? '新建群聊' : (view === 'direct' || view === 'bot') ? personName : 'AEEIS';
  const presenceText = view === 'group' ? '群聊' : view === 'direct' ? '私聊' : view === 'draft' ? '选择成员' : lifePresenceLabel(view === 'bot' ? activeBotId() : 'aeeis');
  if (entryTitle) entryTitle.textContent = titleText;
  if (entryPresence) entryPresence.textContent = presenceText;
  const shellTitle = $('gb-title');
  const shellPresence = $('gb-presence');
  if (shellTitle) shellTitle.textContent = titleText;
  if (shellPresence) shellPresence.textContent = presenceText;
  const stageEmpty = $('empty');
  if (stageEmpty && conversationEnabled) stageEmpty.hidden = true;
  syncShellClasses();
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
  if (conversationEnabled) {
    void openLifeThread(id).catch(error => message(errorMessage(error)));
    return;
  }
  if (id === 'aeeis') { showEntry(); return; }
  selectedBotId = id;
  localStorage.setItem('aeeis.bot', id);
  entryEpoch += 1;
  leaveGroup();
  stopRunEventStream();
  currentId = '';
  current = undefined;
  localStorage.removeItem('aeeis.run');
  document.body.classList.remove('roster-focus');
  document.body.classList.add('draft-open');
  setCurrentRunOpen(false);
  if (!readOnlyShare && !linkedThreadId && window.location.pathname !== '/') window.history.replaceState(null, '', '/');
  setIntentPresetsOpen(false);
  renderBotRoster();
  renderRunQueue(runSummaries);
  syncPresence();
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
  const proposal = $('group-proposal');
  if (proposal) proposal.textContent = groupProposalText();
}
function groupProposalText(): string {
  const reused = [...draftAgents].map(id => participantLabel(id));
  const roster = reused.length ? `复用${reused.join('、')}。` : '优先复用名单里已有的人。';
  const extras = draftPeople.length ? `名单以外：${draftPeople.join('、')}。` : '';
  const reason = $<HTMLInputElement>('group-newcomer-reason')?.value.trim() ?? '';
  const why = reason ? '原因已写下。' : '';
  return `提议：AEEIS 担任 PM。${roster}${extras}一共 ${groupOccupancy()} / 6。创建前确认这一组。${why}`;
}
function reuseRoster(): void {
  for (const bot of rosterBots()) {
    if (bot.id === 'aeeis' || draftAgents.has(bot.id)) continue;
    if (groupOccupancy() >= 6) break;
    draftAgents.add(bot.id);
  }
  renderGroupCandidates();
}
function showGroupDraft(): void {
  clearOpenGroup();
  showRoster(false);
  draftAgents.clear();
  draftPeople = [];
  groupDraftOpen = true;
  setCurrentRunOpen(false);
  renderBotRoster();
  updateConversationControls();
  const title = $<HTMLInputElement>('group-title');
  if (title) { title.value = ''; title.focus(); }
  const person = $<HTMLInputElement>('group-person');
  if (person) person.value = '';
  const reason = $<HTMLInputElement>('group-newcomer-reason');
  if (reason) reason.value = '';
  renderGroupCandidates();
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
  const reason = $<HTMLInputElement>('group-newcomer-reason')?.value.trim() ?? '';
  const reused = [...draftAgents].map(id => participantLabel(id));
  const newcomers = [...draftPeople];
  groupDraftOpen = false;
  message('');
  await openGroup(room.id);
  if (reason && newcomers.length) {
    const roster = reused.length ? `复用${reused.join('、')}。` : '';
    await channelPostSession('system', `分工：AEEIS 担任 PM。${roster}名单以外的人：${newcomers.join('、')}。原因：${reason}。`);
  }
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
    resetChannelLog();
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
  if (openGroupId !== id) { groupMembers = []; resetChannelLog(); handoffViews.clear(); hideChannelSurfaces(); }
  openGroupId = id;
  groupDraftOpen = false;
  showRoster(false);
  localStorage.setItem('aeeis.group', id);
  renderGroups(roomSummaries);
  $<HTMLTextAreaElement>('group-text')?.focus();
}
function finishChannelRead(id: string, epoch: number): void {
  if (openGroupId !== id || channelLoadedRoomId !== id || epoch !== channelReadEpoch) return;
  renderGroupTranscript();
  void refreshHandoffViews();
  if (channelBoardOpen) renderChannelBoard();
  if (!$('channel-studio')?.hidden) renderStudio();
  if (!$('channel-digest')?.hidden) renderDigestBody();
}
async function refreshLoadedChannel(id: string): Promise<void> {
  const epoch = channelReadEpoch;
  const membersPromise = api<RoomMemberSummary[]>(`/rooms/${encodeURIComponent(id)}/members`).catch(() => [] as RoomMemberSummary[]);
  if (!channelEventsCaughtUp && groupEventCursor) {
    const members = await membersPromise;
    if (openGroupId !== id || channelLoadedRoomId !== id || epoch !== channelReadEpoch) return;
    groupMembers = members.filter(member => member.status === 'active');
    finishChannelRead(id, epoch);
    await absorbLaterEvents(id, epoch);
    finishChannelRead(id, epoch);
    return;
  }
  if (channelEventsCaughtUp && groupEventCursor) {
    const cursor = groupEventCursor;
    const [members, page] = await Promise.all([
      membersPromise,
      api<SessionEventPage>(`/rooms/${encodeURIComponent(id)}/session-events?limit=50&cursor=${encodeURIComponent(cursor)}`).catch((): SessionEventPage => ({ items: [] })),
    ]);
    if (openGroupId !== id || channelLoadedRoomId !== id || epoch !== channelReadEpoch) return;
    groupMembers = members.filter(member => member.status === 'active');
    appendUnseen(page.items, liveChannelEvents);
    noteEventPage(page, cursor);
    finishChannelRead(id, epoch);
    if (!channelEventsCaughtUp) {
      await absorbLaterEvents(id, epoch);
      finishChannelRead(id, epoch);
    }
    return;
  }
  const [members, events] = await Promise.all([
    membersPromise,
    api<SessionEventPage>(`/rooms/${encodeURIComponent(id)}/session-events?limit=50`).catch((): SessionEventPage => ({ items: [] })),
  ]);
  if (openGroupId !== id || channelLoadedRoomId !== id || epoch !== channelReadEpoch) return;
  groupMembers = members.filter(member => member.status === 'active');
  const held = new Set([...laterChannelEvents, ...liveChannelEvents].map(event => event.id));
  groupEvents = (events.items ?? []).filter(event => !held.has(event.id));
  noteEventPage(events, undefined);
  finishChannelRead(id, epoch);
  if (!channelEventsCaughtUp) {
    await absorbLaterEvents(id, epoch);
    finishChannelRead(id, epoch);
  }
}
async function loadGroupFromStart(id: string): Promise<void> {
  const epoch = ++channelReadEpoch;
  const [members, events] = await Promise.all([
    api<RoomMemberSummary[]>(`/rooms/${encodeURIComponent(id)}/members`).catch(() => [] as RoomMemberSummary[]),
    api<SessionEventPage>(`/rooms/${encodeURIComponent(id)}/session-events?limit=50`).catch((): SessionEventPage => ({ items: [] })),
  ]);
  if (openGroupId !== id || epoch !== channelReadEpoch) return;
  groupMembers = members.filter(member => member.status === 'active');
  groupEvents = events.items ?? [];
  laterChannelEvents = [];
  liveChannelEvents = [];
  channelLoadedRoomId = id;
  noteEventPage(events, undefined);
  finishChannelRead(id, epoch);
  if (!channelEventsCaughtUp) {
    await absorbLaterEvents(id, epoch);
    finishChannelRead(id, epoch);
  }
}
function trackChannelRead(run: Promise<void>): Promise<void> {
  const tracked = run.finally(() => { if (channelReadFlight === tracked) channelReadFlight = undefined; });
  channelReadFlight = tracked;
  return tracked;
}
async function loadGroup(id: string): Promise<void> {
  if (channelReadFlight) await channelReadFlight.catch(() => undefined);
  if (openGroupId !== id) return;
  if (channelLoadedRoomId === id) return trackChannelRead(refreshLoadedChannel(id));
  return trackChannelRead(loadGroupFromStart(id));
}
function renderGroupTranscript(): void {
  const list = $('group-transcript');
  const empty = $('group-thread-empty');
  if (!list) return;
  if (empty) empty.hidden = channelBoardOpen || channelReadableEvents().length > 0;
  list.hidden = channelBoardOpen;
  const key = channelTranscriptSignature();
  if (key === channelTranscriptKey) return;
  channelTranscriptKey = key;
  const members = $('group-members');
  if (members) {
    const archive = (id: string) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quiet-button';
      button.dataset.botProfile = id;
      button.textContent = '档案';
      button.addEventListener('click', () => { void openChannelBot(id).catch(error => message(errorMessage(error))); });
      return button;
    };
    members.replaceChildren(document.createTextNode('AEEIS'), archive('aeeis'));
    for (const member of groupMembers) {
      members.append(document.createTextNode('、'));
      const openMember = document.createElement('button');
      openMember.type = 'button';
      openMember.className = 'quiet-button';
      openMember.textContent = participantLabel(member.principalId);
      openMember.addEventListener('click', () => { void openDirect(member.principalId).catch(error => message(errorMessage(error))); });
      members.append(openMember, archive(member.principalId));
    }
  }
  const answerDrafts = new Map<string, string>();
  const rejectDrafts = new Map<string, string>();
  list.querySelectorAll<HTMLTextAreaElement>('textarea[data-answer]').forEach(field => {
    if (field.dataset.answer) answerDrafts.set(field.dataset.answer, field.value);
  });
  list.querySelectorAll<HTMLTextAreaElement>('textarea[data-reject]').forEach(field => {
    if (field.dataset.reject) rejectDrafts.set(field.dataset.reject, field.value);
  });
  list.replaceChildren();
  const earlier = earlierChannelCount();
  if (earlier > 0) {
    const row = element('li', '', 'group-earlier');
    const older = element('button', `查看更早的消息 · 还有 ${earlier} 条`, 'quiet-button') as HTMLButtonElement;
    older.type = 'button';
    older.dataset.earlierMessages = String(earlier);
    older.addEventListener('click', () => {
      channelHistoryPages += 1;
      renderGroupTranscript();
      void refreshHandoffViews();
    });
    row.append(older);
    list.append(row);
  }
  for (const event of visibleChannelEvents()) {
    if (event.operation === 'retract') continue;
    const item = element('li', '', 'group-message');
    item.dataset.type = event.type;
    item.dataset.kind = event.type === 'system' ? 'system' : event.actorType === 'agent' ? 'bot' : event.type === 'message' ? 'human' : event.type;
    const heading = element('header');
    heading.append(element('strong', eventAuthor(event)), element('small', formatTime(event.createdAt)));
    item.append(heading, element('p', event.content));
    appendHandoffCard(item, event, { answer: answerDrafts, reject: rejectDrafts });
    list.append(item);
  }
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
function mentionOf(label: string, text: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])@${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(text.normalize('NFKC'));
}
function mentionedGroupBots(text: string): RosterBot[] {
  const members = new Set(groupMembers.filter(member => member.role === 'agent' && member.status === 'active').map(member => member.principalId));
  return rosterBots().filter(bot => bot.id !== 'aeeis' && members.has(bot.id) && mentionOf(bot.name, text));
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
function selectedHandoffBot(): RosterBot | undefined {
  if (rosterView() !== 'group') return;
  const id = $<HTMLSelectElement>('group-handoff')?.value.trim() ?? '';
  if (!id) return;
  return handoffChoices().find(bot => bot.id === id);
}
async function recordRosterHandoff(
  bot: RosterBot,
  text: string,
  room: RoomSummary | undefined,
  spoken: { type: 'agent' | 'principal'; id: string } | undefined,
  postSession: (type: 'message' | 'system', content: string, evidenceRefs?: string[]) => Promise<unknown>,
  receipt: (title: string) => string,
): Promise<string> {
  const kind = room?.description === '私聊' ? '私聊' : '群聊';
  const roomTitle = room?.title || kind;
  const title = entryMentionTitle(text, roomTitle, kind);
  const known = bot.id === 'aeeis' ? aeeisThread() : lifeSummary(bot.id);
  if (bot.id === 'aeeis') {
    if (!conversationEnabled || !known) return '这条点名了 AEEIS，入口讨论还没打开，所以只留在会话里。';
    if (conversationBusy || conversationAttempt) return '入口正在发送另一条讨论，这条点名只留在会话里。';
  } else if (!conversationEnabled) return `还没打开${bot.name}的对话，这句话只留在会话里。`;
  else if (conversationBusy || conversationAttempt) return `${bot.name}正在发送另一条讨论，这句话只留在会话里。`;
  const epoch = conversationEpoch;
  conversationBusy = true;
  updateConversationControls();
  let conversationId = known?.id ?? '';
  let taskId = '';
  let handoffError = '';
  let recorded = false;
  try {
    let target = known;
    if (!target) {
      const created = await api<ConversationView>('/conversations', { title: bot.name, agentId: bot.id });
      if (epoch !== conversationEpoch) return '';
      rememberLifeSummary(created);
      target = created;
    }
    conversationId = target.id;
    const expectedRevision = conversation?.id === conversationId ? conversation.revision : target.revision;
    const result = await api<ConversationPost>(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
      text: clipEntryText(`来自${kind}「${roomTitle}」：${text}`, 7000),
      expectedRevision,
      newTask: { title },
      focus: 'keep',
      intent: 'discuss',
      ...(spoken?.type === 'agent' ? { speaker: { role: 'agent' as const, id: spoken.id } } : {}),
    }, 'POST', groupIdempotencyKey());
    taskId = result.message.route.taskIds.find(item => CITATION_ID.test(item)) ?? '';
    if (epoch === conversationEpoch && result.conversation?.id === conversationId) {
      handoffViews.set(conversationId, result.conversation);
      if (conversation?.id === conversationId) acceptConversation(result.conversation);
      else rememberLifeSummary(result.conversation);
    }
    recorded = epoch === conversationEpoch;
  } catch (error) {
    handoffError = bot.id === 'aeeis'
      ? `会话已留下，入口讨论没有记上。${errorMessage(error)}`
      : `会话已留下，${bot.name}的讨论没有记上。${errorMessage(error)}`;
  } finally {
    if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); }
  }
  if (handoffError || !recorded) return handoffError;
  const cited = CITATION_ID.test(conversationId) && CITATION_ID.test(taskId);
  try {
    await postSession('system', receipt(title), cited ? [conversationId, taskId, bot.id].filter(item => CITATION_ID.test(item)) : undefined);
  } catch (error) {
    return bot.id === 'aeeis'
      ? `入口讨论已记下，回执没有写进会话。${errorMessage(error)}`
      : `已交给${bot.name}，回执没有写进会话。${errorMessage(error)}`;
  }
  return '';
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
  const postSession = (type: 'message' | 'system', content: string, evidenceRefs?: string[]) => api(`/rooms/${encodeURIComponent(roomId)}/session-events`, {
    goalId: goal.id, type, content, contextManifestId: manifest.id, idempotencyKey: groupIdempotencyKey(),
    ...(type === 'message' && spoken ? { actor: spoken } : {}),
    ...(evidenceRefs?.length ? { evidenceRefs } : {}),
  });
  await postSession('message', text);
  if (input) input.value = '';
  let handoffError = '';
  const chosen = selectedHandoffBot();
  const inGroup = room?.description !== '私聊';
  const handTo = (bot: RosterBot, receipt: (title: string) => string) => recordRosterHandoff(bot, text, room, spoken, postSession, receipt);
  const home = botById('aeeis');
  if (!inGroup) {
    if (mentionsAeeis(text) && home) handoffError = await handTo(home, title => `已记为入口讨论「${title}」。未执行，讨论焦点不变。`);
  } else if (home) {
    const named = mentionedGroupBots(text);
    const addressed = mentionsAeeis(text);
    const crowd = mentionOf('所有人', text) || mentionOf('团队', text) || named.length > 1 || (addressed && named.length > 0);
    const asked = chosen && chosen.id !== 'aeeis'
      ? chosen
      : (!chosen && !crowd && named.length === 1 && !addressed ? named[0] : undefined);
    const entryError = await handTo(home, title => {
      if (chosen?.id === 'aeeis') return `已交给AEEIS，记为讨论「${title}」。未执行，对方不会自己回复。`;
      if (asked) return `入口收下了这句话，记成讨论「${title}」。已请${asked.name}回应。未执行，讨论焦点不变。`;
      if (crowd) return `入口记下了这句话，记成讨论「${title}」。没有拆给多个人，也未执行。`;
      if (addressed) return `已记为入口讨论「${title}」。未执行，讨论焦点不变。`;
      return `入口收下了这句话，记成讨论「${title}」。未执行，讨论焦点不变。`;
    });
    const askedError = asked
      ? await handTo(asked, title => chosen
        ? `已交给${asked.name}，记为讨论「${title}」。这句话也留在入口。未执行，对方不会自己回复。`
        : `已请${asked.name}回应，记为讨论「${title}」。这句话也留在入口。未执行，对方不会自己回复。`)
      : '';
    handoffError = [entryError, askedError].filter(Boolean).join(' ');
    if (chosen && !(chosen.id === 'aeeis' ? entryError : askedError)) {
      const select = $<HTMLSelectElement>('group-handoff');
      if (select) select.value = '';
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
function machineLine(machine: { state: 'absent' | 'present' | 'released' | 'unknown'; ready: boolean }): string {
  if (machine.state === 'unknown') return '这件工作的机器记录读不出来。看一眼不会执行。';
  if (machine.state === 'released') return '这件工作的机器已经收掉。';
  if (machine.state === 'present' && machine.ready) return '这件工作有一台机器，还在。看一眼不会执行。';
  if (machine.state === 'present') return '这件工作的机器还没准备好。看一眼不会启动它。';
  return '这件工作还没有机器。';
}
function executionLine(execution: { steps: Array<{ title: string; state: 'done' | 'current' | 'waiting' }> }): string {
  const label = (state: 'done' | 'current' | 'waiting') => state === 'done' ? '已完成' : state === 'current' ? '正在做' : '还没到';
  return `执行步骤：${execution.steps.map(step => `${step.title} ${label(step.state)}`).join(' · ')}`;
}
/** One plain word for where a task's Run stands, and the colour that word is shown in. */
function taskStatusWord(task: ConversationTaskView): { word: string; tone: 'quiet' | 'ink' | 'attention' | 'done' | 'stuck' } {
  switch (task.status) {
    case 'preparing': case 'queued': case 'planning': return { word: '起草中', tone: 'quiet' };
    case 'needs_approval': return task.pendingApproval ? { word: '等你确认计划', tone: 'quiet' } : { word: '需要你', tone: 'attention' };
    case 'needs_input': return { word: '需要你', tone: 'attention' };
    case 'running': case 'waiting_external': case 'reviewing': return { word: '执行中', tone: 'ink' };
    case 'succeeded': return { word: '已完成', tone: 'done' };
    case 'failed': case 'unknown': return { word: '卡住了', tone: 'stuck' };
    case 'cancelled': return { word: '已取消', tone: 'quiet' };
    case 'paused': return { word: '已暂停', tone: 'quiet' };
    default: return { word: runStatusLabel(task.status), tone: 'quiet' };
  }
}
/** One sentence on what the Run is doing now, or what it needs. */
function taskActivity(task: ConversationTaskView): string {
  const steps = task.execution?.steps ?? [];
  const index = Math.max(0, steps.findIndex(step => step.state !== 'done'));
  const at = steps.length ? `第 ${Math.min(index + 1, steps.length)} 步 / 共 ${steps.length} 步` : '';
  const title = steps[index]?.title;
  const evidence = task.execution?.evidence?.length ?? 0;
  switch (task.status) {
    case 'preparing': case 'queued': case 'planning': return '正在起草计划。';
    case 'needs_approval': return task.pendingApproval ? '计划好了，点“开始”它就去做。' : `停在${at || '当前这一步'}，等你决定一个动作。`;
    case 'needs_input': return `停在${at || '当前这一步'}，等你回答一个问题。`;
    case 'running': return title ? `正在做${at}：${title}。` : '正在做。';
    case 'waiting_external': return `在等外部回执${at ? `（${at}）` : ''}。`;
    case 'reviewing': return '在复核结果。';
    case 'paused': return `已暂停${at ? `，停在${at}` : ''}。`;
    case 'succeeded': return evidence ? `做完了，留下 ${evidence} 份证据。` : '做完了。';
    case 'failed': return `在${at || '执行中'}卡住了。可以重试，或打开工作台看原因。`;
    case 'unknown': return '有一次调用结果未知，需要你核查后才能继续。';
    case 'cancelled': return '已取消，不会再执行。';
    default: return '';
  }
}
/** A task's Run, shown in the transcript under the message that started it: status, what it is doing, progress and the plan. Its buttons use the same Run commands as the task table. */
function conversationPlanCard(task: ConversationTaskView, feedbackDraft = ''): HTMLElement {
  const card = element('section', '', 'plan-card');
  card.dataset.planTask = task.id;
  card.dataset.state = task.pendingApproval ? 'awaiting' : task.status;
  const status = taskStatusWord(task);
  card.dataset.tone = status.tone;
  card.setAttribute('aria-label', `「${task.title}」的运行`);
  const head = element('div', '', 'plan-card-head');
  head.append(element('strong', task.title, 'plan-card-title'), element('span', status.word, 'plan-card-status'));
  card.append(head);
  const activity = taskActivity(task);
  if (activity) card.append(element('p', activity, 'plan-card-activity'));
  const steps = task.execution?.steps ?? [];
  if (steps.length) {
    const done = steps.filter(step => step.state === 'done').length;
    const strip = element('div', '', 'plan-card-progress');
    strip.setAttribute('role', 'progressbar'); strip.setAttribute('aria-label', '进度');
    strip.setAttribute('aria-valuemin', '0'); strip.setAttribute('aria-valuemax', String(steps.length)); strip.setAttribute('aria-valuenow', String(done));
    strip.setAttribute('aria-valuetext', `${done} / ${steps.length} 步已完成`);
    const fill = element('span'); fill.style.width = `${Math.round((done / steps.length) * 100)}%`;
    strip.append(fill); card.append(strip);
  }
  if (task.pendingApproval) card.append(element('p', task.pendingApproval.summary, 'plan-card-summary'));
  if (steps.length) {
    const list = element('ol', '', 'plan-card-steps');
    for (const step of steps) {
      const item = element('li'); item.dataset.state = step.state;
      const mark = element('span', step.state === 'done' ? '✓' : step.state === 'current' ? '•' : '○', 'plan-card-mark'); mark.setAttribute('aria-hidden', 'true');
      item.append(mark, element('span', step.title), element('span', step.state === 'done' ? '（已完成）' : step.state === 'current' ? '（正在做）' : '', 'sr-only'));
      list.append(item);
    }
    card.append(list);
  }
  if (task.runId && task.pendingApproval) {
    const actions = element('div', '', 'plan-card-actions');
    const start = dashboardButton('开始', () => approveConversationTask(task, 'task'));
    start.className = 'decision-primary'; start.dataset.planStart = task.id;
    const revise = dashboardButton('改一下计划', async () => { revision.hidden = !revision.hidden; if (!revision.hidden) field.focus(); });
    revise.dataset.planRevise = task.id; revise.setAttribute('aria-expanded', 'false');
    const cancel = dashboardButton('算了', () => cancelConversationTask(task));
    cancel.dataset.planCancel = task.id;
    actions.append(start, revise, cancel);
    const revision = element('div', '', 'plan-card-revision');
    const field = element('textarea', '', 'conversation-answer');
    field.rows = 2; field.maxLength = 8000; field.dataset.planFeedback = task.id; field.value = feedbackDraft;
    field.placeholder = '想怎么改？它会按你说的重新出一份计划，仍然等你确认。';
    field.setAttribute('aria-label', `修改「${task.title}」的计划`);
    const submit = dashboardButton('按这个改', () => rejectConversationTask(task, field.value));
    submit.dataset.planReviseSubmit = task.id;
    revision.append(field, submit);
    revision.hidden = !feedbackDraft;
    revise.addEventListener('click', () => revise.setAttribute('aria-expanded', String(!revision.hidden)));
    card.append(actions, revision);
  }
  return card;
}
/** What the Run is waiting on from you, shown under its plan: one external action to decide, or one question to answer. */
function conversationDecisionCard(task: ConversationTaskView, answerDraft = ''): HTMLElement | undefined {
  const action = task.runId && task.status === 'needs_approval' ? task.pendingAction : undefined;
  const question = task.runId && task.status === 'needs_input' ? task.pendingQuestion : undefined;
  if (!action && !question) return;
  const card = element('section', '', 'decision-card');
  card.dataset.decisionTask = task.id;
  card.dataset.kind = action ? 'action' : 'question';
  const head = element('div', '', 'decision-card-head');
  head.append(element('span', '需要你', 'decision-card-badge'));
  if (action?.step) head.append(element('span', action.step, 'decision-card-step'));
  card.append(head);
  if (action) {
    card.setAttribute('aria-label', `「${task.title}」等你决定一个动作`);
    card.append(element('strong', action.kind === 'agent' ? `想交给外部代理 ${action.ref}` : `想调用 ${action.ref}`, 'decision-card-title'));
    card.append(element('p', '计划已经批准，这一步里的这个动作要你单独点头。不要时它不会执行，任务会接着做，并知道你没同意。', 'decision-card-note'));
    const why = element('p', action.reason || '没有附带原因。', 'decision-card-reason');
    why.hidden = true; why.id = `decision-reason-${task.id}`;
    const actions = element('div', '', 'decision-card-actions');
    const approve = dashboardButton('批准', () => decideConversationAction(task, 'once'));
    approve.className = 'decision-primary'; approve.dataset.cardDecision = 'once';
    const deny = dashboardButton('不要', () => decideConversationAction(task, 'deny'));
    deny.dataset.cardDecision = 'deny';
    const whyButton = dashboardButton('为什么？', async () => { why.hidden = !why.hidden; whyButton.setAttribute('aria-expanded', String(!why.hidden)); });
    whyButton.dataset.cardWhy = task.id; whyButton.setAttribute('aria-expanded', 'false'); whyButton.setAttribute('aria-controls', why.id);
    const more = element('div', '', 'decision-card-more'); more.hidden = true; more.id = `decision-more-${task.id}`;
    const moreButton = dashboardButton('更多', async () => { more.hidden = !more.hidden; moreButton.setAttribute('aria-expanded', String(!more.hidden)); });
    moreButton.dataset.cardMore = task.id; moreButton.setAttribute('aria-expanded', 'false'); moreButton.setAttribute('aria-controls', more.id);
    const always = dashboardButton('这件任务里以后都允许', () => decideConversationAction(task, 'always'));
    always.dataset.cardDecision = 'always';
    const block = dashboardButton('这件任务里一直阻止', () => decideConversationAction(task, 'block'));
    block.dataset.cardDecision = 'block';
    more.append(always, block);
    actions.append(approve, deny, whyButton, moreButton);
    card.append(actions, why, more);
    return card;
  }
  card.setAttribute('aria-label', `「${task.title}」等你回答`);
  card.append(element('strong', '它需要你补一句', 'decision-card-title'), element('p', question!.text, 'decision-card-question'));
  const field = element('textarea', '', 'conversation-answer');
  field.rows = 2; field.maxLength = 8000; field.dataset.questionAnswer = task.id; field.value = answerDraft;
  field.placeholder = '回答后它从当前这一步接着做';
  field.setAttribute('aria-label', `回答「${task.title}」的问题`);
  const submit = dashboardButton('回答', () => answerConversationTask(task, field.value));
  submit.className = 'decision-primary'; submit.dataset.questionSubmit = task.id;
  const actions = element('div', '', 'decision-card-actions'); actions.append(submit);
  card.append(field, actions);
  return card;
}
async function decideConversationAction(task: ConversationTaskView, decision: 'once' | 'always' | 'deny' | 'block'): Promise<void> {
  const action = task.pendingAction;
  if (!conversation || !task.runId || !action || conversationBusy || conversationAttempt) return;
  const epoch = conversationEpoch, runId = task.runId;
  conversationBusy = true; updateConversationControls();
  try {
    await api(`/runs/${encodeURIComponent(runId)}/approve-action`, { idempotencyKey: action.idempotencyKey, decision });
    if (epoch !== conversationEpoch) return;
    await refreshConversation(false, true);
    if (epoch !== conversationEpoch) return;
    if (currentId === runId) await refresh();
    void refreshHandoffViews();
    if (epoch !== conversationEpoch) return;
    const done: Record<typeof decision, string> = {
      once: `已批准 ${action.ref} 这一次，「${task.title}」接着做。`,
      always: `已允许 ${action.ref}，这件任务里以后不再问。`,
      deny: `没有执行 ${action.ref}，「${task.title}」会接着做，并知道你没同意。`,
      block: `已阻止 ${action.ref}，这件任务里不会再执行它。`,
    };
    $('conversation-status').textContent = done[decision];
    $('conversation-error').textContent = '';
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    $('conversation-error').textContent = errorMessage(error);
    if (error instanceof ApiError && error.status === 409) await refreshConversation(false, true).catch(() => undefined);
  } finally { if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); } }
}
async function cancelConversationTask(task: ConversationTaskView): Promise<void> {
  if (!conversation || !task.runId || conversationBusy || conversationAttempt) return;
  const epoch = conversationEpoch, runId = task.runId;
  conversationBusy = true; updateConversationControls();
  try {
    await api(`/runs/${encodeURIComponent(runId)}/cancel`, { reason: '在计划卡片上选择了“算了”' });
    if (epoch !== conversationEpoch) return;
    await refreshConversation(false, true);
    if (epoch !== conversationEpoch) return;
    if (currentId === runId) await refresh();
    void refreshHandoffViews();
    if (epoch !== conversationEpoch) return;
    $('conversation-status').textContent = `已取消「${task.title}」，这份计划不会执行。`;
    $('conversation-error').textContent = '';
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    $('conversation-error').textContent = errorMessage(error);
    if (error instanceof ApiError && error.status === 409) await refreshConversation(false, true).catch(() => undefined);
  } finally { if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); } }
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
    const reconcileDrafts = new Map<string, string>();
    const rejectDrafts = new Map<string, string>();
    taskBody?.querySelectorAll<HTMLTextAreaElement>('textarea[data-answer]').forEach(field => {
      if (field.dataset.answer) answerDrafts.set(field.dataset.answer, field.value);
    });
    taskBody?.querySelectorAll<HTMLTextAreaElement>('textarea[data-reconcile]').forEach(field => {
      if (field.dataset.reconcile) reconcileDrafts.set(field.dataset.reconcile, field.value);
    });
    taskBody?.querySelectorAll<HTMLTextAreaElement>('textarea[data-reject]').forEach(field => {
      if (field.dataset.reject) rejectDrafts.set(field.dataset.reject, field.value);
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
      if (task.execution?.steps.length) {
        name.append(element('small', executionLine(task.execution), 'conversation-steps'));
        if (task.execution.evidence?.length) name.append(element('small', `证据：${task.execution.evidence.join('、')}`, 'conversation-evidence'));
      }
      if (task.machine) name.append(element('small', machineLine(task.machine), 'conversation-machine'));
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
        const approve = dashboardButton('批准并执行', () => approveConversationTask(task, 'task'));
        approve.dataset.approve = task.id; approve.className = 'decision-primary';
        const once = dashboardButton('仅这一次', () => approveConversationTask(task, 'once'));
        once.dataset.approveOnce = task.id;
        once.title = '记在这次批准记录上。这次仍按当前计划执行，以后的计划仍要再批。';
        const field = document.createElement('textarea');
        field.className = 'conversation-answer'; field.maxLength = 8000; field.rows = 2;
        field.placeholder = '写下拒绝原因。拒绝后重新规划，新计划仍停在等待批准，不会按这份计划执行。';
        field.dataset.reject = task.id;
        const draft = rejectDrafts.get(task.id);
        if (draft) field.value = draft;
        const reject = dashboardButton('拒绝并说明', () => rejectConversationTask(task, field.value));
        reject.dataset.rejectSubmit = task.id;
        actions.append(approve, once, field, reject);
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
      if (runId && ['queued', 'planning', 'running', 'reviewing'].includes(task.status)) {
        const pause = dashboardButton('暂停', () => controlConversationRun(task, 'pause'));
        pause.dataset.runPause = task.id;
        actions.append(pause);
      }
      if (runId && task.status === 'paused') {
        const resume = dashboardButton('继续', () => controlConversationRun(task, 'resume'));
        resume.dataset.runResume = task.id;
        actions.append(resume);
      }
      if (runId && (task.status === 'unknown' || task.status === 'waiting_external')) {
        const field = document.createElement('textarea');
        field.className = 'conversation-answer'; field.maxLength = 2000; field.rows = 2;
        field.placeholder = '写下你确认的结果。提交后这件 Run 会继续；如果有一次结果未知的模型调用，会把那次调用再发一遍。'; field.dataset.reconcile = task.id;
        field.setAttribute('aria-label', `核查「${task.title}」`);
        const draft = reconcileDrafts.get(task.id);
        if (draft) field.value = draft;
        const submit = dashboardButton('提交核查并继续', () => controlConversationRun(task, 'reconcile', { reason: field.value.trim() }));
        submit.dataset.reconcileSubmit = task.id;
        actions.append(field, submit);
      }
      if (runId) { const view = button('查看运行', async () => openConversationRun(runId)); view.type = 'button'; actions.append(view); }
      if (runId && task.memory?.activeSummaries) { const memory = button('查看任务记忆', async () => openConversationMemory(runId)); memory.type = 'button'; actions.append(memory); }
      row.append(rank, name, status, actions); taskBody?.append(row);
    });
    $('conversation-tasks').hidden = ordered.length === 0;
    const messages = $('conversation-messages');
    const planDrafts = new Map<string, string>();
    messages.querySelectorAll<HTMLTextAreaElement>('textarea[data-plan-feedback]').forEach(field => {
      if (field.dataset.planFeedback && field.value) planDrafts.set(field.dataset.planFeedback, field.value);
    });
    const questionDrafts = new Map<string, string>();
    messages.querySelectorAll<HTMLTextAreaElement>('textarea[data-question-answer]').forEach(field => {
      if (field.dataset.questionAnswer && field.value) questionDrafts.set(field.dataset.questionAnswer, field.value);
    });
    messages.replaceChildren();
    // One plan card per task, under the latest message that asked it to run.
    const planMessage = new Map<string, string>();
    for (const item of conversation?.messages ?? []) if (item.execution && item.execution.state !== 'cancelled') planMessage.set(item.execution.taskId, item.id);
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
            $('conversation-status').textContent = '已选择任务。请检查内容，再点击“发送”交给它去做，或“只记下来”；尚未执行。';
          }); choice.type = 'button'; row.append(choice);
        }
      }
      const runId = item.notificationRunId ?? item.execution?.runId;
      if (runId) { const view = button('查看此次运行', async () => openConversationRun(runId)); view.type = 'button'; row.append(view); }
      const planTask = item.execution && planMessage.get(item.execution.taskId) === item.id ? conversation?.tasks.find(task => task.id === item.execution!.taskId) : undefined;
      if (planTask && (planTask.runId === item.execution!.runId || planTask.status === 'preparing')) {
        row.append(conversationPlanCard(planTask, planDrafts.get(planTask.id)));
        const decision = conversationDecisionCard(planTask, questionDrafts.get(planTask.id));
        if (decision) row.append(decision);
      }
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
  // A task that finishes while you watch opens its results in the workbench. A first load or another conversation never does.
  const before = conversation?.id === view.id ? new Map(conversation.tasks.map(task => [task.id, task.status])) : undefined;
  const finished = before ? view.tasks.find(task => task.status === 'succeeded' && task.runId && before.has(task.id) && !['succeeded', 'failed', 'cancelled', 'discussion', 'unreadable'].includes(before.get(task.id)!)) : undefined;
  conversation = view;
  if (finished?.runId && rosterView() === 'entry') void revealFinishedRun(finished.runId).catch(() => undefined);
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
    void refreshHandoffViews();
    if (epoch !== conversationEpoch) return;
    $('conversation-status').textContent = `已回答「${task.title}」。讨论焦点没有改变。`;
    $('conversation-error').textContent = conversation?.id === id && conversation.focusTaskId !== focus ? '回答后讨论焦点发生变化，请刷新核对。' : '';
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    $('conversation-error').textContent = errorMessage(error);
    if (error instanceof ApiError && error.status === 409) await refreshConversation(false, true).catch(() => undefined);
  } finally { if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); } }
}
async function controlConversationRun(task: ConversationTaskView, action: 'pause' | 'resume' | 'reconcile', body: Record<string, string> = {}): Promise<void> {
  const runId = task.runId;
  if (!conversation || !runId || conversationBusy || conversationAttempt) return;
  const allowed = action === 'pause' ? ['queued', 'planning', 'running', 'reviewing'] : action === 'resume' ? ['paused'] : ['unknown', 'waiting_external'];
  if (!allowed.includes(task.status)) return;
  if (action === 'reconcile' && !body.reason?.trim()) {
    $('conversation-error').textContent = '请先写下核查说明，再提交。';
    return;
  }
  const epoch = conversationEpoch, id = conversation.id, focus = conversation.focusTaskId;
  conversationBusy = true; updateConversationControls();
  try {
    await api(`/runs/${encodeURIComponent(runId)}/${action}`, body);
    if (epoch !== conversationEpoch) return;
    await refreshConversation(false, true);
    if (epoch !== conversationEpoch) return;
    if (currentId === runId) await refresh();
    if (epoch !== conversationEpoch) return;
    const receipt = action === 'pause' ? `已暂停「${task.title}」。讨论焦点没有改变。` : action === 'resume' ? `已继续「${task.title}」。讨论焦点没有改变。` : `已核查「${task.title}」并继续这件 Run。若有一次结果未知的模型调用，会再发一遍。讨论焦点没有改变。`;
    $('conversation-status').textContent = receipt;
    $('conversation-error').textContent = conversation?.id === id && conversation.focusTaskId !== focus ? '这一步之后讨论焦点发生变化，请刷新核对。' : '';
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
async function approveConversationTask(task: ConversationTaskView, duration: 'task' | 'once' = 'task'): Promise<void> {
  if (!conversation || !task.runId || !task.pendingApproval || conversationBusy || conversationAttempt) return;
  const epoch = conversationEpoch, id = conversation.id, focus = conversation.focusTaskId, runId = task.runId;
  conversationBusy = true; updateConversationControls();
  try {
    await api(`/runs/${encodeURIComponent(runId)}/approve`, { planHash: task.pendingApproval.planHash, planVersion: task.pendingApproval.planVersion, ...(duration === 'once' ? { duration: 'once' } : {}) });
    if (epoch !== conversationEpoch) return;
    await refreshConversation(false, true);
    if (epoch !== conversationEpoch) return;
    if (currentId === runId) await refresh();
    void refreshHandoffViews();
    if (epoch !== conversationEpoch) return;
    $('conversation-status').textContent = duration === 'once'
      ? `已批准「${task.title}」的当前计划并开始执行。这次批准记录标为仅这一次，以后的计划仍要再批。讨论焦点没有改变。`
      : `已批准「${task.title}」的当前计划并开始执行。讨论焦点没有改变。`;
    $('conversation-error').textContent = conversation?.id === id && conversation.focusTaskId !== focus ? '批准后讨论焦点发生变化，请刷新核对。' : '';
  } catch (error) {
    if (epoch !== conversationEpoch) return;
    $('conversation-error').textContent = errorMessage(error);
    if (error instanceof ApiError && error.status === 409) await refreshConversation(false, true).catch(() => undefined);
  } finally { if (epoch === conversationEpoch) { conversationBusy = false; updateConversationControls(); } }
}
async function rejectConversationTask(task: ConversationTaskView, feedback: string): Promise<void> {
  const text = feedback.trim();
  if (!conversation || !task.runId || !task.pendingApproval || conversationBusy || conversationAttempt) return;
  if (!text) { $('conversation-error').textContent = '请先写下拒绝原因，再提交。'; return; }
  const epoch = conversationEpoch, id = conversation.id, focus = conversation.focusTaskId, runId = task.runId;
  conversationBusy = true; updateConversationControls();
  try {
    await api(`/runs/${encodeURIComponent(runId)}/revise-plan`, { planVersion: task.pendingApproval.planVersion, feedback: text });
    if (epoch !== conversationEpoch) return;
    await refreshConversation(false, true);
    if (epoch !== conversationEpoch) return;
    if (currentId === runId) await refresh();
    void refreshHandoffViews();
    if (epoch !== conversationEpoch) return;
    $('conversation-status').textContent = `已拒绝「${task.title}」的当前计划，并请它重新规划。讨论焦点没有改变。`;
    $('conversation-error').textContent = conversation?.id === id && conversation.focusTaskId !== focus ? '拒绝后讨论焦点发生变化，请刷新核对。' : '';
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
/** Loads a finished Run into the workbench and opens it, without scrolling or moving keyboard focus. */
async function revealFinishedRun(runId: string): Promise<void> {
  const epoch = conversationEpoch;
  const run = await api<RunView>(`/runs/${encodeURIComponent(runId)}`);
  const [graphs, explanation] = await Promise.all([api<RunGraphsView>(`/runs/${encodeURIComponent(runId)}/graphs`), api<RunExplanation>(`/runs/${encodeURIComponent(runId)}/explanation`)]);
  if (epoch !== conversationEpoch || rosterView() !== 'entry') return;
  currentId = runId; current = { ...run, graphs }; localStorage.setItem('aeeis.run', runId);
  setCurrentRunOpen(true); render(current); renderExplanation(explanation);
  // Open the run pane for now only; setRunDetailsMode would also remember it for every later visit.
  runDetailsMode = true; document.body.classList.add('run-details-mode'); syncRunDetailsToggleLabel();
  setComputerOpen(true, 'run');
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
    if (intent === 'execute' && conversationSendIntent() !== 'execute') return;
    const target = $<HTMLSelectElement>('conversation-target').value;
    if (conversationCorrectionId && (intent !== 'discuss' || !conversation.tasks.some(task => task.id === target))) return;
    const lifeSpeaker = selectedLifeSpeaker();
    const text = $<HTMLTextAreaElement>('conversation-text').value.trim();
    // A send that names no task starts a new one and makes it the focus, so the next message (a change to the plan, a follow-up) lands on it.
    const autoTitle = intent === 'execute' && !target && !conversationReplyId && !conversation.focusTaskId ? autoTaskTitle(text) : '';
    if (intent === 'execute' && !target && !conversationReplyId && !conversation.focusTaskId && autoTitle.length < 2) intent = 'discuss';
    const body = conversationCorrectionId
      ? { text: '纠正这条讨论的任务归属', expectedRevision: conversation.revision, taskIds: [target], correctsMessageId: conversationCorrectionId, intent: 'discuss', focus: 'keep' }
      : { text, expectedRevision: conversation.revision,
        ...(lifeSpeaker ? { speaker: lifeSpeaker } : {}),
        ...(target === '__new' ? { newTask: { title: $<HTMLInputElement>('conversation-task-title').value.trim() } } : autoTitle.length >= 2 && intent === 'execute' ? { newTask: { title: autoTitle } } : { ...(target ? { taskIds: [target] } : intent === 'execute' && !conversationReplyId && conversation.focusTaskId ? { taskIds: [conversation.focusTaskId] } : {}), ...(conversationReplyId ? { replyTo: conversationReplyId } : {}) }),
        focus: autoTitle.length >= 2 && intent === 'execute' ? 'switch' : $<HTMLSelectElement>('conversation-focus-effect').value, intent, ...(intent === 'execute' ? { ...(currentTaskKind() ? { taskKind: currentTaskKind() } : {}), runOptions: runOptions(true, conversationExecutionGoal()) } : {}) };
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
$('conversation-composer').addEventListener('submit', event => { event.preventDefault(); void sendConversation(conversationSendIntent()).catch(error => { $('conversation-error').textContent = errorMessage(error); }); });
$('conversation-note').addEventListener('click', () => { void sendConversation('discuss').catch(error => { $('conversation-error').textContent = errorMessage(error); }); });
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
  if (!draft) return;
  draft.hidden = !draft.hidden;
  if (!draft.hidden) $<HTMLInputElement>('bot-group-name')?.focus();
});
$('gb-new-group')?.addEventListener('click', () => showGroupDraft());
$('group-add-person')?.addEventListener('click', () => addDraftPerson());
$('group-reuse')?.addEventListener('click', () => reuseRoster());
$('group-newcomer-reason')?.addEventListener('input', () => {
  const proposal = $('group-proposal');
  if (proposal) proposal.textContent = groupProposalText();
});
$('group-create')?.addEventListener('submit', event => { void createGroup(event).catch(error => message(errorMessage(error))); });
$('group-composer')?.addEventListener('submit', event => { void submitGroupMessage(event).catch(error => message(errorMessage(error))); });
$('channel-artifact-close')?.addEventListener('click', () => hideChannelArtifact());
const MEMORY_KIND_LABEL: Record<string, string> = { fact: '事实', preference: '偏好', decision: '决定', note: '备注' };
async function listedChannelGoal(): Promise<GoalSummary | undefined> {
  const roomId = openGroupId;
  if (!roomId) return;
  const listed = await api<GoalSummary[] | { goals?: GoalSummary[] }>(`/rooms/${encodeURIComponent(roomId)}/goals`);
  const goals = Array.isArray(listed) ? listed : (listed.goals ?? []);
  return goals.find(item => item.status === 'active') ?? goals[0];
}
async function channelGoal(): Promise<GoalSummary | undefined> {
  const existing = await listedChannelGoal();
  if (existing || !openGroupId) return existing;
  const roomId = openGroupId;
  const room = roomSummaries.find(item => item.id === roomId);
  return api<GoalSummary>('/goals', { title: room?.title || '群聊', roomId });
}
async function renderChannelMemory(): Promise<void> {
  const list = $('channel-memory-list');
  const roomId = openGroupId;
  if (!list || !roomId) return;
  list.replaceChildren(element('p', '正在读取这个频道记住的事。'));
  const goal = await listedChannelGoal();
  if (openGroupId !== roomId) return;
  const memories = goal ? await api<MemoryView[]>(`/goals/${encodeURIComponent(goal.id)}/memories?limit=50`).catch(() => [] as MemoryView[]) : [];
  if (openGroupId !== roomId) return;
  list.replaceChildren();
  const active = memories.filter(item => item.state !== 'retracted' && item.state !== 'superseded');
  if (!active.length) list.append(element('p', '这个频道还没有记下的事实。'));
  for (const memory of active) {
    const row = element('article', '');
    row.dataset.memoryId = memory.id;
    row.append(element('strong', `${MEMORY_KIND_LABEL[memory.kind] ?? memory.kind} · ${privacyLabel(memory.classification)}`), element('p', memory.content), element('small', `来源：${memory.source || '未标明'}`));
    const correction = document.createElement('textarea');
    correction.maxLength = 2000;
    correction.rows = 2;
    correction.value = memory.content;
    correction.setAttribute('aria-label', '修正这条记忆');
    const correct = dashboardButton('修正', async () => {
      const content = correction.value.trim();
      if (!content || !goal) return;
      await api(`/goals/${encodeURIComponent(goal.id)}/memories/${encodeURIComponent(memory.id)}/correct`, {
        kind: memory.kind, content, scope: memory.scope, classification: memory.classification, source: memory.source, confidence: memory.confidence,
      });
      message('已修正这条频道记忆。旧的一版还留着。');
      await renderChannelMemory();
    });
    const reason = document.createElement('input');
    reason.maxLength = 500;
    reason.placeholder = '撤回原因';
    reason.setAttribute('aria-label', '撤回原因');
    const retract = dashboardButton('撤回', async () => {
      const why = reason.value.trim();
      if (!why) { message('请先写下撤回原因。'); return; }
      if (!goal) return;
      await api(`/goals/${encodeURIComponent(goal.id)}/memories/${encodeURIComponent(memory.id)}/retract`, { reason: why });
      message('已撤回这条频道记忆。');
      await renderChannelMemory();
    });
    row.append(correction, correct, reason, retract);
    list.append(row);
  }
}
async function openChannelMemory(): Promise<void> {
  const panel = $('channel-memory');
  if (!panel || !openGroupId) return;
  panel.hidden = false;
  await renderChannelMemory();
}
async function saveChannelMemory(event: Event): Promise<void> {
  event.preventDefault();
  const roomId = openGroupId;
  const text = $<HTMLTextAreaElement>('channel-memory-text')?.value.trim() ?? '';
  if (!roomId || !text) return;
  const room = roomSummaries.find(item => item.id === roomId);
  const source = $<HTMLInputElement>('channel-memory-source')?.value.trim() || `频道：${room?.title || '群聊'}`;
  if (source.startsWith('团队规则') || source.startsWith('带教：')) {
    message('团队规则从复盘里收，带教从带教里记。这条请换一个来源。');
    return;
  }
  const goal = await channelGoal();
  if (!goal || openGroupId !== roomId) return;
  const kind = $<HTMLSelectElement>('channel-memory-kind')?.value || 'fact';
  const classification = $<HTMLSelectElement>('channel-memory-class')?.value || 'internal';
  await api(`/goals/${encodeURIComponent(goal.id)}/memories`, { kind, content: text, scope: 'project', classification, source, confidence: 1 });
  const field = $<HTMLTextAreaElement>('channel-memory-text');
  if (field) field.value = '';
  message('已记下这条频道记忆。看一眼不会执行。');
  await renderChannelMemory();
}
async function openChannelBot(agentId: string): Promise<void> {
  const panel = $('channel-bot');
  const title = $('channel-bot-title');
  const body = $('channel-bot-body');
  if (!panel || !body) return;
  const bot = botById(agentId);
  const name = bot?.name ?? participantLabel(agentId);
  if (title) title.textContent = `${name}的档案`;
  body.replaceChildren(element('p', '正在读取这份档案。看一眼不会执行。'));
  panel.hidden = false;
  const summary = agentId === 'aeeis' ? aeeisThread() : lifeSummary(agentId);
  let view = summary ? handoffViews.get(summary.id) : undefined;
  if (summary && !view) {
    try { view = await api<ConversationView>(`/conversations/${encodeURIComponent(summary.id)}`); if (view) handoffViews.set(view.id, view); }
    catch { view = undefined; }
  }
  body.replaceChildren();
  body.append(element('p', `${name} · ${bot?.note ? `职责：${bot.note}` : '职责还没有单独写下。'}`));
  body.append(element('small', lifePresenceLabel(agentId)));
  body.append(element('small', '权限仍是现在这套：讨论不授权，执行要单独创建 Run。批准、登录和密钥留在和 AEEIS 的对话里。'));
  const remembered = view?.standingInstruction?.trim();
  body.append(element('small', remembered ? `这个人记得：${remembered}` : '这个人还没有长期嘱咐。'));
  body.append(element('small', view?.acceptedPractice ? `收下的做法：${view.acceptedPractice.text}` : '还没有收下的做法。'));
  const models = view?.taskSettings?.models ?? [];
  const skills = view?.taskSettings?.skills ?? [];
  body.append(element('small', models.length ? `设置：${models.map(item => `${item.taskKind}用 ${item.model}`).join('、')}` : '还没有按任务种类选定模型。'));
  if (skills.length) body.append(element('small', `技能：${skills.map(item => `${item.taskKind} ${item.methodId} ${item.version}`).join('、')}`));
  const recent = channelCitations().filter(cite => (cite.agentId ?? handoffViews.get(cite.conversationId)?.agentId) === agentId);
  body.append(element('small', recent.length ? `最近：${recent.map(cite => handoffViews.get(cite.conversationId)?.tasks.find(task => task.id === cite.taskId)?.title ?? cite.taskId).join('、')}` : '这个频道里还没有交给这个人的事。'));
  body.append(element('small', '档案只读。要改嘱咐、做法或模型，打开这个人。看一眼不会执行。'));
  const open = dashboardButton('打开这个人', () => openLifeThread(agentId));
  open.dataset.openLife = agentId;
  body.append(open);
}
function openChannelInbox(): void {
  const toggle = $('attention-toggle') as HTMLButtonElement | null;
  if (!toggle || toggle.hidden) { message('现在没有待处理的事。'); return; }
  if (!attentionInboxOpen) toggle.click();
  else $('attention-inbox')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
interface StudioHop { id: string; fromId: string; toId: string; fromName: string; toName: string; at: string; content: string; conversationId: string; taskId: string }
function studioRoster(): Array<{ id: string; name: string; seat: 'meet' | 'desk' }> {
  const people: Array<{ id: string; name: string; seat: 'meet' | 'desk' }> = [{ id: 'aeeis', name: 'AEEIS', seat: 'meet' }];
  for (const member of groupMembers) {
    if (member.status !== 'active' || member.principalId === 'aeeis' || people.some(person => person.id === member.principalId)) continue;
    people.push({ id: member.principalId, name: participantLabel(member.principalId), seat: 'desk' });
  }
  return people;
}
function studioWork(agentId: string): Array<{ title: string; column: string }> {
  return channelCitations().flatMap(cite => {
    const owner = cite.agentId ?? handoffViews.get(cite.conversationId)?.agentId ?? '';
    if (owner !== agentId) return [];
    const view = handoffViews.get(cite.conversationId);
    const task = view?.tasks.find(item => item.id === cite.taskId);
    if (!view || !task) return [{ title: cite.taskId, column: 'capture' }];
    return [{ title: task.title, column: boardColumn(task.status, boardDecision(view.id, task.id), taskRunId(task)) }];
  });
}
function studioLabel(agentId: string): { label: string; task: string } {
  const work = studioWork(agentId);
  const pick = (column: string) => work.find(item => item.column === column);
  const blocked = pick('blocked');
  if (blocked) return { label: '需要你', task: blocked.title };
  const doing = pick('doing');
  if (doing) return { label: '执行中', task: doing.title };
  const review = pick('review');
  if (review) return { label: '待验收', task: review.title };
  const ready = pick('ready');
  if (ready) return { label: '等待', task: ready.title };
  const done = pick('done');
  if (done) return { label: '完成', task: done.title };
  const any = work[0];
  if (any) return { label: '待整理', task: any.title };
  return { label: '空闲', task: '现在没有交给这个人的事' };
}
function studioHops(): StudioHop[] {
  const hops: StudioHop[] = [];
  for (const event of channelLog()) {
    if (event.operation === 'retract' || event.type === 'task_update') continue;
    const cite = handoffCitation(event);
    if (!cite) continue;
    hops.push({
      id: event.id,
      fromId: event.actorType === 'agent' ? event.actorId : 'you',
      toId: cite.agentId ?? '未知',
      fromName: event.actorType === 'agent' ? participantLabel(event.actorId) : '你',
      toName: cite.agentId ? participantLabel(cite.agentId) : '这个人',
      at: event.createdAt,
      content: event.content,
      conversationId: cite.conversationId,
      taskId: cite.taskId,
    });
  }
  return hops;
}
function studioEdges(): Array<{ fromId: string; toId: string; fromName: string; toName: string; count: number; latest: StudioHop }> {
  const map = new Map<string, { fromId: string; toId: string; fromName: string; toName: string; count: number; latest: StudioHop }>();
  for (const hop of studioHops()) {
    const key = `${hop.fromId}\0${hop.toId}`;
    const current = map.get(key);
    if (current) { current.count += 1; current.latest = hop; }
    else map.set(key, { fromId: hop.fromId, toId: hop.toId, fromName: hop.fromName, toName: hop.toName, count: 1, latest: hop });
  }
  return [...map.values()];
}
function studioCaption(): string {
  const hops = studioHops();
  if (!hops.length) return '这个频道还没有交接可以回放。空格暂停，左右键单步。';
  const hop = studioIndex >= 0 ? hops[studioIndex] : undefined;
  if (!hop) return `可以回放 ${hops.length} 次交接。空格暂停，左右键单步。`;
  const detail = studioPrivacy ? `${hop.fromName} 和 ${hop.toName} 在协作` : `${hop.fromName} → ${hop.toName}：${hop.content}`;
  return `${studioIndex + 1} / ${hops.length} · ${detail}`;
}
function studioSignature(): string {
  const people = studioRoster().map(person => { const state = studioLabel(person.id); return `${person.id}:${state.label}:${state.task}`; }).join('\n');
  const hops = studioHops().map(hop => `${hop.id}:${hop.fromName}:${hop.toName}:${studioPrivacy ? '' : hop.content}`).join('\n');
  return `${studioView}\u0000${studioPrivacy}\u0000${studioIndex}\u0000${people}\u0000${hops}`;
}
function stopStudioPlay(): void {
  studioPlaying = false;
  if (studioTimer !== undefined) window.clearInterval(studioTimer);
  studioTimer = undefined;
}
function motionReduced(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
function startStudioTimer(): void {
  if (studioTimer !== undefined) window.clearInterval(studioTimer);
  studioTimer = window.setInterval(() => {
    if (studioIndex >= studioHops().length - 1) { stopStudioPlay(); renderStudio(); return; }
    studioIndex += 1;
    renderStudio();
  }, studioSpeed === 2 ? 700 : 1400);
}
function studioStep(delta: number): void {
  const hops = studioHops();
  if (!hops.length) { studioIndex = -1; renderStudio(); return; }
  studioIndex = Math.min(hops.length - 1, Math.max(0, studioIndex + delta));
  renderStudio();
}
function playStudio(): void {
  if (!studioHops().length) { message('这个频道还没有交接可以回放。'); return; }
  if (motionReduced()) { stopStudioPlay(); studioStep(1); message('已按单步回放。'); return; }
  if (studioIndex >= studioHops().length - 1) studioIndex = -1;
  studioPlaying = true;
  startStudioTimer();
  studioStep(1);
}
function studioPersonButton(person: { id: string; name: string }): HTMLButtonElement {
  const state = studioLabel(person.id);
  const button = element('button', '', 'studio-person') as HTMLButtonElement;
  button.type = 'button';
  button.dataset.studioPerson = person.id;
  button.append(element('strong', person.name), element('small', state.label), element('small', state.task));
  button.addEventListener('click', () => { void openChannelBot(person.id).catch(error => message(errorMessage(error))); });
  return button;
}
function studioHopButton(hop: StudioHop, index: number): HTMLButtonElement {
  const button = element('button', '', 'studio-hop') as HTMLButtonElement;
  button.type = 'button';
  button.dataset.hopIndex = String(index);
  if (index === studioIndex) button.classList.add('studio-live');
  const detail = studioPrivacy ? `${hop.fromName} 和 ${hop.toName} 在协作` : hop.content;
  button.append(element('strong', `${hop.fromName} → ${hop.toName}`), element('small', formatTime(hop.at)), element('small', detail));
  button.addEventListener('click', () => {
    studioIndex = index;
    stopStudioPlay();
    const view = handoffViews.get(hop.conversationId);
    const task = view?.tasks.find(item => item.id === hop.taskId);
    renderStudio();
    if (!view || !task) { message('正在读取这件事。看一眼不会执行。'); return; }
    openChannelTask(view, task, hop.toName);
  });
  return button;
}
function studioTable(): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'studio-status';
  const caption = document.createElement('caption');
  caption.textContent = '团队状态';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['人', '状态', '当前的事']) { const cell = document.createElement('th'); cell.textContent = label; headRow.append(cell); }
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const person of studioRoster()) {
    const state = studioLabel(person.id);
    const row = document.createElement('tr');
    for (const value of [person.name, state.label, state.task]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    body.append(row);
  }
  table.append(caption, head, body);
  return table;
}
function renderStudio(): void {
  const body = $('channel-studio-body');
  const caption = $('studio-replay-caption');
  const play = $('studio-play');
  const speed = $('studio-speed');
  if (caption) caption.textContent = studioCaption();
  if (play) play.textContent = studioPlaying ? '回放中' : '回放';
  if (speed) speed.textContent = `速度 ${studioSpeed}×`;
  if (!body) return;
  const key = studioSignature();
  if (key === studioKey && body.childElementCount) return;
  studioKey = key;
  body.replaceChildren();
  const stage = element('div', '', 'studio-stage');
  stage.id = 'channel-studio-stage';
  stage.append(element('p', studioSummary()));
  if (studioView === 'graph') appendStudioGraph(stage);
  else if (studioView === 'timeline') appendStudioTimeline(stage);
  else appendStudioFloor(stage);
  body.append(stage, studioTable());
}
function studioSummary(): string {
  const people = studioRoster();
  const busy = people.filter(person => studioLabel(person.id).label !== '空闲').length;
  return `${busy} 人在忙 · ${people.length - busy} 人空闲`;
}
function appendStudioFloor(stage: HTMLElement): void {
  const floor = element('div', '', 'studio-floor');
  const meet = element('section', '', 'studio-seat');
  const desks = element('section', '', 'studio-seat');
  meet.append(element('h3', '会议室'));
  desks.append(element('h3', '工位区'));
  const roster = studioRoster();
  for (const person of roster) (person.seat === 'meet' ? meet : desks).append(studioPersonButton(person));
  if (!roster.some(person => person.seat === 'desk')) desks.append(element('small', '工位区还空着。'));
  floor.append(meet, desks);
  stage.append(floor);
  const hops = studioHops();
  if (!hops.length) stage.append(element('p', '这个频道还没有交接。'));
  hops.forEach((hop, index) => stage.append(studioHopButton(hop, index)));
}
function appendStudioGraph(stage: HTMLElement): void {
  const edges = studioEdges();
  if (!edges.length) { stage.append(element('p', '这个频道还没有交接。')); return; }
  for (const edge of edges) {
    const reverse = edges.some(item => item.fromId === edge.toId && item.toId === edge.fromId);
    const button = element('button', '', 'studio-edge') as HTMLButtonElement;
    button.type = 'button';
    button.append(element('strong', `${edge.fromName} → ${edge.toName}`), element('small', reverse ? `${edge.count} 次` : `${edge.count} 次 · 单向`));
    button.append(element('small', studioPrivacy ? `${edge.fromName} 和 ${edge.toName} 在协作` : edge.latest.content));
    if (studioHops()[studioIndex]?.id === edge.latest.id) button.classList.add('studio-live');
    button.addEventListener('click', () => {
      studioIndex = studioHops().findIndex(hop => hop.id === edge.latest.id);
      stopStudioPlay();
      renderStudio();
    });
    stage.append(button);
  }
}
function appendStudioTimeline(stage: HTMLElement): void {
  const hops = studioHops();
  for (const person of studioRoster()) {
    const row = element('section', '', 'studio-seat');
    row.append(element('h3', person.name));
    const mine = hops.map((hop, index) => ({ hop, index })).filter(item => item.hop.toId === person.id || item.hop.fromId === person.id);
    if (!mine.length) row.append(element('small', '这一行还没有交接。'));
    for (const item of mine) row.append(studioHopButton(item.hop, item.index));
    stage.append(row);
  }
}
async function ensureCitedViews(roomId: string): Promise<void> {
  await absorbLaterEvents(roomId, channelReadEpoch);
  if (openGroupId !== roomId) return;
  await Promise.all(channelBoardIds().map(async id => {
    if (handoffViews.has(id)) return;
    try {
      const view = await api<ConversationView>(`/conversations/${encodeURIComponent(id)}`);
      if (openGroupId === roomId && view) handoffViews.set(view.id, view);
    } catch { return undefined; }
  }));
}
async function openChannelStudio(): Promise<void> {
  const roomId = openGroupId;
  const panel = $('channel-studio');
  if (!roomId || !panel) return;
  panel.hidden = false;
  studioKey = '';
  await ensureCitedViews(roomId);
  if (openGroupId !== roomId) return;
  renderStudio();
}
function inDigestWindow(iso: string | undefined, span: DigestWindow): boolean {
  const time = Date.parse(iso ?? '');
  if (!Number.isFinite(time)) return false;
  const when = new Date(time);
  const now = new Date();
  if (when.getTime() > now.getTime() + 60_000) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (span === 'day') return when.getTime() >= today.getTime();
  const week = new Date(today);
  const weekday = week.getDay();
  week.setDate(week.getDate() - (weekday === 0 ? 6 : weekday - 1));
  return when.getTime() >= week.getTime();
}
function digestNeedsYou(): number {
  const seen = new Set<string>();
  let count = 0;
  for (const cite of channelCitations()) {
    const key = `${cite.conversationId}\0${cite.taskId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const view = handoffViews.get(cite.conversationId);
    const task = view?.tasks.find(item => item.id === cite.taskId);
    if (!view || !task) continue;
    if (boardColumn(task.status, boardDecision(view.id, task.id), taskRunId(task)) === 'blocked') count += 1;
  }
  return count;
}
function digestTaskCount(events: SessionEventSummary[], match: (event: SessionEventSummary) => boolean): number {
  const seen = new Set<string>();
  for (const event of events) {
    if (!match(event)) continue;
    const cite = handoffCitation(event);
    if (!cite) continue;
    seen.add(`${cite.conversationId}\0${cite.taskId}`);
  }
  return seen.size;
}
function renderDigestBody(): void {
  const body = $('channel-digest-body');
  if (!body) return;
  const events = channelLog().filter(event => event.operation !== 'retract' && inDigestWindow(event.createdAt, digestWindow));
  const handoffs = events.filter(event => event.type !== 'task_update' && Boolean(handoffCitation(event))).length;
  const blocked = digestTaskCount(events, event => event.type === 'task_update' && event.content.trim().startsWith('阻塞：'));
  const done = digestTaskCount(events, event => event.type === 'task_update' && event.content.trim() === '验收通过');
  const label = digestWindow === 'day' ? '今日' : '本周';
  body.replaceChildren(element('p', `${label}：交接 ${handoffs}，阻塞 ${blocked}，完成 ${done}。现在需要你 ${digestNeedsYou()}。`), element('small', '花费记在各件事的抽屉里。今日和本周按这台机器的本地日历，一周从周一开始。'));
}
async function scopedMemories(selector: { exact?: string; prefix?: string; kind?: string }): Promise<{ goal?: GoalSummary; items: MemoryView[] }> {
  const goal = await listedChannelGoal();
  if (!goal) return { items: [] };
  const memories = await api<MemoryView[]>(`/goals/${encodeURIComponent(goal.id)}/memories?limit=50`).catch(() => [] as MemoryView[]);
  return { goal, items: memories.filter(item => item.state !== 'retracted' && item.state !== 'superseded' && (!selector.kind || item.kind === selector.kind) && (selector.exact ? item.source === selector.exact : Boolean(selector.prefix && item.source.startsWith(selector.prefix)))) };
}
function renderScopedMemories(list: HTMLElement, goal: GoalSummary | undefined, items: MemoryView[], empty: string, reload: () => Promise<void>): void {
  list.replaceChildren();
  if (!items.length) { list.append(element('p', empty)); return; }
  for (const memory of items) {
    const row = element('article');
    row.append(element('p', memory.content), element('small', `来源：${memory.source}`));
    const reason = document.createElement('input');
    reason.maxLength = 500;
    reason.placeholder = '撤回原因';
    reason.setAttribute('aria-label', '撤回原因');
    const retract = dashboardButton('撤回', async () => {
      const why = reason.value.trim();
      if (!why) { message('请先写下撤回原因。'); return; }
      if (!goal) return;
      await api(`/goals/${encodeURIComponent(goal.id)}/memories/${encodeURIComponent(memory.id)}/retract`, { reason: why });
      message('已撤回。');
      await reload();
    });
    row.append(reason, retract);
    list.append(row);
  }
}
async function renderTeamRules(): Promise<void> {
  const list = $('channel-rule-list');
  const roomId = openGroupId;
  if (!list || !roomId) return;
  const loaded = await scopedMemories({ exact: '团队规则', kind: 'decision' });
  if (openGroupId !== roomId) return;
  renderScopedMemories(list, loaded.goal, loaded.items, '这个频道还没有团队规则。', renderTeamRules);
}
async function openChannelDigest(): Promise<void> {
  const roomId = openGroupId;
  const panel = $('channel-digest');
  if (!roomId || !panel) return;
  panel.hidden = false;
  await ensureCitedViews(roomId);
  if (openGroupId !== roomId) return;
  renderDigestBody();
  await renderTeamRules();
}
async function saveTeamRule(event: Event): Promise<void> {
  event.preventDefault();
  const text = $<HTMLTextAreaElement>('channel-rule-text')?.value.trim() ?? '';
  const roomId = openGroupId;
  if (!text || !roomId) return;
  const goal = await channelGoal();
  if (!goal || openGroupId !== roomId) return;
  await api(`/goals/${encodeURIComponent(goal.id)}/memories`, { kind: 'decision', content: text, scope: 'project', classification: 'internal', source: '团队规则', confidence: 1 });
  const field = $<HTMLTextAreaElement>('channel-rule-text');
  if (field) field.value = '';
  message('已收成这个频道的团队规则。看一眼不会执行。');
  await renderTeamRules();
}
function teachingSteps(): string[] {
  return ($<HTMLTextAreaElement>('channel-teach-steps')?.value ?? '').split('\n').map(line => line.trim()).filter(Boolean).slice(0, 12);
}
function teachingDraft(): string {
  return teachingSteps().map((line, index) => `${index + 1}. ${line}`).join('\n');
}
function renderTeachingPreview(): void {
  const list = $('channel-teach-preview');
  if (!list) return;
  const steps = teachingSteps();
  list.replaceChildren();
  if (!steps.length) { list.append(element('li', '写下步骤后再生成草案。')); return; }
  for (const step of steps) list.append(element('li', step));
}
function renderTeachPeople(): void {
  const select = $<HTMLSelectElement>('channel-teach-person');
  if (!select) return;
  const previous = select.value;
  select.replaceChildren();
  for (const person of studioRoster()) {
    const option = document.createElement('option');
    option.value = person.id;
    option.textContent = person.name;
    select.append(option);
  }
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
}
async function renderTeachingSaved(): Promise<void> {
  const list = $('channel-teach-saved');
  const roomId = openGroupId;
  if (!list || !roomId) return;
  const loaded = await scopedMemories({ prefix: '带教：', kind: 'note' });
  if (openGroupId !== roomId) return;
  renderScopedMemories(list, loaded.goal, loaded.items, '这个频道还没有带教草案。', renderTeachingSaved);
}
async function openChannelTeach(): Promise<void> {
  const panel = $('channel-teach');
  if (!panel || !openGroupId) return;
  panel.hidden = false;
  renderTeachPeople();
  await renderTeachingSaved();
}
async function saveTeachingDraft(): Promise<void> {
  const text = teachingDraft();
  const roomId = openGroupId;
  const agentId = $<HTMLSelectElement>('channel-teach-person')?.value ?? '';
  if (!text || !roomId || !agentId) { message('先生成草案。'); return; }
  const goal = await channelGoal();
  if (!goal || openGroupId !== roomId) return;
  const name = participantLabel(agentId);
  await api(`/goals/${encodeURIComponent(goal.id)}/memories`, { kind: 'note', content: text, scope: 'project', classification: 'internal', source: `带教：${name}`, confidence: 1 });
  message(`已把草案记在这个频道，教给${name}。只影响这个频道。`);
  await renderTeachingSaved();
}
async function keepTeachingProfile(): Promise<void> {
  const text = teachingDraft();
  if (!text) { message('先生成草案。'); return; }
  if (text.length > 500) { message('收进档案的做法最多 500 字。草案可以先记在这个频道。'); return; }
  const agentId = $<HTMLSelectElement>('channel-teach-person')?.value ?? '';
  const summary = agentId === 'aeeis' ? aeeisThread() : lifeSummary(agentId);
  if (!summary) { message('这个人还没有自己的对话。草案可以先记在这个频道。'); return; }
  const view = await api<ConversationView>(`/conversations/${encodeURIComponent(summary.id)}`);
  const runId = view.lastDelivery?.runId;
  if (!runId) { message('这个人还没有一次做成的交付。草案先留在这个频道。'); return; }
  try {
    const next = await api<ConversationView>(`/conversations/${encodeURIComponent(summary.id)}/practice`, { expectedRevision: view.revision, text, runId });
    if (next) handoffViews.set(next.id, next);
    message(`已收进${participantLabel(agentId)}的档案。只影响这个人。`);
  } catch (error) { message(errorMessage(error)); }
}
$('channel-board-open')?.addEventListener('click', () => { void showChannelBoard().catch(error => message(errorMessage(error))); });
$('channel-board-more')?.addEventListener('click', () => { void showChannelBoard().catch(error => message(errorMessage(error))); });
$('channel-board-close')?.addEventListener('click', () => { hideChannelBoard(); renderGroupTranscript(); });
$('channel-memory-open')?.addEventListener('click', () => { void openChannelMemory().catch(error => message(errorMessage(error))); });
$('channel-memory-close')?.addEventListener('click', () => { const panel = $('channel-memory'); if (panel) panel.hidden = true; });
$('channel-memory-form')?.addEventListener('submit', event => { void saveChannelMemory(event).catch(error => message(errorMessage(error))); });
$('channel-studio-open')?.addEventListener('click', () => { void openChannelStudio().catch(error => message(errorMessage(error))); });
$('channel-studio-close')?.addEventListener('click', () => { stopStudioPlay(); const panel = $('channel-studio'); if (panel) panel.hidden = true; });
$('channel-studio')?.addEventListener('click', event => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-studio-view]');
  if (!target || !$('channel-studio')?.contains(target)) return;
  const view = target.dataset.studioView;
  if (view !== 'floor' && view !== 'graph' && view !== 'timeline') return;
  studioView = view;
  studioKey = '';
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-studio-view]')) button.setAttribute('aria-pressed', button === target ? 'true' : 'false');
  renderStudio();
});
$('studio-privacy')?.addEventListener('change', () => {
  studioPrivacy = $<HTMLInputElement>('studio-privacy')?.checked === true;
  studioKey = '';
  renderStudio();
});
$('studio-play')?.addEventListener('click', () => playStudio());
$('studio-pause')?.addEventListener('click', () => { stopStudioPlay(); renderStudio(); });
$('studio-prev')?.addEventListener('click', () => { stopStudioPlay(); studioStep(-1); });
$('studio-next')?.addEventListener('click', () => { stopStudioPlay(); studioStep(1); });
$('studio-speed')?.addEventListener('click', () => {
  studioSpeed = studioSpeed === 1 ? 2 : 1;
  if (studioPlaying) startStudioTimer();
  renderStudio();
});
document.addEventListener('keydown', event => {
  const panel = $('channel-studio');
  if (!panel || panel.hidden) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest('button, a, input, textarea, select, summary, [contenteditable="true"]')) return;
  const role = target?.getAttribute('role');
  if (role === 'button' || role === 'link' || role === 'checkbox' || role === 'switch' || role === 'textbox') return;
  const atRoot = !target || target === document.body || target === document.documentElement;
  if (!atRoot && !panel.contains(target)) return;
  if (event.key === ' ') {
    event.preventDefault();
    if (studioPlaying) { stopStudioPlay(); renderStudio(); }
    else playStudio();
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault();
    stopStudioPlay();
    studioStep(event.key === 'ArrowRight' ? 1 : -1);
  }
});
$('channel-digest-open')?.addEventListener('click', () => { void openChannelDigest().catch(error => message(errorMessage(error))); });
$('channel-digest-close')?.addEventListener('click', () => { const panel = $('channel-digest'); if (panel) panel.hidden = true; });
$('channel-digest')?.addEventListener('click', event => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-digest-window]');
  if (!target || !$('channel-digest')?.contains(target)) return;
  const next = target.dataset.digestWindow;
  if (next !== 'day' && next !== 'week') return;
  digestWindow = next;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-digest-window]')) button.setAttribute('aria-pressed', button === target ? 'true' : 'false');
  renderDigestBody();
});
$('channel-rule-form')?.addEventListener('submit', event => { void saveTeamRule(event).catch(error => message(errorMessage(error))); });
$('channel-teach-open')?.addEventListener('click', () => { void openChannelTeach().catch(error => message(errorMessage(error))); });
$('channel-teach-close')?.addEventListener('click', () => { const panel = $('channel-teach'); if (panel) panel.hidden = true; });
$('channel-teach-draft')?.addEventListener('click', () => renderTeachingPreview());
$('channel-teach-save')?.addEventListener('click', () => { void saveTeachingDraft().catch(error => message(errorMessage(error))); });
$('channel-teach-profile')?.addEventListener('click', () => { void keepTeachingProfile().catch(error => message(errorMessage(error))); });
$('channel-bot-close')?.addEventListener('click', () => { const panel = $('channel-bot'); if (panel) panel.hidden = true; });
$('channel-inbox')?.addEventListener('click', () => openChannelInbox());
$('channel-task-close')?.addEventListener('click', () => {
  const task = $('channel-task');
  if (task) task.hidden = true;
  $('channel-task-body')?.replaceChildren();
});
$('group-text')?.addEventListener('input', () => renderMentions());
$('group-rename')?.addEventListener('click', () => { void renameGroup().catch(error => message(errorMessage(error))); });
$('chat-archive')?.addEventListener('click', () => { void archiveOpenChat().catch(error => message(errorMessage(error))); });
$('entry-back')?.addEventListener('click', () => showRoster(true));
$('entry-computer')?.addEventListener('click', () => {
  if (computerOpen) closeComputer();
  else if (current || currentId) setRunDetailsMode(true);
  else setComputerOpen(true, 'setup');
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
type InboxKind = 'approval' | 'question' | 'unknown' | 'failure' | 'mention';
function inboxKind(status: string): InboxKind | undefined {
  if (status === 'needs_approval') return 'approval';
  if (status === 'needs_input' || status === 'waiting_external' || status === 'paused') return 'question';
  if (status === 'unknown') return 'unknown';
  if (status === 'failed') return 'failure';
  return undefined;
}
function inboxSeverity(kind: InboxKind): number {
  if (kind === 'approval' || kind === 'question') return 1;
  if (kind === 'unknown') return 2;
  return 3;
}
function inboxAge(at: string | undefined, kind: InboxKind): { label: string; level: 'normal' | 'remind' | 'escalate' } {
  const stamp = at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : Date.now();
  const hours = Math.max(0, Date.now() - stamp) / 3_600_000;
  const [remind, escalate] = kind === 'approval' || kind === 'question' ? [1, 4] : kind === 'unknown' ? [2, 8] : [24, 72];
  if (hours < remind) return { label: '正常', level: 'normal' };
  if (hours < escalate) return { label: '提醒', level: 'remind' };
  return { label: '升级', level: 'escalate' };
}
function inboxKindLabel(kind: InboxKind): string {
  if (kind === 'approval') return '审批';
  if (kind === 'question') return '提问';
  if (kind === 'unknown') return '结果不明';
  if (kind === 'failure') return '失败';
  return '点名';
}
function renderAttentionInbox(runs: RunSummary[]): void {
  const panel = $('attention-inbox');
  const list = $('attention-items');
  const count = $('attention-count');
  if (!panel || !list || !count) return;
  const items: Array<{ kind: InboxKind; title: string; detail: string; at?: string | undefined; status: string; selected: boolean; open: () => Promise<void>; quick: string; act: () => Promise<void> }> = [];
  for (const run of runs) {
    const kind = inboxKind(run.status);
    if (!kind) continue;
    const [label, next] = attentionCopy(run.status);
    items.push({
      kind, title: run.goal, detail: `${label} · ${next}`, at: run.updatedAt, status: run.status, selected: run.id === currentId,
      open: () => openAttentionRun(run),
      quick: kind === 'failure' ? '查看原因' : kind === 'approval' ? '查看计划' : kind === 'unknown' ? '核查' : '补充',
      act: () => openAttentionRun(run),
    });
  }
  for (const message of conversation?.messages ?? []) {
    if (message.route.status !== 'clarify') continue;
    if (conversation?.messages.some(item => item.correctsMessageId === message.id)) continue;
    items.push({
      kind: 'mention', title: message.text, detail: '需要你明确选择任务。还没有执行。', at: message.createdAt, status: 'mention', selected: false,
      open: async () => { prepareConversationReply(message); openConversationRoute(); },
      quick: '查看',
      act: async () => { prepareConversationReply(message); openConversationRoute(); },
    });
  }
  const stamp = (at?: string) => { const value = Date.parse(at ?? ''); return Number.isFinite(value) ? value : 0; };
  items.sort((left, right) => inboxSeverity(left.kind) - inboxSeverity(right.kind) || stamp(left.at) - stamp(right.at));
  const attention = items.slice(0, 8);
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
  for (const entry of attention) {
    const age = inboxAge(entry.at, entry.kind);
    const item = element('div', '', `attention-item ${entry.status}${entry.selected ? ' is-selected' : ''}`);
    item.dataset.inbox = entry.kind;
    item.dataset.age = age.level;
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.onclick = () => void entry.open().catch(error => message(errorMessage(error)));
    item.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void entry.open().catch(error => message(errorMessage(error))); }
    };
    item.setAttribute('aria-label', `${inboxKindLabel(entry.kind)}：${entry.title}`);
    const marker = element('span', '', 'attention-marker');
    const body = element('span', '', 'attention-body');
    const heading = element('span', '', 'attention-heading');
    heading.append(element('strong', inboxKindLabel(entry.kind)), element('small', age.label));
    body.append(heading, element('span', entry.title.slice(0, 120), 'attention-goal'), element('small', entry.detail, 'attention-next'));
    const meta = entry.at && Number.isFinite(Date.parse(entry.at)) ? formatTime(entry.at) : '刚刚更新';
    const quickAction = button(entry.quick, () => entry.act());
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
    const item = button('', async () => {
      leaveGroup();
      document.body.classList.remove('roster-focus');
      document.body.classList.add('draft-open');
      if (currentId === run.id && current) {
        setCurrentRunOpen(true);
        $('run-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      currentId = run.id;
      localStorage.setItem('aeeis.run', run.id);
      current = undefined;
      await refresh();
    });
    item.className = `roster-row task-row${run.id === currentId && currentRunOpen && !openGroupId ? ' selected' : ''}`;
    item.dataset.status = run.status;
    const presence = presenceOf(run.status);
    const dot = element('span', '', 'task-dot');
    dot.dataset.state = presence.state;
    const copy = element('span', '', 'roster-copy');
    copy.append(element('strong', run.goal), element('small', presence.label));
    item.append(dot, copy);
    list.append(item);
  }
  syncBotRow();
  const count = $('run-count');
  if (count) count.textContent = `${visible.length} / ${runs.length} 项任务`;
  const empty = $('runs-empty');
  if (empty) {
    empty.hidden = visible.length > 0;
    empty.textContent = runs.length ? '当前筛选没有任务。' : '还没有任务。先发一条消息。';
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
  roomSummaries = rooms;
  agentSummaries = agents;
  agentsLoaded = true;
  reminderItems = reminderPage.items; reminderNextCursor = reminderPage.nextCursor;
  renderAttentionInbox(runs);
  await renderRooms(rooms); await renderGoals(goals, runs, rooms); renderCandidates(candidates); renderImprovementSignals(signals); renderCollaborations(competitions, debates, projections, triggerPolicies, triggerDecisions); renderAgents(agents); renderReminders(reminderItems);
  renderBotRoster();
  renderGroups(rooms);
  if (selectedCandidateId) await renderCandidateDetail().catch(error => message(errorMessage(error)));
  renderRunQueue(runs);
  renderMinimalRecentRuns(runs);
  const requestedId = currentId;
  const epoch = entryEpoch;
  if (!requestedId) { stopRunEventStream(); setCurrentRunOpen(false); return; }
  let run: RunView;
  try { run = await api<RunView>(`/runs/${requestedId}`); }
  catch (error) {
    // A local data directory or tenant can change between sessions. Do not
    // leave the workbench stuck on a stale selection when its Run disappeared.
    if (error instanceof Error && /Unknown run|HTTP 404/.test(error.message)) {
      if (currentId === requestedId && entryEpoch === epoch) {
        currentId = ''; current = undefined; localStorage.removeItem('aeeis.run'); setCurrentRunOpen(false);
      }
      return;
    }
    throw error;
  }
  if (currentId !== requestedId || entryEpoch !== epoch) return;
  if (DONE_STATUSES.has(run.status)) stopRunEventStream();
  else ensureRunEventStream(requestedId);
  const [graphs, explanation] = await Promise.all([
    api<RunGraphsView>(`/runs/${requestedId}/graphs`),
    api<RunExplanation>(`/runs/${requestedId}/explanation`),
  ]);
  if (currentId !== requestedId || entryEpoch !== epoch) return;
  const keepGroup = Boolean(openGroupId) || document.body.classList.contains('group-draft');
  if (current?.id === run.id && current.revision === run.revision) {
    if (!currentRunOpen && !keepGroup) {
      setCurrentRunOpen(true);
      render(current);
      renderExplanation(explanation);
    }
    return;
  }
  current = { ...run, graphs };
  if (keepGroup) return;
  if (!currentRunOpen) setCurrentRunOpen(true);
  render(current); renderExplanation(explanation);
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
          let id: string | undefined; let name = 'message';
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('id: ')) id = line.slice(4).trim();
            else if (line.startsWith('event: ')) name = line.slice(7).trim();
          }
          if (id && /^\d+$/.test(id)) eventStreamCursor = btoa(JSON.stringify({ seq: Number(id) })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
          // Any event refreshes the Run; the timeline and the transcript card show what changed.
          if (name !== 'heartbeat' && name !== 'timeout') queueEventStreamRefresh();
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
          await api(`/plans/${plan.id}/schedule`, goalExecutionOptions()); await refresh();
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
              await api(`/plans/${plan.id}/tasks/${encodeURIComponent(node.id)}/schedule`, goalExecutionOptions()); goalViewSignature = ''; await refresh();
            });
            schedule.disabled = !modelConfigured; row.append(schedule);
          } else {
            row.append(element('small', '调度器未启用', 'muted'));
          }
          const start = button('直接执行此任务', async () => {
            const created = await api<{ id: string }>(`/plans/${plan.id}/tasks/${encodeURIComponent(node.id)}/run`, goalExecutionOptions());
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
  // Default is auto: the model decides whether a plan stops for approval, and per-action approval still stops writes.
  select.value = saved === 'required' || saved === 'yolo' ? saved : 'auto';
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
function goalExecutionOptions(): Record<string, unknown> {
  return { ...runOptions(false), executionReview: 'required' };
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
    const pendingAction = run.actionApproval?.status === 'pending' ? run.actionApproval : undefined;
    review.hidden = !isReview;
    reviewGrid.replaceChildren();
    reviewTasks.replaceChildren();
    reviewActions.replaceChildren();
    if (isReview && pendingAction) {
      const reviewValues: Array<[string, string]> = [
        ['动作', `${pendingAction.kind === 'agent' ? '交给外部代理' : '调用工具'} ${pendingAction.ref}`],
        ['任务', pendingAction.taskId],
        ['为什么要问', pendingAction.reason],
      ];
      for (const [label, value] of reviewValues) {
        const item = element('div', '', 'review-fact');
        item.append(element('small', label), element('strong', value));
        reviewGrid.append(item);
      }
      reviewTasks.append(element('p', '计划已经批准。这一步里的这个动作需要你单独决定。拒绝或阻止时不会执行它，Run 会继续，执行器会知道原因。', 'muted'));
      if (!readOnlyShare && run.canEdit !== false) {
        const decide = (decision: 'once' | 'always' | 'deny' | 'block') => () => command('approve-action', { idempotencyKey: pendingAction.idempotencyKey, decision });
        const once = button('仅这一次', decide('once'));
        once.className = 'decision-primary';
        once.dataset.actionDecision = 'once';
        const always = button('这件 Run 里以后都允许', decide('always'));
        always.dataset.actionDecision = 'always';
        const deny = button('拒绝这一次', decide('deny'));
        deny.dataset.actionDecision = 'deny';
        const block = button('在这件 Run 里阻止', decide('block'));
        block.dataset.actionDecision = 'block';
        reviewActions.append(once, always, deny, block);
      }
    } else if (isReview && plan) {
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
    else if (run.status === 'needs_approval' && run.actionApproval?.status === 'pending') { /* The action card above carries the decision. */ }
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
  syncTranscriptEmpty();
  $('detail').hidden = !currentRunOpen;
  syncCurrentRunToggle(run);
  syncPresence(run);
  if (intentPresetsOpen) setIntentPresetsOpen(false);
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
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#d4d4d4'); path.setAttribute('stroke-width', '1.5'); svg.append(path);
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
        : '请打开它的工作台查看模型调用和事件记录。', 'delivery-artifact-warning'));
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
    sessionPrincipal = status.principal ?? '';
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
      quickSubmit.title = quickRunReady ? '发送' : '请先连接模型';
      const label = quickSubmit.querySelector('span');
      if (!quickRunReady) quickSubmit.childNodes[0]!.textContent = '等待连接 ';
      else if (label) quickSubmit.childNodes[0]!.textContent = '发送 ';
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
