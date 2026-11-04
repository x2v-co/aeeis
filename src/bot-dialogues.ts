import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Ownership } from './security/principal.js';
import { createPostgresPool } from './adapters/postgres-pool.js';
import { postgresAdvisoryXactLock } from './adapters/postgres-lock.js';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { Conflict } from './runtime/engine.js';

export interface BotDialogue extends Ownership {
  botId: string; conversationId: string; roomId: string;
  phase: 'preparing' | 'backfilling' | 'ready' | 'conflict'; version: number;
  state: { roomIds: string[]; revision: number; highWater: Record<string, number>; conflict?: string; conflictRoomIds?: string[] };
  createdAt: string; updatedAt: string;
}
export interface DialogueAlias extends Ownership { aliasRoomId: string; canonicalRoomId: string; botId: string }
export interface DialogueOperation extends Ownership {
  operationKey: string; botId: string; kind: 'ensure' | 'import' | 'delivery'; sourceId: string;
  targetId?: string; status: 'pending' | 'completed' | 'conflict'; state: Record<string, string | number>;
}
/** All writes are made under withOwner. Each checkpoint is durable BEFORE its external side effect. */
export interface BotDialogueStore {
  init(): Promise<void>; close(): Promise<void>;
  withOwner<T>(scope: Ownership, work: () => Promise<T>): Promise<T>;
  list(scope: Ownership): Promise<BotDialogue[]>;
  put(value: BotDialogue): Promise<void>;
  aliases(scope: Ownership): Promise<DialogueAlias[]>;
  alias(value: DialogueAlias): Promise<void>;
  operations(scope: Ownership): Promise<DialogueOperation[]>;
  operation(value: DialogueOperation): Promise<void>;
}
const owned = (a: Ownership, b: Ownership) => a.owner === b.owner && a.tenantId === b.tenantId;
const key = (scope: Ownership, id: string) => JSON.stringify([scope.tenantId, scope.owner, id]);
type Rows = { bindings: Record<string, BotDialogue>; aliases: Record<string, DialogueAlias>; operations: Record<string, DialogueOperation> };
export class InMemoryBotDialogueStore implements BotDialogueStore {
  private readonly fence = new AsyncLocalStorage<string>();
  protected rows: Rows = { bindings: {}, aliases: {}, operations: {} };
  private queue: Promise<unknown> = Promise.resolve();
  async init(): Promise<void> {}
  async close(): Promise<void> { await this.queue; }
  withOwner<T>(scope: Ownership, work: () => Promise<T>): Promise<T> {
    const ownerKey = key(scope, 'owner');
    if (this.fence.getStore() === ownerKey) return work();
    const next = this.queue.then(() => this.fence.run(ownerKey, work)); this.queue = next.catch(() => undefined); return next;
  }
  async list(scope: Ownership): Promise<BotDialogue[]> { return structuredClone(Object.values(this.rows.bindings).filter(v => owned(v, scope))); }
  async aliases(scope: Ownership): Promise<DialogueAlias[]> { return structuredClone(Object.values(this.rows.aliases).filter(v => owned(v, scope))); }
  async operations(scope: Ownership): Promise<DialogueOperation[]> { return structuredClone(Object.values(this.rows.operations).filter(v => owned(v, scope))); }
  async put(value: BotDialogue): Promise<void> {
    if (Object.values(this.rows.bindings).some(v => owned(v, value) && v.botId !== value.botId && (v.roomId === value.roomId || v.conversationId === value.conversationId))) throw new Conflict('Duplicate dialogue address');
    await this.save({ ...this.rows, bindings: { ...this.rows.bindings, [key(value, value.botId)]: structuredClone(value) } });
  }
  async alias(value: DialogueAlias): Promise<void> {
    const binding = (await this.list(value)).find(v => v.botId === value.botId && v.roomId === value.canonicalRoomId);
    if (!binding || value.aliasRoomId === value.canonicalRoomId || (await this.list(value)).some(v => v.roomId === value.aliasRoomId)) throw new Conflict('Invalid dialogue alias');
    const previous = this.rows.aliases[key(value, value.aliasRoomId)];
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Conflict('Dialogue alias already assigned');
    await this.save({ ...this.rows, aliases: { ...this.rows.aliases, [key(value, value.aliasRoomId)]: structuredClone(value) } });
  }
  async operation(value: DialogueOperation): Promise<void> {
    const previous = this.rows.operations[key(value, value.operationKey)];
    if (previous && (previous.botId !== value.botId || previous.kind !== value.kind || previous.sourceId !== value.sourceId)) throw new Conflict('Dialogue operation identity is immutable');
    if (Object.values(this.rows.operations).some(v => owned(v, value) && v.operationKey !== value.operationKey && v.botId === value.botId && v.kind === value.kind && v.sourceId === value.sourceId)) throw new Conflict('Duplicate dialogue source');
    await this.save({ ...this.rows, operations: { ...this.rows.operations, [key(value, value.operationKey)]: structuredClone(value) } });
  }
  protected async save(rows: Rows): Promise<void> { this.rows = rows; }
}
/** Same single-writer contract as FileConversationStore, with atomic, fsynced checkpoints. */
export class FileBotDialogueStore extends InMemoryBotDialogueStore {
  private lockToken: string | undefined;
  constructor(private readonly path: string) { super(); }
  override async init(): Promise<void> {
    if (this.lockToken) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const file = await open(`${this.path}.lock`, 'wx', 0o600);
        this.lockToken = `${process.pid}:${randomUUID()}`;
        try { await file.writeFile(this.lockToken); await file.sync(); } finally { await file.close(); }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const previous = await readFile(`${this.path}.lock`, 'utf8');
        const pid = Number(previous.split(':')[0]);
        if (!Number.isInteger(pid) || pid <= 0 || attempt) throw new Conflict('Dialogue file already has a writer');
        try { process.kill(pid, 0); throw new Conflict('Dialogue file already has a writer'); }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
        await unlink(`${this.path}.lock`);
      }
    }
    try {
      try { this.rows = JSON.parse(await readFile(this.path, 'utf8')) as Rows; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } catch (error) { await this.close(); throw error; }
  }
  override async close(): Promise<void> {
    await super.close();
    if (this.lockToken && await readFile(`${this.path}.lock`, 'utf8').catch(() => '') === this.lockToken) await unlink(`${this.path}.lock`);
    this.lockToken = undefined;
  }
  protected override async save(rows: Rows): Promise<void> {
    if (!this.lockToken) throw new Conflict('Dialogue file is closed');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(rows)); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
      const directory = await open(dirname(this.path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      this.rows = rows;
    } finally { await unlink(temp).catch(() => undefined); }
  }
}

export const botDialoguesMigration = `CREATE TABLE IF NOT EXISTS aeeis_bot_dialogues (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  bot_id text NOT NULL,
  conversation_id text NOT NULL,
  room_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('preparing', 'backfilling', 'ready', 'conflict')),
  version bigint NOT NULL DEFAULT 0,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, bot_id),
  UNIQUE (tenant_id, owner, conversation_id),
  UNIQUE (tenant_id, owner, room_id)
);
CREATE TABLE IF NOT EXISTS aeeis_bot_dialogue_room_aliases (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  alias_room_id text NOT NULL,
  canonical_room_id text NOT NULL,
  bot_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, alias_room_id),
  CHECK (alias_room_id <> canonical_room_id)
);
CREATE TABLE IF NOT EXISTS aeeis_bot_dialogue_operations (
  tenant_id text NOT NULL,
  owner text NOT NULL,
  operation_key text NOT NULL,
  bot_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ensure', 'import', 'delivery')),
  source_id text NOT NULL,
  target_id text,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'conflict')),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner, operation_key),
  UNIQUE (tenant_id, owner, bot_id, kind, source_id)
);
CREATE INDEX IF NOT EXISTS aeeis_bot_dialogue_operations_pending_idx
  ON aeeis_bot_dialogue_operations (tenant_id, owner, updated_at, operation_key)
  WHERE status = 'pending';
ALTER TABLE aeeis_bot_dialogues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON aeeis_bot_dialogues;
CREATE POLICY aeeis_tenant ON aeeis_bot_dialogues
  USING (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true));
ALTER TABLE aeeis_bot_dialogue_room_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON aeeis_bot_dialogue_room_aliases;
CREATE POLICY aeeis_tenant ON aeeis_bot_dialogue_room_aliases
  USING (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true));
ALTER TABLE aeeis_bot_dialogue_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aeeis_tenant ON aeeis_bot_dialogue_operations;
CREATE POLICY aeeis_tenant ON aeeis_bot_dialogue_operations
  USING (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true))
  WITH CHECK (current_setting('aeeis.system', true) = 'on' OR tenant_id = current_setting('aeeis.tenant_id', true));
-- Rollback: disable the professional dialogue entry first; retain/export canonical Conversations.
-- BEGIN; DROP TABLE IF EXISTS aeeis_bot_dialogue_operations; DROP TABLE IF EXISTS aeeis_bot_dialogue_room_aliases; DROP TABLE IF EXISTS aeeis_bot_dialogues; COMMIT;
-- DDL rollback does not copy new Conversation messages back into SessionEvents.
`;
export class PostgresBotDialogueStore implements BotDialogueStore {
  private readonly fence = new AsyncLocalStorage<string>();
  private readonly pool: pg.Pool;
  private readonly lockPool: pg.Pool;
  constructor(url: string) { this.pool = createPostgresPool(url); this.lockPool = createPostgresPool(url, { max: 4 }); }
  async init(): Promise<void> { await withPostgresMigrationLock(this.pool, 'bot-dialogues', async c => { await c.query(botDialoguesMigration); }); }
  async close(): Promise<void> { await Promise.all([this.pool.end(), this.lockPool.end()]); }
  async withOwner<T>(scope: Ownership, work: () => Promise<T>): Promise<T> {
    const ownerKey = key(scope, 'owner');
    if (this.fence.getStore() === ownerKey) return work();
    const client = await this.lockPool.connect();
    try {
      await client.query('BEGIN'); await postgresAdvisoryXactLock(client, 'aeeis:bot-dialogues', key(scope, 'owner'));
      const result = await this.fence.run(ownerKey, work); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  async list(scope: Ownership): Promise<BotDialogue[]> {
    return (await this.pool.query('SELECT state FROM aeeis_bot_dialogues WHERE tenant_id=$1 AND owner=$2', [scope.tenantId, scope.owner])).rows.map(r => r.state as BotDialogue);
  }
  async put(v: BotDialogue): Promise<void> {
    await this.pool.query(`INSERT INTO aeeis_bot_dialogues(tenant_id,owner,bot_id,conversation_id,room_id,phase,version,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(tenant_id,owner,bot_id) DO UPDATE SET conversation_id=EXCLUDED.conversation_id,room_id=EXCLUDED.room_id,phase=EXCLUDED.phase,version=EXCLUDED.version,state=EXCLUDED.state,updated_at=now()`, [v.tenantId,v.owner,v.botId,v.conversationId,v.roomId,v.phase,v.version,v]);
  }
  async aliases(scope: Ownership): Promise<DialogueAlias[]> {
    return (await this.pool.query('SELECT alias_room_id,canonical_room_id,bot_id FROM aeeis_bot_dialogue_room_aliases WHERE tenant_id=$1 AND owner=$2', [scope.tenantId,scope.owner])).rows.map(r => ({ ...scope,aliasRoomId:r.alias_room_id,canonicalRoomId:r.canonical_room_id,botId:r.bot_id }));
  }
  async alias(v: DialogueAlias): Promise<void> {
    if (v.aliasRoomId === v.canonicalRoomId || !(await this.list(v)).some(b => b.botId === v.botId && b.roomId === v.canonicalRoomId) || (await this.list(v)).some(b => b.roomId === v.aliasRoomId)) throw new Conflict('Invalid dialogue alias');
    const previous = (await this.aliases(v)).find(a => a.aliasRoomId === v.aliasRoomId);
    if (previous && (previous.canonicalRoomId !== v.canonicalRoomId || previous.botId !== v.botId)) throw new Conflict('Dialogue alias already assigned');
    await this.pool.query('INSERT INTO aeeis_bot_dialogue_room_aliases(tenant_id,owner,alias_room_id,canonical_room_id,bot_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [v.tenantId,v.owner,v.aliasRoomId,v.canonicalRoomId,v.botId]);
  }
  async operations(scope: Ownership): Promise<DialogueOperation[]> {
    return (await this.pool.query('SELECT state FROM aeeis_bot_dialogue_operations WHERE tenant_id=$1 AND owner=$2', [scope.tenantId,scope.owner])).rows.map(r => r.state as DialogueOperation);
  }
  async operation(v: DialogueOperation): Promise<void> {
    const previous = (await this.operations(v)).find(op => op.operationKey === v.operationKey);
    if (previous && (previous.botId !== v.botId || previous.kind !== v.kind || previous.sourceId !== v.sourceId)) throw new Conflict('Dialogue operation identity is immutable');
    await this.pool.query(`INSERT INTO aeeis_bot_dialogue_operations(tenant_id,owner,operation_key,bot_id,kind,source_id,target_id,status,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(tenant_id,owner,operation_key) DO UPDATE SET target_id=EXCLUDED.target_id,status=EXCLUDED.status,state=EXCLUDED.state,updated_at=now()`, [v.tenantId,v.owner,v.operationKey,v.botId,v.kind,v.sourceId,v.targetId ?? null,v.status,v]);
  }
}
