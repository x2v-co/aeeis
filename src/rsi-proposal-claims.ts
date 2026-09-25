import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';

export interface RsiProposalClaimScope {
  owner: string;
  tenantId: string;
}

export type RsiProposalClaim = { claimed: true; token: string } | { claimed: false };

/** A short lease prevents multiple pump instances from doing the same work.
 * The lease is advisory: canonical Run events and RSI candidate IDs remain the
 * correctness boundary, so an expired claim can safely be retried. */
export interface RsiProposalClaimStore {
  init?(): Promise<void>;
  claim(signalId: string, scope: RsiProposalClaimScope, leaseMs: number): Promise<RsiProposalClaim>;
  release(signalId: string, scope: RsiProposalClaimScope, token: string): Promise<void>;
  close?(): Promise<void>;
}

const claimRecordSchema = z.object({
  signalId: z.string().min(1).max(200), owner: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200), token: z.string().uuid(),
  leaseUntil: z.number().int().nonnegative(),
}).strict();
type ClaimRecord = z.infer<typeof claimRecordSchema>;
function validateLease(leaseMs: number): void {
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 86_400_000) throw new Error('leaseMs must be between 1000 and 86400000');
}
function key(signalId: string, scope: RsiProposalClaimScope): string {
  return JSON.stringify([scope.owner, scope.tenantId, signalId]);
}

/** In-memory/File deployments already use a single writer lock. This store is
 * still useful for tests and gives the pump the same lease semantics locally. */
export class InMemoryRsiProposalClaimStore implements RsiProposalClaimStore {
  private readonly claims = new Map<string, ClaimRecord>();
  async claim(signalId: string, scope: RsiProposalClaimScope, leaseMs: number): Promise<RsiProposalClaim> {
    validateLease(leaseMs);
    const now = Date.now();
    const existing = this.claims.get(key(signalId, scope));
    if (existing && existing.leaseUntil > now) return { claimed: false };
    const token = randomUUID();
    this.claims.set(key(signalId, scope), { signalId, ...scope, token, leaseUntil: now + leaseMs });
    return { claimed: true, token };
  }
  async release(signalId: string, scope: RsiProposalClaimScope, token: string): Promise<void> {
    const record = this.claims.get(key(signalId, scope));
    if (record?.token === token) this.claims.delete(key(signalId, scope));
  }
}

/** Durable claim store for the local JSON deployment. The application already
 * enforces one writer per data directory, so an atomic replace is sufficient. */
export class FileRsiProposalClaimStore implements RsiProposalClaimStore {
  private queue: Promise<unknown> = Promise.resolve();
  private records = new Map<string, ClaimRecord>();
  private loaded = false;
  constructor(private readonly path: string) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const records = z.array(claimRecordSchema).parse(JSON.parse(await readFile(this.path, 'utf8')));
      this.records = new Map(records.map(record => [key(record.signalId, record), record]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }
  async init(): Promise<void> { await this.serial(() => this.load()); }
  private async save(records: Map<string, ClaimRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify([...records.values()])); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
      const directory = await open(dirname(this.path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      this.records = records;
    } catch (error) {
      // Rename may have committed before a directory-sync failure; reload the
      // canonical file before any later lease decision.
      this.loaded = false;
      throw error;
    } finally { await unlink(temp).catch(() => undefined); }
  }
  async claim(signalId: string, scope: RsiProposalClaimScope, leaseMs: number): Promise<RsiProposalClaim> {
    validateLease(leaseMs);
    return this.serial(async () => {
      await this.load();
      const id = key(signalId, scope), now = Date.now(), existing = this.records.get(id);
      if (existing && existing.leaseUntil > now) return { claimed: false };
      const token = randomUUID();
      const next = new Map(this.records);
      next.set(id, claimRecordSchema.parse({ signalId, ...scope, token, leaseUntil: now + leaseMs }));
      await this.save(next);
      return { claimed: true, token };
    });
  }
  async release(signalId: string, scope: RsiProposalClaimScope, token: string): Promise<void> {
    await this.serial(async () => {
      await this.load();
      const id = key(signalId, scope), existing = this.records.get(id);
      if (existing?.token === token) { const next = new Map(this.records); next.delete(id); await this.save(next); }
    });
  }
  async close(): Promise<void> { await this.queue; }
}

export class PostgresRsiProposalClaimStore implements RsiProposalClaimStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'rsi-proposal-claims', async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_rsi_proposal_claims (
        signal_id text NOT NULL, owner text NOT NULL, tenant_id text NOT NULL,
        token text NOT NULL, lease_until timestamptz NOT NULL,
        PRIMARY KEY (signal_id, owner, tenant_id)
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS aeeis_rsi_proposal_claims_lease_idx ON aeeis_rsi_proposal_claims (lease_until)');
    });
  }
  async claim(signalId: string, scope: RsiProposalClaimScope, leaseMs: number): Promise<RsiProposalClaim> {
    validateLease(leaseMs);
    const token = randomUUID();
    const result = await this.pool.query<{ token: string }>(`
      INSERT INTO aeeis_rsi_proposal_claims(signal_id, owner, tenant_id, token, lease_until)
      VALUES ($1, $2, $3, $4, now() + ($5::double precision * interval '1 millisecond'))
      ON CONFLICT (signal_id, owner, tenant_id) DO UPDATE
      SET token=EXCLUDED.token, lease_until=EXCLUDED.lease_until
      WHERE aeeis_rsi_proposal_claims.lease_until <= now()
      RETURNING token`, [signalId, scope.owner, scope.tenantId, token, leaseMs]);
    return result.rows[0] ? { claimed: true, token: result.rows[0].token } : { claimed: false };
  }
  async release(signalId: string, scope: RsiProposalClaimScope, token: string): Promise<void> {
    await this.pool.query('DELETE FROM aeeis_rsi_proposal_claims WHERE signal_id=$1 AND owner=$2 AND tenant_id=$3 AND token=$4', [signalId, scope.owner, scope.tenantId, token]);
  }
  async close(): Promise<void> { await this.pool.end(); }
}
