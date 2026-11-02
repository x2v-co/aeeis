import type { AgentRun } from './runtime/contracts.js';
import type { SessionEvent } from './session-events.js';
import type { ChannelBoard } from './channel-task-action.js';
import type { UiEventCounts } from './ui-event-counts.js';

/** Interaction-design §18.1 for one channel over a window. Every number is read from records AEEIS already keeps:
 * the room's events and task actions, the Runs its tasks started, and the browser-only counts of §18.2. */
export interface ChannelMetrics {
  schemaVersion: 'channel-metrics/1';
  roomId: string;
  from: string;
  to: string;
  tasks: { created: number; done: number };
  indicators: ChannelIndicator[];
}
export interface ChannelIndicator {
  key: IndicatorKey;
  /** Undefined when the window has nothing to measure. */
  value?: number;
  unit: 'ratio' | 'ms' | 'count';
  /** How many observations the value comes from. */
  samples: number;
  /** Whether the value meets the design target; undefined when the target is a baseline or there is no value. */
  ok?: boolean;
  /** Extra numbers the indicator is read with, such as the maximum handoff depth. */
  detail?: Record<string, number>;
}
export type IndicatorKey = 'completion_rate' | 'first_reply' | 'cycle_time' | 'handoff_depth' | 'parallel_use' | 'interventions' | 'intervened_share'
  | 'blocked_time' | 'noise' | 'evidence_open_rate' | 'duplicate_effects' | 'handoff_failure_rate';

export interface ChannelMetricsInput {
  roomId: string;
  from: string;
  to: string;
  history: readonly SessionEvent[];
  board: ChannelBoard;
  /** Runs started by the room's tasks, by id. A Run the reader cannot open is left out. */
  runs: ReadonlyMap<string, AgentRun>;
  ui: UiEventCounts;
}

const HOUR = 3_600_000;
/** Run events that record a person's decision: plan approval or rejection, an action decision, an answer, a reconcile, a takeover. */
const HUMAN_DECISIONS = new Set(['plan.approved', 'plan.revision_requested', 'action.approved', 'action.denied', 'input.received', 'run.reconciled', 'run.taken_over']);
const TERMINAL_RUN_EVENTS = new Set(['run.failed', 'run.cancelled', 'review.completed']);
const EXECUTING = new Set(['queued', 'planning', 'running', 'reviewing']);

export function quantile(values: readonly number[], q: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}
const time = (at: string | undefined) => { const value = Date.parse(at ?? ''); return Number.isFinite(value) ? value : undefined; };
const taskKey = (item: { conversationId: string; taskId: string }) => `${item.conversationId}:${item.taskId}`;

export function channelMetrics(input: ChannelMetricsInput): ChannelMetrics {
  const from = time(input.from)!, to = time(input.to)!;
  const inWindow = (at: string | undefined) => { const value = time(at); return value !== undefined && value >= from && value < to; };
  const { board } = input;

  // A task is created when the room first cites it.
  const firstCited = new Map<string, number>();
  for (const cite of board.citations) {
    const at = time(cite.at); if (at === undefined) continue;
    const key = taskKey(cite);
    if (!firstCited.has(key) || at < firstCited.get(key)!) firstCited.set(key, at);
  }
  const created = [...firstCited].filter(([, at]) => at >= from && at < to).map(([key]) => key);
  const createdSet = new Set(created);
  const accepts = board.actions.filter(action => action.kind === 'accept' && inWindow(action.at));
  const doneKeys = new Set(accepts.map(taskKey));

  // First reply: a person's message to the first message a Bot writes after it.
  const published = input.history.filter(event => event.operation === 'publish' && event.type === 'message').sort((left, right) => left.sequence - right.sequence);
  const replies: number[] = [];
  published.forEach((event, index) => {
    if (event.actorType !== 'principal' || !inWindow(event.createdAt)) return;
    const reply = published.slice(index + 1).find(next => next.actorType === 'agent');
    if (reply) replies.push(Date.parse(reply.createdAt) - Date.parse(event.createdAt));
  });

  const cycles = accepts.flatMap(action => { const start = firstCited.get(taskKey(action)); const end = time(action.at); return start !== undefined && end !== undefined ? [end - start] : []; });

  // Handoff depth: how many times a task created in the window changed hands.
  const depths = created.map(key => board.actions.filter(action => action.kind === 'transfer' && taskKey(action) === key).length);

  // Runs by task, and who ran them.
  const cardByKey = new Map(board.cards.map(card => [taskKey(card), card]));
  const runsByKey = new Map<string, AgentRun>();
  for (const card of board.cards) { const run = card.runId ? input.runs.get(card.runId) : undefined; if (run) runsByKey.set(taskKey(card), run); }

  const interventions = created.map(key => (runsByKey.get(key)?.events ?? []).filter(event => HUMAN_DECISIONS.has(event.type)).length);

  // Blocked time: a block to the next unblock, cancel or acceptance of the same task, or to the end of the window.
  const blocked: number[] = [];
  for (const block of board.actions.filter(action => action.kind === 'block' && inWindow(action.at))) {
    const start = time(block.at)!;
    const end = board.actions.find(action => taskKey(action) === taskKey(block) && ['unblock', 'cancel', 'accept'].includes(action.kind) && (time(action.at) ?? 0) >= start);
    blocked.push(Math.min(time(end?.at) ?? to, to) - start);
  }

  // Noise: messages Bots wrote in the window, per task created in it.
  const botMessages = published.filter(event => event.actorType === 'agent' && inWindow(event.createdAt)).length;

  // Parallel use: share of the window during which Runs of at least two different Bots were executing.
  const spans: Array<{ agent: string; start: number; end: number }> = [];
  for (const [key, run] of runsByKey) {
    const agent = cardByKey.get(key)?.ownerId; if (!agent) continue;
    const started = run.events.find(event => event.type === 'model.started' && event.data.phase === 'executor') ?? run.events.find(event => event.type === 'plan.approved');
    const start = time(started?.at); if (start === undefined) continue;
    // A Run still executing counts to the end of the window; one waiting on a person stopped at its last event.
    const end = time([...run.events].reverse().find(event => TERMINAL_RUN_EVENTS.has(event.type))?.at)
      ?? (EXECUTING.has(run.status) ? to : time(run.events.at(-1)?.at) ?? time(run.updatedAt) ?? to);
    const clipped = { agent, start: Math.max(start, from), end: Math.min(end, to) };
    if (clipped.end > clipped.start) spans.push(clipped);
  }
  const parallel = overlapOfDistinct(spans, 2);

  // Duplicate side effects: a completed tool call written twice with the same idempotency key and request.
  const seen = new Map<string, number>();
  for (const run of runsByKey.values()) for (const receipt of run.toolReceipts ?? []) {
    if (receipt.status !== 'completed' || !inWindow(receipt.completedAt ?? receipt.startedAt) || !receipt.authorization?.idempotencyKey) continue;
    const key = `${receipt.authorization.idempotencyKey}\0${receipt.requestHash}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicates = [...seen.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);

  // Handoff failure: offers in the window that ended without the other side taking the task.
  const offers = board.actions.filter(action => action.kind === 'offer' && inWindow(action.at));
  const failedOffers = offers.filter(offer => {
    const start = time(offer.at)!;
    const outcome = board.actions.find(action => taskKey(action) === taskKey(offer) && (action.kind === 'transfer' || action.kind === 'decline') && (time(action.at) ?? 0) >= start);
    return outcome?.kind === 'decline';
  });

  const ratio = (part: number, whole: number) => whole > 0 ? part / whole : undefined;
  const p50 = (values: number[]) => quantile(values, 0.5);
  const indicator = (key: IndicatorKey, unit: ChannelIndicator['unit'], value: number | undefined, samples: number, meets?: (value: number) => boolean, detail?: Record<string, number>): ChannelIndicator =>
    ({ key, unit, samples, ...(value === undefined ? {} : { value }), ...(value !== undefined && meets ? { ok: meets(value) } : {}), ...(detail ? { detail } : {}) });
  const intervened = interventions.filter(count => count > 0).length;
  const depthMax = depths.length ? Math.max(...depths) : undefined;
  const depthP50 = p50(depths);
  return {
    schemaVersion: 'channel-metrics/1', roomId: input.roomId, from: input.from, to: input.to,
    tasks: { created: created.length, done: doneKeys.size },
    indicators: [
      indicator('completion_rate', 'ratio', ratio([...doneKeys].filter(key => createdSet.has(key)).length, created.length), created.length),
      indicator('first_reply', 'ms', p50(replies), replies.length, value => value < 30_000),
      indicator('cycle_time', 'ms', p50(cycles), cycles.length),
      indicator('handoff_depth', 'count', depthP50, depths.length, value => value <= 2 && (depthMax ?? 0) <= 5, depthMax === undefined ? undefined : { max: depthMax }),
      indicator('parallel_use', 'ratio', to > from ? parallel / (to - from) : undefined, spans.length),
      indicator('interventions', 'count', ratio(interventions.reduce((total, count) => total + count, 0), created.length), created.length, value => value < 0.5),
      indicator('intervened_share', 'ratio', ratio(intervened, created.length), created.length, value => value < 0.5),
      indicator('blocked_time', 'ms', quantile(blocked, 0.9), blocked.length, value => value < 4 * HOUR),
      indicator('noise', 'count', ratio(botMessages, created.length), created.length, value => value < 6, { botMessages }),
      indicator('evidence_open_rate', 'ratio', ratio(input.ui['ui.evidence.open'], input.ui['ui.artifact.view']), input.ui['ui.artifact.view'], value => value > 0.3, { views: input.ui['ui.artifact.view'], opens: input.ui['ui.evidence.open'] }),
      indicator('duplicate_effects', 'count', duplicates, seen.size, value => value === 0),
      indicator('handoff_failure_rate', 'ratio', ratio(failedOffers.length, offers.length), offers.length, value => value < 0.05),
    ],
  };
}

/** Total time during which spans of at least `minimum` distinct agents overlap. */
function overlapOfDistinct(spans: ReadonlyArray<{ agent: string; start: number; end: number }>, minimum: number): number {
  const points = [...new Set(spans.flatMap(span => [span.start, span.end]))].sort((left, right) => left - right);
  let total = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index]!, end = points[index + 1]!;
    const agents = new Set(spans.filter(span => span.start <= start && span.end >= end).map(span => span.agent));
    if (agents.size >= minimum) total += end - start;
  }
  return total;
}
