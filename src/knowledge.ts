import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export const knowledgeRecordSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/),
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(100_000),
  source: z.string().min(1).max(2000),
  classification: z.enum(['public', 'internal', 'confidential', 'private']),
  tags: z.array(z.string().max(100)).max(100),
  updatedAt: z.string().datetime({ offset: true }),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type KnowledgeRecord = z.infer<typeof knowledgeRecordSchema>;

export interface KnowledgeSearchRequest {
  query: string;
  maxItems: number;
  allowedClassifications: Array<KnowledgeRecord['classification']>;
  audience: string;
}
export interface KnowledgeHit { record: KnowledgeRecord; score: number; matchedTerms: string[] }
export interface KnowledgeProvider {
  search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[]>;
}

/** Re-checks provider output at the AEEIS trust boundary. */
export function validateKnowledgeHits(request: KnowledgeSearchRequest, hits: KnowledgeHit[]): KnowledgeHit[] {
  if (hits.length > request.maxItems) throw new Error('Knowledge provider returned more items than requested');
  const seen = new Set<string>();
  for (const hit of hits) {
    knowledgeHitSchema.parse(hit);
    if (!request.allowedClassifications.includes(hit.record.classification)) throw new Error('Knowledge provider returned a record outside the allowed classification');
    if (seen.has(hit.record.id)) throw new Error('Knowledge provider returned duplicate record IDs');
    seen.add(hit.record.id);
    if (digest(hit.record.content) !== hit.record.contentHash) throw new Error('Knowledge record content hash does not match its content');
  }
  return hits.map(hit => structuredClone(hit));
}

const knowledgeHitSchema = z.object({ record: knowledgeRecordSchema, score: z.number().finite().min(0).max(1), matchedTerms: z.array(z.string()).max(200) }).strict();

/** Deterministic local adapter used for development and as a contract fixture. */
export class InMemoryKnowledgeProvider implements KnowledgeProvider {
  constructor(private readonly records: KnowledgeRecord[]) {}

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[]> {
    const terms = tokenize(request.query);
    return this.records
      .filter(record => request.allowedClassifications.includes(record.classification))
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
  constructor(private readonly endpoint: string, private readonly token?: string, private readonly timeoutMs = 15_000) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Knowledge endpoint must use HTTPS except loopback');
    if (url.username || url.password || url.hash) throw new Error('Knowledge endpoint must not contain credentials or fragments');
  }

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[]> {
    const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify({ schemaVersion: 'knowledge-search/1', ...request }) });
    if (!response.ok) throw new Error('Knowledge service returned HTTP ' + response.status);
    const body = z.object({ schemaVersion: z.literal('knowledge-results/1'), hits: z.array(z.object({ record: knowledgeRecordSchema, score: z.number().min(0).max(1), matchedTerms: z.array(z.string()) }).strict()) }).strict().parse(await response.json());
    return validateKnowledgeHits(request, body.hits);
  }
}

/** File-backed source for local development and single-machine deployments. */
export class FileKnowledgeProvider implements KnowledgeProvider {
  constructor(private readonly path: string) {}

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeHit[]> {
    const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('Knowledge file must contain an array of records');
    const records = parsed.map(record => knowledgeRecordSchema.parse(record));
    return new InMemoryKnowledgeProvider(records).search(request);
  }
}

export function makeKnowledgeRecord(input: Omit<KnowledgeRecord, 'contentHash'>): KnowledgeRecord {
  return knowledgeRecordSchema.parse({ ...input, contentHash: digest(input.content) });
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1))];
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
