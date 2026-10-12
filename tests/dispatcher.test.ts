import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { notifyTemporalRunWorkflow, TemporalDispatcher } from '../src/runtime/dispatcher.js';

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
