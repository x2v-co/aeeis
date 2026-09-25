import { HttpDependencyProbe, readableFileHealth } from './dependency-health.js';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { globalBudgetUsageSchema, type GlobalBudgetUsage } from './global-budget.js';

export const projectSourceKindSchema = z.enum(['document', 'task', 'message', 'code', 'other']);
export type ProjectSourceKind = z.infer<typeof projectSourceKindSchema>;

export const projectSourceRecordSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{1,191}$/),
  title: z.string().trim().min(1).max(500),
  // Content is hashed byte-for-byte by the connector. Do not normalize
  // whitespace here or the hash would no longer describe the source object.
  content: z.string().min(1).max(100_000),
  source: z.string().trim().min(1).max(2000),
  kind: projectSourceKindSchema,
  classification: z.enum(['public', 'internal', 'confidential', 'private']).optional(),
  tenantId: z.string().trim().min(1).max(200).optional(),
  updatedAt: z.string().datetime({ offset: true }),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ProjectSourceRecord = z.infer<typeof projectSourceRecordSchema>;

export type ProjectSourceClassification = NonNullable<ProjectSourceRecord['classification']>;
export interface ProjectSourceProviderHealth { ready: boolean; detail: string; checkedAt?: string }
export interface ProjectSourceSearchRequest { query: string; maxItems: number; tenantId: string; allowedClassifications?: ProjectSourceClassification[]; cursor?: string }
export interface ProjectSourceProvider {
  search(request: ProjectSourceSearchRequest): Promise<ProjectSourceRecord[]>;
  /** Stable installation-owned identity used to scope incremental cursors. */
  readonly checkpointIdentity?: string;
  /** Optional lightweight dependency probe. It must not fetch a project page
   * or advance a connector cursor. */
  health?(): Promise<ProjectSourceProviderHealth>;
}

/** Describes how a response changes the installed source view. A scan page
 * belongs to a refresh cycle: only its final page can remove unseen records. */
export const projectSourceUpdateSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('snapshot') }).strict(),
  z.object({ mode: z.literal('unchanged') }).strict(),
  z.object({ mode: z.literal('delta'), deletedIds: z.array(projectSourceRecordSchema.shape.id).max(1000) }).strict(),
  z.object({ mode: z.literal('scan'), start: z.boolean(), complete: z.boolean() }).strict(),
]);
export type ProjectSourceUpdate = z.infer<typeof projectSourceUpdateSchema>;

export const projectSourceSyncReceiptSchema = z.object({
  schemaVersion: z.literal('project-source-sync-receipt/1'),
  provider: z.string().trim().min(1).max(200),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/),
  previousCursor: z.string().max(1000).optional(),
  nextCursor: z.string().trim().min(1).max(1000),
  recordCount: z.number().int().min(0).max(1000),
  changed: z.boolean(),
  completedAt: z.string().datetime({ offset: true }),
  update: projectSourceUpdateSchema.optional(),
  /** At least one component is still scanning; absence is not deletion yet. */
  partial: z.boolean().optional(),
  /** Added by the runtime after a durable checkpoint commit. */
  checkpointRevision: z.number().int().positive().optional(),
  /** Optional provider-reported billable usage. Its absence means the
   * connector is not exposing a token/USD meter, not that a billable meter was
   * silently zeroed. */
  usage: globalBudgetUsageSchema.optional(),
}).strict();
export type ProjectSourceSyncReceipt = z.infer<typeof projectSourceSyncReceiptSchema>;
export interface ProjectSourceSyncRequest extends ProjectSourceSearchRequest { cursor?: string }
export interface ProjectSourceSyncResult { records: ProjectSourceRecord[]; nextCursor: string; receipt: ProjectSourceSyncReceipt }
export interface ProjectSourceSyncProvider extends ProjectSourceProvider { sync(request: ProjectSourceSyncRequest, checkpoints?: ProjectSourceCheckpointStore): Promise<ProjectSourceSyncResult> }

export interface ProjectSourceCheckpointKey {
  provider: string;
  tenantId: string;
  query: string;
  maxItems: number;
  allowedClassifications: ProjectSourceClassification[];
}
export interface ProjectSourceCheckpoint {
  schemaVersion: 'project-source-checkpoint/1';
  key: ProjectSourceCheckpointKey;
  revision: number;
  cursor: string;
  receipt: ProjectSourceSyncReceipt;
  updatedAt: string;
  /** Absent only on legacy cursor-only checkpoints; these must be resynced. */
  records?: ProjectSourceRecord[] | undefined;
  scanRecords?: ProjectSourceRecord[] | undefined;
}
export interface ProjectSourceCheckpointStore {
  init?(): Promise<void>;
  get(key: ProjectSourceCheckpointKey): Promise<ProjectSourceCheckpoint | undefined>;
  /** Compare-and-set protects a cursor from concurrent sync jobs. */
  save(key: ProjectSourceCheckpointKey, expectedRevision: number | undefined, result: ProjectSourceSyncResult): Promise<ProjectSourceCheckpoint>;
  close?(): Promise<void>;
}
export class ProjectSourceCheckpointConflict extends Error {}

const projectSourceClassificationSchema = z.enum(['public', 'internal', 'confidential', 'private']);
export const projectSourceCheckpointKeySchema = z.object({
  provider: z.string().trim().min(1).max(500),
  tenantId: z.string().trim().min(1).max(200),
  query: z.string().max(2000),
  maxItems: z.number().int().min(1).max(100),
  allowedClassifications: z.array(projectSourceClassificationSchema).min(1).max(4),
}).strict();
export const projectSourceCheckpointSchema = z.object({
  schemaVersion: z.literal('project-source-checkpoint/1'), key: projectSourceCheckpointKeySchema,
  revision: z.number().int().positive(), cursor: z.string().trim().min(1).max(1000),
  receipt: projectSourceSyncReceiptSchema, updatedAt: z.string().datetime({ offset: true }),
  records: z.array(projectSourceRecordSchema).max(1000).optional(),
  scanRecords: z.array(projectSourceRecordSchema).max(1000).optional(),
}).strict();

export function projectSourceCheckpointKey(provider: ProjectSourceProvider, request: ProjectSourceSearchRequest): ProjectSourceCheckpointKey {
  return {
    provider: provider.checkpointIdentity ?? provider.constructor?.name ?? 'project-source',
    tenantId: request.tenantId,
    query: request.query,
    maxItems: request.maxItems,
    allowedClassifications: [...(request.allowedClassifications ?? ['public', 'internal'])],
  };
}

function checkpointMapKey(key: ProjectSourceCheckpointKey): string { return projectSourceProtocolHash(key); }

/** Shared by file and SQL adapters so cursor and accepted evidence are one
 * atomic fact. Capacity failures never discard records or advance a cursor. */
export function nextProjectSourceCheckpoint(key: ProjectSourceCheckpointKey, current: ProjectSourceCheckpoint | undefined, result: ProjectSourceSyncResult): ProjectSourceCheckpoint {
  const request = { ...key, ...(current?.records !== undefined ? { cursor: current.cursor } : {}) };
  const synced = validateProjectSourceSync(request, result);
  const update = synced.receipt.update;
  if (!update) throw new Error('Durable project source sync requires explicit update semantics');
  const previous = current?.records ?? [];
  let records: ProjectSourceRecord[];
  let scanRecords: ProjectSourceRecord[] | undefined;
  const merge = (base: ProjectSourceRecord[], incoming: ProjectSourceRecord[]) => [...new Map([...base, ...incoming].map(record => [record.id, record])).values()];
  if (update.mode === 'snapshot') records = synced.records;
  else if (update.mode === 'unchanged') {
    if (current?.records === undefined) throw new Error('Unchanged source response requires a saved snapshot');
    records = previous;
    scanRecords = current.scanRecords;
  } else if (update.mode === 'delta') {
    if (current?.scanRecords) throw new Error('Cannot apply a delta during an unfinished source scan');
    const deleted = new Set(update.deletedIds);
    records = merge(previous.filter(record => !deleted.has(record.id)), synced.records);
  } else {
    if (!update.start && !current?.scanRecords) throw new Error('Source scan continuation requires a saved first page');
    scanRecords = merge(update.start ? [] : current!.scanRecords!, synced.records);
    records = update.complete ? scanRecords : merge(previous, synced.records);
    if (update.complete) scanRecords = undefined;
  }
  validateProjectSources({ ...key, maxItems: 1000 }, records);
  if (scanRecords) validateProjectSources({ ...key, maxItems: 1000 }, scanRecords);
  if (Buffer.byteLength(JSON.stringify({ records, scanRecords })) > 5_000_000) throw new Error('Project source snapshot capacity exceeded; narrow the configured query');
  return projectSourceCheckpointSchema.parse({ schemaVersion: 'project-source-checkpoint/1', key, revision: (current?.revision ?? 0) + 1, cursor: synced.nextCursor, receipt: synced.receipt, records, ...(scanRecords ? { scanRecords } : {}), updatedAt: new Date().toISOString() });
}

export function normalizeProjectSourceSyncResult(key: ProjectSourceCheckpointKey, current: ProjectSourceCheckpoint | undefined, resultOrCursor: ProjectSourceSyncResult | string, legacyReceipt?: ProjectSourceSyncReceipt): ProjectSourceSyncResult {
  if (typeof resultOrCursor !== 'string') return resultOrCursor;
  const cursor = resultOrCursor;
  const update = { mode: 'snapshot' as const };
  const request = { ...key, ...(current?.cursor ? { cursor: current.cursor } : {}) };
  const receipt = legacyReceipt
    ? { ...legacyReceipt, ...(current?.cursor ? { previousCursor: current.cursor } : { previousCursor: undefined }), requestHash: projectSourceSyncRequestHash(request), responseHash: projectSourceSyncResponseHash([], cursor, update, legacyReceipt.usage), nextCursor: cursor, recordCount: 0, changed: current?.cursor !== cursor, update }
    : makeSyncReceipt(key.provider, request, [], cursor, update);
  return { records: [], nextCursor: cursor, receipt };
}

/** Produces a reusable, bounded context from durable evidence, independently
 * of whether the subsequent Run can be created. Composites use this for each
 * child before selecting their combined context. */
export async function synchronizeProjectSources(provider: ProjectSourceProvider, request: ProjectSourceSyncRequest, checkpoints?: ProjectSourceCheckpointStore): Promise<ProjectSourceSyncResult & { availableRecordCount: number; scanInProgress: boolean }> {
  if (!('sync' in provider) || typeof provider.sync !== 'function') {
    const records = validateProjectSources(request, await provider.search(request));
    const nextCursor = projectSourceProtocolHash(records);
    return { records, nextCursor, receipt: makeSyncReceipt('search', request, records, nextCursor, { mode: 'snapshot' }), availableRecordCount: records.length, scanInProgress: false };
  }
  const key = projectSourceCheckpointKey(provider, request);
  const checkpoint = checkpoints ? await checkpoints.get(key) : undefined;
  if (request.cursor && checkpoint && request.cursor !== checkpoint.cursor) throw new Error('Project source cursor does not match the durable checkpoint; omit it to resume from the latest checkpoint');
  const { cursor: _cursor, ...base } = request;
  // A legacy cursor is not enough to reconstruct context. Re-fetch it once.
  const cursor = checkpoint ? (checkpoint.records === undefined ? undefined : checkpoint.cursor) : request.cursor;
  const effective = { ...base, ...(cursor ? { cursor } : {}) };
  const synced = validateProjectSourceSync(effective, await (provider as ProjectSourceSyncProvider).sync(effective, checkpoints));
  if (!checkpoints) {
    if (synced.receipt.update?.mode === 'unchanged') {
      const fresh = validateProjectSourceSync({ ...base }, await (provider as ProjectSourceSyncProvider).sync({ ...base }));
      return { ...fresh, availableRecordCount: fresh.records.length, scanInProgress: fresh.receipt.update?.mode === 'scan' && !fresh.receipt.update.complete };
    }
    return { ...synced, availableRecordCount: synced.records.length, scanInProgress: synced.receipt.update?.mode === 'scan' && !synced.receipt.update.complete };
  }
  const saved = await checkpoints.save(key, checkpoint?.revision, synced);
  const records = searchProjectSources(request, saved.records!, false);
  return { records, nextCursor: saved.cursor, receipt: { ...synced.receipt, checkpointRevision: saved.revision }, availableRecordCount: saved.records!.length, scanInProgress: saved.scanRecords !== undefined || Boolean(synced.receipt.partial) };
}

/** Local durable adapter. A writer lock prevents two processes from silently
 * replacing each other's state; writes are also serialized in-process and
 * atomically replaced so a crash cannot leave a partially written cursor. */
export class FileProjectSourceCheckpointStore implements ProjectSourceCheckpointStore {
  private state = new Map<string, ProjectSourceCheckpoint>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private writeFailure?: Error;
  private readonly lockPath: string;
  constructor(private readonly path: string) { this.lockPath = `${path}.lock`; }
  async init(): Promise<void> {
    if (this.loaded) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const lock = await open(this.lockPath, 'wx', 0o600);
      await lock.writeFile(String(process.pid)); await lock.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(this.lockPath, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid project source checkpoint lock; inspect before recovery');
      try { process.kill(pid, 0); }
      catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(this.lockPath); return this.init(); }
        throw probeError;
      }
      throw new Error('Project source checkpoint file already has a live writer');
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('Project source checkpoint file must contain an array');
      this.state = new Map(parsed.map(value => {
        const checkpoint = projectSourceCheckpointSchema.parse(value);
        return [checkpointMapKey(checkpoint.key), checkpoint];
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = new Map();
    }
    this.loaded = true;
  }
  async get(key: ProjectSourceCheckpointKey): Promise<ProjectSourceCheckpoint | undefined> {
    await this.ensureLoaded();
    const value = this.state.get(checkpointMapKey(projectSourceCheckpointKeySchema.parse(key)));
    return value ? structuredClone(value) : undefined;
  }
  save(key: ProjectSourceCheckpointKey, expectedRevision: number | undefined, result: ProjectSourceSyncResult): Promise<ProjectSourceCheckpoint>;
  save(key: ProjectSourceCheckpointKey, expectedRevision: number | undefined, cursor: string, receipt: ProjectSourceSyncReceipt): Promise<ProjectSourceCheckpoint>;
  save(key: ProjectSourceCheckpointKey, expectedRevision: number | undefined, resultOrCursor: ProjectSourceSyncResult | string, legacyReceipt?: ProjectSourceSyncReceipt): Promise<ProjectSourceCheckpoint> {
    return this.serial(async () => {
      await this.ensureLoaded();
      const parsedKey = projectSourceCheckpointKeySchema.parse(key);
      const mapKey = checkpointMapKey(parsedKey);
      const current = this.state.get(mapKey);
      if (current && current.revision !== expectedRevision) throw new ProjectSourceCheckpointConflict('Project source checkpoint changed concurrently; retry from the latest cursor');
      if (!current && expectedRevision !== undefined) throw new ProjectSourceCheckpointConflict('Project source checkpoint was deleted concurrently; retry from the beginning');
      const next = nextProjectSourceCheckpoint(parsedKey, current, normalizeProjectSourceSyncResult(parsedKey, current, resultOrCursor, legacyReceipt));
      const state = new Map(this.state).set(mapKey, next);
      await this.flush(state);
      this.state = state;
      return structuredClone(next);
    });
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  private async ensureLoaded(): Promise<void> { if (this.writeFailure) throw this.writeFailure; if (!this.loaded) await this.init(); }
  private async flush(state: Map<string, ProjectSourceCheckpoint>): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(JSON.stringify([...state.values()])); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
      try {
        const directory = await open(dirname(this.path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        this.writeFailure = new Error('Project source checkpoint durability is uncertain; reopen the store before continuing', { cause: error });
        throw this.writeFailure;
      }
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  async close(): Promise<void> {
    await this.queue;
    if (this.loaded) { this.loaded = false; await unlink(this.lockPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
}

export function projectSourceContentHash(content: string): string { return createHash('sha256').update(content).digest('hex'); }
export function projectSourceProtocolHash(value: unknown): string { return createHash('sha256').update(stableJson(value)).digest('hex'); }

export function projectSourceSyncRequestHash(request: ProjectSourceSyncRequest): string {
  return projectSourceProtocolHash({ query: request.query, maxItems: request.maxItems, tenantId: request.tenantId, allowedClassifications: request.allowedClassifications ?? ['public', 'internal'], cursor: request.cursor ?? null });
}

export function projectSourceSyncResponseHash(records: ProjectSourceRecord[], nextCursor: string, update?: ProjectSourceUpdate, usage?: GlobalBudgetUsage): string {
  return projectSourceProtocolHash({ records, nextCursor, ...(update ? { update } : {}), ...(usage === undefined ? {} : { usage }) });
}

export function validateProjectSourceSync(request: ProjectSourceSyncRequest, result: ProjectSourceSyncResult): ProjectSourceSyncResult {
  const records = validateProjectSources(request, result.records);
  const receipt = projectSourceSyncReceiptSchema.parse(result.receipt);
  if (receipt.requestHash !== projectSourceSyncRequestHash(request)) throw new Error('Project source sync receipt request hash does not match the request');
  if (receipt.responseHash !== projectSourceSyncResponseHash(records, result.nextCursor, receipt.update, receipt.usage)) throw new Error('Project source sync receipt response hash does not match the records');
  if (receipt.nextCursor !== result.nextCursor) throw new Error('Project source sync receipt cursor does not match the response');
  if (receipt.previousCursor !== request.cursor) throw new Error('Project source sync receipt previous cursor does not match the request');
  if (receipt.recordCount !== records.length) throw new Error('Project source sync receipt record count does not match the response');
  if (receipt.changed !== (request.cursor !== result.nextCursor)) throw new Error('Project source sync receipt changed flag does not match the response');
  if (receipt.update?.mode === 'unchanged' && (records.length || receipt.changed)) throw new Error('Unchanged project source response must preserve the cursor and contain no records');
  if (receipt.update?.mode === 'delta' && receipt.update.deletedIds.some(id => records.some(record => record.id === id))) throw new Error('Project source response cannot update and delete the same record');
  return { records, nextCursor: result.nextCursor, receipt };
}

export function validateProjectSources(request: ProjectSourceSearchRequest, records: ProjectSourceRecord[]): ProjectSourceRecord[] {
  if (records.length > request.maxItems) throw new Error('Project source provider returned more items than requested');
  const seen = new Set<string>();
  for (const record of records) {
    projectSourceRecordSchema.parse(record);
    if (!projectSourceVisible(record, request)) throw new Error('Project source provider returned a record outside the allowed classification');
    if (record.tenantId !== undefined && record.tenantId !== request.tenantId) throw new Error('Project source provider returned a record outside the requested tenant');
    if (seen.has(record.id)) throw new Error('Project source provider returned duplicate record IDs');
    seen.add(record.id);
    if (projectSourceContentHash(record.content) !== record.contentHash) throw new Error('Project source content hash does not match its content');
  }
  return records.map(record => structuredClone(record));
}

/** The file is produced by a connector/import job; a Run request never
 * supplies a path, so the server keeps the file trust boundary explicit. */
export class FileProjectSourceProvider implements ProjectSourceSyncProvider {
  readonly checkpointIdentity: string;
  private cached?: { signature: string; records: ProjectSourceRecord[] };
  constructor(private readonly path: string) { this.checkpointIdentity = `file:${projectSourceProtocolHash({ path })}`; }

  async health(): Promise<ProjectSourceProviderHealth> {
    return readableFileHealth(this.path);
  }

  async search(request: ProjectSourceSearchRequest): Promise<ProjectSourceRecord[]> {
    await this.load();
    return searchProjectSources(request, this.cached!.records);
  }

  async sync(request: ProjectSourceSyncRequest): Promise<ProjectSourceSyncResult> {
    const { signature } = await this.load();
    const records = request.cursor !== undefined && request.cursor === signature ? [] : searchProjectSources(request, this.cached!.records);
    const receipt = makeSyncReceipt('file', request, records, signature, { mode: request.cursor === signature ? 'unchanged' : 'snapshot' });
    return validateProjectSourceSync(request, { records, nextCursor: signature, receipt });
  }

  private async load(): Promise<{ signature: string; records: ProjectSourceRecord[] }> {
    const content = await readFile(this.path, 'utf8');
    const metadata = await stat(this.path);
    const signature = projectSourceProtocolHash({ content, size: metadata.size });
    if (!this.cached || this.cached.signature !== signature) {
      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed)) throw new Error('Project source file must contain an array of records');
      this.cached = { signature, records: parsed.map(value => projectSourceRecordSchema.parse(value)) };
    }
    return this.cached;
  }
}

export function projectSourceVisible(record: ProjectSourceRecord, request: ProjectSourceSearchRequest): boolean {
  return (request.allowedClassifications ?? ['public', 'internal']).includes(record.classification ?? 'internal');
}

export function searchProjectSources(request: ProjectSourceSearchRequest, candidates: ProjectSourceRecord[], filterUnmatched = true): ProjectSourceRecord[] {
    const terms = tokenize(request.query);
    const records = candidates
      .filter(record => record.tenantId === undefined || record.tenantId === request.tenantId)
      .filter(record => projectSourceVisible(record, request))
      .map(record => {
        const haystack = tokenize(`${record.title} ${record.content} ${record.source} ${record.kind}`);
        const matched = terms.filter(term => haystack.includes(term));
        return { record, score: terms.length === 0 ? 1 : matched.length / terms.length };
      })
      .filter(item => !filterUnmatched || terms.length === 0 || item.score > 0)
      .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt) || left.record.id.localeCompare(right.record.id))
      .slice(0, request.maxItems)
      .map(item => item.record);
    return validateProjectSources(request, records);
}

/** HTTP connector boundary for Linear/Jira/Feishu/code adapters. The adapter
 * owns vendor authentication and incremental sync; AEEIS receives only the
 * normalized, hash-bound records in the versioned response envelope. */
export class HttpProjectSourceProvider implements ProjectSourceSyncProvider {
  readonly checkpointIdentity: string;
  private readonly healthProbe: HttpDependencyProbe;
  constructor(private readonly endpoint: string, private readonly token?: string, private readonly timeoutMs = 15_000, healthEndpoint?: string) {
    this.healthProbe = new HttpDependencyProbe(endpoint, healthEndpoint, token);
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Project source endpoint must use HTTPS except loopback');
    if (url.username || url.password || url.hash) throw new Error('Project source endpoint must not contain credentials or fragments');
    this.checkpointIdentity = `http:${url.toString()}`;
  }

  async health(): Promise<ProjectSourceProviderHealth> { return this.healthProbe.health(); }

  async search(request: ProjectSourceSearchRequest): Promise<ProjectSourceRecord[]> {
    const response = await fetch(this.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ schemaVersion: 'project-source-search/1', ...request }),
    });
    if (!response.ok) throw new Error('Project source service returned HTTP ' + response.status);
    const body = z.object({ schemaVersion: z.literal('project-source-results/1'), records: z.array(projectSourceRecordSchema).max(100) }).strict().parse(await response.json());
    return validateProjectSources(request, body.records);
  }

  async sync(request: ProjectSourceSyncRequest): Promise<ProjectSourceSyncResult> {
    const response = await fetch(this.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ schemaVersion: 'project-source-sync/1', ...request }),
    });
    if (!response.ok) throw new Error('Project source service returned HTTP ' + response.status);
    const body = z.object({ schemaVersion: z.literal('project-source-sync-results/1'), records: z.array(projectSourceRecordSchema).max(100), nextCursor: z.string().trim().min(1).max(1000), receipt: projectSourceSyncReceiptSchema }).strict().parse(await response.json());
    return validateProjectSourceSync(request, { records: body.records, nextCursor: body.nextCursor, receipt: body.receipt });
  }
}

function tokenize(value: string): string[] { return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(term => term.length > 0))]; }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function makeSyncReceipt(provider: string, request: ProjectSourceSyncRequest, records: ProjectSourceRecord[], nextCursor: string, update?: ProjectSourceUpdate, usage?: GlobalBudgetUsage): ProjectSourceSyncReceipt {
  return { schemaVersion: 'project-source-sync-receipt/1', provider, requestHash: projectSourceSyncRequestHash(request), responseHash: projectSourceSyncResponseHash(records, nextCursor, update, usage), ...(request.cursor === undefined ? {} : { previousCursor: request.cursor }), nextCursor, recordCount: records.length, changed: request.cursor !== nextCursor, completedAt: new Date().toISOString(), ...(update ? { update } : {}), ...(usage === undefined ? {} : { usage }) };
}
