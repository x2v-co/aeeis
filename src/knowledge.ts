import { HttpDependencyProbe, readableFileHealth } from './dependency-health.js';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import pg from 'pg';
import { z } from 'zod';
import { globalBudgetUsageSchema, type GlobalBudgetUsage } from './global-budget.js';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { postgresAdvisoryXactLock } from './adapters/postgres-lock.js';

export const knowledgeRecordSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/),
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(100_000),
  source: z.string().min(1).max(2000),
  /** Omitted means an installation-wide record kept for backward compatibility. */
  tenantId: z.string().trim().min(1).max(200).optional(),
  classification: z.enum(['public', 'internal', 'confidential', 'private']),
  tags: z.array(z.string().max(100)).max(100),
  /** Optional audience ACL. `*` makes the record visible to every admitted audience. */
  audiences: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  updatedAt: z.string().datetime({ offset: true }),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type KnowledgeRecord = z.infer<typeof knowledgeRecordSchema>;

export interface KnowledgeSearchRequest {
  query: string;
  maxItems: number;
  allowedClassifications: Array<KnowledgeRecord['classification']>;
  audience: string;
  tenantId?: string;
}
export interface KnowledgeHit { record: KnowledgeRecord; score: number; matchedTerms: string[] }
export interface KnowledgeSearchResult { hits: KnowledgeHit[]; usage?: GlobalBudgetUsage }
export interface KnowledgeProviderHealth { ready: boolean; detail: string; checkedAt?: string }
export interface KnowledgeProvider {
  /** Arrays remain supported for non-metered/local providers. Remote
   * providers may return an envelope carrying verified usage. */
  search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[] | KnowledgeSearchResult>;
  /** Optional lightweight dependency probe. It must not perform a search or
   * mutate the knowledge source. */
  health?(): Promise<KnowledgeProviderHealth>;
}

/** Embeddings are an optional indexing capability. The source record and its
 * content hash remain canonical; vectors are derived, replaceable indexes. */
export interface KnowledgeEmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

export interface PostgresKnowledgeProviderOptions {
  embedding?: KnowledgeEmbeddingProvider;
}

export interface KnowledgeEmbeddingReindexStatus {
  model: string;
  cursor: string;
  indexed: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  batchSize: number;
  resetRequested: boolean;
  jobId?: string;
  lastError?: string;
  updatedAt: string;
  lastBatchStartedAt?: string;
  lastBatchCompletedAt?: string;
  lastBatchDurationMs?: number;
  consecutiveFailures: number;
}

export interface KnowledgeEmbeddingMaintenance {
  enqueueEmbeddingReindex(options?: { batchSize?: number; reset?: boolean }): Promise<KnowledgeEmbeddingReindexStatus>;
  getEmbeddingReindexStatus(): Promise<KnowledgeEmbeddingReindexStatus | undefined>;
  runEmbeddingReindexBatch(): Promise<KnowledgeEmbeddingReindexStatus | undefined>;
}

/** Re-checks provider output at the AEEIS trust boundary. */
export function validateKnowledgeHits(request: KnowledgeSearchRequest, hits: KnowledgeHit[]): KnowledgeHit[] {
  if (hits.length > request.maxItems) throw new Error('Knowledge provider returned more items than requested');
  const seen = new Set<string>();
  for (const hit of hits) {
    knowledgeHitSchema.parse(hit);
    if (!request.allowedClassifications.includes(hit.record.classification)) throw new Error('Knowledge provider returned a record outside the allowed classification');
    if (!isAudienceAllowed(hit.record, request.audience)) throw new Error('Knowledge provider returned a record outside the requested audience');
    if (!isTenantAllowed(hit.record, request.tenantId)) throw new Error('Knowledge provider returned a record outside the requested tenant');
    if (seen.has(hit.record.id)) throw new Error('Knowledge provider returned duplicate record IDs');
    seen.add(hit.record.id);
    if (digest(hit.record.content) !== hit.record.contentHash) throw new Error('Knowledge record content hash does not match its content');
  }
  return hits.map(hit => structuredClone(hit));
}

export function normalizeKnowledgeSearchResult(value: KnowledgeHit[] | KnowledgeSearchResult): KnowledgeSearchResult {
  if (Array.isArray(value)) return { hits: value };
  return { hits: value.hits, ...(value.usage === undefined ? {} : { usage: globalBudgetUsageSchema.parse(value.usage) }) };
}

const knowledgeHitSchema = z.object({ record: knowledgeRecordSchema, score: z.number().finite().min(0).max(1), matchedTerms: z.array(z.string()).max(200) }).strict();

/** Deterministic local adapter used for development and as a contract fixture. */
export class InMemoryKnowledgeProvider implements KnowledgeProvider {
  constructor(private readonly records: KnowledgeRecord[]) {}

  async health(): Promise<KnowledgeProviderHealth> { return { ready: true, detail: 'in-memory knowledge provider' }; }

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[] | KnowledgeSearchResult> {
    const terms = tokenize(request.query);
    return this.records
      .filter(record => request.allowedClassifications.includes(record.classification) && isAudienceAllowed(record, request.audience) && isTenantAllowed(record, request.tenantId))
      .map(record => {
        const haystack = tokenize(`${record.title} ${record.content} ${record.tags.join(' ')}`);
        const matchedTerms = terms.filter(term => haystack.includes(term));
        return { record, matchedTerms, score: terms.length === 0 ? 1 : matchedTerms.length / terms.length };
      })
      .filter(hit => terms.length === 0 || hit.score > 0)
      .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
      .slice(0, request.maxItems)
      .map(hit => structuredClone(hit));
  }
}

/** HTTP boundary for an owned knowledge service; it returns source records, never instructions. */
export class HttpKnowledgeProvider implements KnowledgeProvider {
  private readonly healthProbe: HttpDependencyProbe;
  constructor(private readonly endpoint: string, private readonly token?: string, private readonly timeoutMs = 15_000, healthEndpoint?: string) {
    this.healthProbe = new HttpDependencyProbe(endpoint, healthEndpoint, token);
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Knowledge endpoint must use HTTPS except loopback');
    if (url.username || url.password || url.hash) throw new Error('Knowledge endpoint must not contain credentials or fragments');
  }

  async health(): Promise<KnowledgeProviderHealth> { return this.healthProbe.health(); }

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[] | KnowledgeSearchResult> {
    const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify({ schemaVersion: 'knowledge-search/1', ...request }) });
    if (!response.ok) throw new Error('Knowledge service returned HTTP ' + response.status);
    const body = z.object({ schemaVersion: z.literal('knowledge-results/1'), hits: z.array(z.object({ record: knowledgeRecordSchema, score: z.number().min(0).max(1), matchedTerms: z.array(z.string()) }).strict()), usage: globalBudgetUsageSchema.optional() }).strict().parse(await response.json());
    const hits = validateKnowledgeHits(request, body.hits);
    return body.usage === undefined ? hits : { hits, usage: body.usage };
  }
}

/** OpenAI-compatible embeddings endpoint used only for derived indexes. */
export class HttpKnowledgeEmbeddingProvider implements KnowledgeEmbeddingProvider {
  readonly dimensions: number;
  private readonly healthProbe: HttpDependencyProbe | undefined;
  constructor(
    private readonly endpoint: string,
    public readonly model: string,
    private readonly apiKey = '',
    dimensions = 1536,
    private readonly timeoutMs = 15_000,
    healthEndpoint?: string,
  ) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Embedding endpoint must use HTTPS except loopback');
    if (url.username || url.password || url.search || url.hash) throw new Error('Embedding endpoint must not contain credentials, query or fragments');
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16_384) throw new Error('Embedding dimensions must be an integer between 1 and 16384');
    this.dimensions = dimensions;
    this.healthProbe = healthEndpoint === undefined ? undefined : new HttpDependencyProbe(endpoint, healthEndpoint, apiKey);
  }

  async health(): Promise<KnowledgeProviderHealth> {
    if (!this.healthProbe) return { ready: false, detail: 'embedding health probe unavailable; configure a read-only health endpoint', checkedAt: new Date().toISOString() };
    return this.healthProbe.health();
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(this.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!response.ok) throw new Error('Embedding service returned HTTP ' + response.status);
    const body = z.object({ data: z.array(z.object({ embedding: z.array(z.number().finite()) }).strict()).min(1) }).strict().parse(await response.json());
    const embedding = body.data[0]?.embedding;
    if (!embedding || embedding.length !== this.dimensions) throw new Error('Embedding service returned an unexpected vector dimension');
    return embedding;
  }
}

/** File-backed source for local development and single-machine deployments. */
export class FileKnowledgeProvider implements KnowledgeProvider {
  constructor(private readonly path: string) {}
  private cached?: { signature: string; records: KnowledgeRecord[] };

  async health(): Promise<KnowledgeProviderHealth> {
    return readableFileHealth(this.path);
  }

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[]> {
    const metadata = await stat(this.path);
    const signature = `${metadata.mtimeMs}:${metadata.size}`;
    if (!this.cached || this.cached.signature !== signature) {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('Knowledge file must contain an array of records');
      this.cached = { signature, records: parsed.map(record => knowledgeRecordSchema.parse(record)) };
    }
    return normalizeKnowledgeSearchResult(await new InMemoryKnowledgeProvider(this.cached.records).search(request)).hits;
  }
}

/** PostgreSQL knowledge source for installations that need durable, indexed
 * records. The provider owns only knowledge records; AEEIS still re-validates
 * every hit at the trust boundary before it enters a Context Pack. */
export class PostgresKnowledgeProvider implements KnowledgeProvider, KnowledgeEmbeddingMaintenance {
  private readonly pool: pg.Pool;
  private readonly embedding: KnowledgeEmbeddingProvider | undefined;

  constructor(connectionString: string, options: PostgresKnowledgeProviderOptions = {}) {
    this.pool = new pg.Pool({ connectionString });
    this.embedding = options.embedding;
  }

  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'knowledge', async client => { await client.query(`
      CREATE TABLE IF NOT EXISTS aeeis_knowledge_records (
        id text PRIMARY KEY,
        record jsonb NOT NULL,
        tenant_id text,
        classification text NOT NULL,
        audiences text[],
        updated_at timestamptz NOT NULL,
        content_hash text NOT NULL,
        search_text text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS aeeis_knowledge_classification_idx ON aeeis_knowledge_records(classification);
      ALTER TABLE aeeis_knowledge_records ADD COLUMN IF NOT EXISTS tenant_id text;
      CREATE INDEX IF NOT EXISTS aeeis_knowledge_tenant_idx ON aeeis_knowledge_records(tenant_id);
      CREATE INDEX IF NOT EXISTS aeeis_knowledge_audiences_idx ON aeeis_knowledge_records USING GIN(audiences);
      CREATE INDEX IF NOT EXISTS aeeis_knowledge_search_idx ON aeeis_knowledge_records USING GIN(to_tsvector('simple', search_text));
    `);
    if (this.embedding) {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_knowledge_embeddings (
          record_id text PRIMARY KEY REFERENCES aeeis_knowledge_records(id) ON DELETE CASCADE,
          model text NOT NULL,
          embedding vector(${this.embedding.dimensions}) NOT NULL,
          updated_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS aeeis_knowledge_embedding_idx ON aeeis_knowledge_embeddings USING hnsw (embedding vector_cosine_ops);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_knowledge_embedding_reindex (
          model text PRIMARY KEY,
          cursor text NOT NULL DEFAULT '',
          indexed bigint NOT NULL DEFAULT 0,
          status text NOT NULL DEFAULT 'running',
          updated_at timestamptz NOT NULL,
          batch_size integer NOT NULL DEFAULT 100,
          reset_requested boolean NOT NULL DEFAULT false,
          job_id text,
          last_error text,
          last_batch_started_at timestamptz,
          last_batch_completed_at timestamptz,
          last_batch_duration_ms integer,
          consecutive_failures integer NOT NULL DEFAULT 0
        );
        ALTER TABLE aeeis_knowledge_embedding_reindex ADD COLUMN IF NOT EXISTS batch_size integer NOT NULL DEFAULT 100;
        ALTER TABLE aeeis_knowledge_embedding_reindex ADD COLUMN IF NOT EXISTS reset_requested boolean NOT NULL DEFAULT false;
        ALTER TABLE aeeis_knowledge_embedding_reindex ADD COLUMN IF NOT EXISTS job_id text;
        ALTER TABLE aeeis_knowledge_embedding_reindex ADD COLUMN IF NOT EXISTS last_error text;
        ALTER TABLE aeeis_knowledge_embedding_reindex ADD COLUMN IF NOT EXISTS last_batch_started_at timestamptz;
        ALTER TABLE aeeis_knowledge_embedding_reindex ADD COLUMN IF NOT EXISTS last_batch_completed_at timestamptz;
        ALTER TABLE aeeis_knowledge_embedding_reindex ADD COLUMN IF NOT EXISTS last_batch_duration_ms integer;
        ALTER TABLE aeeis_knowledge_embedding_reindex ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;
      `);
    }
    });
  }

  async health(): Promise<KnowledgeProviderHealth> {
    await this.pool.query('SELECT 1');
    return { ready: true, detail: 'knowledge PostgreSQL reachable' };
  }

  async upsert(recordInput: KnowledgeRecord): Promise<void> {
    const record = knowledgeRecordSchema.parse(recordInput);
    assertKnowledgeRecordHash(record);
    await this.pool.query(
      `INSERT INTO aeeis_knowledge_records(id,record,tenant_id,classification,audiences,updated_at,content_hash,search_text)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(id) DO UPDATE SET record=EXCLUDED.record,tenant_id=EXCLUDED.tenant_id,classification=EXCLUDED.classification,audiences=EXCLUDED.audiences,updated_at=EXCLUDED.updated_at,content_hash=EXCLUDED.content_hash,search_text=EXCLUDED.search_text`,
      [record.id, record, record.tenantId ?? null, record.classification, record.audiences ?? null, record.updatedAt, record.contentHash, searchableText(record)],
    );
    await this.upsertEmbedding(record);
  }

  async upsertMany(records: KnowledgeRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const parsedRecords = records.map(record => {
        const parsed = knowledgeRecordSchema.parse(record);
        assertKnowledgeRecordHash(parsed);
        return parsed;
      });
      const embeddings = this.embedding
        ? await Promise.all(parsedRecords.map(async record => ({ record, vector: await this.embedding!.embed(searchableText(record)) })))
        : [];
      for (const parsed of parsedRecords) {
        await client.query(
          `INSERT INTO aeeis_knowledge_records(id,record,tenant_id,classification,audiences,updated_at,content_hash,search_text)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT(id) DO UPDATE SET record=EXCLUDED.record,tenant_id=EXCLUDED.tenant_id,classification=EXCLUDED.classification,audiences=EXCLUDED.audiences,updated_at=EXCLUDED.updated_at,content_hash=EXCLUDED.content_hash,search_text=EXCLUDED.search_text`,
          [parsed.id, parsed, parsed.tenantId ?? null, parsed.classification, parsed.audiences ?? null, parsed.updatedAt, parsed.contentHash, searchableText(parsed)],
        );
      }
      for (const item of embeddings) await this.writeEmbedding(client, item.record.id, item.vector);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async remove(id: string): Promise<void> { await this.pool.query('DELETE FROM aeeis_knowledge_records WHERE id=$1', [id]); }

  /** Backfills the derived vector index in bounded, durable batches. The
   * canonical record table is never replaced. A completed cursor is reused
   * on subsequent invocations; pass reset=true for an explicit full rebuild. */
  async reindexEmbeddings(batchSize = 100, reset = false): Promise<{ indexed: number; completed: boolean }> {
    if (!this.embedding) throw new Error('Knowledge embedding provider is not configured');
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Embedding reindex batch size must be between 1 and 1000');
    const queued = await this.enqueueEmbeddingReindex({ batchSize, reset });
    // Synchronous callers own this invocation and may resume a previously
    // interrupted lease immediately; the HTTP/operator path remains queued
    // and is protected by the advisory lock in runEmbeddingReindexBatch.
    await this.pool.query(`UPDATE aeeis_knowledge_embedding_reindex SET status='queued',updated_at=$2 WHERE model=$1`, [this.embedding.model, new Date().toISOString()]);
    let status = queued;
    while (status.status !== 'completed') {
      const next = await this.runEmbeddingReindexBatch();
      if (!next) break;
      status = next;
      if (status.status === 'failed') throw new Error(status.lastError ?? 'Embedding reindex failed');
      if (status.status === 'completed') break;
    }
    // The batch status is authoritative; this return value is the number of
    // rows indexed by this call, reconstructed from the durable checkpoint.
    return { indexed: status.indexed - (reset ? 0 : queued.indexed), completed: status.status === 'completed' };
  }

  async enqueueEmbeddingReindex(options: { batchSize?: number; reset?: boolean } = {}): Promise<KnowledgeEmbeddingReindexStatus> {
    if (!this.embedding) throw new Error('Knowledge embedding provider is not configured');
    const batchSize = options.batchSize ?? 100;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Embedding reindex batch size must be between 1 and 1000');
    const reset = options.reset === true;
    const now = new Date().toISOString();
    const jobId = randomUUID();
    await this.pool.query(
      `INSERT INTO aeeis_knowledge_embedding_reindex(model,cursor,indexed,status,updated_at,batch_size,reset_requested,job_id,last_error,consecutive_failures)
       VALUES($1,'',0,'queued',$2,$3,$4,$5,NULL,0)
       ON CONFLICT(model) DO UPDATE SET
         status=CASE WHEN $4 THEN 'queued' ELSE CASE WHEN aeeis_knowledge_embedding_reindex.status='running' THEN 'running' ELSE 'queued' END END,
         batch_size=$3,
         reset_requested=aeeis_knowledge_embedding_reindex.reset_requested OR $4,
         job_id=COALESCE(aeeis_knowledge_embedding_reindex.job_id,$5),
         last_error=NULL,
         updated_at=$2`,
      [this.embedding.model, now, batchSize, reset, jobId],
    );
    return (await this.getEmbeddingReindexStatus())!;
  }

  async getEmbeddingReindexStatus(): Promise<KnowledgeEmbeddingReindexStatus | undefined> {
    if (!this.embedding) return undefined;
    const result = await this.pool.query<{
      model: string; cursor: string; indexed: string | number; status: string; batch_size: number;
      reset_requested: boolean; job_id: string | null; last_error: string | null; updated_at: Date | string;
      last_batch_started_at: Date | string | null; last_batch_completed_at: Date | string | null;
      last_batch_duration_ms: number | null; consecutive_failures: number;
    }>(`SELECT model,cursor,indexed,status,batch_size,reset_requested,job_id,last_error,updated_at,last_batch_started_at,last_batch_completed_at,last_batch_duration_ms,consecutive_failures
        FROM aeeis_knowledge_embedding_reindex WHERE model=$1`, [this.embedding.model]);
    const row = result.rows[0];
    if (!row) return undefined;
    const timestamp = (value: Date | string | null): string | undefined => value === null ? undefined : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    const lastBatchStartedAt = timestamp(row.last_batch_started_at);
    const lastBatchCompletedAt = timestamp(row.last_batch_completed_at);
    return {
      model: row.model, cursor: row.cursor, indexed: Number(row.indexed),
      status: z.enum(['queued', 'running', 'completed', 'failed']).parse(row.status),
      batchSize: row.batch_size, resetRequested: row.reset_requested,
      ...(row.job_id ? { jobId: row.job_id } : {}), ...(row.last_error ? { lastError: row.last_error } : {}),
      updatedAt: timestamp(row.updated_at)!, ...(lastBatchStartedAt ? { lastBatchStartedAt } : {}),
      ...(lastBatchCompletedAt ? { lastBatchCompletedAt } : {}),
      ...(row.last_batch_duration_ms === null ? {} : { lastBatchDurationMs: row.last_batch_duration_ms }),
      consecutiveFailures: row.consecutive_failures,
    };
  }

  async runEmbeddingReindexBatch(): Promise<KnowledgeEmbeddingReindexStatus | undefined> {
    if (!this.embedding) return undefined;
    const client = await this.pool.connect();
    let claimed: KnowledgeEmbeddingReindexStatus | undefined;
    try {
      await client.query('BEGIN');
      await postgresAdvisoryXactLock(client, 'aeeis:knowledge-reindex', this.embedding.model);
      const current = await this.getEmbeddingReindexStatus();
      if (!current || current.status === 'completed') { await client.query('COMMIT'); return current; }
      if (current.status === 'running' && Date.now() - Date.parse(current.updatedAt) < 300_000) { await client.query('COMMIT'); return current; }
      const startedAt = new Date().toISOString();
      await client.query(`UPDATE aeeis_knowledge_embedding_reindex SET status='running',updated_at=$2,last_batch_started_at=$2 WHERE model=$1`, [this.embedding.model, startedAt]);
      await client.query('COMMIT');
      claimed = { ...current, status: 'running', updatedAt: startedAt, lastBatchStartedAt: startedAt };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
    if (!claimed) return undefined;
    const started = Date.now();
    try {
      const cursor = claimed.resetRequested ? '' : claimed.cursor;
      const result = await this.pool.query<{ id: string; record: unknown }>(`SELECT id, record FROM aeeis_knowledge_records WHERE id > $1 ORDER BY id ASC LIMIT $2`, [cursor, claimed.batchSize]);
      const records = result.rows.map(row => knowledgeRecordSchema.parse(row.record));
      const vectors = await Promise.all(records.map(record => this.embedding!.embed(searchableText(record))));
      const finishedAt = new Date().toISOString();
      const client2 = await this.pool.connect();
      try {
        await client2.query('BEGIN');
        for (let index = 0; index < records.length; index += 1) {
          const record = records[index]; const vector = vectors[index];
          if (!record || !vector) throw new Error('Embedding reindex batch is incomplete');
          await this.writeEmbedding(client2, record.id, vector);
        }
        await client2.query(`UPDATE aeeis_knowledge_embedding_reindex SET cursor=$2,indexed=CASE WHEN $3 THEN 0 ELSE indexed END + $4,status=$5,reset_requested=false,last_error=NULL,updated_at=$6,last_batch_completed_at=$6,last_batch_duration_ms=$7,consecutive_failures=0 WHERE model=$1`, [this.embedding.model, result.rows.at(-1)?.id ?? cursor, claimed.resetRequested, records.length, result.rows.length === 0 ? 'completed' : 'queued', finishedAt, Date.now() - started]);
        await client2.query('COMMIT');
      } catch (error) { await client2.query('ROLLBACK'); throw error; } finally { client2.release(); }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Embedding reindex failed';
      await this.pool.query(`UPDATE aeeis_knowledge_embedding_reindex SET status='failed',last_error=$2,updated_at=$3,consecutive_failures=consecutive_failures+1 WHERE model=$1`, [this.embedding.model, message.slice(0, 2000), new Date().toISOString()]);
    }
    return (await this.getEmbeddingReindexStatus())!;
  }

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[]> {
    const query = request.query.trim();
    if (this.embedding && query) {
      try {
        const vector = await this.embedding.embed(query);
        const semantic = await this.semanticSearch(request, vector);
        if (semantic.length > 0) return semantic;
      } catch {
        // The derived index is optional. Keep the canonical lexical path
        // available during embedding outages or partial backfills.
      }
    }
    const result = await this.pool.query<{ record: unknown; score: number; search_text: string }>(
      `WITH candidate AS (
         SELECT record, search_text,
           CASE WHEN $1 = '' THEN 1::real ELSE ts_rank_cd(to_tsvector('simple', search_text), websearch_to_tsquery('simple', $1)) END AS score
         FROM aeeis_knowledge_records
         WHERE classification = ANY($2::text[])
           AND (tenant_id IS NULL OR tenant_id = $5)
           AND (audiences IS NULL OR '*' = ANY(audiences) OR $3 = ANY(audiences))
           AND ($1 = '' OR to_tsvector('simple', search_text) @@ websearch_to_tsquery('simple', $1) OR lower(search_text) LIKE lower('%' || $1 || '%'))
       )
       SELECT record, search_text, GREATEST(score, CASE WHEN $1 <> '' AND lower(search_text) LIKE lower('%' || $1 || '%') THEN 0.01 ELSE 0 END)::real AS score
       FROM candidate ORDER BY score DESC, (record->>'updatedAt') DESC, (record->>'id') ASC LIMIT $4`,
      [query, request.allowedClassifications, request.audience, request.maxItems, request.tenantId ?? null],
    );
    const hits = result.rows.map(row => {
      const record = knowledgeRecordSchema.parse(row.record);
      const terms = tokenize(query);
      const haystack = tokenize(row.search_text);
      return { record, score: Math.max(0, Math.min(1, Number(row.score))), matchedTerms: terms.filter(term => haystack.includes(term)) };
    });
    return validateKnowledgeHits(request, hits);
  }

  private async semanticSearch(request: KnowledgeSearchRequest, vector: number[]): Promise<KnowledgeHit[]> {
    if (!this.embedding) return [];
    const result = await this.pool.query<{ record: unknown; distance: number; search_text: string }>(
      `SELECT r.record, r.search_text, e.embedding <=> $1::vector AS distance
       FROM aeeis_knowledge_records r
       JOIN aeeis_knowledge_embeddings e ON e.record_id = r.id AND e.model = $5
       WHERE r.classification = ANY($2::text[])
         AND (r.tenant_id IS NULL OR r.tenant_id = $6)
         AND (r.audiences IS NULL OR '*' = ANY(r.audiences) OR $3 = ANY(r.audiences))
       ORDER BY e.embedding <=> $1::vector ASC, (r.record->>'updatedAt') DESC, (r.record->>'id') ASC
       LIMIT $4`,
      [toPgVector(vector, this.embedding.dimensions), request.allowedClassifications, request.audience, request.maxItems, this.embedding.model, request.tenantId ?? null],
    );
    return validateKnowledgeHits(request, result.rows.map(row => {
      const record = knowledgeRecordSchema.parse(row.record);
      const terms = tokenize(request.query);
      const haystack = tokenize(row.search_text);
      return { record, score: Math.max(0, Math.min(1, 1 - Number(row.distance))), matchedTerms: terms.filter(term => haystack.includes(term)) };
    }));
  }

  private async upsertEmbedding(record: KnowledgeRecord): Promise<void> {
    if (!this.embedding) return;
    const vector = await this.embedding.embed(searchableText(record));
    await this.writeEmbedding(this.pool, record.id, vector);
  }

  private async writeEmbedding(client: Pick<pg.Pool, 'query'>, recordId: string, vector: number[]): Promise<void> {
    if (!this.embedding) return;
    await client.query(
      `INSERT INTO aeeis_knowledge_embeddings(record_id,model,embedding,updated_at)
       VALUES($1,$2,$3::vector,$4)
       ON CONFLICT(record_id) DO UPDATE SET model=EXCLUDED.model,embedding=EXCLUDED.embedding,updated_at=EXCLUDED.updated_at`,
      [recordId, this.embedding.model, toPgVector(vector, this.embedding.dimensions), new Date().toISOString()],
    );
  }

  async close(): Promise<void> { await this.pool.end(); }
}

export function makeKnowledgeRecord(input: Omit<KnowledgeRecord, 'contentHash'>): KnowledgeRecord {
  return knowledgeRecordSchema.parse({ ...input, contentHash: digest(input.content) });
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1))];
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function searchableText(record: KnowledgeRecord): string { return `${record.title} ${record.content} ${record.tags.join(' ')}`; }
function assertKnowledgeRecordHash(record: KnowledgeRecord): void { if (digest(record.content) !== record.contentHash) throw new Error('Knowledge record content hash does not match its content'); }

export function toPgVector(vector: readonly number[], dimensions: number): string {
  if (vector.length !== dimensions || vector.some(value => !Number.isFinite(value))) throw new Error('Embedding vector has an unexpected dimension or non-finite value');
  return `[${vector.join(',')}]`;
}

export function isAudienceAllowed(record: KnowledgeRecord, audience: string): boolean {
  return record.audiences === undefined || record.audiences.includes('*') || record.audiences.includes(audience);
}

function isTenantAllowed(record: KnowledgeRecord, tenantId: string | undefined): boolean {
  return record.tenantId === undefined || record.tenantId === tenantId;
}
