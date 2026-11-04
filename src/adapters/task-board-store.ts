import { acquireFileWriter, releaseFileWriter } from './file-writer-lock.js';
import { persistBoardAction } from '../task-board-controls.js';
import type { SessionEvent } from '../session-events.js';
import pg from 'pg';
import { mkdir, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createPostgresPool } from './postgres-pool.js';
import { withPostgresMigrationLock } from './postgres-migration.js';

export const taskBoardMigration = `-- PR3: relation and rebuildable control projection; audit stays in SessionEvent.
-- Rollback (stop commands/pump and export these tables first):
-- BEGIN; DROP TABLE IF EXISTS aeeis_task_board_controls; DROP TABLE IF EXISTS aeeis_room_tasks; COMMIT;
-- Revert init/TENANT_POLICIES too; retain a reader for channel-task-action/2 audits.
CREATE TABLE IF NOT EXISTS aeeis_room_tasks (
  tenant_id text NOT NULL, owner text NOT NULL, room_id text NOT NULL,
  conversation_id text NOT NULL, task_id text NOT NULL, source_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, room_id, conversation_id, task_id)
);
CREATE INDEX IF NOT EXISTS aeeis_room_tasks_task_idx ON aeeis_room_tasks (tenant_id, owner, conversation_id, task_id);
CREATE TABLE IF NOT EXISTS aeeis_task_board_controls (
  tenant_id text NOT NULL, owner text NOT NULL, room_id text NOT NULL,
  conversation_id text NOT NULL, task_id text NOT NULL, version bigint NOT NULL DEFAULT 0,
  observed_run_id text, observed_run_revision bigint,
  override_column text CHECK (override_column IN ('capture','ready','doing','blocked','review','done')),
  accepted_run_id text, last_action_event_id text, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, room_id, conversation_id, task_id),
  CHECK ((observed_run_id IS NULL) = (observed_run_revision IS NULL))
);
ALTER TABLE aeeis_room_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON aeeis_room_tasks;
CREATE POLICY aeeis_tenant ON aeeis_room_tasks
  USING (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true));
ALTER TABLE aeeis_task_board_controls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON aeeis_task_board_controls;
CREATE POLICY aeeis_tenant ON aeeis_task_board_controls
  USING (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true));
`;
const relationSchema = z.object({ tenantId: z.string(), owner: z.string(), roomId: z.string(), conversationId: z.string(), taskId: z.string(), sourceId: z.string() }).strict();
export type RoomTask = z.infer<typeof relationSchema>;
export interface TaskBoardStore {
  repair?(events: SessionEvent[]): Promise<void>;
  init(): Promise<void>;
  link(relation: RoomTask): Promise<void>;
  list(roomId: string, owner: string, tenantId: string): Promise<RoomTask[]>;
  /** Bounded cyclic recovery inventory, including inactive rooms. */
  page(after?: string, limit?: number): Promise<{ items: RoomTask[]; next?: string }>;
  close(): Promise<void>;
}
const key = (row: RoomTask) => JSON.stringify([row.tenantId, row.owner, row.roomId, row.conversationId, row.taskId]);
export class InMemoryTaskBoardStore implements TaskBoardStore {
  protected rows: RoomTask[] = [];
  async init(): Promise<void> {}
  async link(row: RoomTask): Promise<void> { relationSchema.parse(row); if (!this.rows.some(item => key(item) === key(row))) this.rows.push(structuredClone(row)); }
  async list(roomId: string, owner: string, tenantId: string): Promise<RoomTask[]> { return structuredClone(this.rows.filter(row => row.roomId === roomId && row.owner === owner && row.tenantId === tenantId)); }
  async page(after?: string, limit = 25): Promise<{ items: RoomTask[]; next?: string }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Invalid board scan limit');
    const rows = this.rows.filter(row => !after || key(row) > after).sort((a,b) => key(a) < key(b) ? -1 : 1);
    const items = structuredClone(rows.slice(0, limit)); return { items, ...(rows.length > limit ? { next: key(items.at(-1)!) } : {}) };
  }
  async close(): Promise<void> {}
}
/** SessionEvent is the durable operation journal. A crash between that atomic
 * fsync/rename and relation repair is recovered by the next board read/sweep. */
export class FileTaskBoardStore extends InMemoryTaskBoardStore {
  private lock: { handle: FileHandle; token: string } | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) { super(); }
  override async init(): Promise<void> {
    if (this.lock) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.lock = await acquireFileWriter(`${this.path}.lock`);
    try { this.rows = z.array(relationSchema).parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await this.close(); throw error; } }
  }
  override link(row: RoomTask): Promise<void> {
    const work = this.queue.then(async () => {
      if (!this.lock) throw new Error('Task board store is closed');
      relationSchema.parse(row); if (this.rows.some(item => key(item) === key(row))) return;
      const rows = [...this.rows, row], temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(rows)); await file.sync(); } finally { await file.close(); }
        await rename(temp, this.path);
        const directory = await open(dirname(this.path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
        this.rows = rows;
      } finally { await unlink(temp).catch(() => undefined); }
    });
    this.queue = work.catch(() => undefined); return work;
  }
  override async close(): Promise<void> { await this.queue; if (this.lock) { await releaseFileWriter(`${this.path}.lock`,this.lock); this.lock = undefined; } }
}
export class PostgresTaskBoardStore implements TaskBoardStore {
  private readonly pool: pg.Pool;
  constructor(url: string) { this.pool = createPostgresPool(url); }
  async init(): Promise<void> { await withPostgresMigrationLock(this.pool, 'task-board-controls', client => client.query(taskBoardMigration).then(() => undefined)); }
  async link(row: RoomTask): Promise<void> {
    relationSchema.parse(row);
    await this.pool.query(`INSERT INTO aeeis_room_tasks(tenant_id,owner,room_id,conversation_id,task_id,source_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [row.tenantId,row.owner,row.roomId,row.conversationId,row.taskId,row.sourceId]);
  }
  async repair(events: SessionEvent[]): Promise<void> {
    if (!events.length) return;
    const client = await this.pool.connect(), first = events[0]!;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${first.tenantId}:${first.owner}:${first.roomId}`]);
      for (const event of events) await persistBoardAction(client,event);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  async list(roomId: string, owner: string, tenantId: string): Promise<RoomTask[]> {
    const result = await this.pool.query('SELECT * FROM aeeis_room_tasks WHERE room_id=$1 AND owner=$2 AND tenant_id=$3 ORDER BY conversation_id,task_id', [roomId,owner,tenantId]); return result.rows.map(decode);
  }
  async page(after?: string, limit = 25): Promise<{ items: RoomTask[]; next?: string }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Invalid board scan limit');
    const parts = after ? z.array(z.string()).length(5).parse(JSON.parse(after)) : ['', '', '', '', ''];
    const result = await this.pool.query(`SELECT * FROM aeeis_room_tasks WHERE (tenant_id,owner,room_id,conversation_id,task_id)>($1,$2,$3,$4,$5) ORDER BY tenant_id,owner,room_id,conversation_id,task_id LIMIT $6`, [...parts,limit + 1]);
    const items = result.rows.slice(0,limit).map(decode); return { items, ...(result.rows.length > limit ? { next: key(items.at(-1)!) } : {}) };
  }
  async close(): Promise<void> { await this.pool.end(); }
}
function decode(row: Record<string,string>): RoomTask { return relationSchema.parse({ tenantId: row.tenant_id, owner: row.owner, roomId: row.room_id, conversationId: row.conversation_id, taskId: row.task_id, sourceId: row.source_id }); }
