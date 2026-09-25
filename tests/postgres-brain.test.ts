import { describe, expect, it } from 'vitest';
import { BrainConflict } from '../src/brain.js';
import { PostgresBrainStore } from '../src/adapters/postgres-brain-store.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres Brain store', () => {
  it.skipIf(!databaseUrl)('persists claims and audit state across store instances', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresBrainStore(db.url);
    await first.init();
    try {
      const brain = await first.load();
      const claim = brain.addClaim({ owner: 'owner', tenantId: 'local', scope: 'project', scopeRef: 'p1', classification: 'internal', kind: 'decision', content: 'Use PostgreSQL for Brain durability', sourceRefs: ['design'], confidence: 1 }, 'owner');
      await first.save(brain);
      expect(claim.id).toMatch(/^brain_/);
    } finally { await first.close(); }

    const second = new PostgresBrainStore(db.url);
    await second.init();
    try {
      const restored = await second.load();
      expect(restored.read('p1', 'owner', 'internal')).toHaveLength(1);
      expect(restored.auditLog().some(entry => entry.action === 'write')).toBe(true);
    } finally { await second.close(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('rejects stale saves instead of losing concurrent Brain changes', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresBrainStore(db.url), second = new PostgresBrainStore(db.url);
    await first.init(); await second.init();
    try {
      const initial = await first.load();
      await first.save(initial);
      const left = await first.load();
      const right = await second.load();
      left.addClaim({ owner: 'owner', tenantId: 'local', scope: 'project', scopeRef: 'p2', classification: 'internal', kind: 'fact', content: 'First writer', sourceRefs: ['left'], confidence: 1 }, 'owner');
      await first.save(left);
      right.addClaim({ owner: 'owner', tenantId: 'local', scope: 'project', scopeRef: 'p2', classification: 'internal', kind: 'fact', content: 'Stale writer', sourceRefs: ['right'], confidence: 1 }, 'owner');
      await expect(second.save(right)).rejects.toBeInstanceOf(BrainConflict);
      const check = await first.load();
      expect(check.read('p2', 'owner', 'internal').map(claim => claim.content)).toEqual(['First writer']);
    } finally { await first.close(); await second.close(); await db.close(); }
  });
});
