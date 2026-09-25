import { FileProjectionOutbox } from '../src/collaboration-projection.js';
import { FileCollaborationTriggerStore } from '../src/collaboration-triggers.js';
import { AgentDirectory } from '../src/agent-gateway.js';
import { InMemoryRoomMembershipRepository, JsonRoomMembershipRepository } from '../src/room-membership.js';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRunRepository } from '../src/runtime/repository.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { JsonFileStore } from '../src/adapters/json-store.js';
import { FileCollaborationRepository } from '../src/collaboration-service.js';
import { FileEvolutionRepository } from '../src/rsi.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { collectionOwner, runCollectionContract, goalCollectionContract, collaborationCollectionContract, evolutionCollectionContract, roomCollectionContract, registryCollectionContract, triggerCollectionContract, projectionCollectionContract } from './support/collection-contract.js';

describe('bounded collection storage', () => {
  it('bounds cached triggers and outbox without truncating delivery work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-collection-triggers-'));
    const store = new FileCollaborationTriggerStore(join(directory, 'triggers'));
    const outbox = new FileProjectionOutbox(join(directory, 'outbox'));
    await store.init(); await outbox.init();
    try {
      await triggerCollectionContract(store);
      await projectionCollectionContract(outbox);
      const policies = await store.listPolicies(collectionOwner, 2);
      const events = await outbox.list(undefined, collectionOwner, 2);
      await store.close(); await outbox.close();
      await store.init(); await outbox.init();
      expect(await store.listPolicies(collectionOwner, 2)).toEqual(policies);
      expect(await outbox.list(undefined, collectionOwner, 2)).toEqual(events);
    } finally { await store.close(); await outbox.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('limits Room reads after membership filtering in memory and JSON stores', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-collection-rooms-'));
    const store = new JsonFileStore(join(directory, 'domain.json'));
    const memberships = new JsonRoomMembershipRepository(join(directory, 'members.json'));
    await store.init(); await memberships.init();
    try {
      await roomCollectionContract(new InMemoryStore(), new InMemoryRoomMembershipRepository());
      await roomCollectionContract(store, memberships);
    } finally { await store.close(); await memberships.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('limits registry cards before copying their reputation histories', async () => {
    const directory = new AgentDirectory();
    await registryCollectionContract(directory);
    const reputation = vi.spyOn(directory, 'reputationSnapshot');
    directory.entriesSnapshot(1);
    expect(reputation).toHaveBeenCalledTimes(1);
  });

  it('rebuilds logical Run ordering after restart and reads only the selected files once warm', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-collection-runs-'));
    const repo = new FileRunRepository(directory);
    await repo.init();
    try {
      const newestId = await runCollectionContract(repo);
      const get = vi.spyOn(repo, 'get');
      await repo.list(collectionOwner, 2);
      expect(get).toHaveBeenCalledTimes(2);
      get.mockRestore();
      await repo.close();
      // Backup restoration can make an old record the newest filesystem entry.
      await utimes(join(directory, 'run_00000000-0000-4000-8000-000000000003.json'), new Date('2099-01-01'), new Date('2099-01-01'));
      await repo.init();
      expect((await repo.list(collectionOwner, 1))[0]?.id).toBe(newestId);
      const readAfterRebuild = vi.spyOn(repo, 'get');
      await repo.list(collectionOwner, 1);
      expect(readAfterRebuild).toHaveBeenCalledTimes(1);
    } finally { await repo.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('uses the durable Run metadata index on a clean restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-collection-runs-index-'));
    const repo = new FileRunRepository(directory);
    await repo.init();
    try {
      await runCollectionContract(repo);
      await repo.list(collectionOwner, 1); // publish the index while warm
      await repo.close();
      await repo.init();
      const get = vi.spyOn(repo, 'get');
      await repo.list(collectionOwner, 1);
      // A valid index avoids parsing every canonical aggregate during cold
      // start; only the requested page is loaded.
      expect(get).toHaveBeenCalledTimes(1);
    } finally { await repo.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('pages Room-visible Runs from the bounded metadata view', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-collection-shared-runs-'));
    const repo = new FileRunRepository(directory); await repo.init();
    try {
      const seedId = await runCollectionContract(repo);
      const seed = await repo.get(seedId, collectionOwner);
      const sharedGoalId = 'goal_shared';
      await repo.create({ ...seed, id: 'run_00000000-0000-4000-8000-000000000010', owner: 'bob', tenantId: 'team-a', goalId: sharedGoalId, privacy: 'internal', updatedAt: '2020-01-09T00:00:00.000Z' });
      await repo.create({ ...seed, id: 'run_00000000-0000-4000-8000-000000000011', owner: 'bob', tenantId: 'team-a', goalId: sharedGoalId, privacy: 'confidential', updatedAt: '2020-01-08T00:00:00.000Z' });
      await repo.create({ ...seed, id: 'run_00000000-0000-4000-8000-000000000012', owner: 'bob', tenantId: 'team-a', goalId: sharedGoalId, privacy: 'internal', updatedAt: '2020-01-07T00:00:00.000Z' });
      await repo.create({ ...seed, id: 'run_00000000-0000-4000-8000-000000000013', owner: 'bob', tenantId: 'team-a', goalId: 'other_goal', privacy: 'internal', updatedAt: '2020-01-06T00:00:00.000Z' });
      const first = await repo.pageVisible({ owner: 'carol', tenantId: 'team-a' }, [sharedGoalId], 1);
      expect(first.runs.map(run => run.id)).toEqual(['run_00000000-0000-4000-8000-000000000010']);
      expect(first.nextCursor).toBeDefined();
      const second = await repo.pageVisible({ owner: 'carol', tenantId: 'team-a' }, [sharedGoalId], 1, first.nextCursor);
      expect(second.runs.map(run => run.id)).toEqual(['run_00000000-0000-4000-8000-000000000012']);
      expect(second.nextCursor).toBeUndefined();
    } finally { await repo.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('falls back to canonical Runs when the disposable index is corrupt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-collection-runs-index-corrupt-'));
    const repo = new FileRunRepository(directory);
    await repo.init();
    try {
      await runCollectionContract(repo);
      await repo.close();
      await writeFile(join(directory, '.runs.index.json'), '{not-json');
      await repo.init();
      expect((await repo.list(collectionOwner, 1)).length).toBe(1);
    } finally { await repo.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('bounds Goal snapshots in the memory and JSON stores after scope filtering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-collection-goals-'));
    const file = new JsonFileStore(join(directory, 'domain.json'));
    await file.init();
    try {
      await goalCollectionContract(new InMemoryStore());
      await goalCollectionContract(file);
      await file.close(); await file.init();
      expect(await file.getGoals(collectionOwner, 2)).toHaveLength(2);
    } finally { await file.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('bounds Goal memory reads after ordering by durable update time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-collection-memories-'));
    const file = new JsonFileStore(join(directory, 'domain.json'));
    await file.init();
    try {
      for (const store of [new InMemoryStore(), file]) {
        const service = new AeeisService(store);
        const goal = await service.createGoal({ title: 'bounded memory' }, '2026-01-01T00:00:00.000Z');
        await service.addMemory(goal.id, { kind: 'note', content: 'older' }, '2026-01-01T00:00:01.000Z');
        await service.addMemory(goal.id, { kind: 'note', content: 'newer' }, '2026-01-01T00:00:02.000Z');
        expect((await store.getMemories(goal.id, 1)).map(memory => memory.content)).toEqual(['newer']);
      }
    } finally { await file.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('bounds cached collaboration snapshots, isolates caller changes and survives reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-collection-collab-'));
    const repo = new FileCollaborationRepository(directory);
    await repo.init();
    try {
      await collaborationCollectionContract(repo);
      const before = await repo.listCompetitions(collectionOwner, 2);
      await repo.close(); await repo.init();
      expect(await repo.listCompetitions(collectionOwner, 2)).toEqual(before);
    } finally { await repo.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps collaboration records independently readable after legacy migration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-collection-collab-records-'));
    const repo = new FileCollaborationRepository(directory);
    await repo.init();
    try {
      await collaborationCollectionContract(repo);
      await repo.close();
      const entries = await readdir(directory);
      expect(entries).toContain('collaboration.index.json');
      expect(entries).toContain('competitions');
      expect(entries).toContain('debates');
      // A clean restart reads the record index and canonical per-record files;
      // the old aggregate is retained only as a migration/backup artifact.
      await writeFile(join(directory, 'collaborations.json'), '{legacy aggregate no longer required');
      await repo.init();
      expect(await repo.listCompetitions(collectionOwner, 1)).toHaveLength(1);
      expect(await repo.listDebates(collectionOwner, 1)).toHaveLength(1);
    } finally { await repo.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('migrates the old collaboration aggregate into record files once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-collection-collab-legacy-'));
    const now = new Date().toISOString();
    await writeFile(join(directory, 'collaborations.json'), JSON.stringify({ competitions: [{
      schemaVersion: 1, id: 'competition_legacy', owner: 'alice', tenantId: 'team-a',
      brief: { schemaVersion: 'competition-brief/1', taskId: 'task.legacy', contextVersion: 'ctx.legacy', goal: 'Legacy', participantAgentIds: ['agent.one', 'agent.two'], expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: false },
      status: 'collecting', candidates: [], scores: [], attempts: [], totalCost: 0, createdAt: now, updatedAt: now,
    }], debates: [] }));
    const repo = new FileCollaborationRepository(directory);
    await repo.init();
    try {
      expect((await repo.listCompetitions(collectionOwner, 1))[0]?.id).toBe('competition_legacy');
      expect(await readdir(join(directory, 'competitions'))).toContain('competition_legacy.json');
      expect(await readdir(directory)).toContain('collaboration.index.json');
    } finally { await repo.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('orders and bounds RSI candidates by durable change time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-collection-evolution-'));
    const repository = new FileEvolutionRepository(directory);
    await repository.init();
    try {
      const { newestId, seed } = await evolutionCollectionContract(repository);
      const get = vi.spyOn(repository, 'get');
      await repository.list(collectionOwner, 2);
      expect(get).toHaveBeenCalledTimes(2);
      get.mockRestore();
      await repository.close();
      const legacy = { ...seed, id: 'evo_ffffffff-ffff-4fff-8fff-ffffffffffff', ...collectionOwner, createdAt: '2000-01-01T00:00:00.000Z' };
      delete legacy.updatedAt;
      // A legacy record and restored filesystem timestamps must not outrank
      // a candidate actually changed more recently.
      await writeFile(join(directory, `${legacy.id}.json`), JSON.stringify(legacy));
      await utimes(join(directory, `${legacy.id}.json`), new Date('2099-01-01'), new Date('2099-01-01'));
      await repository.init();
      expect((await repository.list(collectionOwner, 1))[0]?.id).toBe(newestId);
      expect((await repository.list(collectionOwner)).at(-1)?.id).toBe(legacy.id);
      const warmGet = vi.spyOn(repository, 'get');
      await repository.list(collectionOwner, 1);
      expect(warmGet).toHaveBeenCalledTimes(1);
    } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
