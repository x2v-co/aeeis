import { condition, continueAsNew, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { AdvanceReminderActivityResult, AdvanceRunActivityResult } from './activity.js';

const { advanceRun, advanceReminder } = proxyActivities<{
  advanceRun(id: string): Promise<AdvanceRunActivityResult>;
  advanceReminder(id: string): Promise<AdvanceReminderActivityResult>;
}>({
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
      // Approval, input, external reconciliation, failure and cancellation
      // are business states owned by AEEIS. Polling them every 30 seconds
      // creates needless Activity load and can hide a stuck long-running Run;
      // the API signals the same workflow after the durable state changes.
      await condition(() => wake);
    }
  }
  await continueAsNew<typeof agentRunWorkflow>(runId);
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
