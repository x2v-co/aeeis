import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import type { Ownership } from './security/principal.js';
import { visibleConversationMessages, type Conversation, type ConversationMessage, type ConversationStore } from './conversations.js';
import type { SessionEvent, SessionEventRepository } from './session-events.js';
import type { Room } from './contracts.js';
import { openField, sealField } from './content-encryption.js';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { createPostgresPool } from './adapters/postgres-pool.js';

/**
 * One row per chat for the 消息 list, written when the chat is written, so the
 * list never opens whole conversations. `newCount` is a running count of
 * messages someone other than you sent; it only grows. A person's read marker
 * stores the count they had reached, so unread = newCount − that count.
 * Title and preview are sealed like conversation content; ids, kind, times and
 * counts stay plain for sorting and counting.
 */
const id = z.string().min(1).max(200);
export const chatSummarySchema = z.object({
  chatId: id, owner: id, tenantId: id,
  kind: z.enum(['direct', 'group']), backing: z.enum(['conversation', 'room']),
  counterpart: id.optional(),
  title: z.string().max(500), preview: z.string().max(500),
  lastActivityAt: z.string().datetime({ offset: true }),
  newCount: z.number().int().nonnegative(),
  /** Conversation revision, or the last room event sequence folded in. A write never moves it back. */
  sourceRevision: z.number().int().nonnegative(),
  /** Room only: the event the preview shows, so an edit or retraction of it updates the preview. */
  previewEventId: id.optional(),
}).strict();
export type ChatSummary = z.infer<typeof chatSummarySchema>;
export const readMarkerSchema = z.object({ principalId: id, tenantId: id, chatId: id, readCount: z.number().int().nonnegative(), readAt: z.string().datetime({ offset: true }) }).strict();
export type ReadMarker = z.infer<typeof readMarkerSchema>;

const PREVIEW = 120;
const clip = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW);

/** Something you did not say yourself: a Bot's reply, a Run notice, anyone else. Your own lines,
 * including from Feishu and artifacts you saved, have you as the speaker (or no speaker on a typed line). */
export function isNewForOwner(message: ConversationMessage, owner: string): boolean {
  // A group line copied into a Bot's chat (intake or hand-over) is counted once, in the group.
  if (message.source?.kind === 'channel' && message.source.channel === 'room') return false;
  // An edit or retraction of an imported room line is folded into that line; it is not another message.
  if (message.source?.kind === 'room' && message.source.targetMessageId && message.source.targetMessageId !== message.id) return false;
  return message.speaker ? message.speaker.id !== owner : message.role === 'notification';
}
export function conversationSummary(conversation: Conversation): ChatSummary {
  const messages = visibleConversationMessages(conversation.messages);
  const fresh = messages.filter(message => isNewForOwner(message, conversation.owner));
  const last = messages.at(-1);
  return chatSummarySchema.parse({
    chatId: conversation.id, owner: conversation.owner, tenantId: conversation.tenantId,
    kind: 'direct', backing: 'conversation', ...(conversation.agentId ? { counterpart: conversation.agentId } : {}),
    title: conversation.title.slice(0, 500), preview: clip(fresh.at(-1)?.text ?? ''),
    lastActivityAt: last?.createdAt ?? conversation.updatedAt,
    // Counted over every message ever written (messages are append-only), so it never goes back.
    newCount: conversation.messages.filter(message => isNewForOwner(message, conversation.owner)).length,
    sourceRevision: conversation.revision,
  });
}
/** Group chats only. Direct rooms are a Bot conversation's address (counted through the conversation),
 * and side threads are between two Bots. */
export function summarizedRoom(room: Room): boolean {
  return room.chat !== 'direct' && room.description !== '私聊' && room.description !== '侧线程';
}
const counted = (event: SessionEvent) => event.type === 'message' || event.type === 'canonical_response';
/** Folds room events after `previous.sourceRevision` into the summary. Only someone else's new post
 * (publish of a message or answer) counts; an edit or retraction only updates the preview. */
export function foldRoomEvents(room: Room, scope: Ownership, previous: ChatSummary | undefined, events: SessionEvent[]): ChatSummary {
  let summary: ChatSummary = previous ?? { chatId: room.id, owner: scope.owner, tenantId: scope.tenantId, kind: 'group', backing: 'room', title: '', preview: '', lastActivityAt: room.createdAt, newCount: 0, sourceRevision: 0 };
  summary = { ...summary, title: room.title.slice(0, 500) };
  for (const event of events) {
    if (event.sequence <= summary.sourceRevision) continue;
    summary.sourceRevision = event.sequence;
    if (!counted(event)) continue;
    if (event.createdAt > summary.lastActivityAt) summary.lastActivityAt = event.createdAt;
    const mine = event.actorId === scope.owner || event.actorType === 'system';
    if (event.operation === 'publish') {
      if (mine) continue;
      summary.newCount += 1; summary.preview = clip(event.content); summary.previewEventId = event.id;
    } else if (event.targetEventId && event.targetEventId === summary.previewEventId) {
      summary.preview = event.operation === 'retract' ? '（已撤回）' : clip(event.content); summary.previewEventId = event.id;
    }
  }
  return chatSummarySchema.parse(summary);
}

export interface ChatSummaryStore {
  init(): Promise<void>;
  close(): Promise<void>;
  /** Keeps the row with the higher sourceRevision; an older write is ignored. */
  put(summary: ChatSummary): Promise<void>;
  get(chatId: string, scope: Ownership): Promise<ChatSummary | undefined>;
  list(scope: Ownership): Promise<ChatSummary[]>;
  reads(principalId: string, tenantId: string): Promise<ReadMarker[]>;
  /** Only ever raises the marker. */
  markRead(marker: ReadMarker): Promise<void>;
  seeded(): Promise<boolean>;
  markSeeded(): Promise<void>;
}

const mine = (summary: ChatSummary | undefined, scope: Ownership) => summary && summary.owner === scope.owner && summary.tenantId === scope.tenantId ? structuredClone(summary) : undefined;
const readKey = (principalId: string, tenantId: string, chatId: string) => JSON.stringify([tenantId, principalId, chatId]);

export class InMemoryChatSummaryStore implements ChatSummaryStore {
  protected summaries = new Map<string, ChatSummary>();
  protected markers = new Map<string, ReadMarker>();
  protected done = false;
  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async put(summary: ChatSummary): Promise<void> {
    const value = chatSummarySchema.parse(summary), current = this.summaries.get(value.chatId);
    if (current && (current.owner !== value.owner || current.tenantId !== value.tenantId || current.sourceRevision > value.sourceRevision)) return;
    this.summaries.set(value.chatId, value); await this.persist();
  }
  async get(chatId: string, scope: Ownership): Promise<ChatSummary | undefined> { return mine(this.summaries.get(chatId), scope); }
  async list(scope: Ownership): Promise<ChatSummary[]> { return [...this.summaries.values()].flatMap(item => mine(item, scope) ?? []); }
  async reads(principalId: string, tenantId: string): Promise<ReadMarker[]> { return [...this.markers.values()].filter(item => item.principalId === principalId && item.tenantId === tenantId).map(item => structuredClone(item)); }
  async markRead(marker: ReadMarker): Promise<void> {
    const value = readMarkerSchema.parse(marker), key = readKey(value.principalId, value.tenantId, value.chatId), current = this.markers.get(key);
    if (current && current.readCount >= value.readCount) return;
    this.markers.set(key, value); await this.persist();
  }
  async seeded(): Promise<boolean> { return this.done; }
  async markSeeded(): Promise<void> { this.done = true; await this.persist(); }
  protected async persist(): Promise<void> {}
}

const fileSchema = z.object({ seeded: z.boolean(), summaries: z.array(chatSummarySchema), markers: z.array(readMarkerSchema) }).strict();
/** Local single-writer deployment. Plain file, like the file conversation store without a key. */
export class FileChatSummaryStore extends InMemoryChatSummaryStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) { super(); }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next; }
  override async init(): Promise<void> {
    try {
      const state = fileSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      this.summaries = new Map(state.summaries.map(item => [item.chatId, item]));
      this.markers = new Map(state.markers.map(item => [readKey(item.principalId, item.tenantId, item.chatId), item]));
      this.done = state.seeded;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  override async close(): Promise<void> { await this.queue; }
  override put(summary: ChatSummary): Promise<void> { return this.serial(() => super.put(summary)); }
  override markRead(marker: ReadMarker): Promise<void> { return this.serial(() => super.markRead(marker)); }
  override markSeeded(): Promise<void> { return this.serial(() => super.markSeeded()); }
  protected override async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ seeded: this.done, summaries: [...this.summaries.values()], markers: [...this.markers.values()] })); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
    } finally { await unlink(temp).catch(() => undefined); }
  }
}

type SummaryRow = { chat_id: string; owner: string; tenant_id: string; kind: string; backing: string; counterpart: string | null; title: string; preview: string; last_activity_at: Date | string; new_count: number; source_revision: string | number; preview_event_id: string | null };
export class PostgresChatSummaryStore implements ChatSummaryStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = createPostgresPool(connectionString); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'chat-summaries', async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_chat_summaries (
        chat_id text PRIMARY KEY, owner text NOT NULL, tenant_id text NOT NULL, kind text NOT NULL, backing text NOT NULL, counterpart text,
        title text NOT NULL, preview text NOT NULL, last_activity_at timestamptz NOT NULL, new_count integer NOT NULL, source_revision bigint NOT NULL, preview_event_id text
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS aeeis_chat_summaries_owner_idx ON aeeis_chat_summaries (tenant_id, owner, last_activity_at DESC)');
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_chat_reads (
        principal_id text NOT NULL, tenant_id text NOT NULL, chat_id text NOT NULL, read_count integer NOT NULL, read_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, principal_id, chat_id)
      )`);
      await client.query('CREATE TABLE IF NOT EXISTS aeeis_chat_summary_seed (name text PRIMARY KEY)');
    });
  }
  async close(): Promise<void> { await this.pool.end(); }
  async put(summary: ChatSummary): Promise<void> {
    const value = chatSummarySchema.parse(summary);
    const [title, preview] = await Promise.all([sealField('chat-summary', value.tenantId, `${value.chatId}:title`, value.title), sealField('chat-summary', value.tenantId, `${value.chatId}:preview`, value.preview)]);
    await this.pool.query(`INSERT INTO aeeis_chat_summaries(chat_id, owner, tenant_id, kind, backing, counterpart, title, preview, last_activity_at, new_count, source_revision, preview_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(chat_id) DO UPDATE SET kind=EXCLUDED.kind, backing=EXCLUDED.backing, counterpart=EXCLUDED.counterpart, title=EXCLUDED.title, preview=EXCLUDED.preview,
        last_activity_at=EXCLUDED.last_activity_at, new_count=EXCLUDED.new_count, source_revision=EXCLUDED.source_revision, preview_event_id=EXCLUDED.preview_event_id
      WHERE aeeis_chat_summaries.owner=EXCLUDED.owner AND aeeis_chat_summaries.tenant_id=EXCLUDED.tenant_id AND aeeis_chat_summaries.source_revision <= EXCLUDED.source_revision`,
      [value.chatId, value.owner, value.tenantId, value.kind, value.backing, value.counterpart ?? null, title, preview, value.lastActivityAt, value.newCount, value.sourceRevision, value.previewEventId ?? null]);
  }
  private async row(row: SummaryRow): Promise<ChatSummary> {
    const [title, preview] = await Promise.all([openField('chat-summary', row.tenant_id, `${row.chat_id}:title`, row.title), openField('chat-summary', row.tenant_id, `${row.chat_id}:preview`, row.preview)]);
    return chatSummarySchema.parse({ chatId: row.chat_id, owner: row.owner, tenantId: row.tenant_id, kind: row.kind, backing: row.backing, ...(row.counterpart ? { counterpart: row.counterpart } : {}),
      title, preview, lastActivityAt: new Date(row.last_activity_at).toISOString(), newCount: row.new_count, sourceRevision: Number(row.source_revision), ...(row.preview_event_id ? { previewEventId: row.preview_event_id } : {}) });
  }
  async get(chatId: string, scope: Ownership): Promise<ChatSummary | undefined> {
    const result = await this.pool.query('SELECT * FROM aeeis_chat_summaries WHERE chat_id=$1 AND owner=$2 AND tenant_id=$3', [chatId, scope.owner, scope.tenantId]);
    return result.rows[0] ? this.row(result.rows[0] as SummaryRow) : undefined;
  }
  async list(scope: Ownership): Promise<ChatSummary[]> {
    const result = await this.pool.query('SELECT * FROM aeeis_chat_summaries WHERE owner=$1 AND tenant_id=$2 ORDER BY last_activity_at DESC, chat_id', [scope.owner, scope.tenantId]);
    return Promise.all(result.rows.map(row => this.row(row as SummaryRow)));
  }
  async reads(principalId: string, tenantId: string): Promise<ReadMarker[]> {
    const result = await this.pool.query('SELECT * FROM aeeis_chat_reads WHERE principal_id=$1 AND tenant_id=$2', [principalId, tenantId]);
    return result.rows.map(row => readMarkerSchema.parse({ principalId: row.principal_id, tenantId: row.tenant_id, chatId: row.chat_id, readCount: row.read_count, readAt: new Date(row.read_at).toISOString() }));
  }
  async markRead(marker: ReadMarker): Promise<void> {
    const value = readMarkerSchema.parse(marker);
    await this.pool.query(`INSERT INTO aeeis_chat_reads(principal_id, tenant_id, chat_id, read_count, read_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(tenant_id, principal_id, chat_id) DO UPDATE SET read_count=EXCLUDED.read_count, read_at=EXCLUDED.read_at WHERE aeeis_chat_reads.read_count < EXCLUDED.read_count`,
      [value.principalId, value.tenantId, value.chatId, value.readCount, value.readAt]);
  }
  async seeded(): Promise<boolean> { return (await this.pool.query(`SELECT 1 FROM aeeis_chat_summary_seed WHERE name='summaries'`)).rows.length === 1; }
  async markSeeded(): Promise<void> { await this.pool.query(`INSERT INTO aeeis_chat_summary_seed(name) VALUES('summaries') ON CONFLICT DO NOTHING`); }
}

export interface ChatListItem { chatId: string; kind: ChatSummary['kind']; backing: ChatSummary['backing']; counterpart?: string; title: string; preview: string; lastActivityAt: string; unread: number }

/** Keeps the summaries current and answers the list. Summary writes are best effort: a failure is
 * logged and the next write to that chat repairs it, so a summary can never block a message. */
export class ChatSummaryService {
  constructor(
    private readonly store: ChatSummaryStore,
    private readonly events: Pick<SessionEventRepository, 'page'>,
    private readonly rooms: { getRoom(roomId: string, owner?: string, tenantId?: string): Promise<Room> },
    private readonly log: (message: string, error: unknown) => void = (message, error) => console.error(message, error instanceof Error ? error.message : error),
  ) {}
  private roomWork = new Map<string, Promise<void>>();
  /** The conversation revision last summarized here. A write that changed nothing keeps its
   * revision (the store skips saving it), so it skips the summary too. Set only after a successful put. */
  private summarized = new Map<string, number>();
  async conversationWritten(conversation: Conversation): Promise<void> {
    if (this.summarized.get(conversation.id) === conversation.revision) return;
    try { await this.store.put(conversationSummary(conversation)); this.summarized.set(conversation.id, conversation.revision); }
    catch (error) { this.log('AEEIS chat summary write failed', error); }
  }
  /** Folds the room's events written since its summary. Safe to call for any event, any number of times. */
  async roomWritten(roomId: string, scope: Ownership): Promise<void> {
    const key = JSON.stringify([scope.tenantId, roomId]);
    const running = this.roomWork.get(key);
    const next = (running ?? Promise.resolve()).then(() => this.catchUpRoom(roomId, scope)).catch(error => this.log('AEEIS chat summary write failed', error));
    this.roomWork.set(key, next);
    await next;
    if (this.roomWork.get(key) === next) this.roomWork.delete(key);
  }
  private async catchUpRoom(roomId: string, scope: Ownership): Promise<void> {
    const room = await this.rooms.getRoom(roomId, scope.owner, scope.tenantId);
    if (!summarizedRoom(room)) return;
    let summary = await this.store.get(roomId, scope);
    for (;;) {
      const after = summary?.sourceRevision ?? 0;
      const page = await this.events.page(roomId, { tenantId: scope.tenantId, owner: scope.owner }, 200, after);
      summary = foldRoomEvents(room, scope, summary, page.items);
      if (page.items.length < 200 || summary.sourceRevision === after) break;
    }
    await this.store.put(summary);
  }
  async list(scope: Ownership, principalId: string): Promise<ChatListItem[]> {
    const [summaries, reads] = await Promise.all([this.store.list(scope), this.store.reads(principalId, scope.tenantId)]);
    const read = new Map(reads.map(item => [item.chatId, item.readCount]));
    return summaries.sort((a, b) => a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : a.chatId.localeCompare(b.chatId))
      .map(item => ({ chatId: item.chatId, kind: item.kind, backing: item.backing, ...(item.counterpart ? { counterpart: item.counterpart } : {}), title: item.title, preview: item.preview,
        lastActivityAt: item.lastActivityAt, unread: Math.max(0, item.newCount - (read.get(item.chatId) ?? 0)) }));
  }
  /** Marks read up to the count the person saw (never past what exists, never backwards). */
  async markRead(chatId: string, seen: number, scope: Ownership, principalId: string): Promise<ChatListItem['unread']> {
    const summary = await this.store.get(chatId, scope);
    if (!summary) return 0;
    const readCount = Math.min(Math.max(0, Math.floor(seen)), summary.newCount);
    await this.store.markRead({ principalId, tenantId: scope.tenantId, chatId, readCount, readAt: new Date().toISOString() });
    const marker = (await this.store.reads(principalId, scope.tenantId)).find(item => item.chatId === chatId);
    return Math.max(0, summary.newCount - (marker?.readCount ?? 0));
  }
  /**
   * One-time fill. Every existing chat gets its summary, and its owner's read marker is set to
   * everything there now, so launch does not show years of history as unread.
   */
  async seed(conversations: { scanPage?(after?: string, limit?: number): Promise<{ items: Conversation[]; next?: string }> }, rooms: { boardRoomsPage?(after?: string, limit?: number): Promise<{ items: Array<{ tenantId: string; owner: string; roomId: string }>; next?: string }> }): Promise<number> {
    if (await this.store.seeded()) return 0;
    let filled = 0;
    const settle = async (summary: ChatSummary | undefined) => {
      if (!summary) return;
      await this.store.markRead({ principalId: summary.owner, tenantId: summary.tenantId, chatId: summary.chatId, readCount: summary.newCount, readAt: new Date().toISOString() });
      filled += 1;
    };
    if (conversations.scanPage) {
      let after: string | undefined;
      do {
        const page = await conversations.scanPage(after, 25);
        for (const conversation of page.items) { const summary = conversationSummary(conversation); await this.store.put(summary); await settle(await this.store.get(summary.chatId, conversation)); }
        after = page.next;
      } while (after);
    }
    if (rooms.boardRoomsPage) {
      let after: string | undefined;
      do {
        const page = await rooms.boardRoomsPage(after, 25);
        for (const item of page.items) {
          const scope = { owner: item.owner, tenantId: item.tenantId };
          await this.catchUpRoom(item.roomId, scope);
          await settle(await this.store.get(item.roomId, scope));
        }
        after = page.next;
      } while (after);
    }
    await this.store.markSeeded();
    return filled;
  }
}

/** Every conversation write updates its chat summary: Bot replies, Run notices, imported room
 * history and Feishu lines all go through this store, so no writer can forget. */
export class SummarizingConversationStore implements ConversationStore {
  constructor(private readonly inner: ConversationStore, private readonly summaries: Pick<ChatSummaryService, 'conversationWritten'>) {}
  /** Every store this wraps pages; one that does not reads as empty. */
  scanPage(after?: string, limit?: number): Promise<{ items: Conversation[]; next?: string }> { return this.inner.scanPage ? this.inner.scanPage(after, limit) : Promise.resolve({ items: [] }); }
  init(): Promise<void> { return this.inner.init(); }
  close(): Promise<void> { return this.inner.close(); }
  async create(value: Conversation): Promise<void> { await this.inner.create(value); await this.summaries.conversationWritten(value); }
  get(id: string, scope: Ownership): Promise<Conversation> { return this.inner.get(id, scope); }
  list(scope: Ownership): Promise<Conversation[]> { return this.inner.list(scope); }
  async mutate(id: string, scope: Ownership, change: (value: Conversation) => void): Promise<Conversation> {
    const next = await this.inner.mutate(id, scope, change);
    await this.summaries.conversationWritten(next);
    return next;
  }
  pending(): AsyncIterable<Conversation> { return this.inner.pending(); }
}
