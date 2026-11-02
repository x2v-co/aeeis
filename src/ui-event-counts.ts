import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { createPostgresPool } from './adapters/postgres-pool.js';
import type { Ownership } from './security/principal.js';

/** Interaction-design §18.2 events that only the browser sees. Everything else in §18 is read from the room's events,
 * task actions and Runs, which already record it. Only the name, the room and the day are kept: no text, no refs. */
export const uiEventNameSchema = z.enum(['ui.channel.open', 'ui.artifact.view', 'ui.evidence.open', 'ui.digest.view', 'ui.studio.open']);
export type UiEventName = z.infer<typeof uiEventNameSchema>;
export const uiEventInputSchema = z.object({
  name: uiEventNameSchema,
  roomId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/),
}).strict();
export type UiEventInput = z.infer<typeof uiEventInputSchema>;
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const countSchema = z.object({ owner: z.string().min(1).max(200), tenantId: z.string().min(1).max(200), roomId: uiEventInputSchema.shape.roomId, day: daySchema, name: uiEventNameSchema, count: z.number().int().positive() }).strict();
type CountRow = z.infer<typeof countSchema>;

export type UiEventCounts = Record<UiEventName, number>;
export function emptyUiEventCounts(): UiEventCounts {
  return Object.fromEntries(uiEventNameSchema.options.map(name => [name, 0])) as UiEventCounts;
}
/** UTC day of an instant. */
export function uiEventDay(at: string): string { return at.slice(0, 10); }

export interface UiEventCountStore {
  init?(): Promise<void>;
  record(scope: Ownership, input: UiEventInput, at?: string): Promise<void>;
  /** Counts for one room over the inclusive UTC day range. */
  counts(scope: Ownership, roomId: string, fromDay: string, toDay: string): Promise<UiEventCounts>;
  close?(): Promise<void>;
}

function sum(rows: readonly CountRow[], scope: Ownership, roomId: string, fromDay: string, toDay: string): UiEventCounts {
  const counts = emptyUiEventCounts();
  for (const row of rows) if (row.owner === scope.owner && row.tenantId === scope.tenantId && row.roomId === roomId && row.day >= fromDay && row.day <= toDay) counts[row.name] += row.count;
  return counts;
}
function bump(rows: readonly CountRow[], scope: Ownership, input: UiEventInput, day: string): CountRow[] {
  const index = rows.findIndex(row => row.owner === scope.owner && row.tenantId === scope.tenantId && row.roomId === input.roomId && row.day === day && row.name === input.name);
  if (index < 0) return [...rows, countSchema.parse({ owner: scope.owner, tenantId: scope.tenantId, roomId: input.roomId, day, name: input.name, count: 1 })];
  const next = [...rows];
  next[index] = { ...rows[index]!, count: rows[index]!.count + 1 };
  return next;
}

export class InMemoryUiEventCountStore implements UiEventCountStore {
  private rows: CountRow[] = [];
  async record(scope: Ownership, input: UiEventInput, at = new Date().toISOString()): Promise<void> { this.rows = bump(this.rows, scope, uiEventInputSchema.parse(input), uiEventDay(at)); }
  async counts(scope: Ownership, roomId: string, fromDay: string, toDay: string): Promise<UiEventCounts> { return sum(this.rows, scope, roomId, fromDay, toDay); }
}

export class JsonUiEventCountStore implements UiEventCountStore {
  private rows: CountRow[] = [];
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  async init(): Promise<void> { await this.serial(async () => this.load()); }
  async record(scope: Ownership, input: UiEventInput, at = new Date().toISOString()): Promise<void> {
    const parsed = uiEventInputSchema.parse(input);
    await this.serial(async () => { await this.load(); await this.save(bump(this.rows, scope, parsed, uiEventDay(at))); });
  }
  async counts(scope: Ownership, roomId: string, fromDay: string, toDay: string): Promise<UiEventCounts> { await this.init(); return sum(this.rows, scope, roomId, fromDay, toDay); }
  async close(): Promise<void> { await this.queue; }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try { this.rows = z.array(countSchema).parse((JSON.parse(await readFile(this.path, 'utf8')) as { counts?: unknown }).counts ?? []); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.loaded = true;
  }
  private async save(rows: CountRow[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify({ counts: rows })}\n`); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path); this.rows = rows;
    } finally { await unlink(temp).catch(() => undefined); }
  }
}

export class PostgresUiEventCountStore implements UiEventCountStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = createPostgresPool(connectionString); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'ui-event-counts', async client => {
      await client.query('CREATE TABLE IF NOT EXISTS aeeis_ui_event_counts (tenant_id text NOT NULL, owner text NOT NULL, room_id text NOT NULL, day date NOT NULL, name text NOT NULL, count integer NOT NULL, PRIMARY KEY (tenant_id, owner, room_id, day, name))');
    });
  }
  async record(scope: Ownership, input: UiEventInput, at = new Date().toISOString()): Promise<void> {
    const parsed = uiEventInputSchema.parse(input);
    await this.pool.query('INSERT INTO aeeis_ui_event_counts(tenant_id, owner, room_id, day, name, count) VALUES($1,$2,$3,$4,$5,1) ON CONFLICT (tenant_id, owner, room_id, day, name) DO UPDATE SET count = aeeis_ui_event_counts.count + 1', [scope.tenantId, scope.owner, parsed.roomId, uiEventDay(at), parsed.name]);
  }
  async counts(scope: Ownership, roomId: string, fromDay: string, toDay: string): Promise<UiEventCounts> {
    const result = await this.pool.query<{ name: string; total: string }>('SELECT name, SUM(count)::text AS total FROM aeeis_ui_event_counts WHERE tenant_id=$1 AND owner=$2 AND room_id=$3 AND day BETWEEN $4 AND $5 GROUP BY name', [scope.tenantId, scope.owner, roomId, fromDay, toDay]);
    const counts = emptyUiEventCounts();
    for (const row of result.rows) { const name = uiEventNameSchema.safeParse(row.name); if (name.success) counts[name.data] = Number(row.total); }
    return counts;
  }
  async close(): Promise<void> { await this.pool.end(); }
}
