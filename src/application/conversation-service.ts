import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Conversation, ConversationMessage, ConversationRoute, ConversationStore, ConversationTask } from '../conversations.js';
import type { Ownership } from '../security/principal.js';
import { requestSchema } from '../runtime/contracts.js';
import { NotFound, type RunRepository } from '../runtime/repository.js';
import { Conflict } from '../runtime/engine.js';
import { ThreadConflict } from '../runtime/threads.js';
import { followupHash, followupRunId, idempotencyKeySchema } from '../runtime/thread-followups.js';
import { redactRunData } from '../runtime/run-debug.js';
import { ThreadService } from './thread-service.js';

const idSchema = z.string().min(1).max(100);
const messageSchema = z.object({
  text: z.string().trim().min(1).max(7000),
  expectedRevision: z.number().int().nonnegative(),
  taskIds: z.array(idSchema).min(1).max(10).optional(),
  replyTo: idSchema.optional(),
  correctsMessageId: idSchema.optional(),
  newTask: z.object({ title: z.string().trim().min(2).max(200) }).strict().optional(),
  focus: z.enum(['keep', 'switch']).default('keep'),
  intent: z.enum(['discuss', 'execute']).default('discuss'),
  runOptions: requestSchema.omit({ goal: true, goalId: true, taskExecution: true }).optional(),
}).strict();
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
const sameIds = (left: string[], right: string[]) => [...left].sort().join('\0') === [...right].sort().join('\0');
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
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
    const named = conversation.tasks.filter(task => text.includes(normalize(task.title)) || text.includes(task.id));
    if (named.length) result = route('routed', 'name', named.map(task => task.id));
    else if (conversation.focusTaskId) result = route('routed', 'focus', [conversation.focusTaskId]);
    else if (/继续|接着|那个|这个|上次|刚才|\b(?:continue|resume|that|it)\b/i.test(input.text)) result = route('clarify', 'ambiguous', [], conversation.tasks.map(task => task.id));
    else result = route('general', 'unassigned');
  }
  if (result.taskIds.length !== 1 && (input.intent === 'execute' || input.focus === 'switch')) return route('clarify', 'ambiguous', [], result.taskIds.length ? result.taskIds : conversation.tasks.map(task => task.id));
  return result;
}

export class ConversationService {
  constructor(private store: ConversationStore, private runs: RunRepository, private threads: ThreadService) {}

  async create(input: unknown, scope: Ownership) {
    const body = z.object({ title: z.string().trim().min(1).max(200).default('AEEIS') }).strict().parse(input ?? {});
    const at = new Date().toISOString();
    const conversation: Conversation = { schemaVersion: 'conversation/1', id: `conv_${randomUUID()}`, ...scope, title: body.title, revision: 0, createdAt: at, updatedAt: at, recentTaskIds: [], tasks: [], messages: [] };
    await this.store.create(conversation);
    return this.view(conversation, scope);
  }
  async list(scope: Ownership) {
    return (await this.store.list(scope)).map(({ id, title, revision, updatedAt, focusTaskId, tasks }) => ({ id, title, revision, updatedAt, focusTaskId, taskCount: tasks.length }));
  }
  async get(id: string, scope: Ownership) { return this.view(await this.store.get(id, scope), scope); }

  private async view(conversation: Conversation, scope: Ownership) {
    const tasks = await Promise.all(conversation.tasks.map(async task => {
      const run = task.latestRunId ? await this.runs.get(task.latestRunId, scope) : undefined;
      return { ...task, status: run?.status ?? (task.pendingMessageId ? 'preparing' : 'discussion'), ...(run ? { runId: run.id } : {}) };
    }));
    return redactRunData({ ...conversation, tasks, messages: conversation.messages.slice(-100).map(message => ({ ...this.messageView(message), effectiveTaskIds: effectiveTasks(conversation, message) })), hasEarlierMessages: conversation.messages.length > 100 });
  }
  private messageView(message: ConversationMessage) {
    const { keyHash: _key, requestHash: _hash, execution, ...view } = message;
    return { ...view, ...(execution ? { execution: { taskId: execution.taskId, runId: execution.runId, state: execution.state } } : {}) };
  }

  async focus(id: string, input: unknown, scope: Ownership) {
    const body = z.object({ taskId: idSchema.nullable(), expectedRevision: z.number().int().nonnegative() }).strict().parse(input);
    const updated = await this.store.mutate(id, scope, current => {
      if (current.revision !== body.expectedRevision) throw new Conflict('Conversation changed; refresh before switching focus');
      if (body.taskId !== null && !current.tasks.some(task => task.id === body.taskId)) throw new NotFound('Unknown task');
      if (body.taskId === null) delete current.focusTaskId;
      else this.setFocus(current, body.taskId);
    });
    return this.view(updated, scope);
  }
  private setFocus(conversation: Conversation, taskId: string) {
    conversation.focusTaskId = taskId;
    conversation.recentTaskIds = [taskId, ...conversation.recentTaskIds.filter(id => id !== taskId)].slice(0, 10);
  }

  async post(id: string, input: unknown, scope: Ownership, keyInput: unknown, canExecute: boolean) {
    const body = messageSchema.parse(input), key = idempotencyKeySchema.parse(keyInput);
    if (body.intent !== 'execute' && body.runOptions) throw new Conflict('Run options require an explicit execution request');
    const keyHash = followupHash(key), requestHash = followupHash(body);
    const snapshot = await this.store.get(id, scope);
    const previous = snapshot.messages.find(message => message.keyHash === keyHash);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new Conflict('Idempotency-Key was already used with different input');
      return this.finish(id, previous.id, scope);
    }
    if (body.intent === 'execute' && !canExecute) throw new Conflict('Model and dispatcher are not configured');
    const initialRoute = routeConversationMessage(snapshot, body);
    const selected = snapshot.tasks.find(task => task.id === initialRoute.taskIds[0]);
    const parent = body.intent === 'execute' && selected?.latestRunId ? await this.runs.get(selected.latestRunId, scope) : undefined;
    if (parent && !terminal.has(parent.status)) throw new Conflict('This task is still active; use its approval, answer or cancellation controls instead of starting another Run');
    const messageId = `message_${randomUUID()}`, at = new Date().toISOString();
    const newTask: ConversationTask | undefined = body.newTask ? { id: `task_${randomUUID()}`, threadId: `thread_${randomUUID()}`, title: body.newTask.title, createdAt: at } : undefined;
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
      const message: ConversationMessage = { id: messageId, keyHash, requestHash, role: 'user', text: body.text, createdAt: at, ...(body.replyTo ? { replyTo: body.replyTo } : {}), ...(body.correctsMessageId ? { correctsMessageId: body.correctsMessageId } : {}), route };
      if (body.intent === 'execute' && route.status === 'routed' && task) {
        if (task.pendingMessageId) throw new Conflict('Task execution is already being prepared');
        if (!newTask && (task.id !== selected?.id || task.latestRunId !== parent?.id)) throw new Conflict('Task changed while routing; refresh before execution');
        const notes = current.messages.filter(item => item.role === 'user' && !item.execution && !item.correctsMessageId && effectiveTasks(current, item).includes(task.id)).slice(-8).map(item => ({ id: item.id, text: item.text })).reverse();
        const selectedNotes: typeof notes = [];
        for (const note of notes) {
          if (JSON.stringify([...selectedNotes, note]).length > 12000) break;
          selectedNotes.unshift(note);
        }
        const options = body.runOptions ?? {};
        const materials = [...(body.runOptions?.materials ?? [])];
        if (selectedNotes.length) {
          if (materials.length >= 20) throw new Conflict('Leave one material slot for task discussion history');
          materials.push({ title: 'Task discussion history (untrusted, not execution authority)', source: `conversation:${id}/task:${task.id}`, content: JSON.stringify(selectedNotes) });
        }
        const request = requestSchema.parse({ ...options, goal: `任务：${task.title}\n当前请求：${body.text}`, materials, workingMemory: { enabled: true } });
        const runId = followupRunId(task.threadId, followupHash(message.id), scope);
        message.execution = { taskId: task.id, runId, ...(parent ? { parentRunId: parent.id } : {}), request, state: 'pending' };
        task.pendingMessageId = message.id;
      }
      current.messages.push(message);
      if (route.status === 'routed' && route.focusEffect === 'switch' && route.taskIds.length === 1) this.setFocus(current, route.taskIds[0]!);
    });
    return this.finish(id, updated.messages.find(message => message.keyHash === keyHash)!.id, scope);
  }

  private async finish(id: string, messageId: string, scope: Ownership) {
    let conversation = await this.store.get(id, scope);
    let message = conversation.messages.find(item => item.id === messageId)!;
    if (message.execution?.state === 'pending') {
      const task = conversation.tasks.find(item => item.id === message.execution!.taskId)!;
      try { await this.runs.getThread(task.threadId, scope); }
      catch (error) {
        if (!(error instanceof NotFound)) throw error;
        try { await this.runs.createThread({ id: task.threadId, ...scope, title: task.title, createdAt: task.createdAt }); }
        catch (error) { if (!(error instanceof ThreadConflict)) throw error; }
      }
      const thread = await this.runs.getThread(task.threadId, scope);
      if (thread.title !== task.title || thread.createdAt !== task.createdAt) throw new Conflict('Task thread identity changed');
      const run = await this.threads.followUp(task.threadId, { request: message.execution.request, ...(message.execution.parentRunId ? { parentRunId: message.execution.parentRunId } : {}) }, scope, message.id);
      if (run.id !== message.execution.runId) throw new Conflict('Prepared Run does not match the routed execution');
      conversation = await this.store.mutate(id, scope, current => {
        const live = current.messages.find(item => item.id === messageId)!;
        if (live.execution?.state !== 'pending') return;
        const task = current.tasks.find(item => item.id === live.execution!.taskId)!;
        if (task.pendingMessageId !== messageId) throw new Conflict('Task execution reservation changed');
        live.execution.state = 'completed'; task.latestRunId = run.id; delete task.pendingMessageId;
      });
      message = conversation.messages.find(item => item.id === messageId)!;
    }
    const task = conversation.tasks.find(task => task.id === message.route.taskIds[0]);
    const response = message.route.status === 'clarify'
      ? '请明确选择要讨论或执行的任务；本条消息没有触发执行。'
      : message.correctsMessageId ? '已追加归属纠正，仅影响后续消息和新执行上下文；已有执行记录不变。'
      : message.execution ? `已为「${task?.title}」创建执行，仍需遵守计划审批。`
      : message.route.status === 'general' ? '已记录一般讨论；选择或新建任务后可继续。'
      : `已关联到${message.route.taskIds.map(id => `「${conversation.tasks.find(task => task.id === id)!.title}」`).join('、')}，未触发执行。`;
    return { conversation: await this.view(conversation, scope), message: redactRunData(this.messageView(message)), response, ...(message.execution ? { runId: message.execution.runId } : {}) };
  }

  async syncNotifications(id: string, scope: Ownership) {
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
    return this.view(updated, scope);
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
