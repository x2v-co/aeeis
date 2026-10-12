import { describe, expect, it } from 'vitest';
import { NON_TERMINAL_RUN_STATUSES, planRunReconcile } from '../src/runtime/run-reconcile.js';
import type { WorkflowStatus } from '../src/runtime/dispatcher.js';

const matrix: [WorkflowStatus, 'none' | 'cancel' | 'fail'][] = [
  ['RUNNING', 'none'], ['CONTINUED_AS_NEW', 'none'], ['TERMINATED', 'cancel'], ['CANCELED', 'cancel'],
  ['FAILED', 'fail'], ['TIMED_OUT', 'fail'], ['NOT_FOUND', 'fail'], ['COMPLETED', 'fail'],
];
describe('planRunReconcile', () => {
  for (const status of NON_TERMINAL_RUN_STATUSES) {
    it.each(matrix)(`${status} with %s plans %s`, (workflowStatus, action) => {
      const run = { status };
      expect(planRunReconcile(run, workflowStatus)).toEqual({ action, reason: expect.any(String) });
      expect(run).toEqual({ status });
    });
  }
  for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
    it.each(matrix)(`never changes terminal ${status} with %s`, workflowStatus => {
      expect(planRunReconcile({ status }, workflowStatus).action).toBe('none');
    });
  }
  it('explains an unexpectedly completed workflow', () => {
    expect(planRunReconcile({ status: 'unknown' }, 'COMPLETED')).toEqual({ action: 'fail', reason: 'workflow completed while run non-terminal' });
  });
});
