import { Client, Connection, isGrpcDeadlineError, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AgentEngine } from './engine.js';
import { validateInternalEndpoint } from '../internal-endpoint.js';
import { withSystemScope } from '../adapters/postgres-pool.js';

export interface TemporalRunWorkflowClient {
  workflow: {
    getHandle(id: string): { signal(name: string): Promise<void> };
    start(workflowType: string, options: { taskQueue: string; workflowId: string; args: [string] }): Promise<unknown>;
  };
}

/**
 * Wake or start a Run workflow across the signal/start race. Two API
 * processes can observe the same missing workflow: one may start it between
 * the other's signal and start calls. Retrying the signal after
 * AlreadyStarted closes that window without creating a second workflow.
 * A not-found on that final signal means the existing execution completed in
 * the meantime; the durable Run state remains authoritative and the next
 * recovery sweep can start it again if it is still actionable.
 */
export async function notifyTemporalRunWorkflow(client: TemporalRunWorkflowClient, taskQueue: string, id: string): Promise<void> {
  const signal = async (): Promise<void> => { await client.workflow.getHandle(id).signal('wake'); };
  try { await signal(); return; }
  catch (error) { if (!(error instanceof WorkflowNotFoundError)) throw error; }
  try {
    await client.workflow.start('agentRunWorkflow', { taskQueue, workflowId: id, args: [id] });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    try { await signal(); }
    catch (signalError) {
      if (!(signalError instanceof WorkflowNotFoundError)) throw signalError;
    }
  }
}

/**
 * Boot recovery wakes only Runs a worker can still advance. Terminal Runs
 * (including `failed`) must not be notified: Temporal allows a closed
 * workflow ID to be started again, so every API restart would otherwise
 * start a fresh, immediately-returning workflow for every historical failed
 * Run. Waiting states resume through their own signal/approval paths.
 */
export const BOOT_RECOVERABLE_RUN_STATUSES: readonly string[] = ['queued', 'planning', 'running', 'reviewing'];
export function isBootRecoverableRun(status: string): boolean { return BOOT_RECOVERABLE_RUN_STATUSES.includes(status); }

export type WorkflowStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TERMINATED' | 'TIMED_OUT' | 'CONTINUED_AS_NEW' | 'NOT_FOUND';
export interface WorkflowCancellation { outcome: 'cancelled' | 'terminated' | 'not_found' | 'already_closed' | 'unsupported' }
function workflowStatus(name: string): WorkflowStatus {
  // The TypeScript SDK spells this status CANCELLED; the API uses CANCELED.
  if (name === 'CANCELLED') return 'CANCELED';
  if (['RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'TERMINATED', 'TIMED_OUT', 'CONTINUED_AS_NEW', 'NOT_FOUND'].includes(name)) return name as WorkflowStatus;
  throw new Error(`Unknown Temporal workflow status: ${name}`);
}
function cancelTimeoutMs(): number {
  const value = Number(process.env.AEEIS_RUN_CANCEL_TIMEOUT_MS ?? 10_000);
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('AEEIS_RUN_CANCEL_TIMEOUT_MS must be a positive integer');
  return value;
}

export interface Dispatcher {
  notify(id: string): Promise<void>;
  /** Lower numbers start first. Missing ranks sort after every ranked Run.
   * Updating a rank does not approve, pause, resume, or cancel. */
  setSchedulingRank?(id: string, rank: number | undefined): void;
  cancel?(id: string, reason?: string): Promise<WorkflowCancellation>;
  /** Describe the latest execution of a workflow ID, without pinning a run ID. */
  describe?(id: string): Promise<{ status: WorkflowStatus }>;
  /** Wake or start the durable timer workflow for a Reminder when supported. */
  notifyReminder?(id: string): Promise<void>;
  close(): Promise<void>;
  health?(): Promise<{ ready: boolean; detail: string }>;
}
const LOCAL_RUNNABLE = new Set(['queued', 'planning', 'running', 'reviewing']);
/** One step per turn, then back to the queue. In-flight model calls keep overlapping:
 * a compaction request is not a lock on any other Run, and a started call is
 * finished inside the advance that reserved it. */
export class LocalDispatcher implements Dispatcher {
  private queued = new Set<string>();
  private inflight = new Map<string, Promise<void>>();
  private ranks = new Map<string, number>();
  private pumpScheduled = false;
  private closing = false;
  constructor(private engine: AgentEngine) {}
  setSchedulingRank(id: string, rank: number | undefined): void {
    if (rank === undefined || !Number.isSafeInteger(rank) || rank < 1 || rank > 100) this.ranks.delete(id);
    else this.ranks.set(id, rank);
    this.schedulePump();
  }
  async notify(id: string): Promise<void> {
    if (this.closing || !id) return;
    this.queued.add(id);
    this.schedulePump();
  }
  private rankValue(id: string): number {
    return this.ranks.get(id) ?? Number.POSITIVE_INFINITY;
  }
  private schedulePump(): void {
    if (this.pumpScheduled || this.closing) return;
    this.pumpScheduled = true;
    // The pump outlives the request that scheduled it and runs every tenant's queued Runs: it reads as the system.
    queueMicrotask(() => withSystemScope(() => {
      this.pumpScheduled = false;
      this.pump();
    }));
  }
  private pump(): void {
    if (this.closing) return;
    const ready = [...this.queued].filter(id => !this.inflight.has(id));
    ready.sort((left, right) => this.rankValue(left) - this.rankValue(right) || (left < right ? -1 : left > right ? 1 : 0));
    for (const id of ready) this.start(id);
  }
  private start(id: string): void {
    if (this.inflight.has(id) || this.closing) return;
    this.queued.delete(id);
    let resolve!: () => void;
    const done = new Promise<void>(resolveDone => { resolve = resolveDone; });
    this.inflight.set(id, done);
    void (async () => {
      let status = '';
      let failed = false;
      try { status = await this.engine.advance(id); }
      catch (error) {
        failed = true;
        console.error('Local run driver failed', error instanceof Error ? error.name : 'Error');
      }
      if (failed || this.closing || this.engine.isDraining || !LOCAL_RUNNABLE.has(status)) this.queued.delete(id);
      else this.queued.add(id);
    })().finally(() => {
      this.inflight.delete(id);
      resolve();
      this.schedulePump();
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    this.queued.clear();
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }
  async cancel(_id: string, _reason?: string): Promise<WorkflowCancellation> { return { outcome: 'unsupported' }; }
  async health(): Promise<{ ready: boolean; detail: string }> { return { ready: !this.closing, detail: this.closing ? 'local dispatcher is closing' : 'LocalDispatcher ready' }; }
}

/** Boot recovery. A local dispatcher learns every rank before the first step
 * so the page starts in priority order and still overlaps. Temporal stays
 * one signal at a time; it has no cross-run rank. */
export async function notifyRecoverableRuns(dispatcher: Dispatcher, runs: readonly { id: string; status: string; schedulingPriority?: number }[]): Promise<void> {
  const recoverable = runs.filter(run => isBootRecoverableRun(run.status));
  if (dispatcher.setSchedulingRank) {
    await Promise.all(recoverable.map(run => {
      dispatcher.setSchedulingRank!(run.id, run.schedulingPriority);
      return dispatcher.notify(run.id);
    }));
    return;
  }
  for (const run of recoverable) await dispatcher.notify(run.id);
}
export class TemporalDispatcher implements Dispatcher {
  private constructor(private client: Client, private connection: Connection, private taskQueue: string, private readonly workerHealthUrl?: string) {}
  static async connect(address: string, taskQueue: string, namespace = 'default', workerHealthUrl?: string): Promise<TemporalDispatcher> {
    validateInternalEndpoint(workerHealthUrl, 'AEEIS_TEMPORAL_WORKER_HEALTH_URL', process.env, process.env.AEEIS_TEMPORAL_WORKER_HEALTH_ALLOW_INSECURE_HTTP === '1');
    const connection = await Connection.connect({ address });
    return new TemporalDispatcher(new Client({ connection, namespace }), connection, taskQueue, workerHealthUrl);
  }
  async notify(id: string): Promise<void> {
    await notifyTemporalRunWorkflow(this.client, this.taskQueue, id);
  }
  async describe(id: string): Promise<{ status: WorkflowStatus }> {
    try {
      const description = await this.client.withDeadline(Date.now() + 10_000, () => this.client.workflow.getHandle(id).describe());
      return { status: workflowStatus(description.status.name) };
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return { status: 'NOT_FOUND' };
      throw error;
    }
  }
  async cancel(id: string, reason?: string): Promise<WorkflowCancellation> {
    const timeoutMs = cancelTimeoutMs();
    const handle = this.client.workflow.getHandle(id);
    const deadline = Date.now() + timeoutMs;
    const describe = () => this.client.withDeadline(deadline, () => handle.describe());
    const closed = (status: string) => status !== 'RUNNING' && status !== 'CONTINUED_AS_NEW';
    try {
      try {
        if (closed(workflowStatus((await describe()).status.name))) return { outcome: 'already_closed' };
        await this.client.withDeadline(deadline, () => handle.cancel());
        while (Date.now() < deadline) {
          const status = workflowStatus((await describe()).status.name);
          if (closed(status)) return { outcome: status === 'CANCELED' ? 'cancelled' : status === 'TERMINATED' ? 'terminated' : 'already_closed' };
          await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
        }
      } catch (error) {
        if (!isGrpcDeadlineError(error)) throw error;
      }
      await this.client.withDeadline(Date.now() + timeoutMs, () => handle.terminate(reason));
      return { outcome: 'terminated' };
    } catch (error) {
      // Temporal also reports already-completed executions as not found.
      if (error instanceof WorkflowNotFoundError) return { outcome: 'not_found' };
      throw error;
    }
  }
  async notifyReminder(id: string): Promise<void> {
    const workflowId = `aeeis-reminder-${id}`;
    // Signal-with-start makes cancellation/retry and restart races atomic. A
    // plain getHandle().signal() can reach a completed timer chain just before
    // the subsequent start, while a separate start can lose to another API
    // process. USE_EXISTING wakes the live chain; ALLOW_DUPLICATE permits a
    // cancelled/finished reminder to be retried with the same deterministic ID.
    await this.client.workflow.signalWithStart('reminderWorkflow', {
      taskQueue: this.taskQueue,
      workflowId,
      args: [id],
      signal: 'wake',
      signalArgs: [],
      workflowIdConflictPolicy: 'USE_EXISTING',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    });
  }
  async health(): Promise<{ ready: boolean; detail: string }> {
    try {
      await checkTemporalHealth(this.connection);
      if (this.workerHealthUrl) {
        const worker = await checkWorkerHealth(this.workerHealthUrl);
        if (!worker.ready) return { ready: false, detail: `Temporal reachable (${this.taskQueue}); ${worker.detail}` };
        return { ready: true, detail: `Temporal reachable (${this.taskQueue}); ${worker.detail}` };
      }
      return { ready: true, detail: `Temporal reachable (${this.taskQueue}); Worker health URL not configured` };
    } catch (error) {
      return { ready: false, detail: `Temporal health check failed: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
  }
  async close(): Promise<void> { await this.connection.close(); }
}

/** Probe the Worker process separately from Temporal's gRPC service. A healthy
 * Temporal cluster without a polling Worker cannot make long-running Runs
 * progress, so configured deployments fail closed until /readyz reports a
 * RUNNING Worker. The response body is deliberately ignored. */
export async function checkWorkerHealth(endpoint: string, timeoutMs = 3_000, env: NodeJS.ProcessEnv = process.env): Promise<{ ready: boolean; detail: string }> {
  try {
    validateInternalEndpoint(endpoint, 'AEEIS_TEMPORAL_WORKER_HEALTH_URL', env, env.AEEIS_TEMPORAL_WORKER_HEALTH_ALLOW_INSECURE_HTTP === '1');
    const response = await fetch(endpoint, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    await response.body?.cancel();
    return { ready: response.ok, detail: response.ok ? 'Temporal Worker ready' : `Temporal Worker returned HTTP ${response.status}` };
  } catch {
    return { ready: false, detail: 'Temporal Worker health endpoint unreachable or timed out' };
  }
}

async function checkTemporalHealth(connection: Connection): Promise<void> {
  const service = connection.healthService as unknown as { check: (request: { service: string }, callback: (error: Error | null, response?: { status?: number }) => void) => void };
  await new Promise<void>((resolve, reject) => {
    service.check({ service: '' }, (error, response) => {
      if (error) { reject(error); return; }
      if (response?.status !== undefined && response.status !== 1) { reject(new Error(`Temporal health status ${response.status}`)); return; }
      resolve();
    });
  });
}
