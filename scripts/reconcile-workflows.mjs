import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { reconcileWorkflows } from '../dist/temporal/reconcile.js';

const args = process.argv.slice(2);
if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
  throw new Error('Usage: node scripts/reconcile-workflows.mjs [--dry-run | --apply]');
}
const api = (process.env.AEEIS_INTERNAL_URL ?? 'http://127.0.0.1:4323').replace(/\/$/, '');
const token = process.env.AEEIS_WORKER_TOKEN;
if (!token) throw new Error('AEEIS_WORKER_TOKEN is required');
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'aeeis';
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233' });
const client = new Client({ connection, namespace });
console.log(JSON.stringify({ protocol: 'aeeis-workflow-reconcile/1', namespace, mode: args.includes('--apply') ? 'apply' : 'dry-run' }));
try {
  await reconcileWorkflows({
    executions: client.workflow.list({ query: 'WorkflowType="agentRunWorkflow" AND ExecutionStatus="Running"' }),
    apply: args.includes('--apply'),
    readStatus: async id => {
      const response = await fetch(`${api}/internal/runs/${encodeURIComponent(id)}/status`, {
        headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Run status lookup failed: HTTP ${response.status} for ${id}`);
      const body = await response.json();
      if (typeof body.status !== 'string') throw new Error(`Invalid Run status for ${id}`);
      return body.status;
    },
    terminate: async ({ workflowId, runId }, reason) => {
      try {
        // Pin the listed execution, never terminate a newly started retry.
        const handle = client.workflow.getHandle(workflowId, runId);
        if ((await handle.describe()).status.name !== 'RUNNING') return false;
        await handle.terminate(reason);
        return true;
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
        return false;
      }
    },
    log: record => console.log(JSON.stringify(record)),
  });
} finally {
  await connection.close();
}
