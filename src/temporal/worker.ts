import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';

const token = process.env.AEEIS_WORKER_TOKEN;
if (!token) throw new Error('Set AEEIS_WORKER_TOKEN for the private activity endpoint');
const api = process.env.AEEIS_INTERNAL_URL ?? 'http://127.0.0.1:4323';
const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
try {
  const worker = await Worker.create({
    connection, taskQueue: process.env.AEEIS_TASK_QUEUE ?? 'aeeis-agent',
    workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
    activities: {
      async advanceRun(id: string): Promise<string> {
        const response = await fetch(`${api}/internal/runs/${encodeURIComponent(id)}/advance`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: '{}', signal: AbortSignal.timeout(90000), redirect: 'error',
        });
        if (!response.ok) throw new Error(`Activity endpoint returned HTTP ${response.status}`);
        const body = await response.json() as { status: string };
        return body.status;
      },
    },
  });
  await worker.run();
} finally { await connection.close(); }
