import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import type { Ownership } from '../security/principal.js';
import { withPostgresMigrationLock } from './postgres-migration.js';
import { createPostgresPool } from './postgres-pool.js';

/**
 * Which conversation and task a Run thread belongs to, and the last Run notice
 * written for it. A Run records its thread but not its conversation; this
 * lets the notifier find the conversation without opening every one. Ids only:
 * no titles or text, so nothing here needs sealing.
 */
const id = z.string().min(1).max(200);
const noticeSchema = z.object({ runId: id, key: z.string().min(1).max(200) }).strict();
export const threadLinkSchema = z.object({
  threadId: id, conversationId: id, taskId: id, owner: id, tenantId: id,
  notified: noticeSchema.optional(),
}).strict();
export type ThreadLink = z.infer<typeof threadLinkSchema>;
export type ThreadNotice = z.infer<typeof noticeSchema>;

export interface ConversationThreadIndex {
  init(): Promise<void>;
  close(): Promise<void>;
  /** Records the link once. Returns false when it already existed (the first link wins). */
  link(entry: Omit<ThreadLink, 'notified'>, notified?: ThreadNotice): Promise<boolean>;
  get(threadId: string, scope: Ownership): Promise<ThreadLink | undefined>;
  markNotified(threadId: string, scope: Ownership, notified: ThreadNotice): Promise<void>;
  /** Whether the one-time fill from existing conversations has finished. */
  seeded(): Promise<boolean>;
  markSeeded(): Promise<void>;
}

const owned = (link: ThreadLink | undefined, scope: Ownership) => link && link.owner === scope.owner && link.tenantId === scope.tenantId ? structuredClone(link) : undefined;

export class InMemoryConversationThreadIndex implements ConversationThreadIndex {
  protected links = new Map<string, ThreadLink>();
  protected done = false;
  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async link(entry: Omit<ThreadLink, 'notified'>, notified?: ThreadNotice): Promise<boolean> {
    if (this.links.has(entry.threadId)) return false;
    this.links.set(entry.threadId, threadLinkSchema.parse({ ...entry, ...(notified ? { notified } : {}) }));
    await this.persist();
    return true;
  }
  async get(threadId: string, scope: Ownership): Promise<ThreadLink | undefined> { return owned(this.links.get(threadId), scope); }
  async markNotified(threadId: string, scope: Ownership, notified: ThreadNotice): Promise<void> {
    const link = owned(this.links.get(threadId), scope);
    if (!link) return;
    this.links.set(threadId, { ...link, notified: noticeSchema.parse(notified) });
    await this.persist();
  }
  async seeded(): Promise<boolean> { return this.done; }
  async markSeeded(): Promise<void> { this.done = true; await this.persist(); }
  protected async persist(): Promise<void> {}
}

const fileSchema = z.object({ seeded: z.boolean(), links: z.array(threadLinkSchema) }).strict();

/** Local single-writer deployment, next to the file conversation store. */
export class FileConversationThreadIndex extends InMemoryConversationThreadIndex {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) { super(); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next;
  }
  override async init(): Promise<void> {
    try {
      const state = fileSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      this.links = new Map(state.links.map(link => [link.threadId, link])); this.done = state.seeded;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  override async close(): Promise<void> { await this.queue; }
  override link(entry: Omit<ThreadLink, 'notified'>, notified?: ThreadNotice): Promise<boolean> { return this.serial(() => super.link(entry, notified)); }
  override markNotified(threadId: string, scope: Ownership, notified: ThreadNotice): Promise<void> { return this.serial(() => super.markNotified(threadId, scope, notified)); }
  override markSeeded(): Promise<void> { return this.serial(() => super.markSeeded()); }
  protected override async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ seeded: this.done, links: [...this.links.values()] })); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
    } finally { await unlink(temp).catch(() => undefined); }
  }
}

export class PostgresConversationThreadIndex implements ConversationThreadIndex {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = createPostgresPool(connectionString); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'conversation-threads', async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_conversation_threads (
        thread_id text PRIMARY KEY, conversation_id text NOT NULL, task_id text NOT NULL,
        owner text NOT NULL, tenant_id text NOT NULL, notified_run_id text, notified_key text
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_conversation_thread_seed (name text PRIMARY KEY)`);
    });
  }
  async close(): Promise<void> { await this.pool.end(); }
  async link(entry: Omit<ThreadLink, 'notified'>, notified?: ThreadNotice): Promise<boolean> {
    const value = threadLinkSchema.parse({ ...entry, ...(notified ? { notified } : {}) });
    const result = await this.pool.query(`INSERT INTO aeeis_conversation_threads(thread_id, conversation_id, task_id, owner, tenant_id, notified_run_id, notified_key)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(thread_id) DO NOTHING RETURNING thread_id`,
      [value.threadId, value.conversationId, value.taskId, value.owner, value.tenantId, value.notified?.runId ?? null, value.notified?.key ?? null]);
    return result.rows.length === 1;
  }
  async get(threadId: string, scope: Ownership): Promise<ThreadLink | undefined> {
    const result = await this.pool.query('SELECT * FROM aeeis_conversation_threads WHERE thread_id=$1 AND owner=$2 AND tenant_id=$3', [threadId, scope.owner, scope.tenantId]);
    const row = result.rows[0] as Record<string, string | null> | undefined;
    if (!row) return undefined;
    return threadLinkSchema.parse({ threadId: row.thread_id, conversationId: row.conversation_id, taskId: row.task_id, owner: row.owner, tenantId: row.tenant_id,
      ...(row.notified_run_id && row.notified_key ? { notified: { runId: row.notified_run_id, key: row.notified_key } } : {}) });
  }
  async markNotified(threadId: string, scope: Ownership, notified: ThreadNotice): Promise<void> {
    const value = noticeSchema.parse(notified);
    await this.pool.query('UPDATE aeeis_conversation_threads SET notified_run_id=$4, notified_key=$5 WHERE thread_id=$1 AND owner=$2 AND tenant_id=$3', [threadId, scope.owner, scope.tenantId, value.runId, value.key]);
  }
  async seeded(): Promise<boolean> { return (await this.pool.query(`SELECT 1 FROM aeeis_conversation_thread_seed WHERE name='threads'`)).rows.length === 1; }
  async markSeeded(): Promise<void> { await this.pool.query(`INSERT INTO aeeis_conversation_thread_seed(name) VALUES('threads') ON CONFLICT DO NOTHING`); }
}
