import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AgentEngine, Conflict, event } from './engine.js';
import { NotFound, type RunRepository } from './repository.js';
import type { Dispatcher } from './dispatcher.js';
import { brainClaimInputSchema, brainClassificationSchema, brainGrantInputSchema, type GovernedBrain } from '../brain.js';
import type { FileBrainStore } from '../brain.js';
import type { RsiService } from '../rsi.js';
import { CollaborationNotFound, type CollaborationService } from '../collaboration-service.js';
import type { CandidateRunner, IndependentEvaluator } from '../collaboration.js';
import type { DebateRecord } from '../collaboration-service.js';
import { projectRunGraphs } from './graphs.js';
import { AeeisConflict, AeeisNotFound, AeeisService } from '../application/aeeis-service.js';
import type { RsiEvaluationHarness } from '../evaluation.js';
import type { FileProjectionOutbox, ProjectionSink } from '../collaboration-projection.js';
import type { SkillGovernance } from '../integrations.js';

interface Options { repository: RunRepository; engine?: AgentEngine; dispatcher?: Dispatcher; token?: string; workerToken?: string; brain?: GovernedBrain; brainStore?: FileBrainStore; rsi?: RsiService; rsiHarness?: RsiEvaluationHarness; skills?: SkillGovernance; collaboration?: CollaborationService; projection?: FileProjectionOutbox; projectionSink?: ProjectionSink; domain?: AeeisService; competitionRunner?: CandidateRunner; competitionEvaluator?: IndependentEvaluator; competitionEvaluatorAgentId?: string; debateRunner?: { run(id: string): Promise<DebateRecord> } }
function matches(expected: string | undefined, received: string | undefined): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(`Bearer ${expected}`), b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function buildApp(options: Options) {
  const app = Fastify({ bodyLimit: 700000, logger: false });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const host = request.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return reply.code(403).send({ error: 'Untrusted host' });
    if (request.headers.origin && request.headers.origin !== `http://${host}`) return reply.code(403).send({ error: 'Cross-origin access denied' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'Cross-site access denied' });
    if (request.url.startsWith('/internal/')) {
      if (!matches(options.workerToken, request.headers.authorization)) return reply.code(401).send({ error: 'Worker authentication required' });
    } else if (request.url.startsWith('/api/') && options.token && !matches(options.token, request.headers.authorization)) {
      return reply.code(401).send({ error: 'Local access token required' });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request', issues: error.issues.map(i => ({ path: i.path, message: i.message })) });
    if (error instanceof NotFound) return reply.code(404).send({ error: error.message });
    if (error instanceof AeeisNotFound) return reply.code(404).send({ error: error.message });
    if (error instanceof AeeisConflict) return reply.code(409).send({ error: error.message });
    if (error instanceof CollaborationNotFound) return reply.code(404).send({ error: error.message });
    if (error instanceof Conflict) return reply.code(409).send({ error: error.message });
    const e = error as { statusCode?: number };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'Invalid HTTP request' });
    console.error('Request failed', error instanceof Error ? error.name : 'Error');
    return reply.code(500).send({ error: 'Internal operation failed; inspect the server log' });
  });
  app.get('/health', async () => ({ status: 'ok', service: 'aeeis-agent', protocol: 'aeeis-health/1' }));
  app.get('/readyz', async (_request, reply) => {
    const checks: Array<{ name: string; ready: boolean; required: boolean; detail: string }> = [];
    const check = async (name: string, required: boolean, operation: () => Promise<void>, detail: string): Promise<void> => {
      try { await operation(); checks.push({ name, ready: true, required, detail }); }
      catch { checks.push({ name, ready: false, required, detail: 'dependency check failed' }); }
    };
    await check('repository', true, async () => { await options.repository.list(); }, 'run repository reachable');
    checks.push({ name: 'model', ready: Boolean(options.engine?.modelConfigured), required: true, detail: options.engine?.modelConfigured ? 'model configured' : 'model configuration required' });
    checks.push({ name: 'dispatcher', ready: Boolean(options.engine && options.dispatcher), required: true, detail: options.dispatcher?.constructor.name ?? 'dispatcher unavailable' });
    checks.push({ name: 'domain', ready: Boolean(options.domain), required: true, detail: options.domain ? 'Goal/Plan domain configured' : 'domain unavailable' });
    checks.push({ name: 'brain', ready: Boolean(options.brain), required: false, detail: options.brain ? 'Brain configured' : 'Brain unavailable' });
    checks.push({ name: 'evolution', ready: Boolean(options.rsi), required: false, detail: options.rsi ? 'RSI repository configured' : 'RSI unavailable' });
    checks.push({ name: 'collaboration', ready: Boolean(options.collaboration), required: false, detail: options.collaboration ? 'collaboration repository configured' : 'collaboration unavailable' });
    const ready = checks.every(checkResult => !checkResult.required || checkResult.ready);
    return reply.code(ready ? 200 : 503).send({ protocol: 'aeeis-readiness/1', status: ready ? 'ready' : 'not_ready', checks });
  });
  app.get('/metrics', async (_request, reply) => {
    const runs = await options.repository.list();
    const lines = [
      '# HELP aeeis_runs_total Number of durable runs by status.',
      '# TYPE aeeis_runs_total gauge',
      ...countValues(runs.map(run => run.status), 'aeeis_runs_total'),
      `aeeis_model_configured ${options.engine?.modelConfigured ? 1 : 0}`,
      `aeeis_dispatcher_configured ${options.dispatcher ? 1 : 0}`,
      `aeeis_domain_configured ${options.domain ? 1 : 0}`,
      `aeeis_rsi_configured ${options.rsi ? 1 : 0}`,
      `aeeis_collaboration_configured ${options.collaboration ? 1 : 0}`,
      `aeeis_projection_sink_configured ${options.projectionSink ? 1 : 0}`,
    ];
    if (options.rsi) {
      const candidates = await options.rsi.list();
      lines.push('# HELP aeeis_evolution_candidates_total Evolution candidates by status.', '# TYPE aeeis_evolution_candidates_total gauge', ...countValues(candidates.map(candidate => candidate.status), 'aeeis_evolution_candidates_total'));
    }
    if (options.projection) {
      const projections = await options.projection.list();
      lines.push('# HELP aeeis_projection_events_total Projection outbox events by status.', '# TYPE aeeis_projection_events_total gauge', ...countValues(projections.map(event => event.status), 'aeeis_projection_events_total'));
    }
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(lines.join('\n') + '\n');
  });
  const assets: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'],
  };
  for (const [route, [file, type]] of Object.entries(assets)) {
    app.get(route, async (_request, reply) => reply.type(type).send(await readFile(file === 'app.js' ? new URL('../../dist/ui/app.js', import.meta.url) : new URL(`../../public/${file}`, import.meta.url), 'utf8')));
  }
  app.get('/api/status', async () => ({ modelConfigured: options.engine?.modelConfigured ?? false, model: options.engine?.modelPin ?? null, modelRouting: options.engine?.modelPin ? 'pinned' : options.engine ? 'catalog' : 'unconfigured', agentGatewayConfigured: options.engine?.agentGatewayConfigured ?? false, runner: options.dispatcher?.constructor.name ?? 'unconfigured', knowledgeConfigured: options.engine?.knowledgeConfigured ?? false, evolutionConfigured: Boolean(options.rsi), rsiEvaluatorConfigured: Boolean(options.rsiHarness), skillGovernanceConfigured: Boolean(options.skills), collaborationConfigured: Boolean(options.collaboration), projectionConfigured: Boolean(options.projection), projectionSinkConfigured: Boolean(options.projectionSink), domainConfigured: Boolean(options.domain), mode: 'single-owner-local' }));
  app.get('/api/goals', async () => options.domain ? options.domain.listGoals() : []);
  app.post('/api/goals', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ title: z.string().trim().min(1).max(500), description: z.string().max(8000).optional() }).strict().parse(request.body);
    return options.domain.createGoal({ title: body.title, ...(body.description === undefined ? {} : { description: body.description }) });
  });
  app.get<{ Params: { id: string } }>('/api/goals/:id', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    return options.domain.getGoal(request.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/goals/:id/plans', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    return options.domain.listPlans(request.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id/plans', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ nodes: z.array(z.object({ id: z.string().min(1).max(128), title: z.string().trim().min(1).max(500), kind: z.enum(['task', 'review', 'approval', 'deliverable']).optional(), dependsOn: z.array(z.string().min(1).max(128)).optional() }).strict()).min(1).max(100) }).strict().parse(request.body);
    return options.domain.createPlan({ goalId: request.params.id, nodes: body.nodes.map(node => ({ id: node.id, title: node.title, ...(node.kind === undefined ? {} : { kind: node.kind }), ...(node.dependsOn === undefined ? {} : { dependsOn: node.dependsOn }) })) });
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id/plans/revise', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ nodes: z.array(z.object({ id: z.string().min(1).max(128), title: z.string().trim().min(1).max(500), kind: z.enum(['task', 'review', 'approval', 'deliverable']).optional(), dependsOn: z.array(z.string().min(1).max(128)).optional() }).strict()).min(1).max(100) }).strict().parse(request.body);
    return options.domain.createPlanRevision({ goalId: request.params.id, nodes: body.nodes.map(node => ({ id: node.id, title: node.title, ...(node.kind === undefined ? {} : { kind: node.kind }), ...(node.dependsOn === undefined ? {} : { dependsOn: node.dependsOn }) })) });
  });
  app.get<{ Params: { id: string } }>('/api/goals/:id/memories', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    return options.domain.listMemories(request.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id/memories', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ kind: z.enum(['fact', 'decision', 'preference', 'note']), scope: z.enum(['private', 'project', 'session']).optional(), content: z.string().trim().min(1).max(30000), source: z.string().trim().max(1000).optional(), confidence: z.number().min(0).max(1).optional() }).strict().parse(request.body);
    return options.domain.addMemory(request.params.id, { kind: body.kind, content: body.content, ...(body.scope === undefined ? {} : { scope: body.scope }), ...(body.source === undefined ? {} : { source: body.source }), ...(body.confidence === undefined ? {} : { confidence: body.confidence }) });
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id/context-manifests', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ purpose: z.string().trim().min(1).max(500), query: z.string().max(2000).optional(), audience: z.array(z.string().min(1).max(128)).max(20).optional(), maxItems: z.number().int().min(1).max(50).optional(), knowledgeClassifications: z.array(z.enum(['public', 'internal', 'confidential', 'private'])).max(4).optional() }).strict().parse(request.body);
    return options.domain.createContextManifest(request.params.id, { purpose: body.purpose, ...(body.query === undefined ? {} : { query: body.query }), ...(body.audience === undefined ? {} : { audience: body.audience }), ...(body.maxItems === undefined ? {} : { maxItems: body.maxItems }), ...(body.knowledgeClassifications === undefined ? {} : { knowledgeClassifications: body.knowledgeClassifications }) });
  });
  app.get<{ Params: { id: string } }>('/api/plans/:id/snapshot', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    return options.domain.getSnapshot(request.params.id);
  });
  app.post<{ Params: { planId: string; taskId: string } }>('/api/plans/:planId/tasks/:taskId/transition', async request => {
    if (!options.domain) throw new Error('Goal service is not configured');
    const body = z.object({ transition: z.enum(['start', 'wait', 'request_approval', 'block', 'succeed', 'fail', 'cancel', 'mark_unknown', 'retry']), reason: z.string().max(4000).optional() }).strict().parse(request.body);
    return options.domain.transitionTask({ planId: request.params.planId, taskId: request.params.taskId, transition: body.transition, ...(body.reason === undefined ? {} : { reason: body.reason }) });
  });
  app.get('/api/evolution/candidates', async () => {
    if (!options.rsi) return [];
    return options.rsi.list();
  });
  app.get<{ Params: { id: string } }>('/api/evolution/candidates/:id', async request => {
    if (!options.rsi) throw new Error('RSI service is not configured');
    return options.rsi.get(request.params.id);
  });
  app.post('/api/evolution/candidates', async request => {
    if (!options.rsi) throw new Error('RSI service is not configured');
    return options.rsi.propose(request.body);
  });
  app.post<{ Params: { id: string; action: string } }>('/api/evolution/candidates/:id/:action', async request => {
    if (!options.rsi) throw new Error('RSI service is not configured');
    const { id, action } = request.params;
    if (action === 'evaluate') return options.rsi.evaluate(id, request.body);
    if (action === 'evaluate-suite') {
      if (!options.rsiHarness) throw new Conflict('RSI evaluator is not configured');
      return options.rsi.evaluateSuite(id, request.body, options.rsiHarness);
    }
    if (action === 'approve') return options.rsi.approve(id, z.object({ approvalRef: z.string().min(1).max(200) }).strict().parse(request.body).approvalRef);
    if (action === 'start-shadow') return options.rsi.startShadow(id);
    if (action === 'run-shadow') {
      if (!options.rsiHarness) throw new Conflict('RSI evaluator is not configured');
      return options.rsi.runRollout(id, 'shadow', request.body, options.rsiHarness);
    }
    if (action === 'reconcile-rollout') return options.rsi.reconcileRollout(id, request.body);
    if (action === 'record-shadow') return options.rsi.recordShadow(id, request.body);
    if (action === 'start-canary') return options.rsi.startCanary(id);
    if (action === 'run-canary') {
      if (!options.rsiHarness) throw new Conflict('RSI evaluator is not configured');
      return options.rsi.runRollout(id, 'canary', request.body, options.rsiHarness);
    }
    if (action === 'record-canary') return options.rsi.recordCanary(id, request.body);
    if (action === 'promote') return options.rsi.promote(id);
    if (action === 'rollback') return options.rsi.rollback(id, z.object({ reason: z.string().min(1).max(4000) }).strict().parse(request.body).reason);
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
  app.get('/api/collaborations/competitions', async () => options.collaboration ? options.collaboration.listCompetitions() : []);
  app.get<{ Params: { id: string } }>('/api/collaborations/competitions/:id', async request => {
    if (!options.collaboration) throw new Error('Collaboration service is not configured');
    return options.collaboration.getCompetition(request.params.id);
  });
  app.post('/api/collaborations/competitions', async request => {
    if (!options.collaboration) throw new Error('Collaboration service is not configured');
    return options.collaboration.createCompetition(request.body);
  });
  app.post<{ Params: { id: string; action: string } }>('/api/collaborations/competitions/:id/:action', async request => {
    if (!options.collaboration) throw new Error('Collaboration service is not configured');
    const { id, action } = request.params;
    if (action === 'candidate') return options.collaboration.submitCandidate(id, request.body);
    if (action === 'begin-evaluation') {
      const evaluatorAgentId = z.object({ evaluatorAgentId: z.string().min(1).max(128) }).strict().parse(request.body).evaluatorAgentId;
      await options.collaboration.beginEvaluation(id, evaluatorAgentId);
      return options.collaboration.getEvaluationView(id);
    }
    if (action === 'score') {
      const body = z.object({ evaluatorAgentId: z.string().min(1).max(128), score: z.unknown() }).strict().parse(request.body);
      await options.collaboration.submitScore(id, body.evaluatorAgentId, body.score);
      return options.collaboration.getEvaluationView(id);
    }
    if (action === 'run') {
      if (!options.competitionRunner || !options.competitionEvaluator || !options.competitionEvaluatorAgentId) throw new Conflict('Internal competition model pool is not configured');
      return options.collaboration.runCompetition(id, options.competitionEvaluatorAgentId, options.competitionRunner, options.competitionEvaluator);
    }
    if (action === 'reconcile-attempt') return options.collaboration.reconcileCompetitionAttempt(id, request.body);
    if (action === 'reconcile-evaluator') return options.collaboration.reconcileCompetitionEvaluator(id, request.body);
    throw new Conflict('Unsupported competition action');
  });
  app.get('/api/collaborations/debates', async () => options.collaboration ? options.collaboration.listDebates() : []);
  app.get<{ Params: { id: string } }>('/api/collaborations/debates/:id', async request => {
    if (!options.collaboration) throw new Error('Collaboration service is not configured');
    return options.collaboration.getDebate(request.params.id);
  });
  app.post('/api/collaborations/debates', async request => {
    if (!options.collaboration) throw new Error('Collaboration service is not configured');
    return options.collaboration.createDebate(request.body);
  });
  app.post<{ Params: { id: string; action: string } }>('/api/collaborations/debates/:id/:action', async request => {
    if (!options.collaboration) throw new Error('Collaboration service is not configured');
    const { id, action } = request.params;
    if (action === 'message') return options.collaboration.appendMessage(id, request.body);
    if (action === 'close') return options.collaboration.closeDebate(id, z.object({ reason: z.string().min(1).max(4000) }).strict().parse(request.body).reason);
    if (action === 'run') {
      if (!options.debateRunner) throw new Conflict('Internal debate model pool is not configured');
      return options.debateRunner.run(id);
    }
    throw new Conflict('Unsupported debate action');
  });
  app.get<{ Querystring: { status?: string } }>('/api/collaborations/projections', async request => {
    if (!options.projection) return [];
    const status = request.query.status === undefined ? undefined : z.enum(['pending', 'failed', 'unknown', 'delivered']).parse(request.query.status);
    return options.projection.list(status);
  });
  app.post('/api/collaborations/projections', async request => {
    if (!options.collaboration || !options.projection) throw new Conflict('Collaboration projection is not configured');
    const body = z.object({ channel: z.string().trim().min(1).max(100), destination: z.string().trim().min(1).max(500), aggregateType: z.enum(['debate', 'competition']), aggregateId: z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/), idempotencyKey: z.string().trim().min(1).max(500).optional() }).strict().parse(request.body);
    const record = body.aggregateType === 'debate' ? await options.collaboration.getDebate(body.aggregateId) : await options.collaboration.getCompetition(body.aggregateId);
    return options.projection.enqueue({ ...body, payload: record, idempotencyKey: body.idempotencyKey ?? `${body.channel}:${body.aggregateType}:${body.aggregateId}:${record.updatedAt}` });
  });
  app.post<{ Params: { id: string } }>('/api/collaborations/projections/:id/deliver', async request => {
    if (!options.projection || !options.projectionSink) throw new Conflict('Projection sink is not configured');
    return options.projection.deliver(request.params.id, options.projectionSink);
  });
  app.post<{ Params: { id: string } }>('/api/collaborations/projections/:id/reconcile', async request => {
    if (!options.projection) throw new Conflict('Collaboration projection is not configured');
    const body = z.object({ outcome: z.enum(['completed', 'failed']), reason: z.string().trim().min(1).max(2000), externalId: z.string().trim().min(1).max(500).optional() }).strict().parse(request.body);
    return options.projection.reconcile(request.params.id, body.outcome, body.reason, body.externalId);
  });
  app.post('/api/collaborations/projections/deliver-pending', async request => {
    if (!options.projection || !options.projectionSink) throw new Conflict('Projection sink is not configured');
    const body = z.object({ limit: z.number().int().min(1).max(100).optional() }).strict().parse(request.body ?? {});
    return options.projection.deliverPending(options.projectionSink, body.limit ?? 20);
  });
  app.get<{ Params: { scope: string }; Querystring: { classification?: 'public' | 'internal' | 'confidential' | 'private' } }>('/api/brain/:scope', async request => {
    if (!options.brain) return { error: 'Brain is not configured' };
    const query = z.object({ classification: brainClassificationSchema.optional() }).strict().parse(request.query);
    return { scope: request.params.scope, claims: options.brain.read(request.params.scope, 'owner', query.classification ?? 'internal') };
  });
  app.post('/api/brain/claims', async request => {
    if (!options.brain || !options.brainStore) throw new Error('Brain is not configured');
    const claim = options.brain.addClaim(brainClaimInputSchema.parse(request.body), 'owner');
    await options.brainStore.save(options.brain); return claim;
  });
  app.post('/api/brain/grants', async request => {
    if (!options.brain || !options.brainStore) throw new Error('Brain is not configured');
    const grant = options.brain.grant(brainGrantInputSchema.parse(request.body), 'owner');
    await options.brainStore.save(options.brain); return grant;
  });
  app.post<{ Params: { id: string } }>('/api/brain/grants/:id/revoke', async request => {
    if (!options.brain || !options.brainStore) throw new Error('Brain is not configured');
    options.brain.revoke(request.params.id, 'owner'); await options.brainStore.save(options.brain); return { status: 'revoked' };
  });
  app.delete<{ Params: { scope: string } }>('/api/brain/:scope', async request => {
    if (!options.brain || !options.brainStore) throw new Error('Brain is not configured');
    options.brain.deleteScope(request.params.scope, 'owner'); await options.brainStore.save(options.brain); return { status: 'deleted' };
  });
  app.get('/api/runs', async () => (await options.repository.list()).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id, goal, goalId, domainPlanId, status, updatedAt }) => ({ id, goal, ...(goalId ? { goalId } : {}), ...(domainPlanId ? { domainPlanId } : {}), status, updatedAt })));
  app.get<{ Params: { id: string } }>('/api/runs/:id', async request => options.repository.get(request.params.id));
  app.post<{ Params: { id: string } }>('/api/runs/:id/corrections', async request => {
    if (!options.rsi) throw new Error('RSI service is not configured');
    const run = await options.repository.get(request.params.id);
    const body = z.object({ target: z.enum(['profile', 'skill', 'prompt', 'workflow', 'tool-policy', 'model-policy']), baseVersion: z.string().min(1).max(200), proposedVersion: z.string().min(1).max(200), change: z.string().min(1).max(8000), reason: z.string().min(1).max(4000), risk: z.enum(['low', 'medium', 'high']), sourceReceiptRefs: z.array(z.string().min(1).max(200)).min(1).max(100) }).strict().parse(request.body);
    const evidenceRefs = new Set<string>([
      ...run.context.sources.map(source => source.id),
      ...run.artifacts.map(artifact => artifact.id),
      ...(run.toolReceipts ?? []).map(receipt => receipt.receiptId),
      ...(run.delegationOutcomes ?? []).map(outcome => outcome.receiptRef),
      ...run.calls.map(call => call.id),
    ]);
    if (body.sourceReceiptRefs.some(ref => !evidenceRefs.has(ref))) throw new Conflict('Correction references evidence that this Run did not receive');
    const correctionId = `correction_${randomUUID()}`;
    const candidate = await options.rsi.proposeFromCorrection({ ...body, correctionRef: correctionId });
    const updated = await options.repository.mutate(run.id, current => {
      current.corrections ??= [];
      current.corrections.push({ id: correctionId, text: body.reason, candidateId: candidate.id, sourceRefs: body.sourceReceiptRefs, createdAt: new Date().toISOString() });
      event(current, 'rsi.correction.recorded', { correctionId, candidateId: candidate.id, sourceReceiptRefs: body.sourceReceiptRefs });
    });
    return { correction: updated.corrections?.at(-1), candidate };
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/graphs', async request => projectRunGraphs(await options.repository.get(request.params.id)));
  async function notify(id: string): Promise<void> {
    try { await options.dispatcher?.notify(id); }
    catch {
      await options.repository.mutate(id, run => { event(run, 'dispatch.failed'); run.error = 'Execution service unavailable. Restore it and use resume dispatch.'; });
    }
  }
  app.post('/api/runs', async (request, reply) => {
    if (!options.engine || !options.dispatcher) return reply.code(503).send({ error: 'Configure a pinned model or AEEIS_PLANPRICE_URL with provider endpoints before starting an agent run' });
    const body = z.object({ goal: z.string().trim().min(1).max(8000), goalId: z.string().trim().min(1).max(200).optional(), materials: z.array(z.object({ title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(30000), source: z.string().trim().min(1).max(1000) }).strict()).max(20).optional(), maxModelCalls: z.number().int().min(3).max(100).optional(), allowedTools: z.array(z.string().trim().min(1).max(200)).max(50).optional(), allowedAgents: z.array(z.string().trim().min(1).max(200)).max(20).optional(), knowledgeQuery: z.string().trim().min(1).max(2000).optional(), knowledgeMaxItems: z.number().int().min(1).max(20).optional(), brainScope: z.string().trim().min(1).max(200).optional(), skillRuntime: z.string().trim().min(1).max(100).optional(), privacy: z.enum(['public', 'internal', 'confidential', 'private']).optional() }).strict().parse(request.body);
    const run = await options.engine.create(body);
    await notify(run.id); return reply.code(202).send({ id: run.id });
  });
  app.post<{ Params: { id: string } }>('/api/goals/:id/runs', async (request, reply) => {
    if (!options.domain || !options.engine || !options.dispatcher) return reply.code(503).send({ error: 'Configure the Goal service, model and dispatcher before starting a Goal run' });
    const goal = await options.domain.getGoal(request.params.id);
    const body = z.object({ materials: z.array(z.object({ title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(30000), source: z.string().trim().min(1).max(1000) }).strict()).max(20).optional(), maxModelCalls: z.number().int().min(3).max(100).optional(), allowedTools: z.array(z.string().trim().min(1).max(200)).max(50).optional(), allowedAgents: z.array(z.string().trim().min(1).max(200)).max(20).optional(), knowledgeQuery: z.string().trim().min(1).max(2000).optional(), knowledgeMaxItems: z.number().int().min(1).max(20).optional(), brainScope: z.string().trim().min(1).max(200).optional(), skillRuntime: z.string().trim().min(1).max(100).optional(), privacy: z.enum(['public', 'internal', 'confidential', 'private']).optional() }).strict().parse(request.body);
    const run = await options.engine.create({ goal: goal.title, goalId: goal.id, ...body });
    await notify(run.id); return reply.code(202).send({ id: run.id, goalId: goal.id });
  });
  app.post<{ Params: { id: string; action: string } }>('/api/runs/:id/:action', async (request, reply) => {
    if (!options.engine) return reply.code(503).send({ error: 'Model is not configured' });
    const { id, action } = request.params;
    await options.repository.get(id);
    if (action !== 'dispatch') await options.engine.command(id, action, request.body);
    await notify(id); return options.repository.get(id);
  });
  app.post<{ Params: { id: string } }>('/internal/runs/:id/advance', async (request, reply) => {
    if (!options.engine) return reply.code(503).send({ error: 'Model is not configured' });
    return { status: await options.engine.advance(request.params.id) };
  });
  return app;
}

function countValues(values: string[], metric: string): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([value, count]) => `${metric}{status="${escapeMetricLabel(value)}"} ${count}`);
}

function escapeMetricLabel(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n'); }
