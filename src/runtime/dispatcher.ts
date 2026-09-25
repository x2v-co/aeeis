import { Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import type { AgentEngine } from './engine.js';

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

export interface Dispatcher {
  notify(id: string): Promise<void>;
  /** Wake or start the durable timer workflow for a Reminder when supported. */
  notifyReminder?(id: string): Promise<void>;
  close(): Promise<void>;
  health?(): Promise<{ ready: boolean; detail: string }>;
}
export class LocalDispatcher implements Dispatcher {
  private jobs = new Map<string, Promise<void>>();
  private closing = false;
  constructor(private engine: AgentEngine) {}
  async notify(id: string): Promise<void> {
    if (this.jobs.has(id) || this.closing) return;
    const work = (async () => {
      while (!this.closing) {
        const status = await this.engine.advance(id);
        if (!['queued', 'planning', 'running', 'reviewing'].includes(status)) break;
      }
    })().finally(() => this.jobs.delete(id));
    this.jobs.set(id, work);
    // Keep failures observable without an unhandled rejection. The durable status remains inspectable.
    void work.catch(error => console.error('Local run driver failed', error instanceof Error ? error.name : 'Error'));
  }
  async close(): Promise<void> { this.closing = true; await Promise.allSettled(this.jobs.values()); }
  async health(): Promise<{ ready: boolean; detail: string }> { return { ready: !this.closing, detail: this.closing ? 'local dispatcher is closing' : 'LocalDispatcher ready' }; }
}
export class TemporalDispatcher implements Dispatcher {
  private constructor(private client: Client, private connection: Connection, private taskQueue: string, private readonly workerHealthUrl?: string) {}
  static async connect(address: string, taskQueue: string, namespace = 'default', workerHealthUrl?: string): Promise<TemporalDispatcher> {
    const connection = await Connection.connect({ address });
    return new TemporalDispatcher(new Client({ connection, namespace }), connection, taskQueue, workerHealthUrl);
  }
  async notify(id: string): Promise<void> {
    await notifyTemporalRunWorkflow(this.client, this.taskQueue, id);
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
export async function checkWorkerHealth(endpoint: string, timeoutMs = 3_000): Promise<{ ready: boolean; detail: string }> {
  try {
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
