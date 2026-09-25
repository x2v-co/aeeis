import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { createAdvanceReminderActivity, createAdvanceRunActivity } from './activity.js';
import { closeWorkerHealthServer, startWorkerHealthServer } from './health.js';
import { parseTemporalWorkerConfig } from './config.js';

const config = parseTemporalWorkerConfig();
const { token, api, taskQueue, namespace, versioning, healthHost, healthPort, shutdownGraceTime, shutdownForceTime, address } = config;
const connection = await NativeConnection.connect({ address });
try {
  const worker = await Worker.create({
    connection, namespace, taskQueue, buildId: versioning.buildId,
    ...(versioning.useVersioning ? {
      workerDeploymentOptions: {
        version: { deploymentName: versioning.deploymentName, buildId: versioning.buildId },
        useWorkerVersioning: true,
        defaultVersioningBehavior: 'PINNED',
      },
    } : {}),
    shutdownGraceTime, shutdownForceTime,
    workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
    activities: {
      advanceRun: createAdvanceRunActivity({ api, token }),
      advanceReminder: createAdvanceReminderActivity({ api, token }),
    },
  });
  const health = await startWorkerHealthServer(worker, { host: healthHost, port: healthPort, taskQueue, buildId: versioning.buildId });
  console.log(`AEEIS Temporal worker ready: http://${healthHost}:${healthPort}/readyz (queue=${taskQueue}, build=${versioning.buildId}, rollout=${versioning.rollout})`);
  try { await worker.run(); }
  finally { await closeWorkerHealthServer(health); }
} finally {
  await connection.close();
}
