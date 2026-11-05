import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CollaborationTriggerPump } from '../src/collaboration-trigger-pump.js';
import { CollaborationTriggerService, FileCollaborationTriggerStore, PostgresCollaborationTriggerStore, type CollaborationTriggerStore } from '../src/collaboration-triggers.js';
import { CollaborationService, FileCollaborationRepository, PostgresCollaborationRepository, type CollaborationRepository } from '../src/collaboration-service.js';
import { FileRunRepository, PostgresRunRepository, type RunRepository } from '../src/runtime/repository.js';
import { requestSchema, type AgentRun } from '../src/runtime/contracts.js';
import { buildApp } from '../src/runtime/http.js';
import { explainRun } from '../src/runtime/explanation.js';
import { childLineage, lineageOf, maxDerivationDepthFromEnv, type Lineage } from '../src/lineage.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter } from '../src/runtime/model.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const scope = { owner: 'alice', tenantId: 'team-a' };

function loopRun(index: number, lineage?: Lineage): AgentRun {
  const id = `run_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return {
    schemaVersion: 1, id, revision: 1, owner: scope.owner, tenantId: scope.tenantId, goal: `Loop hop ${index}`, status: 'succeeded',
    createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:01.000Z',
    context: { id: 'ctx_loop', audience: ['alice@team-a'], sources: [{ id: 'source_loop', title: 'Brief', content: 'Loop', source: 'fixture', hash: 'a'.repeat(64), classification: 'internal' }] },
    privacy: 'internal', model: { model: 'fixture', endpoint: 'http://127.0.0.1:4399', promptVersion: 'fixture/1' },
    maxModelCalls: 10, modelUsage: { tokens: 0, unreportedCalls: 0 }, calls: [],
    allowedTools: [], allowedAgents: ['agent.one', 'agent.two'], knowledgeMaxItems: 8,
    brainMaxItems: 20, toolReceipts: [], delegationOutcomes: [], plans: [],
    steps: [{ taskId: 'task_loop', status: 'succeeded', attempts: 1, observations: [] }],
    artifacts: [],
    events: [{ id: `evt_completed_${index}`, seq: 1, type: 'task.completed', at: '2026-11-05T00:00:01.000Z', data: { taskId: 'task_loop' } }],
    answers: [],
    ...(lineage ? { lineage } : {}),
  };
}

/**
 * task.completed → Trigger Policy → Competition (dispatch: run) → Run →
 * task.completed → … Each Competition the trigger creates is one hop; the
 * executor stands in for a runtime that derives a Run from the finished
 * Competition, which is another hop. With the default limit of 8, the
 * Competition that would be hop 9 is refused.
 */
async function runLoop(runs: RunRepository, collaborations: CollaborationRepository, triggerStore: CollaborationTriggerStore): Promise<void> {
  const collaboration = new CollaborationService(collaborations);
  let nextRun = 2;
  const triggers = new CollaborationTriggerService(triggerStore, collaboration, {
    runCompetition: async (competitionId, ownership) => {
      const competition = await collaboration.getCompetition(competitionId, ownership);
      await runs.create(loopRun(nextRun++, childLineage(lineageOf(competition))));
    },
    runDebate: async () => { throw new Error('not used'); },
  });
  expect(triggers.maxDerivationDepth).toBe(8);
  await triggers.createPolicy({
    id: 'policy.loop', name: 'Compete on every completed task', eventTypes: ['task.completed'], cooldownMs: 0,
    action: { type: 'competition', participantAgentIds: ['agent.one', 'agent.two'], evaluatorAgentId: 'agent.evaluator', expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: true, dispatch: 'run' },
  }, scope);
  const root = loopRun(1);
  await runs.create(root);

  const pump = new CollaborationTriggerPump(runs, triggers, { onError: error => { throw error; } });
  for (let pass = 0; pass < 12; pass += 1) await pump.pump();

  const competitions = await collaboration.listCompetitions(scope);
  expect(competitions.map(item => item.lineage).sort((a, b) => a!.depth - b!.depth)).toEqual([1, 3, 5, 7].map(depth => ({ rootId: root.id, depth })));
  const allRuns = (await runs.list(scope)).sort((a, b) => lineageOf(a).depth - lineageOf(b).depth);
  expect(allRuns.map(run => lineageOf(run).depth)).toEqual([0, 2, 4, 6, 8]);

  const decisions = await triggers.listDecisions(scope, 'policy.loop');
  expect(decisions).toHaveLength(5);
  const blocked = decisions.filter(decision => decision.state === 'blocked_depth');
  expect(blocked).toHaveLength(1);
  expect(blocked[0]).toMatchObject({ lineage: { rootId: root.id, depth: 9 }, dispatchState: 'not_requested' });
  expect(blocked[0]!.resourceId).toBeUndefined();
  expect(blocked[0]!.reason).toContain('over the limit of 8');
  expect(decisions.filter(decision => decision.state === 'triggered').every(decision => decision.dispatchState === 'completed')).toBe(true);

  // The Run at the end of the chain carries the notice the inbox shows.
  const last = allRuns.at(-1)!;
  expect(last.derivationBlocked).toMatchObject({ kind: 'collaboration_trigger', limit: 8, decisionId: blocked[0]!.id, policyId: 'policy.loop', lineage: { depth: 9 } });
  expect(last.events.filter(item => item.type === 'derivation.blocked')).toHaveLength(1);
  expect(explainRun(last).attention.kind).toBe('inspect_derivation');

  // Replays neither create work nor raise the notice again.
  for (let pass = 0; pass < 3; pass += 1) await pump.pump();
  expect(await collaboration.listCompetitions(scope)).toHaveLength(4);
  expect(await triggers.listDecisions(scope, 'policy.loop')).toHaveLength(5);
  expect((await runs.get(last.id)).events.filter(item => item.type === 'derivation.blocked')).toHaveLength(1);
  // A blocked decision is terminal.
  await expect(triggers.reconcileDecision(blocked[0]!.id, { outcome: 'resource_created', resourceId: 'competition_forged', reason: 'try to revive' }, scope)).rejects.toThrow(/terminal/);
}

describe('derivation depth limit', () => {
  it('stops a task.completed → competition loop at hop 9 on the File stores', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-derivation-depth-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const collaborations = new FileCollaborationRepository(join(directory, 'collaboration')); await collaborations.init();
    const triggerStore = new FileCollaborationTriggerStore(join(directory, 'triggers')); await triggerStore.init();
    try { await runLoop(runs, collaborations, triggerStore); }
    finally { await triggerStore.close(); await collaborations.close(); await runs.close(); }
  });

  it.skipIf(!databaseUrl)('stops a task.completed → competition loop at hop 9 on the PostgreSQL stores', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const runs = new PostgresRunRepository(db.url);
    const collaborations = new PostgresCollaborationRepository(db.url);
    const triggerStore = new PostgresCollaborationTriggerStore(db.url);
    try {
      await Promise.all([runs.init(), collaborations.init(), triggerStore.init()]);
      await runLoop(runs, collaborations, triggerStore);
    } finally {
      await Promise.allSettled([runs.close(), collaborations.close(), triggerStore.close()]);
      await db.close();
    }
  });

  it('takes the limit from deployment config, never from the event', async () => {
    expect(maxDerivationDepthFromEnv({})).toBe(8);
    expect(maxDerivationDepthFromEnv({ AEEIS_MAX_DERIVATION_DEPTH: '3' })).toBe(3);
    expect(() => maxDerivationDepthFromEnv({ AEEIS_MAX_DERIVATION_DEPTH: '0' })).toThrow(RangeError);
    expect(() => maxDerivationDepthFromEnv({ AEEIS_MAX_DERIVATION_DEPTH: 'many' })).toThrow(RangeError);
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-derivation-limit-'));
    const collaborations = new FileCollaborationRepository(join(directory, 'collaboration')); await collaborations.init();
    const triggerStore = new FileCollaborationTriggerStore(join(directory, 'triggers')); await triggerStore.init();
    try {
      const triggers = new CollaborationTriggerService(triggerStore, new CollaborationService(collaborations), undefined, { maxDerivationDepth: 2 });
      await triggers.createPolicy({ id: 'policy.limit', name: 'Limit', eventTypes: ['task.completed'], action: { type: 'debate', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1 } }, scope);
      const event = { schemaVersion: 'collaboration-trigger-event/1', source: 'system', ...scope, eventType: 'task.completed', taskId: 'task_loop', contextVersion: 'ctx_loop', occurredAt: new Date().toISOString() };
      const [second] = await triggers.evaluateDerived({ ...event, eventId: 'run:a:1', lineage: { rootId: 'run_root', depth: 1 } }, scope);
      expect(second).toMatchObject({ created: true, decision: { state: 'triggered', lineage: { rootId: 'run_root', depth: 2 } } });
      expect((await new CollaborationService(collaborations).listDebates(scope))[0]!.lineage).toEqual({ rootId: 'run_root', depth: 2 });
      const [third] = await triggers.evaluateDerived({ ...event, eventId: 'run:a:2', lineage: { rootId: 'run_root', depth: 2 } }, scope);
      expect(third).toMatchObject({ created: true, decision: { state: 'blocked_depth', lineage: { depth: 3 } } });
      expect(await new CollaborationService(collaborations).listDebates(scope)).toHaveLength(1);
    } finally { await triggerStore.close(); await collaborations.close(); }
  });
});

describe('lineage is read-only to callers', () => {
  it('rejects lineage from HTTP callers, worker bridges, channel messages and request bodies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-lineage-http-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const collaborations = new FileCollaborationRepository(join(directory, 'collaboration')); await collaborations.init();
    const triggerStore = new FileCollaborationTriggerStore(join(directory, 'triggers')); await triggerStore.init();
    const collaboration = new CollaborationService(collaborations);
    const triggers = new CollaborationTriggerService(triggerStore, collaboration);
    const domain = new AeeisService(new InMemoryStore());
    const app = buildApp({ repository: runs, domain, collaboration, collaborationTriggers: triggers, workerToken: 'worker-secret', trustedHosts: ['aeeis'], principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] } } });
    const headers = { authorization: 'Bearer alice' };
    const reset = { rootId: 'run_forged', depth: 0 };
    try {
      await triggers.createPolicy({ id: 'policy.http', name: 'Debate', eventTypes: ['task.completed'], action: { type: 'debate', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1 } }, scope);
      const event = { eventId: 'run:http:1', eventType: 'task.completed', source: 'system', taskId: 'task_http', contextVersion: 'ctx_http', occurredAt: new Date().toISOString() };

      const user = await app.inject({ method: 'POST', url: '/api/collaborations/triggers/evaluate', headers, payload: { ...event, lineage: reset } });
      expect(user.statusCode).toBe(400);
      const worker = await app.inject({ method: 'POST', url: '/internal/collaborations/triggers/evaluate', headers: { host: 'aeeis:4323', authorization: 'Bearer worker-secret' }, payload: { ...event, schemaVersion: 'collaboration-trigger-event/1', ...scope, lineage: reset } });
      expect(worker.statusCode).toBe(400);
      expect(worker.json().error).toContain('lineage');
      await expect(triggers.evaluate({ ...event, schemaVersion: 'collaboration-trigger-event/1', ...scope, lineage: reset }, scope)).rejects.toThrow(RangeError);
      await expect(triggers.evaluateExternalMessage({ ...event, schemaVersion: 'collaboration-trigger-event/1', ...scope, eventType: 'external.message', source: 'feishu', lineage: reset,
        externalInput: { channel: 'feishu', messageId: 'msg_1', senderAgentId: 'agent.one', text: 'hi', receivedAt: new Date().toISOString() } }, scope)).rejects.toThrow(/new roots/);
      expect(await triggers.listDecisions(scope)).toHaveLength(0);

      // An HTTP event is a root: what it derives sits at depth 1.
      const accepted = await app.inject({ method: 'POST', url: '/api/collaborations/triggers/evaluate', headers, payload: event });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()[0].decision.lineage).toEqual({ rootId: 'event:run:http:1', depth: 1 });

      const competition = await app.inject({ method: 'POST', url: '/api/collaborations/competitions', headers, payload: { schemaVersion: 'competition-brief/1', taskId: 'task_http', contextVersion: 'ctx_http', goal: 'Compare', participantAgentIds: ['agent.one', 'agent.two'], expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: true, lineage: reset } });
      expect(competition.statusCode).toBe(400);
      const debate = await app.inject({ method: 'POST', url: '/api/collaborations/debates', headers, payload: { taskId: 'task_http', contextVersion: 'ctx_http', participantAgentIds: ['agent.one'], lineage: reset } });
      expect(debate.statusCode).toBe(400);

      const goal = await domain.createGoal({ title: 'Long-term goal' }, undefined, 'alice', 'team-a');
      const plan = await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/plans/revise`, headers, payload: { nodes: [{ id: 'task_a', title: 'A' }], lineage: reset } });
      expect(plan.statusCode).toBe(400);
      // A person scheduling from the goal page starts a new root.
      const manual = await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/plans/revise`, headers, payload: { nodes: [{ id: 'task_a', title: 'A' }] } });
      expect(manual.statusCode).toBe(200);
      expect(manual.json().lineage).toBeUndefined();

      expect(requestSchema.safeParse({ goal: 'Do it', lineage: reset }).success).toBe(false);
    } finally { await app.close(); await triggerStore.close(); await collaborations.close(); await runs.close(); }
  });

  it('lets the owner acknowledge a stopped chain without resuming it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-lineage-ack-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const app = buildApp({ repository: runs, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] } } });
    try {
      const run = loopRun(1, { rootId: 'run_root', depth: 8 });
      await runs.create({ ...run, derivationBlocked: { kind: 'collaboration_trigger', lineage: { rootId: 'run_root', depth: 9 }, limit: 8, reason: 'over the limit', at: '2026-11-05T00:00:02.000Z' } });
      const listed = await app.inject({ method: 'GET', url: '/api/runs', headers: { authorization: 'Bearer alice' } });
      expect(listed.json()[0]).toMatchObject({ lineage: { depth: 8 }, derivationBlocked: { limit: 8 } });
      expect((await app.inject({ method: 'POST', url: `/api/runs/${run.id}/derivation-block/acknowledge`, headers: { authorization: 'Bearer bob' }, payload: {} })).statusCode).toBe(404);
      const acknowledged = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/derivation-block/acknowledge`, headers: { authorization: 'Bearer alice' }, payload: {} });
      expect(acknowledged.statusCode).toBe(200);
      expect(acknowledged.json().derivationBlocked.acknowledgedAt).toEqual(expect.any(String));
      const stored = await runs.get(run.id);
      expect(stored.lineage).toEqual({ rootId: 'run_root', depth: 8 });
      expect(explainRun(stored).attention.kind).toBe('none');
    } finally { await app.close(); await runs.close(); }
  });
});

describe('Project Pulse successor Plans', () => {
  it.each([[2, 'projects'], [3, 'blocks']] as const)('a Pulse Run at depth %i %s its successor Plan under a limit of 3', async (depth, outcome) => {
    const domain = new AeeisService(new InMemoryStore());
    const goal = await domain.createGoal({ title: 'Release readiness' }, undefined, 'alice', 'team-a');
    const content = 'The release is blocked by the migration.';
    const model: ModelAdapter = {
      pin: { model: 'pulse-depth-fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test/1' },
      complete: async request => {
        if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Pulse', nodes: [{ id: 'pulse', title: 'Project Pulse', instruction: 'Summarize', dependsOn: [] }] } };
        if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Accepted', issues: [] } };
        const input = request.input as { sourceCatalog: Array<{ id: string }>; observations: unknown[] };
        if (input.observations.length === 0) return { value: { type: 'tool', tool: 'sources.read', argument: input.sourceCatalog[0]!.id } };
        const ref = input.sourceCatalog[0]!.id;
        return { value: {
          type: 'finish', title: 'Project Pulse', content: 'Rehearse the migration.', evidenceRefs: [ref], artifactType: 'project-pulse/1',
          structured: { schemaVersion: 'project-pulse/1', progress: [], completedChanges: [], blockers: [{ text: content, evidenceRefs: [ref] }], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [{ text: 'Rehearse the migration.', evidenceRefs: [ref] }], unknowns: [] },
        } };
      },
    };
    const repository = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-pulse-depth-'))); await repository.init();
    const engine = new AgentEngine(repository, { model, domain, maxDerivationDepth: 3 });
    try {
      const input = { goal: goal.title, goalId: goal.id, builtinSkill: 'project-pulse/1', materials: [{ title: 'Release blocker', content, source: 'user-input' }] };
      await expect(engine.create({ ...input, lineage: { rootId: 'run_forged', depth: 0 } }, 'alice', 'team-a')).rejects.toThrow();
      const run = await engine.create(input, 'alice', 'team-a', undefined, undefined, undefined, { lineage: { rootId: 'run_root', depth } });
      expect(run.lineage).toEqual({ rootId: 'run_root', depth });
      expect(await engine.advance(run.id)).toBe('needs_approval');
      const proposed = await repository.get(run.id);
      await engine.command(run.id, 'approve', { planHash: proposed.plans[0]!.hash, planVersion: proposed.plans[0]!.version });
      let status = await engine.advance(run.id);
      for (let step = 0; step < 6 && status !== 'succeeded'; step += 1) status = await engine.advance(run.id);
      expect(status).toBe('succeeded');
      const completed = await repository.get(run.id);
      const plans = await domain.listPlans(goal.id, 'alice', 'team-a');
      if (outcome === 'projects') {
        const followUp = plans.find(plan => plan.id === completed.followUpPlanId)!;
        expect(followUp.lineage).toEqual({ rootId: 'run_root', depth: 3 });
        expect(completed.derivationBlocked).toBeUndefined();
      } else {
        expect(completed.followUpPlanId).toBeUndefined();
        expect(plans.every(plan => plan.lineage === undefined)).toBe(true);
        expect(completed.derivationBlocked).toMatchObject({ kind: 'project_pulse', limit: 3, lineage: { rootId: 'run_root', depth: 4 } });
        expect(explainRun(completed).attention.kind).toBe('inspect_derivation');
      }
    } finally { await repository.close(); }
  });
});
