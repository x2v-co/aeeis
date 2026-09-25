import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { InMemorySessionEventRepository, JsonSessionEventRepository, SessionEventConflict, SessionEventService, type SessionEventDraft } from '../src/session-events.js';
import { createContextAudienceSnapshot } from '../src/context-audience.js';
import { digestProtocol } from '../src/protocol.js';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { FileProjectionOutbox } from '../src/collaboration-projection.js';

describe('Shared Session canonical events', () => {
  it('recovers the append-only JSON event store after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-session-json-'));
    const snapshot = createContextAudienceSnapshot({ schemaVersion: 'context-audience/1', capturedAt: '2026-09-22T00:00:00.000Z', participants: [{ principalId: 'alice', tenantId: 'team-a', audience: JSON.stringify(['team-a', 'alice']), authority: 'goal-owner', role: 'owner' }] });
    const draft: SessionEventDraft = { roomId: 'room.json', goalId: 'goal.json', owner: 'alice', tenantId: 'team-a', type: 'canonical_response', actorId: 'alice', actorType: 'principal', contextManifestId: 'ctx.json', contextManifestHash: 'a'.repeat(64), audienceSnapshot: snapshot, content: 'Persisted', contentHash: digestProtocol({ content: 'Persisted' }), evidenceRefs: [], idempotencyKey: 'json-1', createdAt: '2026-09-22T00:00:00.000Z' };
    const first = new JsonSessionEventRepository(join(directory, 'events.json')); await first.init();
    const created = await first.append(draft); await first.close();
    const second = new JsonSessionEventRepository(join(directory, 'events.json')); await second.init();
    try { await expect(second.get(created.id, { tenantId: 'team-a' })).resolves.toEqual(created); } finally { await second.close(); }
  });

  it('binds events to one manifest and audience snapshot, supports idempotency, and hides them after membership changes', async () => {
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(new InMemoryStore(), [], memberships);
    const room = await domain.createRoom({ title: 'Release session' }, '2026-09-22T00:00:00.000Z', 'alice', 'team-a');
    const goal = await domain.createGoal({ title: 'Ship release', roomId: room.id }, '2026-09-22T00:00:01.000Z', 'alice', 'team-a');
    await domain.addRoomMember(room.id, 'bob', 'editor', 'alice', 'team-a', '2026-09-22T00:00:02.000Z');
    await domain.addRoomMember(room.id, 'carol', 'viewer', 'alice', 'team-a', '2026-09-22T00:00:03.000Z');
    const manifest = await domain.createContextManifest(goal.id, { purpose: 'shared release decision', audienceMode: 'room' }, '2026-09-22T00:00:04.000Z', 'alice', 'team-a');
    const events = new SessionEventService(new InMemorySessionEventRepository(), domain);
    const canonical = await events.create(room.id, { goalId: goal.id, type: 'canonical_response', content: 'Release after the final review.', contextManifestId: manifest.id, evidenceRefs: [], idempotencyKey: 'release-1' }, 'alice', 'team-a');
    expect(canonical).toMatchObject({ schemaVersion: 'session-event/1', owner: 'alice', actorId: 'alice', type: 'canonical_response', classification: 'internal', audienceSnapshot: { digest: manifest.audienceSnapshot?.digest } });
    await expect(events.create(room.id, { goalId: goal.id, type: 'canonical_response', content: 'Release after the final review.', contextManifestId: manifest.id, evidenceRefs: [], idempotencyKey: 'release-1' }, 'alice', 'team-a')).resolves.toEqual(canonical);
    await expect(events.create(room.id, { goalId: goal.id, type: 'canonical_response', content: 'Different response.', contextManifestId: manifest.id, evidenceRefs: [], idempotencyKey: 'release-1' }, 'alice', 'team-a')).rejects.toBeInstanceOf(SessionEventConflict);
    const memberMessage = await events.create(room.id, { goalId: goal.id, type: 'message', content: 'Bob agrees.', contextManifestId: manifest.id, idempotencyKey: 'release-2' }, 'bob', 'team-a');
    expect(memberMessage.owner).toBe('alice');
    expect((await events.page(room.id, 'bob', 'team-a')).items.map(item => item.id)).toEqual([canonical.id, memberMessage.id]);
    await domain.addRoomMember(room.id, 'dave', 'viewer', 'alice', 'team-a', '2026-09-22T00:00:05.000Z');
    expect((await events.page(room.id, 'dave', 'team-a')).items).toEqual([]);
    await domain.revokeRoomMember(room.id, 'bob', 'alice', 'team-a', '2026-09-22T00:00:06.000Z');
    await expect(events.page(room.id, 'bob', 'team-a')).rejects.toThrow('Unknown room');
  });

  it('rejects a viewer from publishing a canonical event', async () => {
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(new InMemoryStore(), [], memberships);
    const room = await domain.createRoom({ title: 'Viewer session' }, undefined, 'alice', 'team-a');
    const goal = await domain.createGoal({ title: 'Goal', roomId: room.id }, undefined, 'alice', 'team-a');
    await domain.addRoomMember(room.id, 'carol', 'viewer', 'alice', 'team-a');
    const manifest = await domain.createContextManifest(goal.id, { purpose: 'shared', audienceMode: 'room' }, undefined, 'alice', 'team-a');
    const events = new SessionEventService(new InMemorySessionEventRepository(), domain);
    await expect(events.create(room.id, { goalId: goal.id, type: 'canonical_response', content: 'Should fail.', contextManifestId: manifest.id, idempotencyKey: 'viewer-1' }, 'carol', 'team-a')).rejects.toThrow('writer role');
  });

  it('keeps canonical response revisions and retractions append-only', async () => {
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(new InMemoryStore(), [], memberships);
    const room = await domain.createRoom({ title: 'Revision session' }, undefined, 'alice', 'team-a');
    const goal = await domain.createGoal({ title: 'Goal', roomId: room.id }, undefined, 'alice', 'team-a');
    const manifest = await domain.createContextManifest(goal.id, { purpose: 'shared', audienceMode: 'room' }, undefined, 'alice', 'team-a');
    const events = new SessionEventService(new InMemorySessionEventRepository(), domain);
    const original = await events.create(room.id, { goalId: goal.id, type: 'canonical_response', content: 'Ship Friday.', contextManifestId: manifest.id, idempotencyKey: 'publish-1' }, 'alice', 'team-a');
    const revised = await events.revise(room.id, original.id, { content: 'Ship Monday after the security review.', idempotencyKey: 'revise-1' }, 'alice', 'team-a');
    expect(revised).toMatchObject({ operation: 'revise', targetEventId: original.id, revision: 2, type: 'canonical_response' });
    await expect(events.revise(room.id, original.id, { content: 'Ship Monday after the security review.', idempotencyKey: 'revise-1' }, 'alice', 'team-a')).resolves.toEqual(revised);
    await expect(events.revise(room.id, original.id, { content: 'Branching revision.', idempotencyKey: 'revise-branch' }, 'alice', 'team-a')).rejects.toThrow('latest canonical response');
    const retracted = await events.retract(room.id, revised.id, 'Security review found a blocking issue.', 'retract-1', 'alice', 'team-a');
    expect(retracted).toMatchObject({ operation: 'retract', targetEventId: revised.id, revision: 2, retractionReason: 'Security review found a blocking issue.' });
    await expect(events.retract(room.id, revised.id, 'Security review found a blocking issue.', 'retract-1', 'alice', 'team-a')).resolves.toEqual(retracted);
    await expect(events.retract(room.id, retracted.id, 'Again', 'retract-2', 'alice', 'team-a')).rejects.toThrow('cannot be retracted');
    const history = (await events.page(room.id, 'alice', 'team-a')).items;
    expect(history.map(event => event.operation)).toEqual(['publish', 'revise', 'retract']);
    expect(history[0]?.content).toBe('Ship Friday.');
    expect(history[2]?.retractionReason).toContain('blocking');
    await expect(events.revise(room.id, original.id, { content: 'idempotent branch', idempotencyKey: 'revise-branch' }, 'alice', 'team-a')).rejects.toThrow('latest canonical response');
    await expect(events.revise(room.id, revised.id, { content: 'Cannot revise after retraction.', idempotencyKey: 'revise-retracted' }, 'alice', 'team-a')).rejects.toThrow('latest canonical response');
  });

  it('serializes concurrent latest revisions and only retracts canonical responses', async () => {
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(new InMemoryStore(), [], memberships);
    const room = await domain.createRoom({ title: 'Concurrent session' }, undefined, 'alice', 'team-a');
    const goal = await domain.createGoal({ title: 'Goal', roomId: room.id }, undefined, 'alice', 'team-a');
    const manifest = await domain.createContextManifest(goal.id, { purpose: 'shared', audienceMode: 'room' }, undefined, 'alice', 'team-a');
    const events = new SessionEventService(new InMemorySessionEventRepository(), domain);
    const original = await events.create(room.id, { goalId: goal.id, type: 'canonical_response', content: 'Initial', contextManifestId: manifest.id, idempotencyKey: 'concurrent-publish' }, 'alice', 'team-a');
    const results = await Promise.allSettled([
      events.revise(room.id, original.id, { content: 'Revision A', idempotencyKey: 'concurrent-a' }, 'alice', 'team-a'),
      events.revise(room.id, original.id, { content: 'Revision B', idempotencyKey: 'concurrent-b' }, 'alice', 'team-a'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const decision = await events.create(room.id, { goalId: goal.id, type: 'decision', content: 'A decision', contextManifestId: manifest.id, idempotencyKey: 'decision-1' }, 'alice', 'team-a');
    await expect(events.retract(room.id, decision.id, 'Must remain a decision', 'decision-retract', 'alice', 'team-a')).rejects.toThrow('Only an active canonical response');
  });

  it('rejects a Goal from a different Room even when its Manifest is readable', async () => {
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(new InMemoryStore(), [], memberships);
    const firstRoom = await domain.createRoom({ title: 'First session' }, undefined, 'alice', 'team-a');
    const secondRoom = await domain.createRoom({ title: 'Second session' }, undefined, 'alice', 'team-a');
    const foreignGoal = await domain.createGoal({ title: 'Foreign goal', roomId: secondRoom.id }, undefined, 'alice', 'team-a');
    const foreignManifest = await domain.createContextManifest(foreignGoal.id, { purpose: 'foreign shared context', audienceMode: 'room' }, undefined, 'alice', 'team-a');
    const events = new SessionEventService(new InMemorySessionEventRepository(), domain);

    await expect(events.create(firstRoom.id, {
      goalId: foreignGoal.id,
      type: 'canonical_response',
      content: 'Must stay in the second Room.',
      contextManifestId: foreignManifest.id,
      idempotencyKey: 'cross-room-1',
    }, 'alice', 'team-a')).rejects.toThrow('Unknown goal for Room');
    await expect(events.page(firstRoom.id, 'alice', 'team-a')).resolves.toMatchObject({ items: [] });
  });

  it('supports one Room-scoped context across multiple Goals and keeps source ACLs', async () => {
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(new InMemoryStore(), [], memberships);
    const room = await domain.createRoom({ title: 'Multi-goal session' }, undefined, 'alice', 'team-a');
    const first = await domain.createGoal({ title: 'Release', roomId: room.id }, undefined, 'alice', 'team-a');
    await domain.addRoomMember(room.id, 'bob', 'editor', 'alice', 'team-a');
    const second = await domain.createGoal({ title: 'Migration', roomId: room.id }, undefined, 'bob', 'team-a');
    await domain.addMemory(first.id, { kind: 'decision', content: 'Release after review' }, undefined, 'alice', 'team-a');
    await domain.addMemory(second.id, { kind: 'fact', content: 'Migration has a rollback plan' }, undefined, 'bob', 'team-a');
    const firstSource = await domain.createContextManifest(first.id, { purpose: 'release source', audienceMode: 'room' }, undefined, 'alice', 'team-a');
    const secondSource = await domain.createContextManifest(second.id, { purpose: 'migration source', audienceMode: 'room' }, undefined, 'bob', 'team-a');
    const session = await domain.createSessionContextManifest(room.id, { purpose: 'release and migration decision', contexts: [{ goalId: first.id, contextManifestId: firstSource.id }, { goalId: second.id, contextManifestId: secondSource.id }] }, undefined, 'bob', 'team-a');
    expect(session).toMatchObject({ roomId: room.id, goalIds: [first.id, second.id], audienceSnapshot: { scope: 'room' } });
    expect(session.goalContextRefs).toHaveLength(2);
    expect(session.included.map(item => item.content)).toEqual(expect.arrayContaining(['Release after review', 'Migration has a rollback plan']));
    const events = new SessionEventService(new InMemorySessionEventRepository(), domain);
    const event = await events.create(room.id, { type: 'decision', content: 'Coordinate both tracks.', contextManifestId: session.id, idempotencyKey: 'multi-goal-1' }, 'bob', 'team-a');
    expect(event.goalId).toBeUndefined();
    expect((await events.page(room.id, 'bob', 'team-a')).items).toHaveLength(1);
    await expect(events.get(event.id, 'alice', 'team-a')).resolves.toEqual(event);
    await domain.addRoomMember(room.id, 'carol', 'viewer', 'alice', 'team-a');
    await expect(domain.getSessionContextManifest(room.id, session.id, 'carol', 'team-a')).rejects.toThrow('Unknown context manifest');
    expect((await events.page(room.id, 'carol', 'team-a')).items).toEqual([]);
    await domain.addRoomMember(room.id, 'bob', 'viewer', 'alice', 'team-a');
    await expect(events.get(event.id, 'bob', 'team-a')).rejects.toThrow('Unknown context manifest');
    await domain.revokeRoomMember(room.id, 'bob', 'alice', 'team-a');
    await expect(events.get(event.id, 'bob', 'team-a')).rejects.toThrow('Unknown room');
  });

  it('exposes owner-scoped creation and audience-filtered Room event reads over HTTP', async () => {
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(new InMemoryStore(), [], memberships);
    const room = await domain.createRoom({ title: 'HTTP session' }, undefined, 'alice', 'team-a');
    const goal = await domain.createGoal({ title: 'HTTP goal', roomId: room.id }, undefined, 'alice', 'team-a');
    await domain.addRoomMember(room.id, 'bob', 'viewer', 'alice', 'team-a');
    const manifest = await domain.createContextManifest(goal.id, { purpose: 'HTTP shared', audienceMode: 'room' }, undefined, 'alice', 'team-a');
    const sessionEvents = new SessionEventService(new InMemorySessionEventRepository(), domain);
    const runs = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-session-http-runs-'))); await runs.init();
    const projection = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-session-http-projection-'))); await projection.init();
    const app = buildApp({ repository: runs, domain, sessionEvents, projection, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team-a', roles: ['agent'] } } });
    try {
      const created = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/session-events`, headers: { authorization: 'Bearer alice' }, payload: { goalId: goal.id, type: 'canonical_response', content: 'HTTP canonical response', contextManifestId: manifest.id, idempotencyKey: 'http-1' } });
      expect(created.statusCode).toBe(200);
      const listed = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/session-events?limit=10`, headers: { authorization: 'Bearer bob' } });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().items).toHaveLength(1);
      expect(listed.json().items[0]).toMatchObject({ type: 'canonical_response', content: 'HTTP canonical response' });
      const eventId = listed.json().items[0].id as string;
      const projected = await app.inject({ method: 'POST', url: '/api/collaborations/projections', headers: { authorization: 'Bearer alice' }, payload: { channel: 'hermes', destination: 'room.release', aggregateType: 'session_event', aggregateId: eventId } });
      expect(projected.statusCode).toBe(200);
      expect(projected.json()).toMatchObject({ aggregateType: 'session_event', aggregateId: eventId, payload: { id: eventId, type: 'canonical_response' } });
      const revised = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/session-events/${eventId}/revise`, headers: { authorization: 'Bearer alice' }, payload: { content: 'HTTP revised response', idempotencyKey: 'http-revise-1' } });
      expect(revised.statusCode).toBe(200);
      expect(revised.json()).toMatchObject({ operation: 'revise', targetEventId: eventId, revision: 2 });
      const retracted = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/session-events/${revised.json().id}/retract`, headers: { authorization: 'Bearer alice' }, payload: { reason: 'HTTP correction', idempotencyKey: 'http-retract-1' } });
      expect(retracted.statusCode).toBe(200);
      expect(retracted.json()).toMatchObject({ operation: 'retract', targetEventId: revised.json().id, retractionReason: 'HTTP correction' });
      const contextPayload = { purpose: 'Session decision', contexts: [{ goalId: goal.id, contextManifestId: manifest.id }] };
      const sessionContext = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/context-manifests`, headers: { authorization: 'Bearer alice' }, payload: contextPayload });
      expect(sessionContext.statusCode).toBe(200);
      const sessionManifestId = sessionContext.json().id as string;
      expect((await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/context-manifests/${sessionManifestId}`, headers: { authorization: 'Bearer bob' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/context-manifests`, headers: { authorization: 'Bearer bob' }, payload: contextPayload })).statusCode).toBe(409);
      const sessionEvent = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/session-events`, headers: { authorization: 'Bearer alice' }, payload: { type: 'decision', content: 'Session-wide decision', contextManifestId: sessionManifestId, idempotencyKey: 'http-session-1' } });
      expect(sessionEvent.statusCode).toBe(200);
      expect(sessionEvent.json().goalId).toBeUndefined();
      const projectionResult = await app.inject({ method: 'POST', url: '/api/collaborations/projections', headers: { authorization: 'Bearer alice' }, payload: { channel: 'hermes', destination: 'room.release', aggregateType: 'session_event', aggregateId: sessionEvent.json().id } });
      expect(projectionResult.statusCode).toBe(200);
      expect(projectionResult.json().payload.contextManifestId).toBe(sessionManifestId);
    } finally { await app.close(); await projection.close(); await runs.close(); }
  });
});
