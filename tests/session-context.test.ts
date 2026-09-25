import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { JsonFileStore } from '../src/adapters/json-store.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { InMemorySessionEventRepository, JsonSessionEventRepository, SessionEventService } from '../src/session-events.js';
import { digestProtocol } from '../src/protocol.js';
import { principalAudience } from '../src/security/principal.js';

async function fixture() {
  const store = new InMemoryStore();
  const memberships = new InMemoryRoomMembershipRepository();
  const domain = new AeeisService(store, [], memberships);
  const room = await domain.createRoom({ title: 'Shared' }, undefined, 'alice', 'team');
  await domain.addRoomMember(room.id, 'bob', 'editor', 'alice', 'team');
  const goal = await domain.createGoal({ title: 'Release', roomId: room.id }, undefined, 'alice', 'team');
  await domain.addMemory(goal.id, { kind: 'fact', content: 'Approved release window' }, undefined, 'alice', 'team');
  const source = await domain.createContextManifest(goal.id, { purpose: 'Share release context', audienceMode: 'room' }, undefined, 'alice', 'team');
  const input = { purpose: 'Coordinate', contexts: [{ goalId: goal.id, contextManifestId: source.id }] };
  const repository = new InMemorySessionEventRepository();
  return { store, domain, room, goal, source, input, repository, events: new SessionEventService(repository, domain) };
}

describe('Room context authorization and persistence', () => {
  it('rejects audience expansion, other Rooms, tenants, and viewer creation', async () => {
    const { domain, room, goal, input } = await fixture();
    const privateSource = await domain.createContextManifest(goal.id, { purpose: 'Owner only' }, undefined, 'alice', 'team');
    await expect(domain.createSessionContextManifest(room.id, { ...input, contexts: [{ goalId: goal.id, contextManifestId: privateSource.id }] }, undefined, 'alice', 'team')).rejects.toThrow('Unknown context manifest');
    const otherRoom = await domain.createRoom({ title: 'Other' }, undefined, 'alice', 'team');
    await expect(domain.createSessionContextManifest(otherRoom.id, input, undefined, 'alice', 'team')).rejects.toThrow('target Room');
    await expect(domain.createSessionContextManifest(room.id, input, undefined, 'alice', 'other-tenant')).rejects.toThrow('Unknown room');
    await domain.addRoomMember(room.id, 'carol', 'viewer', 'alice', 'team');
    await expect(domain.createSessionContextManifest(room.id, input, undefined, 'carol', 'team')).rejects.toThrow('editor role');
    // New members cannot be included using an older source context.
    await expect(domain.createSessionContextManifest(room.id, input, undefined, 'alice', 'team')).rejects.toThrow('Unknown context manifest');
    const restricted = await domain.createSessionContextManifest(room.id, { ...input, audience: [principalAudience({ id: 'alice', tenantId: 'team' }), principalAudience({ id: 'bob', tenantId: 'team' })] }, undefined, 'bob', 'team');
    expect(restricted.audience).toHaveLength(2);
  });

  it('freezes source content and rejects changed content or Goal placement on read', async () => {
    const { store, domain, room, goal, source, input, events } = await fixture();
    const manifest = await domain.createSessionContextManifest(room.id, input, undefined, 'alice', 'team');
    const event = await events.create(room.id, { type: 'decision', content: 'Proceed', contextManifestId: manifest.id, idempotencyKey: 'decision' }, 'alice', 'team');
    await store.saveContextManifest({ ...source, included: source.included.map(item => ({ ...item, content: 'Changed after freezing' })) });
    await expect(events.get(event.id, 'alice', 'team')).rejects.toThrow('changed');
    expect((await events.page(room.id, 'bob', 'team')).items).toEqual([]);
    await store.saveContextManifest(source);
    const otherRoom = await domain.createRoom({ title: 'Other' }, undefined, 'alice', 'team');
    await store.saveGoal({ ...goal, roomId: otherRoom.id });
    await expect(events.get(event.id, 'alice', 'team')).rejects.toThrow('no longer');
  });

  it('keeps legacy Goal event hashes readable and hides old cross-Room events', async () => {
    const { domain, room, goal, source, repository, events } = await fixture();
    const contextManifestHash = digestProtocol({ id: source.id, goalId: source.goalId, owner: source.owner, tenantId: source.tenantId, purpose: source.purpose, audience: source.audience, audienceSnapshot: source.audienceSnapshot, memoryRefs: source.memoryRefs, knowledgeRefs: source.knowledgeRefs ?? [], createdAt: source.createdAt });
    const draft = { roomId: room.id, goalId: goal.id, owner: 'alice', tenantId: 'team', type: 'decision' as const, actorId: 'alice', actorType: 'principal' as const, contextManifestId: source.id, contextManifestHash, audienceSnapshot: source.audienceSnapshot!, content: 'Legacy decision', evidenceRefs: [], idempotencyKey: 'legacy', createdAt: source.createdAt };
    const contentHash = digestProtocol({ type: draft.type, content: draft.content, evidenceRefs: [], contextManifestId: source.id, contextManifestHash, audienceDigest: source.audienceSnapshot!.digest });
    const legacy = await repository.append({ ...draft, contentHash });
    await expect(events.get(legacy.id, 'bob', 'team')).resolves.toEqual(legacy);
    await expect(events.create(room.id, draft, 'alice', 'team')).resolves.toEqual(legacy);
    const otherRoom = await domain.createRoom({ title: 'Wrong Room' }, undefined, 'alice', 'team');
    const misplaced = await repository.append({ ...draft, contentHash, roomId: otherRoom.id });
    await expect(events.get(misplaced.id, 'alice', 'team')).rejects.toThrow('Unknown goal for Room');
    expect((await events.page(otherRoom.id, 'alice', 'team')).items).toEqual([]);
  });

  it('recovers a Room context and its event from durable files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-session-context-'));
    const file = join(directory, 'domain.json');
    const eventsFile = join(directory, 'events.json');
    const store = new JsonFileStore(file); await store.init();
    const repository = new JsonSessionEventRepository(eventsFile); await repository.init();
    try {
      const domain = new AeeisService(store);
      const room = await domain.createRoom({ title: 'Release' });
      const goal = await domain.createGoal({ title: 'Release', roomId: room.id });
      const source = await domain.createContextManifest(goal.id, { purpose: 'Source' });
      const manifest = await domain.createSessionContextManifest(room.id, { purpose: 'Session', contexts: [{ goalId: goal.id, contextManifestId: source.id }] });
      const event = await new SessionEventService(repository, domain).create(room.id, { type: 'decision', content: 'Proceed', contextManifestId: manifest.id, idempotencyKey: 'persistent' }, 'owner', 'local');
      await repository.close(); await store.close();
      const restoredStore = new JsonFileStore(file); await restoredStore.init();
      const restoredEvents = new JsonSessionEventRepository(eventsFile); await restoredEvents.init();
      try {
        const restoredDomain = new AeeisService(restoredStore);
        await expect(restoredDomain.getSessionContextManifest(room.id, manifest.id)).resolves.toEqual(manifest);
        await expect(new SessionEventService(restoredEvents, restoredDomain).get(event.id, 'owner', 'local')).resolves.toEqual(event);
      } finally { await restoredEvents.close(); await restoredStore.close(); }
    } finally { await repository.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
