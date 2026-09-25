import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRunRepository } from '../src/runtime/repository.js';
import { FileEvolutionRepository, RsiService } from '../src/rsi.js';
import { RsiProposalPump } from '../src/rsi-proposal-pump.js';
import { InMemoryRsiProposalClaimStore } from '../src/rsi-proposal-claims.js';
import { runWithSignals } from './support/rsi-proposal.js';

describe('RSI proposal pump', () => {
  it('only creates a deterministic candidate for a complete evidence-backed proposal and replays idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-rsi-pump-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const evolution = new FileEvolutionRepository(join(directory, 'evolution')); await evolution.init();
    try {
      await runs.create(runWithSignals());
      const pump = new RsiProposalPump(runs, new RsiService(evolution));
      expect((await pump.pump()).proposed).toBe(1);
      expect((await pump.pump()).proposed).toBe(0);
      const candidates = await evolution.list({ owner: 'alice', tenantId: 'team-a' });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ proposalSignalId: 'rsi-signal:run_00000000-0000-4000-8000-000000000011:evt_proposal', status: 'proposed', sourceReceiptRefs: ['artifact_1'] });
      const run = await runs.get('run_00000000-0000-4000-8000-000000000011', { owner: 'alice', tenantId: 'team-a' });
      expect(run.events.filter(event => event.type === 'rsi.proposal.created')).toHaveLength(1);
      expect(run.events.filter(event => event.type === 'rsi.improvement.detected')).toHaveLength(2);
    } finally { await evolution.close(); await runs.close(); }
  });

  it('does not turn a failure or low-confidence signal without a concrete change into a candidate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-rsi-pump-skip-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const evolution = new FileEvolutionRepository(join(directory, 'evolution')); await evolution.init();
    try {
      const run = runWithSignals(); run.events = [{ id: 'evt_failed', seq: 1, type: 'run.failed', at: new Date().toISOString(), data: { reason: 'provider timeout' } }];
      await runs.create(run);
      const result = await new RsiProposalPump(runs, new RsiService(evolution)).pump();
      expect(result.signalled).toBe(1); expect(result.skipped).toBe(1); expect(await evolution.list({ owner: 'alice', tenantId: 'team-a' })).toEqual([]);
      expect((await runs.get(run.id)).events.some(event => event.type === 'rsi.improvement.detected')).toBe(true);
    } finally { await evolution.close(); await runs.close(); }
  });

  it('claims a signal across concurrent pumps and reclaims it after lease expiry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-rsi-pump-claim-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const evolution = new FileEvolutionRepository(join(directory, 'evolution')); await evolution.init();
    const claims = new InMemoryRsiProposalClaimStore();
    try {
      const run = runWithSignals();
      await runs.create(run);
      const first = new RsiProposalPump(runs, new RsiService(evolution), { claimStore: claims, claimLeaseMs: 1_000 });
      const second = new RsiProposalPump(runs, new RsiService(evolution), { claimStore: claims, claimLeaseMs: 1_000 });
      const [a, b] = await Promise.all([first.pump(), second.pump()]);
      expect(a.proposed + b.proposed).toBe(1);
      expect(await evolution.list({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(1);
      const signalId = 'rsi-signal:run_00000000-0000-4000-8000-000000000011:evt_proposal';
      const held = await claims.claim(signalId, { owner: 'alice', tenantId: 'team-a' }, 1_000);
      expect(held.claimed).toBe(true);
      const blocked = await claims.claim(signalId, { owner: 'alice', tenantId: 'team-a' }, 1_000);
      expect(blocked.claimed).toBe(false);
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_010);
      try { expect((await claims.claim(signalId, { owner: 'alice', tenantId: 'team-a' }, 1_000)).claimed).toBe(true); }
      finally { now.mockRestore(); }
    } finally { await evolution.close(); await runs.close(); }
  });
});
