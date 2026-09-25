import type { Ownership } from '../security/principal.js';
import Fastify, { type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AgentEngine, Conflict, digest, event } from './engine.js';
import { encodeRunEventCursor, NotFound, type RunRepository } from './repository.js';
import type { Dispatcher } from './dispatcher.js';
import type { AgentRun } from './contracts.js';
import { BrainAccessDenied, BrainConflict, brainBundleContentHash, brainBundleSchema, brainClaimInputSchema, brainClassificationSchema, brainGrantInputSchema, type GovernedBrain, type BrainPersistence, type BrainSemanticIndexMaintenance } from '../brain.js';
import { EvolutionNotFound, type RsiService } from '../rsi.js';
import { baselineVersions } from '../evolution-activation.js';
import { CollaborationNotFound, type CollaborationService } from '../collaboration-service.js';
import type { CandidateRunner, IndependentEvaluator } from '../collaboration.js';
import type { DebateRecord } from '../collaboration-service.js';
import { externalBudgetSchema, modelBudgetSchema, requestSchema } from './contracts.js';
import { projectRunGraphs } from './graphs.js';
import { explainRun } from './explanation.js';
import { AeeisConflict, AeeisNotFound, AeeisService } from '../application/aeeis-service.js';
import type { RsiEvaluationHarness } from '../evaluation.js';
import { ProjectionNotFound, type ProjectionOutbox, type ProjectionSink } from '../collaboration-projection.js';
import type { SkillGovernance, ToolGateway } from '../integrations.js';
import { agentCardSchema } from '../protocol.js';
import { AgentCallbackAuthenticationError, AgentResponseRejected, agentReputationObservationSchema, HttpAgentCardDiscovery, type AgentDirectoryPort, type AgentTransportResponse } from '../agent-gateway.js';
import { principalResolver as staticPrincipalResolver, type Principal, type PrincipalResolver } from '../security/principal.js';
import { publicTaskDispatch, type TaskScheduler, type TaskSchedulerAction } from '../task-scheduler.js';
import { globalBudgetBillingImportSchema, globalBudgetReconcileSchema, type GlobalBudgetLedger, type GlobalBudgetSelector } from '../global-budget.js';
import { RoomMembershipConflict, RoomMembershipNotFound } from '../room-membership.js';
import type { KnowledgeEmbeddingMaintenance, KnowledgeEmbeddingReindexStatus, KnowledgeProvider } from '../knowledge.js';
import type { ProjectSourceProvider } from '../project-sources.js';
import type { FeishuDebateIngress } from '../feishu-debate-ingress.js';
import type { HermesDebateIngress } from '../hermes-debate-ingress.js';
import { collaborationTriggerEventSchema, collaborationTriggerReconcileSchema, CollaborationTriggerNotFound, type CollaborationTriggerService } from '../collaboration-triggers.js';
import { improvementSignalsForRun } from '../rsi-proposal-pump.js';
import { synthesisAttempts, type DurableRsiProposalSynthesis } from '../rsi-proposal-synthesizer.js';
import { ReminderConflict, ReminderNotFound, reminderRecurrenceSchema, type ReminderPump, type ReminderStatus, type ReminderStore } from '../reminders.js';
import type { PrincipalDirectory } from '../security/principal-directory.js';
import { PrincipalDirectoryUnavailable } from '../security/principal-directory.js';
import type { ChannelIdentityResolver } from '../security/channel-identity.js';
import { ChannelIdentityUnavailable } from '../security/channel-identity.js';
import type { SessionEventService } from '../session-events.js';
import type { GrantLedger } from '../agent-ledger.js';

declare module 'fastify' { interface FastifyRequest { aeeisPrincipal: Principal | null; aeeisRawBody?: string; aeeisRequestId: string; aeeisStartedAt?: bigint } }

interface Options { demoMode?: boolean; repository: RunRepository; engine?: AgentEngine; dispatcher?: Dispatcher; token?: string; workerToken?: string; trustedHosts?: string[]; publicHosts?: string[]; trustedOrigins?: string[]; agentEndpointHosts?: string[]; principalTokens?: Record<string, Principal>; principalResolver?: PrincipalResolver; authMode?: string; brain?: GovernedBrain; brainStore?: BrainPersistence; brainSemanticIndex?: BrainSemanticIndexMaintenance; rsi?: RsiService; rsiProposalSynthesis?: DurableRsiProposalSynthesis; rsiHarness?: RsiEvaluationHarness; rsiAutomation?: { status(): unknown }; skills?: SkillGovernance; tools?: ToolGateway; knowledge?: KnowledgeEmbeddingMaintenance; knowledgeProvider?: KnowledgeProvider; projectSourcesProvider?: ProjectSourceProvider; collaboration?: CollaborationService; collaborationTriggers?: CollaborationTriggerService; projection?: ProjectionOutbox; projectionSink?: ProjectionSink; domain?: AeeisService; taskScheduler?: TaskScheduler; reminders?: ReminderStore; reminderPump?: Pick<ReminderPump, 'advance'>; competitionRunner?: CandidateRunner; competitionEvaluator?: IndependentEvaluator; competitionEvaluatorAgentId?: string; debateRunner?: { run(id: string, scope?: Ownership): Promise<DebateRecord> }; feishuDebateIngress?: FeishuDebateIngress; hermesDebateIngress?: HermesDebateIngress; agentDirectory?: AgentDirectoryPort; grantLedger?: GrantLedger; principalDirectory?: PrincipalDirectory; channelIdentityResolver?: ChannelIdentityResolver; sessionEvents?: SessionEventService; globalBudget?: { ledger: GlobalBudgetLedger; select: GlobalBudgetSelector }; readinessCheckTimeoutMs?: number; maxSseConnections?: number }
function matches(expected: string | undefined, received: string | undefined): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(`Bearer ${expected}`), b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Parse an optional bounded collection size at the HTTP edge. Keeping the
 * limit optional preserves the API's existing full-list behavior for callers
 * that need an export, while the workbench can request a small recent view. */
function collectionLimit(query: unknown): number | undefined {
  return z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).strict().parse(query).limit;
}
function cursorCollectionLimit(query: unknown): number | undefined {
  return z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().min(1).max(1000).optional() }).strict().parse(query).limit;
}

const requestLatencyBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const readinessCheckTimeoutMs = 5_000;
type HttpMetricRoute = {
  durationCount: number;
  durationSum: number;
  buckets: number[];
  statuses: Map<string, number>;
};
type HttpMetrics = {
  inFlight: number;
  routes: Map<string, HttpMetricRoute>;
};
function newHttpMetricRoute(): HttpMetricRoute {
  return { durationCount: 0, durationSum: 0, buckets: requestLatencyBuckets.map(() => 0), statuses: new Map() };
}
function metricLabel(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n'); }
function metricRoute(request: FastifyRequest): string {
  const route = request.routeOptions.url ?? 'unmatched';
  // Route templates are bounded by the application source; do not expose raw URLs.
  return route.length <= 200 ? route : 'unmatched';
}
function renderHttpMetrics(metrics: HttpMetrics): string[] {
  const lines = [
    '# HELP aeeis_http_requests_total HTTP requests ended by method, route template, and status code (aborted for disconnected clients).',
    '# TYPE aeeis_http_requests_total counter',
  ];
  const histograms = [
    '# HELP aeeis_http_request_duration_seconds HTTP request lifetime in seconds, including aborted connections.',
    '# TYPE aeeis_http_request_duration_seconds histogram',
  ];
  const gauges = [
    '# HELP aeeis_http_requests_in_flight HTTP requests currently being processed.',
    '# TYPE aeeis_http_requests_in_flight gauge',
    `aeeis_http_requests_in_flight ${metrics.inFlight}`,
  ];
  for (const [route, entry] of [...metrics.routes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [method, template] = route.split(' ', 2) as [string, string];
    const labels = `method="${metricLabel(method)}",route="${metricLabel(template)}"`;
    for (const [status, count] of [...entry.statuses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`aeeis_http_requests_total{${labels},status="${status}"} ${count}`);
    }
    let cumulative = 0;
    for (let index = 0; index < requestLatencyBuckets.length; index += 1) {
      cumulative += entry.buckets[index] ?? 0;
      histograms.push(`aeeis_http_request_duration_seconds_bucket{${labels},le="${requestLatencyBuckets[index]}"} ${cumulative}`);
    }
    histograms.push(`aeeis_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${entry.durationCount}`);
    histograms.push(`aeeis_http_request_duration_seconds_sum{${labels}} ${entry.durationSum}`);
    histograms.push(`aeeis_http_request_duration_seconds_count{${labels}} ${entry.durationCount}`);
  }
  return [...lines, ...gauges, ...histograms];
}
export function buildApp(options: Options) {
  if (options.token !== undefined && options.principalTokens !== undefined) throw new Error('Configure either local access token or principal tokens, not both');
  const resolvePrincipal = options.principalResolver ?? staticPrincipalResolver(options.principalTokens);
  const trustedHosts = new Set((options.trustedHosts ?? []).map(host => host.trim().toLowerCase()).filter(Boolean));
  const publicHosts = new Set((options.publicHosts ?? []).map(host => host.trim().toLowerCase()).filter(Boolean));
  const trustedOrigins = new Set((options.trustedOrigins ?? []).map(origin => origin.trim()).filter(Boolean));
  const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
  const isLoopbackHost = (host: string): boolean => /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
  const isTrustedHost = (host: string, internal: boolean): boolean => {
    const normalized = host.toLowerCase();
    if (isLoopbackHost(normalized)) return true;
    const withoutPort = normalized.replace(/:\d+$/, '');
    return internal
      ? trustedHosts.has(normalized) || trustedHosts.has(withoutPort)
      : publicHosts.has(normalized) || publicHosts.has(withoutPort);
  };
  const httpMetrics: HttpMetrics = { inFlight: 0, routes: new Map() };
  const app = Fastify({ bodyLimit: 700000, logger: false });
  const maxSseConnections = options.maxSseConnections ?? 100;
  if (!Number.isSafeInteger(maxSseConnections) || maxSseConnections < 1) throw new Error('maxSseConnections must be a positive integer');
  let activeSseConnections = 0;
  const metricMethods = new Set<string>(app.supportedMethods);
  const finishHttpRequest = (request: FastifyRequest, status: string): void => {
    const startedAt = request.aeeisStartedAt;
    if (startedAt === undefined) return;
    // Both response completion and socket close can fire. Settle exactly once.
    delete request.aeeisStartedAt;
    httpMetrics.inFlight -= 1;
    const method = metricMethods.has(request.method) ? request.method : 'OTHER';
    const key = `${method} ${metricRoute(request)}`;
    const entry = httpMetrics.routes.get(key) ?? newHttpMetricRoute();
    const duration = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    entry.durationCount += 1;
    entry.durationSum += duration;
    entry.statuses.set(status, (entry.statuses.get(status) ?? 0) + 1);
    const bucketIndex = requestLatencyBuckets.findIndex(bucket => duration <= bucket);
    if (bucketIndex >= 0) entry.buckets[bucketIndex] = (entry.buckets[bucketIndex] ?? 0) + 1;
    httpMetrics.routes.set(key, entry);
  };
  const readinessTimeoutMs = options.readinessCheckTimeoutMs ?? readinessCheckTimeoutMs;
  if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0) throw new Error('readinessCheckTimeoutMs must be a positive finite number');
  class ProbeTimeout extends Error {}
  // A timed-out adapter may still be running. Keep at most one underlying
  // operation per collector until it settles, without retaining its result.
  const probes = new Map<string, Promise<unknown>>();
  const bounded = async <T>(name: string, operation: () => T | Promise<T>): Promise<T> => {
    let pending = probes.get(name) as Promise<T> | undefined;
    if (!pending) {
      pending = Promise.resolve().then(operation);
      probes.set(name, pending);
      const clear = () => { if (probes.get(name) === pending) probes.delete(name); };
      void pending.then(clear, clear);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProbeTimeout()), readinessTimeoutMs); }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const skillGovernanceHealth = async () => {
    if (!options.skills?.health) return { ready: false, detail: options.skills ? 'Skill governance health probe unavailable' : 'Skill governance not configured', checkedAt: new Date().toISOString() };
    try { return await bounded('skillGovernance', () => options.skills!.health!()); }
    catch (error) { return { ready: false, detail: error instanceof ProbeTimeout ? 'Skill governance health probe timed out' : 'Skill governance health probe failed', checkedAt: new Date().toISOString() }; }
  };
  const principalDirectoryReadiness = async () => {
    if (!options.principalDirectory) return { ready: true, detail: 'principal directory not configured' };
    if (!options.principalDirectory.health) return { ready: false, detail: 'Principal directory health probe unavailable' };
    try { return await bounded('principalDirectory', () => options.principalDirectory!.health!()); }
    catch (error) { return { ready: false, detail: error instanceof ProbeTimeout ? 'Principal directory health probe timed out' : 'Principal directory health probe failed' }; }
  };
  const channelIdentityReadiness = async () => {
    if (!options.channelIdentityResolver) return { ready: true, detail: 'channel identity resolver not configured' };
    if (!options.channelIdentityResolver.health) return { ready: false, detail: 'Channel identity resolver health probe unavailable' };
    try { return await bounded('channelIdentity', () => options.channelIdentityResolver!.health!()); }
    catch (error) { return { ready: false, detail: error instanceof ProbeTimeout ? 'Channel identity resolver health probe timed out' : 'Channel identity resolver health probe failed' }; }
  };
  const knowledgeProviderReadiness = async () => {
    if (!options.knowledgeProvider) return { ready: true, detail: 'knowledge provider not configured' };
    if (!options.knowledgeProvider.health) return { ready: false, detail: 'Knowledge provider health probe unavailable' };
    try { return await bounded('knowledgeProvider', () => options.knowledgeProvider!.health!()); }
    catch (error) { return { ready: false, detail: error instanceof ProbeTimeout ? 'Knowledge provider health probe timed out' : 'Knowledge provider health probe failed' }; }
  };
  const projectSourcesReadiness = async () => {
    if (!options.projectSourcesProvider) return { ready: true, detail: 'project sources not configured' };
    if (!options.projectSourcesProvider.health) return { ready: false, detail: 'Project source health probe unavailable' };
    try { return await bounded('projectSourcesProvider', () => options.projectSourcesProvider!.health!()); }
    catch (error) { return { ready: false, detail: error instanceof ProbeTimeout ? 'Project source health probe timed out' : 'Project source health probe failed' }; }
  };
  const brainSemanticReadiness = async () => {
    if (!options.brainSemanticIndex) return { ready: true, detail: 'Brain semantic index not configured' };
    if (!options.brainSemanticIndex.health) return { ready: false, detail: 'Brain semantic index health probe unavailable' };
    try { return await bounded('brainSemanticIndex', () => options.brainSemanticIndex!.health!()); }
    catch (error) { return { ready: false, detail: error instanceof ProbeTimeout ? 'Brain semantic index health probe timed out' : 'Brain semantic index health probe failed' }; }
  };
  const toolsReadiness = async () => {
    if (!options.tools) return { ready: true, detail: 'tool gateway not configured' };
    if (!options.tools.health) return { ready: false, detail: 'Tool gateway health probe unavailable' };
    try { return await bounded('tools', () => options.tools!.health!()); }
    catch (error) { return { ready: false, detail: error instanceof ProbeTimeout ? 'Tool gateway health probe timed out' : 'Tool gateway health probe failed' }; }
  };
  const agentRegistryReadiness = async () => {
    if (!options.agentDirectory) return { ready: true, detail: 'agent registry not configured' };
    if (!options.agentDirectory.health) return { ready: false, detail: 'Agent Registry health probe unavailable' };
    try { return await bounded('agentRegistry', () => options.agentDirectory!.health!()); }
    catch (error) { return { ready: false, detail: error instanceof ProbeTimeout ? 'Agent Registry health probe timed out' : 'Agent Registry health probe failed' }; }
  };
  const projectionSinkReadiness = async () => {
    if (!options.projectionSink) return { ready: true, detail: 'projection sink not configured' };
    if (!options.projectionSink.health) return { ready: false, detail: 'Projection sink health probe unavailable' };
    try { return await bounded('projectionSink', () => options.projectionSink!.health!()); }
    catch (error) { return { ready: false, detail: error instanceof ProbeTimeout ? 'Projection sink health probe timed out' : 'Projection sink health probe failed' }; }
  };
  const rsiEvaluatorReadiness = async () => {
    if (!options.rsiHarness) return { ready: true, detail: 'RSI evaluator not configured' };
    if (!options.rsiHarness.health) return { ready: false, detail: 'RSI evaluator health probe unavailable' };
    try { return await bounded('rsiEvaluator', () => options.rsiHarness!.health!()); }
    catch (error) { return { ready: false, detail: error instanceof ProbeTimeout ? 'RSI evaluator health probe timed out' : 'RSI evaluator health probe failed' }; }
  };
  const statusHealth = async (name: string, operation: () => Promise<{ ready: boolean; detail: string }>) => {
    try { return await bounded(name, operation); }
    catch (error) { return { ready: false, detail: error instanceof ProbeTimeout ? 'dependency check timed out' : 'dependency check failed', checkedAt: new Date().toISOString() }; }
  };
  type ReadinessCheck = { name: string; ready: boolean; required: boolean; detail: string };
  type ReadinessSnapshot = { ready: boolean; checks: ReadinessCheck[]; reindex?: KnowledgeEmbeddingReindexStatus; knowledgeCollected: boolean };
  let readinessInFlight: Promise<ReadinessSnapshot> | undefined;
  const readinessSnapshot = async (): Promise<ReadinessSnapshot> => {
    if (readinessInFlight) return readinessInFlight;
    readinessInFlight = (async (): Promise<ReadinessSnapshot> => {
      let reindex: KnowledgeEmbeddingReindexStatus | undefined;
      let knowledgeCollected = false;
      const check = async (name: string, required: boolean, operation: () => Promise<{ ready: boolean; detail: string }>): Promise<ReadinessCheck> => {
        try { return { name, required, ...await operation() }; }
        catch (error) { return { name, ready: false, required, detail: error instanceof ProbeTimeout ? 'dependency check timed out' : 'dependency check failed' }; }
      };
      const checks = await Promise.all([
        check('repository', true, async () => {
          if (options.repository.health) await bounded('repository', () => options.repository.health!());
          else await bounded('repository', () => options.repository.list());
          return { ready: true, detail: 'run repository reachable' };
        }),
        check('model', true, () => options.engine
          ? bounded('model', () => options.engine!.modelHealth())
          : Promise.resolve({ ready: false, detail: 'model configuration required' })),
        check('dispatcher', true, () => options.engine && options.dispatcher?.health
          ? bounded('dispatcher', () => options.dispatcher!.health!())
          : Promise.resolve({ ready: Boolean(options.engine && options.dispatcher), detail: options.dispatcher?.constructor.name ?? 'dispatcher unavailable' })),
        check('skillGovernance', Boolean(options.skills?.health), skillGovernanceHealth),
        ...(options.principalDirectory ? [check('principalDirectory', true, principalDirectoryReadiness)] : []),
        ...(options.channelIdentityResolver ? [check('channelIdentity', true, channelIdentityReadiness)] : []),
        ...(options.knowledge ? [check('knowledgeEmbeddingReindex', false, async () => {
          reindex = await bounded('knowledge', () => options.knowledge!.getEmbeddingReindexStatus());
          knowledgeCollected = true;
          return { ready: !reindex || reindex.status !== 'failed', detail: !reindex ? 'embedding reindex idle' : `embedding reindex ${reindex.status}` };
        })] : []),
        ...(options.knowledgeProvider ? [check('knowledgeProvider', false, knowledgeProviderReadiness)] : []),
        ...(options.projectSourcesProvider ? [check('projectSources', false, projectSourcesReadiness)] : []),
        ...(options.brainSemanticIndex ? [check('brainSemanticIndex', false, brainSemanticReadiness)] : []),
        ...(options.tools ? [check('tools', false, toolsReadiness)] : []),
        ...(options.agentDirectory ? [check('agentRegistry', false, agentRegistryReadiness)] : []),
        ...(options.projectionSink ? [check('projectionSink', false, projectionSinkReadiness)] : []),
        ...(options.rsiHarness ? [check('rsiEvaluator', false, rsiEvaluatorReadiness)] : []),
      ]);
      checks.push(
        { name: 'domain', ready: Boolean(options.domain), required: true, detail: options.domain ? 'Goal/Plan domain configured' : 'domain unavailable' },
        { name: 'taskScheduler', ready: !options.engine || Boolean(options.taskScheduler), required: Boolean(options.engine), detail: options.taskScheduler ? 'durable task dispatch configured' : 'task scheduler unavailable' },
        { name: 'brain', ready: Boolean(options.brain), required: false, detail: options.brain ? 'Brain configured' : 'Brain unavailable' },
        { name: 'evolution', ready: Boolean(options.rsi), required: false, detail: options.rsi ? 'RSI repository configured' : 'RSI unavailable' },
        { name: 'collaboration', ready: Boolean(options.collaboration), required: false, detail: options.collaboration ? 'collaboration repository configured' : 'collaboration unavailable' },
        { name: 'reminders', ready: Boolean(options.reminders), required: false, detail: options.reminders ? 'durable reminder store configured' : 'reminders unavailable' },
      );
      return { ready: checks.every(result => !result.required || result.ready), checks, knowledgeCollected, ...(reindex === undefined ? {} : { reindex }) };
    })();
    try { return await readinessInFlight; }
    finally { readinessInFlight = undefined; }
  };
  app.decorateRequest('aeeisPrincipal', null);
  app.decorateRequest('aeeisRequestId', '');
  app.decorateRequest('aeeisStartedAt', undefined);
  app.addHook('preParsing', async (request, _reply, payload) => {
    if (!request.url.startsWith('/webhooks/feishu/events') && !request.url.startsWith('/webhooks/hermes/events') && !request.url.startsWith('/webhooks/agents/')) return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    request.aeeisRawBody = raw.toString('utf8');
    return Readable.from([raw]);
  });
  app.addHook('onRequest', async (request, reply) => {
    request.aeeisStartedAt = process.hrtime.bigint();
    httpMetrics.inFlight += 1;
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) finishHttpRequest(request, 'aborted');
    });
    const suppliedRequestId = request.headers['x-request-id'];
    const requestId = typeof suppliedRequestId === 'string' && requestIdPattern.test(suppliedRequestId) ? suppliedRequestId : randomUUID();
    request.aeeisRequestId = requestId;
    reply.header('x-request-id', requestId);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const host = request.headers.host ?? '';
    const route = request.routeOptions.url ?? '';
    const agentCallbackRoute = route === '/webhooks/agents/:id/callback';
    if (!isTrustedHost(host, route.startsWith('/internal/'))) return reply.code(403).send({ error: 'Untrusted host' });
    if (request.headers.origin) {
      const origin = request.headers.origin.trim();
      const sameOrigin = isLoopbackHost(host) && origin === `http://${host}`;
      if (!sameOrigin && !trustedOrigins.has(origin)) return reply.code(403).send({ error: 'Cross-origin access denied' });
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'Cross-site access denied' });
    if (route.startsWith('/internal/')) {
      if (!matches(options.workerToken, request.headers.authorization)) return reply.code(401).send({ error: 'Worker authentication required' });
    } else if (route.startsWith('/api/') && options.token && !matches(options.token, request.headers.authorization)) {
      return reply.code(401).send({ error: 'Local access token required' });
    }
    if (!agentCallbackRoute && (route.startsWith('/api/') || ((options.principalTokens !== undefined || options.principalResolver !== undefined || options.token !== undefined) && ['/metrics', '/readyz'].includes(route)))) {
      if (options.token && !matches(options.token, request.headers.authorization)) return reply.code(401).send({ error: 'Local access token required' });
      const principal = await resolvePrincipal(request.headers.authorization);
      if (!principal) return reply.code(401).send({ error: 'Principal authentication required' });
      request.aeeisPrincipal = principal;
      // These services currently manage installation-wide configuration/state.
      // A tenant owner never acquires installation operator privileges.
      const operatorRoute = route === '/metrics' || /^\/api\/(?:skills|agents|knowledge)(?:\/|$)/.test(route) || route === '/api/brain/semantic-reindex';
      if (operatorRoute && !principal.roles.includes('operator')) return reply.code(403).send({ error: 'Installation operator role required' });
      const ownedResourceRoute = /^\/api\/(evolution|collaborations|reminders)(?:\/|$)/.test(route) || route.endsWith('/corrections');
      if (ownedResourceRoute && !principal.roles.some(role => role === 'owner' || role === 'operator')) return reply.code(403).send({ error: 'Resource owner role required' });
      const roomRoute = /^\/api\/rooms(?:\/|$)/.test(route);
      const roomCreation = route === '/api/rooms' && request.method === 'POST';
      const sharedGraphRead = request.method === 'GET' && (/^\/api\/goals\/[^/]+(?:\/plans(?:\/page)?|\/memories|\/context-manifests\/[^/]+|$)/.test(route) || /^\/api\/plans\/[^/]+\/(?:snapshot|scheduler)$/.test(route));
      const sharedEditorWrite = request.method === 'POST' && /^\/api\/goals\/[^/]+\/plans(?:\/revise)?$/.test(route);
      const sharedTaskTransition = request.method === 'POST' && /^\/api\/plans\/[^/]+\/tasks\/[^/]+\/transition$/.test(route);
      const sharedRunRead = request.method === 'GET' && /^\/api\/runs(?:\/|$)/.test(route);
      if (/^\/api\/(rooms|goals|plans|runs|reminders)(?:\/|$)/.test(route) && !principal.roles.includes('owner') && !(roomRoute && !roomCreation) && !(route === '/api/goals' && request.method === 'POST') && !sharedGraphRead && !sharedEditorWrite && !sharedTaskTransition && !sharedRunRead) return reply.code(403).send({ error: 'Resource owner role required' });
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    finishHttpRequest(request, String(reply.statusCode));
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request', issues: error.issues.map(i => ({ path: i.path, message: i.message })) });
    if (error instanceof BrainAccessDenied) return reply.code(403).send({ error: 'Brain access denied' });
    if (error instanceof AgentCallbackAuthenticationError) return reply.code(401).send({ error: 'Agent callback authentication failed' });
    if (error instanceof AgentResponseRejected) return reply.code(400).send({ error: 'Agent response rejected', kind: error.kind, detail: error.message });
    if (error instanceof BrainConflict) return reply.code(409).send({ error: error.message });
    if (error instanceof NotFound || error instanceof EvolutionNotFound) return reply.code(404).send({ error: error.message });
    if (error instanceof AeeisNotFound || error instanceof RoomMembershipNotFound) return reply.code(404).send({ error: error.message });
    if (error instanceof PrincipalDirectoryUnavailable) return reply.code(503).send({ error: 'Principal directory unavailable; invitation refused' });
    if (error instanceof ChannelIdentityUnavailable) return reply.code(503).send({ error: 'Channel identity resolver unavailable; event admission refused' });
    if (error instanceof AeeisConflict || error instanceof RoomMembershipConflict) return reply.code(409).send({ error: error.message });
    if (error instanceof CollaborationNotFound || error instanceof CollaborationTriggerNotFound || error instanceof ProjectionNotFound || error instanceof ReminderNotFound) return reply.code(404).send({ error: error.message });
    if (error instanceof ReminderConflict) return reply.code(409).send({ error: error.message });
    if (error instanceof Conflict) return reply.code(409).send({ error: error.message });
    if (error instanceof RangeError) return reply.code(400).send({ error: error.message });
    const e = error as { statusCode?: number };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'Invalid HTTP request' });
    console.error('Request failed', request.aeeisRequestId, error instanceof Error ? error.name : 'Error');
    return reply.code(500).send({ error: 'Internal operation failed; inspect the server log' });
  });
  if (options.feishuDebateIngress) {
    app.post('/webhooks/feishu/events', async request => {
      const rawBody = request.aeeisRawBody ?? JSON.stringify(request.body ?? {});
      const headers: Record<string, string | string[] | undefined> = request.headers;
      return options.feishuDebateIngress!.handle(rawBody, headers);
    });
  }
  if (options.hermesDebateIngress) {
    app.post('/webhooks/hermes/events', async request => {
      const rawBody = request.aeeisRawBody ?? JSON.stringify(request.body ?? {});
      const headers: Record<string, string | string[] | undefined> = request.headers;
      return options.hermesDebateIngress!.handle(rawBody, headers);
    });
  }
  app.post<{ Params: { id: string } }>('/webhooks/agents/:id/callback', async (request, reply) => {
    if (!options.engine) throw new Conflict('Model runtime is not configured');
    const header = (name: string): string | undefined => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const timestamp = header('x-aeeis-timestamp');
    const signature = header('x-aeeis-signature');
    await options.engine.acceptAgentCallback(request.params.id, request.body as AgentTransportResponse, {
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(signature === undefined ? {} : { signature }),
      ...(request.aeeisRawBody === undefined ? {} : { body: request.aeeisRawBody }),
    });
    try { await options.dispatcher?.notify(request.params.id); }
    catch (error) {
      await options.repository.mutate(request.params.id, run => {
        event(run, 'dispatch.failed', { reason: error instanceof Error ? error.message : 'Execution service unavailable', source: 'agent-callback' });
      });
    }
    return reply.code(202).send({ accepted: true });
  });
  app.get('/health', async () => ({ status: 'ok', service: 'aeeis-agent', protocol: 'aeeis-health/1' }));
  app.get('/readyz', async (_request, reply) => {
    const readiness = await readinessSnapshot();
    return reply.code(readiness.ready ? 200 : 503).send({ protocol: 'aeeis-readiness/1', status: readiness.ready ? 'ready' : 'not_ready', checks: readiness.checks });
  });
  app.get('/metrics', async (_request, reply) => {
    const collector = async <T>(name: string, operation: (() => T | Promise<T>) | undefined, probeName = name) => {
      if (!operation) return undefined;
      try { return { name, ok: true, value: await bounded(probeName, operation) }; }
      catch { return { name, ok: false, value: undefined }; }
    };
    const [readiness, runsResult, agentsResult, candidatesResult, trafficResult, projectionsResult, dispatchesResult, remindersResult] = await Promise.all([
      readinessSnapshot(),
      collector('repository', () => options.repository.list(), 'repositoryMetrics'),
      collector('agents', options.agentDirectory ? () => options.agentDirectory!.entriesSnapshot() : undefined),
      collector('evolutionCandidates', options.rsi ? () => options.rsi!.list() : undefined),
      collector('evolutionTraffic', options.rsi ? () => options.rsi!.listTraffic() : undefined),
      collector('projections', options.projection ? () => options.projection!.list() : undefined),
      collector('taskDispatches', options.taskScheduler ? () => options.taskScheduler!.listAll() : undefined),
      collector('reminders', options.reminders ? () => options.reminders!.list() : undefined),
    ]);
    const lines = [
      ...renderHttpMetrics(httpMetrics),
      '# HELP aeeis_readiness AEEIS required dependency readiness (1 ready, 0 not ready).',
      '# TYPE aeeis_readiness gauge',
      `aeeis_readiness ${readiness.ready ? 1 : 0}`,
      '# HELP aeeis_readiness_check AEEIS readiness by dependency check (1 ready, 0 not ready).',
      '# TYPE aeeis_readiness_check gauge',
      ...readiness.checks.map(check => `aeeis_readiness_check{check="${escapeMetricLabel(check.name)}",required="${check.required ? 'true' : 'false'}"} ${check.ready ? 1 : 0}`),
      '# HELP aeeis_runs_total Number of durable runs by status.',
      '# TYPE aeeis_runs_total gauge',
      ...(runsResult?.value ? countValues(runsResult.value.map(run => run.status), 'aeeis_runs_total') : []),
      `aeeis_model_configured ${options.engine?.modelConfigured ? 1 : 0}`,
      `aeeis_brain_semantic_search_configured ${options.engine?.brainSemanticSearchConfigured ? 1 : 0}`,
      `aeeis_dispatcher_configured ${options.dispatcher ? 1 : 0}`,
      `aeeis_domain_configured ${options.domain ? 1 : 0}`,
      `aeeis_task_scheduler_configured ${options.taskScheduler ? 1 : 0}`,
      `aeeis_reminders_configured ${options.reminders ? 1 : 0}`,
      `aeeis_rsi_configured ${options.rsi ? 1 : 0}`,
      `aeeis_collaboration_configured ${options.collaboration ? 1 : 0}`,
      `aeeis_projection_sink_configured ${options.projectionSink ? 1 : 0}`,
      '# HELP aeeis_sse_connections_in_flight Active Run event SSE connections.',
      '# TYPE aeeis_sse_connections_in_flight gauge',
      `aeeis_sse_connections_in_flight ${activeSseConnections}`,
      '# HELP aeeis_sse_connections_limit Maximum concurrent Run event SSE connections.',
      '# TYPE aeeis_sse_connections_limit gauge',
      `aeeis_sse_connections_limit ${maxSseConnections}`,
    ];
    if (options.knowledge && readiness.knowledgeCollected) {
      const reindex = readiness.reindex;
      lines.push(`aeeis_knowledge_embedding_reindex_configured ${reindex ? 1 : 0}`);
      if (reindex) {
        lines.push(...countValues([reindex.status], 'aeeis_knowledge_embedding_reindex_status'));
        lines.push(`aeeis_knowledge_embedding_reindex_indexed ${reindex.indexed}`);
        lines.push(`aeeis_knowledge_embedding_reindex_consecutive_failures ${reindex.consecutiveFailures}`);
        if (reindex.lastBatchDurationMs !== undefined) lines.push(`aeeis_knowledge_embedding_reindex_last_batch_duration_ms ${reindex.lastBatchDurationMs}`);
      }
    }
    if (agentsResult?.value) {
      const agents = agentsResult.value;
      lines.push('# HELP aeeis_agents_total Registered Agents by lifecycle status.', '# TYPE aeeis_agents_total gauge', ...countValues(agents.map(agent => agent.status), 'aeeis_agents_total'), `aeeis_agent_reputation_observations_total ${agents.reduce((sum, agent) => sum + agent.reputation.samples, 0)}`);
    }
    if (candidatesResult?.value) {
      const candidates = candidatesResult.value;
      lines.push('# HELP aeeis_evolution_candidates_total Evolution candidates by status.', '# TYPE aeeis_evolution_candidates_total gauge', ...countValues(candidates.map(candidate => candidate.status), 'aeeis_evolution_candidates_total'));
    }
    if (trafficResult?.value) {
      const traffic = trafficResult.value;
      lines.push('# HELP aeeis_evolution_traffic_routes_total Production traffic routes by status.', '# TYPE aeeis_evolution_traffic_routes_total gauge', ...countValues(traffic.map(route => route.status), 'aeeis_evolution_traffic_routes_total'), `aeeis_evolution_traffic_observations_total ${traffic.reduce((sum, route) => sum + (route.observations?.length ?? 0), 0)}`);
    }
    if (projectionsResult?.value) {
      const projections = projectionsResult.value;
      lines.push('# HELP aeeis_projection_events_total Projection outbox events by status.', '# TYPE aeeis_projection_events_total gauge', ...countValues(projections.map(event => event.status), 'aeeis_projection_events_total'));
    }
    if (dispatchesResult?.value) {
      const dispatches = dispatchesResult.value;
      lines.push('# HELP aeeis_task_dispatches_total Durable domain task dispatches by state.', '# TYPE aeeis_task_dispatches_total gauge', ...countValues(dispatches.map(dispatch => dispatch.state), 'aeeis_task_dispatches_total'));
    }
    lines.push('# HELP aeeis_metrics_collection_success Whether the current collector succeeded; failed collectors omit their values.', '# TYPE aeeis_metrics_collection_success gauge',
      `aeeis_metrics_collection_success{collector="repository"} ${runsResult?.ok ? 1 : 0}`,
      ...(options.knowledge ? [`aeeis_metrics_collection_success{collector="knowledge"} ${readiness.knowledgeCollected ? 1 : 0}`] : []),
      ...[agentsResult, candidatesResult, trafficResult, projectionsResult, dispatchesResult, remindersResult].flatMap(result => result ? [`aeeis_metrics_collection_success{collector="${result.name}"} ${result.ok ? 1 : 0}`] : []));
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(lines.join('\n') + '\n');
  });
  const assets: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'],
  };
  for (const [route, [file, type]] of Object.entries(assets)) {
    app.get(route, async (_request, reply) => reply.type(type).send(await readFile(file === 'app.js' ? new URL('../../dist/ui/app.js', import.meta.url) : new URL(`../../public/${file}`, import.meta.url), 'utf8')));
  }
  app.get('/api/status', async request => {
    const principal = principalOf(request);
    const [modelHealth, dispatcherHealth, skillsHealth, principalDirectoryHealth, channelIdentityHealth, knowledgeProviderHealth, projectSourcesHealth, brainSemanticIndexHealth, toolsHealth, agentRegistryHealth, projectionSinkHealth, rsiEvaluatorHealth] = await Promise.all([
      options.engine ? statusHealth('model', () => options.engine!.modelHealth()) : { ready: false, detail: 'model configuration required' },
      options.dispatcher?.health ? statusHealth('dispatcher', () => options.dispatcher!.health!()) : null,
      skillGovernanceHealth(),
      options.principalDirectory ? principalDirectoryReadiness() : null,
      options.channelIdentityResolver ? channelIdentityReadiness() : null,
      options.knowledgeProvider ? knowledgeProviderReadiness() : null,
      options.projectSourcesProvider ? projectSourcesReadiness() : null,
      options.brainSemanticIndex ? brainSemanticReadiness() : null,
      options.tools ? toolsReadiness() : null,
      options.agentDirectory ? agentRegistryReadiness() : null,
      options.projectionSink ? projectionSinkReadiness() : null,
      options.rsiHarness ? rsiEvaluatorReadiness() : null,
    ]);
    return {
      executionProfile: options.demoMode ? 'fixture' : 'unverified',
      modelConfigured: options.engine?.modelConfigured ?? false, model: options.engine?.modelPin ?? null, modelHealth: modelHealth, modelRouting: options.engine?.modelPin ? 'pinned' : options.engine ? 'catalog' : 'unconfigured', agentGatewayConfigured: options.engine?.agentGatewayConfigured ?? false, agentRegistryConfigured: Boolean(options.agentDirectory), agentRegistryCounts: options.agentDirectory ? countObject((await options.agentDirectory.entriesSnapshot()).map(agent => agent.status)) : {}, agentRegistryHealth, principalDirectoryConfigured: Boolean(options.principalDirectory), principalDirectoryHealth, channelIdentityConfigured: Boolean(options.channelIdentityResolver), channelIdentityHealth, runner: options.dispatcher?.constructor.name ?? 'unconfigured', dispatcherHealth: dispatcherHealth, toolsConfigured: Boolean(options.tools), toolsHealth, knowledgeConfigured: options.engine?.knowledgeConfigured ?? false, knowledgeProviderHealth, brainSemanticSearchConfigured: options.engine?.brainSemanticSearchConfigured ?? false, brainSemanticIndexHealth, projectSourcesConfigured: options.engine?.projectSourcesConfigured ?? false, projectSourcesHealth, projectSourceCheckpointsConfigured: Boolean(options.engine?.projectSourceCheckpointsConfigured), evolutionConfigured: Boolean(options.rsi), rsiEvaluatorConfigured: Boolean(options.rsiHarness), rsiEvaluatorHealth, rsiProposalSynthesisConfigured: Boolean(options.rsiProposalSynthesis), rsiAutomation: options.rsiAutomation?.status() ?? { enabled: false }, skillGovernanceConfigured: Boolean(options.skills), skillGovernanceHealth: skillsHealth, collaborationConfigured: Boolean(options.collaboration), remindersConfigured: Boolean(options.reminders), projectionConfigured: Boolean(options.projection), projectionSinkConfigured: Boolean(options.projectionSink), projectionSinkHealth, domainConfigured: Boolean(options.domain), taskSchedulerConfigured: Boolean(options.taskScheduler), mode: options.authMode ?? (options.principalTokens ? 'principal-scoped' : 'single-owner-local'), principal: principal.id, tenantId: principal.tenantId, roles: principal.roles
    };
  });
  app.get('/api/brain/semantic-reindex', async (): Promise<{ configured: false } | { configured: true; model?: string; dimensions?: number }> => options.brainSemanticIndex ? { configured: true, ...(options.brainSemanticIndex.model === undefined ? {} : { model: options.brainSemanticIndex.model }), ...(options.brainSemanticIndex.dimensions === undefined ? {} : { dimensions: options.brainSemanticIndex.dimensions }) } : { configured: false });
  app.post('/api/brain/semantic-reindex', async request => {
    if (!options.brainSemanticIndex || !options.brain) throw new Conflict('Brain semantic index is not configured');
    z.object({}).strict().parse(request.body ?? {});
    try {
      const claims = options.brain.state().claims;
      await options.brainSemanticIndex.reconcile(claims);
      return { status: 'reconciled', claims: claims.filter(claim => claim.state === 'active').length, model: options.brainSemanticIndex.model ?? null, dimensions: options.brainSemanticIndex.dimensions ?? null };
    } catch (error) { throw new Conflict(error instanceof Error ? error.message : 'Brain semantic index reconciliation failed'); }
  });
  app.get('/api/knowledge/embedding-reindex', async (): Promise<KnowledgeEmbeddingReindexStatus | { configured: false }> => options.knowledge ? (await options.knowledge.getEmbeddingReindexStatus()) ?? { configured: false } : { configured: false });
  app.post('/api/knowledge/embedding-reindex', async request => {
    if (!options.knowledge) throw new Conflict('Knowledge embedding maintenance is not configured');
    const body = z.object({ batchSize: z.number().int().min(1).max(1000).optional(), reset: z.boolean().optional() }).strict().parse(request.body ?? {});
    try {
      const status = await options.knowledge.enqueueEmbeddingReindex({ ...(body.batchSize === undefined ? {} : { batchSize: body.batchSize }), ...(body.reset === undefined ? {} : { reset: body.reset }) });
      return { accepted: true, status };
    } catch (error) { throw new Conflict(error instanceof Error ? error.message : 'Knowledge embedding reindex enqueue failed'); }
  });
  app.post('/api/knowledge/embedding-reindex/run', async request => {
    if (!options.knowledge) throw new Conflict('Knowledge embedding maintenance is not configured');
    try { return { status: await options.knowledge.runEmbeddingReindexBatch() }; }
    catch (error) { throw new Conflict(error instanceof Error ? error.message : 'Knowledge embedding reindex batch failed'); }
  });
  app.get('/api/budgets/global', async request => {
    if (!options.globalBudget) return { configured: false, account: null };
    const principal = principalOf(request); const selection = options.globalBudget.select({ owner: principal.id, tenantId: principal.tenantId }, new Date().toISOString());
    if (!selection) return { configured: false, account: null };
    const account = await options.globalBudget.ledger.get(selection.accountKey);
    return { configured: true, account: account ?? { accountKey: selection.accountKey, owner: selection.owner, tenantId: selection.tenantId, windowKey: selection.windowKey, budget: selection.budget, usedCalls: 0, usedTokens: 0, usedMoneyUsd: 0, unreportedTokenCalls: 0, unreportedMoneyCalls: 0, entries: {} } };
  });
  app.post('/api/budgets/global/reconcile', async (request, reply) => {
    if (!options.globalBudget) throw new Conflict('Global budget is not configured');
    const principal = principalOf(request);
    const body = globalBudgetReconcileSchema.parse(request.body);
    const account = await options.globalBudget.ledger.get(body.accountKey);
    if (!account) throw new Conflict('Unknown global budget account');
    const operator = principal.roles.includes('operator');
    if (!operator && !principal.roles.includes('owner')) return reply.code(403).send({ error: 'Global budget owner role required' });
    const ownsAccount = (account.owner === '*' || account.owner === principal.id) && (account.tenantId === '*' || account.tenantId === principal.tenantId);
    if (!operator && !ownsAccount) return reply.code(403).send({ error: 'Global budget account access denied' });
    if (!account.entries[body.idempotencyKey]) throw new Conflict('Unknown global budget reservation');
    try { await options.globalBudget.ledger.reconcile(body.accountKey, body.idempotencyKey, body.usage, body.reconciliation); }
    catch (error) { throw new Conflict(error instanceof Error ? error.message : 'Global budget reconciliation failed'); }
    return { reconciled: true, account: await options.globalBudget.ledger.get(body.accountKey) };
  });
  app.post('/api/budgets/global/import', async (request, reply) => {
    if (!options.globalBudget) throw new Conflict('Global budget is not configured');
    const principal = principalOf(request);
    const body = globalBudgetBillingImportSchema.parse(request.body);
    const operator = principal.roles.includes('operator');
    if (!operator && !principal.roles.includes('owner')) return reply.code(403).send({ error: 'Global budget owner role required' });
    const accounts = await Promise.all(body.lines.map(line => options.globalBudget!.ledger.get(line.accountKey)));
    for (const [index, account] of accounts.entries()) {
      if (!account) throw new Conflict(`Unknown global budget account for billing line ${index}`);
      const ownsAccount = (account.owner === '*' || account.owner === principal.id) && (account.tenantId === '*' || account.tenantId === principal.tenantId);
      if (!operator && !ownsAccount) return reply.code(403).send({ error: 'Global budget account access denied' });
      if (!account.entries[body.lines[index]!.idempotencyKey]) throw new Conflict(`Unknown global budget reservation for billing line ${index}`);
    }
    const results: Array<{ accountKey: string; idempotencyKey: string; status: 'reconciled' | 'rejected'; reason?: string }> = [];
    for (const line of body.lines) {
      try {
        await options.globalBudget.ledger.reconcile(line.accountKey, line.idempotencyKey, line.usage, line.reconciliation);
        results.push({ accountKey: line.accountKey, idempotencyKey: line.idempotencyKey, status: 'reconciled' });
      } catch (error) {
        results.push({ accountKey: line.accountKey, idempotencyKey: line.idempotencyKey, status: 'rejected', reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { protocol: 'aeeis-billing-import/1', imported: results.filter(result => result.status === 'reconciled').length, rejected: results.filter(result => result.status === 'rejected').length, results };
  });
  app.get<{ Querystring: { limit?: string } }>('/api/agents', async request => {
    if (!options.agentDirectory) throw new Conflict('Agent registry is not configured');
    const limit = collectionLimit(request.query);
    return options.agentDirectory.entriesSnapshot(limit);
  });
  app.get<{ Params: { id: string } }>('/api/agents/:id/audit', async request => {
    if (!options.agentDirectory) throw new Conflict('Agent registry is not configured');
    return await options.agentDirectory.auditSnapshot(request.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/agents/:id/reputation', async request => {
    if (!options.agentDirectory) throw new Conflict('Agent registry is not configured');
    try { return await options.agentDirectory.reputationSnapshot(request.params.id); }
    catch (error) { throw new Conflict(error instanceof Error ? error.message : 'Agent reputation lookup failed'); }
  });
  app.post<{ Params: { id: string } }>('/api/agents/:id/reputation/observations', async request => {
    if (!options.agentDirectory) throw new Conflict('Agent registry is not configured');
    try { return await options.agentDirectory.recordReputation(request.params.id, agentReputationObservationSchema.parse(request.body), principalOf(request).id); }
    catch (error) { throw new Conflict(error instanceof Error ? error.message : 'Agent reputation update failed'); }
  });
  app.post('/api/agents/discover', async request => {
    if (!options.agentDirectory) throw new Conflict('Agent registry is not configured');
    const card = agentCardSchema.parse(request.body);
    try { return await options.agentDirectory.discover(card, new Date().toISOString(), principalOf(request).id); }
    catch (error) { throw new Conflict(error instanceof Error ? error.message : 'Agent discovery failed'); }
  });
  app.post('/api/agents/discover-url', async request => {
    if (!options.agentDirectory) throw new Conflict('Agent registry is not configured');
    const body = z.object({ url: z.string().url().max(2000) }).strict().parse(request.body);
    try {
      const card = await new HttpAgentCardDiscovery(10_000, false, 256_000, options.agentEndpointHosts ?? []).fetch(body.url);
      return await options.agentDirectory.discover(card, new Date().toISOString(), principalOf(request).id);
    } catch (error) { throw new Conflict(error instanceof Error ? error.message : 'Agent Card discovery failed'); }
  });
  app.get<{ Params: { id: string } }>('/api/agents/grants/:id', async request => {
    if (!options.grantLedger) throw new Conflict('Agent grant ledger is not configured');
    const record = await options.grantLedger.getGrant(request.params.id);
    if (!record) throw new AeeisNotFound(`Unknown delegation grant: ${request.params.id}`);
    return record;
  });
  app.post<{ Params: { id: string } }>('/api/agents/:id/admit', async request => {
    if (!options.agentDirectory) throw new Conflict('Agent registry is not configured');
    try { return await options.agentDirectory.admit(request.params.id, new Date().toISOString(), principalOf(request).id); }
    catch (error) { throw new Conflict(error instanceof Error ? error.message : 'Agent admission failed'); }
  });
  app.post<{ Params: { id: string } }>('/api/agents/:id/revoke', async request => {
    if (!options.agentDirectory) throw new Conflict('Agent registry is not configured');
    try { await options.agentDirectory.revoke(request.params.id, new Date().toISOString(), principalOf(request).id); return { status: 'revoked', agentId: request.params.id }; }
    catch (error) { throw new Conflict(error instanceof Error ? error.message : 'Agent revocation failed'); }
  });
  app.post<{ Params: { id: string } }>('/api/agents/grants/:id/revoke', async request => {
    if (!options.grantLedger) throw new Conflict('Agent grant ledger is not configured');
    const body = z.object({ reason: z.string().trim().min(1).max(2000).optional() }).strict().parse(request.body ?? {});
    try {
      return await options.grantLedger.revokeGrant(request.params.id, { actor: principalOf(request).id, ...(body.reason === undefined ? {} : { reason: body.reason }) });
    } catch (error) { throw new Conflict(error instanceof Error ? error.message : 'Agent grant revocation failed'); }
  });
  app.get<{ Querystring: { limit?: string } }>('/api/goals', async request => { const principal = principalOf(request); const limit = collectionLimit(request.query); return options.domain ? options.domain.listGoals(principal.id, principal.tenantId, limit) : []; });
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/api/goals/page', async request => {
    const principal = principalOf(request); const parsed = cursorCollectionLimit(request.query); const limit = parsed ?? 50;
    return options.domain ? options.domain.listGoalsPage(principal.id, principal.tenantId, limit, request.query.cursor) : { goals: [] };
  });
  app.post('/api/goals', async (request, reply) => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ title: z.string().trim().min(1).max(500), description: z.string().max(8000).optional(), roomId: z.string().trim().min(1).max(200).optional() }).strict().parse(request.body);
    const principal = principalOf(request);
    if (!principal.roles.includes('owner') && body.roomId === undefined) return reply.code(403).send({ error: 'Room editor role required for shared Goal creation' });
    return options.domain.createGoal({ title: body.title, ...(body.description === undefined ? {} : { description: body.description }), ...(body.roomId === undefined ? {} : { roomId: body.roomId }) }, undefined, principal.id, principal.tenantId);
  });
  app.get<{ Querystring: { limit?: string } }>('/api/rooms', async request => { const principal = principalOf(request); const limit = collectionLimit(request.query); return options.domain ? options.domain.listRoomsForPrincipal(principal.id, principal.tenantId, limit) : []; });
  app.post('/api/rooms', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ title: z.string().trim().min(1).max(500), description: z.string().max(8000).optional() }).strict().parse(request.body);
    const principal = principalOf(request);
    return options.domain.createRoom({ title: body.title, ...(body.description === undefined ? {} : { description: body.description }) }, undefined, principal.id, principal.tenantId);
  });
  app.patch<{ Params: { id: string } }>('/api/rooms/:id', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ title: z.string().trim().min(1).max(500).optional(), description: z.string().max(8000).optional(), status: z.enum(['active', 'archived']).optional() }).strict().parse(request.body);
    const principal = principalOf(request);
    return options.domain.updateRoom(request.params.id, { ...(body.title === undefined ? {} : { title: body.title }), ...(body.description === undefined ? {} : { description: body.description }), ...(body.status === undefined ? {} : { status: body.status }) }, undefined, principal.id, principal.tenantId);
  });
  app.get<{ Params: { id: string } }>('/api/rooms/:id', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const principal = principalOf(request); return options.domain.getRoomForPrincipal(request.params.id, principal.id, principal.tenantId);
  });
  app.get<{ Params: { id: string } }>('/api/rooms/:id/goals', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const principal = principalOf(request); return options.domain.listGoalsInRoomForPrincipal(request.params.id, principal.id, principal.tenantId);
  });
  app.get<{ Params: { id: string } }>('/api/rooms/:id/members', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const principal = principalOf(request); return options.domain.listRoomMembers(request.params.id, principal.id, principal.tenantId);
  });
  app.post<{ Params: { id: string } }>('/api/rooms/:id/members', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ principalId: z.string().trim().min(1).max(200), role: z.enum(['editor', 'viewer', 'agent']) }).strict().parse(request.body);
    const principal = principalOf(request); return options.domain.addRoomMember(request.params.id, body.principalId, body.role, principal.id, principal.tenantId);
  });
  app.delete<{ Params: { id: string; principalId: string } }>('/api/rooms/:id/members/:principalId', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const principal = principalOf(request); return options.domain.revokeRoomMember(request.params.id, request.params.principalId, principal.id, principal.tenantId);
  });
  app.post<{ Params: { id: string } }>('/api/rooms/:id/context-manifests', async request => {
    if (!options.domain) throw new Conflict('Goal service is not configured');
    const body = z.object({
      purpose: z.string().trim().min(1).max(2000),
      contexts: z.array(z.object({ goalId: z.string().min(1).max(128), contextManifestId: z.string().min(1).max(128) }).strict()).min(1).max(20),
      audience: z.array(z.string().min(1).max(500)).min(1).max(100).optional(),
    }).strict().parse(request.body);
    const principal = principalOf(request);
    return options.domain.createSessionContextManifest(request.params.id, { purpose: body.purpose, contexts: body.contexts, ...(body.audience === undefined ? {} : { audience: body.audience }) }, undefined, principal.id, principal.tenantId);
  });
  app.get<{ Params: { id: string; manifestId: string } }>('/api/rooms/:id/context-manifests/:manifestId', async request => {
    if (!options.domain) throw new Conflict('Goal service is not configured');
    const principal = principalOf(request);
    return options.domain.getSessionContextManifest(request.params.id, request.params.manifestId, principal.id, principal.tenantId);
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>('/api/rooms/:id/session-events', async request => {
    if (!options.sessionEvents) throw new Conflict('Shared Session event service is not configured');
    const principal = principalOf(request); const parsed = cursorCollectionLimit(request.query); const limit = parsed ?? 50;
    const afterSequence = request.query.cursor === undefined ? 0 : z.coerce.number().int().nonnegative().parse(request.query.cursor);
    return options.sessionEvents.page(request.params.id, principal.id, principal.tenantId, limit, afterSequence);
  });
  app.post<{ Params: { id: string } }>('/api/rooms/:id/session-events', async request => {
    if (!options.sessionEvents) throw new Conflict('Shared Session event service is not configured');
    const body = z.object({ goalId: z.string().trim().min(1).max(200).optional(), type: z.enum(['message', 'canonical_response', 'decision', 'task_update', 'system']), content: z.string().trim().min(1).max(20_000), contextManifestId: z.string().trim().min(1).max(200), evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(200).optional(), idempotencyKey: z.string().trim().min(1).max(500) }).strict().parse(request.body);
    const principal = principalOf(request);
    return options.sessionEvents.create(request.params.id, { ...(body.goalId === undefined ? {} : { goalId: body.goalId }), type: body.type, content: body.content, contextManifestId: body.contextManifestId, ...(body.evidenceRefs === undefined ? {} : { evidenceRefs: body.evidenceRefs }), idempotencyKey: body.idempotencyKey }, principal.id, principal.tenantId);
  });
  app.post<{ Params: { id: string; eventId: string } }>('/api/rooms/:id/session-events/:eventId/revise', async request => {
    if (!options.sessionEvents) throw new Conflict('Shared Session event service is not configured');
    const body = z.object({ content: z.string().trim().min(1).max(20_000), evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(200).optional(), idempotencyKey: z.string().trim().min(1).max(500) }).strict().parse(request.body);
    const principal = principalOf(request);
    return options.sessionEvents.revise(request.params.id, request.params.eventId, { content: body.content, ...(body.evidenceRefs === undefined ? {} : { evidenceRefs: body.evidenceRefs }), idempotencyKey: body.idempotencyKey }, principal.id, principal.tenantId);
  });
  app.post<{ Params: { id: string; eventId: string } }>('/api/rooms/:id/session-events/:eventId/retract', async request => {
    if (!options.sessionEvents) throw new Conflict('Shared Session event service is not configured');
    const body = z.object({ reason: z.string().trim().min(1).max(4000), idempotencyKey: z.string().trim().min(1).max(500) }).strict().parse(request.body);
    const principal = principalOf(request);
    return options.sessionEvents.retract(request.params.id, request.params.eventId, body.reason, body.idempotencyKey, principal.id, principal.tenantId);
  });
  app.get<{ Params: { id: string } }>('/api/goals/:id', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const principal = principalOf(request); return options.domain.getGoal(request.params.id, principal.id, principal.tenantId);
  });
  app.get<{ Params: { id: string } }>('/api/goals/:id/plans', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const principal = principalOf(request); return options.domain.listPlans(request.params.id, principal.id, principal.tenantId);
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>('/api/goals/:id/plans/page', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const principal = principalOf(request); const parsed = cursorCollectionLimit(request.query); const limit = parsed ?? 50;
    return options.domain.listPlansPage(request.params.id, principal.id, principal.tenantId, limit, request.query.cursor);
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id/plans', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ nodes: z.array(z.object({ id: z.string().min(1).max(128), title: z.string().trim().min(1).max(500), instruction: z.string().trim().min(1).max(4000).optional(), kind: z.enum(['task', 'review', 'approval', 'deliverable']).optional(), dependsOn: z.array(z.string().min(1).max(128)).optional(), evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(50).optional(), evidenceRunId: z.string().trim().min(1).max(200).optional() }).strict()).min(1).max(100) }).strict().parse(request.body);
    const principal = principalOf(request); return options.domain.createPlan({ goalId: request.params.id, nodes: body.nodes.map(node => ({ id: node.id, title: node.title, ...(node.instruction === undefined ? {} : { instruction: node.instruction }), ...(node.kind === undefined ? {} : { kind: node.kind }), ...(node.dependsOn === undefined ? {} : { dependsOn: node.dependsOn }), ...(node.evidenceRefs === undefined ? {} : { evidenceRefs: node.evidenceRefs }), ...(node.evidenceRunId === undefined ? {} : { evidenceRunId: node.evidenceRunId }) })) }, undefined, principal.id, principal.tenantId);
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id/plans/revise', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ nodes: z.array(z.object({ id: z.string().min(1).max(128), title: z.string().trim().min(1).max(500), instruction: z.string().trim().min(1).max(4000).optional(), kind: z.enum(['task', 'review', 'approval', 'deliverable']).optional(), dependsOn: z.array(z.string().min(1).max(128)).optional(), evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(50).optional(), evidenceRunId: z.string().trim().min(1).max(200).optional() }).strict()).min(1).max(100) }).strict().parse(request.body);
    const principal = principalOf(request); return options.domain.createPlanRevision({ goalId: request.params.id, nodes: body.nodes.map(node => ({ id: node.id, title: node.title, ...(node.instruction === undefined ? {} : { instruction: node.instruction }), ...(node.kind === undefined ? {} : { kind: node.kind }), ...(node.dependsOn === undefined ? {} : { dependsOn: node.dependsOn }), ...(node.evidenceRefs === undefined ? {} : { evidenceRefs: node.evidenceRefs }), ...(node.evidenceRunId === undefined ? {} : { evidenceRunId: node.evidenceRunId }) })) }, undefined, principal.id, principal.tenantId);
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id/schedule', async (request, reply) => {
    if (!options.domain || !options.taskScheduler) return reply.code(503).send({ error: 'Configure the Goal domain, model, dispatcher and task scheduler before scheduling a Goal' });
    const principal = principalOf(request);
    const plans = await options.domain.listPlans(request.params.id, principal.id, principal.tenantId);
    const plan = plans[0];
    if (!plan) throw new AeeisNotFound(`Goal ${request.params.id} has no plan`);
    const body = requestSchema.omit({ goal: true, goalId: true, taskExecution: true }).parse(request.body ?? {});
    const dispatches = await options.taskScheduler.schedulePlan(plan.id, { owner: principal.id, tenantId: principal.tenantId }, { runOptions: body });
    return reply.code(202).send({ goalId: request.params.id, planId: plan.id, dispatches: dispatches.map(publicTaskDispatch) });
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/goals/:id/memories', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const principal = principalOf(request); const limit = collectionLimit(request.query); return options.domain.listMemories(request.params.id, principal.id, principal.tenantId, limit);
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id/memories', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ kind: z.enum(['fact', 'decision', 'preference', 'note']), scope: z.enum(['private', 'project', 'session']).optional(), classification: z.enum(['public', 'internal', 'confidential', 'private']).optional(), content: z.string().trim().min(1).max(30000), source: z.string().trim().max(1000).optional(), confidence: z.number().min(0).max(1).optional(), evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(100).optional() }).strict().parse(request.body);
    const principal = principalOf(request); return options.domain.addMemory(request.params.id, { kind: body.kind, content: body.content, ...(body.scope === undefined ? {} : { scope: body.scope }), ...(body.classification === undefined ? {} : { classification: body.classification }), ...(body.source === undefined ? {} : { source: body.source }), ...(body.confidence === undefined ? {} : { confidence: body.confidence }), ...(body.evidenceRefs === undefined ? {} : { evidenceRefs: body.evidenceRefs }) }, undefined, principal.id, principal.tenantId);
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id/memories/from-run', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ runId: z.string().regex(/^run_[a-f0-9-]{36}$/), kind: z.enum(['fact', 'decision', 'preference', 'note']), scope: z.enum(['private', 'project', 'session']).optional(), classification: z.enum(['public', 'internal', 'confidential', 'private']).optional(), content: z.string().trim().min(1).max(30000), source: z.string().trim().max(1000).optional(), confidence: z.number().min(0).max(1).optional(), evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(100) }).strict().parse(request.body);
    const principal = principalOf(request);
    const run = await getOwnedRun(options.repository, body.runId, principal.id, principal.tenantId);
    if (run.goalId !== request.params.id) throw new Conflict('Memory writeback Run is not linked to this Goal');
    const evidenceRefs = [...new Set(body.evidenceRefs)];
    const available = new Set(projectRunGraphs(run).evidence.nodes.map(node => node.id));
    if (evidenceRefs.some(ref => !available.has(ref))) throw new Conflict('Memory writeback references evidence that this Run did not produce or receive');
    const scope = body.scope ?? 'project';
    const classification = scope === 'private' ? 'private' : (body.classification ?? run.privacy);
    if (classificationRank(classification) < classificationRank(run.privacy)) throw new Conflict('Memory classification cannot be less restrictive than the source Run privacy');
    return options.domain.addMemory(request.params.id, {
      kind: body.kind, content: body.content, scope, classification,
      source: body.source ?? `run:${run.id}`,
      ...(body.confidence === undefined ? {} : { confidence: body.confidence }),
      evidenceRefs, evidenceRunId: run.id,
    }, undefined, principal.id, principal.tenantId);
  });
  app.post<{ Params: { id: string; memoryId: string } }>('/api/goals/:id/memories/:memoryId/correct', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ kind: z.enum(['fact', 'decision', 'preference', 'note']), scope: z.enum(['private', 'project', 'session']).optional(), classification: z.enum(['public', 'internal', 'confidential', 'private']).optional(), content: z.string().trim().min(1).max(30000), source: z.string().trim().max(1000).optional(), confidence: z.number().min(0).max(1).optional(), evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(100).optional() }).strict().parse(request.body);
    const principal = principalOf(request); return options.domain.correctMemory(request.params.id, request.params.memoryId, {
      kind: body.kind, content: body.content,
      ...(body.scope === undefined ? {} : { scope: body.scope }),
      ...(body.classification === undefined ? {} : { classification: body.classification }),
      ...(body.source === undefined ? {} : { source: body.source }),
      ...(body.confidence === undefined ? {} : { confidence: body.confidence }),
      ...(body.evidenceRefs === undefined ? {} : { evidenceRefs: body.evidenceRefs }),
    }, undefined, principal.id, principal.tenantId);
  });
  app.post<{ Params: { id: string; memoryId: string } }>('/api/goals/:id/memories/:memoryId/retract', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ reason: z.string().trim().min(1).max(4000) }).strict().parse(request.body);
    const principal = principalOf(request); return options.domain.retractMemory(request.params.id, request.params.memoryId, body.reason, undefined, principal.id, principal.tenantId);
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id/context-manifests', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ purpose: z.string().trim().min(1).max(500), query: z.string().max(2000).optional(), audience: z.array(z.string().min(1).max(128)).max(100).optional(), audienceMode: z.enum(['owner', 'room']).optional(), maxItems: z.number().int().min(1).max(50).optional(), memoryMaxItems: z.number().int().min(1).max(50).optional(), memoryClassifications: z.array(z.enum(['public', 'internal', 'confidential', 'private'])).max(4).optional(), knowledgeClassifications: z.array(z.enum(['public', 'internal', 'confidential', 'private'])).max(4).optional() }).strict().parse(request.body);
    const principal = principalOf(request); return options.domain.createContextManifest(request.params.id, { purpose: body.purpose, ...(body.query === undefined ? {} : { query: body.query }), ...(body.audience === undefined ? {} : { audience: body.audience }), ...(body.audienceMode === undefined ? {} : { audienceMode: body.audienceMode }), ...(body.maxItems === undefined ? {} : { maxItems: body.maxItems }), ...(body.memoryMaxItems === undefined ? {} : { memoryMaxItems: body.memoryMaxItems }), ...(body.memoryClassifications === undefined ? {} : { memoryClassifications: body.memoryClassifications }), ...(body.knowledgeClassifications === undefined ? {} : { knowledgeClassifications: body.knowledgeClassifications }) }, undefined, principal.id, principal.tenantId);
  });
  app.get<{ Params: { id: string; manifestId: string } }>('/api/goals/:id/context-manifests/:manifestId', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const principal = principalOf(request);
    return options.domain.getContextManifest(request.params.id, request.params.manifestId, principal.id, principal.tenantId);
  });
  app.get<{ Params: { id: string } }>('/api/plans/:id/snapshot', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const principal = principalOf(request); return options.domain.getSnapshot(request.params.id, principal.id, principal.tenantId);
  });
  app.post<{ Params: { planId: string; taskId: string } }>('/api/plans/:planId/tasks/:taskId/transition', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ transition: z.enum(['start', 'wait', 'request_approval', 'block', 'succeed', 'fail', 'cancel', 'mark_unknown', 'retry']), reason: z.string().max(4000).optional() }).strict().parse(request.body);
    const principal = principalOf(request); return options.domain.transitionTask({ planId: request.params.planId, taskId: request.params.taskId, transition: body.transition, ...(body.reason === undefined ? {} : { reason: body.reason }) }, undefined, principal.id, principal.tenantId);
  });
  app.post<{ Params: { planId: string; taskId: string } }>('/api/plans/:planId/tasks/:taskId/run', async (request, reply) => {
    if (!options.domain || !options.engine || !options.dispatcher) return reply.code(503).send({ error: 'Configure the Goal service, model and dispatcher before starting a task Run' });
    const principal = principalOf(request);
    const plan = await options.domain.getPlan(request.params.planId, principal.id, principal.tenantId);
    const task = plan.nodes.find(node => node.id === request.params.taskId);
    if (!task) throw new AeeisNotFound(`Unknown task: ${request.params.taskId}`);
    const goal = await options.domain.getGoal(plan.goalId, principal.id, principal.tenantId);
    const body = requestSchema.omit({ goal: true, goalId: true, taskExecution: true }).parse(request.body ?? {});
    const run = await options.engine.create({ goal: `${goal.title}：${task.title}`, goalId: goal.id, taskExecution: { domainPlanId: plan.id, taskId: task.id }, ...body }, principal.id, principal.tenantId);
    await notify(run.id);
    return reply.code(202).send({ id: run.id, goalId: goal.id, domainPlanId: plan.id, taskId: task.id });
  });
  app.get<{ Params: { id: string } }>('/api/plans/:id/scheduler', async request => {
    if (!options.taskScheduler) throw new Conflict('Task scheduler is not configured');
    const principal = principalOf(request);
    if (options.taskScheduler.listVisibleForPlan) return (await options.taskScheduler.listVisibleForPlan(request.params.id, { owner: principal.id, tenantId: principal.tenantId })).map(publicTaskDispatch);
    await options.domain?.getPlan(request.params.id, principal.id, principal.tenantId);
    return (await options.taskScheduler.list({ owner: principal.id, tenantId: principal.tenantId }, request.params.id)).map(publicTaskDispatch);
  });
  app.post<{ Params: { id: string } }>('/api/plans/:id/schedule', async (request, reply) => {
    if (!options.taskScheduler) return reply.code(503).send({ error: 'Task scheduler is not configured' });
    if (!options.domain) throw new Conflict('Goal domain is not configured');
    const principal = principalOf(request);
    const body = requestSchema.omit({ goal: true, goalId: true, taskExecution: true }).parse(request.body ?? {});
    const dispatches = await options.taskScheduler.schedulePlan(request.params.id, { owner: principal.id, tenantId: principal.tenantId }, { runOptions: body });
    return reply.code(202).send({ planId: request.params.id, dispatches: dispatches.map(publicTaskDispatch) });
  });
  app.post<{ Params: { id: string } }>('/api/plans/:id/scheduler/reconcile', async request => {
    if (!options.taskScheduler) throw new Conflict('Task scheduler is not configured');
    const principal = principalOf(request);
    return (await options.taskScheduler.reconcilePlan(request.params.id, { owner: principal.id, tenantId: principal.tenantId })).map(publicTaskDispatch);
  });
  app.post<{ Params: { planId: string; taskId: string } }>('/api/plans/:planId/tasks/:taskId/schedule', async (request, reply) => {
    if (!options.taskScheduler) return reply.code(503).send({ error: 'Task scheduler is not configured' });
    const principal = principalOf(request);
    const body = requestSchema.omit({ goal: true, goalId: true, taskExecution: true }).parse(request.body ?? {});
    const dispatch = await options.taskScheduler.scheduleNodeById(request.params.planId, request.params.taskId, { owner: principal.id, tenantId: principal.tenantId }, { runOptions: body });
    return reply.code(202).send(publicTaskDispatch(dispatch));
  });
  app.post<{ Params: { planId: string; taskId: string; action: string } }>('/api/plans/:planId/tasks/:taskId/control/:action', async (request, reply) => {
    if (!options.taskScheduler) return reply.code(503).send({ error: 'Task scheduler is not configured' });
    const action = z.enum(['dispatch', 'pause', 'resume', 'cancel', 'retry', 'reconcile']).parse(request.params.action) as TaskSchedulerAction;
    const principal = principalOf(request);
    try {
      const dispatch = await options.taskScheduler.controlTask(request.params.planId, request.params.taskId, action, { owner: principal.id, tenantId: principal.tenantId }, request.body ?? {});
      return reply.code(202).send(publicTaskDispatch(dispatch));
    } catch (error) {
      throw new Conflict(error instanceof Error ? error.message : 'Task control failed');
    }
  });
  app.get<{ Querystring: { status?: string; limit?: string } }>('/api/reminders', async request => {
    if (!options.reminders) throw new Conflict('Reminder store is not configured');
    const status = request.query.status === undefined ? undefined : z.enum(['scheduled', 'firing', 'projected', 'cancelled', 'failed']).parse(request.query.status) as ReminderStatus;
    return options.reminders.list(collaborationScope(principalOf(request)), status, collectionLimit({ limit: request.query.limit }));
  });
  app.get<{ Querystring: { status?: string; limit?: string; cursor?: string } }>('/api/reminders/page', async request => {
    if (!options.reminders?.listPage) throw new Conflict('Reminder cursor pagination is unavailable');
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().min(1).max(1000).optional(), status: z.enum(['scheduled', 'firing', 'projected', 'cancelled', 'failed']).optional() }).strict().parse(request.query);
    if (parsed.limit === undefined) throw new RangeError('limit is required for reminder cursor pagination');
    const status = parsed.status as ReminderStatus | undefined;
    const principal = principalOf(request);
    return options.reminders.listPage({ owner: principal.id, tenantId: principal.tenantId }, parsed.limit, parsed.cursor, status);
  });
  app.post('/api/reminders', async request => {
    if (!options.reminders) throw new Conflict('Reminder store is not configured');
    const body = z.object({ title: z.string().trim().min(1).max(200), message: z.string().trim().min(1).max(8000), dueAt: z.string().datetime({ offset: true }), channel: z.string().trim().min(1).max(100), destination: z.string().trim().min(1).max(500), privacy: z.enum(['public', 'internal', 'confidential', 'private']).optional(), recurrence: reminderRecurrenceSchema.optional(), goalId: z.string().trim().min(1).max(200).optional(), planId: z.string().trim().min(1).max(200).optional(), taskId: z.string().trim().min(1).max(200).optional(), idempotencyKey: z.string().trim().min(1).max(500).optional(), maxAttempts: z.number().int().min(1).max(20).optional() }).strict().parse(request.body);
    const principal = principalOf(request);
    if (body.goalId && options.domain) await options.domain.getGoal(body.goalId, principal.id, principal.tenantId);
    const reminder = await options.reminders.create({ title: body.title, message: body.message, dueAt: body.dueAt, delivery: { channel: body.channel, destination: body.destination }, ...(body.privacy === undefined ? {} : { privacy: body.privacy }), ...(body.recurrence === undefined ? {} : { recurrence: body.recurrence }), ...(body.goalId === undefined ? {} : { goalId: body.goalId }), ...(body.planId === undefined ? {} : { planId: body.planId }), ...(body.taskId === undefined ? {} : { taskId: body.taskId }), ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }), ...(body.maxAttempts === undefined ? {} : { maxAttempts: body.maxAttempts }) }, { owner: principal.id, tenantId: principal.tenantId });
    await notifyReminder(reminder.id);
    return reminder;
  });
  app.get<{ Params: { id: string } }>('/api/reminders/:id', async request => {
    if (!options.reminders) throw new Conflict('Reminder store is not configured');
    return options.reminders.get(request.params.id, collaborationScope(principalOf(request)));
  });
  app.post<{ Params: { id: string; action: string } }>('/api/reminders/:id/:action', async request => {
    if (!options.reminders) throw new Conflict('Reminder store is not configured');
    const scope = collaborationScope(principalOf(request));
    if (request.params.action === 'cancel') { const reminder = await options.reminders.cancel(request.params.id, scope); await notifyReminder(reminder.id); return reminder; }
    if (request.params.action === 'retry') { const reminder = await options.reminders.retry(request.params.id, scope); await notifyReminder(reminder.id); return reminder; }
    throw new Conflict('Unsupported reminder action');
  });
  app.get('/api/evolution/activation', async request => {
    if (!options.rsi) throw new Conflict('RSI service is not configured');
    return options.rsi.activationStatus(evolutionScope(principalOf(request)));
  });
  app.get('/api/evolution/traffic', async request => {
    if (!options.rsi) throw new Conflict('RSI service is not configured');
    return options.rsi.listTraffic(evolutionScope(principalOf(request)));
  });
  app.get<{ Querystring: { limit?: string } }>('/api/evolution/candidates', async request => {
    const limit = collectionLimit(request.query);
    if (!options.rsi) return [];
    return options.rsi.list(evolutionScope(principalOf(request)), limit);
  });
  app.get<{ Querystring: { limit?: string } }>('/api/evolution/signals', async request => {
    const limit = collectionLimit(request.query);
    const principal = principalOf(request);
    const runs = await options.repository.list({ owner: principal.id, tenantId: principal.tenantId }, limit);
    const signals = runs.flatMap(run => improvementSignalsForRun(run)).map(signal => ({
      ...signal,
      candidateId: runs.find(run => run.id === signal.runId)?.events.find(event => event.type === 'rsi.proposal.created' && event.data.signalId === signal.id)?.data.candidateId,
      synthesis: (() => {
        const run = runs.find(run => run.id === signal.runId)!;
        const attempt = synthesisAttempts(run).find(item => item.signalId === signal.id);
        return attempt ? { id: attempt.id, state: attempt.state, inputHash: attempt.inputHash, idempotencyKey: attempt.idempotencyKey, usage: attempt.usage, error: attempt.error ?? attempt.settlementError, settled: attempt.settled, hasProposal: Boolean(attempt.proposal) } : undefined;
      })(),
    }));
    return limit === undefined ? signals : signals.slice(0, limit);
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/rsi-proposal-synthesis-reconcile', async request => {
    if (!options.rsiProposalSynthesis) throw new Conflict('RSI proposal synthesis is not configured');
    const principal = principalOf(request);
    await getOwnedRun(options.repository, request.params.id, principal.id, principal.tenantId);
    await options.rsiProposalSynthesis.reconcile(request.params.id, request.body, { owner: principal.id, tenantId: principal.tenantId });
    return getOwnedRun(options.repository, request.params.id, principal.id, principal.tenantId);
  });
  app.get<{ Params: { id: string } }>('/api/evolution/candidates/:id', async request => {
    if (!options.rsi) throw new Error('RSI service is not configured');
    return options.rsi.get(request.params.id, evolutionScope(principalOf(request)));
  });
  app.post('/api/evolution/candidates', async request => {
    if (!options.rsi) throw new Error('RSI service is not configured');
    return options.rsi.propose(request.body, evolutionScope(principalOf(request)));
  });
  app.post<{ Params: { id: string; action: string } }>('/api/evolution/candidates/:id/:action', async request => {
    if (!options.rsi) throw new Error('RSI service is not configured');
    const { id, action } = request.params;
    const scope = evolutionScope(principalOf(request));
    if (action === 'evaluate') return options.rsi.evaluate(id, request.body, scope);
    if (action === 'evaluate-suite') {
      if (!options.rsiHarness) throw new Conflict('RSI evaluator is not configured');
      return options.rsi.evaluateSuite(id, request.body, options.rsiHarness, scope);
    }
    if (action === 'reconcile-evaluation') return options.rsi.reconcileEvaluation(id, request.body, scope);
    if (action === 'approve') return options.rsi.approve(id, z.object({ approvalRef: z.string().min(1).max(200) }).strict().parse(request.body).approvalRef, scope);
    if (action === 'start-shadow') return options.rsi.startShadow(id, scope);
    if (action === 'run-shadow') {
      if (!options.rsiHarness) throw new Conflict('RSI evaluator is not configured');
      return options.rsi.runRollout(id, 'shadow', request.body, options.rsiHarness, scope);
    }
    if (action === 'reconcile-rollout') return options.rsi.reconcileRollout(id, request.body, scope);
    if (action === 'record-shadow') return options.rsi.recordShadow(id, request.body, scope);
    if (action === 'start-canary') return options.rsi.startCanary(id, scope);
    if (action === 'run-canary') {
      if (!options.rsiHarness) throw new Conflict('RSI evaluator is not configured');
      return options.rsi.runRollout(id, 'canary', request.body, options.rsiHarness, scope);
    }
    if (action === 'record-canary') return options.rsi.recordCanary(id, request.body, scope);
    if (action === 'promote') return options.rsi.promote(id, scope);
    if (action === 'activate') return options.rsi.activate(id, z.object({ activationRef: z.string().trim().min(1).max(200) }).strict().parse(request.body).activationRef, scope);
    if (action === 'start-traffic') {
      const body = z.object({ percentage: z.number().int().min(1).max(9999), rolloutRef: z.string().trim().min(1).max(200), safety: z.object({ minScore: z.number().min(0).max(1), maxFailedObservations: z.number().int().min(1).max(100), autoPause: z.boolean() }).strict().optional() }).strict().parse(request.body);
      return options.rsi.startTraffic(id, body.percentage, body.rolloutRef, scope, body.safety);
    }
    if (action === 'update-traffic') {
      const body = z.object({ percentage: z.number().int().min(1).max(9999), rolloutRef: z.string().trim().min(1).max(200) }).strict().parse(request.body);
      return options.rsi.updateTraffic(id, body.percentage, body.rolloutRef, scope);
    }
    if (action === 'pause-traffic') {
      const body = z.object({ reason: z.string().trim().min(1).max(4000) }).strict().parse(request.body);
      return options.rsi.pauseTraffic(id, body.reason, scope);
    }
    if (action === 'resume-traffic') {
      const body = z.object({ rolloutRef: z.string().trim().min(1).max(200) }).strict().parse(request.body);
      return options.rsi.resumeTraffic(id, body.rolloutRef, scope);
    }
    if (action === 'stop-traffic') {
      const body = z.object({ reason: z.string().trim().min(1).max(4000) }).strict().parse(request.body);
      return options.rsi.stopTraffic(id, body.reason, scope);
    }
    if (action === 'record-traffic') {
      const body = z.object({ id: z.string().trim().min(1).max(200), passed: z.boolean(), score: z.number().min(0).max(1), evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(100), recordedAt: z.string().datetime({ offset: true }).optional() }).strict().parse(request.body);
      return options.rsi.recordTraffic(id, { ...body, recordedAt: body.recordedAt ?? new Date().toISOString() }, scope);
    }
    if (action === 'rollback') return options.rsi.rollback(id, z.object({ reason: z.string().min(1).max(4000) }).strict().parse(request.body).reason, scope);
    throw new Conflict('Unsupported evolution action');
  });
  app.get('/api/skills/proposals', async () => {
    if (!options.skills) throw new Conflict('Skill governance is not configured');
    return options.skills.propose();
  });
  app.post<{ Params: { id: string } }>('/api/skills/proposals/:id/apply', async request => {
    if (!options.skills) throw new Conflict('Skill governance is not configured');
    z.object({ approvalRef: z.string().trim().min(1).max(200) }).strict().parse(request.body ?? {});
    return options.skills.apply(request.params.id);
  });
  app.post<{ Params: { methodId: string; version: string } }>('/api/skills/:methodId/:version/rollback', async request => {
    if (!options.skills) throw new Conflict('Skill governance is not configured');
    const body = z.object({ reason: z.string().trim().min(1).max(4000) }).strict().parse(request.body ?? {});
    return options.skills.rollback(request.params.methodId, request.params.version);
  });
  app.get<{ Querystring: { limit?: string } }>('/api/collaborations/triggers/policies', async request => {
    if (!options.collaborationTriggers) throw new Conflict('Collaboration trigger service is not configured');
    const limit = collectionLimit(request.query);
    return options.collaborationTriggers.listPolicies(collaborationScope(principalOf(request)), limit);
  });
  app.post('/api/collaborations/triggers/policies', async request => {
    if (!options.collaborationTriggers) throw new Conflict('Collaboration trigger service is not configured');
    const principal = principalOf(request);
    return options.collaborationTriggers.createPolicy(request.body, { owner: principal.id, tenantId: principal.tenantId });
  });
  app.patch<{ Params: { id: string } }>('/api/collaborations/triggers/policies/:id', async request => {
    if (!options.collaborationTriggers) throw new Conflict('Collaboration trigger service is not configured');
    return options.collaborationTriggers.updatePolicy(request.params.id, request.body, collaborationScope(principalOf(request)));
  });
  app.delete<{ Params: { id: string } }>('/api/collaborations/triggers/policies/:id', async request => {
    if (!options.collaborationTriggers) throw new Conflict('Collaboration trigger service is not configured');
    await options.collaborationTriggers.deletePolicy(request.params.id, collaborationScope(principalOf(request))); return { status: 'deleted' };
  });
  app.get<{ Querystring: { policyId?: string; limit?: string } }>('/api/collaborations/triggers/decisions', async request => {
    if (!options.collaborationTriggers) throw new Conflict('Collaboration trigger service is not configured');
    const policyId = request.query.policyId === undefined ? undefined : z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/).parse(request.query.policyId);
    const limit = collectionLimit({ limit: request.query.limit });
    return options.collaborationTriggers.listDecisions(collaborationScope(principalOf(request)), policyId, limit);
  });
  app.post<{ Params: { id: string } }>('/api/collaborations/triggers/decisions/:id/reconcile', async request => {
    if (!options.collaborationTriggers) throw new Conflict('Collaboration trigger service is not configured');
    try {
      return await options.collaborationTriggers.reconcileDecision(request.params.id, collaborationTriggerReconcileSchema.parse(request.body), collaborationScope(principalOf(request)));
    } catch (error) {
      if (error instanceof CollaborationTriggerNotFound) throw error;
      throw new Conflict(error instanceof Error ? error.message : 'Collaboration trigger decision reconciliation failed');
    }
  });
  app.post('/api/collaborations/triggers/evaluate', async request => {
    if (!options.collaborationTriggers) throw new Conflict('Collaboration trigger service is not configured');
    const principal = principalOf(request);
    const body = collaborationTriggerEventSchema.omit({ schemaVersion: true, owner: true, tenantId: true }).parse(request.body);
    return options.collaborationTriggers.evaluate({ ...body, schemaVersion: 'collaboration-trigger-event/1', owner: principal.id, tenantId: principal.tenantId }, { owner: principal.id, tenantId: principal.tenantId });
  });
  // Worker/event bridges use this route for Feishu/Hermes or internal system
  // events. The worker token is checked by the shared /internal middleware.
  app.post('/internal/collaborations/triggers/evaluate', async request => {
    if (!options.collaborationTriggers) throw new Conflict('Collaboration trigger service is not configured');
    return options.collaborationTriggers.evaluate(request.body);
  });
  app.get<{ Querystring: { limit?: string } }>('/api/collaborations/competitions', async request => {
    if (!options.collaboration) return [];
    const limit = collectionLimit(request.query);
    return options.collaboration.listCompetitions(collaborationScope(principalOf(request)), limit);
  });
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/api/collaborations/competitions/page', async request => {
    if (!options.collaboration) return { items: [] };
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200), cursor: z.string().min(1).max(1000).optional() }).strict().parse(request.query);
    return options.collaboration.pageCompetitions(collaborationScope(principalOf(request)), query.limit, query.cursor);
  });
  app.get<{ Params: { id: string } }>('/api/collaborations/competitions/:id', async request => {
    if (!options.collaboration) throw new Error('Collaboration service is not configured');
    return options.collaboration.getCompetition(request.params.id, collaborationScope(principalOf(request)));
  });
  app.post('/api/collaborations/competitions', async request => {
    if (!options.collaboration) throw new Error('Collaboration service is not configured');
    return options.collaboration.createCompetition(request.body, collaborationScope(principalOf(request)));
  });
  app.post<{ Params: { id: string; action: string } }>('/api/collaborations/competitions/:id/:action', async request => {
    if (!options.collaboration) throw new Error('Collaboration service is not configured');
    const { id, action } = request.params;
    const scope = collaborationScope(principalOf(request));
    if (action === 'candidate') return options.collaboration.submitCandidate(id, request.body, scope);
    if (action === 'begin-evaluation') {
      const evaluatorAgentId = z.object({ evaluatorAgentId: z.string().min(1).max(128) }).strict().parse(request.body).evaluatorAgentId;
      await options.collaboration.beginEvaluation(id, evaluatorAgentId, scope);
      return options.collaboration.getEvaluationView(id, scope);
    }
    if (action === 'score') {
      const body = z.object({ evaluatorAgentId: z.string().min(1).max(128), score: z.unknown() }).strict().parse(request.body);
      await options.collaboration.submitScore(id, body.evaluatorAgentId, body.score, scope);
      return options.collaboration.getEvaluationView(id, scope);
    }
    if (action === 'run') {
      if (!options.competitionRunner || !options.competitionEvaluator || !options.competitionEvaluatorAgentId) throw new Conflict('Internal competition model pool is not configured');
      await options.collaboration.getCompetition(id, scope);
      return options.collaboration.runCompetition(id, options.competitionEvaluatorAgentId, options.competitionRunner, options.competitionEvaluator, scope);
    }
    if (action === 'reconcile-attempt') return options.collaboration.reconcileCompetitionAttempt(id, request.body, scope);
    if (action === 'reconcile-evaluator') return options.collaboration.reconcileCompetitionEvaluator(id, request.body, scope);
    throw new Conflict('Unsupported competition action');
  });
  app.get<{ Querystring: { limit?: string } }>('/api/collaborations/debates', async request => {
    if (!options.collaboration) return [];
    const limit = collectionLimit(request.query);
    return options.collaboration.listDebates(collaborationScope(principalOf(request)), limit);
  });
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/api/collaborations/debates/page', async request => {
    if (!options.collaboration) return { items: [] };
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200), cursor: z.string().min(1).max(1000).optional() }).strict().parse(request.query);
    return options.collaboration.pageDebates(collaborationScope(principalOf(request)), query.limit, query.cursor);
  });
  app.get<{ Params: { id: string } }>('/api/collaborations/debates/:id', async request => {
    if (!options.collaboration) throw new Error('Collaboration service is not configured');
    return options.collaboration.getDebate(request.params.id, collaborationScope(principalOf(request)));
  });
  app.post('/api/collaborations/debates', async request => {
    if (!options.collaboration) throw new Error('Collaboration service is not configured');
    return options.collaboration.createDebate(request.body, collaborationScope(principalOf(request)));
  });
  app.post<{ Params: { id: string; action: string } }>('/api/collaborations/debates/:id/:action', async request => {
    if (!options.collaboration) throw new Error('Collaboration service is not configured');
    const { id, action } = request.params;
    const scope = collaborationScope(principalOf(request));
    if (action === 'message') return options.collaboration.appendMessage(id, request.body, scope);
    if (action === 'reconcile-attempt') return options.collaboration.reconcileDebateAttempt(id, request.body, scope);
    if (action === 'close') return options.collaboration.closeDebate(id, z.object({ reason: z.string().min(1).max(4000) }).strict().parse(request.body).reason, scope);
    if (action === 'run') {
      if (!options.debateRunner) throw new Conflict('Internal debate model pool is not configured');
      await options.collaboration.getDebate(id, scope);
      return options.debateRunner.run(id, scope);
    }
    throw new Conflict('Unsupported debate action');
  });
  app.get<{ Querystring: { status?: string; limit?: string } }>('/api/collaborations/projections', async request => {
    if (!options.projection) return [];
    const status = request.query.status === undefined ? undefined : z.enum(['pending', 'failed', 'unknown', 'delivered']).parse(request.query.status);
    const limit = collectionLimit({ limit: request.query.limit });
    return options.projection.list(status, collaborationScope(principalOf(request)), limit);
  });
  app.post('/api/collaborations/projections', async request => {
    if (!options.projection) throw new Conflict('Projection outbox is not configured');
    const body = z.object({ channel: z.string().trim().min(1).max(100), destination: z.string().trim().min(1).max(500), aggregateType: z.enum(['room', 'debate', 'competition', 'evolution', 'goal', 'plan', 'task', 'run', 'reminder', 'session_event']), aggregateId: z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/), idempotencyKey: z.string().trim().min(1).max(500).optional() }).strict().parse(request.body);
    let record: unknown;
    if (body.aggregateType === 'debate' || body.aggregateType === 'competition') {
      if (!options.collaboration) throw new Conflict('Collaboration service is not configured');
      const scope = collaborationScope(principalOf(request));
      record = body.aggregateType === 'debate' ? await options.collaboration.getDebate(body.aggregateId, scope) : await options.collaboration.getCompetition(body.aggregateId, scope);
    } else if (body.aggregateType === 'evolution') {
      if (!options.rsi) throw new Conflict('RSI service is not configured');
      const scope = evolutionScope(principalOf(request));
      const candidate = await options.rsi.get(body.aggregateId, scope);
      const traffic = (await options.rsi.listTraffic(scope)).filter(route => route.candidateId === candidate.id);
      record = { ...candidate, ...(traffic.length ? { traffic } : {}) };
    } else if (body.aggregateType === 'run') {
      record = await getOwnedRun(options.repository, body.aggregateId, principalOf(request).id, principalOf(request).tenantId);
    } else if (body.aggregateType === 'reminder') {
      if (!options.reminders) throw new Conflict('Reminder store is not configured');
      record = await options.reminders.get(body.aggregateId, collaborationScope(principalOf(request)));
    } else if (body.aggregateType === 'session_event') {
      if (!options.sessionEvents) throw new Conflict('Shared Session event service is not configured');
      const principal = principalOf(request);
      record = await options.sessionEvents.get(body.aggregateId, principal.id, principal.tenantId);
    } else if (body.aggregateType === 'room') {
      if (!options.domain) throw new Conflict('Goal domain is not configured');
      const principal = principalOf(request);
      record = await options.domain.getRoomProjectionForPrincipal(body.aggregateId, principal.id, principal.tenantId);
    } else {
      if (!options.domain) throw new Conflict('Goal domain is not configured');
      if (body.aggregateType === 'goal') record = await options.domain.getGoal(body.aggregateId, principalOf(request).id, principalOf(request).tenantId);
      else if (body.aggregateType === 'plan') record = await options.domain.getSnapshot(body.aggregateId, principalOf(request).id, principalOf(request).tenantId);
      else {
        const separator = body.aggregateId.indexOf('.');
        if (separator <= 0 || separator === body.aggregateId.length - 1) throw new Conflict('Task projection ID must be planId.taskId');
        const planId = body.aggregateId.slice(0, separator); const taskId = body.aggregateId.slice(separator + 1);
        const snapshot = await options.domain.getSnapshot(planId, principalOf(request).id, principalOf(request).tenantId);
        const task = snapshot.plan.nodes.find(node => node.id === taskId);
        if (!task) throw new AeeisNotFound(`Unknown task: ${taskId}`);
        record = { planId, goalId: snapshot.goal.id, task };
      }
    }
    const recordVersion = record && typeof record === 'object' && typeof (record as Record<string, unknown>).updatedAt === 'string' ? (record as Record<string, unknown>).updatedAt : digest(record);
    const principal = principalOf(request);
    return options.projection.enqueue({ ...body, payload: record, owner: principal.id, tenantId: principal.tenantId, idempotencyKey: body.idempotencyKey ?? `${body.channel}:${body.destination}:${body.aggregateType}:${body.aggregateId}:${recordVersion}` });
  });
  app.post<{ Params: { id: string } }>('/api/collaborations/projections/:id/deliver', async request => {
    if (!options.projection || !options.projectionSink) throw new Conflict('Projection sink is not configured');
    return options.projection.deliver(request.params.id, options.projectionSink, collaborationScope(principalOf(request)));
  });
  app.post<{ Params: { id: string } }>('/api/collaborations/projections/:id/reconcile', async request => {
    if (!options.projection) throw new Conflict('Collaboration projection is not configured');
    const body = z.object({ outcome: z.enum(['completed', 'failed']), reason: z.string().trim().min(1).max(2000), externalId: z.string().trim().min(1).max(500).optional() }).strict().parse(request.body);
    return options.projection.reconcile(request.params.id, body.outcome, body.reason, body.externalId, collaborationScope(principalOf(request)));
  });
  app.post('/api/collaborations/projections/deliver-pending', async request => {
    if (!options.projection || !options.projectionSink) throw new Conflict('Projection sink is not configured');
    const body = z.object({ limit: z.number().int().min(1).max(100).optional() }).strict().parse(request.body ?? {});
    return options.projection.deliverPending(options.projectionSink, body.limit ?? 20, collaborationScope(principalOf(request)));
  });
  app.get<{ Params: { scope: string }; Querystring: { owner?: string } }>('/api/brain/:scope/export', async request => {
    if (!options.brain) return { error: 'Brain is not configured' };
    const principal = principalOf(request);
    const query = z.object({ owner: z.string().min(1).max(200).optional() }).strict().parse(request.query);
    const owner = query.owner ?? principal.id;
    const claims = options.brain.exportHistory(request.params.scope, principal, query.owner);
    await options.brainStore?.save(options.brain);
    const bundle = {
      schemaVersion: 'aeeis-brain-bundle/1' as const,
      exportedAt: new Date().toISOString(),
      owner,
      tenantId: principal.tenantId,
      scopeRef: request.params.scope,
      claims,
      contentHash: brainBundleContentHash(claims),
    };
    return bundle;
  });
  app.post<{ Params: { scope: string } }>('/api/brain/:scope/import', async request => {
    if (!options.brain || !options.brainStore) throw new Error('Brain is not configured');
    const bundle = brainBundleSchema.parse(request.body);
    if (bundle.scopeRef !== request.params.scope) throw new BrainConflict('Brain bundle scope does not match the import route');
    const result = options.brain.importBundle(bundle, principalOf(request));
    await options.brainStore.save(options.brain);
    return { schemaVersion: 'aeeis-brain-import/1' as const, ...result };
  });
  app.get<{ Params: { scope: string }; Querystring: { owner?: string; classification?: 'public' | 'internal' | 'confidential' | 'private'; query?: string; maxItems?: string } }>('/api/brain/:scope', async request => {
    if (!options.brain) return { error: 'Brain is not configured' };
    const query = z.object({ owner: z.string().min(1).max(200).optional(), classification: brainClassificationSchema.optional(), query: z.string().trim().min(1).max(2000).optional(), maxItems: z.coerce.number().int().min(1).max(100).default(20) }).strict().parse(request.query);
    const claims = query.query
      ? options.brain.search(request.params.scope, query.query, principalOf(request), query.classification ?? 'internal', query.maxItems, query.owner)
      : options.brain.read(request.params.scope, principalOf(request), query.classification ?? 'internal', query.owner);
    await options.brainStore?.save(options.brain);
    return { scope: request.params.scope, claims };
  });
  app.post('/api/brain/claims', async request => {
    if (!options.brain || !options.brainStore) throw new Error('Brain is not configured');
    const principal = principalOf(request);
    const input = brainClaimInputSchema.omit({ tenantId: true }).extend({ owner: z.string().min(1).max(200).optional() }).parse(request.body);
    const claim = options.brain.addClaim({ ...input, owner: input.owner ?? principal.id, tenantId: principal.tenantId }, principal);
    await options.brainStore.save(options.brain); return claim;
  });
  app.post('/api/brain/grants', async request => {
    if (!options.brain || !options.brainStore) throw new Error('Brain is not configured');
    const grant = options.brain.grant(brainGrantInputSchema.parse(request.body), principalOf(request));
    await options.brainStore.save(options.brain); return grant;
  });
  app.post<{ Params: { id: string } }>('/api/brain/grants/:id/revoke', async request => {
    if (!options.brain || !options.brainStore) throw new Error('Brain is not configured');
    options.brain.revoke(request.params.id, principalOf(request)); await options.brainStore.save(options.brain); return { status: 'revoked' };
  });
  app.delete<{ Params: { scope: string } }>('/api/brain/:scope', async request => {
    if (!options.brain || !options.brainStore) throw new Error('Brain is not configured');
    options.brain.deleteScope(request.params.scope, principalOf(request)); await options.brainStore.save(options.brain); return { status: 'deleted' };
  });
  app.get<{ Querystring: { limit?: string } }>('/api/runs', async request => { const principal = principalOf(request); const limit = collectionLimit(request.query); const runs = await listReadableRuns(options.repository, options.domain, principal, limit); return runs.map(({ id, goal, goalId, domainPlanId, taskExecution, followUpPlanId, status, updatedAt }) => ({ id, goal, ...(goalId ? { goalId } : {}), ...(domainPlanId ? { domainPlanId } : {}), ...(taskExecution ? { taskExecution } : {}), ...(followUpPlanId ? { followUpPlanId } : {}), status, updatedAt })); });
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/api/runs/page', async request => {
    const principal = principalOf(request); const limit = cursorCollectionLimit(request.query);
    if (limit === undefined) throw new RangeError('limit is required for cursor pagination');
    if (options.repository.page && (!options.domain || !(await options.domain.hasSharedReadableGoals(principal.id, principal.tenantId)))) {
      const result = await options.repository.page({ owner: principal.id, tenantId: principal.tenantId }, limit, request.query.cursor);
      return { items: result.runs.map(runSummary), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
    }
    const result = await pageReadableRuns(options.repository, options.domain, principal, limit, request.query.cursor);
    return { items: result.runs.map(({ id, goal, goalId, domainPlanId, taskExecution, followUpPlanId, status, updatedAt }) => ({ id, goal, ...(goalId ? { goalId } : {}), ...(domainPlanId ? { domainPlanId } : {}), ...(taskExecution ? { taskExecution } : {}), ...(followUpPlanId ? { followUpPlanId } : {}), status, updatedAt })), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>('/api/runs/:id/events', async request => {
    const eventsPage = options.repository.eventsPage;
    if (!eventsPage) throw new Error('Run event pagination is unavailable');
    const principal = principalOf(request); const limit = cursorCollectionLimit(request.query);
    if (limit === undefined) throw new RangeError('limit is required for event pagination');
    const run = await getReadableRun(options.repository, options.domain, request.params.id, principal);
    return eventsPage.call(options.repository, request.params.id, { owner: run.owner ?? 'owner', tenantId: run.tenantId ?? 'local' }, limit, request.query.cursor);
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string; waitMs?: string; heartbeatMs?: string } }>('/api/runs/:id/events/stream', async (request, reply) => {
    const eventsPage = options.repository.eventsPage;
    if (!eventsPage) throw new Error('Run event stream is unavailable');
    const readEvents = eventsPage;
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(100),
      cursor: z.string().min(1).max(1000).optional(),
      waitMs: z.coerce.number().int().min(0).max(60000).default(30000),
      heartbeatMs: z.coerce.number().int().min(100).max(30000).default(15000),
    }).strict().parse(request.query);
    const principal = principalOf(request);
    const readableRun = await getReadableRun(options.repository, options.domain, request.params.id, principal);
    const runScope = { owner: readableRun.owner ?? 'owner', tenantId: readableRun.tenantId ?? 'local' };
    const lastEventId = request.headers['last-event-id'];
    const headerCursor = lastEventId === undefined ? undefined : (() => {
      if (typeof lastEventId !== 'string' || !/^\d+$/.test(lastEventId)) throw new RangeError('Invalid Last-Event-ID');
      return encodeRunEventCursor(Number(lastEventId));
    })();
    const initialCursor = query.cursor ?? headerCursor;
    if (activeSseConnections >= maxSseConnections) return reply.code(429).send({ error: 'SSE connection limit reached' });
    activeSseConnections += 1;
    let released = false;
    const release = () => { if (!released) { released = true; activeSseConnections -= 1; } };
    // Resolve ownership and cursor validation before sending SSE headers. An
    // error discovered after the stream starts cannot be represented as a
    // normal HTTP 404/400 response and would otherwise surface as a 500.
    let initialPage: Awaited<ReturnType<typeof readEvents>>;
    try { initialPage = await readEvents.call(options.repository, request.params.id, runScope, query.limit, initialCursor); }
    catch (error) { release(); throw error; }
    let cursor = initialCursor;
    let closed = false;
    request.raw.once('close', () => { closed = true; release(); });
    const sleep = (duration: number): Promise<void> => new Promise(resolve => setTimeout(resolve, duration));
    async function* frames(): AsyncGenerator<string> {
      const startedAt = Date.now();
      let lastHeartbeatAt = startedAt;
      let pending: Awaited<ReturnType<typeof readEvents>> | undefined = initialPage;
      for (;;) {
        if (closed) return;
        const page = pending;
        pending = undefined;
        const nextPage = page ?? await readEvents.call(options.repository, request.params.id, runScope, query.limit, cursor);
        if (nextPage.events.length) {
          for (const item of nextPage.events) {
            if (closed) return;
            yield `id: ${item.seq}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`;
          }
          cursor = nextPage.nextCursor ?? Buffer.from(JSON.stringify({ seq: nextPage.events.at(-1)!.seq }), 'utf8').toString('base64url');
          lastHeartbeatAt = Date.now();
          continue;
        }
        const now = Date.now();
        if (now - lastHeartbeatAt >= query.heartbeatMs) {
          yield `event: heartbeat\ndata: ${JSON.stringify({ cursor: cursor ?? null, at: new Date(now).toISOString() })}\n\n`;
          lastHeartbeatAt = now;
        }
        // A slow scheduler can make the heartbeat and wait deadline mature
        // in the same pass. Emit the due heartbeat first so clients retain a
        // liveness signal before the terminal timeout frame.
        if (now - startedAt >= query.waitMs) {
          yield `event: timeout\ndata: ${JSON.stringify({ cursor: cursor ?? null, waitedMs: now - startedAt })}\n\n`;
          return;
        }
        await sleep(Math.min(250, Math.max(25, query.heartbeatMs - (now - lastHeartbeatAt))));
      }
    }
    const stream = Readable.from(frames());
    stream.once('end', release); stream.once('close', release); stream.once('error', release);
    try { return reply.type('text/event-stream').header('cache-control', 'no-cache').header('connection', 'keep-alive').send(stream); }
    catch (error) { release(); throw error; }
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', async request => { const principal = principalOf(request); return getReadableRun(options.repository, options.domain, request.params.id, principal); });
  app.get<{ Params: { id: string } }>('/api/runs/:id/explanation', async request => {
    const principal = principalOf(request);
    return explainRun(await getReadableRun(options.repository, options.domain, request.params.id, principal));
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/corrections', async request => {
    if (!options.rsi) throw new Error('RSI service is not configured');
    const principal = principalOf(request); const run = await getOwnedRun(options.repository, request.params.id, principal.id, principal.tenantId);
    const body = z.object({ target: z.enum(['profile', 'skill', 'prompt', 'workflow', 'tool-policy', 'model-policy']), baseVersion: z.string().min(1).max(200), proposedVersion: z.string().min(1).max(200), change: z.string().min(1).max(8000), reason: z.string().min(1).max(4000), risk: z.enum(['low', 'medium', 'high']), sourceReceiptRefs: z.array(z.string().min(1).max(200)).min(1).max(100) }).strict().parse(request.body);
    const expectedBaseVersion = run.evolution?.find(item => item.target === body.target)?.version ?? baselineVersions[body.target];
    if (body.baseVersion !== expectedBaseVersion) throw new Conflict(`Correction baseVersion must match the Run snapshot (${expectedBaseVersion})`);
    const evidenceRefs = new Set<string>([
      ...run.context.sources.map(source => source.id),
      ...run.artifacts.map(artifact => artifact.id),
      ...(run.toolReceipts ?? []).filter(receipt => receipt.authorization?.decision !== 'isolated').map(receipt => receipt.receiptId),
      ...(run.delegationOutcomes ?? []).filter(item => item.disposition !== 'isolated').map(outcome => outcome.receiptRef),
      ...run.calls.map(call => call.id),
    ]);
    if (body.sourceReceiptRefs.some(ref => !evidenceRefs.has(ref))) throw new Conflict('Correction references evidence that this Run did not receive');
    const correctionId = `correction_${randomUUID()}`;
    const candidate = await options.rsi.proposeFromCorrection({ ...body, correctionRef: correctionId }, { owner: principal.id, tenantId: principal.tenantId });
    const updated = await options.repository.mutate(run.id, current => {
      current.corrections ??= [];
      current.corrections.push({ id: correctionId, text: body.reason, candidateId: candidate.id, sourceRefs: body.sourceReceiptRefs, createdAt: new Date().toISOString() });
      event(current, 'rsi.correction.recorded', { correctionId, candidateId: candidate.id, sourceReceiptRefs: body.sourceReceiptRefs });
    });
    return { correction: updated.corrections?.at(-1), candidate };
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/graphs', async request => { const principal = principalOf(request); return projectRunGraphs(await getReadableRun(options.repository, options.domain, request.params.id, principal)); });
  async function notify(id: string): Promise<void> {
    try { await options.dispatcher?.notify(id); }
    catch {
      await options.repository.mutate(id, run => { event(run, 'dispatch.failed'); run.error = 'Execution service unavailable. Restore it and use resume dispatch.'; });
    }
  }
  async function notifyReminder(id: string): Promise<void> {
    try { await options.dispatcher?.notifyReminder?.(id); }
    catch (error) { console.error('AEEIS reminder timer notification failed', id, error instanceof Error ? error.message : error); }
  }
  app.post('/api/runs', async (request, reply) => {
    if (!options.engine || !options.dispatcher) return reply.code(503).send({ error: 'Configure a pinned model or AEEIS_PLANPRICE_URL with provider endpoints before starting an agent run' });
    const body = requestSchema.omit({ goalId: true, taskExecution: true }).parse(request.body);
    const principal = principalOf(request); const run = await options.engine.create(body, principal.id, principal.tenantId);
    await notify(run.id); return reply.code(202).send({ id: run.id });
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id/runs', async (request, reply) => {
    if (!options.domain || !options.engine || !options.dispatcher) return reply.code(503).send({ error: 'Configure the Goal service, model and dispatcher before starting a Goal run' });
    const principal = principalOf(request);
    const goal = await options.domain.getGoal(request.params.id, principal.id, principal.tenantId);
    const body = requestSchema.omit({ goal: true, goalId: true, taskExecution: true }).parse(request.body ?? {});
    const run = await options.engine.create({ goal: goal.title, goalId: goal.id, ...body }, principal.id, principal.tenantId);
    await notify(run.id); return reply.code(202).send({ id: run.id, goalId: goal.id });
  });
  app.post<{ Params: { id: string; action: string } }>('/api/runs/:id/:action', async (request, reply) => {
    if (!options.engine) return reply.code(503).send({ error: 'Model is not configured' });
    const { id, action } = request.params;
    const principal = principalOf(request); await getOwnedRun(options.repository, id, principal.id, principal.tenantId);
    if (action === 'model-reconcile') await options.engine.reconcileModelCall(id, request.body);
    else if (action === 'reconcile-cancelled') await options.engine.reconcileCancelledExternal(id, request.body);
    else if (action !== 'dispatch') await options.engine.command(id, action, request.body);
    await notify(id); return getOwnedRun(options.repository, id, principal.id, principal.tenantId);
  });
  app.post<{ Params: { id: string } }>('/internal/runs/:id/advance', async (request, reply) => {
    if (!options.engine) return reply.code(503).send({ error: 'Model is not configured' });
    return { status: await options.engine.advance(request.params.id) };
  });
  app.post<{ Params: { id: string } }>('/internal/reminders/:id/advance', async (request, reply) => {
    if (!options.reminders || !options.reminderPump) return reply.code(503).send({ error: 'Reminder timer is not configured' });
    return { protocol: 'aeeis-reminder-advance/1', ...(await options.reminderPump.advance(request.params.id)) };
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/agent-callback', async request => {
    if (!options.engine) throw new Conflict('Model runtime is not configured');
    const principal = principalOf(request); await getOwnedRun(options.repository, request.params.id, principal.id, principal.tenantId);
    const header = (name: string): string | undefined => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const timestamp = header('x-aeeis-timestamp');
    const signature = header('x-aeeis-signature');
    const updated = await options.engine.acceptAgentCallback(request.params.id, request.body as AgentTransportResponse, {
      ...(timestamp === undefined ? {} : { timestamp }), ...(signature === undefined ? {} : { signature }), ...(request.aeeisRawBody === undefined ? {} : { body: request.aeeisRawBody }),
    });
    try { await options.dispatcher?.notify(request.params.id); }
    catch (error) {
      await options.repository.mutate(request.params.id, run => {
        event(run, 'dispatch.failed', { reason: error instanceof Error ? error.message : 'Execution service unavailable', source: 'agent-callback' });
      });
    }
    return updated;
  });
  return app;
}

function principalOf(request: FastifyRequest): Principal {
  if (!request.aeeisPrincipal) throw new Error('Authenticated principal missing');
  return request.aeeisPrincipal;
}

function evolutionScope(principal: Principal): { owner: string; tenantId: string } | undefined {
  return principal.roles.includes('operator') ? undefined : { owner: principal.id, tenantId: principal.tenantId };
}

function collaborationScope(principal: Principal): { owner: string; tenantId: string } | undefined {
  return principal.roles.includes('operator') ? undefined : { owner: principal.id, tenantId: principal.tenantId };
}

async function getOwnedRun(repository: RunRepository, id: string, owner: string, tenantId: string) {
  return repository.get(id, { owner, tenantId });
}

/** Read access follows the Goal's Room membership, while mutations retain the
 * owner/operator boundary enforced by the HTTP hook and route handlers. */
async function getReadableRun(repository: RunRepository, domain: AeeisService | undefined, id: string, principal: Principal): Promise<AgentRun> {
  let owned: AgentRun | undefined;
  try { owned = await getOwnedRun(repository, id, principal.id, principal.tenantId); }
  catch (error) { if (!(error instanceof NotFound)) throw error; }
  if (owned) return owned;
  if (!domain) throw new NotFound('Unknown run');
  const candidate = await repository.get(id).catch(() => { throw new NotFound('Unknown run'); });
  if (!candidate.goalId) throw new NotFound('Unknown run');
  await domain.getGoal(candidate.goalId, principal.id, principal.tenantId);
  if (classificationRank(candidate.privacy) > classificationRank('internal')) throw new NotFound('Unknown run');
  return candidate;
}

type ReadableRunCursor = { updatedAt: string; id: string };
function encodeReadableRunCursor(value: ReadableRunCursor): string { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }
function decodeReadableRunCursor(value: string | undefined): ReadableRunCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ReadableRunCursor>;
    if (typeof parsed.updatedAt !== 'string' || !Number.isFinite(Date.parse(parsed.updatedAt)) || typeof parsed.id !== 'string' || !/^run_[a-f0-9-]{36}$/.test(parsed.id)) throw new Error();
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch { throw new RangeError('Invalid run page cursor'); }
}
function readableRunAfter(run: AgentRun, cursor: ReadableRunCursor | undefined): boolean {
  if (!cursor) return true;
  const time = Date.parse(run.updatedAt), after = Date.parse(cursor.updatedAt);
  return time < after || (time === after && run.id > cursor.id);
}
function readableRunSort(left: AgentRun, right: AgentRun): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
function runSummary(run: AgentRun): Pick<AgentRun, 'id' | 'goal' | 'goalId' | 'domainPlanId' | 'taskExecution' | 'followUpPlanId' | 'status' | 'updatedAt'> {
  return { id: run.id, goal: run.goal, ...(run.goalId ? { goalId: run.goalId } : {}), ...(run.domainPlanId ? { domainPlanId: run.domainPlanId } : {}), ...(run.taskExecution ? { taskExecution: run.taskExecution } : {}), ...(run.followUpPlanId ? { followUpPlanId: run.followUpPlanId } : {}), status: run.status, updatedAt: run.updatedAt };
}
async function readableRunCandidates(repository: RunRepository, domain: AeeisService | undefined, principal: Principal): Promise<AgentRun[]> {
  const all = principal.roles.includes('operator')
    ? await repository.list(undefined)
    : await (repository.listByTenant ? repository.listByTenant(principal.tenantId) : repository.list(undefined));
  if (principal.roles.includes('operator')) return all;
  const readableGoals = domain ? await domain.readableGoalIds(principal.id, principal.tenantId) : new Set<string>();
  return all.filter(run => {
    if ((run.tenantId ?? 'local') !== principal.tenantId) return false;
    if ((run.owner ?? 'owner') === principal.id) return true;
    return Boolean(run.goalId && readableGoals.has(run.goalId) && classificationRank(run.privacy) <= classificationRank('internal'));
  });
}
async function listReadableRuns(repository: RunRepository, domain: AeeisService | undefined, principal: Principal, limit?: number): Promise<AgentRun[]> {
  const owned = await repository.list({ owner: principal.id, tenantId: principal.tenantId }, limit);
  if (!domain || !(await domain.hasSharedReadableGoals(principal.id, principal.tenantId))) return owned;
  // Keep the legacy unbounded endpoint semantics when no limit was supplied.
  // The storage-side page is intentionally used only for bounded collection
  // reads; callers that need a complete list still take the compatibility
  // path below.
  if (repository.pageVisible && limit !== undefined) {
    const readableGoals = await domain.readableGoalIds(principal.id, principal.tenantId);
    return (await repository.pageVisible({ owner: principal.id, tenantId: principal.tenantId }, [...readableGoals], limit)).runs;
  }
  const runs = (await readableRunCandidates(repository, domain, principal)).sort(readableRunSort);
  return limit === undefined ? runs : runs.slice(0, limit);
}
async function pageReadableRuns(repository: RunRepository, domain: AeeisService | undefined, principal: Principal, limit: number, cursor?: string): Promise<{ runs: AgentRun[]; nextCursor?: string }> {
  if (repository.pageVisible && domain) {
    const readableGoals = await domain.readableGoalIds(principal.id, principal.tenantId);
    const result = await repository.pageVisible({ owner: principal.id, tenantId: principal.tenantId }, [...readableGoals], limit, cursor);
    return result;
  }
  const pageCursor = decodeReadableRunCursor(cursor);
  const runs = (await readableRunCandidates(repository, domain, principal)).filter(run => readableRunAfter(run, pageCursor)).sort(readableRunSort);
  const visible = runs.slice(0, limit + 1);
  const hasMore = visible.length > limit;
  const items = hasMore ? visible.slice(0, limit) : visible;
  return { runs: items, ...(hasMore && items.length ? { nextCursor: encodeReadableRunCursor({ updatedAt: items.at(-1)!.updatedAt, id: items.at(-1)!.id }) } : {}) };
}

function countValues(values: string[], metric: string): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([value, count]) => `${metric}{status="${escapeMetricLabel(value)}"} ${count}`);
}
function countObject(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function escapeMetricLabel(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n'); }
function classificationRank(value: 'public' | 'internal' | 'confidential' | 'private'): number {
  return { public: 0, internal: 1, confidential: 2, private: 3 }[value];
}
