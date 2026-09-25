import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRsiProposalClaimStore } from '../src/rsi-proposal-claims.js';

describe('File RSI proposal leases', () => {
  it('preserves claims across restart, expires them and rejects a stale release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aeeis-claims-'));
    const path = join(dir, 'claims.json');
    const scope = { owner: 'alice', tenantId: 'team' };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      const first = new FileRsiProposalClaimStore(path);
      await first.init();
      const lease = await first.claim('signal', scope, 1000);
      expect(lease.claimed).toBe(true);
      if (!lease.claimed) throw new Error('Expected claim');
      await first.close();
      const next = new FileRsiProposalClaimStore(path);
      await next.init();
      expect((await next.claim('signal', scope, 1000)).claimed).toBe(false);
      expect((await next.claim('signal', { ...scope, tenantId: 'other' }, 1000)).claimed).toBe(true);
      clock.mockReturnValue(11_000);
      const replacement = await next.claim('signal', scope, 1000);
      expect(replacement.claimed).toBe(true);
      if (!replacement.claimed) throw new Error('Expected replacement claim');
      await next.release('signal', scope, lease.token);
      expect((await next.claim('signal', scope, 1000)).claimed).toBe(false);
      await next.release('signal', scope, replacement.token);
      expect((await next.claim('signal', scope, 1000)).claimed).toBe(true);
      await next.close();
    } finally { clock.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });

  it('does not publish a failed file write in memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aeeis-claims-failed-'));
    const store = new FileRsiProposalClaimStore(join(dir, 'claims.json'));
    const scope = { owner: 'alice', tenantId: 'team' };
    try {
      await store.init();
      const save = vi.spyOn(store as unknown as { save: (...args: unknown[]) => Promise<void> }, 'save').mockRejectedValueOnce(new Error('disk full'));
      await expect(store.claim('signal', scope, 1000)).rejects.toThrow('disk full');
      save.mockRestore();
      expect((await store.claim('signal', scope, 1000)).claimed).toBe(true);
    } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
