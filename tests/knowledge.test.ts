import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileKnowledgeProvider, InMemoryKnowledgeProvider, makeKnowledgeRecord, validateKnowledgeHits } from '../src/knowledge.js';

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
  });
});

it('loads and validates a file-backed knowledge index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-knowledge-file-'));
  const record = makeKnowledgeRecord({ id: 'knowledge.file', title: 'Durable execution', content: 'Use checkpoints', source: 'local-file', classification: 'internal', tags: ['runtime'], updatedAt: '2026-09-18T00:00:00.000Z' });
  const provider = new FileKnowledgeProvider(join(directory, 'records.json'));
  await writeFile(join(directory, 'records.json'), JSON.stringify([record]));
  const hits = await provider.search({ query: 'checkpoints', maxItems: 3, allowedClassifications: ['public', 'internal'], audience: 'owner' });
  expect(hits[0]?.record.id).toBe('knowledge.file');
});

it('rejects provider results outside the requested classification or with a bad content hash', () => {
  const record = makeKnowledgeRecord({ id: 'knowledge.boundary', title: 'Boundary', content: 'Safe', source: 'fixture', classification: 'internal', tags: [], updatedAt: '2026-09-18T00:00:00.000Z' });
  const request = { query: 'safe', maxItems: 2, allowedClassifications: ['public'] as const, audience: 'owner' };
  expect(() => validateKnowledgeHits(request, [{ record, score: 1, matchedTerms: ['safe'] }])).toThrow('classification');
  expect(() => validateKnowledgeHits({ ...request, allowedClassifications: ['internal'] }, [{ record: { ...record, contentHash: 'a'.repeat(64) }, score: 1, matchedTerms: ['safe'] }])).toThrow('hash');
});
