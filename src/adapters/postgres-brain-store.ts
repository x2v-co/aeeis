import pg from 'pg';
import { postgresAdvisoryXactLock } from './postgres-lock.js';
import { BrainConflict, GovernedBrain, brainStateSchema, type BrainPersistence, type BrainSemanticIndexMaintenance, type BrainClaim } from '../brain.js';
import { withPostgresMigrationLock } from './postgres-migration.js';

export interface PostgresBrainStoreOptions {
  semanticIndex?: BrainSemanticIndexMaintenance & { init(): Promise<void> };
}

/**
 * Durable Brain persistence for installations that already use PostgreSQL.
 *
 * Brain semantics stay in GovernedBrain; PostgreSQL only stores the validated
 * state and a revision. Saves use an optimistic compare-and-swap so two AEEIS
 * processes cannot silently overwrite one another's claims or audit events.
 */
export class PostgresBrainStore implements BrainPersistence {
  private readonly pool: pg.Pool;
  private readonly revisions = new WeakMap<GovernedBrain, number>();

  constructor(connectionString: string, private readonly options: PostgresBrainStoreOptions = {}) {
    this.pool = new pg.Pool({ connectionString });
  }

  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'brain-state', async client => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_brain_state (
          id smallint PRIMARY KEY CHECK (id = 1),
          revision bigint NOT NULL,
          state jsonb NOT NULL,
          updated_at timestamptz NOT NULL
        );
      `);
    });
    // The vector side index is derived. Brain startup must remain available
    // when the embedding service or pgvector is temporarily unavailable.
    try { await this.options.semanticIndex?.init(); } catch { /* lexical fallback */ }
  }

  async load(): Promise<GovernedBrain> {
    const result = await this.pool.query<{ revision: string; state: unknown }>(
      'SELECT revision, state FROM aeeis_brain_state WHERE id=1',
    );
    if (!result.rows[0]) {
      const brain = new GovernedBrain();
      this.revisions.set(brain, 0);
      try { await this.options.semanticIndex?.reconcile(brain.state().claims); } catch { /* lexical fallback */ }
      return brain;
    }
    const brain = GovernedBrain.fromState(brainStateSchema.parse(result.rows[0].state));
    this.revisions.set(brain, parseRevision(result.rows[0].revision));
    try { await this.options.semanticIndex?.reconcile(brain.state().claims); } catch { /* lexical fallback */ }
    return brain;
  }

  async save(brain: GovernedBrain): Promise<void> {
    const expected = this.revisions.get(brain);
    if (expected === undefined) throw new Error('Brain must be loaded from this store before it can be saved');
    const state = brainStateSchema.parse(brain.state());
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The row does not exist on first write, so serialize the bootstrap path
      // with an advisory transaction lock as well as locking existing rows.
      await postgresAdvisoryXactLock(client, 'aeeis:brain-state', 'singleton');
      const current = await client.query<{ revision: string }>(
        'SELECT revision FROM aeeis_brain_state WHERE id=1 FOR UPDATE',
      );
      const actual = current.rows[0] ? parseRevision(current.rows[0].revision) : 0;
      if (actual !== expected) {
        throw new BrainConflict(`Brain changed concurrently (expected revision ${expected}, found ${actual})`);
      }
      const next = expected + 1;
      await client.query(
        `INSERT INTO aeeis_brain_state(id,revision,state,updated_at)
         VALUES(1,$1,$2,$3)
         ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state,updated_at=EXCLUDED.updated_at`,
        [next, state, new Date().toISOString()],
      );
      await client.query('COMMIT');
      this.revisions.set(brain, next);
      // A successful canonical write must not become ambiguous just because a
      // replaceable embedding index is temporarily unavailable.
      try { await this.options.semanticIndex?.reconcile(state.claims); } catch { /* lexical fallback */ }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.options.semanticIndex?.close();
    await this.pool.end();
  }
}

function parseRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid Brain persistence revision');
  return revision;
}
