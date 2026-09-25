import { validateCollectionLimit } from './collection-query.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { postgresAdvisoryXactLock } from './postgres-lock.js';
import { withPostgresMigrationLock } from './postgres-migration.js';
import { z } from 'zod';
import {
  agentReputationObservationSchema,
  type AgentDirectoryPort,
  type AgentRegistryAuditEvent,
  type AgentRegistryEntry,
  type AgentReputation,
} from '../agent-gateway.js';
import { agentCardSchema, type AgentCard } from '../protocol.js';

const statusSchema = z.enum(['discovered', 'admitted', 'revoked']);
const storedEntrySchema = z.object({
  agentId: z.string().min(1), card: agentCardSchema, status: statusSchema,
  discoveredAt: z.string().datetime({ offset: true }),
  admittedAt: z.string().datetime({ offset: true }).optional(),
  revokedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
const auditSchema = z.object({
  id: z.string().min(1), agentId: z.string().min(1), action: z.enum(['discovered', 'registered', 'admitted', 'revoked']),
  actor: z.string().min(1), cardVersion: z.string().min(1), status: statusSchema, at: z.string().datetime({ offset: true }),
}).strict();
const observationSchema = agentReputationObservationSchema.extend({ id: z.string().min(1), actor: z.string().min(1), at: z.string().datetime({ offset: true }) });
const dimensionsSchema = z.object({ identity: z.number().min(0).max(1), quality: z.number().min(0).max(1), evidence: z.number().min(0).max(1), safety: z.number().min(0).max(1), latency: z.number().min(0).max(1), cost: z.number().min(0).max(1), privacy: z.number().min(0).max(1), revocation: z.number().min(0).max(1) }).strict();
const reputationSchema = z.object({
  agentId: z.string().min(1), samples: z.number().int().nonnegative(), dimensions: dimensionsSchema,
  observations: z.array(observationSchema).max(100), updatedAt: z.string().datetime({ offset: true }),
}).strict();
const stateSchema = z.object({ entries: z.array(storedEntrySchema).max(10_000), audit: z.array(auditSchema).max(100_000), reputation: z.record(z.string(), reputationSchema) }).strict();
type RegistryState = z.infer<typeof stateSchema>;

type EntryRow = { agent_id: string; card: unknown; status: string; discovered_at: string; admitted_at: string | null; revoked_at: string | null };
type AuditRow = { id: string; agent_id: string; action: string; actor: string; card_version: string; status: string; at: string };
type ReputationRow = { agent_id: string; samples: number | string; dimensions: unknown; updated_at: string };
type ObservationRow = { id: string; agent_id: string; observation: unknown; actor: string; at: string };

/**
 * PostgreSQL Agent Registry.
 *
 * The original release stored the complete registry in one JSONB row. That
 * row remains as a compatibility mirror, but lifecycle entries, audit events,
 * reputation aggregates and observations now have bounded relational rows.
 * Reads therefore filter and limit inside PostgreSQL while mutations still
 * use one advisory-locked transaction and keep the old row in sync.
 */
export class PostgresAgentDirectory implements AgentDirectoryPort {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }

  async health(): Promise<{ ready: boolean; detail: string; checkedAt: string }> {
    const checkedAt = new Date().toISOString();
    try {
      const result = await this.pool.query<{ present: string }>(`
        SELECT count(*)::text AS present
        FROM (VALUES
          ('aeeis_agent_registry'::text),
          ('aeeis_agent_registry_entries'::text),
          ('aeeis_agent_registry_audit'::text),
          ('aeeis_agent_registry_reputations'::text),
          ('aeeis_agent_registry_observations'::text)
        ) AS required(table_name)
        WHERE to_regclass(required.table_name) IS NOT NULL
      `);
      if (Number(result.rows[0]?.present ?? 0) !== 5) return { ready: false, detail: 'PostgreSQL Agent Registry schema is incomplete', checkedAt };
      return { ready: true, detail: 'PostgreSQL Agent Registry reachable', checkedAt };
    }
    catch (error) { return { ready: false, detail: `PostgreSQL Agent Registry unavailable: ${error instanceof Error ? error.message : 'unknown error'}`.slice(0, 500), checkedAt }; }
  }

  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'agent-registry', async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_agent_registry (id smallint PRIMARY KEY CHECK (id = 1), revision bigint NOT NULL, state jsonb NOT NULL, updated_at timestamptz NOT NULL)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_agent_registry_entries (
          agent_id text PRIMARY KEY, position bigint NOT NULL UNIQUE, card jsonb NOT NULL,
          status text NOT NULL CHECK (status IN ('discovered','admitted','revoked')),
          discovered_at text NOT NULL, admitted_at text, revoked_at text
        );
        CREATE INDEX IF NOT EXISTS aeeis_agent_registry_entries_status_position ON aeeis_agent_registry_entries(status, position);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_agent_registry_audit (
          seq bigserial NOT NULL, id text PRIMARY KEY, agent_id text NOT NULL,
          action text NOT NULL CHECK (action IN ('discovered','registered','admitted','revoked')),
          actor text NOT NULL, card_version text NOT NULL,
          status text NOT NULL CHECK (status IN ('discovered','admitted','revoked')), at text NOT NULL
        );
      `);
      await client.query('ALTER TABLE aeeis_agent_registry_audit ADD COLUMN IF NOT EXISTS seq bigserial');
      await client.query('CREATE INDEX IF NOT EXISTS aeeis_agent_registry_audit_agent_seq ON aeeis_agent_registry_audit(agent_id, seq, id)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_agent_registry_reputations (
          agent_id text PRIMARY KEY, samples integer NOT NULL CHECK (samples >= 0), dimensions jsonb NOT NULL, updated_at text NOT NULL
        );
        CREATE TABLE IF NOT EXISTS aeeis_agent_registry_observations (
          seq bigserial NOT NULL, id text PRIMARY KEY, agent_id text NOT NULL, observation jsonb NOT NULL, actor text NOT NULL, at text NOT NULL
        );
      `);
      await client.query('ALTER TABLE aeeis_agent_registry_observations ADD COLUMN IF NOT EXISTS seq bigserial');
      await client.query('CREATE INDEX IF NOT EXISTS aeeis_agent_registry_observations_agent_seq ON aeeis_agent_registry_observations(agent_id, seq, id)');
      await migrateLegacyState(client);
    });
  }

  async close(): Promise<void> { await this.pool.end(); }

  async get(agentId: string): Promise<AgentCard> {
    const result = await this.pool.query<EntryRow>('SELECT agent_id,card,status,discovered_at,admitted_at,revoked_at FROM aeeis_agent_registry_entries WHERE agent_id=$1', [agentId]);
    if (!result.rows[0]) throw new Error('Agent is not admitted');
    const entry = parseEntry(result.rows[0]);
    if (entry.status !== 'admitted') throw new Error('Agent is not admitted');
    assertNotExpired(entry.card, 'Agent Card has expired');
    return structuredClone(entry.card);
  }

  async list(status: 'discovered' | 'admitted' | 'revoked' = 'admitted'): Promise<AgentCard[]> {
    const result = await this.pool.query<EntryRow>('SELECT agent_id,card,status,discovered_at,admitted_at,revoked_at FROM aeeis_agent_registry_entries WHERE status=$1 ORDER BY position', [status]);
    return result.rows.map(row => structuredClone(parseEntry(row).card));
  }

  async entriesSnapshot(limit?: number): Promise<AgentRegistryEntry[]> {
    validateCollectionLimit(limit);
    const result = await this.pool.query<EntryRow & { samples: number | string | null; dimensions: unknown | null; updated_at: string | null }>(`
      SELECT entry.agent_id, entry.card, entry.status, entry.discovered_at, entry.admitted_at, entry.revoked_at,
             reputation.samples, reputation.dimensions, reputation.updated_at
      FROM aeeis_agent_registry_entries entry
      LEFT JOIN aeeis_agent_registry_reputations reputation ON reputation.agent_id=entry.agent_id
      ORDER BY entry.position${limit === undefined ? '' : ' LIMIT $1'}
    `, limit === undefined ? [] : [limit]);
    const observations = await this.observationsFor(result.rows.map(row => row.agent_id));
    return result.rows.map(row => {
      const entry = parseEntry(row);
      const reputation = row.samples === null
        ? reputationFor(emptyState(), entry.agentId)
        : parseReputation({ agent_id: entry.agentId, samples: row.samples, dimensions: row.dimensions, updated_at: row.updated_at! }, observations.get(entry.agentId) ?? []);
      return { agentId: entry.agentId, card: structuredClone(entry.card), status: entry.status, discoveredAt: entry.discoveredAt,
        ...(entry.admittedAt === undefined ? {} : { admittedAt: entry.admittedAt }),
        ...(entry.revokedAt === undefined ? {} : { revokedAt: entry.revokedAt }), reputation };
    });
  }

  async auditSnapshot(agentId?: string): Promise<AgentRegistryAuditEvent[]> {
    const result = await this.pool.query<AuditRow>(`SELECT id,agent_id,action,actor,card_version,status,at FROM aeeis_agent_registry_audit${agentId === undefined ? '' : ' WHERE agent_id=$1'} ORDER BY seq,id`, agentId === undefined ? [] : [agentId]);
    return result.rows.map(parseAudit);
  }

  async reputationSnapshot(agentId: string): Promise<AgentReputation> {
    const exists = await this.pool.query<{ agent_id: string }>('SELECT agent_id FROM aeeis_agent_registry_entries WHERE agent_id=$1', [agentId]);
    if (!exists.rows[0]) throw new Error('Unknown agent');
    const result = await this.pool.query<ReputationRow>('SELECT agent_id,samples,dimensions,updated_at FROM aeeis_agent_registry_reputations WHERE agent_id=$1', [agentId]);
    if (!result.rows[0]) return reputationFor(emptyState(), agentId);
    const observations = await this.observationsFor([agentId]);
    return parseReputation(result.rows[0], observations.get(agentId) ?? []);
  }

  async discover(input: AgentCard, at = new Date().toISOString(), actor = 'operator'): Promise<AgentCard> {
    const card = agentCardSchema.parse(input);
    return this.mutate(state => {
      assertNotExpired(card, 'Cannot discover an expired Agent Card');
      const existing = state.entries.find(entry => entry.agentId === card.agentId);
      if (existing && Number(existing.card.cardVersion) > Number(card.cardVersion)) throw new Error('Discovery cannot replace a newer Agent Card');
      if (existing?.status === 'revoked') throw new Error('Revoked Agent requires explicit re-admission');
      if (existing?.status === 'admitted' && existing.card.cardVersion === card.cardVersion) return { value: structuredClone(existing.card), changed: false };
      const next = { agentId: card.agentId, card, status: 'discovered' as const, discoveredAt: existing?.discoveredAt ?? at };
      state.entries = state.entries.filter(entry => entry.agentId !== card.agentId).concat(next); record(state, card, 'discovered', actor, at);
      return { value: structuredClone(card), changed: true };
    });
  }

  async register(input: AgentCard, actor = 'system'): Promise<AgentCard> {
    const card = agentCardSchema.parse(input);
    return this.mutate(state => {
      assertNotExpired(card, 'Cannot register an expired Agent Card');
      const existing = state.entries.find(entry => entry.agentId === card.agentId);
      if (existing?.card.cardVersion === card.cardVersion && existing.status === 'admitted') return { value: structuredClone(card), changed: false };
      if (existing?.status === 'revoked') throw new Error('Revoked Agent requires explicit re-admission');
      const now = new Date().toISOString();
      const next = { agentId: card.agentId, card, status: 'admitted' as const, discoveredAt: existing?.discoveredAt ?? now, admittedAt: existing?.admittedAt ?? now };
      state.entries = state.entries.filter(entry => entry.agentId !== card.agentId).concat(next); record(state, card, 'registered', actor, now);
      return { value: structuredClone(card), changed: true };
    });
  }

  async admit(agentId: string, at = new Date().toISOString(), actor = 'operator'): Promise<AgentCard> {
    return this.mutate(state => {
      const entry = state.entries.find(candidate => candidate.agentId === agentId);
      if (!entry || entry.status !== 'discovered') throw new Error('Agent is not awaiting admission');
      assertNotExpired(entry.card, 'Agent Card has expired'); entry.status = 'admitted'; entry.admittedAt = at; record(state, entry.card, 'admitted', actor, at);
      return { value: structuredClone(entry.card), changed: true };
    });
  }

  async revoke(agentId: string, at = new Date().toISOString(), actor = 'operator'): Promise<void> {
    await this.mutate(state => {
      const entry = state.entries.find(candidate => candidate.agentId === agentId);
      if (!entry) throw new Error('Unknown agent'); entry.status = 'revoked'; entry.revokedAt = at; record(state, entry.card, 'revoked', actor, at);
      return { value: undefined, changed: true };
    });
  }

  async recordReputation(agentId: string, input: unknown, actor = 'operator', at = new Date().toISOString()): Promise<AgentReputation> {
    const observation = agentReputationObservationSchema.parse(input);
    return this.mutate(state => {
      if (!state.entries.some(entry => entry.agentId === agentId)) throw new Error('Unknown agent');
      const current = reputationFor(state, agentId); const nextSamples = current.samples + 1; const dimensions = { ...current.dimensions };
      for (const key of Object.keys(dimensions) as Array<keyof AgentReputation['dimensions']>) { const score = observation.dimensions[key]; if (score !== undefined) dimensions[key] = (dimensions[key] * current.samples + score) / nextSamples; }
      const next: AgentReputation = { agentId, samples: nextSamples, dimensions, observations: [...current.observations, { ...observation, id: `agent_observation_${randomUUID()}`, actor, at }].slice(-100), updatedAt: at };
      state.reputation[agentId] = next; return { value: structuredClone(next), changed: true };
    });
  }

  private async observationsFor(agentIds: string[]): Promise<Map<string, AgentReputation['observations']>> {
    const result = new Map<string, AgentReputation['observations']>(); if (agentIds.length === 0) return result;
    const rows = await this.pool.query<ObservationRow>('SELECT id,agent_id,observation,actor,at FROM aeeis_agent_registry_observations WHERE agent_id = ANY($1::text[]) ORDER BY seq,id', [agentIds]);
    for (const row of rows.rows) { const parsed = observationSchema.parse({ ...(row.observation as Record<string, unknown>), id: row.id, actor: row.actor, at: row.at }); const list = result.get(row.agent_id) ?? []; list.push(parsed); result.set(row.agent_id, list.slice(-100)); }
    return result;
  }

  private async mutate<T>(operation: (state: RegistryState) => { value: T; changed: boolean }): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await postgresAdvisoryXactLock(client, 'aeeis:agent-registry', 'singleton');
      const state = await readNormalizedState(client); const previous = structuredClone(state); const outcome = operation(state);
      if (outcome.changed) {
        const parsed = stateSchema.parse(state); await persistNormalizedDiff(client, previous, parsed);
        const revisionRow = await client.query<{ revision: string }>('SELECT revision FROM aeeis_agent_registry WHERE id=1 FOR UPDATE');
        const revision = revisionRow.rows[0] ? parseRevision(revisionRow.rows[0].revision) : 0;
        await client.query(`INSERT INTO aeeis_agent_registry(id,revision,state,updated_at) VALUES(1,$1,$2,$3) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state,updated_at=EXCLUDED.updated_at`, [revision + 1, parsed, new Date().toISOString()]);
      }
      await client.query('COMMIT'); return outcome.value;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}

async function migrateLegacyState(client: pg.PoolClient): Promise<void> {
  const existing = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM aeeis_agent_registry_entries');
  const legacy = await client.query<{ state: unknown }>('SELECT state FROM aeeis_agent_registry WHERE id=1'); if (!legacy.rows[0]) return;
  const state = stateSchema.parse(legacy.rows[0].state);
  if (Number(existing.rows[0]?.count ?? 0) === 0 && state.entries.length > 0) await persistNormalizedState(client, state);
  const auditCount = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM aeeis_agent_registry_audit');
  if (Number(auditCount.rows[0]?.count ?? 0) === 0) for (const event of state.audit) await insertAudit(client, event);
  const reputationCount = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM aeeis_agent_registry_reputations');
  if (Number(reputationCount.rows[0]?.count ?? 0) === 0 && Object.keys(state.reputation).length > 0) await persistReputations(client, state.reputation);
}

async function readNormalizedState(client: pg.PoolClient): Promise<RegistryState> {
  const entries = await client.query<EntryRow>('SELECT agent_id,card,status,discovered_at,admitted_at,revoked_at FROM aeeis_agent_registry_entries ORDER BY position');
  const audit = await client.query<AuditRow>('SELECT id,agent_id,action,actor,card_version,status,at FROM aeeis_agent_registry_audit ORDER BY seq,id');
  const reputations = await client.query<ReputationRow>('SELECT agent_id,samples,dimensions,updated_at FROM aeeis_agent_registry_reputations');
  const observations = await client.query<ObservationRow>('SELECT id,agent_id,observation,actor,at FROM aeeis_agent_registry_observations ORDER BY seq,id');
  const observationMap = new Map<string, AgentReputation['observations']>();
  for (const row of observations.rows) { const parsed = observationSchema.parse({ ...(row.observation as Record<string, unknown>), id: row.id, actor: row.actor, at: row.at }); observationMap.set(row.agent_id, [...(observationMap.get(row.agent_id) ?? []), parsed].slice(-100)); }
  const reputation: Record<string, AgentReputation> = {}; for (const row of reputations.rows) reputation[row.agent_id] = parseReputation(row, observationMap.get(row.agent_id) ?? []);
  return stateSchema.parse({ entries: entries.rows.map(parseEntry), audit: audit.rows.map(parseAudit), reputation });
}

async function persistNormalizedState(client: pg.PoolClient, state: RegistryState): Promise<void> {
  await client.query('DELETE FROM aeeis_agent_registry_observations'); await client.query('DELETE FROM aeeis_agent_registry_reputations'); await client.query('DELETE FROM aeeis_agent_registry_audit'); await client.query('DELETE FROM aeeis_agent_registry_entries');
  for (const [position, entry] of state.entries.entries()) await client.query('INSERT INTO aeeis_agent_registry_entries(agent_id,position,card,status,discovered_at,admitted_at,revoked_at) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7)', [entry.agentId, position, JSON.stringify(entry.card), entry.status, entry.discoveredAt, entry.admittedAt ?? null, entry.revokedAt ?? null]);
  for (const event of state.audit) await insertAudit(client, event); await persistReputations(client, state.reputation);
}

/** Persist only rows changed by a lifecycle/reputation mutation. The legacy
 * mirror is still updated by the caller, but the normalized tables avoid
 * deleting and reinserting unrelated Agents or their audit history. */
async function persistNormalizedDiff(client: pg.PoolClient, previous: RegistryState, next: RegistryState): Promise<void> {
  const previousEntries = new Map(previous.entries.map(entry => [entry.agentId, entry]));
  const nextEntries = new Map(next.entries.map(entry => [entry.agentId, entry]));
  const removedEntries = [...previousEntries.keys()].filter(agentId => !nextEntries.has(agentId));
  const changedEntries = next.entries.filter((entry, position) => {
    const before = previousEntries.get(entry.agentId);
    return !before || previous.entries.findIndex(candidate => candidate.agentId === entry.agentId) !== position || JSON.stringify(before) !== JSON.stringify(entry);
  }).map(entry => entry.agentId);
  const deleteEntries = [...new Set([...removedEntries, ...changedEntries])];
  if (deleteEntries.length) await client.query('DELETE FROM aeeis_agent_registry_entries WHERE agent_id = ANY($1::text[])', [deleteEntries]);
  for (const [position, entry] of next.entries.entries()) {
    if (!changedEntries.includes(entry.agentId)) continue;
    await client.query('INSERT INTO aeeis_agent_registry_entries(agent_id,position,card,status,discovered_at,admitted_at,revoked_at) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7)', [entry.agentId, position, JSON.stringify(entry.card), entry.status, entry.discoveredAt, entry.admittedAt ?? null, entry.revokedAt ?? null]);
  }

  const previousAudit = new Map(previous.audit.map(event => [event.id, event]));
  const nextAudit = new Map(next.audit.map(event => [event.id, event]));
  const removedAudit = [...previousAudit.keys()].filter(id => !nextAudit.has(id));
  if (removedAudit.length) await client.query('DELETE FROM aeeis_agent_registry_audit WHERE id = ANY($1::text[])', [removedAudit]);
  for (const event of next.audit) if (!previousAudit.has(event.id)) await insertAudit(client, event);

  const reputationIds = new Set([...Object.keys(previous.reputation), ...Object.keys(next.reputation)]);
  for (const agentId of reputationIds) {
    const before = previous.reputation[agentId]; const after = next.reputation[agentId];
    if (!after) {
      await client.query('DELETE FROM aeeis_agent_registry_observations WHERE agent_id=$1', [agentId]);
      await client.query('DELETE FROM aeeis_agent_registry_reputations WHERE agent_id=$1', [agentId]);
      continue;
    }
    if (before && JSON.stringify(before) === JSON.stringify(after)) continue;
    await client.query('DELETE FROM aeeis_agent_registry_observations WHERE agent_id=$1', [agentId]);
    await client.query('DELETE FROM aeeis_agent_registry_reputations WHERE agent_id=$1', [agentId]);
    await persistReputations(client, { [agentId]: after });
  }
}
async function insertAudit(client: pg.PoolClient, event: AgentRegistryAuditEvent): Promise<void> { await client.query('INSERT INTO aeeis_agent_registry_audit(id,agent_id,action,actor,card_version,status,at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING', [event.id, event.agentId, event.action, event.actor, event.cardVersion, event.status, event.at]); }
async function persistReputations(client: pg.PoolClient, reputations: Record<string, AgentReputation>): Promise<void> {
  for (const reputation of Object.values(reputations)) { const parsed = reputationSchema.parse(reputation); await client.query('INSERT INTO aeeis_agent_registry_reputations(agent_id,samples,dimensions,updated_at) VALUES($1,$2,$3::jsonb,$4)', [parsed.agentId, parsed.samples, JSON.stringify(parsed.dimensions), parsed.updatedAt]); for (const observation of parsed.observations) { const { id, actor, at, ...payload } = observation; await client.query('INSERT INTO aeeis_agent_registry_observations(id,agent_id,observation,actor,at) VALUES($1,$2,$3::jsonb,$4,$5)', [id, parsed.agentId, JSON.stringify(payload), actor, at]); } }
}
function parseEntry(row: EntryRow): z.infer<typeof storedEntrySchema> { return storedEntrySchema.parse({ agentId: row.agent_id, card: row.card, status: row.status, discoveredAt: row.discovered_at, ...(row.admitted_at === null ? {} : { admittedAt: row.admitted_at }), ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }) }); }
function parseAudit(row: AuditRow): AgentRegistryAuditEvent { return auditSchema.parse({ id: row.id, agentId: row.agent_id, action: row.action, actor: row.actor, cardVersion: row.card_version, status: row.status, at: row.at }); }
function parseReputation(row: ReputationRow, observations: AgentReputation['observations']): AgentReputation { return reputationSchema.parse({ agentId: row.agent_id, samples: Number(row.samples), dimensions: row.dimensions, observations, updatedAt: row.updated_at }); }
function emptyState(): RegistryState { return { entries: [], audit: [], reputation: {} }; }
function parseRevision(value: string): number { const revision = Number(value); if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid Agent registry revision'); return revision; }
function assertNotExpired(card: AgentCard, message: string): void { if (card.expiresAt && new Date(card.expiresAt).getTime() <= Date.now()) throw new Error(message); }
function record(state: RegistryState, card: AgentCard, action: AgentRegistryAuditEvent['action'], actor: string, at: string): void { state.audit.push({ id: `agent_audit_${randomUUID()}`, agentId: card.agentId, action, actor, cardVersion: card.cardVersion, status: action === 'registered' || action === 'admitted' ? 'admitted' : action === 'revoked' ? 'revoked' : 'discovered', at }); }
function reputationFor(state: RegistryState, agentId: string): AgentReputation { return structuredClone(state.reputation[agentId] ?? { agentId, samples: 0, dimensions: defaultDimensions(), observations: [], updatedAt: new Date(0).toISOString() }); }
function defaultDimensions(): AgentReputation['dimensions'] { return { identity: 0.5, quality: 0.5, evidence: 0.5, safety: 0.5, latency: 0.5, cost: 0.5, privacy: 0.5, revocation: 0.5 }; }
