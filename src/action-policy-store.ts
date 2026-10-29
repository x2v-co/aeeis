import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { postgresAdvisoryXactLock } from './adapters/postgres-lock.js';
import { actionRefSchema, normalizeActionPolicy, type ActionPolicy } from './runtime/action-policy.js';
import { digestProtocol } from './protocol.js';
import type { Ownership } from './security/principal.js';
import { createPostgresPool } from './adapters/postgres-pool.js';

/**
 * The owner's standing allow and block lists. A Run copies them when it is
 * created and records the digest, so later changes never reach a Run that is
 * already going. The lists grow only from an approval card or the settings
 * page; nothing adds to them by guessing a category.
 */
export const ownerActionPolicySchema = z.object({
  owner: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  allow: z.array(actionRefSchema).max(100),
  block: z.array(actionRefSchema).max(100),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type OwnerActionPolicy = z.infer<typeof ownerActionPolicySchema>;

export const ownerActionPolicyChangeSchema = z.union([
  z.object({ expectedRevision: z.number().int().nonnegative(), allow: z.array(actionRefSchema).max(100), block: z.array(actionRefSchema).max(100) }).strict(),
  z.object({ expectedRevision: z.number().int().nonnegative().optional(), add: z.object({ list: z.enum(['allow', 'block']), ref: actionRefSchema }).strict() }).strict(),
  z.object({ expectedRevision: z.number().int().nonnegative().optional(), remove: z.object({ list: z.enum(['allow', 'block']), ref: actionRefSchema }).strict() }).strict(),
]);
export type OwnerActionPolicyChange = z.infer<typeof ownerActionPolicyChangeSchema>;

export class ActionPolicyConflict extends Error {}

export interface ActionPolicyStore {
  init?(): Promise<void>;
  get(scope: Ownership): Promise<OwnerActionPolicy>;
  change(scope: Ownership, change: OwnerActionPolicyChange, now?: string): Promise<OwnerActionPolicy>;
  close?(): Promise<void>;
}

export function emptyOwnerActionPolicy(scope: Ownership): OwnerActionPolicy {
  return { owner: scope.owner, tenantId: scope.tenantId, allow: [], block: [], revision: 0 };
}

/** The lists a new Run freezes: the owner's lists joined with what the request
 * asked for. A ref on either block list stays blocked; the request can never
 * remove an owner block. */
export function frozenRunPolicy(owner: OwnerActionPolicy | undefined, requested: ActionPolicy | undefined): ActionPolicy | undefined {
  const block = [...new Set([...(owner?.block ?? []), ...(requested?.block ?? [])])];
  const allow = [...new Set([...(owner?.allow ?? []), ...(requested?.allow ?? [])])].filter(ref => !block.includes(ref));
  return normalizeActionPolicy({ allow, block });
}

export function actionPolicyDigest(policy: ActionPolicy | undefined): string {
  return digestProtocol({ schemaVersion: 'action-policy/1', allow: policy?.allow ?? [], block: policy?.block ?? [] });
}

/** Applies one change. A ref moves between lists rather than sitting on both. */
export function applyOwnerActionPolicyChange(current: OwnerActionPolicy, raw: OwnerActionPolicyChange, now: string): OwnerActionPolicy {
  const change = ownerActionPolicyChangeSchema.parse(raw);
  if (change.expectedRevision !== undefined && change.expectedRevision !== current.revision) throw new ActionPolicyConflict('动作清单已经变化，请刷新后再改');
  let allow = current.allow;
  let block = current.block;
  if ('allow' in change) {
    block = [...new Set(change.block)];
    allow = [...new Set(change.allow)].filter(ref => !block.includes(ref));
  } else if ('add' in change) {
    if (change.add.list === 'allow') { allow = [...new Set([...allow, change.add.ref])]; block = block.filter(ref => ref !== change.add.ref); }
    else { block = [...new Set([...block, change.add.ref])]; allow = allow.filter(ref => ref !== change.add.ref); }
    if (allow.length > 100 || block.length > 100) throw new ActionPolicyConflict('动作清单最多各 100 条，请先移除不用的');
  } else {
    if (change.remove.list === 'allow') allow = allow.filter(ref => ref !== change.remove.ref);
    else block = block.filter(ref => ref !== change.remove.ref);
  }
  allow = [...allow].sort();
  block = [...block].sort();
  if (allow.join('\n') === current.allow.join('\n') && block.join('\n') === current.block.join('\n')) return current;
  return { ...current, allow, block, revision: current.revision + 1, updatedAt: now };
}

export class InMemoryActionPolicyStore implements ActionPolicyStore {
  private readonly policies = new Map<string, OwnerActionPolicy>();
  async get(scope: Ownership): Promise<OwnerActionPolicy> { return structuredClone(this.policies.get(key(scope)) ?? emptyOwnerActionPolicy(scope)); }
  async change(scope: Ownership, change: OwnerActionPolicyChange, now = new Date().toISOString()): Promise<OwnerActionPolicy> {
    const next = applyOwnerActionPolicyChange(await this.get(scope), change, now);
    this.policies.set(key(scope), structuredClone(next));
    return structuredClone(next);
  }
}

/** Durable single-writer JSON store. */
export class JsonActionPolicyStore implements ActionPolicyStore {
  private policies: OwnerActionPolicy[] = [];
  private loaded = false;
  private lockOwned = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}
  async init(): Promise<void> {
    if (this.loaded) return;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath}.lock`;
    try { const fd = openSync(lockPath, 'wx', 0o600); try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); } }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(lockPath, 'utf8'));
      try { process.kill(pid, 0); } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
        unlinkSync(lockPath); return this.init();
      }
      throw new Error('Action policy store already has a live writer');
    }
    this.lockOwned = true;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as { policies?: unknown };
      this.policies = z.array(ownerActionPolicySchema).parse(parsed.policies ?? []);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await this.close(); throw error; }
    }
    this.loaded = true;
  }
  async get(scope: Ownership): Promise<OwnerActionPolicy> {
    return this.serial(async () => structuredClone(this.policies.find(item => item.owner === scope.owner && item.tenantId === scope.tenantId) ?? emptyOwnerActionPolicy(scope)));
  }
  async change(scope: Ownership, change: OwnerActionPolicyChange, now = new Date().toISOString()): Promise<OwnerActionPolicy> {
    return this.serial(async () => {
      if (!this.loaded || !this.lockOwned) throw new Error('Action policy store is not open');
      const current = this.policies.find(item => item.owner === scope.owner && item.tenantId === scope.tenantId) ?? emptyOwnerActionPolicy(scope);
      const next = applyOwnerActionPolicyChange(current, change, now);
      if (next !== current) this.persist([...this.policies.filter(item => !(item.owner === scope.owner && item.tenantId === scope.tenantId)), next]);
      return structuredClone(next);
    });
  }
  async close(): Promise<void> {
    if (this.lockOwned) { try { unlinkSync(`${this.filePath}.lock`); } catch { /* already gone */ } this.lockOwned = false; }
    this.loaded = false;
  }
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  private persist(next: OwnerActionPolicy[]): void {
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600); writeSync(fd, `${JSON.stringify({ policies: next }, null, 2)}\n`, undefined, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, this.filePath);
      const directory = openSync(dirname(this.filePath), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
      this.policies = next.map(item => structuredClone(item));
    } catch (error) { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch { /* the temp file is already gone */ } throw error; }
  }
}

export class PostgresActionPolicyStore implements ActionPolicyStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = createPostgresPool(connectionString); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'action-policies', async client => {
      await client.query('CREATE TABLE IF NOT EXISTS aeeis_action_policies (owner text NOT NULL, tenant_id text NOT NULL, state jsonb NOT NULL, revision integer NOT NULL, PRIMARY KEY (tenant_id, owner))');
    });
  }
  async get(scope: Ownership): Promise<OwnerActionPolicy> {
    const result = await this.pool.query<{ state: unknown }>('SELECT state FROM aeeis_action_policies WHERE tenant_id=$1 AND owner=$2', [scope.tenantId, scope.owner]);
    return result.rows[0] ? ownerActionPolicySchema.parse(result.rows[0].state) : emptyOwnerActionPolicy(scope);
  }
  async change(scope: Ownership, change: OwnerActionPolicyChange, now = new Date().toISOString()): Promise<OwnerActionPolicy> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await postgresAdvisoryXactLock(client, 'aeeis:action-policies', `${scope.tenantId}\0${scope.owner}`);
      const result = await client.query<{ state: unknown }>('SELECT state FROM aeeis_action_policies WHERE tenant_id=$1 AND owner=$2', [scope.tenantId, scope.owner]);
      const current = result.rows[0] ? ownerActionPolicySchema.parse(result.rows[0].state) : emptyOwnerActionPolicy(scope);
      const next = applyOwnerActionPolicyChange(current, change, now);
      if (next !== current) {
        await client.query('INSERT INTO aeeis_action_policies(owner, tenant_id, state, revision) VALUES($1,$2,$3,$4) ON CONFLICT (tenant_id, owner) DO UPDATE SET state=EXCLUDED.state, revision=EXCLUDED.revision', [scope.owner, scope.tenantId, next, next.revision]);
      }
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

function key(scope: Ownership): string { return `${scope.tenantId}\u0000${scope.owner}`; }
