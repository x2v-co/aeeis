import { proxyActivities } from '@temporalio/workflow';

const { advanceRun, advanceReminder } = proxyActivities<{
  advanceRun(runId: string): Promise<{ status: string }>;
  advanceReminder(reminderId: string): Promise<{ status: string; terminal: boolean }>;
}>({
  startToCloseTimeout: '2 minutes',
});

/**
 * Minimal previous implementation used to create a durable history fixture.
 * The workflow type and activity contract are intentionally stable while the
 * current implementation has since added wake, retry and Continue-As-New
 * behavior around the same activity boundary.
 */
export async function agentRunWorkflow(runId: string): Promise<void> {
  const result = await advanceRun(runId);
  if (result.status === 'succeeded' || result.status === 'cancelled') return;
}

/** The first durable Reminder implementation used one activity call and
 * returned once the reminder had reached a terminal state. The current
 * workflow must continue to replay this history after adding timers/signals. */
export async function reminderWorkflow(reminderId: string): Promise<void> {
  const result = await advanceReminder(reminderId);
  if (result.terminal) return;
}
