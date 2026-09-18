import { Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import type { AgentEngine } from './engine.js';

export interface Dispatcher { notify(id: string): Promise<void>; close(): Promise<void> }
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
}
export class TemporalDispatcher implements Dispatcher {
  private constructor(private client: Client, private connection: Connection, private taskQueue: string) {}
  static async connect(address: string, taskQueue: string): Promise<TemporalDispatcher> {
    const connection = await Connection.connect({ address });
    return new TemporalDispatcher(new Client({ connection }), connection, taskQueue);
  }
  async notify(id: string): Promise<void> {
    try { await this.client.workflow.getHandle(id).signal('wake'); return; }
    catch (e) { if (!(e instanceof WorkflowNotFoundError)) throw e; }
    try {
      await this.client.workflow.start('agentRunWorkflow', { taskQueue: this.taskQueue, workflowId: id, args: [id] });
    } catch (e) {
      if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
      await this.client.workflow.getHandle(id).signal('wake');
    }
  }
  async close(): Promise<void> { await this.connection.close(); }
}
