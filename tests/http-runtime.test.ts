import { CollaborationTriggerService, FileCollaborationTriggerStore } from '../src/collaboration-triggers.js';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { FileBrainStore } from '../src/brain.js';
import { FileEvolutionRepository, RsiService } from '../src/rsi.js';
import { FileEvolutionActivationStore } from '../src/evolution-activation.js';
import { CollaborationService, FileCollaborationRepository } from '../src/collaboration-service.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter } from '../src/runtime/model.js';
import { CatalogModelResolver } from '../src/runtime/model-router.js';
import type { ModelCatalog } from '../src/integrations.js';
import { LocalDispatcher } from '../src/runtime/dispatcher.js';
import { JsonFileStore } from '../src/adapters/json-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import type { RsiEvaluationHarness } from '../src/evaluation.js';
import type { KnowledgeProvider } from '../src/knowledge.js';
import type { ProjectSourceProvider } from '../src/project-sources.js';
import { FileProjectionOutbox, type ProjectionSink } from '../src/collaboration-projection.js';
import type { SkillGovernance, ToolGateway } from '../src/integrations.js';
import { AgentDirectory, AgentResponseRejected } from '../src/agent-gateway.js';
import { digestProtocol, type AgentCard } from '../src/protocol.js';
import { InMemoryTaskDispatchRepository, TaskScheduler } from '../src/task-scheduler.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { InMemoryGrantLedger } from '../src/agent-ledger.js';

describe('AEEIS HTTP boundary', () => {
  it('passes validated limits and caller scope down to storage before reading collections', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-bounded-runs-'))); await repo.init();
    const collaboration = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-bounded-collaboration-'))); await collaboration.init();
    const evolution = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-bounded-rsi-'))); await evolution.init();
    const triggers = new FileCollaborationTriggerStore(await mkdtemp(join(tmpdir(), 'aeeis-http-bounded-triggers-'))); await triggers.init();
    const outbox = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-http-bounded-outbox-'))); await outbox.init();
    const domain = new InMemoryStore();
    const directory = new AgentDirectory();
    const memberships = new InMemoryRoomMembershipRepository();
    const scope = { owner: 'alice', tenantId: 'team-a' };
    const app = buildApp({ repository: repo, projection: outbox, collaborationTriggers: new CollaborationTriggerService(triggers, new CollaborationService(collaboration)), agentDirectory: directory, domain: new AeeisService(domain, [], memberships), collaboration: new CollaborationService(collaboration), rsi: new RsiService(evolution), principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, ops: { id: 'ops', tenantId: 'local', roles: ['operator'] } } });
    try {
      const reads = [
        { path: '/api/runs', spy: vi.spyOn(repo, 'list') },
        { path: '/api/collaborations/triggers/policies', spy: vi.spyOn(triggers, 'listPolicies') },
        { path: '/api/evolution/candidates', spy: vi.spyOn(evolution, 'list') },
        { path: '/api/goals', spy: vi.spyOn(domain, 'getGoals') },
        { path: '/api/collaborations/competitions', spy: vi.spyOn(collaboration, 'listCompetitions') },
        { path: '/api/collaborations/debates', spy: vi.spyOn(collaboration, 'listDebates') },
      ];
      for (const { path, spy } of reads) {
        const headers = { authorization: 'Bearer alice' };
        expect((await app.inject({ url: `${path}?limit=2`, headers })).statusCode).toBe(200);
        expect(spy).toHaveBeenLastCalledWith(scope, 2);
        spy.mockClear();
        expect((await app.inject({ url: `${path}?limit=0`, headers })).statusCode).toBe(400);
        expect(spy).not.toHaveBeenCalled();
        expect((await app.inject({ url: path, headers })).statusCode).toBe(200);
        expect(spy).toHaveBeenLastCalledWith(scope, undefined);
      }
      const decisionRead = vi.spyOn(triggers, 'listDecisions');
      const projectionRead = vi.spyOn(outbox, 'list');
      const headers = { authorization: 'Bearer alice' };
      expect((await app.inject({ url: '/api/collaborations/triggers/decisions?policyId=policy.one&limit=2', headers })).statusCode).toBe(200);
      expect(decisionRead).toHaveBeenLastCalledWith(scope, 'policy.one', 2);
      expect((await app.inject({ url: '/api/collaborations/projections?status=failed&limit=2', headers })).statusCode).toBe(200);
      expect(projectionRead).toHaveBeenLastCalledWith('failed', scope, 2);
      decisionRead.mockClear(); projectionRead.mockClear();
      expect((await app.inject({ url: '/api/collaborations/triggers/decisions?limit=0', headers })).statusCode).toBe(400);
      expect((await app.inject({ url: '/api/collaborations/projections?limit=0', headers })).statusCode).toBe(400);
      expect(decisionRead).not.toHaveBeenCalled(); expect(projectionRead).not.toHaveBeenCalled();
      const roomRead = vi.spyOn(domain, 'getRooms');
      const perRoomCheck = vi.spyOn(memberships, 'get');
      expect((await app.inject({ url: '/api/rooms?limit=2', headers: { authorization: 'Bearer alice' } })).statusCode).toBe(200);
      expect(roomRead).toHaveBeenLastCalledWith(scope, 2, []);
      expect(perRoomCheck).not.toHaveBeenCalled();
      roomRead.mockClear();
      expect((await app.inject({ url: '/api/rooms?limit=0', headers: { authorization: 'Bearer alice' } })).statusCode).toBe(400);
      expect(roomRead).not.toHaveBeenCalled();
      const registryRead = vi.spyOn(directory, 'entriesSnapshot');
      expect((await app.inject({ url: '/api/agents?limit=2', headers: { authorization: 'Bearer ops' } })).statusCode).toBe(200);
      expect(registryRead).toHaveBeenLastCalledWith(2);
      registryRead.mockClear();
      expect((await app.inject({ url: '/api/agents?limit=0', headers: { authorization: 'Bearer ops' } })).statusCode).toBe(400);
      expect((await app.inject({ url: '/api/agents?limit=2', headers: { authorization: 'Bearer alice' } })).statusCode).toBe(403);
      expect(registryRead).not.toHaveBeenCalled();
    } finally { await app.close(); await repo.close(); await collaboration.close(); await evolution.close(); await triggers.close(); await outbox.close(); }
  });

  it('supports bounded recent collection reads without changing the default list behavior', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-list-limit-runs-'))); await repo.init();
    const app = buildApp({ repository: repo });
    try {
      const now = new Date().toISOString();
      for (let index = 0; index < 3; index += 1) {
        await repo.create({ id: `run_${randomUUID()}`, owner: 'owner', tenantId: 'local', goal: `run-${index}`, status: 'succeeded', revision: 1, createdAt: now, updatedAt: new Date(Date.now() + index).toISOString(), calls: [], steps: [], plans: [], events: [], artifacts: [], context: { id: `ctx-${index}`, sources: [], audience: ['owner'] }, privacy: 'internal', approval: { approved: true }, answers: [], model: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'fixture/1' }, allowedTools: [], allowedAgents: [], maxModelCalls: 1, brainMaxItems: 1, memoryMaxItems: 1, knowledgeMaxItems: 1, externalUsage: { calls: 0, tokens: 0, unreportedTokenCalls: 0, unreportedMoneyCalls: 0 }, schemaVersion: 1 });
      }
      expect((await app.inject({ method: 'GET', url: '/api/runs?limit=2' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/runs?limit=2' })).json()).toHaveLength(2);
      expect((await app.inject({ method: 'GET', url: '/api/runs?limit=0' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/runs' })).json()).toHaveLength(3);
    } finally { await app.close(); await repo.close(); }
  });

  it('exposes cursor pages for long collaboration history', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-collab-page-runs-'))); await repo.init();
    const collaboration = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-collab-page-'))); await collaboration.init();
    const service = new CollaborationService(collaboration);
    const app = buildApp({ repository: repo, collaboration: service, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] } } });
    try {
      const now = Date.now();
      for (let index = 0; index < 3; index += 1) {
        const competition = await service.createCompetition({ schemaVersion: 'competition-brief/1', taskId: `task.page.c${index}`, contextVersion: `ctx.page.c${index}`, goal: 'Page', participantAgentIds: ['agent.one', 'agent.two'], expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: false }, { owner: 'alice', tenantId: 'team-a' });
        await collaboration.mutateCompetition(competition.id, current => ({ ...current, updatedAt: new Date(now + index).toISOString() }), { owner: 'alice', tenantId: 'team-a' });
        const debate = await service.createDebate({ taskId: `task.page.d${index}`, contextVersion: `ctx.page.d${index}`, participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1 }, { owner: 'alice', tenantId: 'team-a' });
        await collaboration.mutateDebate(debate.id, current => ({ ...current, updatedAt: new Date(now + index).toISOString() }), { owner: 'alice', tenantId: 'team-a' });
      }
      const headers = { authorization: 'Bearer alice' };
      const first = await app.inject({ method: 'GET', url: '/api/collaborations/competitions/page?limit=2', headers });
      expect(first.statusCode).toBe(200); const firstBody = first.json() as { items: Array<{ id: string }>; nextCursor?: string };
      expect(firstBody.items).toHaveLength(2); expect(firstBody.nextCursor).toBeTruthy();
      const second = await app.inject({ method: 'GET', url: `/api/collaborations/competitions/page?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, headers });
      expect(second.json().items).toHaveLength(1);
      expect((await app.inject({ method: 'GET', url: '/api/collaborations/debates/page?limit=2', headers })).json().items).toHaveLength(2);
      expect((await app.inject({ method: 'GET', url: '/api/collaborations/competitions/page?limit=2&cursor=bad', headers })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/collaborations/competitions/page?limit=0', headers })).statusCode).toBe(400);
    } finally { await app.close(); await collaboration.close(); await repo.close(); }
  });

  it('exposes a stable owner-scoped cursor page for long run history', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-run-page-'))); await repo.init();
    const app = buildApp({ repository: repo });
    const now = new Date().toISOString();
    try {
      for (let index = 0; index < 5; index += 1) {
        await repo.create({ id: `run_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, owner: 'owner', tenantId: 'local', goal: `run-${index}`, status: 'succeeded', revision: 1, createdAt: now, updatedAt: new Date(Date.now() + index).toISOString(), calls: [], steps: [], plans: [], events: [], artifacts: [], context: { id: `ctx-${index}`, sources: [], audience: ['owner'] }, privacy: 'internal', approval: { approved: true }, answers: [], model: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'fixture/1' }, allowedTools: [], allowedAgents: [], maxModelCalls: 1, brainMaxItems: 1, memoryMaxItems: 1, knowledgeMaxItems: 1, externalUsage: { calls: 0, tokens: 0, unreportedTokenCalls: 0, unreportedMoneyCalls: 0 }, schemaVersion: 1 });
      }
      const eventRun = 'run_00000000-0000-4000-8000-000000000000';
      await repo.mutate(eventRun, run => {
        for (let index = 0; index < 3; index += 1) run.events.push({ id: `evt.page.${index}`, seq: run.events.length + 1, type: 'page.test', at: new Date().toISOString(), data: { index } });
      });
      const eventFirst = await app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events?limit=2` });
      expect(eventFirst.statusCode).toBe(200);
      const eventBody = eventFirst.json() as { events: Array<{ id: string }>; nextCursor?: string };
      expect(eventBody.events).toHaveLength(2); expect(eventBody.nextCursor).toBeTruthy();
      const eventSecond = await app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events?limit=2&cursor=${encodeURIComponent(eventBody.nextCursor!)}` });
      expect(eventSecond.statusCode).toBe(200); expect(eventSecond.json().events).toHaveLength(1);
      expect((await app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events?limit=2&cursor=bad` })).statusCode).toBe(400);
      const first = await app.inject({ method: 'GET', url: '/api/runs/page?limit=2' });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as { items: Array<{ id: string }>; nextCursor?: string };
      expect(firstBody.items).toHaveLength(2); expect(firstBody.nextCursor).toBeTruthy();
      const second = await app.inject({ method: 'GET', url: `/api/runs/page?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}` });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as { items: Array<{ id: string }>; nextCursor?: string };
      expect(secondBody.items).toHaveLength(2); expect(new Set(secondBody.items.map(item => item.id))).not.toEqual(new Set(firstBody.items.map(item => item.id)));
      expect((await app.inject({ method: 'GET', url: '/api/runs/page?limit=2&cursor=bad' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/runs/page' })).statusCode).toBe(400);
    } finally { await app.close(); await repo.close(); }
  });

  it('exposes a bounded resumable SSE event stream with owner and tenant isolation', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-run-event-stream-'))); await repo.init();
    const eventRun = 'run_00000000-0000-4000-8000-000000000000';
    await repo.create({ id: eventRun, owner: 'alice', tenantId: 'team-a', goal: 'stream', status: 'succeeded', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), calls: [], steps: [], plans: [], events: [], artifacts: [], context: { id: 'ctx-stream', sources: [], audience: ['owner'] }, privacy: 'internal', approval: { approved: true }, answers: [], model: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'fixture/1' }, allowedTools: [], allowedAgents: [], maxModelCalls: 1, brainMaxItems: 1, memoryMaxItems: 1, knowledgeMaxItems: 1, externalUsage: { calls: 0, tokens: 0, unreportedTokenCalls: 0, unreportedMoneyCalls: 0 }, schemaVersion: 1 });
    await repo.mutate(eventRun, run => {
      run.events.push(
        { id: 'evt.stream.1', seq: 1, type: 'task.started', at: new Date().toISOString(), data: { taskId: 'one' } },
        { id: 'evt.stream.2', seq: 2, type: 'task.completed', at: new Date().toISOString(), data: { taskId: 'one' } },
      );
    }, { owner: 'alice', tenantId: 'team-a' });
    const app = buildApp({ repository: repo, principalTokens: {
      alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
      bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
    } });
    try {
      const response = await app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events/stream?limit=1&waitMs=5&heartbeatMs=100`, headers: { authorization: 'Bearer alice' } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.body).toContain('id: 1\nevent: task.started');
      expect(response.body).toContain('id: 2\nevent: task.completed');
      expect(response.body).toContain('event: timeout');
      const cursor = Buffer.from(JSON.stringify({ seq: 1 }), 'utf8').toString('base64url');
      const resumed = await app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events/stream?cursor=${cursor}&waitMs=5&heartbeatMs=100`, headers: { authorization: 'Bearer alice' } });
      expect(resumed.body).toContain('id: 2\nevent: task.completed');
      expect(resumed.body).not.toContain('id: 1\nevent: task.started');
      const heartbeat = await app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events/stream?cursor=${Buffer.from(JSON.stringify({ seq: 2 }), 'utf8').toString('base64url')}&waitMs=120&heartbeatMs=100`, headers: { authorization: 'Bearer alice' } });
      expect(heartbeat.body).toContain('event: heartbeat');
      expect(heartbeat.body).toContain('event: timeout');
      const headerResumed = await app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events/stream?waitMs=5&heartbeatMs=100`, headers: { authorization: 'Bearer alice', 'last-event-id': '1' } });
      expect(headerResumed.body).toContain('id: 2\nevent: task.completed');
      expect(headerResumed.body).not.toContain('id: 1\nevent: task.started');
      expect((await app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events/stream?waitMs=0`, headers: { authorization: 'Bearer alice', 'last-event-id': 'bad' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events/stream?waitMs=0`, headers: { authorization: 'Bearer bob' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events/stream?waitMs=1&heartbeatMs=1`, headers: { authorization: 'Bearer alice' } })).statusCode).toBe(400);
    } finally { await app.close(); await repo.close(); }
  });

  it('enforces and releases the per-process SSE connection budget', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-run-event-stream-limit-'))); await repo.init();
    const eventRun = 'run_00000000-0000-4000-8000-000000000001';
    await repo.create({ id: eventRun, owner: 'alice', tenantId: 'team-a', goal: 'stream', status: 'succeeded', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), calls: [], steps: [], plans: [], events: [], artifacts: [], context: { id: 'ctx-stream-limit', sources: [], audience: ['owner'] }, privacy: 'internal', approval: { approved: true }, answers: [], model: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'fixture/1' }, allowedTools: [], allowedAgents: [], maxModelCalls: 1, brainMaxItems: 1, memoryMaxItems: 1, knowledgeMaxItems: 1, externalUsage: { calls: 0, tokens: 0, unreportedTokenCalls: 0, unreportedMoneyCalls: 0 }, schemaVersion: 1 });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => {
      const original = repo.eventsPage!.bind(repo);
      vi.spyOn(repo, 'eventsPage').mockImplementation(async (...args) => { resolve(); await held; return original(...args); });
    });
    const app = buildApp({ repository: repo, maxSseConnections: 1, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] } } });
    try {
      expect((await app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events/stream?waitMs=0`, headers: { authorization: 'Bearer alice', 'last-event-id': 'bad' } })).statusCode).toBe(400);
      const first = app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events/stream?waitMs=0`, headers: { authorization: 'Bearer alice' } });
      await started;
      expect((await app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events/stream?waitMs=0`, headers: { authorization: 'Bearer alice' } })).statusCode).toBe(429);
      release();
      expect((await first).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/runs/${eventRun}/events/stream?waitMs=0`, headers: { authorization: 'Bearer alice' } })).statusCode).toBe(200);
    } finally { release(); await app.close(); await repo.close(); }
  });

  it('exposes owner-scoped Rooms and binds created Goals to a Room', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-room-runs-'))); await repo.init();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-http-room-domain-')), 'domain.json')); await domainStore.init();
    const memberships = new InMemoryRoomMembershipRepository();
    const app = buildApp({ repository: repo, domain: new AeeisService(domainStore, [], memberships), principalTokens: {
      alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
      bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
      carol: { id: 'carol', tenantId: 'team-a', roles: ['agent'] },
      dave: { id: 'dave', tenantId: 'team-a', roles: ['agent'] },
    } });
    try {
      const alice = { authorization: 'Bearer alice' };
      const bob = { authorization: 'Bearer bob' };
      const carol = { authorization: 'Bearer carol' };
      const dave = { authorization: 'Bearer dave' };
      const roomResponse = await app.inject({ method: 'POST', url: '/api/rooms', headers: alice, payload: { title: 'Release room' } });
      expect(roomResponse.statusCode).toBe(200);
      const room = roomResponse.json() as { id: string; tenantId: string };
      expect(room.tenantId).toBe('team-a');
      const goalResponse = await app.inject({ method: 'POST', url: '/api/goals', headers: alice, payload: { title: 'Release', roomId: room.id } });
      expect(goalResponse.statusCode).toBe(200);
      expect(goalResponse.json()).toMatchObject({ roomId: room.id });
      expect((await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/goals`, headers: alice })).json()).toHaveLength(1);
      expect((await app.inject({ method: 'GET', url: '/api/rooms', headers: bob })).json()).toEqual([]);
      expect((await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: bob })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/members`, headers: alice, payload: { principalId: 'bob', role: 'editor' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: bob })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/members`, headers: alice, payload: { principalId: 'carol', role: 'viewer' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/members`, headers: alice, payload: { principalId: 'dave', role: 'agent' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/goals/${goalResponse.json().id}`, headers: carol })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/goals/${goalResponse.json().id}/plans`, headers: carol })).statusCode).toBe(200);
      const sharedPlan = await app.inject({ method: 'POST', url: `/api/goals/${goalResponse.json().id}/plans`, headers: bob, payload: { nodes: [{ id: 'shared-step', title: 'Shared step' }] } });
      expect(sharedPlan.statusCode).toBe(200);
      const planId = (sharedPlan.json() as { id: string }).id;
      const agentTransition = await app.inject({ method: 'POST', url: `/api/plans/${planId}/tasks/shared-step/transition`, headers: dave, payload: { transition: 'start' } });
      expect(agentTransition.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/members`, headers: alice })).json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ principalId: 'bob', role: 'editor', status: 'active' }),
        expect.objectContaining({ principalId: 'carol', role: 'viewer', status: 'active' }),
        expect.objectContaining({ principalId: 'dave', role: 'agent', status: 'active' }),
      ]));
      const sharedGoal = await app.inject({ method: 'POST', url: '/api/goals', headers: bob, payload: { title: 'Bob shared goal', roomId: room.id } });
      expect(sharedGoal.statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/goals', headers: carol, payload: { title: 'Viewer cannot create', roomId: room.id } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: '/api/goals', headers: dave, payload: { title: 'Agent cannot create', roomId: room.id } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/members`, headers: bob })).statusCode).toBe(200);
      expect((await app.inject({ method: 'PATCH', url: `/api/rooms/${room.id}`, headers: bob, payload: { description: 'Edited by room editor' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'PATCH', url: `/api/rooms/${room.id}`, headers: carol, payload: { description: 'Viewer cannot edit' } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/members`, headers: bob, payload: { principalId: 'erin', role: 'viewer' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'DELETE', url: `/api/rooms/${room.id}/members/erin`, headers: bob })).statusCode).toBe(200);
      expect((await app.inject({ method: 'PATCH', url: `/api/rooms/${room.id}`, headers: bob, payload: { status: 'archived' } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'DELETE', url: `/api/rooms/${room.id}/members/bob`, headers: alice })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: bob })).statusCode).toBe(404);
      const archived = await app.inject({ method: 'PATCH', url: `/api/rooms/${room.id}`, headers: alice, payload: { status: 'archived', title: 'Archived release room' } });
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toMatchObject({ id: room.id, title: 'Archived release room', status: 'archived' });
      expect((await app.inject({ method: 'POST', url: '/api/goals', headers: alice, payload: { title: 'Rejected', roomId: room.id } })).statusCode).toBe(409);
    } finally { await app.close(); await repo.close(); await domainStore.close(); }
  });

  it('writes Goal Memory only from owned Run evidence and exposes frozen manifests', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-memory-writeback-runs-'))); await repo.init();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-http-memory-writeback-domain-')), 'domain.json')); await domainStore.init();
    const domain = new AeeisService(domainStore);
    const goal = await domain.createGoal({ title: 'Evidence goal' }, undefined, 'alice', 'team-a');
    const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat/completions', promptVersion: 'fixture/1' }, complete: async () => ({ value: {} }) };
    const engine = new AgentEngine(repo, { model, domain });
    const run = await engine.create({ goal: 'Inspect evidence', goalId: goal.id, materials: [{ title: 'Release receipt', source: 'test', content: 'The release was verified.' }] }, 'alice', 'team-a');
    const app = buildApp({ repository: repo, domain, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team-b', roles: ['owner'] } } });
    const alice = { authorization: 'Bearer alice' };
    try {
      const sourceRef = run.context.sources[0]!.id;
      const written = await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/memories/from-run`, headers: alice, payload: { runId: run.id, kind: 'decision', content: 'Release receipt verified', evidenceRefs: [sourceRef] } });
      expect(written.statusCode).toBe(200);
      expect(written.json()).toMatchObject({ evidenceRunId: run.id, evidenceRefs: [sourceRef], source: `run:${run.id}`, classification: 'internal' });
      const manifest = await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/context-manifests`, headers: alice, payload: { purpose: 'inspect', query: 'receipt' } });
      expect(manifest.statusCode).toBe(200);
      const manifestBody = manifest.json() as { id: string; goalId: string; owner: string; tenantId: string };
      expect(manifestBody).toMatchObject({ goalId: goal.id, owner: 'alice', tenantId: 'team-a' });
      expect((await app.inject({ method: 'GET', url: `/api/goals/${goal.id}/context-manifests/${manifestBody.id}`, headers: alice })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/goals/${goal.id}/context-manifests/${manifestBody.id}`, headers: { authorization: 'Bearer bob' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/memories/from-run`, headers: alice, payload: { runId: run.id, kind: 'note', content: 'bad', evidenceRefs: ['missing'] } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/memories/from-run`, headers: alice, payload: { runId: run.id, kind: 'note', content: 'unsafe downgrade', classification: 'public', evidenceRefs: [sourceRef] } })).statusCode).toBe(409);
    } finally { await app.close(); await repo.close(); await domainStore.close(); }
  });

  it('exposes operator-only Agent discovery, admission and revocation', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-agent-registry-runs-'))); await repo.init();
    const directory = new AgentDirectory();
    const card: AgentCard = {
      schemaVersion: 'agent-card/1', agentId: 'agent.http', name: 'HTTP Agent', owner: 'partner',
      protocols: ['aeeis-task/1'], capabilities: ['research'], inputSchemas: ['task-brief/1'], outputSchemas: ['result-envelope/1'],
      auth: ['local'], privacy: { dataRetention: 'none', regions: ['local'] }, pricing: { unit: 'run' }, cardVersion: '1',
    };
    const app = buildApp({ repository: repo, agentDirectory: directory, principalTokens: {
      'owner-token': { id: 'alice', tenantId: 'tenant-a', roles: ['owner'] },
      'operator-token': { id: 'ops', tenantId: 'local', roles: ['operator'] },
    } });
    const ownerHeaders = { authorization: 'Bearer owner-token' };
    const operatorHeaders = { authorization: 'Bearer operator-token' };
    expect((await app.inject({ method: 'GET', url: '/api/agents', headers: ownerHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/agents/discover', headers: operatorHeaders, payload: card })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/agents', headers: operatorHeaders })).json()).toEqual([expect.objectContaining({ agentId: card.agentId, status: 'discovered' })]);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${card.agentId}/admit`, headers: operatorHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${card.agentId}/revoke`, headers: operatorHeaders })).json()).toEqual({ status: 'revoked', agentId: card.agentId });
    expect((await app.inject({ method: 'GET', url: `/api/agents/${card.agentId}/audit`, headers: operatorHeaders })).json().map((event: { action: string; actor: string }) => event.action)).toEqual(['discovered', 'admitted', 'revoked']);
    const observation = await app.inject({ method: 'POST', url: `/api/agents/${card.agentId}/reputation/observations`, headers: operatorHeaders, payload: { source: 'operator', outcome: 'completed', evidenceRefs: ['receipt.http'], dimensions: { quality: 1, evidence: 0.8 }, note: 'bounded test' } });
    expect(observation.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/agents/${card.agentId}/reputation`, headers: operatorHeaders })).json()).toMatchObject({ samples: 1, dimensions: { quality: 1, evidence: 0.8 } });
    expect((await app.inject({ method: 'GET', url: '/api/status', headers: operatorHeaders })).json()).toMatchObject({ agentRegistryConfigured: true, agentRegistryCounts: { revoked: 1 }, agentRegistryHealth: { ready: true, detail: 'in-memory Agent Registry ready' } });
    expect((await app.inject({ method: 'GET', url: '/metrics', headers: operatorHeaders })).body).toContain('aeeis_agents_total{status="revoked"} 1');
    await app.close(); await repo.close();
  });

  it('exposes operator-only durable Agent Grant inspection and revocation', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-grant-runs-'))); await repo.init();
    const ledger = new InMemoryGrantLedger(); await ledger.init();
    const app = buildApp({ repository: repo, grantLedger: ledger, principalTokens: {
      owner: { id: 'owner', tenantId: 'tenant', roles: ['owner'] }, ops: { id: 'ops', tenantId: 'local', roles: ['operator'] },
    } });
    try {
      const grant = { schemaVersion: 'delegation-grant/1' as const, grantId: 'grant.http', subjectAgentId: 'agent.http', issuerAgentId: 'aeeis', taskId: 'task.http', purpose: 'test', actions: ['return_result'] as const, resourceRefs: [], dataScope: 'public' as const, issuedAt: '2029-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z', budget: {}, delegationChain: [], revocationRef: 'revoke.http', nonce: 'nonce-1234567890123456' };
      await ledger.ensureGrant({ grant, digest: digestProtocol(grant) });
      expect((await app.inject({ method: 'GET', url: '/api/agents/grants/grant.http', headers: { authorization: 'Bearer owner' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/agents/grants/grant.http', headers: { authorization: 'Bearer ops' } })).json()).toMatchObject({ grantId: 'grant.http', status: 'active' });
      expect((await app.inject({ method: 'POST', url: '/api/agents/grants/grant.http/revoke', headers: { authorization: 'Bearer ops' }, payload: { reason: 'suspended' } })).json()).toMatchObject({ status: 'revoked', revokedBy: 'ops' });
      expect((await app.inject({ method: 'GET', url: '/api/agents/grants/grant.http', headers: { authorization: 'Bearer ops' } })).json()).toMatchObject({ status: 'revoked', revocationReason: 'suspended' });
    } finally { await app.close(); await repo.close(); await ledger.close(); }
  });

  it('discovers an Agent Card from a URL but leaves it awaiting admission', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-agent-url-runs-'))); await repo.init();
    const directory = new AgentDirectory();
    const card: AgentCard = {
      schemaVersion: 'agent-card/1', agentId: 'agent.url', name: 'URL Agent', owner: 'partner',
      protocols: ['aeeis-task/1'], capabilities: ['research'], inputSchemas: ['task-brief/1'], outputSchemas: ['result-envelope/1'],
      auth: ['local'], privacy: { dataRetention: 'none', regions: ['local'] }, pricing: { unit: 'run' }, cardVersion: '1',
    };
    const cardServer = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(card)); });
    await new Promise<void>(resolve => cardServer.listen(0, '127.0.0.1', resolve));
    const address = cardServer.address(); if (!address || typeof address === 'string') throw new Error('Card server did not bind');
    const app = buildApp({ repository: repo, agentDirectory: directory, principalTokens: { 'operator-token': { id: 'ops', tenantId: 'local', roles: ['operator'] } } });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/agents/discover-url', headers: { authorization: 'Bearer operator-token' }, payload: { url: `http://127.0.0.1:${address.port}/card.json` } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ agentId: card.agentId });
      expect((await app.inject({ method: 'GET', url: '/api/agents', headers: { authorization: 'Bearer operator-token' } })).json()).toEqual([expect.objectContaining({ agentId: card.agentId, status: 'discovered' })]);
    } finally { await app.close(); await repo.close(); await new Promise<void>(resolve => cardServer.close(() => resolve())); }
  });

  it('does not pretend to execute when no model is configured', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-')));
    await repo.init();
    const app = buildApp({ repository: repo });
    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { goal: 'Do real work' } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain('Configure');
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json()).toMatchObject({ modelConfigured: false, mode: 'single-owner-local', principal: 'owner', tenantId: 'local', roles: ['owner', 'operator'] });
    expect((await app.inject({ method: 'POST', url: '/api/runs/run_bad/finish', payload: {} })).statusCode).toBe(503);
    await app.close(); await repo.close();
  });

  it('returns a bounded request correlation id and replaces unsafe caller ids', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-request-id-'))); await repo.init();
    const app = buildApp({ repository: repo });
    try {
      const supplied = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'smoke:request-123' } });
      expect(supplied.statusCode).toBe(200);
      expect(supplied.headers['x-request-id']).toBe('smoke:request-123');
      const generated = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'contains spaces' } });
      expect(generated.statusCode).toBe(200);
      expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    } finally { await app.close(); await repo.close(); }
  });

  it('exposes operator-controlled Knowledge embedding reindex maintenance', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-knowledge-reindex-'))); await repo.init();
    let status: any = undefined;
    const knowledge = {
      async enqueueEmbeddingReindex(options: { batchSize?: number; reset?: boolean } = {}) {
        status = { model: 'fixture-embedding', cursor: '', indexed: 0, status: 'queued', batchSize: options.batchSize ?? 100, resetRequested: options.reset === true, updatedAt: new Date().toISOString(), consecutiveFailures: 0 };
        return status;
      },
      async getEmbeddingReindexStatus() { return status; },
      async runEmbeddingReindexBatch() { if (status) status = { ...status, status: 'completed', indexed: 2 }; return status; },
    };
    const app = buildApp({ repository: repo, knowledge: knowledge as any, principalTokens: {
      'operator-token': { id: 'ops', tenantId: 'local', roles: ['operator'] },
      'owner-token': { id: 'owner', tenantId: 'local', roles: ['owner'] },
    } });
    try {
      expect((await app.inject({ method: 'POST', url: '/api/knowledge/embedding-reindex', headers: { authorization: 'Bearer owner-token' }, payload: {} })).statusCode).toBe(403);
      const queued = await app.inject({ method: 'POST', url: '/api/knowledge/embedding-reindex', headers: { authorization: 'Bearer operator-token' }, payload: { batchSize: 25, reset: true } });
      expect(queued.statusCode).toBe(200); expect(queued.json().status).toMatchObject({ status: 'queued', batchSize: 25, resetRequested: true });
      const run = await app.inject({ method: 'POST', url: '/api/knowledge/embedding-reindex/run', headers: { authorization: 'Bearer operator-token' }, payload: {} });
      expect(run.statusCode).toBe(200); expect(run.json().status).toMatchObject({ status: 'completed', indexed: 2 });
      expect((await app.inject({ method: 'GET', url: '/api/knowledge/embedding-reindex', headers: { authorization: 'Bearer operator-token' } })).json()).toMatchObject({ status: 'completed' });
    } finally { await app.close(); await repo.close(); }
  });

  it('allows only explicitly configured internal hosts for worker requests', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-host-runs-'))); await repo.init();
    const app = buildApp({ repository: repo, workerToken: 'worker-secret', trustedHosts: ['aeeis'] });
    const rejected = await app.inject({ method: 'POST', url: '/internal/runs/run-1/advance', headers: { host: 'other:4323', authorization: 'Bearer worker-secret' }, payload: {} });
    expect(rejected.statusCode).toBe(403);
    const accepted = await app.inject({ method: 'POST', url: '/internal/runs/run-1/advance', headers: { host: 'aeeis:4323', authorization: 'Bearer worker-secret' }, payload: {} });
    expect(accepted.statusCode).toBe(503);
    expect(accepted.json()).toEqual({ error: 'Model is not configured' });
    expect((await app.inject({ method: 'POST', url: '/internal/runs/run-1/advance', headers: { host: 'aeeis:4323' }, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/internal/runs/run-1/advance', headers: { host: 'aeeis.evil:4323', authorization: 'Bearer worker-secret' }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/status', headers: { host: 'aeeis:4323', authorization: 'Bearer worker-secret' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/internal/runs/run-1/advance', headers: { host: 'aeeis:4323', authorization: 'Bearer worker-secret', origin: 'http://other' }, payload: {} })).statusCode).toBe(403);
    await app.close(); await repo.close();
  });

  it('accepts an explicitly configured public proxy host and origin without widening worker hosts', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-public-host-runs-'))); await repo.init();
    const app = buildApp({ repository: repo, publicHosts: ['agent.example.com'], trustedOrigins: ['https://console.example.com'], workerToken: 'worker-secret', trustedHosts: ['aeeis'] });
    try {
      expect((await app.inject({ method: 'GET', url: '/health', headers: { host: 'agent.example.com' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/health', headers: { host: 'agent.example.com', origin: 'https://console.example.com' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/health', headers: { host: 'agent.example.com', origin: 'https://evil.example.com' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/health', headers: { host: 'unknown.example.com' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/internal/runs/run-1/advance', headers: { host: 'agent.example.com', authorization: 'Bearer worker-secret' }, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/internal/runs/run-1/advance', headers: { host: 'aeeis:4323', authorization: 'Bearer worker-secret' }, payload: {} })).statusCode).toBe(503);
    } finally { await app.close(); await repo.close(); }
  });

  it('starts a Run from a ready domain task and writes execution receipts back to that task', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-task-run-'))); await repo.init();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-http-task-domain-')), 'domain.json')); await domainStore.init();
    const model: ModelAdapter = {
      pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat/completions', promptVersion: 'fixture/1' },
      complete: async request => request.system.includes('Independently review')
        ? { value: { verdict: 'accepted', summary: 'Task completed', issues: [] } }
        : { value: { type: 'finish', title: 'Task result', content: 'Completed the ready task.', evidenceRefs: [] } },
    };
    const engine = new AgentEngine(repo, { model, domain: new AeeisService(domainStore) });
    const dispatcher = new LocalDispatcher(engine);
    const app = buildApp({ repository: repo, engine, dispatcher, domain: new AeeisService(domainStore) });
    const goal = (await app.inject({ method: 'POST', url: '/api/goals', payload: { title: 'Release goal' } })).json() as { id: string };
    const plan = (await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/plans`, payload: { nodes: [{ id: 'release_task', title: 'Prepare release notes' }] } })).json() as { id: string };
    const started = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/tasks/release_task/run`, payload: {} });
    expect(started.statusCode).toBe(202);
    const runId = (started.json() as { id: string }).id;
    let run: { status: string; plans: Array<{ hash: string }>; taskExecution?: { domainPlanId: string; taskId: string } };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      run = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json();
      if (run.status === 'needs_approval') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    run = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json();
    expect(run.status).toBe('needs_approval');
    expect(run.taskExecution).toMatchObject({ domainPlanId: plan.id, taskId: 'release_task' });
    await app.inject({ method: 'POST', url: `/api/runs/${runId}/approve`, payload: { planHash: run.plans.at(-1)!.hash } });
    // Full-suite workers can temporarily starve the local dispatcher; wait
    // long enough to observe the durable terminal state instead of making
    // this integration test depend on a 400ms scheduling window.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      run = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json();
      if (['succeeded', 'failed'].includes(run.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(run.status).toBe('succeeded');
    const snapshot = (await app.inject({ method: 'GET', url: `/api/plans/${plan.id}/snapshot` })).json() as { plan: { nodes: Array<{ id: string; status: string }> }; receipts: Array<{ taskId: string; transition: string }> };
    expect(snapshot.plan.nodes).toEqual([expect.objectContaining({ id: 'release_task', status: 'succeeded' })]);
    expect(snapshot.receipts.map(receipt => `${receipt.taskId}:${receipt.transition}`)).toEqual(['release_task:start', 'release_task:succeed']);
    await app.close(); await dispatcher.close(); await repo.close(); await domainStore.close();
  });

  it('exposes durable DAG scheduling and task controls without creating duplicate Runs', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-scheduler-runs-'))); await repo.init();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-http-scheduler-domain-')), 'domain.json')); await domainStore.init();
    const domain = new AeeisService(domainStore);
    const model: ModelAdapter = {
      pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat/completions', promptVersion: 'fixture/1' },
      complete: async request => request.system.includes('Independently review')
        ? { value: { verdict: 'accepted', summary: 'Task completed', issues: [] } }
        : { value: { type: 'finish', title: 'Task result', content: 'Completed the ready task.', evidenceRefs: [] } },
    };
    const engine = new AgentEngine(repo, { model, domain });
    const dispatcher = new LocalDispatcher(engine);
    const dispatchRepository = new InMemoryTaskDispatchRepository();
    const scheduler = new TaskScheduler(domain, engine, dispatcher, dispatchRepository); await scheduler.init();
    const app = buildApp({ repository: repo, engine, dispatcher, domain, taskScheduler: scheduler });
    const goal = (await app.inject({ method: 'POST', url: '/api/goals', payload: { title: 'Scheduler goal' } })).json() as { id: string };
    const plan = (await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/plans`, payload: { nodes: [
      { id: 'first', title: 'First task', instruction: 'Do the first task' },
      { id: 'second', title: 'Second task', instruction: 'Do the second task', dependsOn: ['first'] },
    ] } })).json() as { id: string };
    const scheduled = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/schedule`, payload: {} });
    expect(scheduled.statusCode).toBe(202);
    const first = (scheduled.json() as { dispatches: Array<{ taskId: string; runId: string; state: string }> }).dispatches.find(item => item.taskId === 'first');
    expect(first).toMatchObject({ taskId: 'first', state: 'dispatched' });
    expect((scheduled.json() as { dispatches: Array<Record<string, unknown>> }).dispatches[0]).not.toHaveProperty('createRequest');
    expect((scheduled.json() as { dispatches: Array<Record<string, unknown>> }).dispatches[0]).not.toHaveProperty('createLease');
    const cancelled = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/tasks/first/control/cancel`, payload: {} });
    expect(cancelled.statusCode).toBe(202);
    expect(cancelled.json()).toMatchObject({ taskId: 'first', state: 'cancelled', runId: first!.runId, dispatchAttempts: 1 });
    const listed = await app.inject({ method: 'GET', url: `/api/plans/${plan.id}/scheduler` });
    expect(listed.json()).toEqual([expect.objectContaining({ taskId: 'first', state: 'cancelled', runId: first!.runId })]);
    await app.close(); await dispatchRepository.close(); await dispatcher.close(); await repo.close(); await domainStore.close();
  });

  it('lets active Room members read an owner Run and its evidence graph', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-shared-run-runs-'))); await repo.init();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-http-shared-run-domain-')), 'domain.json')); await domainStore.init();
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(domainStore, [], memberships);
    const room = await domain.createRoom({ title: 'Shared execution' }, undefined, 'alice', 'team-a');
    const goal = await domain.createGoal({ title: 'Shared execution goal', roomId: room.id }, undefined, 'alice', 'team-a');
    await domain.addRoomMember(room.id, 'bob', 'viewer', 'alice', 'team-a');
    const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat/completions', promptVersion: 'fixture/1' }, complete: async () => ({ value: {} }) };
    const engine = new AgentEngine(repo, { model, domain });
    const run = await engine.create({ goal: goal.title, goalId: goal.id, materials: [] }, 'alice', 'team-a');
    const boundedVisiblePage = vi.spyOn(repo, 'pageVisible');
    const app = buildApp({ repository: repo, engine, domain, principalTokens: {
      alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
      bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
      mallory: { id: 'mallory', tenantId: 'team-b', roles: ['owner'] },
    } });
    try {
      const shared = await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: { authorization: 'Bearer bob' } });
      expect(shared.statusCode).toBe(200);
      expect(shared.json()).toMatchObject({ id: run.id, owner: 'alice', tenantId: 'team-a', goalId: goal.id });
      expect((await app.inject({ method: 'GET', url: '/api/runs?limit=10', headers: { authorization: 'Bearer bob' } })).json()).toEqual([expect.objectContaining({ id: run.id, goalId: goal.id })]);
      expect(boundedVisiblePage).toHaveBeenCalledWith({ owner: 'bob', tenantId: 'team-a' }, [goal.id], 10);
      expect((await app.inject({ method: 'GET', url: '/api/runs/page?limit=10', headers: { authorization: 'Bearer bob' } })).json().items).toEqual([expect.objectContaining({ id: run.id, goalId: goal.id })]);
      expect((await app.inject({ method: 'GET', url: `/api/runs/${run.id}/events?limit=10`, headers: { authorization: 'Bearer bob' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/runs/${run.id}/graphs`, headers: { authorization: 'Bearer bob' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: { authorization: 'Bearer mallory' } })).statusCode).toBe(404);
      await domain.revokeRoomMember(room.id, 'bob', 'alice', 'team-a');
      expect((await app.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: { authorization: 'Bearer bob' } })).statusCode).toBe(404);
    } finally { await app.close(); await repo.close(); await domainStore.close(); await memberships.close(); }
  });

  it('preserves the unbounded shared Run list when limit is omitted', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-shared-run-unbounded-'))); await repo.init();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-http-shared-run-unbounded-domain-')), 'domain.json')); await domainStore.init();
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(domainStore, [], memberships);
    const room = await domain.createRoom({ title: 'Shared history' }, undefined, 'alice', 'team-a');
    const goal = await domain.createGoal({ title: 'Shared history goal', roomId: room.id }, undefined, 'alice', 'team-a');
    await domain.addRoomMember(room.id, 'bob', 'viewer', 'alice', 'team-a');
    const base = { owner: 'alice', tenantId: 'team-a', goal: goal.title, goalId: goal.id, status: 'succeeded' as const, revision: 1, calls: [], steps: [], plans: [], events: [], artifacts: [], context: { id: 'ctx-shared-history', sources: [], audience: ['owner'] }, privacy: 'internal' as const, approval: { approved: true }, answers: [], model: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'fixture/1' }, allowedTools: [], allowedAgents: [], maxModelCalls: 1, brainMaxItems: 1, memoryMaxItems: 1, knowledgeMaxItems: 1, externalUsage: { calls: 0, tokens: 0, unreportedTokenCalls: 0, unreportedMoneyCalls: 0 }, schemaVersion: 1 };
    for (let index = 0; index < 205; index += 1) {
      await repo.create({ ...base, id: `run_${randomUUID()}`, goal: `${goal.title}-${index}`, createdAt: new Date(index).toISOString(), updatedAt: new Date(index).toISOString() });
    }
    const app = buildApp({ repository: repo, domain, principalTokens: { bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] } } });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/runs', headers: { authorization: 'Bearer bob' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveLength(205);
    } finally { await app.close(); await repo.close(); await domainStore.close(); await memberships.close(); }
  // This intentionally creates 205 durable File runs. Each create fsyncs the
  // aggregate and its disposable indexes; under the full Vitest suite those
  // writes share the disk with other persistence tests, so keep the timeout
  // large enough to measure the unbounded compatibility path itself.
  }, 30000);

  it('separates liveness from readiness and exposes bounded Prometheus metrics', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-health-runs-'))); await repo.init();
    const app = buildApp({ repository: repo });
    const live = await app.inject({ method: 'GET', url: '/health' });
    expect(live.statusCode).toBe(200); expect(live.json()).toMatchObject({ status: 'ok', protocol: 'aeeis-health/1' });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503); expect(ready.json()).toMatchObject({ protocol: 'aeeis-readiness/1', status: 'not_ready' });
    expect(ready.json().checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'repository', ready: true, required: true }),
      expect.objectContaining({ name: 'model', ready: false, required: true }),
    ]));
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200); expect(metrics.headers['content-type']).toContain('text/plain'); expect(metrics.body).toContain('aeeis_model_configured 0');
    expect(metrics.body).toContain('aeeis_readiness 0');
    expect(metrics.body).toContain('aeeis_readiness_check{check="model",required="true"} 0');
    expect(metrics.body).toContain('aeeis_readiness_check{check="repository",required="true"} 1');
    expect(metrics.body).toContain('aeeis_http_requests_total{method="GET",route="/health",status="200"} 1');
    expect(metrics.body).toContain('aeeis_http_requests_total{method="GET",route="/readyz",status="503"} 1');
    expect(metrics.body).toContain('aeeis_http_request_duration_seconds_bucket{method="GET",route="/health",le="+Inf"} 1');
    // The scrape itself is still in flight while its response is rendered.
    expect(metrics.body).toContain('aeeis_http_requests_in_flight 1');
    await app.close(); await repo.close();
  });

  it('reports a configured model provider probe failure in readiness diagnostics', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-model-probe-runs-'))); await repo.init();
    const model: ModelAdapter = {
      pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat/completions', promptVersion: 'fixture/1' },
      complete: async () => ({ value: {} }),
      health: async () => ({ ready: false, detail: 'provider health probe returned HTTP 503', checkedAt: new Date().toISOString() }),
    };
    const app = buildApp({ repository: repo, engine: new AgentEngine(repo, model) });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'model', ready: false, detail: 'provider health probe returned HTTP 503' })]));
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json().modelHealth).toMatchObject({ ready: false });
    await app.close(); await repo.close();
  });

  it('exposes dynamic catalog and provider health as separate status fields', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-catalog-health-runs-'))); await repo.init();
    const catalog: ModelCatalog = {
      list: async () => [{ model: 'catalog-model', provider: 'catalog-provider', endpoint: 'https://provider.invalid/v1', capabilities: ['agent'] }],
      health: async () => ({ ready: true, detail: 'catalog probe passed', checkedAt: new Date().toISOString() }),
    };
    const resolver = new CatalogModelResolver(catalog, {
      create: () => ({
        pin: { model: 'catalog-model', provider: 'catalog-provider', endpoint: 'https://provider.invalid/v1/chat/completions', promptVersion: 'aeeis-project-agent/1' },
        complete: async () => ({ value: {} }),
        health: async () => ({ ready: true, detail: 'provider probe passed', checkedAt: new Date().toISOString() }),
      }),
    });
    const app = buildApp({ repository: repo, engine: new AgentEngine(repo, { resolver }) });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/status' });
      expect(response.statusCode).toBe(200);
      expect(response.json().modelHealth).toMatchObject({ ready: true, catalog: { ready: true, detail: expect.stringContaining('catalog probe passed') }, provider: { ready: true, detail: 'provider probe passed' } });
    } finally { await app.close(); await repo.close(); }
  });

  it('reports configured knowledge and project-source health without blocking core readiness', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-optional-health-runs-'))); await repo.init();
    const model: ModelAdapter = {
      pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat', promptVersion: 'fixture/1' },
      complete: async () => ({ value: {} }),
      health: async () => ({ ready: true, detail: 'fixture ready', checkedAt: new Date().toISOString() }),
    };
    const knowledgeProvider: KnowledgeProvider = { search: async () => [], health: async () => ({ ready: false, detail: 'knowledge service unavailable' }) };
    const projectSourcesProvider: ProjectSourceProvider = { search: async () => [], health: async () => ({ ready: false, detail: 'project connector unavailable' }) };
    const brainSemanticIndex = { search: async () => [], reconcile: async () => undefined, close: async () => undefined, health: async () => ({ ready: false, detail: 'embedding health endpoint unavailable' }), model: 'fixture-embed/1', dimensions: 3 };
    const domain = new AeeisService(new InMemoryStore());
    const engine = new AgentEngine(repo, { model, domain, knowledge: knowledgeProvider, projectSources: projectSourcesProvider });
    const dispatcher = new LocalDispatcher(engine);
    const scheduler = new TaskScheduler(domain, engine, dispatcher, new InMemoryTaskDispatchRepository());
    await scheduler.init();
    const app = buildApp({ repository: repo, engine, dispatcher, domain, taskScheduler: scheduler, knowledgeProvider, projectSourcesProvider, brainSemanticIndex });
    try {
      const ready = await app.inject('/readyz');
      expect(ready.statusCode).toBe(200);
      expect(ready.json().status).toBe('ready');
      const metrics = await app.inject('/metrics');
      expect(metrics.body).toContain('aeeis_readiness_check{check="knowledgeProvider",required="false"} 0');
      expect(metrics.body).toContain('aeeis_readiness_check{check="projectSources",required="false"} 0');
      expect(ready.json().checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'knowledgeProvider', required: false, ready: false, detail: 'knowledge service unavailable' }),
        expect.objectContaining({ name: 'projectSources', required: false, ready: false, detail: 'project connector unavailable' }),
        expect.objectContaining({ name: 'brainSemanticIndex', required: false, ready: false, detail: 'embedding health endpoint unavailable' }),
      ]));
      expect((await app.inject('/api/status')).json()).toMatchObject({
        knowledgeProviderHealth: { ready: false, detail: 'knowledge service unavailable' },
        projectSourcesHealth: { ready: false, detail: 'project connector unavailable' },
        brainSemanticIndexHealth: { ready: false, detail: 'embedding health endpoint unavailable' },
      });
    } finally { await app.close(); await dispatcher.close(); await repo.close(); }
  });

  it('reports configured Tool Gateway health without blocking core readiness', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-tool-health-runs-'))); await repo.init();
    const tools: ToolGateway = {
      listTools: async () => [],
      invoke: async () => { throw new Error('unused'); },
      health: async () => ({ ready: false, detail: 'tool registry unavailable', checkedAt: new Date().toISOString() }),
    };
    const app = buildApp({ repository: repo, tools });
    try {
      const ready = await app.inject('/readyz');
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'tools', required: false, ready: false, detail: 'tool registry unavailable' }),
      ]));
      expect((await app.inject('/api/status')).json()).toMatchObject({
        toolsConfigured: true,
        toolsHealth: { ready: false, detail: 'tool registry unavailable' },
      });
    } finally { await app.close(); await repo.close(); }
  });

  it.each(['unavailable', 'missing', 'throws', 'timeout'] as const)('reports %s Projection Sink health without blocking core readiness or delivering messages', async probe => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-projection-health-runs-'))); await repo.init();
    const deliver = vi.fn(async () => ({}));
    const projectionSink: ProjectionSink = {
      deliver,
      ...(probe === 'missing' ? {} : { health: async () => {
        if (probe === 'throws') throw new Error('private provider error');
        if (probe === 'timeout') return new Promise<never>(() => {});
        return { ready: false, detail: 'projection provider unavailable' };
      } }),
    };
    const model: ModelAdapter = {
      pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat', promptVersion: 'fixture/1' },
      complete: async () => ({ value: {} }),
      health: async () => ({ ready: true, detail: 'fixture ready', checkedAt: new Date().toISOString() }),
    };
    const domain = new AeeisService(new InMemoryStore());
    const engine = new AgentEngine(repo, { model, domain });
    const dispatcher = new LocalDispatcher(engine);
    const scheduler = new TaskScheduler(domain, engine, dispatcher, new InMemoryTaskDispatchRepository());
    await scheduler.init();
    const detail = { unavailable: 'projection provider unavailable', missing: 'Projection sink health probe unavailable', throws: 'Projection sink health probe failed', timeout: 'Projection sink health probe timed out' }[probe];
    const app = buildApp({ repository: repo, engine, dispatcher, domain, taskScheduler: scheduler, projectionSink, readinessCheckTimeoutMs: 30 });
    try {
      const ready = await app.inject('/readyz');
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'projectionSink', required: false, ready: false, detail }),
      ]));
      expect((await app.inject('/api/status')).json()).toMatchObject({
        projectionSinkConfigured: true,
        projectionSinkHealth: { ready: false, detail },
      });
      expect((await app.inject('/metrics')).body).toContain('aeeis_readiness_check{check="projectionSink",required="false"} 0');
      expect(deliver).not.toHaveBeenCalled();
    } finally { await app.close(); await dispatcher.close(); await repo.close(); }
  });

  it('reports RSI evaluator health without invoking an evaluation case', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-health-runs-'))); await repo.init();
    let evaluations = 0;
    const harness: RsiEvaluationHarness = {
      evaluate: async () => { evaluations += 1; throw new Error('must not evaluate'); },
      health: async () => ({ ready: false, detail: 'evaluator unavailable', checkedAt: new Date().toISOString() }),
    };
    const domain = new AeeisService(new InMemoryStore());
    const model: ModelAdapter = {
      pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat', promptVersion: 'fixture/1' },
      complete: async () => ({ value: {} }),
      health: async () => ({ ready: true, detail: 'fixture ready', checkedAt: new Date().toISOString() }),
    };
    const engine = new AgentEngine(repo, { model, domain });
    const dispatcher = new LocalDispatcher(engine);
    const scheduler = new TaskScheduler(domain, engine, dispatcher, new InMemoryTaskDispatchRepository());
    await scheduler.init();
    const app = buildApp({ repository: repo, engine, dispatcher, domain, taskScheduler: scheduler, rsiHarness: harness });
    try {
      const ready = await app.inject('/readyz');
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'rsiEvaluator', required: false, ready: false, detail: 'evaluator unavailable' }),
      ]));
      expect((await app.inject('/api/status')).json()).toMatchObject({
        rsiEvaluatorConfigured: true,
        rsiEvaluatorHealth: { ready: false, detail: 'evaluator unavailable' },
      });
      expect(evaluations).toBe(0);
    } finally { await app.close(); await dispatcher.close(); await repo.close(); }
  });

  it('bounds hanging readiness probes and reports timeout without leaking a rejected request', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-readiness-timeout-runs-'))); await repo.init();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const model: ModelAdapter = {
      pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat', promptVersion: 'fixture/1' },
      complete: async () => ({ value: {} }),
      health: async () => { await held; return { ready: true, detail: 'fixture ready', checkedAt: new Date().toISOString() }; },
    };
    // Keep the timeout small enough to prove bounded probes, while leaving
    // enough headroom for the repository metrics collector under the full
    // Vitest suite's concurrent filesystem load.
    const app = buildApp({ repository: repo, engine: new AgentEngine(repo, model), readinessCheckTimeoutMs: 100 });
    try {
      const started = Date.now();
      const ready = await app.inject('/readyz');
      expect(Date.now() - started).toBeLessThan(500);
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'model', ready: false, detail: 'dependency check timed out' }),
      ]));
      const metrics = await app.inject('/metrics');
      expect(metrics.statusCode).toBe(200);
      expect(metrics.body).toContain('aeeis_metrics_collection_success{collector="repository"} 1');
    } finally { release(); await app.close(); await repo.close(); }
  });

  it('turns readiness dependency exceptions into a failed check and recovers on the next probe', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-readiness-recovery-runs-'))); await repo.init();
    let calls = 0;
    const model: ModelAdapter = {
      pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat', promptVersion: 'fixture/1' },
      complete: async () => ({ value: {} }),
      health: async () => { calls += 1; if (calls === 1) throw new Error('provider unavailable'); return { ready: true, detail: 'fixture ready', checkedAt: new Date().toISOString() }; },
    };
    const app = buildApp({ repository: repo, engine: new AgentEngine(repo, model), readinessCheckTimeoutMs: 100 });
    try {
      const failed = await app.inject('/readyz');
      expect(failed.statusCode).toBe(503);
      expect(failed.json().checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'model', ready: false, detail: 'dependency check failed' }),
      ]));
      const recovered = await app.inject('/readyz');
      expect(recovered.statusCode).toBe(503);
      expect(recovered.json().checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'model', ready: true, detail: 'fixture ready' }),
      ]));
    } finally { await app.close(); await repo.close(); }
  });

  it('exposes the three graph projections for a persisted run', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-graphs-'))); await repo.init();
    const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat/completions', promptVersion: 'fixture/1' }, complete: async () => ({ value: { summary: 'Plan', nodes: [{ id: 'one', title: 'One', instruction: 'One', dependsOn: [] }] } }) };
    const engine = new AgentEngine(repo, model); const run = await engine.create({ goal: 'Graph run' });
    const app = buildApp({ repository: repo, engine, principalTokens: {
      alice: { id: 'owner', tenantId: 'local', roles: ['owner'] },
      bob: { id: 'bob', tenantId: 'other', roles: ['owner'] },
    } });
    const headers = { authorization: 'Bearer alice' };
    const response = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/graphs`, headers });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ planHistory: [], execution: { kind: 'execution' }, evidence: { kind: 'evidence' } }); expect(response.json().plan).toBeUndefined();
    const explanation = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/explanation`, headers });
    expect(explanation.statusCode).toBe(200); expect(explanation.json()).toMatchObject({ schemaVersion: 'run-explanation/1', run: { id: run.id }, attention: { kind: 'none' }, plan: { tasks: { total: 0 } } });
    await engine.advance(run.id);
    await repo.mutate(run.id, current => {
      const first = current.plans[0]!;
      current.plans.push({ ...first, version: 2, hash: 'f'.repeat(64), nodes: [{ ...first.nodes[0]!, instruction: 'Check sources before writing' }] });
    });
    const revised = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/graphs`, headers });
    expect(revised.json().planComparisons).toEqual([
      expect.objectContaining({ fromVersion: 1, toVersion: 2, changes: [
        expect.objectContaining({ taskId: 'one', fields: ['instruction'], before: expect.objectContaining({ instruction: 'One' }), after: expect.objectContaining({ instruction: 'Check sources before writing' }) }),
      ] }),
    ]);
    expect((await app.inject({ method: 'GET', url: `/api/runs/${run.id}/graphs`, headers: { authorization: 'Bearer bob' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/runs/${run.id}/explanation`, headers: { authorization: 'Bearer bob' } })).statusCode).toBe(404);
    await app.close(); await repo.close();
  });
  it('requires the configured bearer token and rejects cross-origin requests', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-auth-')));
    await repo.init();
    const app = buildApp({ repository: repo, token: 'local-secret' });
    expect((await app.inject({ method: 'GET', url: '/api/runs' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/runs', headers: { authorization: 'Bearer local-secret', origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/runs', headers: { authorization: 'Bearer local-secret' } })).statusCode).toBe(200);
    await app.close(); await repo.close();
  });

  it('isolates domain aggregates by authenticated principal', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-principal-runs-'))); await repo.init();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-http-principal-domain-')), 'domain.json')); await domainStore.init();
    const app = buildApp({
      repository: repo,
      domain: new AeeisService(domainStore),
      principalTokens: {
        'alice-token': { id: 'alice', tenantId: 'tenant-a', roles: ['owner'] },
        'bob-token': { id: 'bob', tenantId: 'tenant-b', roles: ['owner'] },
      },
    });
    const aliceHeaders = { authorization: 'Bearer alice-token' };
    const bobHeaders = { authorization: 'Bearer bob-token' };
    const created = await app.inject({ method: 'POST', url: '/api/goals', headers: aliceHeaders, payload: { title: 'Alice private goal' } });
    expect(created.statusCode).toBe(200);
    const goal = created.json() as { id: string; owner: string; tenantId: string };
    expect(goal).toMatchObject({ owner: 'alice', tenantId: 'tenant-a' });
    expect((await app.inject({ method: 'GET', url: '/api/goals', headers: aliceHeaders })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/goals', headers: bobHeaders })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/goals/${goal.id}`, headers: bobHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/goals/${goal.id}`, headers: aliceHeaders })).json()).toMatchObject({ id: goal.id, owner: 'alice' });
    await app.inject({ method: 'POST', url: '/api/goals', headers: aliceHeaders, payload: { title: 'Alice second goal' } });
    const firstPage = await app.inject({ method: 'GET', url: '/api/goals/page?limit=1', headers: aliceHeaders });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().goals).toHaveLength(1);
    expect(firstPage.json().nextCursor).toBeTruthy();
    const secondPage = await app.inject({ method: 'GET', url: `/api/goals/page?limit=1&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`, headers: aliceHeaders });
    expect(secondPage.json().goals).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/goals/page?limit=1', headers: bobHeaders })).json().goals).toEqual([]);
    const planCreated = await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/plans`, headers: aliceHeaders, payload: { nodes: [{ id: 'inspect', title: 'Inspect' }] } });
    expect(planCreated.statusCode).toBe(200);
    const planPage = await app.inject({ method: 'GET', url: `/api/goals/${goal.id}/plans/page?limit=1`, headers: aliceHeaders });
    expect(planPage.statusCode).toBe(200);
    expect(planPage.json().plans).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/goals/${goal.id}/plans/page?limit=1`, headers: bobHeaders })).statusCode).toBe(404);
    await app.close(); await domainStore.close(); await repo.close();
  });

  it('isolates RSI candidates and activation pointers by authenticated tenant', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-scope-runs-'))); await repo.init();
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-scope-'));
    const evolution = new FileEvolutionRepository(directory); await evolution.init();
    const activation = new FileEvolutionActivationStore(directory); await activation.init();
    const app = buildApp({
      repository: repo,
      rsi: new RsiService(evolution, activation),
      principalTokens: {
        'alice-token': { id: 'alice', tenantId: 'tenant-a', roles: ['owner'] },
        'bob-token': { id: 'bob', tenantId: 'tenant-b', roles: ['owner'] },
      },
    });
    const aliceHeaders = { authorization: 'Bearer alice-token' };
    const bobHeaders = { authorization: 'Bearer bob-token' };
    const create = async (headers: Record<string, string>) => {
      const response = await app.inject({ method: 'POST', url: '/api/evolution/candidates', headers, payload: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Cite evidence', sourceReceiptRefs: ['receipt.1'], reason: 'Correction', risk: 'low' } });
      expect(response.statusCode).toBe(200); return response.json() as { id: string; owner: string; tenantId: string };
    };
    const alice = await create(aliceHeaders); const bob = await create(bobHeaders);
    expect(alice).toMatchObject({ owner: 'alice', tenantId: 'tenant-a' });
    expect(bob).toMatchObject({ owner: 'bob', tenantId: 'tenant-b' });
    expect((await app.inject({ method: 'GET', url: '/api/evolution/candidates', headers: aliceHeaders })).json().map((item: { id: string }) => item.id)).toEqual([alice.id]);
    expect((await app.inject({ method: 'GET', url: `/api/evolution/candidates/${alice.id}`, headers: bobHeaders })).statusCode).toBe(404);
    for (const [headers, candidate] of [[aliceHeaders, alice], [bobHeaders, bob]] as const) {
      for (const kind of ['replay', 'holdout', 'safety'] as const) await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/evaluate`, headers, payload: { kind, passed: true, score: 1, evidenceRefs: [`${kind}.${candidate.owner}`] } });
      await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/approve`, headers, payload: { approvalRef: `${candidate.owner}.approval` } });
      await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/promote`, headers, payload: {} });
      expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/activate`, headers, payload: { activationRef: `${candidate.owner}.activation` } })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/api/evolution/activation', headers: aliceHeaders })).json().active).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/evolution/activation', headers: bobHeaders })).json().active).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/evolution/activation', headers: aliceHeaders })).json().active[0].owner).toBe('alice');
    await app.close(); await activation.close(); await evolution.close(); await repo.close();
  });

  it('isolates Competition and Debate rooms by authenticated tenant', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-collab-scope-runs-'))); await repo.init();
    const collaboration = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-collab-scope-'))); await collaboration.init();
    const app = buildApp({
      repository: repo,
      collaboration: new CollaborationService(collaboration),
      principalTokens: {
        'alice-token': { id: 'alice', tenantId: 'tenant-a', roles: ['owner'] },
        'bob-token': { id: 'bob', tenantId: 'tenant-b', roles: ['owner'] },
      },
    });
    const aliceHeaders = { authorization: 'Bearer alice-token' };
    const bobHeaders = { authorization: 'Bearer bob-token' };
    const brief = { schemaVersion: 'competition-brief/1', taskId: 'task.scope', contextVersion: 'ctx.scope', goal: 'Choose', participantAgentIds: ['agent.one', 'agent.two'], expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: true };
    const aliceCompetition = await app.inject({ method: 'POST', url: '/api/collaborations/competitions', headers: aliceHeaders, payload: brief });
    expect(aliceCompetition.statusCode).toBe(200);
    const competition = aliceCompetition.json() as { id: string; owner: string; tenantId: string };
    expect(competition).toMatchObject({ owner: 'alice', tenantId: 'tenant-a' });
    expect((await app.inject({ method: 'GET', url: '/api/collaborations/competitions', headers: aliceHeaders })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/collaborations/competitions', headers: bobHeaders })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/collaborations/competitions/${competition.id}`, headers: bobHeaders })).statusCode).toBe(404);
    const aliceDebate = await app.inject({ method: 'POST', url: '/api/collaborations/debates', headers: aliceHeaders, payload: { taskId: 'task.scope', contextVersion: 'ctx.scope', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1, maxTotalMessages: 1 } });
    expect(aliceDebate.statusCode).toBe(200);
    const debate = aliceDebate.json() as { id: string; owner: string; tenantId: string };
    expect(debate).toMatchObject({ owner: 'alice', tenantId: 'tenant-a' });
    expect((await app.inject({ method: 'GET', url: `/api/collaborations/debates/${debate.id}`, headers: bobHeaders })).statusCode).toBe(404);
    await app.close(); await collaboration.close(); await repo.close();
  });

  it('keeps projection outbox events inside the aggregate owner tenant', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-projection-scope-runs-'))); await repo.init();
    const collaboration = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-projection-scope-collab-'))); await collaboration.init();
    const projection = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-http-projection-scope-outbox-'))); await projection.init();
    const app = buildApp({
      repository: repo,
      collaboration: new CollaborationService(collaboration),
      projection,
      principalTokens: {
        'alice-token': { id: 'alice', tenantId: 'tenant-a', roles: ['owner'] },
        'bob-token': { id: 'bob', tenantId: 'tenant-b', roles: ['owner'] },
      },
    });
    const aliceHeaders = { authorization: 'Bearer alice-token' };
    const bobHeaders = { authorization: 'Bearer bob-token' };
    const debate = await app.inject({ method: 'POST', url: '/api/collaborations/debates', headers: aliceHeaders, payload: { taskId: 'task.projection.scope', contextVersion: 'ctx.projection.scope', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1, maxTotalMessages: 1 } });
    const debateId = (debate.json() as { id: string }).id;
    const created = await app.inject({ method: 'POST', url: '/api/collaborations/projections', headers: aliceHeaders, payload: { channel: 'test', destination: 'tenant-a', aggregateType: 'debate', aggregateId: debateId } });
    expect(created.statusCode).toBe(200);
    const eventId = (created.json() as { id: string }).id;
    expect((await app.inject({ method: 'GET', url: '/api/collaborations/projections', headers: bobHeaders })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/collaborations/projections?status=pending`, headers: aliceHeaders })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: `/api/collaborations/projections/${eventId}/reconcile`, headers: bobHeaders, payload: { outcome: 'failed', reason: 'wrong tenant' } })).statusCode).toBe(404);
    await app.close(); await projection.close(); await collaboration.close(); await repo.close();
  });

  it('keeps Brain claims inside the principal tenant and owner scope', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-principal-brain-runs-'))); await repo.init();
    const brainStore = new FileBrainStore(await mkdtemp(join(tmpdir(), 'aeeis-http-principal-brain-'))); await brainStore.init();
    const brain = await brainStore.load();
    const app = buildApp({
      repository: repo,
      brain,
      brainStore,
      principalTokens: {
        'alice-token': { id: 'alice', tenantId: 'tenant-a', roles: ['owner'] },
        'agent-token': { id: 'agent', tenantId: 'tenant-a', roles: ['agent'] },
        'bob-token': { id: 'bob', tenantId: 'tenant-b', roles: ['owner'] },
      },
    });
    const aliceHeaders = { authorization: 'Bearer alice-token' };
    const agentHeaders = { authorization: 'Bearer agent-token' };
    const bobHeaders = { authorization: 'Bearer bob-token' };
    const created = await app.inject({ method: 'POST', url: '/api/brain/claims', headers: aliceHeaders, payload: { scope: 'project', scopeRef: 'p1', classification: 'internal', kind: 'decision', content: 'Alice-only decision', sourceRefs: ['src1'], confidence: 1 } });
    expect(created.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/brain/p1', headers: aliceHeaders })).json().claims).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/brain/p1', headers: bobHeaders })).json().claims).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/brain/p1?owner=alice', headers: bobHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/brain/p1/export?owner=alice', headers: agentHeaders })).statusCode).toBe(403);
    const grant = await app.inject({ method: 'POST', url: '/api/brain/grants', headers: aliceHeaders, payload: { subject: 'agent', scopeRef: 'p1', classifications: ['internal'], actions: ['read'], expiresAt: '2030-01-01T00:00:00.000Z' } });
    expect(grant.statusCode).toBe(200);
    const agentExport = await app.inject({ method: 'GET', url: '/api/brain/p1/export?owner=alice', headers: agentHeaders });
    expect(agentExport.statusCode).toBe(200);
    expect(agentExport.json()).toMatchObject({ owner: 'alice', tenantId: 'tenant-a', claims: [{ content: 'Alice-only decision' }] });
    await app.close(); await brainStore.close(); await repo.close();
  });

  it('exposes owner Brain operations through the local API and persists them', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-brain-runs-'))); await repo.init();
    const brainStore = new FileBrainStore(await mkdtemp(join(tmpdir(), 'aeeis-http-brain-'))); await brainStore.init();
    const brain = await brainStore.load(); const app = buildApp({ repository: repo, brain, brainStore });
    const created = await app.inject({ method: 'POST', url: '/api/brain/claims', payload: { owner: 'owner', scope: 'project', scopeRef: 'p1', classification: 'internal', kind: 'decision', content: 'Use durable execution', sourceRefs: ['src1'], confidence: 1 } });
    expect(created.statusCode).toBe(200);
    const listed = await app.inject({ method: 'GET', url: '/api/brain/p1?classification=internal' });
    expect(listed.json().claims).toHaveLength(1);
    const searched = await app.inject({ method: 'GET', url: '/api/brain/p1?query=durable%20execution&maxItems=1' });
    expect(searched.statusCode).toBe(200);
    expect(searched.json().claims).toHaveLength(1);
    const exported = await app.inject({ method: 'GET', url: '/api/brain/p1/export' });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({ schemaVersion: 'aeeis-brain-bundle/1', owner: 'owner', tenantId: 'local', scopeRef: 'p1', claims: [{ content: 'Use durable execution' }], contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const bundle = exported.json();
    expect((await app.inject({ method: 'DELETE', url: '/api/brain/p1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/brain/p1?classification=internal' })).json().claims).toHaveLength(0);
    const imported = await app.inject({ method: 'POST', url: '/api/brain/p1/import', payload: bundle });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ schemaVersion: 'aeeis-brain-import/1', imported: 1, skipped: 0, contentHash: bundle.contentHash });
    expect((await app.inject({ method: 'GET', url: '/api/brain/p1?classification=internal' })).json().claims).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: '/api/brain/p1/import', payload: bundle })).json()).toMatchObject({ imported: 0, skipped: 1 });
    expect((await app.inject({ method: 'POST', url: '/api/brain/p1/import', payload: { ...bundle, contentHash: '0'.repeat(64) } })).statusCode).toBe(409);
    await app.close(); await brainStore.close(); await repo.close();
  });

  it('exposes operator-only Brain semantic index reconciliation', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-brain-reindex-runs-'))); await repo.init();
    const brainStore = new FileBrainStore(await mkdtemp(join(tmpdir(), 'aeeis-http-brain-reindex-'))); await brainStore.init();
    const brain = await brainStore.load();
    let reconciledClaims = 0;
    const semanticIndex = {
      model: 'fixture-embed/1', dimensions: 3,
      search: async () => [],
      reconcile: async (claims: unknown[]) => { reconciledClaims = claims.length; },
      close: async () => undefined,
    };
    const app = buildApp({ repository: repo, brain, brainStore, brainSemanticIndex: semanticIndex, principalTokens: {
      'owner-token': { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
      'operator-token': { id: 'ops', tenantId: 'local', roles: ['operator'] },
    } });
    try {
      const ownerHeaders = { authorization: 'Bearer owner-token' };
      const operatorHeaders = { authorization: 'Bearer operator-token' };
      const created = await app.inject({ method: 'POST', url: '/api/brain/claims', headers: ownerHeaders, payload: { scope: 'project', scopeRef: 'p1', classification: 'internal', kind: 'decision', content: 'Index this claim', sourceRefs: ['src1'], confidence: 1 } });
      expect(created.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/brain/semantic-reindex', headers: ownerHeaders })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/brain/semantic-reindex', headers: operatorHeaders, payload: {} })).json()).toMatchObject({ status: 'reconciled', claims: 1, model: 'fixture-embed/1', dimensions: 3 });
      expect(reconciledClaims).toBe(1);
    } finally { await app.close(); await brainStore.close(); await repo.close(); }
  });

  it('accepts external Agent callbacks through the signed webhook boundary without a user token', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-agent-callback-runs-'))); await repo.init();
    let received: { runId: string; body?: string } | undefined;
    const engine = {
      acceptAgentCallback: async (runId: string, _response: unknown, authentication?: { body?: string }) => {
        received = { runId, ...(authentication?.body === undefined ? {} : { body: authentication.body }) };
        return {};
      },
    } as unknown as AgentEngine;
    const app = buildApp({ repository: repo, engine });
    try {
      const body = '{"status":"completed","receiptRef":"receipt.webhook"}';
      const response = await app.inject({ method: 'POST', url: '/webhooks/agents/run_callback/callback', headers: { 'content-type': 'application/json', 'x-aeeis-timestamp': '1700000000000', 'x-aeeis-signature': 'fixture' }, payload: body });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ accepted: true });
      expect(received).toEqual({ runId: 'run_callback', body });
    } finally { await app.close(); await repo.close(); }
  });

  it('returns a client error for a callback Result Envelope rejected by the Agent protocol', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-agent-rejected-'))); await repo.init();
    const engine = { acceptAgentCallback: async () => { throw new AgentResponseRejected('protocol', 'Result claim cites evidence outside the Context Pack'); } } as unknown as AgentEngine;
    const app = buildApp({ repository: repo, engine });
    try {
      const response = await app.inject({ method: 'POST', url: '/webhooks/agents/run_rejected/callback', payload: { status: 'completed', receiptRef: 'receipt.bad' } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'Agent response rejected', kind: 'protocol' });
    } finally { await app.close(); await repo.close(); }
  });

  it('exposes durable Goal, Plan, Task and Memory domain operations', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-domain-runs-'))); await repo.init();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-http-domain-')), 'domain.json')); await domainStore.init();
    const app = buildApp({ repository: repo, domain: new AeeisService(domainStore) });
    const created = await app.inject({ method: 'POST', url: '/api/goals', payload: { title: 'Ship domain API', description: 'Persist core objects' } });
    expect(created.statusCode).toBe(200);
    const goal = created.json() as { id: string };
    const memory = await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/memories`, payload: { kind: 'decision', content: 'Keep AEEIS as the source of truth' } });
    expect(memory.statusCode).toBe(200);
    const memoryId = (memory.json() as { id: string }).id;
    const corrected = await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/memories/${memoryId}/correct`, payload: { kind: 'decision', content: 'Keep AEEIS as the evidence source', evidenceRefs: ['receipt.domain'] } });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({ version: 2, state: 'active', supersedesId: memoryId, evidenceRefs: ['receipt.domain'] });
    const retracted = await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/memories/${corrected.json().id}/retract`, payload: { reason: 'Replaced by a Brain claim' } });
    expect(retracted.statusCode).toBe(200);
    expect(retracted.json()).toMatchObject({ state: 'retracted', retractionReason: 'Replaced by a Brain claim' });
    const planResponse = await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/plans`, payload: { nodes: [{ id: 'draft', title: 'Draft', dependsOn: [] }, { id: 'review', title: 'Review', dependsOn: ['draft'] }] } });
    expect(planResponse.statusCode).toBe(200);
    const plan = planResponse.json() as { id: string };
    const revision = await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/plans/revise`, payload: { nodes: [{ id: 'draft-v2', title: 'Draft v2', dependsOn: [] }] } });
    expect(revision.statusCode).toBe(200);
    expect(revision.json().version).toBe(2);
    expect((await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/tasks/draft/transition`, payload: { transition: 'start' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/tasks/draft/transition`, payload: { transition: 'succeed' } })).statusCode).toBe(200);
    const snapshot = await app.inject({ method: 'GET', url: `/api/plans/${plan.id}/snapshot` });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({ goal: { id: goal.id }, plan: { id: plan.id }, receipts: [{ to: 'running' }, { to: 'succeeded' }] });
    expect((await app.inject({ method: 'GET', url: `/api/goals/${goal.id}/memories` })).json()).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: `/api/goals/${goal.id}/memories?limit=1` })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/goals/${goal.id}/memories?limit=0` })).statusCode).toBe(400);
    await app.close(); await repo.close();
  });

  it('exposes the governed RSI candidate lifecycle through the API', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-runs-'))); await repo.init();
    const evolution = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-'))); await evolution.init();
    const app = buildApp({ repository: repo, rsi: new RsiService(evolution) });
    const created = await app.inject({ method: 'POST', url: '/api/evolution/candidates', payload: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Cite evidence', sourceReceiptRefs: ['receipt.1'], reason: 'Correction', risk: 'low' } });
    expect(created.statusCode).toBe(200);
    const candidate = created.json() as { id: string };
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/evaluate`, payload: { kind: 'replay', passed: true, score: 0.9, evidenceRefs: ['eval.1'] } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/evaluate`, payload: { kind: 'holdout', passed: true, score: 0.9, evidenceRefs: ['eval.2'] } });
    await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/evaluate`, payload: { kind: 'safety', passed: true, score: 0.9, evidenceRefs: ['eval.3'] } });
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/approve`, payload: { approvalRef: 'approval.1' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/promote`, payload: {} })).json().status).toBe('promoted');
    await app.close(); await evolution.close(); await repo.close();
  });

  it('exposes shadow and canary rollout gates for a medium-risk candidate', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-rollout-runs-'))); await repo.init();
    const evolution = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-rollout-'))); await evolution.init();
    const app = buildApp({ repository: repo, rsi: new RsiService(evolution) });
    const created = await app.inject({ method: 'POST', url: '/api/evolution/candidates', payload: { target: 'skill', baseVersion: 'skill/1', proposedVersion: 'skill/2', change: 'Require rollout evidence', sourceReceiptRefs: ['receipt.1'], reason: 'Safe rollout', risk: 'medium' } });
    const candidate = created.json() as { id: string };
    for (const kind of ['replay', 'holdout', 'safety'] as const) await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/evaluate`, payload: { kind, passed: true, score: 0.9, evidenceRefs: [`eval.${kind}`] } });
    await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/approve`, payload: { approvalRef: 'owner.approval' } });
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/start-shadow`, payload: {} })).json().status).toBe('shadowing');
    for (let index = 1; index <= 3; index++) await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/record-shadow`, payload: { id: `shadow.${index}`, passed: true, score: 0.9, evidenceRefs: [`shadow.${index}`] } });
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/start-canary`, payload: {} })).json().status).toBe('canarying');
    for (let index = 1; index <= 3; index++) await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/record-canary`, payload: { id: `canary.${index}`, passed: true, score: 0.9, evidenceRefs: [`canary.${index}`] } });
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/promote`, payload: {} })).json().status).toBe('promoted');
    await app.close(); await evolution.close(); await repo.close();
  });

  it('exposes the explicit RSI activation boundary and active version snapshot', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-activation-runs-'))); await repo.init();
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-activation-'));
    const evolution = new FileEvolutionRepository(directory); await evolution.init();
    const activation = new FileEvolutionActivationStore(directory); await activation.init();
    const app = buildApp({ repository: repo, rsi: new RsiService(evolution, activation) });
    const created = await app.inject({ method: 'POST', url: '/api/evolution/candidates', payload: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Cite evidence', sourceReceiptRefs: ['receipt.1'], reason: 'Correction', risk: 'low' } });
    const candidate = created.json() as { id: string };
    for (const kind of ['replay', 'holdout', 'safety'] as const) await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/evaluate`, payload: { kind, passed: true, score: 0.9, evidenceRefs: [`eval.${kind}`] } });
    await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/approve`, payload: { approvalRef: 'approval.activation' } });
    await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/promote`, payload: {} });
    const active = await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/activate`, payload: { activationRef: 'owner.activation' } });
    expect(active.statusCode).toBe(200); expect(active.json()).toMatchObject({ candidateId: candidate.id, version: 'prompt/2' });
    expect((await app.inject({ method: 'GET', url: '/api/evolution/activation' })).json().active).toHaveLength(1);
    const canaryResponse = await app.inject({ method: 'POST', url: '/api/evolution/candidates', payload: { target: 'prompt', baseVersion: 'prompt/2', proposedVersion: 'prompt/3', change: 'Canary prompt', sourceReceiptRefs: ['receipt.canary'], reason: 'Traffic validation', risk: 'low' } });
    const canary = canaryResponse.json() as { id: string };
    for (const kind of ['replay', 'holdout', 'safety'] as const) await app.inject({ method: 'POST', url: `/api/evolution/candidates/${canary.id}/evaluate`, payload: { kind, passed: true, score: 0.9, evidenceRefs: [`canary.${kind}`] } });
    await app.inject({ method: 'POST', url: `/api/evolution/candidates/${canary.id}/approve`, payload: { approvalRef: 'approval.canary' } });
    await app.inject({ method: 'POST', url: `/api/evolution/candidates/${canary.id}/promote`, payload: {} });
    const started = await app.inject({ method: 'POST', url: `/api/evolution/candidates/${canary.id}/start-traffic`, payload: { percentage: 2500, rolloutRef: 'traffic.http.start' } });
    expect(started.statusCode).toBe(200); expect(started.json()).toMatchObject({ status: 'active', percentage: 2500 });
    expect((await app.inject({ method: 'GET', url: '/api/evolution/traffic' })).json()).toHaveLength(1);
    const observation = await app.inject({ method: 'POST', url: `/api/evolution/candidates/${canary.id}/record-traffic`, payload: { id: 'traffic.http.observation', passed: true, score: 0.96, evidenceRefs: ['metric.http.latency'] } });
    expect(observation.statusCode).toBe(200); expect(observation.json().observations).toEqual([expect.objectContaining({ id: 'traffic.http.observation', score: 0.96 })]);
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${canary.id}/pause-traffic`, payload: { reason: 'traffic.http.pause' } })).json()).toMatchObject({ status: 'paused', lastReason: 'traffic.http.pause' });
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${canary.id}/resume-traffic`, payload: { rolloutRef: 'traffic.http.resume' } })).json()).toMatchObject({ status: 'active', rolloutRef: 'traffic.http.resume' });
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${canary.id}/stop-traffic`, payload: { reason: 'traffic.http.stop' } })).json()).toMatchObject({ status: 'stopped', lastReason: 'traffic.http.stop' });
    await app.close(); await activation.close(); await evolution.close(); await repo.close();
  });

  it('exposes explicit Skill governance proposal, apply and rollback operations', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-skills-runs-'))); await repo.init();
    const calls: string[] = [];
    const skills: SkillGovernance = {
      health: async () => ({ ready: true, detail: 'test OwnHow ready', checkedAt: new Date().toISOString() }),
      resolve: async () => ({ plan: {} }),
      record: async () => ({ receiptRef: 'skill.receipt.1' }),
      propose: async () => [{ id: 'proposal.1', task: 'project pulse', status: 'ready', sourceReceiptId: 'receipt.1' }],
      apply: async proposalId => { calls.push(`apply:${proposalId}`); return { methodId: 'project-pulse', version: '2' }; },
      rollback: async (methodId, version) => { calls.push(`rollback:${methodId}@${version}`); return { methodId, version }; },
    };
    const app = buildApp({ repository: repo, skills });
    expect((await app.inject({ method: 'GET', url: '/api/skills/proposals' })).json()).toEqual([{ id: 'proposal.1', task: 'project pulse', status: 'ready', sourceReceiptId: 'receipt.1' }]);
    expect((await app.inject({ method: 'POST', url: '/api/skills/proposals/proposal.1/apply', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/skills/proposals/proposal.1/apply', payload: { approvalRef: 'owner.approval.1' } })).json()).toEqual({ methodId: 'project-pulse', version: '2' });
    expect((await app.inject({ method: 'POST', url: '/api/skills/project-pulse/2/rollback', payload: { reason: 'regression' } })).json()).toEqual({ methodId: 'project-pulse', version: '2' });
    expect(calls).toEqual(['apply:proposal.1', 'rollback:project-pulse@2']);
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json()).toMatchObject({ skillGovernanceConfigured: true, skillGovernanceHealth: { ready: true, detail: 'test OwnHow ready' }, executionProfile: 'unverified' });
    await app.close(); await repo.close();
  });

  it('turns a Run correction into an evidence-bound RSI candidate', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-correction-runs-'))); await repo.init();
    const evolution = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-correction-rsi-'))); await evolution.init();
    const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat/completions', promptVersion: 'fixture/1' }, complete: async () => ({ value: {} }) };
    const engine = new AgentEngine(repo, model);
    const app = buildApp({ repository: repo, engine, rsi: new RsiService(evolution) });
    const withMaterial = await engine.create({ goal: 'Correction source with evidence', materials: [{ title: 'Brief', source: 'test', content: 'Evidence' }] });
    const materialRun = await app.inject({ method: 'GET', url: `/api/runs/${withMaterial.id}` });
    const evidenceId = (materialRun.json() as { context: { sources: Array<{ id: string }> } }).context.sources[0]!.id;
    const stale = await app.inject({ method: 'POST', url: `/api/runs/${withMaterial.id}/corrections`, payload: { target: 'prompt', baseVersion: 'prompt/0', proposedVersion: 'prompt/2', change: 'Require explicit evidence', reason: 'Stale version must be rejected', risk: 'low', sourceReceiptRefs: [evidenceId] } });
    expect(stale.statusCode).toBe(409);
    const response = await app.inject({ method: 'POST', url: `/api/runs/${withMaterial.id}/corrections`, payload: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Require explicit evidence', reason: 'The report omitted its source', risk: 'low', sourceReceiptRefs: [evidenceId] } });
    expect(response.statusCode).toBe(200);
    expect(response.json().candidate.status).toBe('proposed');
    expect(response.json().correction.sourceRefs).toEqual([evidenceId]);
    expect((await app.inject({ method: 'GET', url: `/api/runs/${withMaterial.id}` })).json().corrections).toHaveLength(1);
    await app.close(); await evolution.close(); await repo.close();
  });

  it('exposes owner-scoped RSI improvement signals for review', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-signals-runs-'))); await repo.init();
    const evolution = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-signals-evolution-'))); await evolution.init();
    const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat/completions', promptVersion: 'fixture/1' }, complete: async () => ({ value: {} }) };
    const engine = new AgentEngine(repo, model);
    const app = buildApp({ repository: repo, engine, rsi: new RsiService(evolution), principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] } } });
    try {
      const run = await engine.create({ goal: 'Review signal', materials: [{ title: 'Brief', source: 'test', content: 'Evidence' }] }, 'alice', 'team-a');
      await repo.mutate(run.id, current => { current.events.push({ id: 'evt_review_signal', seq: current.events.length + 1, type: 'review.completed', at: new Date().toISOString(), data: { verdict: 'needs_revision', reviewConfidence: 0.2 } }); });
      const response = await app.inject({ method: 'GET', url: '/api/evolution/signals?limit=10', headers: { authorization: 'Bearer alice' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([expect.objectContaining({ runId: run.id, eventId: 'evt_review_signal', kind: 'review_needs_revision', owner: 'alice', tenantId: 'team-a' })]);
    } finally { await app.close(); await evolution.close(); await repo.close(); }
  });

  it('runs a bounded RSI evaluation suite through the HTTP boundary', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-suite-runs-'))); await repo.init();
    const evolution = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-suite-rsi-'))); await evolution.init();
    const rsi = new RsiService(evolution);
    const candidate = await rsi.propose({ target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Cite evidence', sourceReceiptRefs: ['receipt.1'], reason: 'Correction', risk: 'low' });
    const harness: RsiEvaluationHarness = { evaluate: async (_candidate, mode, testCase) => ({ passed: true, score: 0.9, evidenceRefs: [`${mode}.${testCase.id}`] }) };
    const app = buildApp({ repository: repo, rsi, rsiHarness: harness });
    const response = await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/evaluate-suite`, payload: { suite: { replay: [{ id: 'r1', input: {} }], holdout: [{ id: 'h1', input: {} }], safety: [{ id: 's1', input: {} }] } } });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('evaluating');
    expect(response.json().evaluations).toHaveLength(3);
    await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/approve`, payload: { approvalRef: 'approval.rollout-runner' } });
    await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/start-shadow`, payload: {} });
    const rollout = await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/run-shadow`, payload: { cases: [{ id: 'shadow.http', input: {} }] } });
    expect(rollout.statusCode).toBe(200);
    expect(rollout.json().shadowObservations[0].evidenceRefs).toEqual(['shadow.shadow.http']);
    await app.close(); await evolution.close(); await repo.close();
  });

  it('creates and delivers an idempotent collaboration projection snapshot', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-projection-runs-'))); await repo.init();
    const collaboration = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-projection-collab-'))); await collaboration.init();
    const projection = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-http-projection-outbox-'))); await projection.init();
    let delivered = 0;
    const app = buildApp({ repository: repo, collaboration: new CollaborationService(collaboration), projection, projectionSink: { deliver: async () => { delivered += 1; return { externalId: 'feishu.msg.1' }; } } });
    const debate = await app.inject({ method: 'POST', url: '/api/collaborations/debates', payload: { taskId: 'task.projection', contextVersion: 'ctx.projection', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1, maxTotalMessages: 1 } });
    const debateId = (debate.json() as { id: string }).id;
    const created = await app.inject({ method: 'POST', url: '/api/collaborations/projections', payload: { channel: 'feishu', destination: 'chat.1', aggregateType: 'debate', aggregateId: debateId } });
    expect(created.statusCode).toBe(200);
    const eventId = (created.json() as { id: string }).id;
    expect((await app.inject({ method: 'POST', url: `/api/collaborations/projections/${eventId}/deliver` })).json().status).toBe('delivered');
    expect(delivered).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json().projectionConfigured).toBe(true);
    await app.close(); await projection.close(); await collaboration.close(); await repo.close();
  });

  it('projects canonical Goal, Plan and Task snapshots through the same outbox', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-domain-projection-runs-'))); await repo.init();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-http-domain-projection-')), 'domain.json')); await domainStore.init();
    const domain = new AeeisService(domainStore);
    const goal = await domain.createGoal({ title: 'Project this goal' });
    const plan = await domain.createPlan({ goalId: goal.id, nodes: [{ id: 'draft', title: 'Draft' }] });
    const projection = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-http-domain-projection-outbox-'))); await projection.init();
    const app = buildApp({ repository: repo, domain, projection });
    const goalEvent = await app.inject({ method: 'POST', url: '/api/collaborations/projections', payload: { channel: 'tasks', destination: 'project.1', aggregateType: 'goal', aggregateId: goal.id } });
    const planEvent = await app.inject({ method: 'POST', url: '/api/collaborations/projections', payload: { channel: 'tasks', destination: 'project.1', aggregateType: 'plan', aggregateId: plan.id } });
    const taskEvent = await app.inject({ method: 'POST', url: '/api/collaborations/projections', payload: { channel: 'tasks', destination: 'project.1', aggregateType: 'task', aggregateId: `${plan.id}.draft` } });
    expect(goalEvent.statusCode).toBe(200); expect(planEvent.statusCode).toBe(200); expect(taskEvent.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/collaborations/projections?status=pending' })).json()).toHaveLength(3);
    await app.close(); await projection.close(); await domainStore.close(); await repo.close();
  });

  it('projects a Room together with its current membership snapshot', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-room-projection-runs-'))); await repo.init();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-http-room-projection-domain-')), 'domain.json')); await domainStore.init();
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(domainStore, [], memberships);
    const room = await domain.createRoom({ title: 'Shared room' }, undefined, 'alice', 'tenant-a');
    await domain.addRoomMember(room.id, 'bob', 'viewer', 'alice', 'tenant-a');
    const projection = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-http-room-projection-outbox-'))); await projection.init();
    const app = buildApp({ repository: repo, domain, projection, principalTokens: {
      alice: { id: 'alice', tenantId: 'tenant-a', roles: ['owner'] },
      bob: { id: 'bob', tenantId: 'tenant-a', roles: ['owner'] },
      mallory: { id: 'mallory', tenantId: 'tenant-b', roles: ['owner'] },
    }});
    const aliceHeaders = { authorization: 'Bearer alice' };
    const created = await app.inject({ method: 'POST', url: '/api/collaborations/projections', headers: aliceHeaders, payload: { channel: 'rooms', destination: 'workspace.1', aggregateType: 'room', aggregateId: room.id } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ aggregateType: 'room', aggregateId: room.id, owner: 'alice', tenantId: 'tenant-a', payload: { id: room.id, members: [{ principalId: 'bob', role: 'viewer', status: 'active' }] } });
      const wrongTenant = await app.inject({ method: 'POST', url: '/api/collaborations/projections', headers: { authorization: 'Bearer mallory' }, payload: { channel: 'rooms', destination: 'workspace.1', aggregateType: 'room', aggregateId: room.id } });
      expect(wrongTenant.statusCode).toBe(404);
      const viewerProjection = await app.inject({ method: 'POST', url: '/api/collaborations/projections', headers: { authorization: 'Bearer bob' }, payload: { channel: 'rooms', destination: 'workspace.1', aggregateType: 'room', aggregateId: room.id } });
      expect(viewerProjection.statusCode).toBe(409);
      await app.close(); await projection.close(); await memberships.close(); await domainStore.close(); await repo.close();
  });

  it('projects an RSI candidate through the same outbox boundary', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-evolution-projection-runs-'))); await repo.init();
    const evolution = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-evolution-projection-rsi-'))); await evolution.init();
    const rsi = new RsiService(evolution);
    const candidate = await rsi.propose({ target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Cite evidence', sourceReceiptRefs: ['receipt.projection'], reason: 'Projection test', risk: 'low' });
    const projection = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-http-evolution-projection-outbox-'))); await projection.init();
    const app = buildApp({ repository: repo, rsi, projection });
    const response = await app.inject({ method: 'POST', url: '/api/collaborations/projections', payload: { channel: 'tasks', destination: 'project.1', aggregateType: 'evolution', aggregateId: candidate.id } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ aggregateType: 'evolution', aggregateId: candidate.id, payload: { id: candidate.id } });
    await app.close(); await projection.close(); await evolution.close(); await repo.close();
  });

  it('exposes durable competition and debate collaboration endpoints', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-collab-runs-'))); await repo.init();
    const collaboration = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-collab-'))); await collaboration.init();
    const app = buildApp({ repository: repo, collaboration: new CollaborationService(collaboration) });
    const created = await app.inject({ method: 'POST', url: '/api/collaborations/competitions', payload: {
      schemaVersion: 'competition-brief/1', taskId: 'task.http', contextVersion: 'ctx.http', goal: 'Choose', participantAgentIds: ['agent.one', 'agent.two'], expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: true,
    }});
    expect(created.statusCode).toBe(200); const competition = created.json() as { id: string };
    const result = (agentId: string) => ({ schemaVersion: 'result-envelope/1', taskId: 'task.http', agentId, status: 'completed', resultType: 'plan/1', summary: agentId, claims: [], artifacts: [], unresolved: [], requestedFollowups: [], cost: {}, capabilitiesUsed: [], contextVersion: 'ctx.http', receiptRef: `receipt.${agentId}` });
    await app.inject({ method: 'POST', url: `/api/collaborations/competitions/${competition.id}/candidate`, payload: result('agent.one') });
    await app.inject({ method: 'POST', url: `/api/collaborations/competitions/${competition.id}/candidate`, payload: result('agent.two') });
    expect((await app.inject({ method: 'POST', url: `/api/collaborations/competitions/${competition.id}/begin-evaluation`, payload: { evaluatorAgentId: 'agent.eval' } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/collaborations/competitions/${competition.id}/score`, payload: { evaluatorAgentId: 'agent.eval', score: { agentId: 'candidate_1', score: 0.8, accepted: true, reasons: [], evidenceRefs: [] } } });
    expect((await app.inject({ method: 'POST', url: `/api/collaborations/competitions/${competition.id}/score`, payload: { evaluatorAgentId: 'agent.eval', score: { agentId: 'candidate_2', score: 0.5, accepted: true, reasons: [], evidenceRefs: [] } } })).json().status).toBe('completed');
    const debate = await app.inject({ method: 'POST', url: '/api/collaborations/debates', payload: { taskId: 'task.debate.http', contextVersion: 'ctx.debate.http', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1, maxTotalMessages: 1 } });
    expect(debate.statusCode).toBe(200); const room = debate.json() as { id: string };
    expect((await app.inject({ method: 'POST', url: `/api/collaborations/debates/${room.id}/message`, payload: { schemaVersion: 'debate-message/1', messageId: 'message.http', debateId: room.id, round: 1, speakerAgentId: 'agent.one', type: 'position', content: 'Position', claimRefs: [], contextVersion: 'ctx.debate.http' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/collaborations/debates/${room.id}/close`, payload: { reason: 'done' } })).json().status).toBe('closed');
    await app.close(); await collaboration.close(); await repo.close();
  });
});
