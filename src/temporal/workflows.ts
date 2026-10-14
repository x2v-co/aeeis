import { ApplicationFailure, condition, continueAsNew, defineSignal, patched, proxyActivities, setHandler } from '@temporalio/workflow';
import type { AdvanceReminderActivityResult, AdvanceRunActivityResult } from './activity.js';
import { decideRunAdvance } from './run-advance.js';

const retry = {
  initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 5,
  nonRetryableErrorTypes: ['AeeisPermanentError', 'AeeisProtocolError'],
};
const { advanceRun } = proxyActivities<{
  advanceRun(id: string): Promise<AdvanceRunActivityResult>;
}>({
  // Legacy command options retained for histories before the long-model patch.
  startToCloseTimeout: '25 minutes', scheduleToCloseTimeout: '2 hours', retry,
});
const { advanceReminder } = proxyActivities<{
  advanceReminder(id: string): Promise<AdvanceReminderActivityResult>;
}>({ startToCloseTimeout: '2 minutes', scheduleToCloseTimeout: '3 minutes', retry });
const { advanceRun: advanceRunPolling } = proxyActivities<{ advanceRun(id: string): Promise<AdvanceRunActivityResult> }>({
  startToCloseTimeout: '25 minutes', scheduleToCloseTimeout: '2 hours', heartbeatTimeout: '45 seconds', retry,
});
const { advanceRun: advanceRunLong } = proxyActivities<{ advanceRun(id: string): Promise<AdvanceRunActivityResult> }>({
  // One tick can include first-byte retries and a completed length retry.
  startToCloseTimeout: '65 minutes', scheduleToCloseTimeout: '2 hours', heartbeatTimeout: '45 seconds', retry,
});
const { terminalizeRun } = proxyActivities<{ terminalizeRun(id: string, reason: string): Promise<AdvanceRunActivityResult> }>({
  startToCloseTimeout: '30 seconds', scheduleToCloseTimeout: '2 minutes', retry: { ...retry, maximumAttempts: 3 },
});
async function closeUnknownRun(runId: string, reason: string): Promise<boolean> {
  let result: AdvanceRunActivityResult;
  try {
    result = await terminalizeRun(runId, reason);
  } catch { throw ApplicationFailure.nonRetryable('Run could not be terminalized after bounded activity retries', 'AeeisRunTimeout'); }
  if (result.status === 'failed') throw ApplicationFailure.nonRetryable(reason, 'AeeisRunFailed');
  if (['succeeded', 'cancelled'].includes(result.status)) return true;
  // A business wait may win the race with terminalization; keep its workflow alive.
  if (['needs_approval', 'needs_input', 'paused', 'waiting_external'].includes(result.status)) return false;
  throw ApplicationFailure.nonRetryable('Run could not be terminalized after bounded activity retries', 'AeeisRunTimeout');
}
export async function agentRunWorkflow(runId: string, pollState?: { previousProgress?: string; stalled: number }): Promise<void> {
  let wake = false;
  let previousProgress = pollState?.previousProgress;
  let stalled = pollState?.stalled ?? 0;
  setHandler(defineSignal('wake'), () => { wake = true; });
  for (let ticks = 0; ticks < 100; ticks++) {
    wake = false;
    let result: AdvanceRunActivityResult;
    try { result = await (patched('run-advance-async-heartbeat-v1')
      ? patched('run-advance-long-model-v1') ? advanceRunLong : advanceRunPolling
      : advanceRun)(runId); }
    catch (error) {
      if (patched('run-advance-terminal-unknown-v1')) {
        if (await closeUnknownRun(runId, 'Run activity failed after bounded retries')) return;
        continue;
      }
      // Permanent auth/config/protocol failures wait for an explicit wake after
      // operator correction. Transport failures get a durable timer retry.
      await condition(() => wake, hasNonRetryableCause(error) ? undefined : '30 seconds');
      continue;
    }
    const status = result.status;
    if (status === 'unknown' && patched('run-advance-terminal-unknown-v1')) {
      if (await closeUnknownRun(runId, 'Model or activity outcome is unknown')) return;
      continue;
    }
    if (['succeeded', 'cancelled'].includes(status)) return;
    // Preserve old histories that already emitted a wait command for failed.
    if (status === 'failed' && patched('terminal-failed-run-v1')) return;
    if (patched('run-advance-progress-backoff-v1')) {
      const decision = decideRunAdvance(result, previousProgress, stalled, patched('run-advance-active-poll-v2'));
      previousProgress = result.progress;
      stalled = decision.stalled;
      if (decision.kind === 'terminal') return;
      if (decision.kind === 'wait') await condition(() => wake);
      else if (decision.delayMs) await condition(() => wake, decision.delayMs);
      // An explicit wake authorizes a fresh bounded series of advances.
      if (wake) { stalled = 0; previousProgress = undefined; }
    } else if (!['queued', 'planning', 'running', 'reviewing'].includes(status)) {
      // Approval, input, external reconciliation
      // are business states owned by AEEIS. Polling them every 30 seconds
      // creates needless Activity load and can hide a stuck long-running Run;
      // the API signals the same workflow after the durable state changes.
      await condition(() => wake);
    }
  }
  if (patched('run-advance-progress-backoff-v1')) {
    await continueAsNew<typeof agentRunWorkflow>(runId, { stalled, ...(previousProgress === undefined ? {} : { previousProgress }) });
  } else await continueAsNew<typeof agentRunWorkflow>(runId);
}

/**
 * Durable timer for a Reminder. The API remains the owner of reminder state
 * and projection delivery; this workflow only sleeps until the next durable
 * timestamp and wakes the same idempotent advance activity. A signal lets
 * cancellation/retry or an edited schedule take effect immediately.
 */
export async function reminderWorkflow(reminderId: string): Promise<void> {
  let wake = false;
  setHandler(defineSignal('wake'), () => { wake = true; });
  for (let ticks = 0; ticks < 100; ticks++) {
    wake = false;
    let result: AdvanceReminderActivityResult;
    try { result = await advanceReminder(reminderId); }
    catch (error) {
      await condition(() => wake, hasNonRetryableCause(error) ? undefined : '30 seconds');
      continue;
    }
    if (result.terminal) return;
    const wakeAt = result.wakeAt;
    if (!wakeAt) { await condition(() => wake); continue; }
    const delayMs = Math.max(1, Date.parse(wakeAt) - Date.now());
    await condition(() => wake, delayMs);
  }
  await continueAsNew<typeof reminderWorkflow>(reminderId);
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
