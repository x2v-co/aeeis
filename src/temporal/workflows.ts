import { condition, continueAsNew, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';

const { advanceRun } = proxyActivities<{ advanceRun(id: string): Promise<string> }>({
  startToCloseTimeout: '2 minutes', scheduleToCloseTimeout: '3 minutes',
  // Unknown outcomes are reconciled by the domain, not blindly retried by the execution engine.
  retry: { maximumAttempts: 1 },
});
export async function agentRunWorkflow(runId: string): Promise<void> {
  let wake = false;
  setHandler(defineSignal('wake'), () => { wake = true; });
  for (let ticks = 0; ticks < 100; ticks++) {
    wake = false;
    let status: string;
    try { status = await advanceRun(runId); }
    catch { await condition(() => wake, '30 seconds'); continue; }
    if (['succeeded', 'cancelled'].includes(status)) return;
    if (!['queued', 'planning', 'running', 'reviewing'].includes(status)) {
      await condition(() => wake, '30 seconds');
    }
  }
  await continueAsNew<typeof agentRunWorkflow>(runId);
}
