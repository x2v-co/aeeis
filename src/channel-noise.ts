import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type pg from 'pg';
import { createPostgresPool } from './adapters/postgres-pool.js';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { postgresAdvisoryXactLock } from './adapters/postgres-lock.js';
import type { Ownership } from './security/principal.js';

const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const channelNoiseSettingsSchema = z.object({
  mode: z.enum(['quiet', 'lively']).default('quiet'),
  digestMinutes: z.number().int().min(15).max(30).default(15),
  quietHours: z.object({
    start: clockTime, end: clockTime,
    timeZone: z.string().min(1).max(100).refine(value => {
      try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return !/^[+-]/.test(value); } catch { return false; }
    }, '请使用 IANA 时区，例如 Asia/Shanghai'),
  }).strict().refine(value => value.start !== value.end, '起止时间不能相同').nullable().default(null),
}).strict();
export type ChannelNoiseSettings = z.infer<typeof channelNoiseSettingsSchema>;
export const defaultChannelNoiseSettings = (): ChannelNoiseSettings => channelNoiseSettingsSchema.parse({});
export interface ChannelScope extends Ownership { roomId: string }

/** One classification for the write gate and all notification transports. Never infer urgency from prose. */
export function channelAttention(item: { kind?: string | undefined; type?: string | undefined; actorType?: string | undefined; idempotencyKey?: string | undefined; taskAction?: { kind: string } | undefined }): 'decision' | 'progress' | 'message' | 'human' {
  if (['approval', 'question', 'blocked', 'failure', 'escalation', 'channel-upgrade', 'needs_approval', 'needs_input', 'failed', 'unknown', 'waiting_external'].includes(item.kind ?? '') || item.type === 'decision' || ['block', 'hand_up'].includes(item.taskAction?.kind ?? '') || /^(bot-(?:fail|task-fail|escalate|propose(?:-receipt|-mark)?)|handoff-escalate):/.test(item.idempotencyKey ?? '')) return 'decision';
  const automatic = item.kind === 'progress' || item.kind === 'message' || item.actorType === 'agent' || item.actorType === 'system' || /^(bot-|handoff[:-])/.test(item.idempotencyKey ?? '');
  if (!automatic) return 'human';
  return item.kind === 'progress' || item.type === 'task_update' || item.type === 'system' ? 'progress' : 'message';
}
export function inChannelQuietHours(settings: ChannelNoiseSettings, at: number): boolean {
  const hours = settings.quietHours;
  if (!hours) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: hours.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const local = `${parts.find(part => part.type === 'hour')!.value}:${parts.find(part => part.type === 'minute')!.value}`;
  return hours.start < hours.end ? local >= hours.start && local < hours.end : local >= hours.start || local < hours.end;
}

export interface ChannelNoiseStore {
  init?(): Promise<void>;
  get(scope: ChannelScope): Promise<ChannelNoiseSettings>;
  put(scope: ChannelScope, input: unknown): Promise<ChannelNoiseSettings>;
  /** Serializes the gate, the digest pump and setting changes for a channel, including across server processes. */
  withRoom<T>(scope: ChannelScope, work: (settings: ChannelNoiseSettings) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
const keyOf = (scope: ChannelScope) => JSON.stringify([scope.tenantId, scope.owner, scope.roomId]);
export class InMemoryChannelNoiseStore implements ChannelNoiseStore {
  protected rows: Record<string, ChannelNoiseSettings> = {};
  private queue: Promise<unknown> = Promise.resolve();
  async get(scope: ChannelScope): Promise<ChannelNoiseSettings> { return structuredClone(this.rows[keyOf(scope)] ?? defaultChannelNoiseSettings()); }
  async put(scope: ChannelScope, input: unknown): Promise<ChannelNoiseSettings> {
    const parsed = channelNoiseSettingsSchema.parse(input);
    return this.withRoom(scope, async () => { const rows = { ...this.rows, [keyOf(scope)]: parsed }; await this.persist(rows); return structuredClone(parsed); });
  }
  withRoom<T>(_scope: ChannelScope, work: (settings: ChannelNoiseSettings) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => work(await this.get(_scope)));
    this.queue = next.catch(() => undefined); return next;
  }
  protected async persist(rows: Record<string, ChannelNoiseSettings>): Promise<void> { this.rows = rows; }
  async close(): Promise<void> { await this.queue; }
}
/** The event store already enforces a single local writer; settings use the same private, atomic-file convention. */
export class JsonChannelNoiseStore extends InMemoryChannelNoiseStore {
  constructor(private readonly path: string) { super(); }
  async init(): Promise<void> {
    try { this.rows = z.record(z.string(), channelNoiseSettingsSchema).parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  protected override async persist(rows: Record<string, ChannelNoiseSettings>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify(rows)}\n`); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path); this.rows = rows;
    } finally { await unlink(temp).catch(() => undefined); }
  }
}

export const channelNoiseMigration = `CREATE TABLE IF NOT EXISTS aeeis_channel_noise_settings (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  room_id text NOT NULL,
  settings jsonb NOT NULL,
  PRIMARY KEY (tenant_id, owner, room_id)
);
ALTER TABLE aeeis_channel_noise_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON aeeis_channel_noise_settings;
CREATE POLICY aeeis_tenant ON aeeis_channel_noise_settings
  USING (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true));
`;
export class PostgresChannelNoiseStore implements ChannelNoiseStore {
  private readonly pool: pg.Pool;
  constructor(url: string) { this.pool = createPostgresPool(url); }
  async init(): Promise<void> { await withPostgresMigrationLock(this.pool, 'channel-noise', async client => { await client.query(channelNoiseMigration); }); }
  async get(scope: ChannelScope): Promise<ChannelNoiseSettings> {
    const result = await this.pool.query('SELECT settings FROM aeeis_channel_noise_settings WHERE tenant_id=$1 AND owner=$2 AND room_id=$3', [scope.tenantId, scope.owner, scope.roomId]);
    return result.rows[0] ? channelNoiseSettingsSchema.parse(result.rows[0].settings) : defaultChannelNoiseSettings();
  }
  async put(scope: ChannelScope, input: unknown): Promise<ChannelNoiseSettings> {
    const parsed = channelNoiseSettingsSchema.parse(input);
    return this.lock(scope, async client => {
      await client.query('INSERT INTO aeeis_channel_noise_settings(tenant_id,owner,room_id,settings) VALUES($1,$2,$3,$4) ON CONFLICT (tenant_id,owner,room_id) DO UPDATE SET settings=EXCLUDED.settings', [scope.tenantId, scope.owner, scope.roomId, parsed]);
      return parsed;
    });
  }
  withRoom<T>(scope: ChannelScope, work: (settings: ChannelNoiseSettings) => Promise<T>): Promise<T> { return this.lock(scope, async client => {
    const result = await client.query('SELECT settings FROM aeeis_channel_noise_settings WHERE tenant_id=$1 AND owner=$2 AND room_id=$3', [scope.tenantId, scope.owner, scope.roomId]);
    return work(result.rows[0] ? channelNoiseSettingsSchema.parse(result.rows[0].settings) : defaultChannelNoiseSettings());
  }); }
  private async lock<T>(scope: ChannelScope, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await postgresAdvisoryXactLock(client, 'aeeis:channel-noise', keyOf(scope));
      const result = await work(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
