import { describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { notifyTemporalRunWorkflow } from '../src/runtime/dispatcher.js';

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
