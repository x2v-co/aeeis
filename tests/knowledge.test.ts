import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { FileKnowledgeProvider, HttpKnowledgeEmbeddingProvider, InMemoryKnowledgeProvider, makeKnowledgeRecord, toPgVector, validateKnowledgeHits } from '../src/knowledge.js';

describe('knowledge provider boundary', () => {
  it('filters by classification and returns deterministic evidence hits', async () => {
    const provider = new InMemoryKnowledgeProvider([
      makeKnowledgeRecord({ id: 'knowledge.temporal', title: 'Temporal', content: 'Durable workflow execution', source: 'docs', classification: 'internal', tags: ['workflow'], updatedAt: '2026-09-18T00:00:00.000Z' }),
      makeKnowledgeRecord({ id: 'knowledge.private', title: 'Private', content: 'Secret workflow note', source: 'private', classification: 'private', tags: [], updatedAt: '2026-09-18T00:00:00.000Z' }),
    ]);
    const hits = await provider.search({ query: 'durable workflow', maxItems: 5, allowedClassifications: ['internal'], audience: 'agent.1' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.record.id).toBe('knowledge.temporal');
    expect(hits[0]?.record.contentHash).toHaveLength(64);
    await expect(provider.health?.()).resolves.toMatchObject({ ready: true });
  });
});

it('loads and validates a file-backed knowledge index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-knowledge-file-'));
  const record = makeKnowledgeRecord({ id: 'knowledge.file', title: 'Durable execution', content: 'Use checkpoints', source: 'local-file', classification: 'internal', tags: ['runtime'], updatedAt: '2026-09-18T00:00:00.000Z' });
  const provider = new FileKnowledgeProvider(join(directory, 'records.json'));
  await writeFile(join(directory, 'records.json'), JSON.stringify([record]));
  const hits = await provider.search({ query: 'checkpoints', maxItems: 3, allowedClassifications: ['public', 'internal'], audience: 'owner' });
  expect(hits[0]?.record.id).toBe('knowledge.file');
  await expect(provider.health?.()).resolves.toMatchObject({ ready: true, detail: 'source file readable; content validated on use' });
});

it('rejects provider results outside the requested classification or with a bad content hash', () => {
  const record = makeKnowledgeRecord({ id: 'knowledge.boundary', title: 'Boundary', content: 'Safe', source: 'fixture', classification: 'internal', tags: [], updatedAt: '2026-09-18T00:00:00.000Z' });
  const request = { query: 'safe', maxItems: 2, allowedClassifications: ['public'] as const, audience: 'owner' };
  expect(() => validateKnowledgeHits(request, [{ record, score: 1, matchedTerms: ['safe'] }])).toThrow('classification');
  expect(() => validateKnowledgeHits({ ...request, allowedClassifications: ['internal'] }, [{ record: { ...record, contentHash: 'a'.repeat(64) }, score: 1, matchedTerms: ['safe'] }])).toThrow('hash');
});

it('enforces record audience ACLs before returning a hit', async () => {
  const provider = new InMemoryKnowledgeProvider([
    makeKnowledgeRecord({ id: 'knowledge.team', title: 'Team', content: 'Team-only plan', source: 'wiki', classification: 'internal', tags: ['plan'], audiences: ['team-a'], updatedAt: '2026-09-18T00:00:00.000Z' }),
    makeKnowledgeRecord({ id: 'knowledge.public', title: 'Public', content: 'Shared plan', source: 'wiki', classification: 'internal', tags: ['plan'], audiences: ['*'], updatedAt: '2026-09-18T00:00:00.000Z' }),
  ]);
  const hits = await provider.search({ query: 'plan', maxItems: 5, allowedClassifications: ['internal'], audience: 'team-b' });
  expect(hits.map(hit => hit.record.id)).toEqual(['knowledge.public']);
});

it('enforces tenant boundaries while preserving installation-wide records', async () => {
  const provider = new InMemoryKnowledgeProvider([
    makeKnowledgeRecord({ id: 'knowledge.tenant.a', title: 'A', content: 'tenant alpha plan', source: 'wiki', classification: 'internal', tags: ['plan'], tenantId: 'tenant-a', updatedAt: '2026-09-18T00:00:00.000Z' }),
    makeKnowledgeRecord({ id: 'knowledge.global', title: 'Global', content: 'shared plan', source: 'wiki', classification: 'internal', tags: ['plan'], updatedAt: '2026-09-18T00:00:00.000Z' }),
  ]);
  const hits = await provider.search({ query: 'plan', maxItems: 5, allowedClassifications: ['internal'], audience: 'owner', tenantId: 'tenant-b' });
  expect(hits.map(hit => hit.record.id)).toEqual(['knowledge.global']);
  expect(() => validateKnowledgeHits({ query: 'plan', maxItems: 5, allowedClassifications: ['internal'], audience: 'owner', tenantId: 'tenant-b' }, [{ record: makeKnowledgeRecord({ id: 'knowledge.bad-tenant', title: 'Bad', content: 'plan', source: 'fixture', classification: 'internal', tags: [], tenantId: 'tenant-a', updatedAt: '2026-09-18T00:00:00.000Z' }), score: 1, matchedTerms: ['plan'] }])).toThrow('tenant');
});

it('reloads a file source when its source signature changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-knowledge-cache-'));
  const path = join(directory, 'records.json');
  const first = makeKnowledgeRecord({ id: 'knowledge.first', title: 'First', content: 'first', source: 'file', classification: 'internal', tags: [], updatedAt: '2026-09-18T00:00:00.000Z' });
  const second = makeKnowledgeRecord({ id: 'knowledge.second', title: 'Second', content: 'second', source: 'file', classification: 'internal', tags: [], updatedAt: '2026-09-18T00:00:01.000Z' });
  try {
    await writeFile(path, JSON.stringify([first]));
    const provider = new FileKnowledgeProvider(path);
    const request = { query: 'first', maxItems: 5, allowedClassifications: ['internal'] as const, audience: 'owner' };
    await expect(provider.search(request)).resolves.toHaveLength(1);
    await writeFile(path, JSON.stringify([second]));
    await expect(provider.search({ ...request, query: 'second' })).resolves.toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('validates OpenAI-compatible embedding responses and pgvector literals', async () => {
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer embedding-secret');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ embedding: [0.1, -0.2, 0.3] }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const provider = new HttpKnowledgeEmbeddingProvider(`http://127.0.0.1:${port}`, 'fixture-embedding', 'embedding-secret', 3);
    await expect(provider.embed('durable tasks')).resolves.toEqual([0.1, -0.2, 0.3]);
    expect(toPgVector([0.1, -0.2, 0.3], 3)).toBe('[0.1,-0.2,0.3]');
    expect(() => toPgVector([0.1, 0.2], 3)).toThrow('dimension');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('uses an explicit read-only health endpoint without invoking embedding generation', async () => {
  const methods: string[] = [];
  const server = createServer((request, response) => {
    methods.push(request.method ?? '');
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/health') { response.end(JSON.stringify({ status: 'ok' })); return; }
    response.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const provider = new HttpKnowledgeEmbeddingProvider(`http://127.0.0.1:${port}/embeddings`, 'fixture-embedding', 'embedding-secret', 3, 1_000, `http://127.0.0.1:${port}/health`);
    await expect(provider.health?.()).resolves.toMatchObject({ ready: true, detail: 'provider health endpoint reachable' });
    expect(methods).toEqual(['GET']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
