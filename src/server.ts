import { FileRunRepository, PostgresRunRepository } from './runtime/repository.js';
import { HttpModelAdapter } from './runtime/model.js';
import { AgentEngine } from './runtime/engine.js';
import { LocalDispatcher, TemporalDispatcher } from './runtime/dispatcher.js';
import type { Dispatcher } from './runtime/dispatcher.js';
import { buildApp } from './runtime/http.js';
import { FileBrainStore } from './brain.js';
import { ConfiguredHttpToolGateway, OwnHowCliGovernance, PlanpriceHttpCatalog, ToolkitRegistryGateway } from './integrations.js';
import { CatalogModelResolver, HttpCatalogModelFactory } from './runtime/model-router.js';
import { AgentDirectory, AgentGateway, HttpAgentTransport } from './agent-gateway.js';
import { agentCardSchema } from './protocol.js';
import { FileKnowledgeProvider, HttpKnowledgeProvider } from './knowledge.js';
import { FileEvolutionRepository, RsiService } from './rsi.js';
import { CollaborationService, FileCollaborationRepository } from './collaboration-service.js';

const repository = process.env.DATABASE_URL
  ? new PostgresRunRepository(process.env.DATABASE_URL)
  : new FileRunRepository(process.env.AEEIS_DATA_DIR ?? 'data/runs');
await repository.init();
const brainStore = new FileBrainStore(`${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/brain`);
await brainStore.init();
const brain = await brainStore.load();
const evolutionRepository = new FileEvolutionRepository(`${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/evolution`);
await evolutionRepository.init();
const rsi = new RsiService(evolutionRepository);
const collaborationRepository = new FileCollaborationRepository(`${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/collaboration`);
await collaborationRepository.init();
const collaboration = new CollaborationService(collaborationRepository);
let engine: AgentEngine | undefined, dispatcher: Dispatcher | undefined;
try {
  const toolkit = process.env.AEEIS_TOOLKIT_REGISTRY_URL
    ? new ToolkitRegistryGateway(process.env.AEEIS_TOOLKIT_REGISTRY_URL, process.env.AEEIS_TOOLKIT_TOKEN)
    : process.env.AEEIS_TOOLKIT_MANIFEST_URL && process.env.AEEIS_TOOLKIT_INVOKE_URL
    ? new ConfiguredHttpToolGateway(process.env.AEEIS_TOOLKIT_MANIFEST_URL, process.env.AEEIS_TOOLKIT_INVOKE_URL, process.env.AEEIS_TOOLKIT_TOKEN, process.env.AEEIS_TOOLKIT_RECONCILE_URL)
    : undefined;
  const skills = process.env.AEEIS_OWNHOW_ENABLED === '1'
    ? new OwnHowCliGovernance(process.env.AEEIS_OWNHOW_BIN ?? 'ownhow', process.env.AEEIS_OWNHOW_STATE_DIR, process.env.AEEIS_OWNHOW_RUNTIME)
    : undefined;
  let agents: AgentGateway | undefined;
  if (process.env.AEEIS_AGENT_CARDS) {
    const cards = JSON.parse(process.env.AEEIS_AGENT_CARDS) as unknown;
    if (!Array.isArray(cards)) throw new Error('AEEIS_AGENT_CARDS must be a JSON array');
    const directory = new AgentDirectory();
    for (const card of cards) directory.register(agentCardSchema.parse(card));
    let signingKeys: Record<string, string> = {};
    if (process.env.AEEIS_AGENT_SIGNING_KEYS) {
      const parsed: unknown = JSON.parse(process.env.AEEIS_AGENT_SIGNING_KEYS);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AEEIS_AGENT_SIGNING_KEYS must be a JSON object');
      signingKeys = Object.fromEntries(Object.entries(parsed).map(([key, value]) => {
        if (typeof value !== 'string' || value.length < 16) throw new Error('Agent signing keys must be strings of at least 16 characters');
        return [key, value];
      }));
    }
    agents = new AgentGateway(directory, new HttpAgentTransport(60_000, process.env.AEEIS_AGENT_BEARER_TOKEN, signingKeys));
  }
  const knowledge = process.env.AEEIS_KNOWLEDGE_URL
    ? new HttpKnowledgeProvider(process.env.AEEIS_KNOWLEDGE_URL, process.env.AEEIS_KNOWLEDGE_TOKEN)
    : process.env.AEEIS_KNOWLEDGE_FILE ? new FileKnowledgeProvider(process.env.AEEIS_KNOWLEDGE_FILE) : undefined;
  let modelServices: ConstructorParameters<typeof AgentEngine>[1] | undefined;
  if (process.env.AEEIS_MODEL_BASE_URL && process.env.AEEIS_MODEL) {
    modelServices = { model: new HttpModelAdapter(process.env.AEEIS_MODEL_BASE_URL, process.env.AEEIS_MODEL, process.env.AEEIS_MODEL_API_KEY ?? '') };
  } else if (process.env.AEEIS_PLANPRICE_URL) {
    let endpoints: Record<string, string> = {};
    if (process.env.AEEIS_MODEL_PROVIDER_ENDPOINTS) {
      const parsed: unknown = JSON.parse(process.env.AEEIS_MODEL_PROVIDER_ENDPOINTS);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AEEIS_MODEL_PROVIDER_ENDPOINTS must be a JSON object');
      endpoints = Object.fromEntries(Object.entries(parsed).map(([key, value]) => {
        if (typeof value !== 'string') throw new Error('Model provider endpoint must be a string');
        return [key, value];
      }));
    }
    const catalog = new PlanpriceHttpCatalog(process.env.AEEIS_PLANPRICE_URL, endpoints);
    let providerKeys: Record<string, string> = {};
    if (process.env.AEEIS_MODEL_PROVIDER_KEYS) {
      const parsed: unknown = JSON.parse(process.env.AEEIS_MODEL_PROVIDER_KEYS);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AEEIS_MODEL_PROVIDER_KEYS must be a JSON object');
      providerKeys = Object.fromEntries(Object.entries(parsed).map(([key, value]) => {
        if (typeof value !== 'string') throw new Error('Model provider key must be a string');
        return [key, value];
      }));
    }
    const resolver = new CatalogModelResolver(catalog, new HttpCatalogModelFactory(providerKeys));
    modelServices = { resolver };
  }
  if (modelServices) {
    engine = new AgentEngine(repository, { ...modelServices, brain, brainPersistence: brainStore, ...(toolkit ? { tools: toolkit } : {}), ...(skills ? { skills } : {}), ...(agents ? { agents } : {}), ...(knowledge ? { knowledge } : {}) });
    await engine.recover();
    if (process.env.AEEIS_RUNNER === 'temporal') {
      if (!process.env.AEEIS_WORKER_TOKEN) throw new Error('Temporal requires AEEIS_WORKER_TOKEN');
      dispatcher = await TemporalDispatcher.connect(process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233', process.env.AEEIS_TASK_QUEUE ?? 'aeeis-agent');
    } else dispatcher = new LocalDispatcher(engine);
  }
  const app = buildApp({ repository, brain, brainStore, rsi, collaboration, ...(engine ? { engine } : {}), ...(dispatcher ? { dispatcher } : {}),
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
    await app.close(); await dispatcher?.close(); await repository.close(); await brainStore.close(); await evolutionRepository.close(); await collaborationRepository.close();
  };
  process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
} catch (error) { await dispatcher?.close(); await repository.close(); await brainStore.close(); await evolutionRepository.close(); await collaborationRepository.close(); throw error; }
