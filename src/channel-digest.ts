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
  const entries: TaskTimelineEntry[] = [];
  for (const cite of input.board.citations) {
    if (taskKey(cite) !== key || !cite.at) continue;
    const human = cite.actorType !== 'agent' && !cite.automatic;
    entries.push({ at: cite.at, who: cite.actorType === 'agent' ? name(cite.actorId) : cite.automatic ? '自动记录' : OWNER, text: clip(cite.content), source: 'room', human });
  }
  for (const action of input.board.actions) {
    if (taskKey(action) !== key || !action.at) continue;
    const byBot = Boolean(action.automatic);
    const line = taskActionLine({ schemaVersion: 'channel-task-action/1', kind: action.kind, conversationId: action.conversationId, taskId: action.taskId, ...(action.agentId ? { agentId: action.agentId } : {}) }, action.agentId ? name(action.agentId) : undefined);
    entries.push({ at: action.at, who: byBot ? '自动记录' : OWNER, text: line, source: 'room', human: !byBot });
  }
  const run = input.run;
  if (run) {
    const doer = card?.ownerId ? name(card.ownerId) : 'Bot';
    const nodes = new Map((run.plans.at(-1)?.nodes ?? []).map(node => [node.id, node.title]));
    const asked = run.events.filter(event => event.type === 'input.requested');
    const received = run.events.filter(event => event.type === 'input.received');
    const push = (at: string, human: boolean, text: string) => entries.push({ at, who: human ? OWNER : doer, text: clip(text), source: 'run', human });
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
        case 'run.handed_back': push(event.at, true, '写了说明交还'); break;
        case 'review.completed': push(event.at, false, event.data.verdict === 'accepted' ? '独立审核通过' : '独立审核要求修改'); break;
        case 'run.failed': push(event.at, false, `失败：${str(event.data.reason) || run.error || '没有写原因'}`); break;
        case 'run.cancelled': push(event.at, true, '取消了这件 Run'); break;
      }
    }
  }
  return entries.sort((left, right) => left.at.localeCompare(right.at));
}
