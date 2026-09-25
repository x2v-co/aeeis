import { createServer, type Server } from 'node:http';
import type { Worker } from '@temporalio/worker';

export interface WorkerHealthOptions {
  host: string;
  port: number;
  taskQueue: string;
  buildId: string;
}

/** Small process health surface for orchestrators; it exposes no task data. */
export async function startWorkerHealthServer(worker: Worker, options: WorkerHealthOptions): Promise<Server> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'GET' || !['/health', '/readyz'].includes(request.url ?? '')) {
      response.statusCode = 404; response.end(JSON.stringify({ error: 'not found' })); return;
    }
    const state = worker.getState();
    const ready = state === 'RUNNING';
    response.statusCode = request.url === '/readyz' && !ready ? 503 : 200;
    response.end(JSON.stringify({
      protocol: request.url === '/readyz' ? 'aeeis-worker-readiness/1' : 'aeeis-worker-health/1',
      status: request.url === '/readyz' ? (ready ? 'ready' : 'not_ready') : 'ok',
      workerState: state, taskQueue: options.taskQueue, buildId: options.buildId,
    }));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError); server.once('listening', onListening); server.listen(options.port, options.host);
  });
  return server;
}

export async function closeWorkerHealthServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
