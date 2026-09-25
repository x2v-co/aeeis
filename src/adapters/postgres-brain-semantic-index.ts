import { createHash } from 'node:crypto';
import pg from 'pg';
import type { BrainClaim, BrainEmbeddingProvider, BrainSemanticHit, BrainSemanticIndexMaintenance, BrainSemanticSearchRequest } from '../brain.js';
import { withPostgresMigrationLock } from './postgres-migration.js';

/**
 * PostgreSQL/pgvector side index for Brain claims. The JSON Brain state stays
 * canonical; this index can be dropped and rebuilt without changing claims or
 * audit history. Search returns only claim IDs so the Brain trust boundary can
 * apply state, tenant, grant and classification checks again.
 */
export class PostgresBrainSemanticIndex implements BrainSemanticIndexMaintenance {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, private readonly embedding: BrainEmbeddingProvider) {
    this.pool = new pg.Pool({ connectionString });
    if (!Number.isInteger(embedding.dimensions) || embedding.dimensions < 1 || embedding.dimensions > 16_384) throw new Error('Brain embedding dimensions must be an integer between 1 and 16384');
  }

  get model(): string { return this.embedding.model; }
  get dimensions(): number { return this.embedding.dimensions; }

  async health(): Promise<{ ready: boolean; detail: string; checkedAt: string }> {
    const checkedAt = new Date().toISOString();
    try {
      await boundedQuery(this.pool, 'SELECT 1 FROM aeeis_brain_embeddings LIMIT 1', 3_000);
      const embedding = this.embedding.health
        ? await this.embedding.health()
        : { ready: false, detail: 'embedding health probe unavailable; configure a read-only health endpoint' };
      return { ready: embedding.ready, detail: `Brain semantic index database reachable; ${embedding.detail}`, checkedAt };
    } catch {
      return { ready: false, detail: 'Brain semantic index dependency probe failed', checkedAt };
    }
  }

  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'brain-embeddings', async client => {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_brain_embeddings (
          claim_id text PRIMARY KEY,
          owner text NOT NULL,
          tenant_id text NOT NULL,
          scope_ref text NOT NULL,
          classification text NOT NULL,
          content_hash text NOT NULL,
          model text NOT NULL,
          embedding vector(${this.embedding.dimensions}) NOT NULL,
          updated_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS aeeis_brain_embedding_scope_idx ON aeeis_brain_embeddings(tenant_id,owner,scope_ref,classification);
        CREATE INDEX IF NOT EXISTS aeeis_brain_embedding_vector_idx ON aeeis_brain_embeddings USING hnsw (embedding vector_cosine_ops);
      `);
    });
  }

  async reconcile(claims: BrainClaim[]): Promise<void> {
    const active = claims.filter(claim => claim.state === 'active');
    const vectors = await Promise.all(active.map(async claim => ({ claim, vector: await this.embedding.embed(searchableClaim(claim)) })));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const { claim, vector } of vectors) {
        await client.query(
          `INSERT INTO aeeis_brain_embeddings(claim_id,owner,tenant_id,scope_ref,classification,content_hash,model,embedding,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::vector,$9)
           ON CONFLICT(claim_id) DO UPDATE SET owner=EXCLUDED.owner,tenant_id=EXCLUDED.tenant_id,scope_ref=EXCLUDED.scope_ref,classification=EXCLUDED.classification,content_hash=EXCLUDED.content_hash,model=EXCLUDED.model,embedding=EXCLUDED.embedding,updated_at=EXCLUDED.updated_at`,
          [claim.id, claim.owner, claim.tenantId ?? 'local', claim.scopeRef, claim.classification, claimContentHash(claim), this.embedding.model, toVector(vector), claim.updatedAt],
        );
      }
      if (active.length === 0) await client.query('DELETE FROM aeeis_brain_embeddings');
      else await client.query('DELETE FROM aeeis_brain_embeddings WHERE NOT (claim_id = ANY($1::text[]))', [active.map(claim => claim.id)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async search(request: BrainSemanticSearchRequest): Promise<BrainSemanticHit[]> {
    const vector = await this.embedding.embed(request.query);
    const result = await this.pool.query<{ claim_id: string; distance: number }>(
      `SELECT claim_id, (embedding <=> $1::vector) AS distance
         FROM aeeis_brain_embeddings
        WHERE owner=$2 AND tenant_id=$3 AND scope_ref=$4 AND model=$5
          AND classification IN ('public','internal','confidential','private')
          AND CASE $6
            WHEN 'public' THEN classification='public'
            WHEN 'internal' THEN classification IN ('public','internal')
            WHEN 'confidential' THEN classification IN ('public','internal','confidential')
            ELSE true
          END
        ORDER BY embedding <=> $1::vector, claim_id
        LIMIT $7`,
      [toVector(vector), request.owner, request.tenantId, request.scopeRef, this.embedding.model, request.classificationLimit, request.maxItems],
    );
    return result.rows.map(row => ({ claimId: row.claim_id, score: clampScore(1 - Number(row.distance)) }));
  }

  async close(): Promise<void> { await this.pool.end(); }
}

async function boundedQuery(pool: pg.Pool, text: string, timeoutMs: number): Promise<pg.QueryResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pool.query(text),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('database health probe timed out')), timeoutMs); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function searchableClaim(claim: BrainClaim): string {
  return `${claim.kind}\n${claim.content}\n${claim.sourceRefs.join(' ')}`;
}

function claimContentHash(claim: BrainClaim): string {
  // The index only needs a stable change marker; the canonical claim digest is
  // intentionally not used as a trust decision during retrieval.
  return createStableHash(JSON.stringify({ id: claim.id, version: claim.version, content: claim.content, sourceRefs: claim.sourceRefs, kind: claim.kind }));
}

function createStableHash(value: string): string {
  // Avoid importing a second canonicalization policy into the side index.
  // Node's crypto implementation is deterministic for this already-normalized
  // string and the hash is informational only.
  return createHash('sha256').update(value).digest('hex');
}

function toVector(vector: number[]): string {
  if (!vector.every(value => Number.isFinite(value))) throw new Error('Embedding vector contains a non-finite value');
  return `[${vector.join(',')}]`;
}

function clampScore(value: number): number { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
