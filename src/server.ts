import { FileRunRepository, PostgresRunRepository } from './runtime/repository.js';
import { HttpModelAdapter } from './runtime/model.js';
import { AgentEngine } from './runtime/engine.js';
import { LocalDispatcher, TemporalDispatcher } from './runtime/dispatcher.js';
import type { Dispatcher } from './runtime/dispatcher.js';
import { buildApp } from './runtime/http.js';

const repository = process.env.DATABASE_URL
  ? new PostgresRunRepository(process.env.DATABASE_URL)
  : new FileRunRepository(process.env.AEEIS_DATA_DIR ?? 'data/runs');
await repository.init();
let engine: AgentEngine | undefined, dispatcher: Dispatcher | undefined;
try {
  if (process.env.AEEIS_MODEL_BASE_URL && process.env.AEEIS_MODEL) {
    const model = new HttpModelAdapter(process.env.AEEIS_MODEL_BASE_URL, process.env.AEEIS_MODEL, process.env.AEEIS_MODEL_API_KEY ?? '');
    engine = new AgentEngine(repository, model);
    await engine.recover();
    if (process.env.AEEIS_RUNNER === 'temporal') {
      if (!process.env.AEEIS_WORKER_TOKEN) throw new Error('Temporal requires AEEIS_WORKER_TOKEN');
      dispatcher = await TemporalDispatcher.connect(process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233', process.env.AEEIS_TASK_QUEUE ?? 'aeeis-agent');
    } else dispatcher = new LocalDispatcher(engine);
  }
  const app = buildApp({ repository, ...(engine ? { engine } : {}), ...(dispatcher ? { dispatcher } : {}),
    ...(process.env.AEEIS_ACCESS_TOKEN ? { token: process.env.AEEIS_ACCESS_TOKEN } : {}),
    ...(process.env.AEEIS_WORKER_TOKEN ? { workerToken: process.env.AEEIS_WORKER_TOKEN } : {}),
  });
  const port = Number(process.env.PORT ?? 4323);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`AEEIS: http://127.0.0.1:${port} (${engine ? 'model configured' : 'model configuration required'})`);
  for (const run of await repository.list()) if (!['succeeded', 'cancelled'].includes(run.status)) await dispatcher?.notify(run.id);
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    await app.close(); await dispatcher?.close(); await repository.close();
  };
  process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
} catch (error) { await dispatcher?.close(); await repository.close(); throw error; }
