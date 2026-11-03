import { describe, expect, it } from 'vitest';
import { channelDigestCost, taskTimeline } from '../src/channel-digest.js';
import type { BoardActionMark, BoardCard, BoardCitation, ChannelBoard } from '../src/channel-task-action.js';
import type { AgentRun } from '../src/runtime/contracts.js';

const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 10, 2, hour, minute)).toISOString();
const card = (taskId: string, ownerId: string, runId?: string): BoardCard => ({ conversationId: 'conv_a', taskId, ownerId, status: 'running', column: 'doing', chain: [], decision: { conflicts: [], accepted: false, cancelled: false, released: false, handedUp: false, lines: [] }, ...(runId ? { runId } : {}) });
const cite = (taskId: string, hour: number, extra: Partial<BoardCitation> = {}): BoardCitation => ({ eventId: `evt_${taskId}_${hour}`, conversationId: 'conv_a', taskId, actorId: 'owner', actorType: 'principal', at: at(hour), content: '', ...extra });
const mark = (kind: BoardActionMark['kind'], taskId: string, hour: number, extra: Partial<BoardActionMark> = {}): BoardActionMark => ({ eventId: `evt_${kind}_${taskId}_${hour}`, kind, conversationId: 'conv_a', taskId, at: at(hour), ...extra });
const call = (hour: number, tokens?: number) => ({ id: `call_${hour}`, phase: 'executor', state: 'completed', inputHash: 'h', startedAt: at(hour), ...(tokens === undefined ? {} : { usage: { inputTokens: tokens / 2, outputTokens: tokens / 2 } }) });

describe('channel digest cost', () => {
  it('counts Run time inside the window, tokens of calls started in it, a share of priced money and tool credits', () => {
    const board = {
      schemaVersion: 'channel-board/1', roomId: 'room_a', cursor: 1, wip: [],
      cards: [card('task_a', 'bot_one', 'run_a'), card('task_b', 'bot_two', 'run_b')],
      citations: [cite('task_a', 1), cite('task_b', 2)],
      actions: [mark('accept', 'task_a', 7)],
    } as unknown as ChannelBoard;
    const runA = {
      id: 'run_a', status: 'succeeded', updatedAt: at(5), createdAt: at(1),
      events: [{ id: 'e1', seq: 1, type: 'model.started', at: at(2), data: { phase: 'executor' } }, { id: 'e2', seq: 2, type: 'review.completed', at: at(5), data: {} }],
      // 1000 tokens before the window, 3000 inside it; one call reported nothing.
      calls: [call(1, 1000), call(3, 3000), call(4)],
      modelUsage: { tokens: 4000, moneyUsd: 0.8, unreportedCalls: 1 },
      toolReceipts: [{ status: 'completed', startedAt: at(3), completedAt: at(3), cost: { credits: 5 } }, { status: 'failed', startedAt: at(3), cost: { credits: 9 } }],
    } as unknown as AgentRun;
    const runB = {
      id: 'run_b', status: 'needs_input', updatedAt: at(4), createdAt: at(2),
      events: [{ id: 'e1', seq: 1, type: 'plan.approved', at: at(3), data: {} }, { id: 'e2', seq: 2, type: 'input.requested', at: at(4), data: {} }],
      calls: [call(3, 500)], toolReceipts: [],
    } as unknown as AgentRun;
    const result = channelDigestCost({ from: at(2, 30), to: at(10), board, runs: new Map([['run_a', runA], ['run_b', runB]]) });
    // run_a executes 2:30–5:00 inside the window, run_b 3:00–4:00 and then waits on a person.
    expect(result).toEqual({ from: at(2, 30), to: at(10), runs: 2, runTimeMs: 3.5 * 3_600_000, cycleMs: 6 * 3_600_000, accepted: 1, tokens: 3500, moneyUsd: 0.6, credits: 5, unreportedCalls: 1 });
  });

  it('leaves money out when no Run was priced', () => {
    const board = { schemaVersion: 'channel-board/1', roomId: 'room_a', cursor: 0, wip: [], cards: [], citations: [], actions: [] } as unknown as ChannelBoard;
    expect(channelDigestCost({ from: at(0), to: at(1), board, runs: new Map() })).toEqual({ from: at(0), to: at(1), runs: 0, runTimeMs: 0, accepted: 0, tokens: 0, credits: 0, unreportedCalls: 0 });
  });
});

describe('task timeline', () => {
  it('tells one task from the request to delivery, with who did each thing', () => {
    const board = {
      schemaVersion: 'channel-board/1', roomId: 'room_a', cursor: 1, wip: [],
      cards: [card('task_a', 'bot_two', 'run_a'), card('task_other', 'bot_one')],
      citations: [
        cite('task_a', 1, { content: 'AEEIS提议由阿研做：写上线说明', automatic: true }),
        cite('task_other', 1, { content: '别的事' }),
      ],
      actions: [
        mark('offer', 'task_a', 2, { agentId: 'bot_two', automatic: true }),
        mark('transfer', 'task_a', 3, { agentId: 'bot_two', automatic: true }),
        mark('accept', 'task_a', 9),
      ],
    } as unknown as ChannelBoard;
    const run = {
      id: 'run_a', status: 'succeeded', updatedAt: at(8), createdAt: at(4),
      plans: [{ version: 1, hash: 'h', summary: '先查再写', nodes: [{ id: 'draft', title: '起草', instruction: '', dependsOn: [] }] }],
      answers: [{ taskId: 'draft', question: '哪一版？', answer: '0.9' }],
      events: [
        { id: 'e1', seq: 1, type: 'run.created', at: at(4), data: {} },
        { id: 'e2', seq: 2, type: 'plan.approval_requested', at: at(4, 10), data: {} },
        { id: 'e3', seq: 3, type: 'plan.approved', at: at(5), data: {} },
        { id: 'e4', seq: 4, type: 'input.requested', at: at(6), data: { taskId: 'draft' } },
        { id: 'e5', seq: 5, type: 'input.received', at: at(6, 30), data: {} },
        { id: 'e6', seq: 6, type: 'artifact.created', at: at(7), data: { taskId: 'draft' } },
        { id: 'e7', seq: 7, type: 'model.started', at: at(7, 5), data: { phase: 'reviewer' } },
        { id: 'e8', seq: 8, type: 'review.completed', at: at(8), data: { verdict: 'accepted' } },
      ],
    } as unknown as AgentRun;
    const names: Record<string, string> = { bot_two: '阿写', bot_one: '阿研' };
    const entries = taskTimeline({ board, conversationId: 'conv_a', taskId: 'task_a', run, nameOf: id => names[id] ?? id });
    expect(entries.map(entry => `${entry.who}：${entry.text}${entry.human ? '（人）' : ''}`)).toEqual([
      '自动记录：AEEIS提议由阿研做：写上线说明',
      '自动记录：交接中：交给 阿写',
      '自动记录：转交给 阿写',
      '阿写：开了一件 Run',
      '阿写：计划等批准：先查再写',
      '你：批准了计划（人）',
      '阿写：提问：哪一版？',
      '你：回答：0.9（人）',
      '阿写：做完「起草」',
      '阿写：独立审核通过',
      '你：验收通过（人）',
    ]);
    expect(entries.every(entry => !entry.text.includes('别的事'))).toBe(true);
  });

  it('keeps the room\'s own order for records written in the same millisecond', () => {
    const board = {
      schemaVersion: 'channel-board/1', roomId: 'room_a', cursor: 3, wip: [], cards: [card('task_a', 'bot_two')],
      citations: [cite('task_a', 3, { content: '阿写接下了', automatic: true, sequence: 3 })],
      actions: [mark('transfer', 'task_a', 3, { agentId: 'bot_two', automatic: true, sequence: 2 })],
    } as unknown as ChannelBoard;
    expect(taskTimeline({ board, conversationId: 'conv_a', taskId: 'task_a', nameOf: () => '阿写' }).map(entry => entry.text)).toEqual(['转交给 阿写', '阿写接下了']);
  });

  it('shows what the person did in the Bot workspace during a takeover', () => {
    const board = { schemaVersion: 'channel-board/1', roomId: 'room_a', cursor: 0, wip: [], cards: [card('task_a', 'bot_two', 'run_a')], citations: [], actions: [] } as unknown as ChannelBoard;
    const run = { id: 'run_a', status: 'paused', plans: [], answers: [], events: [
      { id: 'e1', seq: 1, type: 'run.taken_over', at: at(1), data: {} },
      { id: 'e2', seq: 2, type: 'takeover.tool', at: at(2), data: { toolId: 'shell', summary: 'npm test', status: 'completed' } },
    ] } as unknown as AgentRun;
    expect(taskTimeline({ board, conversationId: 'conv_a', taskId: 'task_a', run, nameOf: () => '阿写' }).map(entry => `${entry.who}：${entry.text}`)).toEqual(['你：接手做了一段', '你：在 Bot 的工作区里用 shell：npm test']);
  });

  it('keeps only the room part when the reader cannot open the Run', () => {
    const board = { schemaVersion: 'channel-board/1', roomId: 'room_a', cursor: 1, wip: [], cards: [card('task_a', 'bot_two', 'run_a')], citations: [cite('task_a', 1, { content: '已交给阿写' })], actions: [] } as unknown as ChannelBoard;
    expect(taskTimeline({ board, conversationId: 'conv_a', taskId: 'task_a', nameOf: id => id })).toEqual([{ at: at(1), who: '你', text: '已交给阿写', source: 'room', human: true }]);
  });
});
