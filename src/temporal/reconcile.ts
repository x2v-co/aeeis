/** Only app-owned terminal Runs are eligible; unknown/wait states stay alive. */
export const terminalRunStatuses = new Set(['succeeded', 'failed', 'cancelled']);
export interface ReconcileExecution { workflowId: string; runId: string; type: string }
export interface ReconcileWorkflowsOptions {
  executions: AsyncIterable<ReconcileExecution>;
  readStatus(id: string): Promise<string>;
  terminate(execution: ReconcileExecution, reason: string): Promise<void | boolean>;
  apply?: boolean;
  log(record: Record<string, unknown>): void;
}

export async function reconcileWorkflows(options: ReconcileWorkflowsOptions): Promise<void> {
  for await (const execution of options.executions) {
    if (execution.type !== 'agentRunWorkflow') continue;
    // Missing Runs or lookup/auth errors abort rather than assume terminal.
    const status = await options.readStatus(execution.workflowId);
    if (!terminalRunStatuses.has(status)) {
      options.log({ ...execution, status, action: 'keep' });
      continue;
    }
    if (!options.apply) {
      options.log({ ...execution, status, action: 'would-terminate' });
      continue;
    }
    // Recheck immediately before termination: a retried Run is no longer eligible.
    const current = await options.readStatus(execution.workflowId);
    if (!terminalRunStatuses.has(current)) {
      options.log({ ...execution, status: current, action: 'keep-state-changed' });
      continue;
    }
    const terminated = await options.terminate(execution, `AEEIS reconcile: app run is terminal (${current})`);
    options.log({ ...execution, status: current, action: terminated === false ? 'already-closed' : 'terminated' });
  }
}
