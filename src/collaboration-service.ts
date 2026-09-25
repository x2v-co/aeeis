import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  appendDebateMessage,
  adjudicateDebate,
  debateAdjudicationSchema,
  debateModeratorReviewSchema,
  debateMessageSchema,
  isSupportedDebateDecision,
  candidateScoreSchema,
  competitionBriefSchema,
  debateRoomSchema,
  type CandidateRunner,
  type CandidateScore,
  type CompetitionBrief,
  type DebateMessage,
  type DebateRoom,
  type IndependentEvaluator,
} from './collaboration.js';
import { resultEnvelopeSchema } from './protocol.js';
import type { Ownership } from './security/principal.js';
import pg from 'pg';
import { ModelOutcomeUnknown } from './runtime/model.js';
import { assertCollaborationBudget, collaborationBudgetSchema, collaborationCallUsageSchema, collaborationModelPinSchema, collaborationUsage, collaborationUsageSchema, type CollaborationCallUsage, type CollaborationModelPin } from './collaboration-budget.js';
import type { GlobalBudgetLedger, GlobalBudgetSelector, GlobalBudgetSelection } from './global-budget.js';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { afterCollectionCursor, decodeCollectionCursor, encodeCollectionCursor, scopedRecent, validateCollectionLimit, type CollectionCursor } from './adapters/collection-query.js';

function matchesScope(value: { owner?: string; tenantId?: string }, scope?: Ownership): boolean {
  return scope === undefined || (value.owner ?? 'owner') === scope.owner && (value.tenantId ?? 'local') === scope.tenantId;
}
function pageRecords<T extends { id: string; owner?: string; tenantId?: string; updatedAt: string }>(items: T[], scope: Ownership | undefined, limit: number, cursor?: string): CollaborationPage<T> {
  validateCollectionLimit(limit);
  const pageCursor = decodeCollectionCursor(cursor);
  const selected = items.filter(item => matchesScope(item, scope) && afterCollectionCursor(item, item.updatedAt, pageCursor))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const page = selected.slice(0, limit + 1); const hasMore = page.length > limit; const visible = hasMore ? page.slice(0, limit) : page;
  return { items: structuredClone(visible), ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt, id: visible.at(-1)!.id }) } : {}) };
}

const id = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const isoDate = z.string().datetime({ offset: true });
const competitionStatus = z.enum(['collecting', 'running', 'evaluating', 'completed', 'partial', 'failed']);
const debateStatus = z.enum(['active', 'closed']);
export const debateRolesSchema = z.object({ moderatorAgentId: id.optional(), adjudicatorAgentId: id.optional() }).strict();
const debateAttemptSchema = z.object({
  globalBudgetAccountKey: z.string().max(1000).optional(),
  usage: collaborationCallUsageSchema.optional(),
  model: collaborationModelPinSchema.optional(),
  id, slot: z.string().min(1).max(300), agentId: id,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['started', 'completed', 'unknown', 'failed']),
  startedAt: isoDate, endedAt: isoDate.optional(), output: z.unknown().optional(),
  error: z.string().max(4000).optional(), reconciliationReason: z.string().max(4000).optional(),
}).strict();
export type DebateAttempt = z.infer<typeof debateAttemptSchema>;
const competitionAttemptSchema = z.object({
  globalBudgetAccountKey: z.string().max(1000).optional(),
  reconciliationReason: z.string().max(4000).optional(),
  usage: collaborationCallUsageSchema.optional(),
  model: collaborationModelPinSchema.optional(),
  id, participantAgentId: id, inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['started', 'completed', 'failed', 'reconciled', 'unknown']), startedAt: isoDate,
  endedAt: isoDate.optional(), error: z.string().max(4000).optional(), result: resultEnvelopeSchema.optional(),
}).strict();
const evaluatorAttemptSchema = z.object({
  globalBudgetAccountKey: z.string().max(1000).optional(),
  reconciliationReason: z.string().max(4000).optional(),
  usage: collaborationCallUsageSchema.optional(),
  model: collaborationModelPinSchema.optional(),
  id, inputHash: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['started', 'completed', 'failed', 'unknown']),
  startedAt: isoDate, endedAt: isoDate.optional(), error: z.string().max(4000).optional(), scores: z.array(candidateScoreSchema).max(12).optional(),
}).strict();

export const competitionRecordSchema = z.object({
  usage: collaborationUsageSchema.optional(),
  schemaVersion: z.literal(1), id, owner: z.string().min(1).max(200).default('owner'), tenantId: z.string().min(1).max(200).default('local'), brief: competitionBriefSchema, status: competitionStatus,
  candidates: z.array(resultEnvelopeSchema).max(12), scores: z.array(candidateScoreSchema).max(12),
  attempts: z.array(competitionAttemptSchema).max(12).default([]), evaluatorAttempt: evaluatorAttemptSchema.optional(),
  evaluatorAgentId: id.optional(), selectedAgentId: id.optional(), failureReason: z.string().max(4000).optional(), totalCost: z.number().nonnegative(),
  createdAt: isoDate, updatedAt: isoDate, completedAt: isoDate.optional(),
}).strict();
export const debateRecordSchema = z.object({
  usage: collaborationUsageSchema.optional(),
  schemaVersion: z.literal(1), id, owner: z.string().min(1).max(200).default('owner'), tenantId: z.string().min(1).max(200).default('local'), room: debateRoomSchema, status: debateStatus,
  modelBudget: collaborationBudgetSchema.optional(),
  roles: debateRolesSchema.optional(), attempts: z.array(debateAttemptSchema).max(1000).default([]),
  createdAt: isoDate, updatedAt: isoDate, closedAt: isoDate.optional(), closeReason: z.string().max(4000).optional(),
}).strict();
const stateSchema = z.object({ competitions: z.array(competitionRecordSchema).max(1000), debates: z.array(debateRecordSchema).max(1000) }).strict();
const collaborationSummarySchema = z.object({ id, owner: z.string().min(1).max(200), tenantId: z.string().min(1).max(200), updatedAt: isoDate, size: z.number().nonnegative(), mtimeMs: z.number().nonnegative() }).strict();
const collaborationIndexSchema = z.object({ version: z.literal(1), competitions: z.array(collaborationSummarySchema).max(1000), debates: z.array(collaborationSummarySchema).max(1000) }).strict();
type CollaborationState = z.infer<typeof stateSchema>;
type CollaborationSummary = z.infer<typeof collaborationSummarySchema>;
type CollaborationIndex = z.infer<typeof collaborationIndexSchema>;
const candidateInputSchema = resultEnvelopeSchema;
const debateInputSchema = z.object({
  modelBudget: collaborationBudgetSchema.optional(),
  taskId: id, contextVersion: id, goal: z.string().max(8000).optional(), participantAgentIds: z.array(id).min(1).max(12),
  context: z.object({ classification: z.enum(['public', 'internal', 'confidential', 'private']), claims: z.array(z.object({ id, text: z.string().min(1).max(4000), evidenceRefs: z.array(id).max(100) }).strict()).max(200), artifactRefs: z.array(id).max(200), redactions: z.array(z.string().max(500)).max(100) }).strict().optional(),
  maxRounds: z.number().int().min(1).max(12).default(4), maxMessagesPerAgent: z.number().int().min(1).max(20).default(4),
  maxTotalMessages: z.number().int().min(1).max(100).optional(),
}).strict();

export type CompetitionRecord = z.infer<typeof competitionRecordSchema>;
export type CompetitionAttempt = z.infer<typeof competitionAttemptSchema>;
export type DebateRecord = z.infer<typeof debateRecordSchema>;

export interface CollaborationRepository {
  createCompetition(record: CompetitionRecord): Promise<void>;
  getCompetition(id: string, scope?: Ownership): Promise<CompetitionRecord>;
  listCompetitions(scope?: Ownership, limit?: number): Promise<CompetitionRecord[]>;
  pageCompetitions?(scope: Ownership | undefined, limit: number, cursor?: string): Promise<CollaborationPage<CompetitionRecord>>;
  mutateCompetition(id: string, change: (record: CompetitionRecord) => CompetitionRecord, scope?: Ownership): Promise<CompetitionRecord>;
  createDebate(record: DebateRecord): Promise<void>;
  getDebate(id: string, scope?: Ownership): Promise<DebateRecord>;
  listDebates(scope?: Ownership, limit?: number): Promise<DebateRecord[]>;
  pageDebates?(scope: Ownership | undefined, limit: number, cursor?: string): Promise<CollaborationPage<DebateRecord>>;
  mutateDebate(id: string, change: (record: DebateRecord) => DebateRecord, scope?: Ownership): Promise<DebateRecord>;
  close(): Promise<void>;
}

export interface CollaborationPage<T> { items: T[]; nextCursor?: string }

export class CollaborationNotFound extends Error {}

/** Durable local collaboration state. A single writer owns the directory. */
export class FileCollaborationRepository implements CollaborationRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private lockPath: string;
  private statePath: string;
  private indexPath: string;
  private competitionsDirectory: string;
  private debatesDirectory: string;
  private state: CollaborationState | undefined;
  private recordsMode = false;
  private index: CollaborationIndex | undefined;

  constructor(private readonly directory: string) {
    this.lockPath = join(directory, '.writer.lock');
    this.statePath = join(directory, 'collaborations.json');
    this.indexPath = join(directory, 'collaboration.index.json');
    this.competitionsDirectory = join(directory, 'competitions');
    this.debatesDirectory = join(directory, 'debates');
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const lock = await open(this.lockPath, 'wx', 0o600);
      await lock.writeFile(String(process.pid)); await lock.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(this.lockPath, 'utf8'));
      try { process.kill(pid, 0); throw new Error('Collaboration directory already has a live writer'); }
      catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
        await unlink(this.lockPath); return this.init();
      }
    }
    await mkdir(this.competitionsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.debatesDirectory, { recursive: true, mode: 0o700 });
    this.state = undefined; this.index = undefined; this.recordsMode = true;
    const hasRecordFiles = (await readdir(this.competitionsDirectory)).some(file => file.endsWith('.json'))
      || (await readdir(this.debatesDirectory)).some(file => file.endsWith('.json'));
    if (!hasRecordFiles) {
      try { await this.migrateLegacy(stateSchema.parse(JSON.parse(await readFile(this.statePath, 'utf8')))); return; }
      catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw legacyError;
        this.index = { version: 1, competitions: [], debates: [] }; await this.saveIndex(); return;
      }
    }
    try { await this.loadRecordIndex(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.index = await this.rebuildRecordIndex();
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next;
  }

  private async load(): Promise<CollaborationState> {
    if (!this.state) throw new Error('Collaboration repository is not open');
    return structuredClone(this.state);
  }

  private async save(state: CollaborationState): Promise<void> {
    const committed = stateSchema.parse(state);
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(committed)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.statePath);
    this.state = committed;
    const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }

  private recordPath(kind: 'competition' | 'debate', idValue: string): string {
    if (!/^[a-z][a-z0-9_.-]{1,127}$/.test(idValue)) throw new CollaborationNotFound('Unknown collaboration');
    return join(kind === 'competition' ? this.competitionsDirectory : this.debatesDirectory, `${idValue}.json`);
  }
  private summaries(kind: 'competition' | 'debate'): CollaborationSummary[] {
    if (!this.index) throw new Error('Collaboration repository is not open');
    return kind === 'competition' ? this.index.competitions : this.index.debates;
  }
  private async saveIndex(): Promise<void> {
    if (!this.index) return;
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(collaborationIndexSchema.parse(this.index))); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.indexPath);
    const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
  private async writeRecord(kind: 'competition' | 'debate', record: CompetitionRecord | DebateRecord): Promise<void> {
    const parsed = kind === 'competition' ? competitionRecordSchema.parse(record) : debateRecordSchema.parse(record);
    const path = this.recordPath(kind, parsed.id), temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(parsed)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const metadata = await stat(path);
    const summary: CollaborationSummary = { id: parsed.id, owner: parsed.owner ?? 'owner', tenantId: parsed.tenantId ?? 'local', updatedAt: parsed.updatedAt, size: metadata.size, mtimeMs: metadata.mtimeMs };
    const items = this.summaries(kind), index = items.findIndex(item => item.id === parsed.id);
    if (index < 0) items.push(summary); else items[index] = summary;
    try { await this.saveIndex(); } catch { /* canonical record is durable; the index is disposable */ }
    const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
  private async readRecord<T extends CompetitionRecord | DebateRecord>(kind: 'competition' | 'debate', idValue: string): Promise<T> {
    try {
      const raw = JSON.parse(await readFile(this.recordPath(kind, idValue), 'utf8'));
      return (kind === 'competition' ? competitionRecordSchema : debateRecordSchema).parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CollaborationNotFound('Unknown collaboration');
      throw error;
    }
  }
  private async indexMatchesFiles(index: CollaborationIndex): Promise<boolean> {
    const check = async (kind: 'competition' | 'debate', items: CollaborationSummary[]): Promise<boolean> => {
      const directory = kind === 'competition' ? this.competitionsDirectory : this.debatesDirectory;
      const files = (await readdir(directory)).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).sort();
      const indexed = items.map(item => item.id).sort();
      if (files.length !== indexed.length || files.some((file, index) => file !== indexed[index])) return false;
      for (const item of items) {
        const metadata = await stat(this.recordPath(kind, item.id)).catch(() => undefined);
        if (!metadata || metadata.size !== item.size || metadata.mtimeMs !== item.mtimeMs) return false;
      }
      return true;
    };
    return await check('competition', index.competitions) && await check('debate', index.debates);
  }
  private async rebuildRecordIndex(): Promise<CollaborationIndex> {
    const rebuild = async (kind: 'competition' | 'debate'): Promise<CollaborationSummary[]> => {
      const directory = kind === 'competition' ? this.competitionsDirectory : this.debatesDirectory;
      const records: CollaborationSummary[] = [];
      for (const file of (await readdir(directory)).filter(value => value.endsWith('.json'))) {
        const record = await this.readRecord(kind, file.slice(0, -5));
        const metadata = await stat(this.recordPath(kind, record.id));
        records.push({ id: record.id, owner: record.owner ?? 'owner', tenantId: record.tenantId ?? 'local', updatedAt: record.updatedAt, size: metadata.size, mtimeMs: metadata.mtimeMs });
      }
      return records;
    };
    const rebuilt: CollaborationIndex = { version: 1, competitions: await rebuild('competition'), debates: await rebuild('debate') };
    this.index = rebuilt;
    try { await this.saveIndex(); } catch { /* disposable index */ }
    return rebuilt;
  }
  private async loadRecordIndex(): Promise<void> {
    let parsed: CollaborationIndex;
    try { parsed = collaborationIndexSchema.parse(JSON.parse(await readFile(this.indexPath, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      parsed = await this.rebuildRecordIndex();
    }
    this.index = await this.indexMatchesFiles(parsed) ? parsed : await this.rebuildRecordIndex();
  }
  private async migrateLegacy(state: CollaborationState): Promise<void> {
    this.index = { version: 1, competitions: [], debates: [] };
    for (const record of state.competitions) await this.writeRecord('competition', record);
    for (const record of state.debates) await this.writeRecord('debate', record);
    await this.saveIndex();
  }

  createCompetition(record: CompetitionRecord): Promise<void> {
    return this.serial(async () => {
      if (this.recordsMode) {
        if (this.summaries('competition').some(item => item.id === record.id)) throw new Error('Competition already exists');
        await this.writeRecord('competition', record); return;
      }
      const state = await this.load(); if (state.competitions.some(item => item.id === record.id)) throw new Error('Competition already exists');
      state.competitions.push(competitionRecordSchema.parse(record)); await this.save(state);
    });
  }

  async getCompetition(idValue: string, scope?: Ownership): Promise<CompetitionRecord> {
    if (this.recordsMode) {
      const item = await this.readRecord<CompetitionRecord>('competition', idValue);
      if (!matchesScope(item, scope)) throw new CollaborationNotFound('Unknown competition'); return item;
    }
    const item = (await this.load()).competitions.find(candidate => candidate.id === idValue);
    if (!item || !matchesScope(item, scope)) throw new CollaborationNotFound('Unknown competition'); return item;
  }

  async listCompetitions(scope?: Ownership, limit?: number): Promise<CompetitionRecord[]> {
    validateCollectionLimit(limit);
    if (this.recordsMode) {
      const selected = scopedRecent(this.summaries('competition'), item => item.updatedAt, scope, limit);
      return Promise.all(selected.map(item => this.readRecord<CompetitionRecord>('competition', item.id)));
    }
    if (!this.state) throw new Error('Collaboration repository is not open');
    const items = this.state.competitions.filter(item => matchesScope(item, scope));
    return structuredClone(limit === undefined ? items : scopedRecent(items, item => item.updatedAt, scope, limit));
  }
  async pageCompetitions(scope: Ownership | undefined, limit: number, cursor?: string): Promise<CollaborationPage<CompetitionRecord>> {
    validateCollectionLimit(limit);
    if (this.recordsMode) {
      const pageCursor = decodeCollectionCursor(cursor);
      const selected = this.summaries('competition').filter(item => matchesScope(item, scope) && afterCollectionCursor(item, item.updatedAt, pageCursor))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const page = selected.slice(0, limit + 1); const hasMore = page.length > limit; const visible = hasMore ? page.slice(0, limit) : page;
      return { items: await Promise.all(visible.map(item => this.readRecord<CompetitionRecord>('competition', item.id))), ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt, id: visible.at(-1)!.id }) } : {}) };
    }
    return pageRecords((await this.load()).competitions, scope, limit, cursor);
  }

  mutateCompetition(idValue: string, change: (record: CompetitionRecord) => CompetitionRecord, scope?: Ownership): Promise<CompetitionRecord> {
    return this.serial(async () => {
      if (this.recordsMode) {
        const current = await this.readRecord<CompetitionRecord>('competition', idValue);
        if (!matchesScope(current, scope)) throw new CollaborationNotFound('Unknown competition');
        const next = competitionRecordSchema.parse(change(structuredClone(current)));
        if (!matchesScope(next, scope)) throw new CollaborationNotFound('Unknown competition');
        await this.writeRecord('competition', next); return next;
      }
      const state = await this.load(); const index = state.competitions.findIndex(item => item.id === idValue);
      if (index < 0) throw new CollaborationNotFound('Unknown competition');
      if (!matchesScope(state.competitions[index]!, scope)) throw new CollaborationNotFound('Unknown competition');
      const next = competitionRecordSchema.parse(change(structuredClone(state.competitions[index]!)));
      if (!matchesScope(next, scope)) throw new CollaborationNotFound('Unknown competition');
      state.competitions[index] = next; await this.save(state); return next;
    });
  }

  createDebate(record: DebateRecord): Promise<void> {
    return this.serial(async () => {
      if (this.recordsMode) {
        if (this.summaries('debate').some(item => item.id === record.id)) throw new Error('Debate already exists');
        await this.writeRecord('debate', record); return;
      }
      const state = await this.load(); if (state.debates.some(item => item.id === record.id)) throw new Error('Debate already exists');
      state.debates.push(debateRecordSchema.parse(record)); await this.save(state);
    });
  }

  async getDebate(idValue: string, scope?: Ownership): Promise<DebateRecord> {
    if (this.recordsMode) {
      const item = await this.readRecord<DebateRecord>('debate', idValue);
      if (!matchesScope(item, scope)) throw new CollaborationNotFound('Unknown debate'); return item;
    }
    const item = (await this.load()).debates.find(debate => debate.id === idValue);
    if (!item || !matchesScope(item, scope)) throw new CollaborationNotFound('Unknown debate'); return item;
  }

  async listDebates(scope?: Ownership, limit?: number): Promise<DebateRecord[]> {
    validateCollectionLimit(limit);
    if (this.recordsMode) {
      const selected = scopedRecent(this.summaries('debate'), item => item.updatedAt, scope, limit);
      return Promise.all(selected.map(item => this.readRecord<DebateRecord>('debate', item.id)));
    }
    if (!this.state) throw new Error('Collaboration repository is not open');
    const items = this.state.debates.filter(item => matchesScope(item, scope));
    return structuredClone(limit === undefined ? items : scopedRecent(items, item => item.updatedAt, scope, limit));
  }
  async pageDebates(scope: Ownership | undefined, limit: number, cursor?: string): Promise<CollaborationPage<DebateRecord>> {
    validateCollectionLimit(limit);
    if (this.recordsMode) {
      const pageCursor = decodeCollectionCursor(cursor);
      const selected = this.summaries('debate').filter(item => matchesScope(item, scope) && afterCollectionCursor(item, item.updatedAt, pageCursor))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const page = selected.slice(0, limit + 1); const hasMore = page.length > limit; const visible = hasMore ? page.slice(0, limit) : page;
      return { items: await Promise.all(visible.map(item => this.readRecord<DebateRecord>('debate', item.id))), ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt, id: visible.at(-1)!.id }) } : {}) };
    }
    return pageRecords((await this.load()).debates, scope, limit, cursor);
  }

  mutateDebate(idValue: string, change: (record: DebateRecord) => DebateRecord, scope?: Ownership): Promise<DebateRecord> {
    return this.serial(async () => {
      if (this.recordsMode) {
        const current = await this.readRecord<DebateRecord>('debate', idValue);
        if (!matchesScope(current, scope)) throw new CollaborationNotFound('Unknown debate');
        const next = debateRecordSchema.parse(change(structuredClone(current)));
        if (!matchesScope(next, scope)) throw new CollaborationNotFound('Unknown debate');
        await this.writeRecord('debate', next); return next;
      }
      const state = await this.load(); const index = state.debates.findIndex(item => item.id === idValue);
      if (index < 0) throw new CollaborationNotFound('Unknown debate');
      if (!matchesScope(state.debates[index]!, scope)) throw new CollaborationNotFound('Unknown debate');
      const next = debateRecordSchema.parse(change(structuredClone(state.debates[index]!)));
      if (!matchesScope(next, scope)) throw new CollaborationNotFound('Unknown debate');
      state.debates[index] = next; await this.save(state); return next;
    });
  }

  async close(): Promise<void> { await this.queue; this.state = undefined; this.index = undefined; this.recordsMode = false; await unlink(this.lockPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}

/** PostgreSQL collaboration repository. Ownership is indexed in columns while
 * the validated aggregate remains the canonical JSONB state. Each lifecycle
 * mutation locks exactly one aggregate row, so concurrent workers cannot
 * overwrite attempts or debate messages. */
export class PostgresCollaborationRepository implements CollaborationRepository {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }

  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'collaboration', async client => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_competitions (id text PRIMARY KEY, owner text NOT NULL DEFAULT 'owner', tenant_id text NOT NULL DEFAULT 'local', state jsonb NOT NULL, updated_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS aeeis_debates (id text PRIMARY KEY, owner text NOT NULL DEFAULT 'owner', tenant_id text NOT NULL DEFAULT 'local', state jsonb NOT NULL, updated_at timestamptz NOT NULL);
        ALTER TABLE aeeis_competitions ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT 'owner';
        ALTER TABLE aeeis_competitions ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'local';
        ALTER TABLE aeeis_debates ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT 'owner';
        ALTER TABLE aeeis_debates ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'local';
        CREATE INDEX IF NOT EXISTS aeeis_competitions_scope_idx ON aeeis_competitions(owner, tenant_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS aeeis_debates_scope_idx ON aeeis_debates(owner, tenant_id, updated_at DESC);
      `);
      // Backfill rows written by a pre-scope build before the columns existed.
      await client.query(`UPDATE aeeis_competitions SET owner=COALESCE(NULLIF(state->>'owner',''), 'owner'), tenant_id=COALESCE(NULLIF(state->>'tenantId',''), 'local')`);
      await client.query(`UPDATE aeeis_debates SET owner=COALESCE(NULLIF(state->>'owner',''), 'owner'), tenant_id=COALESCE(NULLIF(state->>'tenantId',''), 'local')`);
    });
  }

  async createCompetition(record: CompetitionRecord): Promise<void> {
    const parsed = competitionRecordSchema.parse(record);
    await this.pool.query('INSERT INTO aeeis_competitions(id,owner,tenant_id,state,updated_at) VALUES($1,$2,$3,$4,$5)', [parsed.id, parsed.owner, parsed.tenantId, parsed, parsed.updatedAt]);
  }
  async getCompetition(idValue: string, scope?: Ownership): Promise<CompetitionRecord> {
    const row = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_competitions WHERE id=$1${scope ? ' AND owner=$2 AND tenant_id=$3' : ''}`, scope ? [idValue, scope.owner, scope.tenantId] : [idValue]);
    if (!row.rows[0]) throw new CollaborationNotFound('Unknown competition');
    return competitionRecordSchema.parse(row.rows[0].state);
  }
  async listCompetitions(scope?: Ownership, limit?: number): Promise<CompetitionRecord[]> {
    validateCollectionLimit(limit);
    const values: unknown[] = scope ? [scope.owner, scope.tenantId] : [];
    if (limit !== undefined) values.push(limit);
    const result = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_competitions${scope ? ' WHERE owner=$1 AND tenant_id=$2' : ''} ORDER BY updated_at DESC, id${limit === undefined ? '' : ` LIMIT $${values.length}`}`, values);
    return result.rows.map(row => competitionRecordSchema.parse(row.state));
  }
  async pageCompetitions(scope: Ownership | undefined, limit: number, cursor?: string): Promise<CollaborationPage<CompetitionRecord>> {
    validateCollectionLimit(limit);
    const pageCursor = decodeCollectionCursor(cursor);
    const values: unknown[] = scope ? [scope.owner, scope.tenantId] : [];
    const predicates = scope ? ['owner=$1', 'tenant_id=$2'] : [];
    if (pageCursor) { const offset = values.length + 1; values.push(pageCursor.timestamp, pageCursor.id); predicates.push(`(updated_at < $${offset}::timestamptz OR (updated_at = $${offset}::timestamptz AND id > $${offset + 1}))`); }
    values.push(limit + 1);
    const result = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_competitions${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ORDER BY updated_at DESC, id ASC LIMIT $${values.length}`, values);
    const hasMore = result.rows.length > limit; const rows = hasMore ? result.rows.slice(0, limit) : result.rows; const items = rows.map(row => competitionRecordSchema.parse(row.state));
    return { items, ...(hasMore && items.length ? { nextCursor: encodeCollectionCursor({ timestamp: items.at(-1)!.updatedAt, id: items.at(-1)!.id }) } : {}) };
  }
  async mutateCompetition(idValue: string, change: (record: CompetitionRecord) => CompetitionRecord, scope?: Ownership): Promise<CompetitionRecord> {
    return this.mutate('competition', idValue, change, state => competitionRecordSchema.parse(state), scope);
  }

  async createDebate(record: DebateRecord): Promise<void> {
    const parsed = debateRecordSchema.parse(record);
    await this.pool.query('INSERT INTO aeeis_debates(id,owner,tenant_id,state,updated_at) VALUES($1,$2,$3,$4,$5)', [parsed.id, parsed.owner, parsed.tenantId, parsed, parsed.updatedAt]);
  }
  async getDebate(idValue: string, scope?: Ownership): Promise<DebateRecord> {
    const row = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_debates WHERE id=$1${scope ? ' AND owner=$2 AND tenant_id=$3' : ''}`, scope ? [idValue, scope.owner, scope.tenantId] : [idValue]);
    if (!row.rows[0]) throw new CollaborationNotFound('Unknown debate');
    return debateRecordSchema.parse(row.rows[0].state);
  }
  async listDebates(scope?: Ownership, limit?: number): Promise<DebateRecord[]> {
    validateCollectionLimit(limit);
    const values: unknown[] = scope ? [scope.owner, scope.tenantId] : [];
    if (limit !== undefined) values.push(limit);
    const result = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_debates${scope ? ' WHERE owner=$1 AND tenant_id=$2' : ''} ORDER BY updated_at DESC, id${limit === undefined ? '' : ` LIMIT $${values.length}`}`, values);
    return result.rows.map(row => debateRecordSchema.parse(row.state));
  }
  async pageDebates(scope: Ownership | undefined, limit: number, cursor?: string): Promise<CollaborationPage<DebateRecord>> {
    validateCollectionLimit(limit);
    const pageCursor = decodeCollectionCursor(cursor);
    const values: unknown[] = scope ? [scope.owner, scope.tenantId] : [];
    const predicates = scope ? ['owner=$1', 'tenant_id=$2'] : [];
    if (pageCursor) { const offset = values.length + 1; values.push(pageCursor.timestamp, pageCursor.id); predicates.push(`(updated_at < $${offset}::timestamptz OR (updated_at = $${offset}::timestamptz AND id > $${offset + 1}))`); }
    values.push(limit + 1);
    const result = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_debates${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ORDER BY updated_at DESC, id ASC LIMIT $${values.length}`, values);
    const hasMore = result.rows.length > limit; const rows = hasMore ? result.rows.slice(0, limit) : result.rows; const items = rows.map(row => debateRecordSchema.parse(row.state));
    return { items, ...(hasMore && items.length ? { nextCursor: encodeCollectionCursor({ timestamp: items.at(-1)!.updatedAt, id: items.at(-1)!.id }) } : {}) };
  }
  async mutateDebate(idValue: string, change: (record: DebateRecord) => DebateRecord, scope?: Ownership): Promise<DebateRecord> {
    return this.mutate('debate', idValue, change, state => debateRecordSchema.parse(state), scope);
  }

  private async mutate<T extends CompetitionRecord | DebateRecord>(kind: 'competition' | 'debate', idValue: string, change: (record: T) => T, parse: (state: unknown) => T, scope?: Ownership): Promise<T> {
    const client = await this.pool.connect();
    const table = kind === 'competition' ? 'aeeis_competitions' : 'aeeis_debates';
    try {
      await client.query('BEGIN');
      const result = await client.query<{ state: unknown; owner: string; tenant_id: string }>(`SELECT state,owner,tenant_id FROM ${table} WHERE id=$1 FOR UPDATE`, [idValue]);
      const row = result.rows[0];
      if (!row || (scope && (row.owner !== scope.owner || row.tenant_id !== scope.tenantId))) throw new CollaborationNotFound(kind === 'competition' ? 'Unknown competition' : 'Unknown debate');
      const current = parse(row.state);
      const next = parse(change(structuredClone(current)));
      if (next.owner !== row.owner || next.tenantId !== row.tenant_id) throw new CollaborationNotFound(kind === 'competition' ? 'Unknown competition' : 'Unknown debate');
      await client.query(`UPDATE ${table} SET state=$2, owner=$3, tenant_id=$4, updated_at=$5 WHERE id=$1`, [idValue, next, next.owner, next.tenantId, next.updatedAt]);
      await client.query('COMMIT'); return next;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

export class CollaborationService {
  constructor(private readonly repository: CollaborationRepository, private readonly globalBudget?: { ledger: GlobalBudgetLedger; select: GlobalBudgetSelector }) {}

  private globalKey(kind: 'competition' | 'debate', aggregateId: string, slot: string): string {
    return `aeeis:${kind}:${aggregateId}:${slot}`;
  }

  private async reserveGlobal(kind: 'competition' | 'debate', aggregateId: string, slot: string, scope: Ownership | undefined, startedAt: string): Promise<{ selection: GlobalBudgetSelection; key: string; reserved: boolean; state: 'reserved' | 'unknown' | 'settled' | 'rejected' } | undefined> {
    if (!this.globalBudget) return undefined;
    const selection = this.globalBudget.select(scope, startedAt);
    if (!selection) return undefined;
    const key = this.globalKey(kind, aggregateId, slot);
    const result = await this.globalBudget.ledger.reserve(selection, key);
    return { selection, key, ...result };
  }

  private async globalAccountFor(scope: Ownership | undefined, startedAt: string, accountKey?: string): Promise<GlobalBudgetSelection | undefined> {
    if (!this.globalBudget) return undefined;
    if (accountKey) {
      const current = await this.globalBudget.ledger.get(accountKey);
      if (current) return current;
    }
    return this.globalBudget.select(scope, startedAt);
  }

  private async settleGlobal(kind: 'competition' | 'debate', aggregateId: string, slot: string, scope: Ownership | undefined, startedAt: string, accountKey: string | undefined, usage: CollaborationCallUsage): Promise<void> {
    const selection = await this.globalAccountFor(scope, startedAt, accountKey);
    if (!selection || !this.globalBudget) return;
    await this.globalBudget.ledger.settle(selection.accountKey, this.globalKey(kind, aggregateId, slot), { ...(usage.tokens === undefined ? {} : { tokens: usage.tokens }), ...(usage.moneyUsd === undefined ? {} : { moneyUsd: usage.moneyUsd }) });
  }

  private async markGlobalUnknown(kind: 'competition' | 'debate', aggregateId: string, slot: string, scope: Ownership | undefined, startedAt: string, accountKey?: string): Promise<void> {
    const selection = await this.globalAccountFor(scope, startedAt, accountKey);
    if (!selection || !this.globalBudget) return;
    await this.globalBudget.ledger.markUnknown(selection.accountKey, this.globalKey(kind, aggregateId, slot));
  }

  async createCompetition(input: unknown, scope?: Ownership): Promise<CompetitionRecord> {
    const brief = competitionBriefSchema.parse(input);
    const now = new Date().toISOString();
    const record: CompetitionRecord = { schemaVersion: 1, id: `competition_${randomUUID()}`, owner: scope?.owner ?? 'owner', tenantId: scope?.tenantId ?? 'local', brief, status: 'collecting', candidates: [], scores: [], attempts: [], totalCost: 0, createdAt: now, updatedAt: now };
    await this.repository.createCompetition(record); return record;
  }

  listCompetitions(scope?: Ownership, limit?: number): Promise<CompetitionRecord[]> { return this.repository.listCompetitions(scope, limit); }
  pageCompetitions(scope: Ownership | undefined, limit: number, cursor?: string): Promise<CollaborationPage<CompetitionRecord>> {
    if (this.repository.pageCompetitions) return this.repository.pageCompetitions(scope, limit, cursor);
    return this.repository.listCompetitions(scope).then(items => pageRecords(items, scope, limit, cursor));
  }
  getCompetition(idValue: string, scope?: Ownership): Promise<CompetitionRecord> { return this.repository.getCompetition(idValue, scope); }

  /** Returns the evaluator-facing view. Blind competitions never expose participant IDs here. */
  async getEvaluationView(idValue: string, scope?: Ownership): Promise<CompetitionRecord> {
    const current = await this.repository.getCompetition(idValue, scope);
    if (!current.brief.blindEvaluation) return current;
    const aliases = new Map(current.candidates.map((candidate, index) => [candidate.agentId, `candidate_${index + 1}`]));
    return {
      ...current,
      brief: { ...current.brief, participantAgentIds: current.brief.participantAgentIds.map((_agent, index) => `candidate_${index + 1}`) },
      candidates: current.candidates.map(candidate => ({ ...candidate, agentId: aliases.get(candidate.agentId)! })),
      scores: current.scores.map(score => ({ ...score, agentId: aliases.get(score.agentId) ?? score.agentId })),
      ...(current.selectedAgentId ? { selectedAgentId: aliases.get(current.selectedAgentId) ?? current.selectedAgentId } : {}),
    };
  }

  submitCandidate(idValue: string, input: unknown, scope?: Ownership): Promise<CompetitionRecord> {
    return this.repository.mutateCompetition(idValue, current => {
      if (current.status !== 'collecting') throw new Error('Competition is no longer collecting candidates');
      if (current.brief.modelBudget) throw new Error('Budgeted candidates must come from a durable model attempt');
      const candidate = candidateInputSchema.parse(input);
      if (!current.brief.participantAgentIds.includes(candidate.agentId)) throw new Error('Candidate agent is not a participant');
      if (candidate.taskId !== current.brief.taskId || candidate.contextVersion !== current.brief.contextVersion || candidate.resultType !== current.brief.expectedResultType) throw new Error('Candidate is not bound to the competition brief');
      if (current.candidates.some(item => item.agentId === candidate.agentId)) throw new Error('Candidate already submitted');
      const now = new Date().toISOString(); const candidates = [...current.candidates, candidate];
      return { ...current, candidates, totalCost: candidates.reduce((sum, item) => sum + (item.cost.money ?? 0), 0), updatedAt: now };
    }, scope);
  }

  beginEvaluation(idValue: string, evaluatorAgentId: string, scope?: Ownership): Promise<CompetitionRecord> {
    return this.repository.mutateCompetition(idValue, current => {
      if (current.status !== 'collecting') throw new Error('Competition is not collecting candidates');
      if (current.candidates.length === 0) throw new Error('Competition has no candidates');
      if (current.brief.participantAgentIds.includes(evaluatorAgentId)) throw new Error('Evaluator must be independent from participants');
      return { ...current, status: 'evaluating', evaluatorAgentId, updatedAt: new Date().toISOString() };
    }, scope);
  }

  submitScore(idValue: string, evaluatorAgentId: string, input: unknown, scope?: Ownership): Promise<CompetitionRecord> {
    return this.repository.mutateCompetition(idValue, current => {
      if (current.status !== 'evaluating' || current.evaluatorAgentId !== evaluatorAgentId) throw new Error('Competition is not awaiting this evaluator');
      assertCollaborationBudget(current.brief.modelBudget, competitionCalls(current));
      if (current.brief.modelBudget && current.evaluatorAttempt?.state !== 'completed') throw new Error('Budgeted scoring requires a settled evaluator attempt');
      const score = candidateScoreSchema.parse(input);
      const aliases = new Map(current.candidates.map((candidate, index) => [`candidate_${index + 1}`, candidate.agentId]));
      const actualAgentId = current.brief.blindEvaluation ? aliases.get(score.agentId) : score.agentId;
      if (!actualAgentId) throw new Error('Score refers to an unknown candidate');
      if (!current.candidates.some(candidate => candidate.agentId === actualAgentId)) throw new Error('Score refers to an unknown candidate');
      if (current.scores.some(existing => existing.agentId === actualAgentId)) throw new Error('Candidate has already been scored');
      const scores = [...current.scores, { ...score, agentId: actualAgentId }];
      if (scores.length < current.candidates.length) return { ...current, scores, updatedAt: new Date().toISOString() };
      const overBudget = current.brief.maxCost !== undefined && current.totalCost > current.brief.maxCost;
      const selected = !overBudget ? scores.filter(item => item.accepted).sort((a, b) => b.score - a.score)[0] : undefined;
      const complete = current.candidates.length === current.brief.participantAgentIds.length && !overBudget;
      return { ...current, scores, status: complete ? 'completed' : 'partial', ...(selected ? { selectedAgentId: selected.agentId } : {}), completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    }, scope);
  }

  /**
   * Run an entire competition through isolated candidate runners and an
   * independent evaluator, while persisting every accepted candidate and
   * score. Candidate admission is serialized under the budget lock; the evaluator only
   * receives the bounded, blind view produced by the domain workflow.
   */
  async runCompetition(idValue: string, evaluatorAgentId: string, runner: CandidateRunner, evaluator: IndependentEvaluator, scope?: Ownership): Promise<CompetitionRecord> {
    const current = await this.repository.getCompetition(idValue, scope);
    if (current.status === 'evaluating' && current.evaluatorAttempt && ['started', 'unknown'].includes(current.evaluatorAttempt.state)) return current;
    if (current.status === 'evaluating' && current.evaluatorAttempt?.state === 'completed') return this.finishCompetitionEvaluation(idValue, scope);
    if (!['collecting', 'running'].includes(current.status)) throw new Error('Competition is no longer collecting candidates');
    if (current.brief.participantAgentIds.includes(evaluatorAgentId)) throw new Error('Evaluator must be independent from participants');
    try {
      await this.repository.mutateCompetition(idValue, record => {
        if (!['collecting', 'running'].includes(record.status)) return record;
        return { ...record, status: 'running', updatedAt: new Date().toISOString() };
      }, scope);
      for (const participantAgentId of current.brief.participantAgentIds) {
        const before = await this.repository.getCompetition(idValue, scope);
        if (before.candidates.some(candidate => candidate.agentId === participantAgentId)) continue;
        const existing = before.attempts.find(attempt => attempt.participantAgentId === participantAgentId);
        if (!['collecting', 'running'].includes(before.status)) return before;
        if (before.attempts.some(item => ['started', 'unknown'].includes(item.state))) return before;
        if (existing?.state === 'failed' || existing?.state === 'reconciled') continue;
        const attemptId = `attempt_${randomUUID()}`;
        const inputHash = createHash('sha256').update(JSON.stringify({ brief: before.brief, participantAgentId })).digest('hex');
        const startedAt = new Date().toISOString();
        assertCollaborationBudget(before.brief.modelBudget, competitionCalls(before), true);
        const global = await this.reserveGlobal('competition', idValue, `participant:${participantAgentId}`, scope, startedAt);
        if (global && !global.reserved) {
          if (global.state === 'rejected') return this.failCompetition(idValue, 'Global budget reservation was already rejected', scope);
          const recovered = await this.repository.mutateCompetition(idValue, record => {
            if (record.attempts.some(item => item.participantAgentId === participantAgentId)) return record;
            const attempt = competitionAttemptSchema.parse({ id: attemptId, participantAgentId, inputHash, globalBudgetAccountKey: global.selection.accountKey, state: 'unknown', startedAt, endedAt: startedAt, error: 'Global budget reservation exists; provider outcome requires reconciliation' });
            return { ...record, attempts: [...record.attempts, attempt], usage: collaborationUsage([...record.attempts, attempt]), updatedAt: startedAt };
          }, scope);
          return recovered;
        }
        let reserved = false;
        await this.repository.mutateCompetition(idValue, record => {
          if (!['collecting', 'running'].includes(record.status) || record.attempts.some(attempt => ['started', 'unknown'].includes(attempt.state) || attempt.participantAgentId === participantAgentId)) return record;
          assertCollaborationBudget(record.brief.modelBudget, competitionCalls(record), true);
          record.attempts.push({ id: attemptId, participantAgentId, inputHash, ...(global ? { globalBudgetAccountKey: global.selection.accountKey } : {}), state: 'started', startedAt });
          reserved = true; record.usage = collaborationUsage(competitionCalls(record));
          return { ...record, status: 'running', updatedAt: new Date().toISOString() };
        }, scope);
        if (!reserved) return this.repository.getCompetition(idValue, scope);
        try {
          const candidate = resultEnvelopeSchema.parse(await runner.run(before.brief, { candidateId: participantAgentId, cannotSeeCandidateIds: before.brief.participantAgentIds.filter(id => id !== participantAgentId) }, { idempotencyKey: `competition:${idValue}:${attemptId}`, recordUsage: usage => this.recordCompetitionUsage(idValue, attemptId, usage, scope), recordModel: model => this.recordCompetitionModel(idValue, attemptId, model, scope) }));
          if (candidate.agentId !== participantAgentId || candidate.taskId !== before.brief.taskId || candidate.contextVersion !== before.brief.contextVersion || candidate.resultType !== before.brief.expectedResultType) throw new Error('Candidate result is not bound to the competition brief');
          await this.repository.mutateCompetition(idValue, record => {
            const attempt = record.attempts.find(item => item.id === attemptId);
            if (!attempt || attempt.state !== 'started') return record;
            attempt.state = 'completed'; attempt.endedAt = new Date().toISOString(); attempt.result = candidate;
            try { assertCollaborationBudget(record.brief.modelBudget, competitionCalls(record)); }
            catch (error) { return { ...record, status: 'failed', failureReason: (error as Error).message, updatedAt: new Date().toISOString() }; }
            if (!record.candidates.some(item => item.agentId === candidate.agentId)) {
              record.candidates.push(candidate); record.totalCost = record.candidates.reduce((sum, item) => sum + (item.cost.money ?? 0), 0);
            }
            return { ...record, updatedAt: new Date().toISOString() };
          }, scope);
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Candidate runner failed';
          await this.repository.mutateCompetition(idValue, record => {
            const attempt = record.attempts.find(item => item.id === attemptId);
            if (attempt?.state === 'started') { attempt.state = error instanceof ModelOutcomeUnknown ? 'unknown' : 'failed'; attempt.endedAt = new Date().toISOString(); attempt.error = reason; }
            return { ...record, updatedAt: new Date().toISOString() };
          }, scope);
          if (error instanceof ModelOutcomeUnknown) {
            const latest = await this.repository.getCompetition(idValue, scope);
            const attempt = latest.attempts.find(item => item.id === attemptId);
            if (attempt) await this.markGlobalUnknown('competition', idValue, `participant:${participantAgentId}`, scope, attempt.startedAt, attempt.globalBudgetAccountKey);
          }
        }
      }
      const afterCandidates = await this.repository.getCompetition(idValue, scope);
      if (afterCandidates.status !== 'running') return afterCandidates;
      if (afterCandidates.attempts.some(item => ['started', 'unknown'].includes(item.state))) return afterCandidates;
      if (afterCandidates.candidates.length === 0) return this.failCompetition(idValue, afterCandidates.attempts.map(attempt => attempt.error).filter(Boolean).slice(0, 3).join('; ') || 'No valid candidate completed the isolated run', scope);
      const resultCandidates = afterCandidates.candidates;

      const aliases = new Map(resultCandidates.map((candidate, index) => [candidate.agentId, `candidate_${index + 1}`]));
      const evaluationBrief = afterCandidates.brief.blindEvaluation ? { ...afterCandidates.brief, participantAgentIds: [...aliases.values()] } : afterCandidates.brief;
      const evaluationCandidates = afterCandidates.brief.blindEvaluation ? resultCandidates.map((candidate, index) => ({ ...candidate, agentId: `candidate_${index + 1}` })) : resultCandidates;
      const evaluatorAttemptId = `attempt_${randomUUID()}`;
      const evaluatorInputHash = createHash('sha256').update(JSON.stringify({ brief: evaluationBrief, candidates: evaluationCandidates })).digest('hex');
      const evaluatorStartedAt = new Date().toISOString();
      assertCollaborationBudget(afterCandidates.brief.modelBudget, competitionCalls(afterCandidates), true);
      const evaluatorGlobal = await this.reserveGlobal('competition', idValue, 'evaluator', scope, evaluatorStartedAt);
      if (evaluatorGlobal && !evaluatorGlobal.reserved) {
        if (evaluatorGlobal.state === 'rejected') return this.failCompetition(idValue, 'Global budget reservation was already rejected', scope);
        const recovered = await this.repository.mutateCompetition(idValue, record => {
          if (record.evaluatorAttempt) return record;
          return { ...record, status: 'evaluating', evaluatorAgentId, evaluatorAttempt: { id: evaluatorAttemptId, inputHash: evaluatorInputHash, globalBudgetAccountKey: evaluatorGlobal.selection.accountKey, state: 'unknown' as const, startedAt: evaluatorStartedAt, endedAt: evaluatorStartedAt, error: 'Global budget reservation exists; provider outcome requires reconciliation' }, usage: collaborationUsage(competitionCalls(record)), updatedAt: evaluatorStartedAt };
        }, scope);
        return recovered;
      }
      let evaluatorReserved = false;
      await this.repository.mutateCompetition(idValue, record => {
        if (record.status !== 'running' || record.evaluatorAttempt || record.attempts.some(item => ['started', 'unknown'].includes(item.state))) return record;
        assertCollaborationBudget(record.brief.modelBudget, competitionCalls(record), true);
        record.evaluatorAttempt = { id: evaluatorAttemptId, inputHash: evaluatorInputHash, ...(evaluatorGlobal ? { globalBudgetAccountKey: evaluatorGlobal.selection.accountKey } : {}), state: 'started', startedAt: evaluatorStartedAt };
        evaluatorReserved = true;
        return { ...record, status: 'evaluating', evaluatorAgentId, usage: collaborationUsage(competitionCalls(record)), updatedAt: new Date().toISOString() };
      }, scope);
      if (!evaluatorReserved) return this.repository.getCompetition(idValue, scope);
      let rawScores: CandidateScore[];
      try {
        rawScores = await evaluator.evaluate(evaluationBrief, evaluationCandidates, { idempotencyKey: `competition:${idValue}:${evaluatorAttemptId}`, recordUsage: usage => this.recordCompetitionUsage(idValue, evaluatorAttemptId, usage, scope), recordModel: model => this.recordCompetitionModel(idValue, evaluatorAttemptId, model, scope) });
        await this.repository.mutateCompetition(idValue, record => {
          if (record.evaluatorAttempt?.id !== evaluatorAttemptId || record.evaluatorAttempt.state !== 'started') return record;
          return { ...record, evaluatorAttempt: { ...record.evaluatorAttempt, state: 'completed', endedAt: new Date().toISOString(), scores: rawScores }, updatedAt: new Date().toISOString() };
        }, scope);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Evaluator failed';
        const failed = await this.repository.mutateCompetition(idValue, record => {
          if (record.evaluatorAttempt?.id !== evaluatorAttemptId || record.evaluatorAttempt.state !== 'started') return record;
          const unknown = error instanceof ModelOutcomeUnknown;
          return { ...record, evaluatorAttempt: { ...record.evaluatorAttempt, state: unknown ? 'unknown' : 'failed', endedAt: new Date().toISOString(), error: reason },
            ...(unknown ? {} : { status: 'failed' as const, failureReason: `Competition evaluator failed: ${reason}`, completedAt: new Date().toISOString() }), updatedAt: new Date().toISOString() };
        }, scope);
        if (error instanceof ModelOutcomeUnknown) {
          const attempt = failed.evaluatorAttempt;
          if (attempt) await this.markGlobalUnknown('competition', idValue, 'evaluator', scope, attempt.startedAt, attempt.globalBudgetAccountKey);
        }
        return failed;
      }
      return this.finishCompetitionEvaluation(idValue, scope);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Competition runner or evaluator failed';
      return this.failCompetition(idValue, `Competition execution failed: ${reason}`, scope);
    }
  }

  private async recordCompetitionUsage(idValue: string, attemptId: string, usage: CollaborationCallUsage, scope?: Ownership): Promise<void> {
    const parsed = collaborationCallUsageSchema.parse(usage);
    const updated = await this.repository.mutateCompetition(idValue, current => {
      const attempt = current.attempts.find(item => item.id === attemptId) ?? (current.evaluatorAttempt?.id === attemptId ? current.evaluatorAttempt : undefined);
      if (!attempt || attempt.state !== 'started' || attempt.usage !== undefined) return current;
      attempt.usage = parsed;
      return { ...current, usage: collaborationUsage(competitionCalls(current)), updatedAt: new Date().toISOString() };
    }, scope);
    const attempt = updated.attempts.find(item => item.id === attemptId) ?? (updated.evaluatorAttempt?.id === attemptId ? updated.evaluatorAttempt : undefined);
    if (attempt) {
      if (updated.evaluatorAttempt?.id === attemptId) await this.settleGlobal('competition', idValue, 'evaluator', scope, attempt.startedAt, attempt.globalBudgetAccountKey, parsed);
      else {
        const participant = updated.attempts.find(item => item.id === attemptId);
        if (participant) await this.settleGlobal('competition', idValue, `participant:${participant.participantAgentId}`, scope, participant.startedAt, participant.globalBudgetAccountKey, parsed);
      }
    }
  }

  private async recordCompetitionModel(idValue: string, attemptId: string, model: CollaborationModelPin, scope?: Ownership): Promise<void> {
    const parsed = collaborationModelPinSchema.parse(model);
    await this.repository.mutateCompetition(idValue, current => {
      const attempt = current.attempts.find(item => item.id === attemptId) ?? (current.evaluatorAttempt?.id === attemptId ? current.evaluatorAttempt : undefined);
      if (!attempt || attempt.state !== 'started' || attempt.model !== undefined) return current;
      attempt.model = parsed;
      return { ...current, updatedAt: new Date().toISOString() };
    }, scope);
  }

  /** Resolve a participant attempt after a worker restart without calling the runner again. */
  async reconcileCompetitionAttempt(idValue: string, input: unknown, scope?: Ownership): Promise<CompetitionRecord> {
    const body = z.object({ attemptId: id, outcome: z.enum(['completed', 'failed']), usage: collaborationCallUsageSchema.optional(), result: resultEnvelopeSchema.optional(), reason: z.string().trim().min(1).max(4000) }).strict().parse(input);
    const before = await this.repository.getCompetition(idValue, scope);
    const beforeAttempt = before.attempts.find(item => item.id === body.attemptId);
    if (!beforeAttempt) throw new Error('Unknown competition attempt');
    await this.settleGlobal('competition', idValue, `participant:${beforeAttempt.participantAgentId}`, scope, beforeAttempt.startedAt, beforeAttempt.globalBudgetAccountKey, body.usage ?? {});
    return this.repository.mutateCompetition(idValue, current => {
      const attempt = current.attempts.find(item => item.id === body.attemptId);
      if (!attempt) throw new Error('Unknown competition attempt');
      if (!['started', 'unknown'].includes(attempt.state)) throw new Error(`Competition attempt is already ${attempt.state}`);
      attempt.reconciliationReason = body.reason;
      attempt.endedAt = new Date().toISOString();
      if (body.usage) attempt.usage = body.usage;
      if (body.outcome === 'completed') {
        if (!body.result || body.result.agentId !== attempt.participantAgentId || body.result.taskId !== current.brief.taskId || body.result.contextVersion !== current.brief.contextVersion || body.result.resultType !== current.brief.expectedResultType) throw new Error('Reconciled candidate result is not bound to the competition brief');
        attempt.result = body.result; attempt.state = 'reconciled';
        try { assertCollaborationBudget(current.brief.modelBudget, competitionCalls(current)); }
        catch (error) { return { ...current, usage: collaborationUsage(competitionCalls(current)), status: 'failed', failureReason: (error as Error).message, updatedAt: new Date().toISOString() }; }
        if (!current.candidates.some(candidate => candidate.agentId === body.result!.agentId)) { current.candidates.push(body.result); current.totalCost = current.candidates.reduce((sum, item) => sum + (item.cost.money ?? 0), 0); }
      } else { attempt.state = 'failed'; attempt.error = body.reason; }
      attempt.endedAt = new Date().toISOString();
      const stillStarted = current.attempts.some(item => ['started', 'unknown'].includes(item.state));
      return { ...current, status: stillStarted ? 'running' : 'collecting', usage: collaborationUsage(competitionCalls(current)), updatedAt: new Date().toISOString() };
    }, scope);
  }

  /** Resolve an evaluator call after a worker restart without invoking the evaluator again. */
  async reconcileCompetitionEvaluator(idValue: string, input: unknown, scope?: Ownership): Promise<CompetitionRecord> {
    const body = z.object({ attemptId: id, outcome: z.enum(['completed', 'failed']), usage: collaborationCallUsageSchema.optional(), scores: z.array(candidateScoreSchema).max(12).optional(), reason: z.string().trim().min(1).max(4000) }).strict().parse(input);
    if (body.outcome === 'completed' && !body.scores?.length) throw new Error('Completed evaluator reconciliation requires scores');
    const before = await this.repository.getCompetition(idValue, scope);
    const beforeAttempt = before.evaluatorAttempt;
    if (!beforeAttempt || beforeAttempt.id !== body.attemptId) throw new Error('Unknown competition evaluator attempt');
    await this.settleGlobal('competition', idValue, 'evaluator', scope, beforeAttempt.startedAt, beforeAttempt.globalBudgetAccountKey, body.usage ?? {});
    const settled = await this.repository.mutateCompetition(idValue, record => {
      const attempt = record.evaluatorAttempt;
      if (record.status !== 'evaluating' || !attempt || attempt.id !== body.attemptId || !['started', 'unknown'].includes(attempt.state)) throw new Error('Competition is not waiting for this evaluator reconciliation');
      if (body.usage) attempt.usage = body.usage;
      attempt.state = body.outcome; attempt.endedAt = new Date().toISOString();
      attempt.reconciliationReason = body.reason;
      if (body.outcome === 'completed') attempt.scores = body.scores!;
      else attempt.error = body.reason;
      return { ...record, usage: collaborationUsage(competitionCalls(record)), ...(body.outcome === 'failed' ? { status: 'failed' as const, failureReason: body.reason, completedAt: attempt.endedAt } : {}), updatedAt: attempt.endedAt };
    }, scope);
    return settled.status === 'evaluating' ? this.finishCompetitionEvaluation(idValue, scope) : settled;
  }

  /** Apply stored evaluator output atomically. A crash after settlement or a
   * concurrent /run cannot invoke the evaluator or apply its scores twice. */
  private finishCompetitionEvaluation(idValue: string, scope?: Ownership): Promise<CompetitionRecord> {
    return this.repository.mutateCompetition(idValue, current => {
      if (current.status !== 'evaluating' || current.evaluatorAttempt?.state !== 'completed') return current;
      current.usage = collaborationUsage(competitionCalls(current));
      const now = new Date().toISOString();
      try {
        assertCollaborationBudget(current.brief.modelBudget, competitionCalls(current));
        const aliases = new Map(current.candidates.map((candidate, index) => [`candidate_${index + 1}`, candidate.agentId]));
        const scores: CandidateScore[] = [];
        for (const raw of current.evaluatorAttempt.scores ?? []) {
          const score = candidateScoreSchema.parse(raw);
          // Custom evaluators historically returned either blind aliases or
          // actual IDs. The model adapter only receives anonymous candidates.
          const agentId = current.brief.blindEvaluation ? aliases.get(score.agentId) ?? score.agentId : score.agentId;
          if (!current.candidates.some(candidate => candidate.agentId === agentId) || scores.some(item => item.agentId === agentId)) throw new Error('Evaluator returned an unknown or duplicate candidate');
          scores.push({ ...score, agentId });
        }
        const overBudget = current.brief.maxCost !== undefined && current.totalCost > current.brief.maxCost;
        const selected = !overBudget ? scores.filter(score => score.accepted).sort((a, b) => b.score - a.score)[0] : undefined;
        const complete = !overBudget && current.candidates.length === current.brief.participantAgentIds.length && scores.length === current.candidates.length;
        return { ...current, scores, status: complete ? 'completed' : 'partial', ...(selected ? { selectedAgentId: selected.agentId } : {}), completedAt: now, updatedAt: now };
      } catch (error) {
        delete current.selectedAgentId;
        return { ...current, status: 'failed', failureReason: (error as Error).message, completedAt: now, updatedAt: now };
      }
    }, scope);
  }

  failCompetition(idValue: string, reason: string, scope?: Ownership): Promise<CompetitionRecord> {
    const clean = z.string().trim().min(1).max(4000).parse(reason);
    return this.repository.mutateCompetition(idValue, current => ({ ...current, status: 'failed', failureReason: clean, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), scope);
  }

  finalizePartialCompetition(idValue: string, reason: string, scope?: Ownership): Promise<CompetitionRecord> {
    const clean = z.string().trim().min(1).max(4000).parse(reason);
    return this.repository.mutateCompetition(idValue, current => ({ ...current, status: 'partial', failureReason: clean, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), scope);
  }

  async createDebate(input: unknown, scope?: Ownership): Promise<DebateRecord> {
    const parsed = debateInputSchema.parse(input); const now = new Date().toISOString(); const idValue = `debate_${randomUUID()}`;
    const roomBase = { debateId: idValue, taskId: parsed.taskId, contextVersion: parsed.contextVersion, ...(parsed.goal === undefined ? {} : { goal: parsed.goal }), ...(parsed.context === undefined ? {} : { context: parsed.context }), participantAgentIds: parsed.participantAgentIds, maxRounds: parsed.maxRounds, maxMessagesPerAgent: parsed.maxMessagesPerAgent, messages: [] };
    const room: DebateRoom = parsed.maxTotalMessages === undefined
      ? debateRoomSchema.parse(roomBase)
      : debateRoomSchema.parse({ ...roomBase, maxTotalMessages: parsed.maxTotalMessages });
    const record: DebateRecord = { schemaVersion: 1, id: idValue, owner: scope?.owner ?? 'owner', tenantId: scope?.tenantId ?? 'local', room, status: 'active', attempts: [], ...(parsed.modelBudget ? { modelBudget: parsed.modelBudget } : {}), createdAt: now, updatedAt: now };
    await this.repository.createDebate(record); return record;
  }

  listDebates(scope?: Ownership, limit?: number): Promise<DebateRecord[]> { return this.repository.listDebates(scope, limit); }
  pageDebates(scope: Ownership | undefined, limit: number, cursor?: string): Promise<CollaborationPage<DebateRecord>> {
    if (this.repository.pageDebates) return this.repository.pageDebates(scope, limit, cursor);
    return this.repository.listDebates(scope).then(items => pageRecords(items, scope, limit, cursor));
  }
  getDebate(idValue: string, scope?: Ownership): Promise<DebateRecord> { return this.repository.getDebate(idValue, scope); }

  appendMessage(idValue: string, input: unknown, scope?: Ownership, attemptId?: string): Promise<DebateRecord> {
    return this.repository.mutateDebate(idValue, current => {
      if (current.status !== 'active') throw new Error('Debate is closed');
      assertCollaborationBudget(current.modelBudget, current.attempts);
      const parsed = debateMessageSchema.parse(input);
      // External deliveries use a deterministic message ID. Treat a repeated
      // Feishu delivery as a successful no-op after the canonical event is
      // present; ordinary API messages retain duplicate rejection semantics.
      if ((parsed.origin?.channel === 'feishu' || parsed.origin?.channel === 'hermes') && current.room.messages.some(item => item.messageId === parsed.messageId)) return current;
      if ((current.roles || current.modelBudget) && !attemptId) throw new Error('Managed Debate messages must come from a reserved participant attempt');
      if (attemptId) {
        const attempt = current.attempts.find(item => item.id === attemptId);
        if (!attempt || attempt.state !== 'completed' || !attempt.slot.startsWith('participant:')) throw new Error('Debate participant attempt is not completed');
        const message = parsed;
        if (message.speakerAgentId !== attempt.agentId || message.messageId !== `message_${attemptId.slice('attempt_'.length)}`) throw new Error('Message does not match the participant attempt');
      }
      const room = appendDebateMessage(current.room, parsed);
      return { ...current, room, updatedAt: new Date().toISOString() };
    }, scope);
  }

  async bindDebateRoles(idValue: string, input: unknown, scope?: Ownership): Promise<DebateRecord> {
    const roles = debateRolesSchema.parse(input);
    return this.repository.mutateDebate(idValue, current => {
      const ids = [roles.moderatorAgentId, roles.adjudicatorAgentId].filter((item): item is string => Boolean(item));
      if (new Set(ids).size !== ids.length || ids.some(agentId => current.room.participantAgentIds.includes(agentId))) throw new Error('Debate reviewer roles must be independent from participants and each other');
      if (current.roles && (current.roles.moderatorAgentId !== roles.moderatorAgentId || current.roles.adjudicatorAgentId !== roles.adjudicatorAgentId)) throw new Error('Restore the pinned Debate role configuration');
      return { ...current, roles, updatedAt: new Date().toISOString() };
    }, scope);
  }

  async reserveDebateAttempt(idValue: string, slot: string, agentId: string, inputHash: string, scope?: Ownership): Promise<{ attempt?: DebateAttempt; reserved: boolean }> {
    let reserved = false;
    let attempt: DebateAttempt | undefined;
    const startedAt = new Date().toISOString();
    const current = await this.repository.getDebate(idValue, scope);
    const existing = current.attempts.find(item => item.slot === slot);
    if (existing) return { attempt: existing, reserved: false };
    if (current.status !== 'active' || current.attempts.some(item => ['started', 'unknown'].includes(item.state))) return { reserved: false };
    if (!current.attempts.some(item => item.slot === slot)) assertCollaborationBudget(current.modelBudget, current.attempts, true);
    const global = await this.reserveGlobal('debate', idValue, slot, scope, startedAt);
    if (global && !global.reserved) {
      await this.repository.mutateDebate(idValue, current => {
        const existing = current.attempts.find(item => item.slot === slot);
        if (existing) { attempt = existing; return current; }
        const recovered = debateAttemptSchema.parse({ id: `attempt_${randomUUID()}`, slot, agentId, inputHash, globalBudgetAccountKey: global.selection.accountKey, state: 'unknown', startedAt, endedAt: startedAt, error: global.state === 'rejected' ? 'Global budget reservation was rejected' : 'Global budget reservation exists; provider outcome requires reconciliation' });
        attempt = recovered;
        return { ...current, attempts: [...current.attempts, recovered], usage: collaborationUsage([...current.attempts, recovered]), updatedAt: startedAt };
      }, scope);
      return { ...(attempt ? { attempt } : {}), reserved: false };
    }
    await this.repository.mutateDebate(idValue, current => {
      attempt = current.attempts.find(item => item.slot === slot);
      if (attempt) {
        if (attempt.agentId !== agentId) throw new Error('Debate attempt belongs to a different Agent');
        return current;
      }
      if (current.status !== 'active' || current.attempts.some(item => ['started', 'unknown'].includes(item.state))) return current;
      assertCollaborationBudget(current.modelBudget, current.attempts, true);
      attempt = debateAttemptSchema.parse({ id: `attempt_${randomUUID()}`, slot, agentId, inputHash, ...(global ? { globalBudgetAccountKey: global.selection.accountKey } : {}), state: 'started', startedAt });
      reserved = true;
      return { ...current, attempts: [...current.attempts, attempt], usage: collaborationUsage([...current.attempts, attempt]), updatedAt: new Date().toISOString() };
    }, scope);
    return { ...(attempt ? { attempt } : {}), reserved };
  }

  async recordDebateUsage(idValue: string, attemptId: string, usage: CollaborationCallUsage, scope?: Ownership): Promise<void> {
    const parsed = collaborationCallUsageSchema.parse(usage);
    const updated = await this.repository.mutateDebate(idValue, current => {
      const attempt = current.attempts.find(item => item.id === attemptId);
      if (!attempt || attempt.state !== 'started' || attempt.usage !== undefined) return current;
      attempt.usage = parsed;
      return { ...current, usage: collaborationUsage(current.attempts), updatedAt: new Date().toISOString() };
    }, scope);
    const attempt = updated.attempts.find(item => item.id === attemptId);
    if (attempt) await this.settleGlobal('debate', idValue, attempt.slot, scope, attempt.startedAt, attempt.globalBudgetAccountKey, parsed);
  }

  async recordDebateModel(idValue: string, attemptId: string, model: CollaborationModelPin, scope?: Ownership): Promise<void> {
    const parsed = collaborationModelPinSchema.parse(model);
    await this.repository.mutateDebate(idValue, current => {
      const attempt = current.attempts.find(item => item.id === attemptId);
      if (!attempt || attempt.state !== 'started' || attempt.model !== undefined) return current;
      attempt.model = parsed;
      return { ...current, updatedAt: new Date().toISOString() };
    }, scope);
  }

  async settleDebateAttempt(idValue: string, attemptId: string, result: { output: unknown } | { error: string; unknown: boolean }, scope?: Ownership): Promise<DebateRecord> {
    const updated = await this.repository.mutateDebate(idValue, current => {
      const attempt = current.attempts.find(item => item.id === attemptId);
      // Reconciliation wins over a late model response, including late failures.
      if (!attempt || attempt.state !== 'started') return current;
      if ('output' in result) { attempt.output = result.output; attempt.state = 'completed'; }
      else { attempt.error = result.error.slice(0, 4000); attempt.state = result.unknown ? 'unknown' : 'failed'; }
      attempt.endedAt = new Date().toISOString();
      return { ...current, usage: collaborationUsage(current.attempts), updatedAt: attempt.endedAt };
    }, scope);
    const attempt = updated.attempts.find(item => item.id === attemptId);
    if (attempt && 'error' in result && result.unknown) await this.markGlobalUnknown('debate', idValue, attempt.slot, scope, attempt.startedAt, attempt.globalBudgetAccountKey);
    return updated;
  }

  reconcileDebateAttempt(idValue: string, input: unknown, scope?: Ownership): Promise<DebateRecord> {
    const body = z.object({ attemptId: id, outcome: z.enum(['completed', 'failed']), usage: collaborationCallUsageSchema.optional(), output: z.unknown().optional(), reason: z.string().trim().min(1).max(4000) }).strict().parse(input);
    return this.reconcileDebateAttemptDurable(idValue, { attemptId: body.attemptId, outcome: body.outcome, reason: body.reason, ...(body.usage ? { usage: body.usage } : {}), ...(body.output !== undefined ? { output: body.output } : {}) }, scope);
  }

  private async reconcileDebateAttemptDurable(idValue: string, body: { attemptId: string; outcome: 'completed' | 'failed'; usage?: CollaborationCallUsage; output?: unknown; reason: string }, scope?: Ownership): Promise<DebateRecord> {
    const before = await this.repository.getDebate(idValue, scope);
    const beforeAttempt = before.attempts.find(item => item.id === body.attemptId);
    if (!beforeAttempt) throw new Error('Unknown Debate attempt');
    await this.settleGlobal('debate', idValue, beforeAttempt.slot, scope, beforeAttempt.startedAt, beforeAttempt.globalBudgetAccountKey, body.usage ?? {});
    return this.repository.mutateDebate(idValue, current => {
      if (current.status !== 'active') throw new Error('Debate is closed');
      const attempt = current.attempts.find(item => item.id === body.attemptId);
      if (!attempt || !['started', 'unknown'].includes(attempt.state)) throw new Error('Debate is not waiting for this attempt reconciliation');
      if (body.outcome === 'completed' && body.output === undefined) throw new Error('Completed reconciliation requires provider output');
      if (body.usage) attempt.usage = body.usage;
      attempt.state = body.outcome;
      if (body.outcome === 'completed') attempt.output = body.output;
      else attempt.error = body.reason;
      attempt.reconciliationReason = body.reason;
      attempt.endedAt = new Date().toISOString();
      return { ...current, usage: collaborationUsage(current.attempts), updatedAt: attempt.endedAt };
    }, scope);
  }

  recordModeratorReview(idValue: string, input: unknown, scope?: Ownership): Promise<DebateRecord> {
    const review = debateModeratorReviewSchema.parse(input);
    if (review.status === 'accepted' && (review.violations.length || review.missingClaimRefs.length)) throw new Error('Accepted Moderator review cannot contain violations');
    return this.repository.mutateDebate(idValue, current => {
      if (current.status !== 'active') throw new Error('Debate is closed');
      assertCollaborationBudget(current.modelBudget, current.attempts);
      if (current.roles?.moderatorAgentId !== review.reviewerAgentId || current.room.participantAgentIds.includes(review.reviewerAgentId)) throw new Error('Moderator must match the pinned independent role');
      if (!current.room.messages.some(message => message.messageId === review.messageId)) throw new Error('Moderator review refers to an unknown message');
      if (current.room.moderatorReviews.some(existing => existing.messageId === review.messageId && existing.reviewerAgentId === review.reviewerAgentId)) return current;
      return { ...current, room: { ...current.room, moderatorReviews: [...current.room.moderatorReviews, review] }, updatedAt: new Date().toISOString() };
    }, scope);
  }

  closeDebate(idValue: string, reason: string, scope?: Ownership, adjudication?: DebateRecord['room']['adjudication']): Promise<DebateRecord> {
    const clean = z.string().trim().min(1).max(4000).parse(reason);
    return this.repository.mutateDebate(idValue, current => {
      if (current.status !== 'active') throw new Error('Debate is already closed');
      const now = new Date().toISOString();
      const fallback = current.roles?.adjudicatorAgentId || current.attempts.some(item => item.state !== 'completed')
        ? { status: 'held' as const, decision: 'Independent adjudication has not completed.', rationale: `Independent adjudication has not completed: ${clean}`, evidenceRefs: [], decidedAt: now }
        : adjudicateDebate(current.room);
      const result = debateAdjudicationSchema.parse(adjudication ?? fallback);
      if (result.status === 'decided') {
        assertCollaborationBudget(current.modelBudget, current.attempts);
        const selected = current.room.messages.find(message => message.messageId === result.selectedMessageId);
        if (!selected || !isSupportedDebateDecision(current.room, selected) || result.evidenceRefs.length === 0 || result.evidenceRefs.some(ref => !selected.claimRefs.includes(ref))) throw new Error('Adjudication requires supported decision evidence');
        if (current.attempts.some(item => item.state !== 'completed')) throw new Error('Unsettled Debate attempts prevent adjudication');
        if (current.roles?.adjudicatorAgentId && result.adjudicatorAgentId !== current.roles.adjudicatorAgentId) throw new Error('Independent adjudicator must match the pinned role');
        if (current.roles?.moderatorAgentId && !current.room.moderatorReviews.some(review => review.messageId === selected.messageId && review.reviewerAgentId === current.roles?.moderatorAgentId && review.status === 'accepted')) throw new Error('Decision requires the configured Moderator review');
      } else if (result.selectedMessageId || result.evidenceRefs.length > 0) {
        throw new Error('Held adjudication cannot publish a selected message or evidence');
      }
      const room = { ...current.room, adjudication: result };
      return { ...current, room, status: 'closed', closedAt: now, closeReason: clean, updatedAt: now };
    }, scope);
  }
}

function competitionCalls(record: CompetitionRecord) {
  return [...record.attempts, ...(record.evaluatorAttempt ? [record.evaluatorAttempt] : [])];
}
