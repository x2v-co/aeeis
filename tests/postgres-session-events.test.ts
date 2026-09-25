import { describe, expect, it } from 'vitest';
import { digestProtocol } from '../src/protocol.js';
import { createContextAudienceSnapshot } from '../src/context-audience.js';
import { PostgresSessionEventRepository, type SessionEventDraft } from '../src/session-events.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres Shared Session event repository', () => {
  it.skipIf(!databaseUrl)('allocates durable sequence numbers and preserves idempotency across restart', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresSessionEventRepository(db.url); await first.init();
    const audienceSnapshot = createContextAudienceSnapshot({ schemaVersion: 'context-audience/1', capturedAt: '2026-09-22T00:00:00.000Z', participants: [{ principalId: 'alice', tenantId: 'team-a', audience: JSON.stringify(['team-a', 'alice']), authority: 'goal-owner', role: 'owner' }] });
    const draft: SessionEventDraft = {
      roomId: 'room.release', goalId: 'goal.release', owner: 'alice', tenantId: 'team-a', type: 'canonical_response', actorId: 'alice', actorType: 'principal', contextManifestId: 'ctx.release', contextManifestHash: 'a'.repeat(64), audienceSnapshot, content: 'Release', contentHash: digestProtocol({ content: 'Release' }), evidenceRefs: [], idempotencyKey: 'release-1', createdAt: '2026-09-22T00:00:01.000Z',
    };
    const created = await first.append(draft);
    await expect(first.append(draft)).resolves.toEqual(created);
    await first.close();
    const second = new PostgresSessionEventRepository(db.url); await second.init();
    try {
      await expect(second.get(created.id, { tenantId: 'team-a' })).resolves.toEqual(created);
      await expect(second.page('room.release', { tenantId: 'team-a' }, 10)).resolves.toMatchObject({ items: [expect.objectContaining({ sequence: 1, id: created.id })] });
    } finally { await second.close(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('serializes concurrent linear revisions and replays the winning idempotency key', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresSessionEventRepository(db.url); await first.init();
    const audienceSnapshot = createContextAudienceSnapshot({ schemaVersion: 'context-audience/1', capturedAt: '2026-09-22T00:00:00.000Z', participants: [{ principalId: 'alice', tenantId: 'team-a', audience: JSON.stringify(['team-a', 'alice']), authority: 'goal-owner', role: 'owner' }] });
    const base: SessionEventDraft = {
      roomId: 'room.concurrent', goalId: 'goal.concurrent', owner: 'alice', tenantId: 'team-a', type: 'canonical_response', actorId: 'alice', actorType: 'principal', contextManifestId: 'ctx.concurrent', contextManifestHash: 'b'.repeat(64), audienceSnapshot, content: 'Initial', contentHash: digestProtocol({ content: 'Initial' }), evidenceRefs: [], idempotencyKey: 'concurrent-publish', createdAt: '2026-09-22T00:00:01.000Z',
    };
    const original = await first.append(base);
    const makeRevision = (key: string, content: string): SessionEventDraft => ({ ...base, idempotencyKey: key, operation: 'revise', targetEventId: original.id, revision: 2, content, contentHash: digestProtocol({ content, targetEventId: original.id, revision: 2 }), createdAt: '2026-09-22T00:00:02.000Z' });
    const results = await Promise.allSettled([
      first.appendLinear(makeRevision('concurrent-a', 'Revision A'), original.id, 1),
      first.appendLinear(makeRevision('concurrent-b', 'Revision B'), original.id, 1),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const winner = results.find(result => result.status === 'fulfilled')!;
    if (winner.status !== 'fulfilled') throw new Error('Expected a winning revision');
    await expect(first.appendLinear(makeRevision(winner.value.idempotencyKey, winner.value.content), original.id, 1)).resolves.toEqual(winner.value);
    await first.close(); await db.close();
  });
});
