import { expect, it, vi } from 'vitest';
import { reconcileWorkflows } from '../src/temporal/reconcile.js';

async function* executions() {
  for (const status of ['succeeded', 'failed', 'cancelled', 'unknown', 'needs_input', 'running']) {
    yield { workflowId: status, runId: `execution-${status}`, type: 'agentRunWorkflow' };
  }
  yield { workflowId: 'reminder', runId: 'timer', type: 'reminderWorkflow' };
}

it('defaults to dry-run and leaves unknown, actionable Runs and reminders alone', async () => {
  const terminate = vi.fn(); const log = vi.fn(); const readStatus = vi.fn(async id => id);
  await reconcileWorkflows({ executions: executions(), readStatus, terminate, log });
  expect(terminate).not.toHaveBeenCalled();
  expect(log.mock.calls.filter(([record]) => record.action === 'would-terminate')).toHaveLength(3);
  expect(readStatus).not.toHaveBeenCalledWith('reminder');
});

it('applies only to exact executions whose app status is still terminal', async () => {
  const terminate = vi.fn();
  await reconcileWorkflows({ executions: executions(), readStatus: async id => id, terminate, apply: true, log: vi.fn() });
  expect(terminate.mock.calls.map(([record]) => record.workflowId)).toEqual(['succeeded', 'failed', 'cancelled']);
  expect(terminate.mock.calls[1]?.[0].runId).toBe('execution-failed');
});

it('rechecks status before apply and preserves a retried Run', async () => {
  const terminate = vi.fn(); let calls = 0;
  async function* one() { yield { workflowId: 'run', runId: 'old', type: 'agentRunWorkflow' }; }
  await reconcileWorkflows({ executions: one(), readStatus: async () => ++calls === 1 ? 'failed' : 'queued', terminate, apply: true, log: vi.fn() });
  expect(calls).toBe(2);
  expect(terminate).not.toHaveBeenCalled();
});

it('fails closed on status lookup or termination errors', async () => {
  const terminate = vi.fn();
  await expect(reconcileWorkflows({ executions: executions(), readStatus: async () => { throw new Error('HTTP 401'); }, terminate, apply: true, log: vi.fn() })).rejects.toThrow('HTTP 401');
  expect(terminate).not.toHaveBeenCalled();
  await expect(reconcileWorkflows({ executions: executions(), readStatus: async id => id, terminate: async () => { throw new Error('unreachable'); }, apply: true, log: vi.fn() })).rejects.toThrow('unreachable');
});


it('reports executions that closed during apply without claiming termination', async () => {
  const log = vi.fn();
  await reconcileWorkflows({ executions: executions(), readStatus: async id => id, terminate: async () => false, apply: true, log });
  expect(log.mock.calls.filter(([record]) => record.action === 'already-closed')).toHaveLength(3);
  expect(log.mock.calls.some(([record]) => record.action === 'terminated')).toBe(false);
});
