import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { createPostgresPool } from './adapters/postgres-pool.js';
import { openAggregate, pick, sealAggregate } from './content-encryption.js';
import type { Principal } from './security/principal.js';
import type { PrincipalDirectory } from './security/principal-directory.js';

/**
 * The people of a tenant (stage 3a). Who may sign in is still configuration: the Google allow-list and the allowed
 * Workspace domain. This store only remembers what AEEIS learns about those people, per tenant: the address and
 * Google name from their last sign-in, and the display name an administrator gave them. Nothing here admits anyone.
 */
const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/);
/** A display name: one line, no control characters. */
export const displayNameSchema = z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value), '名字不能含控制字符');
const recordSchema = z.object({
  tenantId: identity,
  principalId: identity,
  email: z.string().max(320).optional(),
  googleName: z.string().max(200).optional(),
  displayName: z.string().max(80).optional(),
  /** How this person was admitted at their last sign-in. */
  via: z.enum(['listed', 'domain']).optional(),
  firstSignInAt: z.string().optional(),
  lastSignInAt: z.string().optional(),
  updatedAt: z.string(),
}).strict();
export type TenantMemberRecord = z.infer<typeof recordSchema>;
export interface SignInFacts { email: string; googleName?: string | undefined; via: 'listed' | 'domain' }

export interface TenantMemberStore {
  init?(): Promise<void>;
  /** Every record of one tenant, and only that tenant. */
  list(tenantId: string): Promise<TenantMemberRecord[]>;
  get(tenantId: string, principalId: string): Promise<TenantMemberRecord | undefined>;
  /** Read-modify-write of one record; `change` gets undefined for a new one. */
  update(tenantId: string, principalId: string, change: (current: TenantMemberRecord | undefined) => TenantMemberRecord): Promise<TenantMemberRecord>;
  close?(): Promise<void>;
}

const sameRow = (row: TenantMemberRecord, tenantId: string, principalId: string) => row.tenantId === tenantId && row.principalId === principalId;
function checked(next: TenantMemberRecord, tenantId: string, principalId: string): TenantMemberRecord {
  const parsed = recordSchema.parse(next);
  if (!sameRow(parsed, tenantId, principalId)) throw new Error('A tenant member record cannot move to another tenant or person');
  return parsed;
}

export class InMemoryTenantMemberStore implements TenantMemberStore {
  protected rows: TenantMemberRecord[] = [];
  async list(tenantId: string): Promise<TenantMemberRecord[]> { return structuredClone(this.rows.filter(row => row.tenantId === tenantId)); }
  async get(tenantId: string, principalId: string): Promise<TenantMemberRecord | undefined> { const row = this.rows.find(item => sameRow(item, tenantId, principalId)); return row ? structuredClone(row) : undefined; }
  async update(tenantId: string, principalId: string, change: (current: TenantMemberRecord | undefined) => TenantMemberRecord): Promise<TenantMemberRecord> {
    const next = checked(change(await this.get(tenantId, principalId)), tenantId, principalId);
    this.rows = [...this.rows.filter(row => !sameRow(row, tenantId, principalId)), next];
    return structuredClone(next);
  }
}

export class JsonTenantMemberStore implements TenantMemberStore {
  private rows: TenantMemberRecord[] = [];
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  async init(): Promise<void> { await this.serial(async () => this.load()); }
  async list(tenantId: string): Promise<TenantMemberRecord[]> { await this.init(); return structuredClone(this.rows.filter(row => row.tenantId === tenantId)); }
  async get(tenantId: string, principalId: string): Promise<TenantMemberRecord | undefined> { await this.init(); const row = this.rows.find(item => sameRow(item, tenantId, principalId)); return row ? structuredClone(row) : undefined; }
  async update(tenantId: string, principalId: string, change: (current: TenantMemberRecord | undefined) => TenantMemberRecord): Promise<TenantMemberRecord> {
    return this.serial(async () => {
      await this.load();
      const current = this.rows.find(item => sameRow(item, tenantId, principalId));
      const next = checked(change(current ? structuredClone(current) : undefined), tenantId, principalId);
      await this.save([...this.rows.filter(row => !sameRow(row, tenantId, principalId)), next]);
      return structuredClone(next);
    });
  }
  async close(): Promise<void> { await this.queue; }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try { this.rows = z.array(recordSchema).parse((JSON.parse(await readFile(this.path, 'utf8')) as { members?: unknown }).members ?? []); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.loaded = true;
  }
  private async save(rows: TenantMemberRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify({ members: rows })}\n`); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path); this.rows = rows;
    } finally { await unlink(temp).catch(() => undefined); }
  }
}

const AGGREGATE = 'tenant-member';
const sealMember = (record: TenantMemberRecord) => sealAggregate(AGGREGATE, record.tenantId, record.principalId, record, value => pick(value, ['principalId']));

/** Addresses and names are personal data: the row is sealed with the tenant's key when content encryption is on. */
export class PostgresTenantMemberStore implements TenantMemberStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = createPostgresPool(connectionString); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'tenant-members', async client => {
      await client.query('CREATE TABLE IF NOT EXISTS aeeis_tenant_members (tenant_id text NOT NULL, principal_id text NOT NULL, state jsonb NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY (tenant_id, principal_id))');
    });
  }
  async list(tenantId: string): Promise<TenantMemberRecord[]> {
    const result = await this.pool.query<{ principal_id: string; state: unknown }>('SELECT principal_id, state FROM aeeis_tenant_members WHERE tenant_id=$1 ORDER BY principal_id', [tenantId]);
    return Promise.all(result.rows.map(async row => recordSchema.parse(await openAggregate(AGGREGATE, row.principal_id, row.state))));
  }
  async get(tenantId: string, principalId: string): Promise<TenantMemberRecord | undefined> {
    const result = await this.pool.query<{ state: unknown }>('SELECT state FROM aeeis_tenant_members WHERE tenant_id=$1 AND principal_id=$2', [tenantId, principalId]);
    return result.rows[0] ? recordSchema.parse(await openAggregate(AGGREGATE, principalId, result.rows[0].state)) : undefined;
  }
  async update(tenantId: string, principalId: string, change: (current: TenantMemberRecord | undefined) => TenantMemberRecord): Promise<TenantMemberRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ state: unknown }>('SELECT state FROM aeeis_tenant_members WHERE tenant_id=$1 AND principal_id=$2 FOR UPDATE', [tenantId, principalId]);
      const current = result.rows[0] ? recordSchema.parse(await openAggregate(AGGREGATE, principalId, result.rows[0].state)) : undefined;
      const next = checked(change(current), tenantId, principalId);
      await client.query('INSERT INTO aeeis_tenant_members(tenant_id, principal_id, state, updated_at) VALUES($1,$2,$3,$4) ON CONFLICT (tenant_id, principal_id) DO UPDATE SET state=EXCLUDED.state, updated_at=EXCLUDED.updated_at',
        [tenantId, principalId, await sealMember(next), next.updatedAt]);
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

/** An address on the Google allow-list and the person it signs in as. */
export interface ListedMember { email: string; principalId: string; tenantId: string }
export type MemberSource = 'listed' | 'domain' | 'self';
export interface MemberView {
  principalId: string;
  /** What the page shows: the display name, else the Google name, else the address, else the id. */
  name: string;
  displayName?: string;
  googleName?: string;
  email?: string;
  source: MemberSource;
  lastSignInAt?: string;
  isSelf: boolean;
}

/** Member names only: what a page or a model prompt may call someone. Never the address. */
export function memberLabel(record: Pick<TenantMemberRecord, 'displayName' | 'googleName'> | undefined): string | undefined {
  return record?.displayName ?? record?.googleName;
}
/** Only an administrator names people, because the name is the same for everyone in the tenant. */
export function canNameMembers(principal: Principal): boolean { return principal.roles.includes('operator'); }

/**
 * Who is in a tenant, as the page sees it: the allow-list entries for the tenant, everyone who has signed in to it
 * (domain sign-ins included), and the viewer. Every read takes the tenant from the viewer; there is no way to ask
 * about another tenant.
 */
export class TenantMembers {
  constructor(private readonly store: TenantMemberStore, private readonly listed: readonly ListedMember[] = [], private readonly directory?: PrincipalDirectory) {}

  async list(viewer: Principal): Promise<MemberView[]> {
    const records = new Map((await this.store.list(viewer.tenantId)).filter(record => record.tenantId === viewer.tenantId).map(record => [record.principalId, record]));
    const listed = new Map<string, string>();
    for (const entry of this.listed) if (entry.tenantId === viewer.tenantId && !listed.has(entry.principalId)) listed.set(entry.principalId, entry.email);
    const ids = new Set([...listed.keys(), ...records.keys(), viewer.id]);
    const views = await Promise.all([...ids].map(id => this.view(viewer, id, records.get(id), listed.get(id))));
    return views.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name, 'zh-CN') || a.principalId.localeCompare(b.principalId));
  }

  /** One person in the viewer's tenant, or undefined when the viewer's tenant has no such person. */
  async find(viewer: Principal, principalId: string): Promise<MemberView | undefined> {
    if (!identity.safeParse(principalId).success) return undefined;
    const record = await this.store.get(viewer.tenantId, principalId);
    const email = this.listed.find(entry => entry.tenantId === viewer.tenantId && entry.principalId === principalId)?.email;
    if (!record && email === undefined && principalId !== viewer.id) return undefined;
    return this.view(viewer, principalId, record?.tenantId === viewer.tenantId ? record : undefined, email);
  }

  /** The name to show for someone in a tenant, for lines that name someone other than the reader. */
  async label(principalId: string, tenantId: string): Promise<string | undefined> {
    const own = memberLabel(await this.store.get(tenantId, principalId).catch(() => undefined));
    if (own) return own;
    return (await this.directory?.lookup(principalId, tenantId).catch(() => undefined))?.displayName;
  }

  async rename(viewer: Principal, principalId: string, displayName: string | undefined, now = new Date().toISOString()): Promise<MemberView | undefined> {
    if (!await this.find(viewer, principalId)) return undefined;
    const name = displayName === undefined ? undefined : displayNameSchema.parse(displayName);
    const record = await this.store.update(viewer.tenantId, principalId, current => {
      const { displayName: _old, ...rest } = current ?? { tenantId: viewer.tenantId, principalId, updatedAt: now };
      return { ...rest, ...(name ? { displayName: name } : {}), updatedAt: now };
    });
    return this.view(viewer, principalId, record, this.listed.find(entry => entry.tenantId === viewer.tenantId && entry.principalId === principalId)?.email);
  }

  /** Called after a successful sign-in. Keeps the display name an administrator gave. */
  async signedIn(principal: Principal, facts: SignInFacts, now = new Date().toISOString()): Promise<void> {
    await this.store.update(principal.tenantId, principal.id, current => {
      const base = current ?? { tenantId: principal.tenantId, principalId: principal.id, firstSignInAt: now, updatedAt: now };
      const { googleName: _old, ...rest } = base;
      const googleName = facts.googleName?.trim().slice(0, 200);
      return { ...rest, email: facts.email.slice(0, 320), ...(googleName ? { googleName } : {}), via: facts.via, firstSignInAt: base.firstSignInAt ?? now, lastSignInAt: now, updatedAt: now };
    });
  }

  private async view(viewer: Principal, principalId: string, record: TenantMemberRecord | undefined, listedEmail: string | undefined): Promise<MemberView> {
    const isSelf = principalId === viewer.id;
    const email = record?.email ?? listedEmail;
    const directoryName = memberLabel(record) ? undefined : (await this.directory?.lookup(principalId, viewer.tenantId).catch(() => undefined))?.displayName;
    const source: MemberSource = listedEmail !== undefined || record?.via === 'listed' ? 'listed' : record?.via === 'domain' ? 'domain' : 'self';
    return {
      principalId,
      name: memberLabel(record) ?? directoryName ?? email ?? principalId,
      ...(record?.displayName ? { displayName: record.displayName } : {}),
      ...(record?.googleName ? { googleName: record.googleName } : {}),
      ...(email ? { email } : {}),
      source,
      ...(record?.lastSignInAt ? { lastSignInAt: record.lastSignInAt } : {}),
      isSelf,
    };
  }
}
