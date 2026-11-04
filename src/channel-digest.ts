import type { SessionEvent, SessionEventDraft, SessionEventRepository } from './session-events.js';
import { channelAttention, type ChannelNoiseStore, type ChannelScope } from './channel-noise.js';
import { digestProtocol } from './protocol.js';
import type { AgentRun } from './runtime/contracts.js';
import { taskActionLine, type ChannelBoard } from './channel-task-action.js';
import { quantile, runExecutionSpan } from './channel-metrics.js';

/** Interaction-design §8.8: the time and money behind a channel's digest window, read from its tasks' Runs. */
export interface ChannelDigestCost {
  from: string;
  to: string;
  /** Runs that executed during the window. */
  runs: number;
  /** Summed time those Runs spent executing inside the window. Waiting on a person does not count. */
  runTimeMs: number;
  /** Median request-to-acceptance time of tasks accepted in the window. */
  cycleMs?: number;
  accepted: number;
  /** Tokens of model calls that started in the window. */
  tokens: number;
  /** Money of those tokens, shared out of each Run's priced total by its tokens in the window. Undefined when no Run was priced. */
  moneyUsd?: number;
  /** Tool credits of tool calls completed in the window. */
  credits: number;
  /** Completed model calls in the window that reported no usage. */
  unreportedCalls: number;
}

const time = (at: string | undefined) => { const value = Date.parse(at ?? ''); return Number.isFinite(value) ? value : undefined; };
const taskKey = (item: { conversationId: string; taskId: string }) => `${item.conversationId}:${item.taskId}`;
const callTokens = (call: AgentRun['calls'][number]) => call.usage ? call.usage.inputTokens + call.usage.outputTokens : 0;

export function channelDigestCost(input: { from: string; to: string; board: ChannelBoard; runs: ReadonlyMap<string, AgentRun> }): ChannelDigestCost {
  const from = time(input.from)!, to = time(input.to)!;
  const inWindow = (at: string | undefined) => { const value = time(at); return value !== undefined && value >= from && value < to; };
  let runs = 0, runTimeMs = 0, tokens = 0, credits = 0, unreportedCalls = 0, money = 0, priced = false;
  for (const card of input.board.cards) {
    const run = card.runId ? input.runs.get(card.runId) : undefined;
    if (!run) continue;
    const span = runExecutionSpan(run, to);
    const inside = span ? Math.min(span.end, to) - Math.max(span.start, from) : 0;
    if (inside > 0) { runs += 1; runTimeMs += inside; }
    const windowCalls = run.calls.filter(call => inWindow(call.startedAt));
    const windowTokens = windowCalls.reduce((total, call) => total + callTokens(call), 0);
    tokens += windowTokens;
    unreportedCalls += windowCalls.filter(call => call.state === 'completed' && !call.usage).length;
    const runTokens = run.calls.reduce((total, call) => total + callTokens(call), 0);
    if (run.modelUsage?.moneyUsd !== undefined && runTokens > 0) { priced = true; money += run.modelUsage.moneyUsd * windowTokens / runTokens; }
    for (const receipt of run.toolReceipts ?? []) if (receipt.status === 'completed' && inWindow(receipt.completedAt ?? receipt.startedAt)) credits += receipt.cost?.credits ?? 0;
  }
  const firstCited = new Map<string, number>();
  for (const cite of input.board.citations) {
    const at = time(cite.at); if (at === undefined) continue;
    const key = taskKey(cite);
    if (!firstCited.has(key) || at < firstCited.get(key)!) firstCited.set(key, at);
  }
  const accepts = input.board.actions.filter(action => action.kind === 'accept' && inWindow(action.at));
  const cycles = accepts.flatMap(action => { const start = firstCited.get(taskKey(action)); const end = time(action.at); return start !== undefined && end !== undefined ? [end - start] : []; });
  const cycleMs = quantile(cycles, 0.5);
  return {
    from: input.from, to: input.to, runs, runTimeMs, accepted: accepts.length, tokens, credits, unreportedCalls,
    ...(cycleMs === undefined ? {} : { cycleMs }), ...(priced ? { moneyUsd: Math.round(money * 10_000) / 10_000 } : {}),
  };
}

/**
 * One task from the request to delivery (§8.8 timeline replay): what the room recorded about it, then what its Run
 * did, each with who did it. A Run the reader cannot open leaves only the room's part.
 */
export interface TaskTimelineEntry { at: string; who: string; text: string; source: 'room' | 'run'; human: boolean }

const clip = (text: string, length = 300) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > length ? `${flat.slice(0, length)}…` : flat; };
const OWNER = '你';

export function taskTimeline(input: { board: ChannelBoard; conversationId: string; taskId: string; run?: AgentRun; nameOf: (agentId: string) => string }): TaskTimelineEntry[] {
  const key = `${input.conversationId}:${input.taskId}`;
  const card = input.board.cards.find(item => taskKey(item) === key);
  const name = input.nameOf;
  // Room records keep the room's own order when they share a millisecond; Run moments come after them.
  const entries: Array<TaskTimelineEntry & { order: number }> = [];
  for (const cite of input.board.citations) {
    if (taskKey(cite) !== key || !cite.at) continue;
    const human = cite.actorType !== 'agent' && !cite.automatic;
    entries.push({ order: cite.sequence ?? 0, at: cite.at, who: cite.actorType === 'agent' ? name(cite.actorId) : cite.automatic ? '自动记录' : OWNER, text: clip(cite.content), source: 'room', human });
  }
  for (const action of input.board.actions) {
    if (taskKey(action) !== key || !action.at) continue;
    const byBot = Boolean(action.automatic);
    const line = action.kind === 'move' || action.kind === 'clear_override' ? action.content ?? action.kind : taskActionLine({ schemaVersion: 'channel-task-action/1', kind: action.kind, conversationId: action.conversationId, taskId: action.taskId, ...(action.agentId ? { agentId: action.agentId } : {}) }, action.agentId ? name(action.agentId) : undefined);
    entries.push({ order: action.sequence ?? 0, at: action.at, who: byBot ? '自动记录' : OWNER, text: line, source: 'room', human: !byBot });
  }
  const run = input.run;
  if (run) {
    const doer = card?.ownerId ? name(card.ownerId) : 'Bot';
    const nodes = new Map((run.plans.at(-1)?.nodes ?? []).map(node => [node.id, node.title]));
    const asked = run.events.filter(event => event.type === 'input.requested');
    const received = run.events.filter(event => event.type === 'input.received');
    const push = (at: string, human: boolean, text: string) => entries.push({ order: Number.MAX_SAFE_INTEGER, at, who: human ? OWNER : doer, text: clip(text), source: 'run', human });
    const str = (value: unknown) => typeof value === 'string' ? value : '';
    for (const event of run.events) {
      const step = typeof event.data.taskId === 'string' ? nodes.get(event.data.taskId) ?? event.data.taskId : '';
      switch (event.type) {
        case 'run.created': push(event.at, false, '开了一件 Run'); break;
        case 'plan.approval_requested': push(event.at, false, `计划等批准${run.plans.at(-1)?.summary ? `：${run.plans.at(-1)!.summary}` : ''}`); break;
        case 'plan.approved': push(event.at, true, '批准了计划'); break;
        case 'plan.auto_approved': push(event.at, false, '按设定自动批准了计划'); break;
        case 'plan.revision_requested': push(event.at, true, `打回计划${str(event.data.reason) ? `：${str(event.data.reason)}` : ''}`); break;
        case 'artifact.created': if (step) push(event.at, false, `做完「${step}」`); break;
        case 'input.requested': {
          const index = asked.indexOf(event);
          const question = run.answers[index]?.question ?? (index === asked.length - 1 ? run.question?.text : undefined);
          push(event.at, false, `提问${question ? `：${question}` : ''}`);
          break;
        }
        case 'input.received': { const answer = run.answers[received.indexOf(event)]?.answer; push(event.at, true, `回答${answer ? `：${answer}` : ''}`); break; }
        case 'action.approval_requested': push(event.at, false, `请求允许动作 ${str(event.data.ref)}`); break;
        case 'action.approved': case 'action.denied': push(event.at, true, `${event.type === 'action.approved' ? '允许' : '拒绝'}动作 ${str(event.data.ref)}`); break;
        case 'run.paused': push(event.at, true, '暂停'); break;
        case 'run.resumed': push(event.at, true, '继续'); break;
        case 'run.taken_over': push(event.at, true, '接手做了一段'); break;
        case 'takeover.tool': push(event.at, true, `在 Bot 的工作区里用 ${str(event.data.toolId)}${str(event.data.summary) ? `：${str(event.data.summary)}` : ''}`); break;
        case 'run.handed_back': push(event.at, true, '写了说明交还'); break;
        case 'review.completed': push(event.at, false, event.data.verdict === 'accepted' ? '独立审核通过' : '独立审核要求修改'); break;
        case 'run.failed': push(event.at, false, `失败：${str(event.data.reason) || run.error || '没有写原因'}`); break;
        case 'run.cancelled': push(event.at, true, '取消了这件 Run'); break;
      }
    }
  }
  return entries.sort((left, right) => left.at.localeCompare(right.at) || left.order - right.order).map(({ order: _order, ...entry }) => entry);
}

/** §5.4: queued originals remain append-only session facts. A digest acknowledges their IDs, so a crash
 * between publishing and the next pump cannot duplicate or lose a batch. The room lock also covers the rate gate. */
export class ChannelDigestDelivery {
  constructor(private readonly repository: SessionEventRepository, readonly settings: ChannelNoiseStore, private readonly now: () => number = Date.now) {}
  private async history(scope: ChannelScope): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    let cursor = 0;
    for (;;) {
      const page = await this.repository.page(scope.roomId, scope, 200, cursor);
      events.push(...page.items);
      if (!page.nextCursor) return events;
      cursor = Number(page.nextCursor);
    }
  }
  async write(input: SessionEventDraft, append: (draft: SessionEventDraft) => Promise<SessionEvent>): Promise<SessionEvent> {
    const attention = channelAttention({ ...input, kind: input.notificationKind });
    if (attention === 'human' || attention === 'decision' || input.operation === 'retract') return append(input);
    return this.settings.withRoom(input, async () => {
      const events = await this.history(input);
      const now = this.now();
      const mode = attention === 'progress' || !channelRateAvailable(events, now) ? 'digest' : 'immediate';
      return append({ ...input, botDelivery: { mode, at: new Date(now).toISOString() } });
    });
  }
  private running: Promise<number> | undefined;
  pump(): Promise<number> {
    this.running ??= this.flush().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async flush(): Promise<number> {
    let sent = 0;
    for (const scope of await this.repository.pendingDigestRooms?.() ?? []) {
      sent += await this.settings.withRoom(scope, async settings => {
        const events = await this.history(scope);
        const now = this.now();
        if (!channelRateAvailable(events, now)) return 0;
        const done = new Set(events.flatMap(event => event.digest?.eventIds ?? []));
        const pending = events.filter(event => event.botDelivery?.mode === 'digest' && !done.has(event.id));
        const first = pending[0];
        if (!first) return 0;
        const lastDigest = events.filter(event => event.digest).at(-1);
        const since = Math.max(Date.parse(first.botDelivery!.at), lastDigest ? Date.parse(lastDigest.createdAt) : 0);
        if (now - since < settings.digestMinutes * 60_000) return 0;
        // Never merge private and room-wide audiences. Each original keeps its own context binding.
        const batch = pending.filter(event => event.classification === first.classification && event.audienceSnapshot.digest === first.audienceSnapshot.digest);
        const content = `已合并 ${batch.length} 条`;
        const eventIds = batch.map(event => event.id);
        const digest = { eventIds, minutes: settings.digestMinutes };
        const draft: SessionEventDraft = {
          roomId: first.roomId, ...(first.goalId ? { goalId: first.goalId } : {}), owner: first.owner, tenantId: first.tenantId,
          type: 'digest', actorId: 'aeeis', actorType: 'system', operation: 'publish', revision: 1,
          classification: first.classification, contextManifestId: first.contextManifestId, contextManifestHash: first.contextManifestHash,
          audienceSnapshot: first.audienceSnapshot, content, contentHash: digestProtocol({ content, digest, contextManifestHash: first.contextManifestHash }),
          evidenceRefs: [], idempotencyKey: `channel-digest:${first.id}`, createdAt: new Date(now).toISOString(),
          botDelivery: { mode: 'immediate', at: new Date(now).toISOString() }, digest,
        };
        await this.repository.append(draft);
        return 1;
      });
    }
    return sent;
  }
}

export function channelRateAvailable(events: readonly SessionEvent[], now: number): boolean {
  return events.filter(event => {
    // Messages published before this rule was installed still occupy their part of the current window.
    const legacy = !event.botDelivery && event.operation !== 'retract' && ['message', 'progress'].includes(channelAttention({ ...event, kind: event.notificationKind }));
    if (event.botDelivery?.mode !== 'immediate' && !legacy) return false;
    const at = Date.parse(event.botDelivery?.at ?? event.createdAt);
    return at > now - 10 * 60_000 && at <= now;
  }).length < 6;
}
