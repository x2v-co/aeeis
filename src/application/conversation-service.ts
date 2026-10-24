import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { conversationTaskOrder, type Conversation, type ConversationMessage, type ConversationRoute, type ConversationSpeaker, type ConversationStore, type ConversationTask } from '../conversations.js';
import { BrainAccessDenied, type BrainClaim, type GovernedBrain } from '../brain.js';
import type { Ownership, Principal } from '../security/principal.js';
import { requestSchema, type AgentRun } from '../runtime/contracts.js';
import { projectRunGraphs } from '../runtime/graphs.js';
import { NotFound, type RunRepository } from '../runtime/repository.js';
import { Conflict } from '../runtime/engine.js';
import { ThreadConflict } from '../runtime/threads.js';
import { baselineVersions } from '../evolution-activation.js';
import type { RsiService } from '../rsi.js';

/** The Run was committed but the conversation acknowledgement was not. Retry the same idempotency key. */
export class ReplayablePreparationError extends Conflict {
  readonly retrySameRequest = true;
}
import { followupHash, followupRunId, idempotencyKeySchema } from '../runtime/thread-followups.js';
import { redactRunData } from '../runtime/run-debug.js';
import { ThreadService } from './thread-service.js';

const idSchema = z.string().min(1).max(100);
const standingSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  text: z.string().max(5000).transform(value => value.trim()).refine(value => value.length <= 500, '这句话最多 500 字'),
}).strict();
const practiceSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  text: z.string().max(5000).transform(value => value.trim()).refine(value => value.length >= 1, '先写下这句做法').refine(value => value.length <= 500, '这句话最多 500 字'),
  runId: z.string().regex(/^run_[a-f0-9-]{36}$/),
}).strict();
const retractPracticeSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  claimId: z.string().regex(/^brain_[a-f0-9-]{36}$/),
}).strict();
const taskKindSchema = z.string().trim().min(1, '先写任务种类').max(40, '任务种类最多 40 字').regex(/^[\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9 ._-]{0,39}$/u, '任务种类只能包含汉字、字母、数字、空格、点、下划线和连字符');
const skillTokenSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/);
const modelTokenSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/, '模型标识只能包含字母、数字和 . _ : / -');
const skillProfileSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  taskKind: taskKindSchema,
  runId: z.string().regex(/^run_[a-f0-9-]{36}$/),
}).strict();
const skillRollbackSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  taskKind: taskKindSchema,
  reason: z.string().trim().min(1, '先写下回滚原因').max(200, '回滚原因最多 200 字'),
}).strict();
const skillRetractSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  taskKind: taskKindSchema,
  claimId: z.string().regex(/^brain_[a-f0-9-]{36}$/),
}).strict();
const taskKindKeepSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  taskKind: taskKindSchema,
}).strict();
const taskModelSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  taskKind: taskKindSchema,
  model: z.string().trim().max(120).optional(),
  provider: z.string().trim().max(120).optional(),
}).strict().superRefine((value, context) => {
  const model = value.model ?? '';
  const provider = value.provider ?? '';
  if (!model && provider) context.addIssue({ code: 'custom', message: '没有模型时不能单写提供方' });
  if (model && !modelTokenSchema.safeParse(model).success) context.addIssue({ code: 'custom', message: '模型标识只能包含字母、数字和 . _ : / -' });
  if (provider && !modelTokenSchema.safeParse(provider).success) context.addIssue({ code: 'custom', message: '提供方标识只能包含字母、数字和 . _ : / -' });
});
const PRACTICE_TITLE = 'Accepted practice (untrusted, not execution authority)';
const TASK_SETTING_TITLE = 'Task setting (untrusted, not execution authority)';
const speakerSchema = z.object({
  role: z.enum(['user', 'agent']),
  id: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/, '说话人标识只能包含字母、数字、点、下划线和连字符'),
}).strict();
const messageSchema = z.object({
  text: z.string().trim().min(1).max(7000),
  expectedRevision: z.number().int().nonnegative(),
  taskIds: z.array(idSchema).min(1).max(10).optional(),
  replyTo: idSchema.optional(),
  correctsMessageId: idSchema.optional(),
  newTask: z.object({ title: z.string().trim().min(2).max(200) }).strict().optional(),
  focus: z.enum(['keep', 'switch']).default('keep'),
  intent: z.enum(['discuss', 'execute']).default('discuss'),
  /** Who is speaking. Missing means the authenticated owner, role user. */
  speaker: speakerSchema.optional(),
  /** Which kind of work this explicit Run is. Missing keeps the runtime default and carries no skill profile. */
  taskKind: taskKindSchema.optional(),
  runOptions: requestSchema.omit({ goal: true, goalId: true, taskExecution: true, preferredModel: true }).optional(),
}).strict();
/** The provider turn stays one inbound user message. This names the persona inside that request. */
function resolveSpeaker(speaker: z.infer<typeof speakerSchema> | undefined, scope: Ownership): ConversationSpeaker {
  if (!speaker || speaker.role === 'user') {
    if (speaker && speaker.id !== scope.owner) throw new Conflict('只能以本人的身份说话');
    return { role: 'user', id: scope.owner };
  }
  if (speaker.id === scope.owner) throw new Conflict('本人的发言角色是 user');
  return { role: 'agent', id: speaker.id };
}
function spoken(message: ConversationMessage, owner: string): ConversationSpeaker {
  return message.speaker ?? { role: 'user', id: owner };
}
/** The private chat's person. Missing on older threads. A value that cannot be a single token is omitted so it cannot reshape the goal. */
function privatePerson(conversation: Conversation): string | undefined {
  const person = conversation.agentId;
  return person && /^[A-Za-z0-9._-]+$/.test(person) ? person : undefined;
}
function harnessGoal(conversation: Conversation, title: string, text: string, speaker: ConversationSpeaker): string {
  const person = privatePerson(conversation);
  const privacy = person ? `私聊：agent:${person}\n` : '';
  return `${privacy}说话人：${speaker.role}:${speaker.id}\n任务：${title}\n当前请求：${text}`;
}
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
const sameIds = (left: string[], right: string[]) => [...left].sort().join('\0') === [...right].sort().join('\0');
/** Pure Han titles match by substring once they are long enough to be distinctive.
 * Mixed and ASCII titles need a letter/number boundary so a short token cannot hide inside a longer word. */
function mentionsTitle(text: string, title: string): boolean {
  const folded = normalize(text);
  const needle = normalize(title).trim();
  if (needle.length < 2) return false;
  if (/^[\p{Script=Han}]+$/u.test(needle)) return needle.length >= 3 && folded.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, 'iu').test(folded);
}
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
/** Statuses whose next step can still be ordered. Terminal success and cancellation are left alone. */
const RANKED_RUN_STATUSES = new Set(['queued', 'planning', 'running', 'reviewing', 'needs_approval', 'needs_input', 'paused', 'failed', 'unknown', 'waiting_external']);
/** Counts only. Summary text and originals stay on the owner memory API. */
function pendingApproval(run: { status: string; plans: ReadonlyArray<{ version: number; hash: string; summary: string }>; approval?: { approved?: boolean; planHash?: string; mode?: string; reason?: string } } | undefined): { planVersion: number; planHash: string; summary: string } | undefined {
  if (!run || run.status !== 'needs_approval' || run.approval?.approved) return;
  const plan = run.plans.at(-1);
  if (!plan || run.approval?.planHash !== plan.hash) return;
  const reason = run.approval.mode === 'auto' && run.approval.reason ? `模型请求批准：${run.approval.reason}。` : '';
  return { planVersion: plan.version, planHash: plan.hash, summary: `${reason}${plan.summary}`.slice(0, 240) };
}
function machineView(record: { state: string; ready?: boolean } | undefined): { state: 'absent' | 'present' | 'released'; ready: boolean } {
  if (record?.state === 'released') return { state: 'released', ready: false };
  if (record?.state === 'present') return { state: 'present', ready: record.ready === true };
  return { state: 'absent', ready: false };
}
function clipTitle(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}
/** Titles and step state from the frozen plan. Instructions, hashes, and artifact bodies stay on the Run. */
function executionView(run: AgentRun | undefined): { steps: Array<{ title: string; state: 'done' | 'current' | 'waiting' }>; evidence?: string[] } | undefined {
  if (!run) return;
  const plan = run.plans.at(-1);
  if (!plan) return;
  const steps = plan.nodes.flatMap(node => {
    const title = clipTitle(node.title);
    if (!title) return [];
    const status = run.steps.find(item => item.taskId === node.id)?.status;
    const state = status === 'succeeded' ? 'done' as const : status === 'running' ? 'current' as const : 'waiting' as const;
    return [{ title, state }];
  });
  if (!steps.length) return;
  const evidence = [...new Set(run.artifacts.map(item => clipTitle(item.title)).filter(Boolean))].slice(0, 6);
  return evidence.length ? { steps, evidence } : { steps };
}
function pendingQuestion(run: { status: string; question?: { text?: string } } | undefined): { text: string } | undefined {
  if (!run || run.status !== 'needs_input') return;
  const text = run.question?.text?.trim();
  if (!text) return;
  return { text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text };
}
function taskMemory(run: { workingMemory?: { originals: readonly unknown[]; summaries: readonly { status: string }[] } } | undefined): { originals: number; activeSummaries: number } | undefined {
  const memory = run?.workingMemory;
  if (!memory) return;
  const activeSummaries = memory.summaries.filter(summary => summary.status === 'active').length;
  const originals = memory.originals.length;
  if (!activeSummaries && !originals) return;
  return { originals, activeSummaries };
}
function effectiveTasks(conversation: Conversation, message: ConversationMessage): string[] {
  return conversation.messages.slice().reverse().find(item => item.correctsMessageId === message.id)?.route.taskIds ?? message.route.taskIds;
}
function validateCorrection(conversation: Conversation, input: z.infer<typeof messageSchema>): void {
  if (!input.correctsMessageId) return;
  if (!input.taskIds || input.newTask || input.replyTo || input.intent !== 'discuss') throw new Conflict('A routing correction requires explicit tasks and cannot execute work');
  const original = conversation.messages.find(message => message.id === input.correctsMessageId);
  if (!original) throw new NotFound('Unknown message');
  if (original.role !== 'user' || original.execution || original.correctsMessageId) throw new Conflict('Only an unexecuted discussion message can be reassigned; execution history is immutable');
}


export function routeConversationMessage(conversation: Conversation, input: z.infer<typeof messageSchema>): ConversationRoute {
  validateCorrection(conversation, input);
  const route = (status: ConversationRoute['status'], reason: ConversationRoute['reason'], taskIds: string[] = [], candidates: string[] = []): ConversationRoute => ({
    status, reason, taskIds, candidateTaskIds: candidates, focusEffect: input.focus,
  });
  if (input.newTask) {
    if (input.taskIds || input.replyTo) throw new Conflict('A new task cannot also target an existing message or task');
    return route('routed', 'new-task');
  }
  const explicit = input.taskIds ? [...new Set(input.taskIds)] : undefined;
  if (explicit?.some(id => !conversation.tasks.some(task => task.id === id))) throw new NotFound('Unknown task');
  const replied = input.replyTo ? conversation.messages.find(message => message.id === input.replyTo) : undefined;
  if (input.replyTo && !replied) throw new NotFound('Unknown message');
  const repliedTasks = replied ? effectiveTasks(conversation, replied) : [];
  if (explicit && repliedTasks.length && !sameIds(explicit, repliedTasks)) throw new Conflict('Task selection conflicts with the replied message');
  let result: ConversationRoute;
  if (explicit) result = route('routed', 'explicit', explicit);
  else if (replied) result = repliedTasks.length ? route('routed', 'reply', [...repliedTasks]) : route('clarify', 'ambiguous', [], [...replied.route.candidateTaskIds]);
  else {
    const text = normalize(input.text);
    const named = conversation.tasks.filter(task => mentionsTitle(input.text, task.title) || text.includes(task.id));
    if (named.length) result = route('routed', 'name', named.map(task => task.id));
    else if (conversation.focusTaskId) result = route('routed', 'focus', [conversation.focusTaskId]);
    else if (/继续|接着|那个|这个|上次|刚才|\b(?:continue|resume|that|it)\b/i.test(input.text)) result = route('clarify', 'ambiguous', [], conversation.tasks.map(task => task.id));
    else result = route('general', 'unassigned');
  }
  // Execution starts only from an explicit task, a reply, or a new task. Name matches and the discussion focus stay on the discussion path.
  if (input.intent === 'execute' && !input.newTask && result.reason !== 'explicit' && result.reason !== 'reply') {
    const candidates = result.candidateTaskIds.length ? result.candidateTaskIds : result.taskIds.length ? result.taskIds : (conversation.focusTaskId ? [conversation.focusTaskId] : conversation.tasks.map(task => task.id));
    return route('clarify', 'ambiguous', [], candidates);
  }
  if (result.taskIds.length !== 1 && (input.intent === 'execute' || input.focus === 'switch')) return route('clarify', 'ambiguous', [], result.taskIds.length ? result.taskIds : conversation.tasks.map(task => task.id));
  return result;
}

/** Evidence already on the succeeded Run. Artifact ids are the citation; other evidence nodes are the fallback. */
function practiceEvidence(run: AgentRun): string[] {
  const nodes = [...new Set(projectRunGraphs(run).evidence.nodes.map(node => node.id).filter(id => id.length >= 1 && id.length <= 200))];
  const artifacts = new Set(run.artifacts.map(item => item.id));
  const cited = nodes.filter(id => artifacts.has(id));
  return (cited.length ? cited : nodes).slice(0, 8);
}
/** Refs the correction path already accepts as evidence on this Run. Thread-history nodes stay out. */
function runEvidenceRefs(run: AgentRun): Set<string> {
  return new Set([
    ...run.context.sources.map(source => source.id),
    ...run.artifacts.map(artifact => artifact.id),
    ...(run.toolReceipts ?? []).filter(receipt => receipt.authorization?.decision !== 'isolated').map(receipt => receipt.receiptId),
    ...(run.delegationOutcomes ?? []).filter(item => item.disposition !== 'isolated').map(outcome => outcome.receiptRef),
    ...run.calls.map(call => call.id),
  ]);
}
function profileBaseVersion(run: AgentRun): string {
  const snapshot = run.evolution?.find(item => item.target === 'profile')?.version?.trim();
  if (snapshot && snapshot.length <= 200) return snapshot;
  return baselineVersions.profile;
}
function practiceMarker(person: string): string { return `practice:${person}`; }
function skillMarker(person: string, taskKind: string): string { return `skill-profile:${person}:${taskKind}`; }
function modelMarker(person: string, taskKind: string): string { return `task-model:${person}:${taskKind}`; }
function keepMarker(person: string, taskKind: string): string { return `task-kind-kept:${person}:${taskKind}`; }
function lineupSignal(person: string, taskKind: string, runId: string): string { return `task-kind-rsi:${person}:${taskKind}:${runId}`; }
interface SkillProfileView { claimId: string; taskKind: string; methodId: string; version: string; runId: string; evidenceRefs: string[] }
interface TaskModelView { claimId: string; taskKind: string; model: string; provider?: string }
interface TaskKindComparison {
  taskKind: string; runId: string; taskTitle: string;
  methodId?: string; version?: string; model?: string; provider?: string;
  profileMethodId?: string; profileVersion?: string; profileRunId?: string; profileModel?: string; profileProvider?: string;
  differs: boolean; kept: boolean;
  proposal?: { candidateId: string; status: string };
}
function kindFromMarker(claim: BrainClaim, prefix: string): string | undefined {
  const markers = claim.sourceRefs.filter(ref => ref.startsWith(prefix));
  if (markers.length !== 1) return;
  const parsed = taskKindSchema.safeParse(markers[0]!.slice(prefix.length));
  return parsed.success ? parsed.data : undefined;
}
function oneRef(refs: readonly string[], prefix: string): string | undefined {
  const matches = refs.filter(ref => ref.startsWith(prefix));
  if (matches.length !== 1) return;
  return matches[0]!.slice(prefix.length);
}
function runSkill(run: AgentRun): { methodId: string; version: string } | undefined {
  const selected = run.skillSelection;
  if (selected?.methodId && selected.version && skillTokenSchema.safeParse(selected.methodId).success && skillTokenSchema.safeParse(selected.version).success) {
    return { methodId: selected.methodId, version: selected.version };
  }
  if (!run.builtinSkill) return;
  const slash = run.builtinSkill.lastIndexOf('/');
  const methodId = run.builtinSkill.slice(0, slash);
  const version = run.builtinSkill.slice(slash + 1);
  if (!skillTokenSchema.safeParse(methodId).success || !skillTokenSchema.safeParse(version).success) return;
  return { methodId, version };
}
function taskKindOfRequest(conversationId: string, request: { materials?: ReadonlyArray<{ title: string; source: string }> } | undefined): string | undefined {
  const prefix = `conversation:${conversationId}/task-kind/`;
  const kinds = [...new Set((request?.materials ?? []).filter(item => item.title === TASK_SETTING_TITLE && item.source.startsWith(prefix)).map(item => item.source.slice(prefix.length)))];
  if (kinds.length !== 1) return;
  const parsed = taskKindSchema.safeParse(kinds[0]);
  return parsed.success ? parsed.data : undefined;
}
function runModel(run: AgentRun): { model: string; provider?: string } | undefined {
  const model = run.model.model;
  if (!modelTokenSchema.safeParse(model).success) return;
  const provider = run.model.provider;
  if (provider && modelTokenSchema.safeParse(provider).success) return { model, provider };
  return { model };
}
function profilesDiffer(run: AgentRun, skill: SkillProfileView | undefined, model: TaskModelView | undefined): boolean {
  const used = runSkill(run);
  const skillDiffers = Boolean(used) !== Boolean(skill) || Boolean(used && skill && (used.methodId !== skill.methodId || used.version !== skill.version));
  const usedModel = runModel(run);
  const modelDiffers = Boolean(model && (!usedModel || usedModel.model !== model.model || (model.provider !== undefined && model.provider !== (usedModel.provider ?? ''))));
  return skillDiffers || modelDiffers;
}
function settingText(taskKind: string, skill: SkillProfileView | undefined, model: TaskModelView | undefined): string {
  const lines = [`任务种类：${taskKind}`];
  if (skill) lines.push(`方法：${skill.methodId}`, `版本：${skill.version}`, `引用：${skill.runId}`, `证据：${skill.evidenceRefs.join('、')}`);
  if (model) {
    lines.push(`模型：${model.model}`);
    if (model.provider) lines.push(`提供方：${model.provider}`);
  }
  return lines.join('\n');
}

export class ConversationService {
  constructor(private store: ConversationStore, private runs: RunRepository, private threads: ThreadService, private brain: GovernedBrain | undefined = undefined, private rsi: RsiService | undefined = undefined, private machines: ((runId: string) => Promise<{ state: 'present' | 'released'; ready: boolean } | undefined>) | undefined = undefined) {}

  async create(input: unknown, scope: Ownership, actor?: Principal) {
    const body = z.object({
      title: z.string().trim().min(1).max(200).default('AEEIS'),
      agentId: z.string().trim().min(1).max(100).optional(),
      claimId: z.string().trim().min(1).max(200).optional(),
    }).strict().parse(input ?? {});
    if (body.claimId && !body.agentId) throw new Conflict('认领一条生命线需要这个人的标识');
    if (body.agentId) {
      const existing = (await this.store.list(scope)).find(item => item.agentId === body.agentId);
      if (existing) return this.view(existing, scope, actor);
    }
    if (body.claimId && body.agentId) {
      const agentId = body.agentId;
      const claimed = await this.store.mutate(body.claimId, scope, current => {
        if (current.agentId && current.agentId !== agentId) throw new Conflict('这条对话已经属于另一个人');
        current.agentId = agentId;
      });
      return this.view(claimed, scope, actor);
    }
    const at = new Date().toISOString();
    const conversation: Conversation = {
      schemaVersion: 'conversation/1', id: `conv_${randomUUID()}`, ...scope, title: body.title, revision: 0, createdAt: at, updatedAt: at, recentTaskIds: [], tasks: [], messages: [],
      ...(body.agentId ? { agentId: body.agentId } : {}),
    };
    await this.store.create(conversation);
    return this.view(conversation, scope, actor);
  }
  async list(scope: Ownership) {
    return (await this.store.list(scope)).map(({ id, title, revision, updatedAt, focusTaskId, tasks, agentId }) => ({ id, title, revision, updatedAt, focusTaskId, taskCount: tasks.length, ...(agentId ? { agentId } : {}) }));
  }
  async get(id: string, scope: Ownership, actor?: Principal) { return this.view(await this.store.get(id, scope), scope, actor); }

  private ownerActor(actor: Principal | undefined, scope: Ownership): actor is Principal {
    return Boolean(actor && actor.id === scope.owner && actor.tenantId === scope.tenantId && actor.roles.includes('owner'));
  }
  private async view(conversation: Conversation, scope: Ownership, actor?: Principal) {
    const loaded = await Promise.all(conversation.tasks.map(async task => {
      const run = task.latestRunId ? await this.runs.get(task.latestRunId, scope) : undefined;
      const memory = taskMemory(run);
      const approval = pendingApproval(run);
      const question = pendingQuestion(run);
      const machine = this.machines && task.latestRunId ? machineView(await this.machines(task.latestRunId)) : undefined;
      const execution = executionView(run);
      return { run, task: { ...task, status: run?.status ?? (task.pendingMessageId ? 'preparing' : 'discussion'), ...(run ? { runId: run.id } : {}), ...(memory ? { memory } : {}), ...(approval ? { pendingApproval: approval } : {}), ...(question ? { pendingQuestion: question } : {}), ...(machine ? { machine } : {}), ...(execution ? { execution } : {}) } };
    }));
    const tasks = loaded.map(item => item.task);
    const lastDelivery = this.latestDelivery(loaded);
    const acceptedPractice = this.ownerActor(actor, scope) ? await this.readPractice(conversation, scope, actor) : undefined;
    const storedSettings = this.ownerActor(actor, scope) ? await this.readTaskSettings(conversation, scope, actor) : undefined;
    const comparisons = this.ownerActor(actor, scope) ? await this.readTaskComparisons(conversation, scope, actor, storedSettings) : undefined;
    const taskSettings = storedSettings || comparisons?.length ? { skills: storedSettings?.skills ?? [], models: storedSettings?.models ?? [], ...(comparisons?.length ? { comparisons } : {}) } : undefined;
    return redactRunData({ ...conversation, tasks, ...(lastDelivery ? { lastDelivery } : {}), ...(acceptedPractice ? { acceptedPractice } : {}), ...(taskSettings ? { taskSettings } : {}), messages: conversation.messages.slice(-100).map(message => ({ ...this.messageView(message), effectiveTaskIds: effectiveTasks(conversation, message) })), hasEarlierMessages: conversation.messages.length > 100 });
  }
  /** The owner's accepted sentence, verified against this conversation's succeeded Run. A forged or foreign claim is omitted. */
  private async readPractice(conversation: Conversation, scope: Ownership, actor: Principal): Promise<{ claimId: string; text: string; runId: string; evidenceRefs: string[] } | undefined> {
    const person = privatePerson(conversation);
    if (!person || !this.brain) return;
    let claims: BrainClaim[];
    try { claims = this.brain.read(person, actor, 'internal', scope.owner); }
    catch { return; }
    const marker = practiceMarker(person);
    const claim = claims
      .filter(item => item.kind === 'preference' && item.sourceRefs.includes(marker))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))[0];
    if (!claim) return;
    const runRef = claim.sourceRefs.find(ref => ref.startsWith('run:'));
    const runId = runRef?.slice(4);
    if (!runId || !/^run_[a-f0-9-]{36}$/.test(runId)) return;
    const evidenceRefs = claim.sourceRefs.filter(ref => ref !== marker && ref !== `run:${runId}`);
    if (!evidenceRefs.length) return;
    const linked = conversation.messages.some(message => message.execution?.runId === runId) || conversation.tasks.some(task => task.latestRunId === runId);
    if (!linked) return;
    let run: AgentRun;
    try { run = await this.runs.get(runId, scope); }
    catch { return; }
    if (run.status !== 'succeeded') return;
    const nodes = new Set(projectRunGraphs(run).evidence.nodes.map(node => node.id));
    if (!evidenceRefs.every(ref => nodes.has(ref))) return;
    return { claimId: claim.id, text: claim.content, runId, evidenceRefs };
  }
  private async deliveryRun(conversation: Conversation, scope: Ownership): Promise<AgentRun | undefined> {
    const loaded = await Promise.all(conversation.tasks.map(async task => {
      let run: AgentRun | undefined;
      if (task.latestRunId) {
        try { run = await this.runs.get(task.latestRunId, scope); }
        catch (error) { if (!(error instanceof NotFound)) throw error; }
      }
      return { task, run };
    }));
    const delivery = this.latestDelivery(loaded);
    return loaded.find(item => item.run?.id === delivery?.runId)?.run;
  }
  private latestDelivery(loaded: Array<{ task: ConversationTask; run: AgentRun | undefined }>) {
    const succeeded = loaded.filter((item): item is { task: ConversationTask; run: AgentRun } => item.run?.status === 'succeeded');
    const latest = succeeded.reduce<{ task: ConversationTask; run: AgentRun } | undefined>((best, item) => !best || Date.parse(item.run.updatedAt) >= Date.parse(best.run.updatedAt) ? item : best, undefined);
    if (!latest) return;
    const summary = latest.run.plans.at(-1)?.summary.trim().slice(0, 240);
    const artifactTitles = [...new Set(latest.run.artifacts.map(item => item.title.trim()).filter(Boolean))].slice(0, 8).map(title => title.length > 80 ? `${title.slice(0, 79)}…` : title);
    return { taskId: latest.task.id, taskTitle: latest.task.title, runId: latest.run.id, ...(summary ? { planSummary: summary } : {}), ...(artifactTitles.length ? { artifactTitles } : {}) };
  }
  private messageView(message: ConversationMessage) {
    const { keyHash: _key, requestHash: _hash, execution, ...view } = message;
    return { ...view, ...(execution ? { execution: { taskId: execution.taskId, runId: execution.runId, state: execution.state } } : {}) };
  }

  async focus(id: string, input: unknown, scope: Ownership, actor?: Principal) {
    const body = z.object({ taskId: idSchema.nullable(), expectedRevision: z.number().int().nonnegative() }).strict().parse(input);
    const updated = await this.store.mutate(id, scope, current => {
      if (current.revision !== body.expectedRevision) throw new Conflict('Conversation changed; refresh before switching focus');
      if (body.taskId !== null && !current.tasks.some(task => task.id === body.taskId)) throw new NotFound('Unknown task');
      if (body.taskId === null) delete current.focusTaskId;
      else this.setFocus(current, body.taskId);
    });
    return this.view(updated, scope, actor);
  }
  async setStanding(id: string, input: unknown, scope: Ownership, actor?: Principal) {
    const body = standingSchema.parse(input);
    const updated = await this.store.mutate(id, scope, current => {
      if (current.revision !== body.expectedRevision) throw new Conflict('对话已变化，请先刷新再改这句话');
      if (body.text) current.standingInstruction = body.text;
      else delete current.standingInstruction;
    });
    return this.view(updated, scope, actor);
  }
  async acceptPractice(id: string, input: unknown, scope: Ownership, actor: Principal) {
    const body = practiceSchema.parse(input);
    const conversation = await this.store.get(id, scope);
    if (conversation.revision !== body.expectedRevision) throw new Conflict('对话已变化，请先刷新再收下这句');
    const person = privatePerson(conversation);
    if (!person) throw new Conflict('这条对话还没有所属的人');
    const brain = this.brain;
    if (!brain) throw new Conflict('Brain 还没有接上，这句话先不记');
    if (!this.ownerActor(actor, scope)) throw new BrainAccessDenied('Brain access denied');
    const run = await this.deliveryRun(conversation, scope);
    if (!run || run.id !== body.runId || run.status !== 'succeeded') throw new Conflict('只能收下这个人上次做成的那一次');
    const evidenceRefs = practiceEvidence(run);
    if (!evidenceRefs.length) throw new Conflict('这次做成还没有可引用的证据');
    const marker = practiceMarker(person);
    for (const claim of brain.read(person, actor, 'internal', scope.owner).filter(item => item.kind === 'preference' && item.sourceRefs.includes(marker))) {
      brain.retract(person, claim.id, actor, scope.owner);
    }
    brain.addClaim({
      owner: scope.owner, tenantId: scope.tenantId, scope: 'identity', scopeRef: person, classification: 'internal', kind: 'preference',
      content: body.text, sourceRefs: [marker, `run:${run.id}`, ...evidenceRefs], confidence: 1,
    }, actor);
    return this.view(conversation, scope, actor);
  }
  async retractPractice(id: string, input: unknown, scope: Ownership, actor: Principal) {
    const body = retractPracticeSchema.parse(input);
    const conversation = await this.store.get(id, scope);
    if (conversation.revision !== body.expectedRevision) throw new Conflict('对话已变化，请先刷新再撤回这句');
    const person = privatePerson(conversation);
    if (!person) throw new Conflict('这条对话还没有所属的人');
    const brain = this.brain;
    if (!brain) throw new Conflict('Brain 还没有接上，这句话先不记');
    if (!this.ownerActor(actor, scope)) throw new BrainAccessDenied('Brain access denied');
    const marker = practiceMarker(person);
    const claim = brain.read(person, actor, 'internal', scope.owner).find(item => item.id === body.claimId && item.kind === 'preference' && item.sourceRefs.includes(marker));
    if (!claim) throw new Conflict('这个人还没有收下的做法');
    brain.retract(person, claim.id, actor, scope.owner);
    return this.view(conversation, scope, actor);
  }
  private requirePerson(conversation: Conversation, scope: Ownership, actor: Principal, expectedRevision: number, stale: string) {
    if (conversation.revision !== expectedRevision) throw new Conflict(stale);
    const person = privatePerson(conversation);
    if (!person) throw new Conflict('这条对话还没有所属的人');
    const brain = this.brain;
    if (!brain) throw new Conflict('Brain 还没有接上，这次先不记');
    if (!this.ownerActor(actor, scope)) throw new BrainAccessDenied('Brain access denied');
    return { person, brain };
  }
  private skillClaims(person: string, taskKind: string, scope: Ownership): BrainClaim[] {
    const brain = this.brain;
    if (!brain) return [];
    const marker = skillMarker(person, taskKind);
    return brain.state().claims.filter(claim => claim.owner === scope.owner && claim.tenantId === scope.tenantId && claim.scope === 'identity' && claim.scopeRef === person && claim.kind === 'decision' && claim.sourceRefs.includes(marker));
  }
  private async linkedRun(conversation: Conversation, scope: Ownership, runId: string): Promise<AgentRun | undefined> {
    const linked = conversation.messages.some(message => message.execution?.runId === runId) || conversation.tasks.some(task => task.latestRunId === runId);
    if (!linked) return;
    try { return await this.runs.get(runId, scope); }
    catch (error) { if (error instanceof NotFound) return; throw error; }
  }
  private async verifySkillClaim(conversation: Conversation, scope: Ownership, claim: BrainClaim, person: string, taskKind: string): Promise<SkillProfileView | undefined> {
    const marker = skillMarker(person, taskKind);
    if (claim.kind !== 'decision' || !claim.sourceRefs.includes(marker)) return;
    const methodId = oneRef(claim.sourceRefs, 'method:');
    const version = oneRef(claim.sourceRefs, 'version:');
    const runId = oneRef(claim.sourceRefs, 'run:');
    if (!methodId || !version || !runId || !skillTokenSchema.safeParse(methodId).success || !skillTokenSchema.safeParse(version).success || !/^run_[a-f0-9-]{36}$/.test(runId)) return;
    const reserved = new Set([marker, `method:${methodId}`, `version:${version}`, `run:${runId}`]);
    const evidenceRefs = claim.sourceRefs.filter(ref => !reserved.has(ref));
    if (!evidenceRefs.length) return;
    const run = await this.linkedRun(conversation, scope, runId);
    if (!run || run.status !== 'succeeded') return;
    const skill = runSkill(run);
    if (!skill || skill.methodId !== methodId || skill.version !== version) return;
    const nodes = new Set(projectRunGraphs(run).evidence.nodes.map(node => node.id));
    if (!evidenceRefs.every(ref => nodes.has(ref))) return;
    return { claimId: claim.id, taskKind, methodId, version, runId, evidenceRefs };
  }
  private verifyModelClaim(claim: BrainClaim, person: string, taskKind: string): TaskModelView | undefined {
    const marker = modelMarker(person, taskKind);
    if (claim.kind !== 'decision' || !claim.sourceRefs.includes(marker)) return;
    const modelRefs = claim.sourceRefs.filter(ref => ref.startsWith('model:'));
    const providerRefs = claim.sourceRefs.filter(ref => ref.startsWith('provider:'));
    if (modelRefs.length !== 1 || providerRefs.length > 1) return;
    const model = modelRefs[0]!.slice('model:'.length);
    const provider = providerRefs[0]?.slice('provider:'.length);
    if (!modelTokenSchema.safeParse(model).success || (provider !== undefined && !modelTokenSchema.safeParse(provider).success)) return;
    const allowed = new Set([marker, `model:${model}`, ...(provider ? [`provider:${provider}`] : [])]);
    if (claim.sourceRefs.some(ref => !allowed.has(ref))) return;
    return { claimId: claim.id, taskKind, model, ...(provider ? { provider } : {}) };
  }
  private async readTaskSettings(conversation: Conversation, scope: Ownership, actor: Principal): Promise<{ skills: SkillProfileView[]; models: TaskModelView[] } | undefined> {
    const person = privatePerson(conversation);
    if (!person || !this.brain) return;
    let claims: BrainClaim[];
    try { claims = this.brain.read(person, actor, 'internal', scope.owner); }
    catch { return; }
    const ranked = claims.filter(claim => claim.kind === 'decision').sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
    const skills: SkillProfileView[] = [];
    const models: TaskModelView[] = [];
    const seenSkills = new Set<string>();
    const seenModels = new Set<string>();
    for (const claim of ranked) {
      const skillKind = kindFromMarker(claim, `skill-profile:${person}:`);
      if (skillKind) {
        if (seenSkills.has(skillKind)) continue;
        seenSkills.add(skillKind);
        const verified = await this.verifySkillClaim(conversation, scope, claim, person, skillKind);
        if (verified) skills.push(verified);
        continue;
      }
      const modelKind = kindFromMarker(claim, `task-model:${person}:`);
      if (!modelKind || seenModels.has(modelKind)) continue;
      seenModels.add(modelKind);
      const verified = this.verifyModelClaim(claim, person, modelKind);
      if (verified) models.push(verified);
    }
    if (!skills.length && !models.length) return;
    return { skills, models };
  }
  private async readTaskKind(conversation: Conversation, scope: Ownership, actor: Principal, taskKind: string): Promise<{ skill?: SkillProfileView; model?: TaskModelView } | undefined> {
    const settings = await this.readTaskSettings(conversation, scope, actor);
    if (!settings) return;
    const skill = settings.skills.find(item => item.taskKind === taskKind);
    const model = settings.models.find(item => item.taskKind === taskKind);
    if (!skill && !model) return;
    return { ...(skill ? { skill } : {}), ...(model ? { model } : {}) };
  }
  private latestDecision(person: string, scope: Ownership, actor: Principal, marker: string): BrainClaim | undefined {
    const brain = this.brain;
    if (!brain) return;
    let claims: BrainClaim[];
    try { claims = brain.read(person, actor, 'internal', scope.owner); }
    catch { return; }
    return claims.filter(item => item.kind === 'decision' && item.sourceRefs.includes(marker)).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))[0];
  }
  /** A keep settles the profile that was already stored. A newer skill or model claim opens the lineup again. */
  private keepStillCovers(person: string, taskKind: string, scope: Ownership, actor: Principal, runId: string): boolean {
    const keep = this.latestDecision(person, scope, actor, keepMarker(person, taskKind));
    if (!keep) return false;
    const cited = oneRef(keep.sourceRefs, 'run:');
    const marker = keepMarker(person, taskKind);
    if (cited !== runId || keep.sourceRefs.some(ref => ref !== marker && ref !== `run:${runId}`)) return false;
    const skillClaim = this.latestDecision(person, scope, actor, skillMarker(person, taskKind));
    const modelClaim = this.latestDecision(person, scope, actor, modelMarker(person, taskKind));
    const profileAt = Math.max(skillClaim ? Date.parse(skillClaim.updatedAt) : 0, modelClaim ? Date.parse(modelClaim.updatedAt) : 0);
    return profileAt > 0 && Date.parse(keep.updatedAt) >= profileAt;
  }
  private async taskKindDeliveries(conversation: Conversation, scope: Ownership): Promise<Array<{ taskKind: string; taskTitle: string; run: AgentRun }>> {
    const candidates = conversation.messages.flatMap(message => {
      if (message.execution?.state !== 'completed') return [];
      const taskKind = taskKindOfRequest(conversation.id, message.execution.request);
      if (!taskKind) return [];
      return [{ taskKind, taskId: message.execution.taskId, runId: message.execution.runId }];
    });
    const runs = new Map<string, AgentRun>();
    for (const runId of new Set(candidates.map(item => item.runId))) {
      try { runs.set(runId, await this.runs.get(runId, scope)); }
      catch (error) { if (!(error instanceof NotFound)) throw error; }
    }
    const best = new Map<string, { taskKind: string; taskTitle: string; run: AgentRun }>();
    for (const item of candidates) {
      const run = runs.get(item.runId);
      if (!run || run.status !== 'succeeded') continue;
      const taskTitle = conversation.tasks.find(task => task.id === item.taskId)?.title ?? item.taskKind;
      const current = best.get(item.taskKind);
      if (!current || Date.parse(run.updatedAt) >= Date.parse(current.run.updatedAt)) best.set(item.taskKind, { taskKind: item.taskKind, taskTitle, run });
    }
    return [...best.values()];
  }
  private async readTaskComparisons(conversation: Conversation, scope: Ownership, actor: Principal, settings: { skills: SkillProfileView[]; models: TaskModelView[] } | undefined): Promise<TaskKindComparison[] | undefined> {
    const person = privatePerson(conversation);
    if (!person) return;
    const deliveries = await this.taskKindDeliveries(conversation, scope);
    if (!deliveries.length) return;
    const proposals = await this.lineupProposals(scope);
    const comparisons: TaskKindComparison[] = [];
    for (const delivery of deliveries) {
      const skill = settings?.skills.find(item => item.taskKind === delivery.taskKind);
      const model = settings?.models.find(item => item.taskKind === delivery.taskKind);
      const used = runSkill(delivery.run);
      const usedModel = runModel(delivery.run);
      const differs = profilesDiffer(delivery.run, skill, model);
      const proposal = proposals.get(lineupSignal(person, delivery.taskKind, delivery.run.id));
      comparisons.push({
        taskKind: delivery.taskKind, runId: delivery.run.id, taskTitle: delivery.taskTitle, differs, kept: differs && this.keepStillCovers(person, delivery.taskKind, scope, actor, delivery.run.id),
        ...(used ? { methodId: used.methodId, version: used.version } : {}),
        ...(usedModel ? { model: usedModel.model, ...(usedModel.provider ? { provider: usedModel.provider } : {}) } : {}),
        ...(skill ? { profileMethodId: skill.methodId, profileVersion: skill.version, profileRunId: skill.runId } : {}),
        ...(model ? { profileModel: model.model, ...(model.provider ? { profileProvider: model.provider } : {}) } : {}),
        ...(proposal ? { proposal } : {}),
      });
    }
    return comparisons;
  }
  private async lineupProposals(scope: Ownership): Promise<Map<string, { candidateId: string; status: string }>> {
    const found = new Map<string, { candidateId: string; status: string }>();
    if (!this.rsi) return found;
    for (const candidate of await this.rsi.list(scope)) {
      const signal = candidate.proposalSignalId;
      if (!signal?.startsWith('task-kind-rsi:')) continue;
      found.set(signal, { candidateId: candidate.id, status: candidate.status });
    }
    return found;
  }
  private async promoteSkill(id: string, input: unknown, scope: Ownership, actor: Principal) {
    const body = skillProfileSchema.parse(input);
    const conversation = await this.store.get(id, scope);
    const { person, brain } = this.requirePerson(conversation, scope, actor, body.expectedRevision, '对话已变化，请先刷新再晋升');
    const run = await this.linkedRun(conversation, scope, body.runId);
    if (!run || run.status !== 'succeeded') throw new Conflict('只能晋升这个人做成过的那一次');
    const skill = runSkill(run);
    if (!skill) throw new Conflict('这次做成还没有可晋升的技能版本');
    const evidenceRefs = practiceEvidence(run);
    if (!evidenceRefs.length) throw new Conflict('这次做成还没有可引用的证据');
    const marker = skillMarker(person, body.taskKind);
    for (const claim of brain.read(person, actor, 'internal', scope.owner).filter(item => item.kind === 'decision' && item.sourceRefs.includes(marker))) {
      brain.retract(person, claim.id, actor, scope.owner);
    }
    brain.addClaim({
      owner: scope.owner, tenantId: scope.tenantId, scope: 'identity', scopeRef: person, classification: 'internal', kind: 'decision',
      content: `任务种类：${body.taskKind}\n方法：${skill.methodId}\n版本：${skill.version}\n引用：${run.id}`,
      sourceRefs: [marker, `method:${skill.methodId}`, `version:${skill.version}`, `run:${run.id}`, ...evidenceRefs], confidence: 1,
    }, actor);
    return this.view(conversation, scope, actor);
  }
  async promoteSkillProfile(id: string, input: unknown, scope: Ownership, actor: Principal) { return this.promoteSkill(id, input, scope, actor); }
  async rollbackSkillProfile(id: string, input: unknown, scope: Ownership, actor: Principal) {
    const body = skillRollbackSchema.parse(input);
    const conversation = await this.store.get(id, scope);
    const { person, brain } = this.requirePerson(conversation, scope, actor, body.expectedRevision, '对话已变化，请先刷新再回滚');
    const marker = skillMarker(person, body.taskKind);
    const active = brain.read(person, actor, 'internal', scope.owner)
      .filter(item => item.kind === 'decision' && item.sourceRefs.includes(marker))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))[0];
    if (!active) throw new Conflict('这个任务种类还没有技能档案');
    const previous = this.skillClaims(person, body.taskKind, scope).filter(claim => claim.id !== active.id && claim.version < active.version).sort((left, right) => right.version - left.version)[0];
    if (!previous) throw new Conflict('这个任务种类还没有可回滚的上一版');
    const verified = await this.verifySkillClaim(conversation, scope, previous, person, body.taskKind);
    if (!verified) throw new Conflict('上一版做法已经不能再核对');
    for (const claim of brain.read(person, actor, 'internal', scope.owner).filter(item => item.kind === 'decision' && item.sourceRefs.includes(marker))) {
      brain.retract(person, claim.id, actor, scope.owner);
    }
    brain.addClaim({
      owner: scope.owner, tenantId: scope.tenantId, scope: 'identity', scopeRef: person, classification: 'internal', kind: 'decision',
      content: `任务种类：${body.taskKind}\n方法：${verified.methodId}\n版本：${verified.version}\n引用：${verified.runId}\n回滚：${body.reason}`,
      sourceRefs: [marker, `method:${verified.methodId}`, `version:${verified.version}`, `run:${verified.runId}`, ...verified.evidenceRefs], confidence: 1,
    }, actor);
    return this.view(conversation, scope, actor);
  }
  async retractSkillProfile(id: string, input: unknown, scope: Ownership, actor: Principal) {
    const body = skillRetractSchema.parse(input);
    const conversation = await this.store.get(id, scope);
    const { person, brain } = this.requirePerson(conversation, scope, actor, body.expectedRevision, '对话已变化，请先刷新再撤回这份档案');
    const marker = skillMarker(person, body.taskKind);
    const claim = brain.read(person, actor, 'internal', scope.owner).find(item => item.id === body.claimId && item.kind === 'decision' && item.sourceRefs.includes(marker));
    if (!claim) throw new Conflict('这个任务种类还没有技能档案');
    brain.retract(person, claim.id, actor, scope.owner);
    return this.view(conversation, scope, actor);
  }
  async setTaskModel(id: string, input: unknown, scope: Ownership, actor: Principal) {
    const body = taskModelSchema.parse(input);
    const conversation = await this.store.get(id, scope);
    const { person, brain } = this.requirePerson(conversation, scope, actor, body.expectedRevision, '对话已变化，请先刷新再改这个任务种类的模型');
    const marker = modelMarker(person, body.taskKind);
    const model = body.model ?? '';
    const provider = body.provider ?? '';
    const active = brain.read(person, actor, 'internal', scope.owner).filter(item => item.kind === 'decision' && item.sourceRefs.includes(marker));
    if (!model && !active.length) throw new Conflict('这个任务种类还没有选定模型');
    for (const claim of active) brain.retract(person, claim.id, actor, scope.owner);
    if (model) {
      brain.addClaim({
        owner: scope.owner, tenantId: scope.tenantId, scope: 'identity', scopeRef: person, classification: 'internal', kind: 'decision',
        content: `任务种类：${body.taskKind}\n模型：${model}${provider ? `\n提供方：${provider}` : ''}`,
        sourceRefs: [marker, `model:${model}`, ...(provider ? [`provider:${provider}`] : [])], confidence: 1,
      }, actor);
    }
    return this.view(conversation, scope, actor);
  }
  async keepTaskKind(id: string, input: unknown, scope: Ownership, actor: Principal) {
    const body = taskKindKeepSchema.parse(input);
    const conversation = await this.store.get(id, scope);
    const { person, brain } = this.requirePerson(conversation, scope, actor, body.expectedRevision, '对话已变化，请先刷新再留下这份档案');
    const delivery = (await this.taskKindDeliveries(conversation, scope)).find(item => item.taskKind === body.taskKind);
    if (!delivery) throw new Conflict('这种任务还没有做成过');
    const settings = await this.readTaskSettings(conversation, scope, actor);
    const skill = settings?.skills.find(item => item.taskKind === body.taskKind);
    const model = settings?.models.find(item => item.taskKind === body.taskKind);
    if (!skill && !model) throw new Conflict('这个任务种类还没有可留下的档案');
    if (!profilesDiffer(delivery.run, skill, model)) throw new Conflict('这次做成和档案一样，不用留下');
    const marker = keepMarker(person, body.taskKind);
    const active = brain.read(person, actor, 'internal', scope.owner).filter(item => item.kind === 'decision' && item.sourceRefs.includes(marker));
    if (active.length === 1 && active[0]!.sourceRefs.includes(`run:${delivery.run.id}`) && active[0]!.sourceRefs.every(ref => ref === marker || ref === `run:${delivery.run.id}`)) return this.view(conversation, scope, actor);
    for (const claim of active) brain.retract(person, claim.id, actor, scope.owner);
    brain.addClaim({
      owner: scope.owner, tenantId: scope.tenantId, scope: 'identity', scopeRef: person, classification: 'internal', kind: 'decision',
      content: `任务种类：${body.taskKind}\n留下：${delivery.run.id}`,
      sourceRefs: [marker, `run:${delivery.run.id}`], confidence: 1,
    }, actor);
    return this.view(conversation, scope, actor);
  }
  async proposeTaskKind(id: string, input: unknown, scope: Ownership, actor: Principal) {
    const body = taskKindKeepSchema.parse(input);
    const conversation = await this.store.get(id, scope);
    const { person } = this.requirePerson(conversation, scope, actor, body.expectedRevision, '对话已变化，请先刷新再送去评测');
    const delivery = (await this.taskKindDeliveries(conversation, scope)).find(item => item.taskKind === body.taskKind);
    if (!delivery) throw new Conflict('这种任务还没有做成过');
    const settings = await this.readTaskSettings(conversation, scope, actor);
    const skill = settings?.skills.find(item => item.taskKind === body.taskKind);
    if (!skill) throw new Conflict('这个任务种类还没有可对照的技能档案');
    const used = runSkill(delivery.run);
    if (!used) throw new Conflict('这次做成还没有可评测的技能版本');
    if (used.methodId === skill.methodId && used.version === skill.version) throw new Conflict('这次做成的技能和档案一样，不用送去评测');
    const evidence = runEvidenceRefs(delivery.run);
    const sourceReceiptRefs = practiceEvidence(delivery.run).filter(ref => evidence.has(ref));
    if (!sourceReceiptRefs.length) throw new Conflict('这次做成还没有可引用的证据');
    const baseVersion = profileBaseVersion(delivery.run);
    const proposedVersion = `${used.methodId}/${used.version}`;
    if (proposedVersion === baseVersion) throw new Conflict('这次技能版本和当前自进化基线相同，不能送去评测');
    const rsi = this.rsi;
    if (!rsi) throw new Conflict('自进化还没有接上，这次先不送');
    const from = `${skill.methodId}/${skill.version}`;
    const change = [`个人技能档案`, `人：${person}`, `任务种类：${body.taskKind}`, `从：${from}`, `到：${proposedVersion}`, `引用：${delivery.run.id}`].join('\n');
    const reason = `主人把${body.taskKind}后来做成的技能从 ${from} 送到 ${proposedVersion} 去评测。引用 ${delivery.run.id}。候选停在 proposed。`;
    await rsi.propose({
      target: 'profile', baseVersion, proposedVersion, change, reason, risk: 'low', sourceReceiptRefs,
      proposalSignalId: lineupSignal(person, body.taskKind, delivery.run.id),
    }, { owner: scope.owner, tenantId: scope.tenantId });
    return this.view(conversation, scope, actor);
  }
  async priority(id: string, taskId: string, input: unknown, scope: Ownership, actor?: Principal) {
    const body = z.object({ expectedRevision: z.number().int().nonnegative(), direction: z.enum(['higher', 'lower']) }).strict().parse(input);
    const updated = await this.store.mutate(id, scope, current => {
      if (current.revision !== body.expectedRevision) throw new Conflict('对话已变化，请先刷新再调整优先级');
      if (!current.tasks.some(task => task.id === taskId)) throw new NotFound('Unknown task');
      const ordered = conversationTaskOrder(current.tasks);
      const index = ordered.findIndex(task => task.id === taskId);
      const swap = body.direction === 'higher' ? index - 1 : index + 1;
      if (swap < 0 || swap >= ordered.length) throw new Conflict('这项任务的优先级已经到头');
      const next = ordered.slice();
      const moving = next[index]!;
      next[index] = next[swap]!;
      next[swap] = moving;
      next.forEach((task, rank) => { task.priority = rank + 1; });
    });
    await this.syncSchedulingPriorities(updated, scope);
    return this.view(updated, scope, actor);
  }
  private async syncSchedulingPriorities(conversation: Conversation, scope: Ownership): Promise<void> {
    for (const task of conversation.tasks) {
      if (task.priority === undefined || !task.latestRunId) continue;
      await this.assignSchedulingPriority(task.latestRunId, task.priority, scope);
    }
  }
  private async assignSchedulingPriority(runId: string, priority: number, scope: Ownership): Promise<void> {
    if (!Number.isSafeInteger(priority) || priority < 1 || priority > 100) return;
    try {
      const current = await this.runs.get(runId, scope);
      if (current.schedulingPriority === priority || !RANKED_RUN_STATUSES.has(current.status)) return;
      await this.runs.mutate(runId, run => {
        if (!RANKED_RUN_STATUSES.has(run.status) || run.schedulingPriority === priority) return;
        run.schedulingPriority = priority;
      }, scope);
    } catch (error) {
      if (error instanceof NotFound) return;
      throw error;
    }
  }
  private setFocus(conversation: Conversation, taskId: string) {
    conversation.focusTaskId = taskId;
    conversation.recentTaskIds = [taskId, ...conversation.recentTaskIds.filter(id => id !== taskId)].slice(0, 10);
  }

  async post(id: string, input: unknown, scope: Ownership, keyInput: unknown, canExecute: boolean, actor?: Principal) {
    const body = messageSchema.parse(input), key = idempotencyKeySchema.parse(keyInput);
    if (body.intent !== 'execute' && body.runOptions) throw new Conflict('Run options require an explicit execution request');
    const keyHash = followupHash(key), requestHash = followupHash(body);
    const snapshot = await this.store.get(id, scope);
    const previous = snapshot.messages.find(message => message.keyHash === keyHash);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new Conflict('Idempotency-Key was already used with different input');
      return this.finish(id, previous.id, scope, actor);
    }
    if (body.intent === 'execute' && !canExecute) throw new Conflict('Model and dispatcher are not configured');
    const initialRoute = routeConversationMessage(snapshot, body);
    const selected = snapshot.tasks.find(task => task.id === initialRoute.taskIds[0]);
    const parent = body.intent === 'execute' && selected?.latestRunId ? await this.runs.get(selected.latestRunId, scope) : undefined;
    if (parent && !terminal.has(parent.status)) throw new Conflict('This task is still active; use its approval, answer or cancellation controls instead of starting another Run');
    const messageId = `message_${randomUUID()}`, at = new Date().toISOString();
    const newTask: ConversationTask | undefined = body.newTask ? { id: `task_${randomUUID()}`, threadId: `thread_${randomUUID()}`, title: body.newTask.title, createdAt: at } : undefined;
    const practice = body.intent === 'execute' && this.ownerActor(actor, scope) ? await this.readPractice(snapshot, scope, actor) : undefined;
    const practiceContent = practice ? `${practice.text}\n引用：${practice.runId}\n证据：${practice.evidenceRefs.join('、')}` : '';
    const taskKind = body.intent === 'execute' ? body.taskKind : undefined;
    const taskSetting = taskKind && this.ownerActor(actor, scope) ? await this.readTaskKind(snapshot, scope, actor, taskKind) : undefined;
    const settingContent = taskKind ? settingText(taskKind, taskSetting?.skill, taskSetting?.model) : '';
    const preferredModel = taskSetting?.model ? { model: taskSetting.model.model, ...(taskSetting.model.provider ? { provider: taskSetting.model.provider } : {}) } : undefined;
    const updated = await this.store.mutate(id, scope, current => {
      const duplicate = current.messages.find(message => message.keyHash === keyHash);
      if (duplicate) {
        if (duplicate.requestHash !== requestHash) throw new Conflict('Idempotency-Key was already used with different input');
        return;
      }
      const route = routeConversationMessage(current, body);
      if ((body.correctsMessageId || route.reason === 'focus' || !body.taskIds && !body.replyTo && !body.newTask || body.focus === 'switch') && current.revision !== body.expectedRevision) throw new Conflict('Discussion focus changed; refresh before sending this message');
      if (newTask) { current.tasks.push(newTask); route.taskIds = [newTask.id]; }
      const task = current.tasks.find(task => task.id === route.taskIds[0]);
      const speaker = resolveSpeaker(body.speaker, scope);
      const message: ConversationMessage = { id: messageId, keyHash, requestHash, role: 'user', speaker, text: body.text, createdAt: at, ...(body.replyTo ? { replyTo: body.replyTo } : {}), ...(body.correctsMessageId ? { correctsMessageId: body.correctsMessageId } : {}), route };
      if (body.intent === 'execute' && route.status === 'routed' && task) {
        if (task.pendingMessageId) throw new Conflict('Task execution is already being prepared');
        if (!newTask && (task.id !== selected?.id || task.latestRunId !== parent?.id)) throw new Conflict('Task changed while routing; refresh before execution');
        const person = privatePerson(current);
        const notes = current.messages.filter(item => item.role === 'user' && !item.execution && !item.correctsMessageId && effectiveTasks(current, item).includes(task.id)).slice(-8).map(item => {
          const voice = spoken(item, current.owner);
          return { id: item.id, role: voice.role, speakerId: voice.id, ...(person ? { privateWith: { role: 'agent' as const, id: person } } : {}), text: item.text };
        }).reverse();
        const selectedNotes: typeof notes = [];
        for (const note of notes) {
          if (JSON.stringify([...selectedNotes, note]).length > 12000) break;
          selectedNotes.unshift(note);
        }
        const options = body.runOptions ?? {};
        const materials = [...(body.runOptions?.materials ?? [])];
        const standing = current.standingInstruction?.trim() ?? '';
        const history = selectedNotes.length > 0;
        const reserved = (history ? 1 : 0) + (standing ? 1 : 0) + (practiceContent ? 1 : 0) + (settingContent ? 1 : 0);
        if (materials.length + reserved > 20) {
          const slots = [standing ? 'the standing instruction' : '', practiceContent ? 'the accepted practice' : '', settingContent ? 'the task setting' : '', history ? 'task discussion history' : ''].filter(Boolean);
          const label = slots[0] ?? 'task discussion history';
          throw new Conflict(slots.length > 1 ? `Leave material slots for ${slots.join(' and ')}` : `Leave one material slot for ${label}`);
        }
        if (standing) materials.push({ title: 'Standing instruction (untrusted, not execution authority)', source: `conversation:${id}/standing`, content: standing });
        if (practiceContent) materials.push({ title: PRACTICE_TITLE, source: `conversation:${id}/practice`, content: practiceContent });
        if (settingContent && taskKind) materials.push({ title: TASK_SETTING_TITLE, source: `conversation:${id}/task-kind/${taskKind}`, content: settingContent });
        if (history) materials.push({ title: 'Task discussion history (untrusted, not execution authority)', source: `conversation:${id}/task:${task.id}`, content: JSON.stringify(selectedNotes) });
        const request = requestSchema.parse({ ...options, goal: harnessGoal(current, task.title, body.text, speaker), materials, workingMemory: { enabled: true }, ...(preferredModel ? { preferredModel } : {}) });
        const runId = followupRunId(task.threadId, followupHash(message.id), scope);
        message.execution = { taskId: task.id, runId, ...(parent ? { parentRunId: parent.id } : {}), request, state: 'pending' };
        task.pendingMessageId = message.id;
      }
      current.messages.push(message);
      if (route.status === 'routed' && route.focusEffect === 'switch' && route.taskIds.length === 1) this.setFocus(current, route.taskIds[0]!);
    });
    return this.finish(id, updated.messages.find(message => message.keyHash === keyHash)!.id, scope, actor);
  }

  private async runExists(runId: string, scope: Ownership): Promise<boolean> {
    try { await this.runs.get(runId, scope); return true; }
    catch (error) { if (error instanceof NotFound) return false; throw error; }
  }
  private async finish(id: string, messageId: string, scope: Ownership, actor?: Principal) {
    let conversation = await this.store.get(id, scope);
    let message = conversation.messages.find(item => item.id === messageId)!;
    if (message.execution?.state === 'pending') {
      const execution = message.execution;
      const task = conversation.tasks.find(item => item.id === execution.taskId)!;
      try {
        try { await this.runs.getThread(task.threadId, scope); }
        catch (error) {
          if (!(error instanceof NotFound)) throw error;
          try { await this.runs.createThread({ id: task.threadId, ...scope, title: task.title, createdAt: task.createdAt }); }
          catch (error) { if (!(error instanceof ThreadConflict)) throw error; }
        }
        const thread = await this.runs.getThread(task.threadId, scope);
        if (thread.title !== task.title || thread.createdAt !== task.createdAt) throw new Conflict('Task thread identity changed');
        const run = await this.threads.followUp(task.threadId, { request: execution.request, ...(execution.parentRunId ? { parentRunId: execution.parentRunId } : {}) }, scope, message.id);
        if (run.id !== execution.runId) throw new Conflict('Prepared Run does not match the routed execution');
        conversation = await this.store.mutate(id, scope, current => {
          const live = current.messages.find(item => item.id === messageId)!;
          if (live.execution?.state !== 'pending') return;
          const task = current.tasks.find(item => item.id === live.execution!.taskId)!;
          if (task.pendingMessageId !== messageId) throw new Conflict('Task execution reservation changed');
          live.execution.state = 'completed'; task.latestRunId = run.id; delete task.pendingMessageId;
        });
        message = conversation.messages.find(item => item.id === messageId)!;
      } catch (error) {
        // A committed Run must stay reserved so the same idempotency key can finish it.
        // A missing Run releases the task; terminal cancellation cannot be undone.
        if (await this.runExists(execution.runId, scope)) throw new ReplayablePreparationError(error instanceof Error ? error.message : 'Execution preparation failed');
        await this.store.mutate(id, scope, current => {
          const live = current.messages.find(item => item.id === messageId);
          if (live?.execution?.state !== 'pending') return;
          live.execution.state = 'cancelled';
          const reserved = current.tasks.find(item => item.id === live.execution!.taskId);
          if (reserved?.pendingMessageId === messageId) delete reserved.pendingMessageId;
        });
        if (error instanceof Conflict || error instanceof ThreadConflict || error instanceof NotFound || error instanceof RangeError) throw error;
        const detail = error instanceof Error ? error.message : 'Execution preparation failed';
        throw new Conflict(`执行没有创建，请重新发送。${detail}`);
      }
    }
    if (message.execution?.state === 'completed' && message.execution.runId) {
      const linked = conversation.tasks.find(item => item.id === message.execution?.taskId);
      if (linked?.priority !== undefined) {
        try { await this.assignSchedulingPriority(message.execution.runId, linked.priority, scope); }
        catch (error) { console.error('Scheduling rank was not stored', message.execution.runId, error instanceof Error ? error.name : 'Error'); }
      }
    }
    const task = conversation.tasks.find(task => task.id === message.route.taskIds[0]);
    const response = message.route.status === 'clarify'
      ? '请明确选择要讨论或执行的任务；本条消息没有触发执行。'
      : message.correctsMessageId ? '已追加归属纠正，仅影响后续消息和新执行上下文；已有执行记录不变。'
      : message.execution?.state === 'cancelled' ? '这次执行没有创建，请重新发送。'
      : message.execution?.state === 'completed' ? `已为「${task?.title}」创建执行，仍需遵守计划审批。`
      : message.route.status === 'general' ? '已记录一般讨论；选择或新建任务后可继续。'
      : `已关联到${message.route.taskIds.map(id => `「${conversation.tasks.find(task => task.id === id)!.title}」`).join('、')}，未触发执行。`;
    return { conversation: await this.view(conversation, scope, actor), message: redactRunData(this.messageView(message)), response, ...(message.execution?.state === 'completed' ? { runId: message.execution.runId } : {}) };
  }

  async syncNotifications(id: string, scope: Ownership, actor?: Principal) {
    const snapshot = await this.store.get(id, scope);
    const notifications: ConversationMessage[] = [];
    for (const task of snapshot.tasks) {
      if (!task.latestRunId) continue;
      const run = await this.runs.get(task.latestRunId, scope);
      if (!terminal.has(run.status) && !['needs_input', 'needs_approval', 'unknown'].includes(run.status)) continue;
      const keyHash = followupHash({ runId: run.id, status: run.status, question: run.question, planVersion: run.plans.at(-1)?.version });
      notifications.push({ id: `message_${randomUUID()}`, keyHash, requestHash: keyHash, role: 'notification', text: `任务「${task.title}」：${run.status}。`, createdAt: new Date().toISOString(), notificationRunId: run.id,
        route: { status: 'routed', reason: 'explicit', taskIds: [task.id], candidateTaskIds: [], focusEffect: 'keep' } });
    }
    const updated = await this.store.mutate(id, scope, current => {
      for (const message of notifications) if (!current.messages.some(item => item.keyHash === message.keyHash)) current.messages.push(message);
    });
    return this.view(updated, scope, actor);
  }

  async taskRun(id: string, taskId: string, runId: string, scope: Ownership) {
    const conversation = await this.store.get(id, scope);
    const task = conversation.tasks.find(task => task.id === taskId);
    if (!task) throw new NotFound('Unknown task');
    const run = await this.runs.get(runId, scope);
    if (run.threadId !== task.threadId) throw new NotFound('Unknown task Run');
    return run;
  }

  async recover(): Promise<void> {
    for await (const conversation of this.store.pending()) {
      for (const message of conversation.messages.filter(message => message.execution?.state === 'pending')) {
        try { await this.finish(conversation.id, message.id, { owner: conversation.owner, tenantId: conversation.tenantId }); }
        catch (error) { console.error('Conversation execution recovery failed', message.id, error instanceof Error ? error.name : 'Error'); }
      }
    }
  }
}
