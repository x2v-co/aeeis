import type { AgentRun } from './contracts.js';
import type { WorkflowStatus } from './dispatcher.js';
import { event } from './engine.js';
import type { RunRepository } from './repository.js';

export const NON_TERMINAL_RUN_STATUSES = ['queued', 'planning', 'needs_approval', 'running', 'needs_input', 'waiting_external', 'paused', 'reviewing', 'unknown'] as const;
export function isTerminalRun(run: Pick<AgentRun, 'status'>): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(run.status);
}
export function planRunReconcile(run: Pick<AgentRun, 'status'>, workflowStatus: WorkflowStatus): { action: 'none' | 'cancel' | 'fail'; reason: string } {
  if (isTerminalRun(run)) return { action: 'none', reason: 'Run is already terminal' };
  switch (workflowStatus) {
    case 'TERMINATED': case 'CANCELED': return { action: 'cancel', reason: `Temporal workflow ${workflowStatus.toLowerCase()}` };
    case 'FAILED': case 'TIMED_OUT': case 'NOT_FOUND': return { action: 'fail', reason: `Temporal workflow ${workflowStatus.toLowerCase()}` };
    case 'COMPLETED': return { action: 'fail', reason: 'workflow completed while run non-terminal' };
    default: return { action: 'none', reason: 'Temporal workflow is still active' };
  }
}

// Abort a no-op mutation so neither repository increments the revision or emits
// change notifications when reconciliation loses a race.
class UnchangedRun extends Error {
  constructor(readonly run: AgentRun) { super('Run unchanged'); }
}

export async function reconcileRun(repository: RunRepository, run: AgentRun, describe: () => Promise<{ status: WorkflowStatus }>, actor: string, dryRun: boolean) {
  const revision = run.revision;
  const scope = { owner: run.owner, tenantId: run.tenantId ?? 'local' };
  let { status: workflowStatus } = await describe();
  run = await repository.get(run.id, scope);
  let plan = run.revision === revision ? planRunReconcile(run, workflowStatus) : { action: 'none' as const, reason: 'Run changed during reconciliation' };
  let applied = false;
  if (!dryRun && plan.action !== 'none') {
    try {
      run = await repository.mutate(run.id, async current => {
        if (current.revision !== revision || isTerminalRun(current)) {
          plan = { action: 'none', reason: 'Run changed during reconciliation' };
          throw new UnchangedRun(current);
        }
        // A closed workflow ID may have been restarted since the first read.
        // Refresh under the Run lock, which also excludes application progress.
        workflowStatus = (await describe()).status;
        plan = planRunReconcile(current, workflowStatus);
        if (plan.action === 'none') throw new UnchangedRun(current);
        current.reconciliation = { workflowStatus, previousStatus: current.status, actor, at: new Date().toISOString(), reason: plan.reason };
        current.status = plan.action === 'cancel' ? 'cancelled' : 'failed';
        if (plan.action === 'fail') current.error = plan.reason;
        event(current, 'run.reconciled', { ...current.reconciliation });
      }, scope);
      applied = true;
    } catch (error) {
      if (!(error instanceof UnchangedRun)) throw error;
      run = error.run;
    }
  }
  return { runId: run.id, appStatus: run.status, workflowStatus, action: plan.action, applied };
}

/** Use immutable-ID pages so applied status changes cannot move the scan cursor. */
export async function* scanReconcileRuns(repository: RunRepository): AsyncGenerator<AgentRun> {
  if (!repository.scanPage) { yield* await repository.list(); return; }
  let afterId: string | undefined, throughId: string | undefined;
  while (true) {
    const page = await repository.scanPage({ limit: 200, ...(afterId ? { afterId } : {}), ...(throughId ? { throughId } : {}) });
    yield* page.runs;
    if (page.done || !page.runs.length) return;
    afterId = page.runs.at(-1)!.id;
    throughId = page.throughId;
  }
}
