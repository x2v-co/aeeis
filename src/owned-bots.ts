import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { postgresAdvisoryXactLock } from './adapters/postgres-lock.js';
import type { Ownership } from './security/principal.js';
import { createPostgresPool } from './adapters/postgres-pool.js';

export const OWNED_BOT_CAP = 30;
export const OWNED_BOT_MARKS = ['letter', 'round', 'square', 'diamond', 'drop'] as const;
export const OWNED_BOT_COLORS = ['#171717', '#6b4a32', '#b42318', '#c2410c', '#a16207', '#176b45', '#0f766e', '#1d4e89', '#6d28d9', '#be185d', '#57534e'] as const;
const ownedBotId = z.string().regex(/^bot_[a-z0-9-]{8,80}$/);
const ownedBotMark = z.enum(OWNED_BOT_MARKS);
const ownedBotColor = z.enum(OWNED_BOT_COLORS);
const isoDate = z.string().datetime({ offset: true });

export const ownedBotSchema = z.object({
  id: ownedBotId,
  owner: z.string().trim().min(1).max(200),
  tenantId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(40),
  mark: ownedBotMark,
  color: ownedBotColor,
  background: z.string().trim().min(1).max(800),
  role: z.string().trim().min(1).max(120).optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  retiredAt: isoDate.optional(),
}).strict();
export type OwnedBot = z.infer<typeof ownedBotSchema>;
export type OwnedBotMark = z.infer<typeof ownedBotMark>;

export interface CreateOwnedBotInput {
  id?: string;
  name: string;
  mark: OwnedBotMark;
  color: string;
  background: string;
  role?: string;
}

export interface OwnedBotStore {
  init(): Promise<void>;
  list(scope: Ownership): Promise<OwnedBot[]>;
  get(id: string): Promise<OwnedBot | undefined>;
  create(input: CreateOwnedBotInput, scope: Ownership, now?: string): Promise<OwnedBot>;
  update(id: string, input: CreateOwnedBotInput, scope: Ownership, now?: string): Promise<OwnedBot>;
  recall(id: string): Promise<OwnedBot | undefined>;
  remove(id: string, scope: Ownership, now?: string): Promise<void>;
  close(): Promise<void>;
}

export class OwnedBotConflict extends Error {}
export class OwnedBotNotFound extends Error {}

export function reservedBotName(name: string): boolean {
  const normalized = name.normalize('NFKC').trim();
  return ['所有人', '团队', 'AEEIS'].some(reserved => reserved.localeCompare(normalized, 'zh', { sensitivity: 'accent' }) === 0);
}

export function sameBotName(left: string, right: string): boolean {
  return left.normalize('NFKC').trim().localeCompare(right.normalize('NFKC').trim(), 'zh', { sensitivity: 'accent' }) === 0;
}

export function visibleOwnedBot(bot: OwnedBot): Omit<OwnedBot, 'owner' | 'tenantId'> {
  return {
    id: bot.id, name: bot.name, mark: bot.mark, color: bot.color, background: bot.background,
    ...(bot.role ? { role: bot.role } : {}), createdAt: bot.createdAt, updatedAt: bot.updatedAt,
  };
}

/** Decide whether this profile is already on the account or is a new row.
 * An id this account already saved returns that row. The account copy stays. */
export function decideOwnedBotCreate(existing: readonly OwnedBot[], input: CreateOwnedBotInput, scope: Ownership, now: string): { bot: OwnedBot; inserted: boolean } {
  if (input.id) {
    const found = existing.find(bot => bot.id === input.id);
    if (found?.retiredAt) throw new OwnedBotConflict('这个身份已经撤下。');
    if (found) {
      if (found.owner !== scope.owner || found.tenantId !== scope.tenantId) throw new OwnedBotConflict('这个身份已经属于另一个账号');
      return { bot: structuredClone(found), inserted: false };
    }
  }
  const name = input.name.normalize('NFKC').trim();
  const background = input.background.trim();
  const role = input.role?.trim();
  if (reservedBotName(name)) throw new OwnedBotConflict('请换一个名字。所有人、团队和 AEEIS 留给群里的点名。');
  if (!name || name.length > 40) throw new OwnedBotConflict('先写下名字。');
  if (!background || background.length > 800) throw new OwnedBotConflict('先写下背景，或给出角色定位再生成。');
  if (!OWNED_BOT_MARKS.includes(input.mark)) throw new OwnedBotConflict('样子没有选好。');
  if (!(OWNED_BOT_COLORS as readonly string[]).includes(input.color)) throw new OwnedBotConflict('颜色没有选好。');
  const mine = existing.filter(bot => bot.owner === scope.owner && bot.tenantId === scope.tenantId && !bot.retiredAt);
  if (mine.some(bot => sameBotName(bot.name, name))) throw new OwnedBotConflict('这个名字已经在名单上。');
  if (mine.length >= OWNED_BOT_CAP) throw new OwnedBotConflict(`这个账号最多留下 ${OWNED_BOT_CAP} 位。`);
  const id = input.id ?? `bot_${randomUUID()}`;
  const bot = ownedBotSchema.parse({
    id, owner: scope.owner, tenantId: scope.tenantId, name, mark: input.mark, color: input.color, background,
    ...(role ? { role } : {}), createdAt: now, updatedAt: now,
  });
  return { bot, inserted: true };
}

export function decideOwnedBotUpdate(existing: readonly OwnedBot[], id: string, input: CreateOwnedBotInput, scope: Ownership, now: string): OwnedBot {
  const found = existing.find(bot => bot.id === id);
  if (!found || found.retiredAt || found.owner !== scope.owner || found.tenantId !== scope.tenantId) throw new OwnedBotNotFound('没有这位 Bot');
  const name = input.name.normalize('NFKC').trim();
  const background = input.background.trim();
  const role = input.role?.trim();
  if (reservedBotName(name)) throw new OwnedBotConflict('请换一个名字。所有人、团队和 AEEIS 留给群里的点名。');
  if (!name || name.length > 40) throw new OwnedBotConflict('先写下名字。');
  if (!background || background.length > 800) throw new OwnedBotConflict('先写下背景，或给出角色定位再生成。');
  if (!OWNED_BOT_MARKS.includes(input.mark)) throw new OwnedBotConflict('样子没有选好。');
  if (!(OWNED_BOT_COLORS as readonly string[]).includes(input.color)) throw new OwnedBotConflict('颜色没有选好。');
  const mine = existing.filter(bot => bot.owner === scope.owner && bot.tenantId === scope.tenantId && bot.id !== id && !bot.retiredAt);
  if (mine.some(bot => sameBotName(bot.name, name))) throw new OwnedBotConflict('这个名字已经在名单上。');
  return ownedBotSchema.parse({
    id: found.id, owner: found.owner, tenantId: found.tenantId, name, mark: input.mark, color: input.color, background,
    ...(role ? { role } : {}), createdAt: found.createdAt, updatedAt: now,
  });
}

function sortBots(bots: readonly OwnedBot[]): OwnedBot[] {
  return [...bots].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function liveOwnedBots(bots: readonly OwnedBot[], scope: Ownership): OwnedBot[] {
  return bots.filter(bot => bot.owner === scope.owner && bot.tenantId === scope.tenantId && !bot.retiredAt);
}

function retireOwnedBot(bots: readonly OwnedBot[], id: string, scope: Ownership, now: string): OwnedBot[] {
  const found = bots.find(bot => bot.id === id);
  if (!found || found.owner !== scope.owner || found.tenantId !== scope.tenantId) throw new OwnedBotNotFound('没有这位 Bot');
  if (found.retiredAt) return [...bots];
  return bots.map(bot => bot.id === id ? { ...bot, retiredAt: now, updatedAt: now } : bot);
}

class ExclusiveQueue {
  private tail: Promise<void> = Promise.resolve();
  run<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export class InMemoryOwnedBotStore implements OwnedBotStore {
  private readonly bots: OwnedBot[] = [];
  private readonly queue = new ExclusiveQueue();
  async init(): Promise<void> {}
  async list(scope: Ownership): Promise<OwnedBot[]> {
    return this.queue.run(() => sortBots(liveOwnedBots(this.bots, scope)).map(bot => structuredClone(bot)));
  }
  async get(id: string): Promise<OwnedBot | undefined> {
    return this.queue.run(() => { const bot = this.bots.find(item => item.id === id && !item.retiredAt); return bot ? structuredClone(bot) : undefined; });
  }
  async recall(id: string): Promise<OwnedBot | undefined> {
    return this.queue.run(() => { const bot = this.bots.find(item => item.id === id); return bot ? structuredClone(bot) : undefined; });
  }
  async create(input: CreateOwnedBotInput, scope: Ownership, now = new Date().toISOString()): Promise<OwnedBot> {
    return this.queue.run(() => {
      const decision = decideOwnedBotCreate(this.bots, input, scope, now);
      if (decision.inserted) this.bots.push(structuredClone(decision.bot));
      return structuredClone(decision.bot);
    });
  }
  async update(id: string, input: CreateOwnedBotInput, scope: Ownership, now = new Date().toISOString()): Promise<OwnedBot> {
    return this.queue.run(() => {
      const next = decideOwnedBotUpdate(this.bots, id, input, scope, now);
      const index = this.bots.findIndex(bot => bot.id === next.id);
      this.bots[index] = structuredClone(next);
      return structuredClone(next);
    });
  }
  async remove(id: string, scope: Ownership, now = new Date().toISOString()): Promise<void> {
    return this.queue.run(() => { this.bots.splice(0, this.bots.length, ...retireOwnedBot(this.bots, id, scope, now).map(bot => structuredClone(bot))); });
  }
  async close(): Promise<void> {}
}

interface FileState { bots: OwnedBot[] }

export class JsonOwnedBotStore implements OwnedBotStore {
  private state: FileState = { bots: [] };
  private loaded = false;
  private lockOwned = false;
  private readonly queue = new ExclusiveQueue();
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
      throw new Error('Owned Bot store already has a live writer');
    }
    this.lockOwned = true;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as { bots?: unknown };
      const bots = z.array(ownedBotSchema).parse(parsed.bots ?? []);
      this.state = { bots };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await this.close(); throw error; }
    }
    this.loaded = true;
  }
  async list(scope: Ownership): Promise<OwnedBot[]> {
    return this.queue.run(() => sortBots(liveOwnedBots(this.state.bots, scope)).map(bot => structuredClone(bot)));
  }
  async get(id: string): Promise<OwnedBot | undefined> {
    return this.queue.run(() => { const bot = this.state.bots.find(item => item.id === id && !item.retiredAt); return bot ? structuredClone(bot) : undefined; });
  }
  async recall(id: string): Promise<OwnedBot | undefined> {
    return this.queue.run(() => { const bot = this.state.bots.find(item => item.id === id); return bot ? structuredClone(bot) : undefined; });
  }
  async create(input: CreateOwnedBotInput, scope: Ownership, now = new Date().toISOString()): Promise<OwnedBot> {
    return this.queue.run(() => {
      if (!this.loaded || !this.lockOwned) throw new Error('Owned Bot store is not open');
      const decision = decideOwnedBotCreate(this.state.bots, input, scope, now);
      if (decision.inserted) this.persist({ bots: [...this.state.bots, decision.bot] });
      return structuredClone(decision.bot);
    });
  }
  async update(id: string, input: CreateOwnedBotInput, scope: Ownership, now = new Date().toISOString()): Promise<OwnedBot> {
    return this.queue.run(() => {
      if (!this.loaded || !this.lockOwned) throw new Error('Owned Bot store is not open');
      const next = decideOwnedBotUpdate(this.state.bots, id, input, scope, now);
      this.persist({ bots: this.state.bots.map(bot => bot.id === next.id ? next : bot) });
      return structuredClone(next);
    });
  }
  async remove(id: string, scope: Ownership, now = new Date().toISOString()): Promise<void> {
    return this.queue.run(() => {
      if (!this.loaded || !this.lockOwned) throw new Error('Owned Bot store is not open');
      this.persist({ bots: retireOwnedBot(this.state.bots, id, scope, now) });
    });
  }
  async close(): Promise<void> {
    if (this.lockOwned) { unlinkSync(`${this.filePath}.lock`); this.lockOwned = false; }
    this.loaded = false;
  }
  private persist(next: FileState): void {
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600); writeSync(fd, `${JSON.stringify(next, null, 2)}\n`, undefined, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, this.filePath);
      const directory = openSync(dirname(this.filePath), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
      this.state = { bots: next.bots.map(bot => structuredClone(bot)) };
    } catch (error) { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch { /* the temp file is already gone */ } throw error; }
  }
}

function readBot(value: unknown): OwnedBot {
  return ownedBotSchema.parse(value);
}

export class PostgresOwnedBotStore implements OwnedBotStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = createPostgresPool(connectionString); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'owned-bots', async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_owned_bots (id text PRIMARY KEY, owner text NOT NULL, tenant_id text NOT NULL, state jsonb NOT NULL, created_at timestamptz NOT NULL); CREATE INDEX IF NOT EXISTS aeeis_owned_bots_owner_idx ON aeeis_owned_bots(owner, tenant_id, created_at);`);
    });
  }
  async list(scope: Ownership): Promise<OwnedBot[]> {
    const result = await this.pool.query<{ state: unknown }>('SELECT state FROM aeeis_owned_bots WHERE owner=$1 AND tenant_id=$2 ORDER BY created_at, id', [scope.owner, scope.tenantId]);
    return sortBots(liveOwnedBots(result.rows.map(row => readBot(row.state)), scope));
  }
  async get(id: string): Promise<OwnedBot | undefined> {
    const bot = await this.recall(id);
    return bot && !bot.retiredAt ? bot : undefined;
  }
  async recall(id: string): Promise<OwnedBot | undefined> {
    const result = await this.pool.query<{ state: unknown }>('SELECT state FROM aeeis_owned_bots WHERE id=$1', [id]);
    return result.rows[0] ? readBot(result.rows[0].state) : undefined;
  }
  async create(input: CreateOwnedBotInput, scope: Ownership, now = new Date().toISOString()): Promise<OwnedBot> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await postgresAdvisoryXactLock(client, 'aeeis:owned-bots', `${scope.tenantId}\0${scope.owner}`);
      const mine = await client.query<{ state: unknown }>('SELECT state FROM aeeis_owned_bots WHERE owner=$1 AND tenant_id=$2', [scope.owner, scope.tenantId]);
      const byId = input.id ? await client.query<{ state: unknown }>('SELECT state FROM aeeis_owned_bots WHERE id=$1', [input.id]) : { rows: [] };
      const existing = [...mine.rows.map(row => readBot(row.state))];
      for (const row of byId.rows) {
        const bot = readBot(row.state);
        if (!existing.some(item => item.id === bot.id)) existing.push(bot);
      }
      const decision = decideOwnedBotCreate(existing, input, scope, now);
      if (decision.inserted) {
        await client.query('INSERT INTO aeeis_owned_bots(id, owner, tenant_id, state, created_at) VALUES($1,$2,$3,$4,$5)', [decision.bot.id, decision.bot.owner, decision.bot.tenantId, decision.bot, decision.bot.createdAt]);
      }
      await client.query('COMMIT');
      return decision.bot;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((error as { code?: string }).code === '23505') throw new OwnedBotConflict('这个身份已经属于另一个账号');
      throw error;
    } finally { client.release(); }
  }
  async update(id: string, input: CreateOwnedBotInput, scope: Ownership, now = new Date().toISOString()): Promise<OwnedBot> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await postgresAdvisoryXactLock(client, 'aeeis:owned-bots', `${scope.tenantId}\0${scope.owner}`);
      const mine = await client.query<{ state: unknown }>('SELECT state FROM aeeis_owned_bots WHERE owner=$1 AND tenant_id=$2', [scope.owner, scope.tenantId]);
      const byId = await client.query<{ state: unknown }>('SELECT state FROM aeeis_owned_bots WHERE id=$1', [id]);
      const existing = mine.rows.map(row => readBot(row.state));
      for (const row of byId.rows) {
        const bot = readBot(row.state);
        if (!existing.some(item => item.id === bot.id)) existing.push(bot);
      }
      const next = decideOwnedBotUpdate(existing, id, input, scope, now);
      await client.query('UPDATE aeeis_owned_bots SET state=$2 WHERE id=$1', [next.id, next]);
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  async remove(id: string, scope: Ownership, now = new Date().toISOString()): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ state: unknown }>('SELECT state FROM aeeis_owned_bots WHERE id=$1 FOR UPDATE', [id]);
      const row = result.rows[0];
      if (!row) throw new OwnedBotNotFound('没有这位 Bot');
      const next = retireOwnedBot([readBot(row.state)], id, scope, now)[0];
      if (next?.retiredAt) await client.query('UPDATE aeeis_owned_bots SET state=$2 WHERE id=$1', [id, next]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
