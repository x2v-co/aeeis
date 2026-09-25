import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { PostgresBrainSemanticIndex } from '../src/adapters/postgres-brain-semantic-index.js';

afterEach(() => vi.restoreAllMocks());

describe('Brain semantic dependency health', () => {
  it('uses only a bounded table read and a provider probe, including outage and recovery', async () => {
    const query = vi.spyOn(pg.Pool.prototype, 'query').mockResolvedValue({ rows: [] } as never);
    let ready = false;
    const embed = vi.fn(async () => [1, 0, 0]);
    const health = vi.fn(async () => ({ ready, detail: ready ? 'provider available' : 'provider unavailable' }));
    const index = new PostgresBrainSemanticIndex('postgresql://unused.invalid/test', { model: 'embed/1', dimensions: 3, embed, health });
    try {
      expect(await index.health()).toMatchObject({ ready: false, detail: expect.stringContaining('provider unavailable') });
      ready = true;
      expect(await index.health()).toMatchObject({ ready: true });
      expect(query.mock.calls).toEqual(Array(2).fill(['SELECT 1 FROM aeeis_brain_embeddings LIMIT 1']));
      expect(health).toHaveBeenCalledTimes(2);
      expect(embed).not.toHaveBeenCalled();
    } finally { await index.close(); }
  });

  it('reports unavailable for an absent provider probe or a failed table read without leaking errors', async () => {
    const query = vi.spyOn(pg.Pool.prototype, 'query').mockResolvedValue({ rows: [] } as never);
    const embed = vi.fn(async () => [1, 0, 0]);
    const index = new PostgresBrainSemanticIndex('postgresql://unused.invalid/test', { model: 'embed/1', dimensions: 3, embed });
    try {
      expect(await index.health()).toMatchObject({ ready: false, detail: expect.stringContaining('probe unavailable') });
      query.mockRejectedValueOnce(new Error('sensitive database error'));
      expect(await index.health()).toMatchObject({ ready: false, detail: 'Brain semantic index dependency probe failed' });
      expect(embed).not.toHaveBeenCalled();
    } finally { await index.close(); }
  });
});
