import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { createPostgresPool } from './adapters/postgres-pool.js';
import type { BotOpen, OwnedBot, OwnedBotStore } from './owned-bots.js';
import type { Ownership } from './security/principal.js';

/**
 * Stage 3c: someone else in the same tenant talks to your Bot one to one.
 *
 * Everything about that crossing lives here, so there is one place to read when checking it:
 * - who may (the open settings on the Bot, same tenant, not the owner, in the audience),
 * - what the Bot shows them (name, role, the background meant for others; never the standing instruction),
 * - what their Runs may do (tools: what they chose ∩ what the owner opened, never a Bot computer; review always required),
 * - and the usage the owner sees (counts and tokens only, never content).
 */

/** Why someone cannot use a Bot opened to them any more. */
export type OpenBotState = 'open' | 'closed' | 'retired';

/** The open settings this person may use, or undefined. The one check every requester path goes through. */
export function openAccess(bot: OwnedBot | undefined, who: Ownership): BotOpen | undefined {
  if (!bot || bot.retiredAt || !bot.open) return undefined;
  if (bot.tenantId !== who.tenantId || bot.owner === who.owner) return undefined;
  if (bot.open.audience.kind === 'people' && !bot.open.audience.people.includes(who.owner)) return undefined;
  return bot.open;
}
export function openState(bot: OwnedBot | undefined, who: Ownership): OpenBotState {
  if (!bot || bot.retiredAt) return 'retired';
  return openAccess(bot, who) ? 'open' : 'closed';
}

/** What a requester and the model answering them may know about the Bot. No owner content: no standing instruction,
 * no memory, no chats, no routines, no autonomy. */
export interface PublicBotProfile { name: string; role?: string; background: string }
export function publicBotProfile(bot: OwnedBot, open: BotOpen): PublicBotProfile {
  return { name: bot.name, ...(bot.role ? { role: bot.role } : {}), background: open.publicBackground ?? bot.background };
}
/** The card the requester's 「新建」 and profile page show. */
export function openBotCard(bot: OwnedBot, open: BotOpen, ownerName: string) {
  return { id: bot.id, name: bot.name, mark: bot.mark, color: bot.color, ...(bot.role ? { role: bot.role } : {}), background: open.publicBackground ?? bot.background, owner: bot.owner, ownerName, tools: [...open.tools], monthlyRunLimit: open.monthlyRunLimit };
}

// ---------------------------------------------------------------- tools

export function toolId(ref: string): string {
  const at = ref.lastIndexOf('@');
  return at > 0 ? ref.slice(0, at) : ref;
}
/** Read-only means the manifest says only `read` (and `network` for reading the web). A tool that declares nothing,
 * or anything else (`write`, `execute`, ...), is not. Remote tools without a declaration are listed as `execute`. */
export function readOnlyTool(capabilities: readonly string[]): boolean {
  return capabilities.includes('read') && capabilities.every(item => item === 'read' || item === 'network');
}
export function writingTool(capabilities: readonly string[]): boolean { return capabilities.includes('write'); }
export interface OpenToolChoice { id: string; version: string; readOnly: boolean; write: boolean; capabilities: string[]; description?: string }
/** The tools an owner may open to others: every configured tool except those that run on a Bot computer. */
export function openToolChoices(tools: ReadonlyArray<{ id: string; version: string; capabilities: string[]; description?: string }>, machineTools: ReadonlySet<string>): OpenToolChoice[] {
  const seen = new Set<string>();
  const choices: OpenToolChoice[] = [];
  for (const tool of tools) {
    if (machineTools.has(tool.id) || seen.has(tool.id)) continue;
    seen.add(tool.id);
    choices.push({ id: tool.id, version: tool.version, readOnly: readOnlyTool(tool.capabilities), write: writingTool(tool.capabilities), capabilities: [...tool.capabilities], ...(tool.description ? { description: tool.description.slice(0, 200) } : {}) });
  }
  return choices;
}
/** Checks what the owner asked to open: known, not on a Bot computer, and a writing tool only when confirmed. */
export function checkOpenTools(requested: readonly string[], choices: readonly OpenToolChoice[], confirmWrite: boolean): string[] {
  const ids = [...new Set(requested.map(toolId))];
  for (const id of ids) {
    const choice = choices.find(item => item.id === id);
    if (!choice) throw new OpenBotRefusal(`工具 ${id} 不能开放给别人：没有这个工具，或它要用 Bot 电脑。`);
    if (choice.write && !confirmWrite) throw new OpenBotRefusal(`工具 ${id} 会写入，开放给别人前要再确认一次。`);
  }
  return ids;
}
export class OpenBotRefusal extends Error {}

/** The requester's Run options, cut down to what a borrowed Bot may do. The server computes this; the page's values
 * only ever narrow it. Tools: chosen ∩ opened, minus Bot-computer tools. Review: always the requester's approval
 * (autonomy capped at `reply`; a Work Grant, auto or yolo never carries over). Everything that would read or reach
 * something beyond the requester's own request is dropped: brain, memory, knowledge, project sources, agents,
 * built-in skills (they need a computer), repository publishing and declared resources. */
export function requesterRunOptions<T extends Record<string, unknown>>(options: T | undefined, open: BotOpen, machineTools: ReadonlySet<string>): Record<string, unknown> {
  const source = (options ?? {}) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of ['maxModelCalls', 'modelBudget', 'externalBudget', 'privacy', 'planning', 'acceptance', 'materials', 'workingMemory'] as const) {
    if (source[key] !== undefined) kept[key] = source[key];
  }
  const allowed = new Set(open.tools);
  const tools = Array.isArray(source.allowedTools) ? (source.allowedTools as unknown[]).filter((ref): ref is string => typeof ref === 'string') : [];
  kept.allowedTools = [...new Set(tools.filter(ref => allowed.has(toolId(ref)) && !machineTools.has(toolId(ref))))];
  kept.executionReview = 'required';
  return kept;
}

// ---------------------------------------------------------------- usage

/** One line of what someone else did with a Bot: a Run, or a reply in the chat. Counts and tokens only. */
const usageRowSchema = z.object({
  tenantId: z.string().min(1).max(200),
  /** The Run id, or the reply's key. Recording the same id twice changes nothing. */
  id: z.string().min(1).max(300),
  botId: z.string().min(1).max(100),
  botOwner: z.string().min(1).max(200),
  requester: z.string().min(1).max(200),
  kind: z.enum(['run', 'reply']),
  /** Calendar month in UTC, YYYY-MM. */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  at: z.string(),
  tokens: z.number().int().nonnegative(),
}).strict();
export type OpenBotUsageRow = z.infer<typeof usageRowSchema>;
export interface OpenBotUsageLine { requester: string; lastAt: string; runs: number; tokens: number }
export const usageMonth = (at: string) => at.slice(0, 7);

export interface OpenBotUsageStore {
  init?(): Promise<void>;
  close?(): Promise<void>;
  /** Writes the row once; a repeat keeps the first row (and its tokens). */
  record(row: OpenBotUsageRow): Promise<void>;
  /** Sets the tokens of a Run once it settles. Never lowers them. */
  settle(tenantId: string, id: string, tokens: number): Promise<void>;
  runsThisMonth(tenantId: string, botId: string, requester: string, month: string): Promise<number>;
  /** The owner's view: per person, in this month. Filtered by the Bot's owner as well as the Bot. */
  summary(tenantId: string, botId: string, botOwner: string, month: string): Promise<OpenBotUsageLine[]>;
}
function summarize(rows: readonly OpenBotUsageRow[]): OpenBotUsageLine[] {
  const lines = new Map<string, OpenBotUsageLine>();
  for (const row of rows) {
    const line = lines.get(row.requester) ?? { requester: row.requester, lastAt: row.at, runs: 0, tokens: 0 };
    if (row.kind === 'run') line.runs += 1;
    line.tokens += row.tokens;
    if (row.at > line.lastAt) line.lastAt = row.at;
    lines.set(row.requester, line);
  }
  return [...lines.values()].sort((left, right) => right.lastAt.localeCompare(left.lastAt));
}

export class InMemoryOpenBotUsageStore implements OpenBotUsageStore {
  protected rows: OpenBotUsageRow[] = [];
  async record(row: OpenBotUsageRow): Promise<void> {
    const parsed = usageRowSchema.parse(row);
    if (!this.rows.some(item => item.tenantId === parsed.tenantId && item.id === parsed.id)) this.rows.push(parsed);
  }
  async settle(tenantId: string, id: string, tokens: number): Promise<void> {
    const row = this.rows.find(item => item.tenantId === tenantId && item.id === id);
    if (row && Number.isSafeInteger(tokens) && tokens > row.tokens) row.tokens = tokens;
  }
  async runsThisMonth(tenantId: string, botId: string, requester: string, month: string): Promise<number> {
    return this.rows.filter(row => row.tenantId === tenantId && row.botId === botId && row.requester === requester && row.month === month && row.kind === 'run').length;
  }
  async summary(tenantId: string, botId: string, botOwner: string, month: string): Promise<OpenBotUsageLine[]> {
    return summarize(this.rows.filter(row => row.tenantId === tenantId && row.botId === botId && row.botOwner === botOwner && row.month === month));
  }
}

export class JsonOpenBotUsageStore extends InMemoryOpenBotUsageStore {
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) { super(); }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  async init(): Promise<void> { await this.serial(() => this.load()); }
  override async record(row: OpenBotUsageRow): Promise<void> { await this.serial(async () => { await this.load(); const before = this.rows.length; await super.record(row); if (this.rows.length !== before) await this.save(); }); }
  override async settle(tenantId: string, id: string, tokens: number): Promise<void> { await this.serial(async () => { await this.load(); const before = JSON.stringify(this.rows); await super.settle(tenantId, id, tokens); if (JSON.stringify(this.rows) !== before) await this.save(); }); }
  override async runsThisMonth(...args: Parameters<InMemoryOpenBotUsageStore['runsThisMonth']>): Promise<number> { await this.init(); return super.runsThisMonth(...args); }
  override async summary(...args: Parameters<InMemoryOpenBotUsageStore['summary']>): Promise<OpenBotUsageLine[]> { await this.init(); return super.summary(...args); }
  async close(): Promise<void> { await this.queue; }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try { this.rows = z.array(usageRowSchema).parse((JSON.parse(await readFile(this.path, 'utf8')) as { rows?: unknown }).rows ?? []); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.loaded = true;
  }
  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify({ rows: this.rows })}\n`); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
    } finally { await unlink(temp).catch(() => undefined); }
  }
}

/** Counts and tokens only, so the row is not sealed; tenant row-level security applies (postgres-pool.ts). */
export class PostgresOpenBotUsageStore implements OpenBotUsageStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = createPostgresPool(connectionString); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'open-bot-usage', async client => {
      await client.query('CREATE TABLE IF NOT EXISTS aeeis_open_bot_usage (tenant_id text NOT NULL, id text NOT NULL, bot_id text NOT NULL, bot_owner text NOT NULL, requester text NOT NULL, kind text NOT NULL, month text NOT NULL, at timestamptz NOT NULL, tokens bigint NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, id)); CREATE INDEX IF NOT EXISTS aeeis_open_bot_usage_bot_idx ON aeeis_open_bot_usage(tenant_id, bot_id, month)');
    });
  }
  async record(row: OpenBotUsageRow): Promise<void> {
    const value = usageRowSchema.parse(row);
    await this.pool.query('INSERT INTO aeeis_open_bot_usage(tenant_id, id, bot_id, bot_owner, requester, kind, month, at, tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id, id) DO NOTHING',
      [value.tenantId, value.id, value.botId, value.botOwner, value.requester, value.kind, value.month, value.at, value.tokens]);
  }
  async settle(tenantId: string, id: string, tokens: number): Promise<void> {
    if (!Number.isSafeInteger(tokens) || tokens < 0) return;
    await this.pool.query('UPDATE aeeis_open_bot_usage SET tokens=GREATEST(tokens, $3) WHERE tenant_id=$1 AND id=$2', [tenantId, id, tokens]);
  }
  async runsThisMonth(tenantId: string, botId: string, requester: string, month: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>("SELECT count(*) FROM aeeis_open_bot_usage WHERE tenant_id=$1 AND bot_id=$2 AND requester=$3 AND month=$4 AND kind='run'", [tenantId, botId, requester, month]);
    return Number(result.rows[0]?.count ?? 0);
  }
  async summary(tenantId: string, botId: string, botOwner: string, month: string): Promise<OpenBotUsageLine[]> {
    const result = await this.pool.query<{ requester: string; last_at: Date; runs: string; tokens: string }>(
      "SELECT requester, max(at) AS last_at, count(*) FILTER (WHERE kind='run') AS runs, coalesce(sum(tokens),0) AS tokens FROM aeeis_open_bot_usage WHERE tenant_id=$1 AND bot_id=$2 AND bot_owner=$3 AND month=$4 GROUP BY requester ORDER BY max(at) DESC",
      [tenantId, botId, botOwner, month]);
    return result.rows.map(row => ({ requester: row.requester, lastAt: new Date(row.last_at).toISOString(), runs: Number(row.runs), tokens: Number(row.tokens) }));
  }
  async close(): Promise<void> { await this.pool.end(); }
}

// ---------------------------------------------------------------- the port the conversation path uses

/** A Bot someone else opened to this person, as the conversation path sees it. */
export interface BorrowedBot { bot: OwnedBot; open: BotOpen }
/** What ConversationService and BotDialogueService need to serve a borrowed Bot. */
export class OpenBots {
  constructor(private readonly bots: Pick<OwnedBotStore, 'get' | 'recall'>, readonly usage: OpenBotUsageStore, readonly machineTools: ReadonlySet<string> = new Set(),
    private readonly personName: (principalId: string, tenantId: string) => Promise<string | undefined> = async () => undefined, private readonly now: () => string = () => new Date().toISOString()) {}
  /** The Bot and its open settings when `who` may use it now. */
  async access(botId: string, who: Ownership): Promise<BorrowedBot | undefined> {
    if (!botId.startsWith('bot_')) return undefined;
    const bot = await this.bots.get(botId).catch(() => undefined);
    const open = openAccess(bot, who);
    return bot && open ? { bot, open } : undefined;
  }
  /** Whether a Bot id belongs to someone else (so this scope cannot start a plain chat, routine or channel with it). */
  async foreign(botId: string, who: Ownership): Promise<boolean> {
    if (!botId.startsWith('bot_')) return false;
    const bot = await this.bots.recall(botId).catch(() => undefined);
    return Boolean(bot && (bot.owner !== who.owner || bot.tenantId !== who.tenantId));
  }
  async state(botId: string, who: Ownership): Promise<OpenBotState> {
    return openState(await this.bots.recall(botId).catch(() => undefined), who);
  }
  async ownerName(owner: string, tenantId: string): Promise<string> {
    return (await this.personName(owner, tenantId).catch(() => undefined))?.trim() || owner;
  }
  /** Refuses a new Run once this person used up the month the owner gave them. */
  async assertRunAllowed(borrowed: BorrowedBot, who: Ownership): Promise<void> {
    const used = await this.usage.runsThisMonth(who.tenantId, borrowed.bot.id, who.owner, usageMonth(this.now()));
    if (used >= borrowed.open.monthlyRunLimit) {
      const owner = await this.ownerName(borrowed.bot.owner, borrowed.bot.tenantId);
      throw new OpenBotRefusal(`这个月已经用满${owner}给你的 ${borrowed.open.monthlyRunLimit} 个 Run。${borrowed.bot.name}还能照常回话，下个月再开新的 Run。`);
    }
  }
  async recordRun(borrowed: BorrowedBot, who: Ownership, runId: string): Promise<void> {
    const at = this.now();
    await this.usage.record({ tenantId: who.tenantId, id: runId, botId: borrowed.bot.id, botOwner: borrowed.bot.owner, requester: who.owner, kind: 'run', month: usageMonth(at), at, tokens: 0 });
  }
  async recordReply(borrowed: BorrowedBot, who: Ownership, key: string, tokens: number): Promise<void> {
    const at = this.now();
    await this.usage.record({ tenantId: who.tenantId, id: `reply:${key}`, botId: borrowed.bot.id, botOwner: borrowed.bot.owner, requester: who.owner, kind: 'reply', month: usageMonth(at), at, tokens: Number.isSafeInteger(tokens) && tokens > 0 ? tokens : 0 });
  }
}
