import { condition, continueAsNew, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { AdvanceRunActivityResult } from './activity.js';

const { advanceRun } = proxyActivities<{ advanceRun(id: string): Promise<AdvanceRunActivityResult> }>({
  startToCloseTimeout: '2 minutes', scheduleToCloseTimeout: '3 minutes',
  // Unknown outcomes are reconciled by the domain, not blindly retried by the execution engine.
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 5, nonRetryableErrorTypes: ['AeeisPermanentError', 'AeeisProtocolError'] },
});
export async function agentRunWorkflow(runId: string): Promise<void> {
  let wake = false;
  setHandler(defineSignal('wake'), () => { wake = true; });
  for (let ticks = 0; ticks < 100; ticks++) {
    wake = false;
    let status: string;
    try { status = (await advanceRun(runId)).status; }
    catch (error) {
      // Permanent auth/config/protocol failures wait for an explicit wake after
      // operator correction. Transport failures get a durable timer retry.
      await condition(() => wake, hasNonRetryableCause(error) ? undefined : '30 seconds');
      continue;
    }
    if (['succeeded', 'cancelled'].includes(status)) return;
    if (!['queued', 'planning', 'running', 'reviewing'].includes(status)) {
      await condition(() => wake, '30 seconds');
    }
  }
  await continueAsNew<typeof agentRunWorkflow>(runId);
}

function hasNonRetryableCause(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth++) {
    if (!current || typeof current !== 'object') return false;
    const candidate = current as { nonRetryable?: unknown; cause?: unknown };
    if (candidate.nonRetryable === true) return true;
    current = candidate.cause;
  }
  return false;
}
