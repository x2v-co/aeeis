import { describe, expect, it } from 'vitest';
import { InMemoryKnowledgeProvider, makeKnowledgeRecord } from '../src/knowledge.js';

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
