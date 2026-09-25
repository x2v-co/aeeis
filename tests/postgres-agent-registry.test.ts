import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresAgentDirectory } from '../src/adapters/postgres-agent-registry.js';
import type { AgentCard } from '../src/protocol.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const card: AgentCard = {
  schemaVersion: 'agent-card/1', agentId: 'agent.pg', name: 'Postgres Agent', owner: 'partner',
  protocols: ['aeeis-task/1'], capabilities: ['research'], inputSchemas: ['task-brief/1'], outputSchemas: ['result-envelope/1'],
  auth: ['local'], privacy: { dataRetention: 'none', regions: ['local'] }, pricing: { unit: 'run' }, cardVersion: '1',
};

describe('Postgres Agent Registry', () => {
  it.skipIf(!databaseUrl)('persists lifecycle, audit and reputation across restart', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresAgentDirectory(db.url); await first.init();
    try {
      await first.discover(card, '2026-09-19T00:00:00.000Z', 'ops');
      await expect(first.get(card.agentId)).rejects.toThrow('not admitted');
      await first.admit(card.agentId, '2026-09-19T00:00:01.000Z', 'ops');
      await first.recordReputation(card.agentId, { source: 'operator', outcome: 'completed', evidenceRefs: ['receipt.pg'], dimensions: { quality: 1, evidence: 0.8 } }, 'ops', '2026-09-19T00:00:02.000Z');
      expect(await first.get(card.agentId)).toEqual(card);
    } finally { await first.close(); }

    const second = new PostgresAgentDirectory(db.url); await second.init();
    try {
      expect((await second.entriesSnapshot())[0]).toMatchObject({ agentId: card.agentId, status: 'admitted', reputation: { samples: 1, dimensions: { quality: 1, evidence: 0.8 } } });
      expect((await second.auditSnapshot(card.agentId)).map(event => event.action)).toEqual(['discovered', 'admitted']);
      await second.revoke(card.agentId, '2026-09-19T00:00:03.000Z', 'ops');
      await expect(second.discover(card)).rejects.toThrow('explicit re-admission');
    } finally { await second.close(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('serializes concurrent reputation writes without losing samples', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const left = new PostgresAgentDirectory(db.url), right = new PostgresAgentDirectory(db.url);
    await left.init(); await right.init();
    try {
      await left.register(card);
      await Promise.all([
        left.recordReputation(card.agentId, { source: 'operator', outcome: 'completed', evidenceRefs: ['receipt.left'], dimensions: { quality: 1 } }, 'left'),
        right.recordReputation(card.agentId, { source: 'operator', outcome: 'partial', evidenceRefs: ['receipt.right'], dimensions: { quality: 0 } }, 'right'),
      ]);
      const restored = new PostgresAgentDirectory(db.url); await restored.init();
      try {
        const reputation = await restored.reputationSnapshot(card.agentId);
        expect(reputation.samples).toBe(2);
        expect(reputation.observations).toHaveLength(2);
        expect(reputation.dimensions.quality).toBe(0.5);
      } finally { await restored.close(); }
    } finally { await left.close(); await right.close(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('migrates the legacy single-row JSONB registry into normalized tables', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const inspection = new pg.Pool({ connectionString: db.url });
    try {
      await inspection.query(`CREATE TABLE aeeis_agent_registry (id smallint PRIMARY KEY CHECK (id = 1), revision bigint NOT NULL, state jsonb NOT NULL, updated_at timestamptz NOT NULL)`);
      const legacy = {
        entries: [{ agentId: card.agentId, card, status: 'admitted', discoveredAt: '2026-09-19T00:00:00.000Z', admittedAt: '2026-09-19T00:00:01.000Z' }],
        audit: [{ id: 'agent_audit_legacy', agentId: card.agentId, action: 'registered', actor: 'legacy', cardVersion: '1', status: 'admitted', at: '2026-09-19T00:00:01.000Z' }],
        reputation: { [card.agentId]: { agentId: card.agentId, samples: 1, dimensions: { identity: 0.5, quality: 1, evidence: 0.5, safety: 0.5, latency: 0.5, cost: 0.5, privacy: 0.5, revocation: 0.5 }, observations: [], updatedAt: '2026-09-19T00:00:02.000Z' } },
      };
      await inspection.query('INSERT INTO aeeis_agent_registry(id,revision,state,updated_at) VALUES(1,4,$1,$2)', [legacy, '2026-09-19T00:00:02.000Z']);
      const directory = new PostgresAgentDirectory(db.url); await directory.init();
      try {
        expect(await directory.get(card.agentId)).toEqual(card);
        expect((await directory.auditSnapshot(card.agentId)).map(event => event.id)).toEqual(['agent_audit_legacy']);
        expect((await directory.reputationSnapshot(card.agentId)).samples).toBe(1);
        const tables = await inspection.query<{ entries: string; audit: string; reputations: string }>(`SELECT (SELECT count(*)::text FROM aeeis_agent_registry_entries) entries, (SELECT count(*)::text FROM aeeis_agent_registry_audit) audit, (SELECT count(*)::text FROM aeeis_agent_registry_reputations) reputations`);
        expect(tables.rows[0]).toEqual({ entries: '1', audit: '1', reputations: '1' });
      } finally { await directory.close(); }
    } finally { await inspection.end(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('adds ordering columns when upgrading an early normalized schema', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const inspection = new pg.Pool({ connectionString: db.url });
    try {
      await inspection.query(`CREATE TABLE aeeis_agent_registry_entries (agent_id text PRIMARY KEY, position bigint NOT NULL UNIQUE, card jsonb NOT NULL, status text NOT NULL, discovered_at text NOT NULL, admitted_at text, revoked_at text)`);
      await inspection.query(`CREATE TABLE aeeis_agent_registry_audit (id text PRIMARY KEY, agent_id text NOT NULL, action text NOT NULL, actor text NOT NULL, card_version text NOT NULL, status text NOT NULL, at text NOT NULL)`);
      await inspection.query(`CREATE TABLE aeeis_agent_registry_reputations (agent_id text PRIMARY KEY, samples integer NOT NULL, dimensions jsonb NOT NULL, updated_at text NOT NULL)`);
      await inspection.query(`CREATE TABLE aeeis_agent_registry_observations (id text PRIMARY KEY, agent_id text NOT NULL, observation jsonb NOT NULL, actor text NOT NULL, at text NOT NULL)`);
      await inspection.query('INSERT INTO aeeis_agent_registry_entries(agent_id,position,card,status,discovered_at) VALUES($1,0,$2,$3,$4)', [card.agentId, card, 'discovered', '2026-09-19T00:00:00.000Z']);
      await inspection.query('INSERT INTO aeeis_agent_registry_audit(id,agent_id,action,actor,card_version,status,at) VALUES($1,$2,$3,$4,$5,$6,$7)', ['agent_audit_old', card.agentId, 'discovered', 'old', '1', 'discovered', '2026-09-19T00:00:00.000Z']);
      const directory = new PostgresAgentDirectory(db.url); await directory.init();
      try {
        expect((await directory.entriesSnapshot())[0]?.agentId).toBe(card.agentId);
        expect((await directory.auditSnapshot(card.agentId))[0]?.id).toBe('agent_audit_old');
        await directory.recordReputation(card.agentId, { source: 'operator', outcome: 'completed', evidenceRefs: ['receipt.upgrade'], dimensions: { quality: 1 } });
        expect((await directory.reputationSnapshot(card.agentId)).samples).toBe(1);
      } finally { await directory.close(); }
    } finally { await inspection.end(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('reports an incomplete schema as unhealthy without mutating it', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const inspection = new pg.Pool({ connectionString: db.url });
    const directory = new PostgresAgentDirectory(db.url);
    try {
      await directory.init();
      expect((await directory.health()).ready).toBe(true);
      await inspection.query('DROP TABLE aeeis_agent_registry_observations');
      expect(await directory.health()).toMatchObject({ ready: false, detail: 'PostgreSQL Agent Registry schema is incomplete' });
    } finally { await directory.close(); await inspection.end(); await db.close(); }
  });
});
