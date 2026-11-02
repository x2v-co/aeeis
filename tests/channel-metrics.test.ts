import { describe, expect, it } from 'vitest';
import { channelMetrics, quantile } from '../src/channel-metrics.js';
import { emptyUiEventCounts, InMemoryUiEventCountStore, JsonUiEventCountStore } from '../src/ui-event-counts.js';
import type { ChannelBoard, BoardActionMark, BoardCard, BoardCitation } from '../src/channel-task-action.js';
import type { AgentRun } from '../src/runtime/contracts.js';
import type { SessionEvent } from '../src/session-events.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const day = '2026-11-02';
const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 10, 2, hour, minute)).toISOString();
const cite = (taskId: string, hour: number): BoardCitation => ({ eventId: `evt_${taskId}`, conversationId: 'conv_a', taskId, actorId: 'owner', actorType: 'principal', at: at(hour), content: '' });
const mark = (kind: BoardActionMark['kind'], taskId: string, hour: number, minute = 0, agentId?: string): BoardActionMark => ({ eventId: `evt_${kind}_${taskId}_${hour}_${minute}`, kind, conversationId: 'conv_a', taskId, at: at(hour, minute), ...(agentId ? { agentId } : {}) });
const card = (taskId: string, ownerId: string, runId?: string): BoardCard => ({ conversationId: 'conv_a', taskId, ownerId, status: 'running', column: 'doing', chain: [], decision: { conflicts: [], accepted: false, cancelled: false, released: false, handedUp: false, lines: [] }, ...(runId ? { runId } : {}) });
const message = (sequence: number, actorType: 'principal' | 'agent', hour: number, minute: number): SessionEvent => ({ id: `evt_m${sequence}`, sequence, type: 'message', actorType, actorId: actorType === 'agent' ? 'aeeis' : 'owner', operation: 'publish', createdAt: at(hour, minute) } as SessionEvent);
const run = (id: string, start: number, end: number, events: Array<{ type: string; hour: number }> = []): AgentRun => ({
  id, status: 'succeeded', updatedAt: at(end), toolReceipts: [],
  events: [{ id: 'e0', seq: 0, type: 'model.started', at: at(start), data: { phase: 'executor' } }, ...events.map((event, index) => ({ id: `e${index + 1}`, seq: index + 1, type: event.type, at: at(event.hour), data: {} })), { id: 'end', seq: 99, type: 'review.completed', at: at(end), data: {} }],
} as unknown as AgentRun);

describe('channel metrics', () => {
  it('reads the §18.1 indicators from the board, the room and the Runs', () => {
    const board = {
      schemaVersion: 'channel-board/1', roomId: 'room_a', cursor: 1, wip: [],
      cards: [card('task_a', 'bot_one', 'run_a'), card('task_b', 'bot_two', 'run_b'), card('task_c', 'bot_one')],
      citations: [cite('task_a', 1), cite('task_b', 2), cite('task_c', 3), cite('task_a', 5)],
      actions: [
        mark('offer', 'task_a', 2, 0, 'bot_two'), mark('transfer', 'task_a', 2, 30, 'bot_two'),
        mark('offer', 'task_c', 3, 0, 'bot_two'), mark('decline', 'task_c', 3, 10, 'bot_two'),
        mark('block', 'task_b', 4), mark('unblock', 'task_b', 6),
        mark('accept', 'task_a', 9),
      ],
    } as unknown as ChannelBoard;
    const runA = run('run_a', 2, 6, [{ type: 'plan.approved', hour: 2 }, { type: 'input.received', hour: 3 }]);
    (runA as { toolReceipts: unknown[] }).toolReceipts = [1, 2].map(() => ({ status: 'completed', startedAt: at(4), completedAt: at(4), requestHash: 'h', authorization: { idempotencyKey: 'k' } }));
    const waiting = run('run_c', 5, 5);
    Object.assign(waiting, { status: 'needs_input', events: waiting.events.filter(event => event.type !== 'review.completed') });
    board.cards.push(card('task_d', 'bot_three', 'run_c'));
    const runs = new Map([['run_a', runA], ['run_b', run('run_b', 4, 8)], ['run_c', waiting]]);
    const history = [message(1, 'principal', 1, 0), message(2, 'agent', 1, 0), message(3, 'agent', 1, 1), message(4, 'principal', 2, 0), message(5, 'agent', 2, 1)];
    (history[1] as { createdAt: string }).createdAt = new Date(Date.parse(at(1)) + 10_000).toISOString();
    const ui = { ...emptyUiEventCounts(), 'ui.artifact.view': 4, 'ui.evidence.open': 1 };
    const result = channelMetrics({ roomId: 'room_a', from: at(0), to: at(10), history, board, runs, ui });
    const of = (key: string) => result.indicators.find(item => item.key === key)!;
    expect(result.tasks).toEqual({ created: 3, done: 1 });
    expect(of('completion_rate').value).toBeCloseTo(1 / 3);
    // Replies after 10 s and after 60 s; the median of two is the lower one.
    expect(of('first_reply')).toMatchObject({ value: 10_000, samples: 2, ok: true });
    expect(of('cycle_time')).toMatchObject({ value: 8 * 3_600_000, samples: 1 });
    expect(of('handoff_depth')).toMatchObject({ value: 0, detail: { max: 1 }, ok: true });
    // Two different Bots run at the same time from 4:00 to 6:00: 2 of 10 hours. A Run waiting on a person since 5:00 adds nothing.
    expect(of('parallel_use')).toMatchObject({ value: 0.2, samples: 2 });
    expect(of('interventions')).toMatchObject({ value: 2 / 3, ok: false });
    expect(of('intervened_share')).toMatchObject({ value: 1 / 3, ok: true });
    expect(of('blocked_time')).toMatchObject({ value: 2 * 3_600_000, ok: true });
    expect(of('noise')).toMatchObject({ value: 1, detail: { botMessages: 3 } });
    expect(of('evidence_open_rate')).toMatchObject({ value: 0.25, ok: false });
    expect(of('duplicate_effects')).toMatchObject({ value: 1, ok: false });
    expect(of('handoff_failure_rate')).toMatchObject({ value: 0.5, samples: 2, ok: false });
  });

  it('leaves an indicator empty when the window has nothing to measure', () => {
    const board = { schemaVersion: 'channel-board/1', roomId: 'room_a', cursor: 0, wip: [], cards: [], citations: [], actions: [] } as unknown as ChannelBoard;
    const result = channelMetrics({ roomId: 'room_a', from: at(0), to: at(10), history: [], board, runs: new Map(), ui: emptyUiEventCounts() });
    expect(result.indicators.filter(item => item.value !== undefined).map(item => item.key)).toEqual(['parallel_use', 'duplicate_effects']);
    expect(result.indicators.find(item => item.key === 'first_reply')).toEqual({ key: 'first_reply', unit: 'ms', samples: 0 });
  });

  it('takes the nearest-rank quantile', () => {
    expect(quantile([], 0.5)).toBeUndefined();
    expect(quantile([5, 1, 3], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});

describe('ui event counts', () => {
  it('counts per owner, room and day, and keeps nothing else', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-ui-events-'));
    for (const store of [new InMemoryUiEventCountStore(), new JsonUiEventCountStore(join(directory, 'ui-event-counts.json'))]) {
      const alice = { owner: 'alice', tenantId: 'local' };
      await store.record(alice, { name: 'ui.artifact.view', roomId: 'room_a' }, `${day}T01:00:00.000Z`);
      await store.record(alice, { name: 'ui.artifact.view', roomId: 'room_a' }, `${day}T02:00:00.000Z`);
      await store.record(alice, { name: 'ui.artifact.view', roomId: 'room_a' }, '2026-10-20T02:00:00.000Z');
      await store.record(alice, { name: 'ui.evidence.open', roomId: 'room_b' }, `${day}T02:00:00.000Z`);
      await store.record({ owner: 'bob', tenantId: 'local' }, { name: 'ui.artifact.view', roomId: 'room_a' }, `${day}T02:00:00.000Z`);
      await expect(store.record(alice, { name: 'ui.artifact.view', roomId: 'room_a', content: 'x' } as never)).rejects.toThrow();
      const counts = await store.counts(alice, 'room_a', '2026-10-27', day);
      expect(counts['ui.artifact.view']).toBe(2);
      expect(counts['ui.evidence.open']).toBe(0);
    }
    const reopened = new JsonUiEventCountStore(join(directory, 'ui-event-counts.json'));
    expect((await reopened.counts({ owner: 'alice', tenantId: 'local' }, 'room_a', '2026-10-01', day))['ui.artifact.view']).toBe(3);
  });
});
