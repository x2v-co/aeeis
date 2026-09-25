import { collaborationPricesSchema, type CollaborationPrices } from './collaboration-budget.js';
import { FileRunRepository, PostgresRunRepository } from './runtime/repository.js';
import { HttpModelAdapter } from './runtime/model.js';
import { AgentEngine, digest } from './runtime/engine.js';
import { LocalDispatcher, TemporalDispatcher } from './runtime/dispatcher.js';
import type { Dispatcher } from './runtime/dispatcher.js';
import type { ModelCatalog } from './integrations.js';
import { buildApp } from './runtime/http.js';
import { FileBrainStore } from './brain.js';
import { PostgresBrainStore } from './adapters/postgres-brain-store.js';
import { PostgresBrainSemanticIndex } from './adapters/postgres-brain-semantic-index.js';
import { ConfiguredHttpToolGateway, OwnHowCliGovernance, PlanpriceHttpCatalog, ToolkitRegistryGateway } from './integrations.js';
import { PlanpriceV1Catalog, type ProviderMapping } from './planprice-v1-adapter.js';
import { CatalogModelResolver, HttpCatalogModelFactory, StaticModelResolver, type ModelResolver } from './runtime/model-router.js';
import { AgentDirectory, AgentGateway, HttpAgentTransport, OAuthClientCredentialsProvider, type AgentDirectoryPort } from './agent-gateway.js';
import { PostgresAgentDirectory } from './adapters/postgres-agent-registry.js';
import { FileGrantLedger } from './agent-ledger.js';
import { PostgresGrantLedger } from './adapters/postgres-agent-ledger.js';
import { agentCardSchema } from './protocol.js';
import { FileKnowledgeProvider, HttpKnowledgeEmbeddingProvider, HttpKnowledgeProvider, PostgresKnowledgeProvider, type KnowledgeEmbeddingMaintenance, type KnowledgeProvider } from './knowledge.js';
import { FileEvolutionRepository, PostgresEvolutionRepository, RsiService } from './rsi.js';
import { FileEvolutionActivationStore, PostgresEvolutionActivationStore } from './evolution-activation.js';
import { CollaborationService, FileCollaborationRepository, PostgresCollaborationRepository } from './collaboration-service.js';
import { ModelPoolCandidateRunner, ModelPoolDebateOrchestrator, ModelPoolIndependentEvaluator } from './collaboration-pool.js';
import { JsonFileStore } from './adapters/json-store.js';
import { PostgresAeeisStore } from './adapters/postgres-store.js';
import { AeeisService } from './application/aeeis-service.js';
import { oauthClientConfigsSchema } from './oauth.js';
import { HttpRsiEvaluationHarness, evaluationSuiteSchema } from './evaluation.js';
import { FeishuAppProjectionSink, FeishuWebhookProjectionSink, FileProjectionOutbox, HermesCliProjectionSink, HttpProjectionSink, PostgresProjectionOutbox, RoutingProjectionSink, type ProjectionSink } from './collaboration-projection.js';
import { FileProjectSourceCheckpointStore, FileProjectSourceProvider, HttpProjectSourceProvider, type ProjectSourceCheckpointStore, type ProjectSourceProvider } from './project-sources.js';
import { PostgresProjectSourceCheckpointStore } from './adapters/postgres-project-source-checkpoints.js';
import { CombinedProjectSourceProvider, GitProjectSourceProvider, gitProjectConfigSchema } from './adapters/git-project-sources.js';
import { LinearProjectSourceProvider, linearProjectConfigSchema } from './adapters/linear-project-sources.js';
import { JiraProjectSourceProvider, jiraProjectConfigSchema } from './adapters/jira-project-sources.js';
import { principalTokensSchema } from './security/principal.js';
import { OidcPrincipalResolver, type OidcConfig } from './security/oidc.js';
import { z } from 'zod';
import type { ProjectionTarget } from './application/aeeis-service.js';
import { reconcileProjectionSnapshots, type ProjectionSnapshot } from './projection-reconciliation.js';
import type { AgentRun } from './runtime/contracts.js';
import type { EvolutionCandidate } from './evolution.js';
import type { CompetitionRecord, DebateRecord } from './collaboration-service.js';
import { FileTaskDispatchRepository, PostgresTaskDispatchRepository, TaskScheduler } from './task-scheduler.js';
import { createGlobalBudgetSelector, FileGlobalBudgetLedger, globalBudgetRuleSchema, PostgresGlobalBudgetLedger, type GlobalBudgetLedger } from './global-budget.js';
import { JsonRoomMembershipRepository, PostgresRoomMembershipRepository, type RoomMembershipRepository } from './room-membership.js';
import { validateRuntimeConfig } from './config-validation.js';
import { FeishuDebateIngress, feishuDebateRouteSchema } from './feishu-debate-ingress.js';
import { HermesDebateIngress, hermesDebateRouteSchema } from './hermes-debate-ingress.js';
import { CollaborationTriggerService, FileCollaborationTriggerStore, PostgresCollaborationTriggerStore } from './collaboration-triggers.js';
import { CollaborationTriggerPump } from './collaboration-trigger-pump.js';
import { RsiProposalPump } from './rsi-proposal-pump.js';
import { FileRunScanCursorStore, PostgresRunScanCursorStore, type RunScanCursorStore } from './run-scan-cursor.js';
import { FileRsiProposalClaimStore, PostgresRsiProposalClaimStore, type RsiProposalClaimStore } from './rsi-proposal-claims.js';
import { DurableRsiProposalSynthesis, HttpRsiProposalSynthesizer } from './rsi-proposal-synthesizer.js';
import { defaultRsiEvaluationSuite, RsiAutomationPump, type RsiAutomationOptions } from './rsi-automation.js';
import { FileReminderStore, PostgresReminderStore, ReminderPump, type ReminderStore } from './reminders.js';
import { CachedPrincipalDirectory, HttpPrincipalDirectory, JsonPrincipalDirectory, type PrincipalDirectory } from './security/principal-directory.js';
import { HttpChannelIdentityResolver, JsonChannelIdentityResolver, type ChannelIdentityResolver } from './security/channel-identity.js';
import { JsonSessionEventRepository, PostgresSessionEventRepository, SessionEventService, type SessionEventRepository } from './session-events.js';
import { loadFileEnvironment } from './config-secrets.js';

// Validate credentials before opening stores and acquiring writer locks.
loadFileEnvironment();
validateRuntimeConfig();
const principalTokens = process.env.AEEIS_PRINCIPAL_TOKENS === undefined ? undefined
  : principalTokensSchema.parse(JSON.parse(process.env.AEEIS_PRINCIPAL_TOKENS));
const oidcEnvPresent = ['AEEIS_OIDC_ISSUER', 'AEEIS_OIDC_AUDIENCE', 'AEEIS_OIDC_JWKS_URL'].some(name => process.env[name] !== undefined);
let oidcResolver: ReturnType<OidcPrincipalResolver['resolver']> | undefined;
if (oidcEnvPresent) {
  const issuer = process.env.AEEIS_OIDC_ISSUER;
  const audience = process.env.AEEIS_OIDC_AUDIENCE;
  const jwksUrl = process.env.AEEIS_OIDC_JWKS_URL;
  if (!issuer || !audience || !jwksUrl) throw new Error('OIDC requires AEEIS_OIDC_ISSUER, AEEIS_OIDC_AUDIENCE and AEEIS_OIDC_JWKS_URL');
  const config: OidcConfig = { issuer, audience, jwksUrl,
    ...(process.env.AEEIS_OIDC_TENANT_CLAIM ? { tenantClaim: process.env.AEEIS_OIDC_TENANT_CLAIM } : {}),
    ...(process.env.AEEIS_OIDC_ROLES_CLAIM ? { rolesClaim: process.env.AEEIS_OIDC_ROLES_CLAIM } : {}),
  };
  oidcResolver = new OidcPrincipalResolver(config).resolver();
}
if (principalTokens !== undefined && (process.env.AEEIS_ACCESS_TOKEN || oidcResolver)) throw new Error('Configure only one of AEEIS_ACCESS_TOKEN, AEEIS_PRINCIPAL_TOKENS or OIDC authentication');
if (oidcResolver && process.env.AEEIS_ACCESS_TOKEN) throw new Error('OIDC authentication cannot be combined with AEEIS_ACCESS_TOKEN');
const projectionTargets: ProjectionTarget[] = process.env.AEEIS_PROJECTION_TARGETS === undefined ? [] : z.array(z.object({
  channel: z.string().trim().min(1).max(100), destination: z.string().trim().min(1).max(500),
  aggregateTypes: z.array(z.enum(['room', 'goal', 'plan', 'task', 'run', 'competition', 'debate', 'evolution', 'reminder', 'session_event'])).max(10).optional(),
}).strict()).max(20).parse(JSON.parse(process.env.AEEIS_PROJECTION_TARGETS));
const publicHosts = process.env.AEEIS_PUBLIC_HOSTS === undefined
  ? []
  : process.env.AEEIS_PUBLIC_HOSTS.split(',').map(host => host.trim()).filter(Boolean);
const trustedOrigins = process.env.AEEIS_TRUSTED_ORIGINS === undefined
  ? []
  : process.env.AEEIS_TRUSTED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean);

const repository = process.env.DATABASE_URL
  ? new PostgresRunRepository(process.env.DATABASE_URL)
  : new FileRunRepository(process.env.AEEIS_DATA_DIR ?? 'data/runs');
await repository.init();
const brainEmbedding = process.env.AEEIS_BRAIN_EMBEDDING_URL
  ? new HttpKnowledgeEmbeddingProvider(process.env.AEEIS_BRAIN_EMBEDDING_URL, process.env.AEEIS_BRAIN_EMBEDDING_MODEL ?? 'text-embedding-3-small', process.env.AEEIS_BRAIN_EMBEDDING_API_KEY ?? '', Number(process.env.AEEIS_BRAIN_EMBEDDING_DIMENSIONS ?? 1536), 15_000, process.env.AEEIS_BRAIN_EMBEDDING_HEALTH_URL)
  : undefined;
const brainSemanticIndex = process.env.DATABASE_URL && brainEmbedding
  ? new PostgresBrainSemanticIndex(process.env.DATABASE_URL, brainEmbedding)
  : undefined;
const brainStore = process.env.DATABASE_URL
  ? new PostgresBrainStore(process.env.DATABASE_URL, brainSemanticIndex ? { semanticIndex: brainSemanticIndex } : {})
  : new FileBrainStore(`${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/brain`);
await brainStore.init();
const brain = await brainStore.load();
const evolutionRepository = process.env.DATABASE_URL
  ? new PostgresEvolutionRepository(process.env.DATABASE_URL)
  : new FileEvolutionRepository(`${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/evolution`);
await evolutionRepository.init();
const evolutionActivation = process.env.DATABASE_URL
  ? new PostgresEvolutionActivationStore(process.env.DATABASE_URL)
  : new FileEvolutionActivationStore(`${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/evolution`);
await evolutionActivation.init();
const collaborationRepository = process.env.DATABASE_URL
  ? new PostgresCollaborationRepository(process.env.DATABASE_URL)
  : new FileCollaborationRepository(`${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/collaboration`);
await collaborationRepository.init();
const globalBudgetRules = process.env.AEEIS_GLOBAL_BUDGETS === undefined ? [] : z.array(globalBudgetRuleSchema).max(100).parse(JSON.parse(process.env.AEEIS_GLOBAL_BUDGETS));
const globalBudgetLedger: GlobalBudgetLedger | undefined = globalBudgetRules.length === 0 ? undefined
  : process.env.DATABASE_URL
  ? new PostgresGlobalBudgetLedger(process.env.DATABASE_URL)
  : new FileGlobalBudgetLedger(process.env.AEEIS_GLOBAL_BUDGET_PATH ?? `${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/global-budget.json`);
await globalBudgetLedger?.init();
const rsi = new RsiService(evolutionRepository, evolutionActivation, globalBudgetLedger ? { ledger: globalBudgetLedger, select: createGlobalBudgetSelector(globalBudgetRules) } : undefined);
const rsiProposalClaims: RsiProposalClaimStore = process.env.DATABASE_URL
  ? new PostgresRsiProposalClaimStore(process.env.DATABASE_URL)
  : new FileRsiProposalClaimStore(process.env.AEEIS_RSI_PROPOSAL_CLAIMS_PATH ?? `${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/rsi-proposal-claims.json`);
await rsiProposalClaims.init?.();
const runScanCursors: RunScanCursorStore = process.env.DATABASE_URL
  ? new PostgresRunScanCursorStore(process.env.DATABASE_URL)
  : new FileRunScanCursorStore(process.env.AEEIS_RUN_SCAN_CURSOR_PATH ?? `${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/run-scan-cursors.json`);
await runScanCursors.init();
const rsiProposalPump = new RsiProposalPump(repository, rsi, {
  maxSignalsPerPass: Number(process.env.AEEIS_RSI_PROPOSAL_BATCH ?? 100),
  lowConfidenceThreshold: Number(process.env.AEEIS_RSI_LOW_CONFIDENCE_THRESHOLD ?? 0.5),
  claimLeaseMs: Number(process.env.AEEIS_RSI_PROPOSAL_CLAIM_LEASE_MS ?? 30_000),
  claimStore: rsiProposalClaims,
  scanCursorStore: runScanCursors,
  onError: (error, run, event) => console.error('AEEIS RSI proposal pump failed', { runId: run.id, eventId: event.id, error: error instanceof Error ? error.message : error }),
});
let rsiProposalSynthesis: DurableRsiProposalSynthesis | undefined;
const grantLedger = process.env.DATABASE_URL
  ? new PostgresGrantLedger(process.env.DATABASE_URL)
  : new FileGrantLedger(`${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/agent-grants.json`);
await grantLedger.init();
const collaboration = new CollaborationService(collaborationRepository, globalBudgetLedger ? { ledger: globalBudgetLedger, select: createGlobalBudgetSelector(globalBudgetRules) } : undefined);
const collaborationTriggerStore = process.env.DATABASE_URL
  ? new PostgresCollaborationTriggerStore(process.env.DATABASE_URL)
  : new FileCollaborationTriggerStore(process.env.AEEIS_COLLABORATION_TRIGGERS_PATH ?? `${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/collaboration-triggers`);
await collaborationTriggerStore.init();
const collaborationTriggers = new CollaborationTriggerService(collaborationTriggerStore, collaboration);
const collaborationTriggerPump = new CollaborationTriggerPump(repository, collaborationTriggers, {
  scanCursorStore: runScanCursors,
  scanCursorName: 'collaboration-trigger-pump',
  onError: (error, run, event) => console.error('AEEIS collaboration trigger pump failed', { runId: run.id, eventId: event.id, error: error instanceof Error ? error.message : error }),
});
const projection = process.env.DATABASE_URL
  ? new PostgresProjectionOutbox(process.env.DATABASE_URL)
  : new FileProjectionOutbox(`${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/collaboration-projection`);
await projection.init();
const reminderStore: ReminderStore = process.env.DATABASE_URL
  ? new PostgresReminderStore(process.env.DATABASE_URL)
  : new FileReminderStore(process.env.AEEIS_REMINDER_PATH ?? `${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/reminders.json`);
await reminderStore.init();
const reminderPump = new ReminderPump(reminderStore, projection, {
  batchSize: Number(process.env.AEEIS_REMINDER_BATCH ?? 20),
  leaseMs: Number(process.env.AEEIS_REMINDER_LEASE_MS ?? 30_000),
  retryDelayMs: Number(process.env.AEEIS_REMINDER_RETRY_DELAY_MS ?? 30_000),
});
const feishuAppConfigured = Boolean(process.env.AEEIS_FEISHU_APP_ID || process.env.AEEIS_FEISHU_APP_SECRET);
if (feishuAppConfigured && (!process.env.AEEIS_FEISHU_APP_ID || !process.env.AEEIS_FEISHU_APP_SECRET)) throw new Error('Feishu application projection requires AEEIS_FEISHU_APP_ID and AEEIS_FEISHU_APP_SECRET together');
const feishuAllowedChatIds = new Set((process.env.AEEIS_FEISHU_ALLOWED_CHAT_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean));
const projectionRoutes: Record<string, ProjectionSink> = {};
if (feishuAppConfigured) projectionRoutes.feishu = new FeishuAppProjectionSink(process.env.AEEIS_FEISHU_APP_ID!, process.env.AEEIS_FEISHU_APP_SECRET!, process.env.AEEIS_FEISHU_API_BASE_URL ?? 'https://open.feishu.cn', process.env.AEEIS_FEISHU_ALLOW_CONFIDENTIAL === '1', feishuAllowedChatIds);
else if (process.env.AEEIS_FEISHU_WEBHOOK_URL) projectionRoutes.feishu = new FeishuWebhookProjectionSink(process.env.AEEIS_FEISHU_WEBHOOK_URL, process.env.AEEIS_FEISHU_ALLOW_CONFIDENTIAL === '1');
if (process.env.AEEIS_HERMES_CLI_PATH) projectionRoutes.hermes = new HermesCliProjectionSink(process.env.AEEIS_HERMES_CLI_PATH, process.env.AEEIS_HERMES_ALLOW_CONFIDENTIAL === '1', Number(process.env.AEEIS_HERMES_CLI_TIMEOUT_MS ?? 30_000));
const genericProjectionSink = process.env.AEEIS_PROJECTION_SINK_URL
  ? new HttpProjectionSink(process.env.AEEIS_PROJECTION_SINK_URL, process.env.AEEIS_PROJECTION_SINK_TOKEN, 30_000, process.env.AEEIS_PROJECTION_SINK_HEALTH_URL)
  : undefined;
const projectionSink = Object.keys(projectionRoutes).length || genericProjectionSink
  ? new RoutingProjectionSink(projectionRoutes, genericProjectionSink)
  : undefined;
const domainStore = process.env.DATABASE_URL
  ? new PostgresAeeisStore(process.env.DATABASE_URL)
  : new JsonFileStore(`${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/domain.json`);
await domainStore.init();
const roomMemberships: RoomMembershipRepository = process.env.DATABASE_URL
  ? new PostgresRoomMembershipRepository(process.env.DATABASE_URL)
  : new JsonRoomMembershipRepository(process.env.AEEIS_ROOM_MEMBERSHIP_PATH ?? `${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/room-memberships.json`);
await (roomMemberships as JsonRoomMembershipRepository | PostgresRoomMembershipRepository).init();
const principalDirectoryBackend: PrincipalDirectory | undefined = process.env.AEEIS_PRINCIPAL_DIRECTORY_URL
  ? new HttpPrincipalDirectory(process.env.AEEIS_PRINCIPAL_DIRECTORY_URL, process.env.AEEIS_PRINCIPAL_DIRECTORY_TOKEN, Number(process.env.AEEIS_PRINCIPAL_DIRECTORY_TIMEOUT_MS ?? 5000), process.env.AEEIS_PRINCIPAL_DIRECTORY_ALLOW_INSECURE_HTTP === '1')
  : process.env.AEEIS_PRINCIPAL_DIRECTORY_PATH
  ? new JsonPrincipalDirectory(process.env.AEEIS_PRINCIPAL_DIRECTORY_PATH)
  : undefined;
const principalDirectory: PrincipalDirectory | undefined = principalDirectoryBackend
  ? new CachedPrincipalDirectory(principalDirectoryBackend, {
      ttlMs: Number(process.env.AEEIS_PRINCIPAL_DIRECTORY_CACHE_TTL_MS ?? 10_000),
      maxEntries: Number(process.env.AEEIS_PRINCIPAL_DIRECTORY_CACHE_MAX_ENTRIES ?? 10_000),
    })
  : undefined;
await principalDirectory?.init?.();
const channelIdentityResolver: ChannelIdentityResolver | undefined = process.env.AEEIS_CHANNEL_IDENTITY_URL
  ? new HttpChannelIdentityResolver(process.env.AEEIS_CHANNEL_IDENTITY_URL, process.env.AEEIS_CHANNEL_IDENTITY_TOKEN, Number(process.env.AEEIS_CHANNEL_IDENTITY_TIMEOUT_MS ?? 5000), process.env.AEEIS_CHANNEL_IDENTITY_ALLOW_INSECURE_HTTP === '1')
  : process.env.AEEIS_CHANNEL_IDENTITY_PATH
  ? new JsonChannelIdentityResolver(process.env.AEEIS_CHANNEL_IDENTITY_PATH)
  : undefined;
await channelIdentityResolver?.init?.();
const domain = new AeeisService(domainStore, projectionTargets, roomMemberships, principalDirectory);
const sessionEventRepository: SessionEventRepository = process.env.DATABASE_URL
  ? new PostgresSessionEventRepository(process.env.DATABASE_URL)
  : new JsonSessionEventRepository(process.env.AEEIS_SESSION_EVENTS_PATH ?? `${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/session-events.json`);
await sessionEventRepository.init?.();
const sessionEvents = new SessionEventService(sessionEventRepository, domain);
const taskDispatchRepository = process.env.DATABASE_URL
  ? new PostgresTaskDispatchRepository(process.env.DATABASE_URL)
  : new FileTaskDispatchRepository(process.env.AEEIS_TASK_DISPATCH_PATH ?? `${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/task-dispatch.json`);
await taskDispatchRepository.init();
const projectSourceCheckpoints: ProjectSourceCheckpointStore = process.env.DATABASE_URL
  ? new PostgresProjectSourceCheckpointStore(process.env.DATABASE_URL)
  : new FileProjectSourceCheckpointStore(process.env.AEEIS_PROJECT_SOURCE_CHECKPOINT_PATH ?? `${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/project-source-checkpoints.json`);
await projectSourceCheckpoints.init?.();
const rsiHarness = process.env.AEEIS_RSI_EVALUATOR_URL
  ? new HttpRsiEvaluationHarness(process.env.AEEIS_RSI_EVALUATOR_URL, process.env.AEEIS_RSI_EVALUATOR_TOKEN, 60_000, process.env.AEEIS_RSI_EVALUATOR_ALLOW_INSECURE_HTTP === '1', process.env.AEEIS_RSI_EVALUATOR_HEALTH_URL)
  : undefined;
let rsiAutomation: RsiAutomationPump | undefined;
if (process.env.AEEIS_RSI_AUTOMATION_ENABLED === '1') {
  if (!rsiHarness) throw new Error('RSI automation requires AEEIS_RSI_EVALUATOR_URL');
  let suite = defaultRsiEvaluationSuite;
  if (process.env.AEEIS_RSI_EVALUATION_SUITE) {
    const parsed: unknown = JSON.parse(process.env.AEEIS_RSI_EVALUATION_SUITE);
    // The suite is parsed once at startup and then treated as immutable for
    // the lifetime of the process. Candidate proposals cannot alter it.
    const parsedSuite = evaluationSuiteSchema.parse(parsed);
    suite = { replay: parsedSuite.replay, holdout: parsedSuite.holdout, safety: parsedSuite.safety, ...(parsedSuite.cost ? { cost: parsedSuite.cost } : {}), ...(parsedSuite.shadow ? { shadow: parsedSuite.shadow } : {}) };
  }
  const automationOptions: RsiAutomationOptions = {
    enabled: true,
    autoApproveLowRisk: process.env.AEEIS_RSI_AUTO_APPROVE_LOW_RISK === '1',
    autoRollout: process.env.AEEIS_RSI_AUTO_ROLLOUT !== '0',
    autoActivate: process.env.AEEIS_RSI_AUTO_ACTIVATE === '1',
    intervalMs: Number(process.env.AEEIS_RSI_AUTOMATION_INTERVAL_MS ?? 30_000),
    maxCandidatesPerPass: Number(process.env.AEEIS_RSI_AUTOMATION_BATCH ?? 10),
    suite,
    suiteVersion: process.env.AEEIS_RSI_EVALUATION_SUITE_VERSION ?? 'internal-v1',
    ...(process.env.AEEIS_RSI_AUTOMATION_MINIMUM_SCORE === undefined ? {} : { minimumScore: Number(process.env.AEEIS_RSI_AUTOMATION_MINIMUM_SCORE) }),
    onError: (candidate, error) => console.error('AEEIS RSI automation failed', { candidateId: candidate.id, status: candidate.status, error: error instanceof Error ? error.message : error }),
  };
  rsiAutomation = new RsiAutomationPump(rsi, rsiHarness, automationOptions);
}
const agentDirectory: AgentDirectoryPort & { close?: () => Promise<void> } = process.env.DATABASE_URL && !process.env.AEEIS_AGENT_REGISTRY_PATH
  ? new PostgresAgentDirectory(process.env.DATABASE_URL)
  : new AgentDirectory(process.env.AEEIS_AGENT_REGISTRY_PATH ?? `${process.env.AEEIS_DATA_DIR ?? 'data/runs'}/agent-registry.json`);
if (agentDirectory instanceof PostgresAgentDirectory) await agentDirectory.init();
let engine: AgentEngine | undefined, dispatcher: Dispatcher | undefined, taskScheduler: TaskScheduler | undefined;
let competitionRunner: ModelPoolCandidateRunner | undefined;
let competitionEvaluator: ModelPoolIndependentEvaluator | undefined;
let debateRunner: ModelPoolDebateOrchestrator | undefined;
let feishuDebateIngress: FeishuDebateIngress | undefined;
let hermesDebateIngress: HermesDebateIngress | undefined;
try {
  const toolkit = process.env.AEEIS_TOOLKIT_REGISTRY_URL
    ? new ToolkitRegistryGateway(
      process.env.AEEIS_TOOLKIT_REGISTRY_URL,
      process.env.AEEIS_TOOLKIT_TOKEN,
      {
        verifySignatures: process.env.AEEIS_TOOLKIT_VERIFY_SIGNATURES === '1' || (process.env.AEEIS_ENV === 'production' && process.env.AEEIS_TOOLKIT_VERIFY_SIGNATURES !== '0'),
        ...(process.env.AEEIS_TOOLKIT_ROOT_PUBLIC_JWK ? { rootPublicJwk: z.record(z.string(), z.unknown()).parse(JSON.parse(process.env.AEEIS_TOOLKIT_ROOT_PUBLIC_JWK)) } : {}),
        ...(process.env.AEEIS_TOOLKIT_RECONCILE_URL ? { reconcileUrl: process.env.AEEIS_TOOLKIT_RECONCILE_URL } : {}),
        ...(process.env.AEEIS_TOOLKIT_PINNED_TOOLS ? {
          additionalTools: z.array(z.object({
            id: z.string().trim().min(1).max(200), version: z.string().trim().min(1).max(100), endpoint: z.string().url(),
            capabilities: z.array(z.string().trim().min(1).max(100)).max(20).optional(), description: z.string().max(4000).optional(),
            inputSchema: z.unknown().optional(), outputSchema: z.unknown().optional(),
          }).strict()).max(20).parse(JSON.parse(process.env.AEEIS_TOOLKIT_PINNED_TOOLS)).map(tool => ({
            id: tool.id, version: tool.version, endpoint: tool.endpoint,
            ...(tool.capabilities === undefined ? {} : { capabilities: tool.capabilities }),
            ...(tool.description === undefined ? {} : { description: tool.description }),
            ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
            ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
          })),
        } : {}),
      },
    )
    : process.env.AEEIS_TOOLKIT_MANIFEST_URL && process.env.AEEIS_TOOLKIT_INVOKE_URL
    ? new ConfiguredHttpToolGateway(process.env.AEEIS_TOOLKIT_MANIFEST_URL, process.env.AEEIS_TOOLKIT_INVOKE_URL, process.env.AEEIS_TOOLKIT_TOKEN, process.env.AEEIS_TOOLKIT_RECONCILE_URL)
    : undefined;
  const skills = process.env.AEEIS_OWNHOW_ENABLED === '1'
    ? new OwnHowCliGovernance(process.env.AEEIS_OWNHOW_BIN ?? 'ownhow', process.env.AEEIS_OWNHOW_STATE_DIR, process.env.AEEIS_OWNHOW_RUNTIME)
    : undefined;
  if (process.env.AEEIS_FEISHU_EVENT_ENCRYPT_KEY) {
    const routes = process.env.AEEIS_FEISHU_DEBATE_ROUTES ? z.array(feishuDebateRouteSchema).max(100).parse(JSON.parse(process.env.AEEIS_FEISHU_DEBATE_ROUTES)) : [];
    const senderAgentIds = process.env.AEEIS_FEISHU_SENDER_AGENTS ? z.record(z.string().min(1).max(500), z.string().min(1).max(128)).parse(JSON.parse(process.env.AEEIS_FEISHU_SENDER_AGENTS)) : {};
    feishuDebateIngress = new FeishuDebateIngress({ collaboration, routes, senderAgentIds, ...(channelIdentityResolver ? { channelIdentityResolver } : {}), encryptKey: process.env.AEEIS_FEISHU_EVENT_ENCRYPT_KEY, onTrigger: event => collaborationTriggers.evaluate(event, { owner: event.owner, tenantId: event.tenantId }).then(() => undefined), ...(process.env.AEEIS_FEISHU_VERIFICATION_TOKEN ? { verificationToken: process.env.AEEIS_FEISHU_VERIFICATION_TOKEN } : {}) });
  }
  if (process.env.AEEIS_HERMES_SIGNING_KEYS) {
    const routes = process.env.AEEIS_HERMES_DEBATE_ROUTES ? z.array(hermesDebateRouteSchema).max(100).parse(JSON.parse(process.env.AEEIS_HERMES_DEBATE_ROUTES)) : [];
    const senderAgentIds = process.env.AEEIS_HERMES_SENDER_AGENTS ? z.record(z.string().min(1).max(500), z.string().min(1).max(128)).parse(JSON.parse(process.env.AEEIS_HERMES_SENDER_AGENTS)) : {};
    const signingKeys = z.record(z.string().min(1).max(128), z.string().min(16).max(1000)).parse(JSON.parse(process.env.AEEIS_HERMES_SIGNING_KEYS));
    hermesDebateIngress = new HermesDebateIngress({ collaboration, routes, senderAgentIds, ...(channelIdentityResolver ? { channelIdentityResolver } : {}), signingKeys, onTrigger: event => collaborationTriggers.evaluate(event, { owner: event.owner, tenantId: event.tenantId }).then(() => undefined) });
  }
  let signingKeys: Record<string, string> = {};
  if (process.env.AEEIS_AGENT_SIGNING_KEYS) {
    const parsed: unknown = JSON.parse(process.env.AEEIS_AGENT_SIGNING_KEYS);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AEEIS_AGENT_SIGNING_KEYS must be a JSON object');
    signingKeys = Object.fromEntries(Object.entries(parsed).map(([key, value]) => {
      if (typeof value !== 'string' || value.length < 16) throw new Error('Agent signing keys must be strings of at least 16 characters');
      return [key, value];
    }));
  }
  let oauthProvider: OAuthClientCredentialsProvider | undefined;
  if (process.env.AEEIS_AGENT_OAUTH_CONFIG) {
    const configs = oauthClientConfigsSchema.parse(JSON.parse(process.env.AEEIS_AGENT_OAUTH_CONFIG));
    oauthProvider = new OAuthClientCredentialsProvider(configs);
  }
  const agentEndpointHosts = process.env.AEEIS_AGENT_ALLOWED_HOSTS === undefined ? [] : process.env.AEEIS_AGENT_ALLOWED_HOSTS.split(',').map(host => host.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
  const agents: AgentGateway = new AgentGateway(agentDirectory, new HttpAgentTransport(60_000, process.env.AEEIS_AGENT_BEARER_TOKEN, signingKeys, oauthProvider, process.env.AEEIS_AGENT_ALLOW_INSECURE_HTTP === '1', agentEndpointHosts), grantLedger, signingKeys);
  if (process.env.AEEIS_AGENT_CARDS) {
    const cards = JSON.parse(process.env.AEEIS_AGENT_CARDS) as unknown;
    if (!Array.isArray(cards)) throw new Error('AEEIS_AGENT_CARDS must be a JSON array');
    for (const card of cards) await agentDirectory.register(agentCardSchema.parse(card));
  }
  let knowledge: KnowledgeProvider | undefined;
  if (process.env.AEEIS_KNOWLEDGE_URL) knowledge = new HttpKnowledgeProvider(process.env.AEEIS_KNOWLEDGE_URL, process.env.AEEIS_KNOWLEDGE_TOKEN, 15_000, process.env.AEEIS_KNOWLEDGE_HEALTH_URL);
  else if (process.env.AEEIS_KNOWLEDGE_FILE) knowledge = new FileKnowledgeProvider(process.env.AEEIS_KNOWLEDGE_FILE);
  else if (process.env.AEEIS_KNOWLEDGE_DATABASE_URL || process.env.DATABASE_URL) {
    const embedding = process.env.AEEIS_KNOWLEDGE_EMBEDDING_URL
      ? new HttpKnowledgeEmbeddingProvider(process.env.AEEIS_KNOWLEDGE_EMBEDDING_URL, process.env.AEEIS_KNOWLEDGE_EMBEDDING_MODEL ?? 'text-embedding-3-small', process.env.AEEIS_KNOWLEDGE_EMBEDDING_API_KEY ?? '', Number(process.env.AEEIS_KNOWLEDGE_EMBEDDING_DIMENSIONS ?? 1536))
      : undefined;
    const provider = new PostgresKnowledgeProvider(process.env.AEEIS_KNOWLEDGE_DATABASE_URL ?? process.env.DATABASE_URL!, embedding ? { embedding } : {});
    await provider.init(); knowledge = provider;
  }
  const remoteProjectSources: ProjectSourceProvider | undefined = process.env.AEEIS_PROJECT_SOURCES_URL
    ? new HttpProjectSourceProvider(process.env.AEEIS_PROJECT_SOURCES_URL, process.env.AEEIS_PROJECT_SOURCES_TOKEN, 15_000, process.env.AEEIS_PROJECT_SOURCES_HEALTH_URL)
    : process.env.AEEIS_PROJECT_SOURCES_FILE
    ? new FileProjectSourceProvider(process.env.AEEIS_PROJECT_SOURCES_FILE)
    : undefined;
  const gitProjects = process.env.AEEIS_PROJECT_GIT
    ? z.array(gitProjectConfigSchema).min(1).max(10).parse(JSON.parse(process.env.AEEIS_PROJECT_GIT)) : [];
  if (new Set(gitProjects.map(project => project.id)).size !== gitProjects.length) throw new Error('Git project IDs must be unique');
  const linearProjects = process.env.AEEIS_LINEAR_PROJECT_SOURCES
    ? z.array(linearProjectConfigSchema).min(1).max(20).parse(JSON.parse(process.env.AEEIS_LINEAR_PROJECT_SOURCES)) : [];
  if (new Set(linearProjects.map(project => project.id)).size !== linearProjects.length) throw new Error('Linear project IDs must be unique');
  const jiraProjects = process.env.AEEIS_JIRA_PROJECT_SOURCES
    ? z.array(jiraProjectConfigSchema).min(1).max(20).parse(JSON.parse(process.env.AEEIS_JIRA_PROJECT_SOURCES)) : [];
  if (new Set(jiraProjects.map(project => project.id)).size !== jiraProjects.length) throw new Error('Jira project IDs must be unique');
  const sourceProviders = [
    ...(remoteProjectSources ? [remoteProjectSources] : []),
    ...gitProjects.map(project => new GitProjectSourceProvider(project)),
    ...linearProjects.map(project => new LinearProjectSourceProvider(project)),
    ...jiraProjects.map(project => new JiraProjectSourceProvider(project)),
  ];
  const projectSources = sourceProviders.length ? new CombinedProjectSourceProvider(sourceProviders) : undefined;
  let modelServices: ConstructorParameters<typeof AgentEngine>[1] | undefined;
  let rsiModelResolver: ModelResolver | undefined;
  if (process.env.AEEIS_MODEL_BASE_URL && process.env.AEEIS_MODEL) {
    const model = new HttpModelAdapter(process.env.AEEIS_MODEL_BASE_URL, process.env.AEEIS_MODEL, process.env.AEEIS_MODEL_API_KEY ?? '', undefined, 60_000, process.env.AEEIS_MODEL_HEALTH_URL, process.env.AEEIS_MODEL_ALLOW_INSECURE_HTTP === '1');
    modelServices = { model }; rsiModelResolver = new StaticModelResolver(model);
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
    const cacheTtlRaw = process.env.AEEIS_PLANPRICE_CACHE_TTL_MS;
    const cacheTtlMs = cacheTtlRaw === undefined ? undefined : Number(cacheTtlRaw);
    if (cacheTtlMs !== undefined && (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0)) throw new Error('AEEIS_PLANPRICE_CACHE_TTL_MS must be a finite non-negative number');
    const allowInsecurePlanprice = process.env.AEEIS_PLANPRICE_ALLOW_INSECURE_HTTP === '1';
    let privateDataAllowed: Record<string, boolean> = {};
    if (process.env.AEEIS_MODEL_PRIVATE_DATA_ALLOWED) {
      const parsed: unknown = JSON.parse(process.env.AEEIS_MODEL_PRIVATE_DATA_ALLOWED);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AEEIS_MODEL_PRIVATE_DATA_ALLOWED must be a JSON object');
      privateDataAllowed = Object.fromEntries(Object.entries(parsed).map(([key, value]) => {
        if (!key.trim() || typeof value !== 'boolean') throw new Error('AEEIS_MODEL_PRIVATE_DATA_ALLOWED entries must map provider/model names to booleans');
        return [key, value];
      }));
    }
    const planpriceProtocol = process.env.AEEIS_PLANPRICE_PROTOCOL === 'v1' ? 'v1' : 'compatibility';
    const planpriceToken = process.env.AEEIS_PLANPRICE_BEARER_TOKEN;
    let catalog: ModelCatalog;
    let planpriceMappings: ProviderMapping[] = [];
    if (planpriceProtocol === 'v1') {
      if (process.env.AEEIS_PLANPRICE_MAPPINGS) {
        const parsed: unknown = JSON.parse(process.env.AEEIS_PLANPRICE_MAPPINGS);
        if (!Array.isArray(parsed)) throw new Error('AEEIS_PLANPRICE_MAPPINGS must be a JSON array');
        planpriceMappings = parsed as ProviderMapping[];
      }
      catalog = new PlanpriceV1Catalog(process.env.AEEIS_PLANPRICE_URL, { mappings: planpriceMappings, ...(planpriceToken ? { token: planpriceToken } : {}), ...(process.env.AEEIS_PLANPRICE_HEALTH_URL ? { healthUrl: process.env.AEEIS_PLANPRICE_HEALTH_URL } : {}), ...(cacheTtlMs === undefined ? {} : { cacheTtlMs }), allowAnonymousDevelopment: allowInsecurePlanprice });
    } else {
      catalog = new PlanpriceHttpCatalog(process.env.AEEIS_PLANPRICE_URL, endpoints, { ...(cacheTtlMs === undefined ? {} : { cacheTtlMs }), allowInsecureHttp: allowInsecurePlanprice, privateDataAllowed, protocol: planpriceProtocol, ...(planpriceToken ? { bearerToken: planpriceToken } : {}), ...(process.env.AEEIS_PLANPRICE_HEALTH_URL ? { healthUrl: process.env.AEEIS_PLANPRICE_HEALTH_URL } : {}) });
    }
    let providerKeys: Record<string, string> = {};
    if (process.env.AEEIS_MODEL_PROVIDER_KEYS) {
      const parsed: unknown = JSON.parse(process.env.AEEIS_MODEL_PROVIDER_KEYS);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AEEIS_MODEL_PROVIDER_KEYS must be a JSON object');
      providerKeys = Object.fromEntries(Object.entries(parsed).map(([key, value]) => {
        if (typeof value !== 'string') throw new Error('Model provider key must be a string');
        return [key, value];
      }));
    }
    let providerHealthUrls: Record<string, string> = {};
    if (process.env.AEEIS_MODEL_PROVIDER_HEALTH_URLS) {
      const parsed: unknown = JSON.parse(process.env.AEEIS_MODEL_PROVIDER_HEALTH_URLS);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AEEIS_MODEL_PROVIDER_HEALTH_URLS must be a JSON object');
      providerHealthUrls = Object.fromEntries(Object.entries(parsed).map(([key, value]) => {
        if (typeof value !== 'string') throw new Error('Model provider health URL must be a string');
        return [key, value];
      }));
    }
    const resolver = new CatalogModelResolver(catalog, new HttpCatalogModelFactory(providerKeys, providerHealthUrls, process.env.AEEIS_MODEL_PROVIDER_ALLOW_INSECURE_HTTP === '1', planpriceMappings));
    modelServices = { resolver }; rsiModelResolver = resolver;
  }
  if (process.env.AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED === '1') {
    if (!rsiModelResolver) throw new Error('RSI proposal synthesis requires a configured model or Planprice resolver');
    const allowedPrivacy = z.array(z.enum(['public', 'internal', 'confidential', 'private'])).min(1).parse((process.env.AEEIS_RSI_PROPOSAL_SYNTHESIS_PRIVACY ?? 'public,internal').split(',').map(value => value.trim()));
    if (!allowedPrivacy.length) throw new Error('AEEIS_RSI_PROPOSAL_SYNTHESIS_PRIVACY must contain at least one supported privacy class');
    const synthesisPrices = process.env.AEEIS_RSI_PROPOSAL_SYNTHESIS_PRICES === undefined
      ? undefined
      : collaborationPricesSchema.parse(JSON.parse(process.env.AEEIS_RSI_PROPOSAL_SYNTHESIS_PRICES));
    if (synthesisPrices && !(rsiModelResolver instanceof StaticModelResolver)) throw new Error('Static RSI synthesis prices require a fixed model; catalog routing must use per-model Planprice prices');
    const synthesizer = new HttpRsiProposalSynthesizer(rsiModelResolver, allowedPrivacy, synthesisPrices);
    const synthesis = new DurableRsiProposalSynthesis(repository, synthesizer, {
      maxCallsPerRun: Number(process.env.AEEIS_RSI_PROPOSAL_SYNTHESIS_MAX_CALLS ?? 1),
      maxTokensPerRun: Number(process.env.AEEIS_RSI_PROPOSAL_SYNTHESIS_MAX_TOKENS ?? 16000),
      ...(globalBudgetLedger ? { globalBudget: { ledger: globalBudgetLedger, select: createGlobalBudgetSelector(globalBudgetRules) } } : {}),
    });
    rsiProposalSynthesis = synthesis;
    rsiProposalPump.setSynthesis(synthesis);
  }
  if (modelServices) {
    engine = new AgentEngine(repository, { ...modelServices, domain, brain, brainPersistence: brainStore, ...(brainSemanticIndex ? { brainSemanticSearcher: brainSemanticIndex } : {}), evolution: rsi, projectSourceCheckpoints, ...(globalBudgetLedger ? { globalBudget: { ledger: globalBudgetLedger, select: createGlobalBudgetSelector(globalBudgetRules) } } : {}), ...(toolkit ? { tools: toolkit } : {}), ...(skills ? { skills } : {}), ...(agents ? { agents } : {}), ...(knowledge ? { knowledge } : {}), ...(projectSources ? { projectSources } : {}) });
    await engine.recover();
    if (process.env.AEEIS_RUNNER === 'temporal') {
      if (!process.env.AEEIS_WORKER_TOKEN) throw new Error('Temporal requires AEEIS_WORKER_TOKEN');
      dispatcher = await TemporalDispatcher.connect(process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233', process.env.AEEIS_TASK_QUEUE ?? 'aeeis-agent', process.env.TEMPORAL_NAMESPACE ?? 'default', process.env.AEEIS_TEMPORAL_WORKER_HEALTH_URL);
    } else dispatcher = new LocalDispatcher(engine);
    taskScheduler = new TaskScheduler(domain, engine, dispatcher, taskDispatchRepository);
    await taskScheduler.init();
  }
  const collaborationResolver = modelServices && typeof modelServices === 'object' && 'resolver' in modelServices ? modelServices.resolver : undefined;
  const staticCompetitionAgents = Boolean(process.env.AEEIS_COMPETITION_AGENT_MODELS);
  const staticCompetitionEvaluator = Boolean(process.env.AEEIS_COMPETITION_EVALUATOR_BASE_URL && process.env.AEEIS_COMPETITION_EVALUATOR_MODEL);
  const allowInsecureCompetitionHttp = process.env.AEEIS_MODEL_ALLOW_INSECURE_HTTP === '1';
  // A Planprice-backed resolver can supply logical competition participants,
  // evaluator and debate roles. Static per-agent endpoints remain supported
  // for isolated model pools and tests.
  if (staticCompetitionAgents || collaborationResolver) {
    if (!staticCompetitionEvaluator && !collaborationResolver) throw new Error('Competition evaluator requires an endpoint/model or Planprice model resolver');
    const agents = new Map<string, HttpModelAdapter>();
    const prices = new Map<string, CollaborationPrices>();
    if (staticCompetitionAgents) {
      const parsed: unknown = JSON.parse(process.env.AEEIS_COMPETITION_AGENT_MODELS!);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AEEIS_COMPETITION_AGENT_MODELS must be a JSON object');
      for (const [agentId, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Competition model config for ${agentId} must be an object`);
        const config = value as Record<string, unknown>;
        if (typeof config.baseUrl !== 'string' || typeof config.model !== 'string') throw new Error(`Competition model config for ${agentId} requires baseUrl and model`);
        if (config.prices !== undefined) prices.set(agentId, collaborationPricesSchema.parse(config.prices));
        agents.set(agentId, new HttpModelAdapter(config.baseUrl, config.model, typeof config.apiKey === 'string' ? config.apiKey : '', typeof config.provider === 'string' ? config.provider : undefined, 60_000, undefined, allowInsecureCompetitionHttp));
      }
    }
    competitionRunner = new ModelPoolCandidateRunner(agents, prices, collaborationResolver);
    const evaluatorAgentId = process.env.AEEIS_COMPETITION_EVALUATOR_AGENT_ID ?? 'agent.evaluator';
    const evaluatorAdapter = staticCompetitionEvaluator
      ? new HttpModelAdapter(process.env.AEEIS_COMPETITION_EVALUATOR_BASE_URL!, process.env.AEEIS_COMPETITION_EVALUATOR_MODEL!, process.env.AEEIS_COMPETITION_EVALUATOR_API_KEY ?? '', undefined, 60_000, undefined, allowInsecureCompetitionHttp)
      : undefined;
    const evaluatorPrices = process.env.AEEIS_COMPETITION_EVALUATOR_PRICES
      ? collaborationPricesSchema.parse(JSON.parse(process.env.AEEIS_COMPETITION_EVALUATOR_PRICES))
      : undefined;
    competitionEvaluator = new ModelPoolIndependentEvaluator(evaluatorAgentId, evaluatorAdapter, evaluatorPrices, collaborationResolver);
    debateRunner = new ModelPoolDebateOrchestrator(collaboration, agents, {
      ...(process.env.AEEIS_DEBATE_MODERATOR_AGENT_ID ? { moderatorAgentId: process.env.AEEIS_DEBATE_MODERATOR_AGENT_ID } : {}),
      ...(process.env.AEEIS_DEBATE_ADJUDICATOR_AGENT_ID ? { adjudicatorAgentId: process.env.AEEIS_DEBATE_ADJUDICATOR_AGENT_ID } : {}),
    }, prices, collaborationResolver);
  }
  collaborationTriggers.setExecutors({
    runCompetition: async (id, scope) => {
      if (!competitionRunner || !competitionEvaluator) throw new Error('Internal competition model pool is not configured');
      return collaboration.runCompetition(id, competitionEvaluator.agentId, competitionRunner, competitionEvaluator, scope);
    },
    runDebate: async (id, scope) => {
      if (!debateRunner) throw new Error('Internal debate model pool is not configured');
      return debateRunner.run(id, scope);
    },
  });
  const trustedHosts = process.env.AEEIS_TRUSTED_HOSTS === undefined ? [] : process.env.AEEIS_TRUSTED_HOSTS.split(',').map(host => host.trim()).filter(Boolean);
  const knowledgeMaintenance = knowledge && 'runEmbeddingReindexBatch' in knowledge && 'enqueueEmbeddingReindex' in knowledge && 'getEmbeddingReindexStatus' in knowledge ? knowledge as unknown as KnowledgeEmbeddingMaintenance : undefined;
  const app = buildApp({ demoMode: process.env.AEEIS_DEMO_MODE === '1', repository, domain, brain, brainStore, ...(brainSemanticIndex ? { brainSemanticIndex } : {}), rsi, ...(rsiProposalSynthesis ? { rsiProposalSynthesis } : {}), ...(rsiAutomation ? { rsiAutomation } : {}), ...(globalBudgetLedger ? { globalBudget: { ledger: globalBudgetLedger, select: createGlobalBudgetSelector(globalBudgetRules) } } : {}), ...(knowledgeMaintenance ? { knowledge: knowledgeMaintenance } : {}), ...(knowledge ? { knowledgeProvider: knowledge } : {}), ...(projectSources ? { projectSourcesProvider: projectSources } : {}), ...(trustedHosts.length ? { trustedHosts } : {}), ...(publicHosts.length ? { publicHosts } : {}), ...(trustedOrigins.length ? { trustedOrigins } : {}), ...(agentEndpointHosts.length ? { agentEndpointHosts } : {}), ...(rsiHarness ? { rsiHarness } : {}), ...(skills ? { skills } : {}), ...(toolkit ? { tools: toolkit } : {}), collaboration, collaborationTriggers, projection, reminders: reminderStore, reminderPump, ...(projectionSink ? { projectionSink } : {}), ...(competitionRunner ? { competitionRunner } : {}), ...(competitionEvaluator ? { competitionEvaluator, competitionEvaluatorAgentId: competitionEvaluator.agentId } : {}), ...(debateRunner ? { debateRunner } : {}), ...(feishuDebateIngress ? { feishuDebateIngress } : {}), ...(hermesDebateIngress ? { hermesDebateIngress } : {}), ...(engine ? { engine } : {}), ...(dispatcher ? { dispatcher } : {}), ...(taskScheduler ? { taskScheduler } : {}),
    ...(process.env.AEEIS_ACCESS_TOKEN ? { token: process.env.AEEIS_ACCESS_TOKEN } : {}),
    ...(process.env.AEEIS_WORKER_TOKEN ? { workerToken: process.env.AEEIS_WORKER_TOKEN } : {}),
    ...(principalTokens ? { principalTokens } : {}),
    ...(oidcResolver ? { principalResolver: oidcResolver } : {}),
    ...(oidcResolver ? { authMode: 'oidc-principal-scoped' } : principalTokens ? { authMode: 'static-principal-scoped' } : {}),
    agentDirectory,
    grantLedger,
    ...(principalDirectory ? { principalDirectory } : {}),
    ...(channelIdentityResolver ? { channelIdentityResolver } : {}),
    sessionEvents,
    ...(process.env.AEEIS_MAX_SSE_CONNECTIONS ? { maxSseConnections: Number(process.env.AEEIS_MAX_SSE_CONNECTIONS) } : {}),
  });
  const compactRun = (run: AgentRun): unknown => ({
    schemaVersion: 'run-snapshot/1', id: run.id, owner: run.owner, tenantId: run.tenantId ?? 'local', goal: run.goal,
    ...(run.goalId ? { goalId: run.goalId } : {}), ...(run.domainPlanId ? { domainPlanId: run.domainPlanId } : {}), ...(run.taskExecution ? { taskExecution: run.taskExecution } : {}), ...(run.followUpPlanId ? { followUpPlanId: run.followUpPlanId } : {}),
    status: run.status, revision: run.revision, privacy: run.privacy, updatedAt: run.updatedAt,
    ...(run.modelBudget ? { modelBudget: run.modelBudget } : {}), ...(run.modelUsage ? { modelUsage: run.modelUsage } : {}),
    ...(run.externalBudget ? { externalBudget: run.externalBudget } : {}), ...(run.externalUsage ? { externalUsage: run.externalUsage } : {}),
    plans: run.plans.map(plan => ({ version: plan.version, summary: plan.summary, hash: plan.hash, nodes: plan.nodes.map(node => ({ id: node.id, title: node.title, dependsOn: node.dependsOn })) })),
    steps: run.steps.map(step => ({ taskId: step.taskId, status: step.status, attempts: step.attempts })),
    // Projection snapshots carry metadata and evidence links only. Structured
    // artifact content stays behind the owner-scoped /api/runs/:id boundary.
    artifacts: run.artifacts.map(artifact => ({ id: artifact.id, taskId: artifact.taskId, title: artifact.title, evidenceRefs: artifact.evidenceRefs, ...(artifact.artifactType ? { artifactType: artifact.artifactType } : {}), hash: artifact.hash })),
    ...(run.review ? { review: run.review } : {}), ...(run.error ? { error: run.error } : {}),
  });
  const compactEvolution = (candidate: EvolutionCandidate): Record<string, unknown> => ({
    schemaVersion: 'evolution-snapshot/1', id: candidate.id, owner: candidate.owner, tenantId: candidate.tenantId,
    ...(candidate.proposalSignalId ? { proposalSignalId: candidate.proposalSignalId } : {}),
    target: candidate.target, baseVersion: candidate.baseVersion, proposedVersion: candidate.proposedVersion, risk: candidate.risk,
    status: candidate.status, reason: candidate.reason, changeHash: digest(candidate.change), privacy: 'internal', sourceReceiptRefs: candidate.sourceReceiptRefs,
    evaluations: candidate.evaluations, ...(candidate.promotedAt ? { promotedAt: candidate.promotedAt } : {}),
    ...(candidate.rolledBackAt ? { rolledBackAt: candidate.rolledBackAt } : {}), createdAt: candidate.createdAt,
  });
  const compactCompetition = (record: CompetitionRecord): unknown => ({
    schemaVersion: 'competition-snapshot/1', id: record.id, owner: record.owner, tenantId: record.tenantId,
    status: record.status, ...(record.usage ? { usage: record.usage } : {}), brief: { ...(record.brief.modelBudget ? { modelBudget: record.brief.modelBudget } : {}), taskId: record.brief.taskId, contextVersion: record.brief.contextVersion, goal: record.brief.goal, expectedResultType: record.brief.expectedResultType, blindEvaluation: record.brief.blindEvaluation, context: { classification: record.brief.context?.classification ?? 'internal' } },
    candidates: record.candidates.map(candidate => ({ agentId: candidate.agentId, status: candidate.status, summary: candidate.summary, resultType: candidate.resultType, cost: candidate.cost })),
    attempts: record.attempts.map(attempt => ({ id: attempt.id, participantAgentId: attempt.participantAgentId, state: attempt.state, ...(attempt.model ? { model: { model: attempt.model.model, ...(attempt.model.provider ? { provider: attempt.model.provider } : {}), promptVersion: attempt.model.promptVersion, ...(attempt.model.catalogHash ? { catalogHash: attempt.model.catalogHash } : {}), ...(attempt.model.catalogRetrievedAt ? { catalogRetrievedAt: attempt.model.catalogRetrievedAt } : {}) } } : {}) })),
    ...(record.evaluatorAttempt ? { evaluatorAttempt: { id: record.evaluatorAttempt.id, state: record.evaluatorAttempt.state, ...(record.evaluatorAttempt.model ? { model: { model: record.evaluatorAttempt.model.model, ...(record.evaluatorAttempt.model.provider ? { provider: record.evaluatorAttempt.model.provider } : {}), promptVersion: record.evaluatorAttempt.model.promptVersion, ...(record.evaluatorAttempt.model.catalogHash ? { catalogHash: record.evaluatorAttempt.model.catalogHash } : {}), ...(record.evaluatorAttempt.model.catalogRetrievedAt ? { catalogRetrievedAt: record.evaluatorAttempt.model.catalogRetrievedAt } : {}) } } : {}) } } : {}),
    scores: record.scores, ...(record.selectedAgentId ? { selectedAgentId: record.selectedAgentId } : {}), totalCost: record.totalCost,
    ...(record.failureReason ? { failureReason: record.failureReason } : {}), updatedAt: record.updatedAt,
  });
  const compactDebate = (record: DebateRecord): unknown => ({
    ...(record.usage ? { usage: record.usage } : {}), ...(record.modelBudget ? { modelBudget: record.modelBudget } : {}),
    schemaVersion: 'debate-snapshot/1', id: record.id, owner: record.owner, tenantId: record.tenantId, status: record.status,
    roles: record.roles, attempts: record.attempts.map(attempt => ({ id: attempt.id, slot: attempt.slot, agentId: attempt.agentId, state: attempt.state, startedAt: attempt.startedAt, endedAt: attempt.endedAt, error: attempt.error, reconciliationReason: attempt.reconciliationReason, ...(attempt.model ? { model: { model: attempt.model.model, ...(attempt.model.provider ? { provider: attempt.model.provider } : {}), promptVersion: attempt.model.promptVersion, ...(attempt.model.catalogHash ? { catalogHash: attempt.model.catalogHash } : {}), ...(attempt.model.catalogRetrievedAt ? { catalogRetrievedAt: attempt.model.catalogRetrievedAt } : {}) } } : {}) })),
    room: { debateId: record.room.debateId, taskId: record.room.taskId, contextVersion: record.room.contextVersion, goal: record.room.goal, participantAgentIds: record.room.participantAgentIds, maxRounds: record.room.maxRounds, context: { classification: record.room.context?.classification ?? 'internal' }, messages: record.room.messages.slice(-50).map(message => ({ messageId: message.messageId, round: message.round, speakerAgentId: message.speakerAgentId, type: message.type, content: message.content.slice(0, 2000), replyTo: message.replyTo })), moderation: (record.room.moderation ?? []).slice(-50), moderatorReviews: (record.room.moderatorReviews ?? []).slice(-50), ...(record.room.adjudication ? { adjudication: record.room.adjudication } : {}) },
    ...(record.closeReason ? { closeReason: record.closeReason } : {}), updatedAt: record.updatedAt,
  });
  const reconcileSnapshots = async (): Promise<void> => {
    if (projectionTargets.length === 0) return;
    const snapshots: ProjectionSnapshot[] = [];
    const flush = async (): Promise<void> => {
      if (!snapshots.length) return;
      const batch = snapshots.splice(0, snapshots.length);
      await reconcileProjectionSnapshots(projectionTargets, projection, batch);
    };
    if (projectionTargets.some(target => !target.aggregateTypes || target.aggregateTypes.includes('room'))) {
      let cursor: string | undefined;
      do {
        const page = await domain.pageRoomsForProjection(50, cursor);
        for (const item of page.items) {
          snapshots.push({ aggregateType: 'room', aggregateId: item.room.id, owner: item.room.owner ?? 'owner', tenantId: item.room.tenantId ?? 'local', payload: { ...item.room, members: item.members } });
          if (snapshots.length >= 50) await flush();
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    if (projectionTargets.some(target => !target.aggregateTypes || target.aggregateTypes.includes('run'))) {
      if (repository.scanPage) {
        let afterId: string | undefined;
        let throughId: string | undefined;
        do {
          const page = await repository.scanPage({ limit: 50, ...(afterId ? { afterId } : {}), ...(throughId ? { throughId } : {}) });
          for (const run of page.runs) {
            snapshots.push({ aggregateType: 'run', aggregateId: run.id, owner: run.owner, tenantId: run.tenantId ?? 'local', payload: compactRun(run) });
            if (snapshots.length >= 50) await flush();
          }
          throughId = page.throughId;
          afterId = page.runs.at(-1)?.id;
          if (page.done) break;
        } while (throughId && afterId);
      } else {
        for (const run of await repository.list()) {
          snapshots.push({ aggregateType: 'run', aggregateId: run.id, owner: run.owner, tenantId: run.tenantId ?? 'local', payload: compactRun(run) });
          if (snapshots.length >= 50) await flush();
        }
      }
    }
    if (projectionTargets.some(target => !target.aggregateTypes || target.aggregateTypes.includes('evolution'))) {
      let cursor: string | undefined;
      do {
        const page = await rsi.page(undefined, 50, cursor);
        // Traffic is stored in a separate activation aggregate. Fetch it once
        // per ownership scope for the page instead of issuing one repository
        // read for every candidate (which becomes an N+1 scan as RSI history
        // grows). The candidate page remains the stable bounded traversal.
        const trafficByScope = new Map<string, Awaited<ReturnType<typeof rsi.listTraffic>>>();
        for (const candidate of page.items) {
          const owner = candidate.owner ?? 'owner';
          const tenantId = candidate.tenantId ?? 'local';
          const scopeKey = `${owner}\u0000${tenantId}`;
          if (!trafficByScope.has(scopeKey)) {
            trafficByScope.set(scopeKey, await rsi.listTraffic({ owner, tenantId }));
          }
        }
        for (const candidate of page.items) {
          const scopeKey = `${candidate.owner ?? 'owner'}\u0000${candidate.tenantId ?? 'local'}`;
          const traffic = (trafficByScope.get(scopeKey) ?? []).filter(route => route.candidateId === candidate.id);
          snapshots.push({ aggregateType: 'evolution', aggregateId: candidate.id, owner: candidate.owner, tenantId: candidate.tenantId, payload: { ...compactEvolution(candidate), ...(traffic.length ? { traffic } : {}) } });
          if (snapshots.length >= 50) await flush();
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    if (projectionTargets.some(target => !target.aggregateTypes || target.aggregateTypes.includes('competition'))) {
      let cursor: string | undefined;
      do {
        const page = await collaboration.pageCompetitions(undefined, 50, cursor);
        for (const record of page.items) {
          snapshots.push({ aggregateType: 'competition', aggregateId: record.id, owner: record.owner, tenantId: record.tenantId, payload: compactCompetition(record) });
          if (snapshots.length >= 50) await flush();
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    if (projectionTargets.some(target => !target.aggregateTypes || target.aggregateTypes.includes('debate'))) {
      let cursor: string | undefined;
      do {
        const page = await collaboration.pageDebates(undefined, 50, cursor);
        for (const record of page.items) {
          snapshots.push({ aggregateType: 'debate', aggregateId: record.id, owner: record.owner, tenantId: record.tenantId, payload: compactDebate(record) });
          if (snapshots.length >= 50) await flush();
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    await flush();
  };
  let projectionPumpBusy = false;
  const runProjectionPump = async (): Promise<void> => {
    if (projectionPumpBusy) return;
    projectionPumpBusy = true;
    try { await domain.drainProjectionIntents(projection); await reconcileSnapshots(); }
    catch (error) { console.error('AEEIS projection pump failed', error instanceof Error ? error.message : error); }
    finally { projectionPumpBusy = false; }
  };
  // Shutdown is a first-class lifecycle boundary. Timers and LISTEN callbacks
  // can otherwise enqueue a new scan while the stores are being closed.
  let closing = false;
  const backgroundWork = new Set<Promise<unknown>>();
  const trackBackground = (work: Promise<unknown>): void => {
    backgroundWork.add(work);
    void work.then(
      () => { backgroundWork.delete(work); },
      () => { backgroundWork.delete(work); },
    );
  };
  const projectionPump = setInterval(() => { if (!closing) trackBackground(runProjectionPump()); }, 1000);
  projectionPump.unref();
  // Run repositories may provide a low-latency change hint (PostgreSQL
  // LISTEN/NOTIFY or the local in-process adapter). It never advances a
  // cursor and never carries business state: the replayable scanners remain
  // the recovery boundary. A dropped notification therefore only adds the
  // normal polling latency.
  const rsiProposalIntervalMs = Number(process.env.AEEIS_RSI_PROPOSAL_INTERVAL_MS ?? 1000);
  let lastChangeWakeAt = 0;
  let unsubscribeRunChanges: (() => Promise<void>) | undefined;
  if (repository.subscribeChanges) {
    try {
      unsubscribeRunChanges = await repository.subscribeChanges(() => {
        if (closing) return;
        if (Date.now() - lastChangeWakeAt < 250) return;
        lastChangeWakeAt = Date.now();
        const collaborationWork = collaborationTriggerPump.pump().catch(error => console.error('AEEIS collaboration trigger changefeed failed', error instanceof Error ? error.message : error));
        trackBackground(collaborationWork);
        if (rsiProposalIntervalMs > 0) {
          const rsiWork = rsiProposalPump.pump().catch(error => console.error('AEEIS RSI proposal changefeed failed', error instanceof Error ? error.message : error));
          trackBackground(rsiWork);
        }
      });
    } catch (error) {
      // Notifications are an optional latency optimization. Startup and the
      // durable polling pumps remain available when LISTEN is unavailable.
      console.error('AEEIS run change notifications unavailable; using polling', error instanceof Error ? error.message : error);
    }
  }
  const collaborationTriggerPumpTimer = setInterval(() => {
    if (closing) return;
    const work = collaborationTriggerPump.pump().catch(error => console.error('AEEIS collaboration trigger pump failed', error instanceof Error ? error.message : error));
    trackBackground(work);
  }, 1000);
  collaborationTriggerPumpTimer.unref();
  if (!Number.isFinite(rsiProposalIntervalMs) || (rsiProposalIntervalMs !== 0 && rsiProposalIntervalMs < 1000)) throw new Error('AEEIS_RSI_PROPOSAL_INTERVAL_MS must be 0 or at least 1000 milliseconds');
  const rsiProposalPumpTimer = rsiProposalIntervalMs > 0 ? setInterval(() => {
    if (closing) return;
    const work = rsiProposalPump.pump().catch(error => console.error('AEEIS RSI proposal pump failed', error instanceof Error ? error.message : error));
    trackBackground(work);
  }, rsiProposalIntervalMs) : undefined;
  rsiProposalPumpTimer?.unref();
  const rsiAutomationTimer = rsiAutomation ? setInterval(() => {
    if (closing) return;
    const work = rsiAutomation!.pump().catch(error => console.error('AEEIS RSI automation pump failed', error instanceof Error ? error.message : error));
    trackBackground(work);
  }, rsiAutomation.status().intervalMs) : undefined;
  rsiAutomationTimer?.unref();
  const taskSchedulerPump = taskScheduler ? setInterval(() => {
    if (closing) return;
    const work = (async () => {
      const scopes = taskDispatchRepository.listScopes
        ? await taskDispatchRepository.listScopes()
        : [...new Map((await taskDispatchRepository.list()).map(record => [`${record.owner}:${record.tenantId}`, { owner: record.owner, tenantId: record.tenantId }])).values()];
      await Promise.all(scopes.map(scope => taskScheduler!.reconcileAll(scope)));
    })().catch(error => console.error('AEEIS task scheduler pump failed', error instanceof Error ? error.message : error));
    trackBackground(work);
  }, 1000) : undefined;
  taskSchedulerPump?.unref();
  const reminderIntervalMs = Number(process.env.AEEIS_REMINDER_INTERVAL_MS ?? 1000);
  if (!Number.isFinite(reminderIntervalMs) || (reminderIntervalMs !== 0 && reminderIntervalMs < 250)) throw new Error('AEEIS_REMINDER_INTERVAL_MS must be 0 or at least 250 milliseconds');
  const reminderPumpTimer = reminderIntervalMs > 0 ? setInterval(() => {
    if (closing) return;
    const work = reminderPump.pump().catch(error => console.error('AEEIS reminder pump failed', error instanceof Error ? error.message : error));
    trackBackground(work);
  }, reminderIntervalMs) : undefined;
  reminderPumpTimer?.unref();
  const reindexIntervalMs = Number(process.env.AEEIS_KNOWLEDGE_REINDEX_INTERVAL_MS ?? 0);
  if (!Number.isFinite(reindexIntervalMs) || (reindexIntervalMs !== 0 && reindexIntervalMs < 1000)) throw new Error('AEEIS_KNOWLEDGE_REINDEX_INTERVAL_MS must be 0 or at least 1000 milliseconds');
  const knowledgeReindexPump = knowledgeMaintenance && reindexIntervalMs > 0 ? setInterval(() => {
    if (closing) return;
    const work = knowledgeMaintenance.runEmbeddingReindexBatch().catch(error => console.error('AEEIS knowledge embedding reindex failed', error instanceof Error ? error.message : error));
    trackBackground(work);
  }, reindexIntervalMs) : undefined;
  knowledgeReindexPump?.unref();
  await runProjectionPump();
  await collaborationTriggerPump.pump();
  if (rsiProposalIntervalMs > 0) await rsiProposalPump.pump();
  if (rsiAutomation) await rsiAutomation.pump();
  await reminderPump.pump();
  // Reattach pre-existing reminders to their deterministic Temporal timer
  // workflows after an API restart. Starting an already-running workflow is
  // idempotent in TemporalDispatcher, while the Reminder store/Outbox remain
  // the authority for claim and delivery.
  if (dispatcher?.notifyReminder) {
    if (reminderStore.listActivePage) {
      let cursor: string | undefined;
      do {
        const page = await reminderStore.listActivePage(100, cursor);
        for (const reminder of page.items) await dispatcher.notifyReminder(reminder.id);
        cursor = page.nextCursor;
      } while (cursor);
    } else {
      for (const reminder of await reminderStore.list()) {
        if (!['projected', 'cancelled'].includes(reminder.status)) await dispatcher.notifyReminder(reminder.id);
      }
    }
  }
  if (taskScheduler) {
    const scopes = taskDispatchRepository.listScopes
      ? await taskDispatchRepository.listScopes()
      : [...new Map((await taskDispatchRepository.list()).map(record => [`${record.owner}:${record.tenantId}`, { owner: record.owner, tenantId: record.tenantId }])).values()];
    await Promise.all(scopes.map(scope => taskScheduler!.reconcileAll(scope)));
  }
  const port = Number(process.env.PORT ?? 4323);
  const host = process.env.AEEIS_HOST ?? '127.0.0.1';
  await app.listen({ port, host });
  console.log(`AEEIS: http://${host}:${port} (${engine ? 'model configured' : 'model configuration required'})`);
  if (dispatcher) {
    if (repository.scanPage) {
      let afterId: string | undefined;
      let throughId: string | undefined;
      do {
        const page = await repository.scanPage({ limit: 50, ...(afterId ? { afterId } : {}), ...(throughId ? { throughId } : {}) });
        for (const run of page.runs) if (!['succeeded', 'cancelled', 'unknown', 'waiting_external', 'needs_input', 'needs_approval', 'paused'].includes(run.status)) await dispatcher.notify(run.id);
        throughId = page.throughId;
        afterId = page.runs.at(-1)?.id;
        if (page.done) break;
      } while (throughId && afterId);
    } else {
      for (const run of await repository.list()) if (!['succeeded', 'cancelled', 'unknown', 'waiting_external', 'needs_input', 'needs_approval', 'paused'].includes(run.status)) await dispatcher.notify(run.id);
    }
  }
  const close = async () => {
    if (closing) return; closing = true;
    clearInterval(projectionPump); clearInterval(collaborationTriggerPumpTimer); if (rsiProposalPumpTimer) clearInterval(rsiProposalPumpTimer); if (rsiAutomationTimer) clearInterval(rsiAutomationTimer); if (taskSchedulerPump) clearInterval(taskSchedulerPump); if (reminderPumpTimer) clearInterval(reminderPumpTimer); if (knowledgeReindexPump) clearInterval(knowledgeReindexPump);
    // Detach change notifications before draining pumps. A callback already
    // in flight is covered by the pump drains; no callback can start another
    // scan after this point.
    await unsubscribeRunChanges?.(); await app.close(); await Promise.allSettled([...backgroundWork]); await reminderPump.drain(); await rsiProposalPump.drain(); await rsiAutomation?.drain(); await collaborationTriggerPump.drain(); await dispatcher?.close(); await repository.close(); await domainStore.close(); await sessionEventRepository.close(); await taskDispatchRepository.close(); await reminderStore.close(); await brainStore.close(); await evolutionRepository.close(); await evolutionActivation.close(); await collaborationRepository.close(); await collaborationTriggerStore.close(); await projection.close(); await grantLedger.close(); await globalBudgetLedger?.close(); await agentDirectory.close?.(); await projectSourceCheckpoints.close?.(); await roomMemberships.close(); await rsiProposalClaims.close?.(); await runScanCursors.close(); await principalDirectory?.close?.(); await channelIdentityResolver?.close?.();
  };
  process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
} catch (error) { await dispatcher?.close(); await repository.close(); await domainStore.close(); await sessionEventRepository.close(); await taskDispatchRepository.close(); await reminderStore.close(); await brainStore.close(); await evolutionRepository.close(); await evolutionActivation.close(); await collaborationRepository.close(); await collaborationTriggerStore.close(); await projection.close(); await grantLedger.close(); await globalBudgetLedger?.close(); await agentDirectory.close?.(); await projectSourceCheckpoints.close?.(); await roomMemberships.close(); await rsiProposalClaims.close?.(); await runScanCursors.close(); await principalDirectory?.close?.(); await channelIdentityResolver?.close?.(); throw error; }
