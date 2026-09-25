import { expect } from 'vitest';
import type { RunRepository } from '../../src/runtime/repository.js';
import type { AeeisStore } from '../../src/adapters/in-memory-store.js';
import type { CollaborationRepository } from '../../src/collaboration-service.js';
import { CollaborationService } from '../../src/collaboration-service.js';
import { AgentEngine } from '../../src/runtime/engine.js';
import { AeeisService } from '../../src/application/aeeis-service.js';

export const collectionOwner = { owner: 'alice', tenantId: 'team-a' };
const otherScopes = [{ owner: 'bob', tenantId: 'team-a' }, { owner: 'alice', tenantId: 'team-b' }];
const date = (day: number) => `2020-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;

export async function runCollectionContract(repo: RunRepository) {
  const engine = new AgentEngine(repo, {
    pin: { model: 'fixture', endpoint: 'http://127.0.0.1', promptVersion: 'fixture/1' },
    complete: async () => { throw new Error('Collection test must not call a model'); },
  });
  const seed = await engine.create({ goal: 'Collection ordering' }, collectionOwner.owner, collectionOwner.tenantId);
  // Insert out of logical timestamp order, including a tie and newer foreign rows.
  const ids: string[] = [];
  for (const [index, day] of [3, 1, 3, 2, 6, 7].entries()) {
    const id = `run_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    await repo.create({ ...seed, id, ...(otherScopes[index - 4] ?? collectionOwner), updatedAt: date(day) });
    ids.push(id);
  }
  // The seed is newer than the deliberately historical fixtures.
  expect((await repo.list(collectionOwner, 3)).map(item => item.id)).toEqual([seed.id, ids[0], ids[2]]);
  expect(await repo.list(collectionOwner)).toHaveLength(5);
  expect(await repo.list(undefined, 7)).toHaveLength(7);
  expect(await repo.list({ owner: 'nobody', tenantId: 'team-a' }, 2)).toEqual([]);
  await repo.mutate(ids[1]!, run => { run.goal = 'Updated old run'; }, collectionOwner);
  expect((await repo.list(collectionOwner, 1))[0]?.id).toBe(ids[1]);
  await expect(repo.list(collectionOwner, 0)).rejects.toThrow('limit');
  await expect(repo.list(undefined, 1.5)).rejects.toThrow('limit');
  if (repo.page) {
    const seen = new Set<string>(); let cursor: string | undefined;
    for (;;) {
      const page = await repo.page(collectionOwner, 2, cursor);
      for (const run of page.runs) seen.add(run.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(new Set([seed.id, ids[0], ids[1], ids[2], ids[3]]));
    await expect(repo.page(collectionOwner, 2, 'invalid-cursor')).rejects.toThrow('cursor');
  }
  if (repo.eventsPage) {
    const target = await repo.get(seed.id, collectionOwner);
    await repo.mutate(seed.id, run => {
      for (let index = 0; index < 4; index += 1) run.events.push({ id: `event.page.${index}`, seq: run.events.length + 1, type: 'page.test', at: date(20 + index), data: { index } });
    }, collectionOwner);
    const first = await repo.eventsPage(seed.id, collectionOwner, 2);
    expect(first.events).toHaveLength(2); expect(first.nextCursor).toBeTruthy();
    const second = await repo.eventsPage(seed.id, collectionOwner, 2, first.nextCursor);
    expect(second.events.map(event => event.id)).not.toEqual(first.events.map(event => event.id));
    await expect(repo.eventsPage(seed.id, { owner: 'bob', tenantId: 'team-a' }, 2)).rejects.toThrow('Unknown run');
    await expect(repo.eventsPage(target.id, collectionOwner, 2, 'invalid-cursor')).rejects.toThrow('cursor');
    // Keep the original collection contract's newest logical Run unchanged
    // after adding events to the separate projection fixture.
    await repo.mutate(ids[1]!, run => { run.goal = 'Updated old run'; }, collectionOwner);
  }
  return ids[1]!;
}

export async function goalCollectionContract(store: AeeisStore) {
  const service = new AeeisService(store);
  for (const [index, day] of [3, 1, 2, 8, 9].entries()) {
    const scope = otherScopes[index - 3] ?? collectionOwner;
    await service.createGoal({ title: `Goal ${day}` }, date(day), scope.owner, scope.tenantId);
  }
  expect((await service.listGoals('alice', 'team-a', 2)).map(goal => goal.title)).toEqual(['Goal 3', 'Goal 2']);
  expect(await service.listGoals('alice', 'team-a')).toHaveLength(3);
  expect(await store.getGoals()).toHaveLength(5);
  await store.saveGoal({ id: 'legacy', title: 'Legacy local owner', status: 'active', createdAt: date(10) });
  expect((await service.listGoals('owner', 'local', 1))[0]?.id).toBe('legacy');
  await expect(store.getGoals(collectionOwner, -1)).rejects.toThrow('limit');
  if (store.getGoalsPage) {
    const seen: string[] = []; let cursor: string | undefined;
    for (;;) {
      const page = await service.listGoalsPage(collectionOwner.owner, collectionOwner.tenantId, 2, cursor);
      seen.push(...page.goals.map(goal => goal.title));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['Goal 3', 'Goal 2', 'Goal 1']);
    await expect(service.listGoalsPage(collectionOwner.owner, collectionOwner.tenantId, 2, 'invalid-cursor')).rejects.toThrow('cursor');
  }
  const goal = (await service.listGoals(collectionOwner.owner, collectionOwner.tenantId))[0]!;
  for (let version = 1; version <= 3; version += 1) {
    if (version === 1) continue;
    await service.createPlanRevision({ goalId: goal.id, nodes: [{ id: `task_${version}`, title: `Plan ${version}` }] }, date(20 + version), collectionOwner.owner, collectionOwner.tenantId);
  }
  if (store.getPlansPage) {
    const first = await service.listPlansPage(goal.id, collectionOwner.owner, collectionOwner.tenantId, 1);
    expect(first.plans).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    const second = await service.listPlansPage(goal.id, collectionOwner.owner, collectionOwner.tenantId, 1, first.nextCursor);
    expect(second.plans[0]!.version).toBe(1);
    await expect(service.listPlansPage(goal.id, collectionOwner.owner, collectionOwner.tenantId, 1, 'invalid-cursor')).rejects.toThrow('cursor');
  }
}

export async function collaborationCollectionContract(repo: CollaborationRepository) {
  const service = new CollaborationService(repo);
  const brief = { schemaVersion: 'competition-brief/1', taskId: 'task.collection', contextVersion: 'ctx.collection', goal: 'Choose', participantAgentIds: ['agent.one', 'agent.two'], expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: true };
  const competitions: string[] = [], debates: string[] = [];
  for (const [index, day] of [3, 1, 2, 8, 9].entries()) {
    const scope = otherScopes[index - 3] ?? collectionOwner;
    const c = await service.createCompetition(brief, scope);
    const d = await service.createDebate({ taskId: brief.taskId, contextVersion: brief.contextVersion, participantAgentIds: brief.participantAgentIds }, scope);
    await repo.mutateCompetition(c.id, current => ({ ...current, updatedAt: date(day) }), scope);
    await repo.mutateDebate(d.id, current => ({ ...current, updatedAt: date(day) }), scope);
    competitions.push(c.id); debates.push(d.id);
  }
  expect((await service.listCompetitions(collectionOwner, 2)).map(item => item.id)).toEqual([competitions[0], competitions[2]]);
  expect((await service.listDebates(collectionOwner, 2)).map(item => item.id)).toEqual([debates[0], debates[2]]);
  expect(await service.listCompetitions(collectionOwner)).toHaveLength(3);
  expect(await service.listDebates()).toHaveLength(5);
  const competitionPage = await service.pageCompetitions(collectionOwner, 2);
  expect(competitionPage.items).toHaveLength(2); expect(competitionPage.nextCursor).toBeTruthy();
  const competitionPage2 = await service.pageCompetitions(collectionOwner, 2, competitionPage.nextCursor);
  expect(competitionPage2.items).toHaveLength(1); expect(new Set(competitionPage2.items.map(item => item.id))).not.toEqual(new Set(competitionPage.items.map(item => item.id)));
  await expect(service.pageCompetitions(collectionOwner, 2, 'invalid-cursor')).rejects.toThrow('cursor');
  const debatePage = await service.pageDebates(collectionOwner, 2);
  expect(debatePage.items).toHaveLength(2); expect(debatePage.nextCursor).toBeTruthy();
  const debatePage2 = await service.pageDebates(collectionOwner, 2, debatePage.nextCursor);
  expect(debatePage2.items).toHaveLength(1);
  const copy = (await repo.listCompetitions(collectionOwner, 1))[0]!;
  copy.brief.goal = 'Mutated caller copy';
  expect((await repo.getCompetition(copy.id)).brief.goal).toBe('Choose');
  const changed = await repo.mutateCompetition(copy.id, current => ({ ...current, brief: { ...current.brief, goal: 'Committed goal' } }));
  changed.brief.goal = 'Mutated return value';
  expect((await repo.getCompetition(copy.id)).brief.goal).toBe('Committed goal');
  await expect(repo.listCompetitions(collectionOwner, 0)).rejects.toThrow('limit');
  await expect(repo.listDebates(undefined, NaN)).rejects.toThrow('limit');
}


/** Seed records with deliberately different insertion and logical time order. */
export async function evolutionCollectionContract(repository: import('../../src/rsi.js').EvolutionRepository) {
  const { EvolutionEngine } = await import('../../src/evolution.js');
  const { RsiService } = await import('../../src/rsi.js');
  const engine = new EvolutionEngine();
  const service = new RsiService(repository);
  const seed = engine.propose({ target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Improve instructions', sourceReceiptRefs: ['receipt.one'], reason: 'test', risk: 'low' });
  const ids: string[] = [];
  for (const [index, day] of [3, 1, 3, 2, 8, 9].entries()) {
    const id = `evo_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    await repository.create({ ...seed, id, ...(otherScopes[index - 4] ?? collectionOwner), createdAt: date(1), updatedAt: date(day) });
    ids.push(id);
  }
  expect((await service.list(collectionOwner, 2)).map(candidate => candidate.id)).toEqual([ids[0], ids[2]]);
  expect(await service.list(collectionOwner)).toHaveLength(4);
  expect(await service.list(undefined, 6)).toHaveLength(6);
  expect(await service.list({ owner: 'nobody', tenantId: 'team-a' }, 1)).toEqual([]);
  await expect(service.list(collectionOwner, 0)).rejects.toThrow('limit');
  await expect(service.list(undefined, NaN)).rejects.toThrow('limit');
  const current = await repository.get(ids[1]!);
  for (const changes of [{ owner: 'bob' }, { tenantId: 'team-b' }, { id: ids[0] }, { createdAt: date(2) }]) {
    // No explicit scope here: operator/internal callers cannot transfer a
    // candidate to another identity either.
    await expect(repository.mutate(current.id, candidate => ({ ...candidate, ...changes }))).rejects.toThrow('immutable');
    expect(await repository.get(current.id)).toEqual(current);
  }
  const updated = await repository.mutate(current.id, candidate => ({ ...candidate, reason: 'Changed old candidate', updatedAt: date(1) }), collectionOwner);
  expect(Date.parse(updated.updatedAt!)).toBeGreaterThan(Date.parse(date(9)));
  expect((await service.list(collectionOwner, 1))[0]?.id).toBe(current.id);
  return { newestId: current.id, seed };
}

export async function roomCollectionContract(store: AeeisStore, memberships: import('../../src/room-membership.js').RoomMembershipRepository) {
  const service = new AeeisService(store, [], memberships);
  for (const [id, owner, tenantId, day] of [
    ['room.own', 'alice', 'team-a', 1], ['room.shared', 'bob', 'team-a', 3],
    ['room.hidden', 'bob', 'team-a', 9], ['room.revoked', 'bob', 'team-a', 8],
    ['room.foreign', 'alice', 'team-b', 10],
  ] as const) {
    await store.commitRoomCreation({ id, owner, tenantId, title: id, status: 'active', createdAt: date(day), updatedAt: date(day) });
  }
  await memberships.add('room.shared', 'alice', 'team-a', 'viewer', 'bob');
  await memberships.add('room.revoked', 'alice', 'team-a', 'viewer', 'bob');
  await memberships.revoke('room.revoked', 'alice', 'team-a', 'bob');
  // A stale or corrupt cross-tenant membership must not override Room scope.
  await memberships.add('room.foreign', 'alice', 'team-a', 'viewer', 'bob');
  await memberships.add('room.missing', 'alice', 'team-a', 'viewer', 'bob');
  expect((await service.listRoomsForPrincipal('alice', 'team-a', 1)).map(room => room.id)).toEqual(['room.shared']);
  expect((await service.listRoomsForPrincipal('alice', 'team-a')).map(room => room.id)).toEqual(['room.shared', 'room.own']);
  await expect(service.getRoomForPrincipal('room.foreign', 'alice', 'team-a')).rejects.toThrow('Unknown room');
  await service.updateRoom('room.own', { title: 'Recently edited' }, undefined, 'alice', 'team-a');
  expect((await service.listRoomsForPrincipal('alice', 'team-a', 1))[0]?.id).toBe('room.own');
  await expect(service.listRoomsForPrincipal('alice', 'team-a', 0)).rejects.toThrow('limit');
  if (store.getRoomsPage) {
    const seen: string[] = []; let cursor: string | undefined;
    for (;;) {
      const page = await service.pageRoomsForProjection(2, cursor);
      seen.push(...page.items.map(item => item.room.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['room.own', 'room.foreign', 'room.hidden', 'room.revoked', 'room.shared']);
    await expect(service.pageRoomsForProjection(2, 'invalid-cursor')).rejects.toThrow('cursor');
  }
}

export async function registryCollectionContract(directory: import('../../src/agent-gateway.js').AgentDirectoryPort) {
  const card: import('../../src/protocol.js').AgentCard = {
    schemaVersion: 'agent-card/1', agentId: 'agent.first', name: 'Test', owner: 'partner',
    protocols: ['aeeis-task/1'], capabilities: ['research'], inputSchemas: ['task-brief/1'], outputSchemas: ['result-envelope/1'],
    auth: ['local'], privacy: { dataRetention: 'none', regions: ['local'] }, pricing: { unit: 'run' }, cardVersion: '1',
  };
  for (const agentId of ['agent.first', 'agent.second', 'agent.third']) await directory.discover({ ...card, agentId });
  await directory.recordReputation('agent.first', { source: 'operator', outcome: 'completed', evidenceRefs: ['receipt.one'], dimensions: { quality: 1 } });
  await directory.admit('agent.second');
  expect((await directory.entriesSnapshot(2)).map(entry => entry.agentId)).toEqual(['agent.first', 'agent.second']);
  expect((await directory.entriesSnapshot(2))[0]?.reputation.samples).toBe(1);
  expect(await directory.entriesSnapshot()).toHaveLength(3);
  const first = (await directory.entriesSnapshot(1))[0]!;
  first.card.name = 'Caller mutation'; first.reputation.samples = 99;
  expect((await directory.entriesSnapshot(1))[0]).toMatchObject({ card: { name: 'Test' }, reputation: { samples: 1 } });
  await expect(Promise.resolve().then(() => directory.entriesSnapshot(0))).rejects.toThrow('limit');
}

export async function triggerCollectionContract(store: import('../../src/collaboration-triggers.js').CollaborationTriggerStore) {
  for (const [index, day] of [3, 1, 3, 2, 8, 9].entries()) {
    const scope = otherScopes[index - 4] ?? collectionOwner;
    await store.createPolicy({ schemaVersion: 1, id: `policy.${index}`, ...scope, name: 'Review', enabled: true, eventTypes: ['review.completed'], action: { type: 'debate', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1, dispatch: 'create' }, cooldownMs: 0, createdAt: date(1), updatedAt: date(day) });
    await store.claimDecision({ schemaVersion: 1, id: `decision.${index}`, policyId: index === 3 ? 'policy.other' : 'policy.0', eventId: `event.${index}`, ...scope, state: 'started', actionType: 'debate', dispatchState: 'not_requested', startedAt: date(day) });
  }
  expect((await store.listPolicies(collectionOwner, 2)).map(item => item.id)).toEqual(['policy.0', 'policy.2']);
  expect((await store.listDecisions(collectionOwner, 'policy.0', 3)).map(item => item.id)).toEqual(['decision.0', 'decision.2', 'decision.1']);
  expect(await store.listPolicies(collectionOwner)).toHaveLength(4);
  expect(await store.listDecisions(undefined, undefined, 2)).toHaveLength(2);
  expect(await store.listDecisions(collectionOwner, 'policy.missing', 2)).toEqual([]);
  const copy = (await store.listPolicies(collectionOwner, 1))[0]!;
  copy.action.participantAgentIds.push('agent.caller');
  expect((await store.getPolicy(copy.id)).action.participantAgentIds).toEqual(['agent.one']);
  const changed = await store.updatePolicy('policy.1', current => ({ ...current, updatedAt: date(10) }), collectionOwner);
  changed.name = 'Caller mutation';
  expect((await store.listPolicies(collectionOwner, 1))[0]).toMatchObject({ id: 'policy.1', name: 'Review' });
  await store.deletePolicy('policy.1', collectionOwner);
  expect((await store.listPolicies(collectionOwner, 1))[0]?.id).toBe('policy.0');
  await expect(store.listPolicies(collectionOwner, 0)).rejects.toThrow('limit');
  await expect(store.listDecisions(undefined, undefined, NaN)).rejects.toThrow('limit');
}

export async function projectionCollectionContract(outbox: import('../../src/collaboration-projection.js').ProjectionOutbox) {
  const { vi } = await import('vitest');
  const { ProjectionOutcomeUnknown } = await import('../../src/collaboration-projection.js');
  const rows: import('../../src/collaboration-projection.js').ProjectionEvent[] = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    for (let index = 0; index < 6; index++) {
      vi.setSystemTime(date(index + 1));
      rows.push(await outbox.enqueue({ channel: 'test', destination: 'local', aggregateType: 'run', aggregateId: `run.${index}`, payload: { title: 'Original' }, idempotencyKey: `projection.${index}`, ...(otherScopes[index - 4] ?? collectionOwner) }));
    }
    vi.setSystemTime(date(10));
    await outbox.deliver(rows[0]!.id, { deliver: async () => ({ externalId: 'sent' }) }, collectionOwner);
    await expect(outbox.deliver(rows[1]!.id, { deliver: async () => { throw new ProjectionOutcomeUnknown('Check provider'); } }, collectionOwner)).rejects.toThrow();
    await expect(outbox.deliver(rows[2]!.id, { deliver: async () => { throw new Error('Retryable'); } }, collectionOwner)).rejects.toThrow();
  } finally { vi.useRealTimers(); }
  expect((await outbox.list('pending', collectionOwner, 1)).map(item => item.id)).toEqual([rows[3]!.id]);
  expect(await outbox.list(undefined, collectionOwner)).toHaveLength(4);
  const recent = await outbox.list(undefined, collectionOwner, 2);
  expect(recent).toHaveLength(2);
  expect(recent.every(item => item.updatedAt === date(10))).toBe(true);
  (recent[0]!.payload as { title: string }).title = 'Caller mutation';
  expect((await outbox.get(recent[0]!.id)).payload).toEqual({ title: 'Original' });
  await expect(outbox.list(undefined, collectionOwner, 0)).rejects.toThrow('limit');
  const sent: string[] = [];
  const sink = { deliver: async (event: { id: string }) => { sent.push(event.id); return {}; } };
  // Oldest actionable first, excluding delivered, unknown and foreign records.
  expect((await outbox.deliverPending(sink, 1, collectionOwner)).delivered).toBe(1);
  expect(sent).toEqual([rows[2]!.id]);
  expect((await outbox.deliverPending(sink, 1, collectionOwner)).delivered).toBe(1);
  expect(sent).toEqual([rows[2]!.id, rows[3]!.id]);
  expect((await outbox.get(rows[1]!.id)).status).toBe('unknown');
  expect((await outbox.get(rows[4]!.id)).status).toBe('pending');
  await expect(outbox.deliverPending(sink, NaN, collectionOwner)).rejects.toThrow('limit');
}
