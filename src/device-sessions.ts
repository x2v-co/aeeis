import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import type { Ownership } from './security/principal.js';

export const deviceIdSchema = z.string().regex(/^device_[0-9a-f-]{36}$/);
export const deviceCapabilitySchema = z.enum(['read', 'approve', 'execute', 'local_access']);
export type DeviceCapability = z.infer<typeof deviceCapabilitySchema>;
export const deviceSessionSchema = z.object({
  schemaVersion: z.literal(1),
  id: deviceIdSchema,
  owner: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  capabilities: z.array(deviceCapabilitySchema).min(1).max(4),
  createdAt: z.string().datetime({ offset: true }),
  lastSeenAt: z.string().datetime({ offset: true }),
  revokedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type DeviceSession = z.infer<typeof deviceSessionSchema>;

export interface DeviceSessionRepository {
  init?(): Promise<void>;
  register(input: { owner: string; tenantId: string; label: string; capabilities: DeviceCapability[]; now?: string }): Promise<DeviceSession>;
  get(id: string, scope?: Ownership): Promise<DeviceSession | undefined>;
  list(scope: Ownership): Promise<DeviceSession[]>;
  touch(id: string, scope: Ownership, now?: string): Promise<DeviceSession>;
  revoke(id: string, scope: Ownership, now?: string): Promise<DeviceSession>;
  close?(): Promise<void>;
}

export class DeviceSessionNotFound extends Error {}
export class DeviceSessionConflict extends Error {}

function clone<T>(value: T): T { return structuredClone(value); }
function owned(session: DeviceSession, scope: Ownership): boolean { return session.owner === scope.owner && session.tenantId === scope.tenantId; }
function normalizeCapabilities(capabilities: DeviceCapability[]): DeviceCapability[] { return [...new Set(capabilities)]; }
function makeSession(input: { owner: string; tenantId: string; label: string; capabilities: DeviceCapability[]; now?: string }): DeviceSession {
  const now = input.now ?? new Date().toISOString();
  return deviceSessionSchema.parse({ schemaVersion: 1, id: `device_${randomUUID()}`, owner: input.owner, tenantId: input.tenantId, label: input.label, capabilities: normalizeCapabilities(input.capabilities), createdAt: now, lastSeenAt: now });
}

export class InMemoryDeviceSessionRepository implements DeviceSessionRepository {
  private readonly sessions = new Map<string, DeviceSession>();
  async register(input: { owner: string; tenantId: string; label: string; capabilities: DeviceCapability[]; now?: string }): Promise<DeviceSession> {
    const session = makeSession(input); this.sessions.set(session.id, session); return clone(session);
  }
  async get(id: string, scope?: Ownership): Promise<DeviceSession | undefined> {
    const session = this.sessions.get(id); return session && (!scope || owned(session, scope)) ? clone(session) : undefined;
  }
  async list(scope: Ownership): Promise<DeviceSession[]> {
    return [...this.sessions.values()].filter(session => owned(session, scope)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone);
  }
  async touch(id: string, scope: Ownership, now = new Date().toISOString()): Promise<DeviceSession> {
    const current = await this.get(id, scope); if (!current) throw new DeviceSessionNotFound('Unknown device session');
    const next = deviceSessionSchema.parse({ ...current, lastSeenAt: now }); this.sessions.set(id, next); return clone(next);
  }
  async revoke(id: string, scope: Ownership, now = new Date().toISOString()): Promise<DeviceSession> {
    const current = await this.get(id, scope); if (!current) throw new DeviceSessionNotFound('Unknown device session');
    if (current.revokedAt) return current;
    const next = deviceSessionSchema.parse({ ...current, revokedAt: now }); this.sessions.set(id, next); return clone(next);
  }
  async close(): Promise<void> {}
}

interface FileState { sessions: DeviceSession[] }
export class JsonDeviceSessionRepository implements DeviceSessionRepository {
  private state: FileState = { sessions: [] };
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  async init(): Promise<void> { await this.serial(async () => this.load()); }
  async register(input: { owner: string; tenantId: string; label: string; capabilities: DeviceCapability[]; now?: string }): Promise<DeviceSession> { return this.serial(async () => { await this.load(); const session = makeSession(input); await this.save({ sessions: [...this.state.sessions, session] }); return clone(session); }); }
  async get(id: string, scope?: Ownership): Promise<DeviceSession | undefined> { await this.init(); const session = this.state.sessions.find(item => item.id === id); return session && (!scope || owned(session, scope)) ? clone(session) : undefined; }
  async list(scope: Ownership): Promise<DeviceSession[]> { await this.init(); return this.state.sessions.filter(session => owned(session, scope)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone); }
  async touch(id: string, scope: Ownership, now = new Date().toISOString()): Promise<DeviceSession> { return this.mutate(id, scope, current => ({ ...current, lastSeenAt: now })); }
  async revoke(id: string, scope: Ownership, now = new Date().toISOString()): Promise<DeviceSession> { return this.mutate(id, scope, current => ({ ...current, revokedAt: current.revokedAt ?? now })); }
  async close(): Promise<void> { await this.queue; }
  private async mutate(id: string, scope: Ownership, change: (current: DeviceSession) => DeviceSession): Promise<DeviceSession> { return this.serial(async () => { await this.load(); const index = this.state.sessions.findIndex(item => item.id === id && owned(item, scope)); if (index < 0) throw new DeviceSessionNotFound('Unknown device session'); const next = deviceSessionSchema.parse(change(this.state.sessions[index]!)); const sessions = [...this.state.sessions]; sessions[index] = next; await this.save({ sessions }); return clone(next); }); }
  private async load(): Promise<void> { if (this.loaded) return; try { const parsed = JSON.parse(await readFile(this.path, 'utf8')) as FileState; this.state = { sessions: z.array(deviceSessionSchema).parse(parsed.sessions) }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } this.loaded = true; }
  private async save(next: FileState): Promise<void> { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); const temp = `${this.path}.${randomUUID()}.tmp`; try { const file = await open(temp, 'wx', 0o600); try { await file.writeFile(`${JSON.stringify(next)}\n`); await file.sync(); } finally { await file.close(); } await rename(temp, this.path); this.state = next; } finally { await unlink(temp).catch(() => undefined); } }
}

export class PostgresDeviceSessionRepository implements DeviceSessionRepository {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> { await withPostgresMigrationLock(this.pool, 'device-sessions', async client => { await client.query(`CREATE TABLE IF NOT EXISTS aeeis_device_sessions (id text PRIMARY KEY, owner text NOT NULL, tenant_id text NOT NULL, state jsonb NOT NULL, created_at timestamptz NOT NULL, revoked_at timestamptz NULL); CREATE INDEX IF NOT EXISTS aeeis_device_sessions_scope_idx ON aeeis_device_sessions(owner, tenant_id, created_at);`); }); }
  async register(input: { owner: string; tenantId: string; label: string; capabilities: DeviceCapability[]; now?: string }): Promise<DeviceSession> { const session = makeSession(input); await this.pool.query('INSERT INTO aeeis_device_sessions(id,owner,tenant_id,state,created_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6)', [session.id, session.owner, session.tenantId, session, session.createdAt, null]); return clone(session); }
  async get(id: string, scope?: Ownership): Promise<DeviceSession | undefined> { const result = await this.pool.query<{ state: DeviceSession }>('SELECT state FROM aeeis_device_sessions WHERE id=$1', [id]); const session = result.rows[0]?.state; return session && (!scope || owned(session, scope)) ? deviceSessionSchema.parse(session) : undefined; }
  async list(scope: Ownership): Promise<DeviceSession[]> { const result = await this.pool.query<{ state: DeviceSession }>('SELECT state FROM aeeis_device_sessions WHERE owner=$1 AND tenant_id=$2 ORDER BY created_at, id', [scope.owner, scope.tenantId]); return result.rows.map(row => deviceSessionSchema.parse(row.state)); }
  async touch(id: string, scope: Ownership, now = new Date().toISOString()): Promise<DeviceSession> { return this.update(id, scope, current => ({ ...current, lastSeenAt: now })); }
  async revoke(id: string, scope: Ownership, now = new Date().toISOString()): Promise<DeviceSession> { return this.update(id, scope, current => ({ ...current, revokedAt: current.revokedAt ?? now })); }
  async close(): Promise<void> { await this.pool.end(); }
  private async update(id: string, scope: Ownership, change: (current: DeviceSession) => DeviceSession): Promise<DeviceSession> { const client = await this.pool.connect(); try { await client.query('BEGIN'); const result = await client.query<{ state: DeviceSession }>('SELECT state FROM aeeis_device_sessions WHERE id=$1 AND owner=$2 AND tenant_id=$3 FOR UPDATE', [id, scope.owner, scope.tenantId]); const current = result.rows[0]?.state; if (!current) throw new DeviceSessionNotFound('Unknown device session'); const next = deviceSessionSchema.parse(change(current)); await client.query('UPDATE aeeis_device_sessions SET state=$2, revoked_at=$3 WHERE id=$1', [id, next, next.revokedAt ?? null]); await client.query('COMMIT'); return clone(next); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
}
