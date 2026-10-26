import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { z } from 'zod';
import type { Conversation, ConversationStore } from '../conversations.js';
import { requestSchema } from '../runtime/contracts.js';
import { Conflict } from '../runtime/engine.js';
import { NotFound } from '../runtime/repository.js';
import type { Ownership } from '../security/principal.js';
import { withPostgresMigrationLock } from './postgres-migration.js';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const conversationId = new RegExp(`^conv_${uuid}$`);
const identifier = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const runId = z.string().regex(new RegExp(`^run_${uuid}$`));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({
  schemaVersion: z.literal('conversation/1'), id: z.string().regex(conversationId),
  owner: identifier, tenantId: identifier, title: z.string(),
  agentId: z.string().trim().min(1).max(100).optional(),
  standingInstruction: z.string().trim().min(1).max(500).optional(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), createdAt: timestamp, updatedAt: timestamp,
  focusTaskId: identifier.optional(), recentTaskIds: z.array(identifier).max(100),
  tasks: z.array(z.object({
    id: identifier, threadId: z.string().regex(new RegExp(`^thread_${uuid}$`)), title: z.string(),
    createdAt: timestamp, priority: z.number().int().min(1).max(100).optional(),
    latestRunId: runId.optional(), pendingMessageId: identifier.optional(),
  }).strict()).max(100),
  messages: z.array(z.object({
    id: identifier, keyHash: hash, requestHash: hash, role: z.enum(['user', 'notification']),
    speaker: z.object({ role: z.enum(['user', 'agent']), id: z.string().trim().min(1).max(200) }).strict().optional(),
    text: z.string(), createdAt: timestamp, replyTo: identifier.optional(), correctsMessageId: identifier.optional(),
    route: z.object({
      status: z.enum(['routed', 'clarify', 'general']),
      reason: z.enum(['new-task', 'explicit', 'reply', 'name', 'focus', 'ambiguous', 'unassigned']),
      taskIds: z.array(identifier).max(100), candidateTaskIds: z.array(identifier).max(100),
      focusEffect: z.enum(['keep', 'switch']),
    }).strict(),
    execution: z.object({
      taskId: identifier, runId, parentRunId: runId.optional(), request: requestSchema,
      state: z.enum(['pending', 'completed', 'cancelled']),
    }).strict().optional(),
    notificationRunId: runId.optional(),
  }).strict()).max(1000),
}).strict();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Conflict(message);
}
function validateId(id: string): void {
  if (!conversationId.test(id)) throw new NotFound('Unknown conversation');
}
function owned(value: Conversation, scope: Ownership): boolean {
  return value.owner === scope.owner && value.tenantId === scope.tenantId;
}
function unique(values: string[]): boolean { return new Set(values).size === values.length; }
function validate(value: Conversation): void {
  assert(schema.safeParse(value).success, 'Invalid conversation state or capacity exceeded (100 tasks / 1000 messages)');
  assert(unique(value.tasks.map(task => task.id)), 'Duplicate conversation task ID');
  assert(unique(value.tasks.map(task => task.threadId)), 'Duplicate conversation thread ID');
  assert(unique(value.tasks.flatMap(task => task.priority === undefined ? [] : [String(task.priority)])), 'Duplicate task priority');
  assert(unique(value.messages.map(message => message.id)), 'Duplicate conversation message ID');
  assert(unique(value.messages.map(message => message.keyHash)), 'Duplicate conversation message key');
  const tasks = new Set(value.tasks.map(task => task.id));
  const references = (ids: string[]) => unique(ids) && ids.every(id => tasks.has(id));
  assert(value.focusTaskId === undefined || tasks.has(value.focusTaskId), 'Unknown focus task');
  assert(references(value.recentTaskIds), 'Invalid recent task references');
  const previousMessages = new Map<string, Conversation['messages'][number]>();
  for (const message of value.messages) {
    assert(references(message.route.taskIds) && references(message.route.candidateTaskIds), 'Invalid route task references');
    assert(message.replyTo === undefined || previousMessages.has(message.replyTo), 'Invalid reply reference');
    if (message.correctsMessageId !== undefined) {
      const original = previousMessages.get(message.correctsMessageId);
      assert(original?.role === 'user' && original.execution === undefined && original.correctsMessageId === undefined, 'Invalid correction target');
      assert(message.role === 'user' && message.execution === undefined && message.notificationRunId === undefined && message.replyTo === undefined
        && message.route.status === 'routed' && message.route.taskIds.length > 0, 'Invalid correction message');
    }
    if (message.execution) {
      assert(tasks.has(message.execution.taskId) && message.route.taskIds.includes(message.execution.taskId), 'Invalid execution task reference');
    }
    previousMessages.set(message.id, message);
  }
  const messages = previousMessages;
  for (const task of value.tasks) {
    if (task.pendingMessageId === undefined) continue;
    const pending = messages.get(task.pendingMessageId)?.execution;
    assert(pending?.taskId === task.id && pending.state === 'pending', 'Invalid pending message reference');
  }
}
const maxBytes = 8 * 1024 * 1024;
function assertSize(json: string): void {
  assert(Buffer.byteLength(json, 'utf8') <= maxBytes, 'Conversation exceeds 8 MiB capacity');
}
function prepare(value: Conversation): Conversation {
  validate(value);
  // Every backend stores the same JSON representation, detached from the caller.
  const json = JSON.stringify(value);
  assertSize(json);
  const copy = JSON.parse(json) as Conversation;
  validate(copy);
  return copy;
}
function changed(before: Conversation, change: (value: Conversation) => void): Conversation {
  const draft = structuredClone(before);
  const returned: unknown = change(draft);
  if (returned && typeof (returned as { then?: unknown }).then === 'function') {
    // Do not let an accidentally async callback hold a transaction or mutate a
    // committed object later. Consume rejections while discarding its draft.
    void Promise.resolve(returned).catch(() => undefined);
    throw new Conflict('Conversation mutations must be synchronous');
  }
  for (const field of ['id', 'owner', 'tenantId', 'createdAt', 'schemaVersion', 'revision', 'updatedAt'] as const) {
    assert(draft[field] === before[field], `Conversation ${field} is immutable`);
  }
  validate(draft);
  assert(draft.tasks.length >= before.tasks.length, 'Conversation tasks are append-only');
  before.tasks.forEach((task, index) => {
    const next = draft.tasks[index]!;
    assert(task.id === next.id && task.threadId === next.threadId && task.title === next.title && task.createdAt === next.createdAt, 'Conversation task identity and title are immutable');
  });
  assert(draft.messages.length >= before.messages.length, 'Conversation messages are append-only');
  before.messages.forEach((message, index) => {
    const next = draft.messages[index]!;
    for (const field of ['id', 'keyHash', 'requestHash', 'role', 'speaker', 'text', 'createdAt', 'replyTo', 'correctsMessageId', 'route', 'notificationRunId'] as const) {
      assert(isDeepStrictEqual(message[field], next[field]), `Conversation message ${field} is immutable`);
    }
    if (message.execution) {
      assert(next.execution, 'Conversation execution is immutable');
      for (const field of ['taskId', 'runId', 'parentRunId', 'request'] as const) {
        assert(isDeepStrictEqual(message.execution[field], next.execution[field]), `Conversation execution ${field} is immutable`);
      }
      const previousState = message.execution.state, nextState = next.execution.state;
      assert(previousState === nextState || (previousState === 'pending' && (nextState === 'completed' || nextState === 'cancelled')), 'Conversation execution state is immutable once terminal');
    } else assert(next.execution === undefined, 'Conversation execution is immutable');
  });
  if (isDeepStrictEqual(draft, before)) return structuredClone(before);
  assert(before.revision < Number.MAX_SAFE_INTEGER, 'Conversation revision exhausted');
  draft.revision = before.revision + 1;
  draft.updatedAt = new Date().toISOString();
  return prepare(draft);
}
function recentFirst(a: Conversation, b: Conversation): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function hasPending(value: Conversation): boolean { return value.messages.some(message => message.execution?.state === 'pending'); }
const lifeConflict = '这个人已经有一条生命线';
function assertOneLife(records: Iterable<Conversation>, value: Conversation): void {
  if (!value.agentId) return;
  for (const existing of records) {
    if (existing.id !== value.id && existing.owner === value.owner && existing.tenantId === value.tenantId && existing.agentId === value.agentId) throw new Conflict(lifeConflict);
  }
}
function agentIndexConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === '23505' && (error as { constraint?: string }).constraint === 'aeeis_conversations_agent_uidx');
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly records = new Map<string, Conversation>();
  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async create(value: Conversation): Promise<void> {
    const copy = prepare(value);
    assert(!this.records.has(copy.id), 'Conversation already exists');
    assertOneLife(this.records.values(), copy);
    this.records.set(copy.id, copy);
  }
  async get(id: string, scope: Ownership): Promise<Conversation> {
    validateId(id);
    const value = this.records.get(id);
    if (!value || !owned(value, scope)) throw new NotFound('Unknown conversation');
    return structuredClone(value);
  }
  async list(scope: Ownership): Promise<Conversation[]> {
    return [...this.records.values()].filter(value => owned(value, scope)).sort(recentFirst).map(value => structuredClone(value));
  }
  async mutate(id: string, scope: Ownership, change: (value: Conversation) => void): Promise<Conversation> {
    validateId(id);
    const before = this.records.get(id);
    if (!before || !owned(before, scope)) throw new NotFound('Unknown conversation');
    // No await between reading and committing: short synchronous callbacks
    // are naturally serialized in this process, including rejected mutations.
    const next = changed(before, change);
    assertOneLife(this.records.values(), next);
    this.records.set(id, next);
    return structuredClone(next);
  }
  async *pending(): AsyncIterable<Conversation> {
    for (const id of [...this.records.keys()].sort()) {
      const value = this.records.get(id)!;
      if (hasPending(value)) yield structuredClone(value);
    }
  }
}

/** Single live writer per directory; independent from the Run repository lock. */
export class FileConversationStore implements ConversationStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly lockPath: string;
  private lockToken: string | undefined;
  private ready = false;
  private closing = false;
  constructor(private readonly directory: string) { this.lockPath = join(directory, '.conversations.writer.lock'); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private operation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Conversation store is closed'));
    return this.serial(async () => {
      if (!this.ready) throw new Error('Conversation store is not initialized');
      return operation();
    });
  }
  init(): Promise<void> {
    return this.serial(async () => {
      if (this.ready) return;
      if (this.closing) throw new Error('Conversation store is closed');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.acquireLock();
      try {
        await this.syncDirectory();
        // Fail closed on corrupt canonical state, without retaining the lock.
        for (const id of await this.ids()) await this.read(id);
        this.ready = true;
      } catch (error) {
        await unlink(this.lockPath).finally(() => { this.lockToken = undefined; });
        throw error;
      }
    });
  }
  /** Reclaim a lock only when its recorded PID is dead. A live PID, including
   * one reused by an unrelated process, still blocks startup. */
  private async acquireLock(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const lock = await open(this.lockPath, 'wx', 0o600);
        this.lockToken = `${process.pid}:${randomUUID()}`;
        try { await lock.writeFile(this.lockToken); await lock.sync(); } finally { await lock.close(); }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (attempt === 1 || !await this.deadLock()) throw new Conflict('Conversation directory already has a writer lock');
        await unlink(this.lockPath).catch(unlinkError => {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
        });
      }
    }
  }
  private async deadLock(): Promise<boolean> {
    const token = await readFile(this.lockPath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (token === undefined) return true;
    const pid = Number(token.split(':', 1)[0]);
    if (!Number.isInteger(pid) || pid <= 0) throw new Conflict('Invalid conversation writer lock; inspect before recovery');
    try { process.kill(pid, 0); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
  }
  private path(id: string): string { validateId(id); return join(this.directory, `${id}.json`); }
  private async ids(): Promise<string[]> {
    return (await readdir(this.directory)).filter(name => name.endsWith('.json') && conversationId.test(name.slice(0, -5))).map(name => name.slice(0, -5)).sort();
  }
  private async read(id: string, scope?: Ownership): Promise<Conversation> {
    let value: Conversation;
    try {
      const json = await readFile(this.path(id), 'utf8');
      assertSize(json);
      value = JSON.parse(json) as Conversation;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFound('Unknown conversation'); throw error; }
    validate(value);
    assert(value.id === id, 'Conversation file identity mismatch');
    if (scope && !owned(value, scope)) throw new NotFound('Unknown conversation');
    return value;
  }
  private async syncDirectory(): Promise<void> {
    const dir = await open(this.directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  private async save(value: Conversation): Promise<void> {
    const path = this.path(value.id), temp = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await rename(temp, path);
      await this.syncDirectory();
    } finally {
      await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }
  create(value: Conversation): Promise<void> {
    // Snapshot before queueing so caller edits cannot change the pending write.
    let copy: Conversation;
    try { copy = prepare(value); } catch (error) { return Promise.reject(error); }
    return this.operation(async () => {
      try { await this.read(copy.id); throw new Conflict('Conversation already exists'); }
      catch (error) { if (!(error instanceof NotFound)) throw error; }
      const existing: Conversation[] = [];
      for (const id of await this.ids()) existing.push(await this.read(id));
      assertOneLife(existing, copy);
      await this.save(copy);
    });
  }
  get(id: string, scope: Ownership): Promise<Conversation> {
    const owner = { ...scope };
    return this.operation(() => this.read(id, owner));
  }
  list(scope: Ownership): Promise<Conversation[]> {
    const owner = { ...scope };
    return this.operation(async () => {
      const result: Conversation[] = [];
      for (const id of await this.ids()) { const value = await this.read(id); if (owned(value, owner)) result.push(value); }
      return result.sort(recentFirst);
    });
  }
  mutate(id: string, scope: Ownership, change: (value: Conversation) => void): Promise<Conversation> {
    const owner = { ...scope };
    return this.operation(async () => {
      const before = await this.read(id, owner), next = changed(before, change);
      if (next.agentId && next.agentId !== before.agentId) {
        const existing: Conversation[] = [];
        for (const otherId of await this.ids()) existing.push(await this.read(otherId));
        assertOneLife(existing, next);
      }
      if (next.revision !== before.revision) await this.save(next);
      return structuredClone(next);
    });
  }
  async *pending(): AsyncIterable<Conversation> {
    const ids = await this.operation(() => this.ids());
    for (const id of ids) {
      const value = await this.operation(() => this.read(id));
      if (hasPending(value)) yield value;
    }
  }
  close(): Promise<void> {
    this.closing = true;
    return this.serial(async () => {
      this.ready = false;
      if (this.lockToken === undefined) return;
      // An uninitialized/failed contender must never remove another's lock.
      const token = await readFile(this.lockPath, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (token === this.lockToken) { await unlink(this.lockPath); await this.syncDirectory(); }
      this.lockToken = undefined;
    });
  }
}

const migration = `CREATE TABLE IF NOT EXISTS aeeis_conversations (
  id text PRIMARY KEY, owner text NOT NULL, tenant_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0), state jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (state->>'id' = id AND state->>'owner' = owner AND state->>'tenantId' = tenant_id)
);
CREATE INDEX IF NOT EXISTS aeeis_conversations_scope_idx ON aeeis_conversations(owner, tenant_id, id);
CREATE INDEX IF NOT EXISTS aeeis_conversations_pending_idx ON aeeis_conversations(id)
  WHERE state @> '{"messages":[{"execution":{"state":"pending"}}]}'::jsonb;
UPDATE aeeis_conversations AS conversation
SET state = conversation.state - 'agentId'
WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY owner, tenant_id, (state->>'agentId')
      ORDER BY updated_at DESC, id DESC
    ) AS n
    FROM aeeis_conversations
    WHERE COALESCE(state->>'agentId', '') <> ''
  ) ranked
  WHERE n > 1
);
CREATE UNIQUE INDEX IF NOT EXISTS aeeis_conversations_agent_uidx ON aeeis_conversations(owner, tenant_id, (state->>'agentId'))
  WHERE state->>'agentId' IS NOT NULL AND state->>'agentId' <> '';`;
const pendingPredicate = `state @> '{"messages":[{"execution":{"state":"pending"}}]}'::jsonb`;
const pageSize = 100;

export class PostgresConversationStore implements ConversationStore {
  private readonly pool: pg.Pool;
  private closed = false;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> {
    try { await withPostgresMigrationLock(this.pool, 'conversations', async client => { await client.query(migration); }); }
    catch (error) { await this.close(); throw error; }
  }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; await this.pool.end(); } }
  async create(value: Conversation): Promise<void> {
    const copy = prepare(value);
    try {
      const result = await this.pool.query(
        'INSERT INTO aeeis_conversations(id,owner,tenant_id,revision,state,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',
        [copy.id, copy.owner, copy.tenantId, copy.revision, copy, copy.updatedAt],
      );
      assert(result.rowCount, 'Conversation already exists');
    } catch (error) {
      if (agentIndexConflict(error)) throw new Conflict(lifeConflict);
      throw error;
    }
  }
  async get(id: string, scope: Ownership): Promise<Conversation> {
    validateId(id);
    const result = await this.pool.query<{ state: Conversation }>('SELECT state FROM aeeis_conversations WHERE id=$1 AND owner=$2 AND tenant_id=$3', [id, scope.owner, scope.tenantId]);
    if (!result.rows[0]) throw new NotFound('Unknown conversation');
    return structuredClone(result.rows[0].state);
  }
  async list(scope: Ownership): Promise<Conversation[]> {
    const owner = { ...scope }, result: Conversation[] = [];
    // The interface returns a full list; keyset pages bound individual SQL
    // responses. Immutable IDs avoid duplicates caused by concurrent updates.
    const upper = (await this.pool.query<{ id: string }>('SELECT id FROM aeeis_conversations WHERE owner=$1 AND tenant_id=$2 ORDER BY id DESC LIMIT 1', [owner.owner, owner.tenantId])).rows[0]?.id;
    if (!upper) return result;
    let after = '';
    while (true) {
      const page = await this.pool.query<{ state: Conversation }>('SELECT state FROM aeeis_conversations WHERE owner=$1 AND tenant_id=$2 AND id>$3 AND id<=$4 ORDER BY id LIMIT $5', [owner.owner, owner.tenantId, after, upper, pageSize]);
      result.push(...page.rows.map(row => structuredClone(row.state)));
      if (page.rows.length < pageSize) return result.sort(recentFirst);
      after = page.rows.at(-1)!.state.id;
    }
  }
  async mutate(id: string, scope: Ownership, change: (value: Conversation) => void): Promise<Conversation> {
    validateId(id);
    const owner = { ...scope }, client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ state: Conversation }>('SELECT state FROM aeeis_conversations WHERE id=$1 AND owner=$2 AND tenant_id=$3 FOR UPDATE', [id, owner.owner, owner.tenantId]);
      if (!result.rows[0]) throw new NotFound('Unknown conversation');
      const before = result.rows[0].state, next = changed(before, change);
      if (next.revision !== before.revision) await client.query('UPDATE aeeis_conversations SET revision=$4,state=$5,updated_at=$6 WHERE id=$1 AND owner=$2 AND tenant_id=$3', [id, owner.owner, owner.tenantId, next.revision, next, next.updatedAt]);
      await client.query('COMMIT');
      return structuredClone(next);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (agentIndexConflict(error)) throw new Conflict(lifeConflict);
      throw error;
    }
    finally { client.release(); }
  }
  async *pending(): AsyncIterable<Conversation> {
    const upper = (await this.pool.query<{ id: string }>(`SELECT id FROM aeeis_conversations WHERE ${pendingPredicate} ORDER BY id DESC LIMIT 1`)).rows[0]?.id;
    if (!upper) return;
    let after = '';
    while (true) {
      const page = await this.pool.query<{ state: Conversation }>(`SELECT state FROM aeeis_conversations WHERE ${pendingPredicate} AND id>$1 AND id<=$2 ORDER BY id LIMIT $3`, [after, upper, pageSize]);
      for (const row of page.rows) yield structuredClone(row.state);
      if (page.rows.length < pageSize) return;
      after = page.rows.at(-1)!.state.id;
    }
  }
}
