import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { LocalDispatcher, notifyRecoverableRuns, notifyTemporalRunWorkflow, TemporalDispatcher } from '../src/runtime/dispatcher.js';
import type { AgentEngine } from '../src/runtime/engine.js';

function fakeClient(signal: (attempt: number) => Promise<void>, start: () => Promise<void>) {
  let attempts = 0;
  return {
    workflow: {
      getHandle: vi.fn(() => ({ signal: vi.fn(async () => signal(++attempts)) })),
      start: vi.fn(start),
    },
  };
}

describe('Temporal run dispatcher wake/start boundary', () => {
  it('signals an existing workflow without starting another one', async () => {
    const start = vi.fn(async () => undefined);
    const client = fakeClient(async () => undefined, start);
    await notifyTemporalRunWorkflow(client, 'queue', 'run-1');
    expect(client.workflow.getHandle).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('starts a missing workflow', async () => {
    const client = fakeClient(
      async () => { throw new WorkflowNotFoundError('missing', 'run-2', undefined); },
      async () => undefined,
    );
    await notifyTemporalRunWorkflow(client, 'queue', 'run-2');
    expect(client.workflow.start).toHaveBeenCalledWith('agentRunWorkflow', { taskQueue: 'queue', workflowId: 'run-2', args: ['run-2'] });
  });

  it('signals again when another process wins the start race', async () => {
    const signal = vi.fn()
      .mockRejectedValueOnce(new WorkflowNotFoundError('missing', 'run-3', undefined))
      .mockResolvedValueOnce(undefined);
    const start = vi.fn(async () => { throw new WorkflowExecutionAlreadyStartedError('started', 'run-3', 'agentRunWorkflow'); });
    const client = { workflow: { getHandle: vi.fn(() => ({ signal })), start } };
    await notifyTemporalRunWorkflow(client, 'queue', 'run-3');
    expect(signal).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not turn a completed workflow race into a dispatch failure', async () => {
    const signal = vi.fn()
      .mockRejectedValueOnce(new WorkflowNotFoundError('missing', 'run-4', undefined))
      .mockRejectedValueOnce(new WorkflowNotFoundError('completed', 'run-4', undefined));
    const client = {
      workflow: {
        getHandle: vi.fn(() => ({ signal })),
        start: vi.fn(async () => { throw new WorkflowExecutionAlreadyStartedError('started', 'run-4', 'agentRunWorkflow'); }),
      },
    };
    await expect(notifyTemporalRunWorkflow(client, 'queue', 'run-4')).resolves.toBeUndefined();
  });
});

describe('Temporal run cancellation and description', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  function fixture() {
    const handle = {
      describe: vi.fn(async () => ({ status: { name: 'RUNNING' } })),
      cancel: vi.fn(async () => undefined), terminate: vi.fn(async () => undefined),
    };
    const client = {
      workflow: { getHandle: vi.fn(() => handle) },
      withDeadline: vi.fn(async (_deadline: number, operation: () => Promise<unknown>) => operation()),
    };
    const dispatcher = Reflect.construct(TemporalDispatcher, [client, { close: vi.fn() }, 'queue']) as TemporalDispatcher;
    return { handle, client, dispatcher };
  }
  it('falls back to terminate after the configured cancellation timeout', async () => {
    vi.useFakeTimers(); vi.stubEnv('AEEIS_RUN_CANCEL_TIMEOUT_MS', '50');
    const { handle, client, dispatcher } = fixture();
    const cancellation = dispatcher.cancel('run-1', 'SRE requested cancellation');
    await vi.advanceTimersByTimeAsync(49);
    expect(handle.cancel).toHaveBeenCalledOnce();
    expect(handle.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(cancellation).resolves.toEqual({ outcome: 'terminated' });
    expect(handle.terminate).toHaveBeenCalledWith('SRE requested cancellation');
    expect(client.workflow.getHandle).toHaveBeenCalledWith('run-1');
  });
  it('waits for cancellation to close without terminating', async () => {
    const { handle, dispatcher } = fixture();
    handle.describe.mockResolvedValueOnce({ status: { name: 'RUNNING' } }).mockResolvedValue({ status: { name: 'CANCELLED' } });
    await expect(dispatcher.cancel('run-2')).resolves.toEqual({ outcome: 'cancelled' });
    expect(handle.terminate).not.toHaveBeenCalled();
  });
  it('follows continued-as-new executions while waiting for cancellation', async () => {
    vi.useFakeTimers();
    const { handle, client, dispatcher } = fixture();
    handle.describe.mockResolvedValueOnce({ status: { name: 'RUNNING' } })
      .mockResolvedValueOnce({ status: { name: 'CONTINUED_AS_NEW' } })
      .mockResolvedValueOnce({ status: { name: 'RUNNING' } })
      .mockResolvedValue({ status: { name: 'CANCELLED' } });
    const cancellation = dispatcher.cancel('run-chain');
    await vi.advanceTimersByTimeAsync(200);
    await expect(cancellation).resolves.toEqual({ outcome: 'cancelled' });
    expect(client.workflow.getHandle).toHaveBeenCalledWith('run-chain');
    expect(handle.terminate).not.toHaveBeenCalled();
  });
  it('uses the default 10 second timeout', async () => {
    vi.useFakeTimers(); vi.stubEnv('AEEIS_RUN_CANCEL_TIMEOUT_MS', undefined);
    const { handle, dispatcher } = fixture();
    const cancellation = dispatcher.cancel('run-3');
    await vi.advanceTimersByTimeAsync(9999);
    expect(handle.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(cancellation).resolves.toEqual({ outcome: 'terminated' });
  });
  it.each(['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT'])('accepts an already closed %s workflow', async name => {
    const { handle, dispatcher } = fixture(); handle.describe.mockResolvedValue({ status: { name } });
    await expect(dispatcher.cancel('run-closed')).resolves.toEqual({ outcome: 'already_closed' });
    expect(handle.cancel).not.toHaveBeenCalled();
    expect(handle.terminate).not.toHaveBeenCalled();
  });
  it('accepts a missing workflow or a close racing with cancellation', async () => {
    const { handle, dispatcher } = fixture();
    handle.describe.mockRejectedValueOnce(new WorkflowNotFoundError('missing', 'run-4', undefined));
    await expect(dispatcher.cancel('run-4')).resolves.toEqual({ outcome: 'not_found' });
    handle.cancel.mockRejectedValueOnce(new WorkflowNotFoundError('already completed', 'run-4', undefined));
    await expect(dispatcher.cancel('run-4')).resolves.toEqual({ outcome: 'not_found' });
  });
  it.each(['describe', 'cancel'] as const)('terminates when the initial %s RPC exceeds the deadline', async operation => {
    const { handle, dispatcher } = fixture();
    const deadline = Object.assign(new Error('deadline exceeded'), { code: 4, details: 'deadline exceeded', metadata: {} });
    handle[operation].mockRejectedValueOnce(new Error('RPC failed', { cause: deadline }));
    await expect(dispatcher.cancel('run-timeout', 'stop')).resolves.toEqual({ outcome: 'terminated' });
    expect(handle.terminate).toHaveBeenCalledWith('stop');
  });
  it('propagates infrastructure errors', async () => {
    const { handle, dispatcher } = fixture(); handle.cancel.mockRejectedValue(new Error('unavailable'));
    await expect(dispatcher.cancel('run-5')).rejects.toThrow('unavailable');
    expect(handle.terminate).not.toHaveBeenCalled();
  });
  it('describes the latest execution and normalizes SDK cancellation spelling', async () => {
    const { handle, client, dispatcher } = fixture();
    handle.describe.mockResolvedValue({ status: { name: 'CANCELLED' } });
    await expect(dispatcher.describe('run-6')).resolves.toEqual({ status: 'CANCELED' });
    expect(client.workflow.getHandle).toHaveBeenCalledWith('run-6');
    handle.describe.mockRejectedValue(new WorkflowNotFoundError('missing', 'run-6', undefined));
    await expect(dispatcher.describe('run-6')).resolves.toEqual({ status: 'NOT_FOUND' });
  });
});

describe('local dispatcher yield and rank', () => {
  function driver(advance: (id: string) => Promise<string>) {
    return new LocalDispatcher({ advance } as unknown as AgentEngine);
  }
  it('returns from notify while one step is still in flight and lets another run advance', async () => {
    let release: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen: string[] = [];
    const dispatcher = driver(async id => {
      seen.push(`start:${id}`);
      if (id === 'compact') await gate;
      seen.push(`end:${id}`);
      return 'needs_approval';
    });
    const pending = dispatcher.notify('compact');
    await pending;
    expect(seen).toEqual(['start:compact']);
    await dispatcher.notify('other');
    expect(seen).toEqual(['start:compact', 'start:other', 'end:other']);
    release!();
    await dispatcher.close();
    expect(seen).toEqual(['start:compact', 'start:other', 'end:other', 'end:compact']);
  });
  it('starts the higher rank first after both steps yield, without serializing the in-flight calls', async () => {
    let release: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const counts = new Map<string, number>();
    const dispatcher = driver(async id => {
      const step = (counts.get(id) ?? 0) + 1;
      counts.set(id, step);
      order.push(`${id}:${step}`);
      if (step === 1) await gate;
      return step === 1 ? 'running' : 'needs_approval';
    });
    dispatcher.setSchedulingRank('low', 2);
    dispatcher.setSchedulingRank('high', 1);
    await Promise.all([dispatcher.notify('low'), dispatcher.notify('high')]);
    expect(order).toEqual(['high:1', 'low:1']);
    release!();
    await vi.waitFor(() => expect(order).toEqual(['high:1', 'low:1', 'high:2', 'low:2']));
    await dispatcher.close();
  });
  it('keeps an unranked run behind a ranked one and does not advance when only the rank changes', async () => {
    const order: string[] = [];
    const dispatcher = driver(async id => {
      order.push(id);
      return 'needs_approval';
    });
    dispatcher.setSchedulingRank('ranked', 4);
    expect(order).toEqual([]);
    await notifyRecoverableRuns(dispatcher, [
      { id: 'plain', status: 'running' },
      { id: 'ranked', status: 'planning', schedulingPriority: 4 },
      { id: 'done', status: 'succeeded', schedulingPriority: 1 },
    ]);
    await dispatcher.close();
    expect(order).toEqual(['ranked', 'plain']);
  });
  it('does not take the next step after close', async () => {
    let release: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const dispatcher = driver(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return 'running';
    });
    await dispatcher.notify('run');
    expect(calls).toBe(1);
    const closed = dispatcher.close();
    release!();
    await closed;
    expect(calls).toBe(1);
  });
});
