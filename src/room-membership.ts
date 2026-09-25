import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { z } from 'zod';

export const roomMemberRoleSchema = z.enum(['owner', 'editor', 'viewer', 'agent']);
export type RoomMemberRole = z.infer<typeof roomMemberRoleSchema>;
export const roomMemberStatusSchema = z.enum(['active', 'revoked']);
export type RoomMemberStatus = z.infer<typeof roomMemberStatusSchema>;

export interface RoomMember {
  id: string;
  roomId: string;
  principalId: string;
  tenantId: string;
  role: RoomMemberRole;
  status: RoomMemberStatus;
  invitedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoomMembershipRepository {
  add(roomId: string, principalId: string, tenantId: string, role: Exclude<RoomMemberRole, 'owner'>, invitedBy: string, now?: string): Promise<RoomMember>;
  get(roomId: string, principalId: string, tenantId: string): Promise<RoomMember | undefined>;
  list(roomId: string, tenantId: string): Promise<RoomMember[]>;
  listForRooms?(roomIds: readonly string[]): Promise<RoomMember[]>;
  activeRoomIds(principalId: string, tenantId: string): Promise<string[]>;
  revoke(roomId: string, principalId: string, tenantId: string, revokedBy: string, now?: string): Promise<RoomMember>;
  close(): Promise<void>;
}

export class RoomMembershipNotFound extends Error {}
export class RoomMembershipConflict extends Error {}

export class InMemoryRoomMembershipRepository implements RoomMembershipRepository {
  private readonly members = new Map<string, RoomMember>();
  async add(roomId: string, principalId: string, tenantId: string, role: Exclude<RoomMemberRole, 'owner'>, invitedBy: string, now = new Date().toISOString()): Promise<RoomMember> {
    const key = keyOf(roomId, principalId, tenantId);
    const existing = this.members.get(key);
    const member: RoomMember = existing
      ? { ...existing, role, status: 'active', invitedBy, updatedAt: now }
      : { id: memberId(roomId, principalId, tenantId), roomId, principalId, tenantId, role, status: 'active', invitedBy, createdAt: now, updatedAt: now };
    this.members.set(key, structuredClone(member));
    return structuredClone(member);
  }
  async get(roomId: string, principalId: string, tenantId: string): Promise<RoomMember | undefined> { const member = this.members.get(keyOf(roomId, principalId, tenantId)); return member ? structuredClone(member) : undefined; }
  async list(roomId: string, tenantId: string): Promise<RoomMember[]> { return structuredClone([...this.members.values()].filter(member => member.roomId === roomId && member.tenantId === tenantId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))); }
  async listForRooms(roomIds: readonly string[]): Promise<RoomMember[]> {
    const ids = new Set(roomIds);
    return structuredClone([...this.members.values()].filter(member => ids.has(member.roomId)).sort((a, b) => a.roomId.localeCompare(b.roomId) || a.createdAt.localeCompare(b.createdAt) || a.principalId.localeCompare(b.principalId)));
  }
  async activeRoomIds(principalId: string, tenantId: string): Promise<string[]> {
    return [...this.members.values()].filter(member => member.principalId === principalId && member.tenantId === tenantId && member.status === 'active').map(member => member.roomId);
  }
  async revoke(roomId: string, principalId: string, tenantId: string, revokedBy: string, now = new Date().toISOString()): Promise<RoomMember> {
    const key = keyOf(roomId, principalId, tenantId);
    const current = this.members.get(key);
    if (!current) throw new RoomMembershipNotFound(`Unknown room member: ${principalId}`);
    const next = { ...current, status: 'revoked' as const, invitedBy: revokedBy, updatedAt: now };
    this.members.set(key, next);
    return structuredClone(next);
  }
  async close(): Promise<void> {}
}

interface FileState { members: RoomMember[] }
const emptyState = (): FileState => ({ members: [] });

export class JsonRoomMembershipRepository implements RoomMembershipRepository {
  private state = emptyState();
  private loaded = false;
  private lockOwned = false;
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
      throw new Error('Room membership store already has a live writer');
    }
    this.lockOwned = true;
    try { this.state = { ...emptyState(), ...(JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<FileState>) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await this.close(); throw error; } }
    this.loaded = true;
  }
  async add(roomId: string, principalId: string, tenantId: string, role: Exclude<RoomMemberRole, 'owner'>, invitedBy: string, now = new Date().toISOString()): Promise<RoomMember> {
    const current = this.state.members.find(member => member.roomId === roomId && member.principalId === principalId && member.tenantId === tenantId);
    const member: RoomMember = current
      ? { ...current, role, status: 'active', invitedBy, updatedAt: now }
      : { id: memberId(roomId, principalId, tenantId), roomId, principalId, tenantId, role, status: 'active', invitedBy, createdAt: now, updatedAt: now };
    this.persist({ ...this.state, members: replace(this.state.members, member) });
    return structuredClone(member);
  }
  async get(roomId: string, principalId: string, tenantId: string): Promise<RoomMember | undefined> { return clone(this.state.members.find(member => member.roomId === roomId && member.principalId === principalId && member.tenantId === tenantId)); }
  async list(roomId: string, tenantId: string): Promise<RoomMember[]> { return structuredClone(this.state.members.filter(member => member.roomId === roomId && member.tenantId === tenantId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))); }
  async listForRooms(roomIds: readonly string[]): Promise<RoomMember[]> {
    const ids = new Set(roomIds);
    return structuredClone(this.state.members.filter(member => ids.has(member.roomId)).sort((a, b) => a.roomId.localeCompare(b.roomId) || a.createdAt.localeCompare(b.createdAt) || a.principalId.localeCompare(b.principalId)));
  }
  async activeRoomIds(principalId: string, tenantId: string): Promise<string[]> {
    return this.state.members.filter(member => member.principalId === principalId && member.tenantId === tenantId && member.status === 'active').map(member => member.roomId);
  }
  async revoke(roomId: string, principalId: string, tenantId: string, revokedBy: string, now = new Date().toISOString()): Promise<RoomMember> {
    const current = this.state.members.find(member => member.roomId === roomId && member.principalId === principalId && member.tenantId === tenantId);
    if (!current) throw new RoomMembershipNotFound(`Unknown room member: ${principalId}`);
    const next = { ...current, status: 'revoked' as const, invitedBy: revokedBy, updatedAt: now };
    this.persist({ ...this.state, members: replace(this.state.members, next) });
    return structuredClone(next);
  }
  async close(): Promise<void> { if (this.lockOwned) { unlinkSync(`${this.filePath}.lock`); this.lockOwned = false; } this.loaded = false; }
  private persist(next: FileState): void {
    if (!this.loaded || !this.lockOwned) throw new Error('Room membership store is not open');
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600); writeSync(fd, `${JSON.stringify(next, null, 2)}\n`, undefined, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, this.filePath);
      const directory = openSync(dirname(this.filePath), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
      this.state = next;
    } catch (error) { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} throw error; }
  }
}

export class PostgresRoomMembershipRepository implements RoomMembershipRepository {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'room-memberships', async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_room_memberships (room_id text NOT NULL, principal_id text NOT NULL, tenant_id text NOT NULL, state jsonb NOT NULL, created_at timestamptz NOT NULL, PRIMARY KEY(room_id, principal_id, tenant_id)); CREATE INDEX IF NOT EXISTS aeeis_room_memberships_room_idx ON aeeis_room_memberships(room_id, tenant_id); CREATE INDEX IF NOT EXISTS aeeis_room_memberships_principal_idx ON aeeis_room_memberships(principal_id, tenant_id, room_id) WHERE state->>'status'='active';`);
    });
  }
  async add(roomId: string, principalId: string, tenantId: string, role: Exclude<RoomMemberRole, 'owner'>, invitedBy: string, now = new Date().toISOString()): Promise<RoomMember> {
    const existing = await this.get(roomId, principalId, tenantId);
    const member: RoomMember = existing
      ? { ...existing, role, status: 'active', invitedBy, updatedAt: now }
      : { id: memberId(roomId, principalId, tenantId), roomId, principalId, tenantId, role, status: 'active', invitedBy, createdAt: now, updatedAt: now };
    await this.pool.query(`INSERT INTO aeeis_room_memberships(room_id,principal_id,tenant_id,state,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(room_id,principal_id,tenant_id) DO UPDATE SET state=EXCLUDED.state`, [roomId, principalId, tenantId, member, member.createdAt]);
    return member;
  }
  async get(roomId: string, principalId: string, tenantId: string): Promise<RoomMember | undefined> { const result = await this.pool.query<{ state: RoomMember }>('SELECT state FROM aeeis_room_memberships WHERE room_id=$1 AND principal_id=$2 AND tenant_id=$3', [roomId, principalId, tenantId]); return result.rows[0]?.state; }
  async list(roomId: string, tenantId: string): Promise<RoomMember[]> { const result = await this.pool.query<{ state: RoomMember }>('SELECT state FROM aeeis_room_memberships WHERE room_id=$1 AND tenant_id=$2 ORDER BY created_at, principal_id', [roomId, tenantId]); return result.rows.map(row => row.state); }
  async listForRooms(roomIds: readonly string[]): Promise<RoomMember[]> {
    if (roomIds.length === 0) return [];
    const result = await this.pool.query<{ state: RoomMember }>('SELECT state FROM aeeis_room_memberships WHERE room_id=ANY($1::text[]) ORDER BY room_id, created_at, principal_id', [roomIds]);
    return result.rows.map(row => row.state);
  }
  async activeRoomIds(principalId: string, tenantId: string): Promise<string[]> {
    const result = await this.pool.query<{ room_id: string }>("SELECT room_id FROM aeeis_room_memberships WHERE principal_id=$1 AND tenant_id=$2 AND state->>'status'='active'", [principalId, tenantId]);
    return result.rows.map(row => row.room_id);
  }
  async revoke(roomId: string, principalId: string, tenantId: string, revokedBy: string, now = new Date().toISOString()): Promise<RoomMember> {
    const current = await this.get(roomId, principalId, tenantId);
    if (!current) throw new RoomMembershipNotFound(`Unknown room member: ${principalId}`);
    const next = { ...current, status: 'revoked' as const, invitedBy: revokedBy, updatedAt: now };
    await this.pool.query('UPDATE aeeis_room_memberships SET state=$4 WHERE room_id=$1 AND principal_id=$2 AND tenant_id=$3', [roomId, principalId, tenantId, next]);
    return next;
  }
  async close(): Promise<void> { await this.pool.end(); }
}

function keyOf(roomId: string, principalId: string, tenantId: string): string { return `${tenantId}:${roomId}:${principalId}`; }
function memberId(roomId: string, principalId: string, tenantId: string): string { return `room_member_${createHash('sha256').update(keyOf(roomId, principalId, tenantId)).digest('hex').slice(0, 32)}`; }
function replace(items: RoomMember[], item: RoomMember): RoomMember[] { const index = items.findIndex(candidate => candidate.id === item.id); return index === -1 ? [...items, structuredClone(item)] : items.map((candidate, i) => i === index ? structuredClone(item) : candidate); }
function clone<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : structuredClone(value); }
