import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { createAdvanceRunActivity } from './activity.js';

const token = process.env.AEEIS_WORKER_TOKEN;
if (!token) throw new Error('Set AEEIS_WORKER_TOKEN for the private activity endpoint');
const api = process.env.AEEIS_INTERNAL_URL ?? 'http://127.0.0.1:4323';
const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
try {
  const worker = await Worker.create({
    connection, taskQueue: process.env.AEEIS_TASK_QUEUE ?? 'aeeis-agent',
    workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
    activities: { advanceRun: createAdvanceRunActivity({ api, token }) },
  });
  await worker.run();
} finally { await connection.close(); }
