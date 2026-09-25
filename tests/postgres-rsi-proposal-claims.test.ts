import { describe, expect, it, vi } from 'vitest';
import { isolatedPostgres } from './support/postgres.js';
import { PostgresRsiProposalClaimStore } from '../src/rsi-proposal-claims.js';
import { PostgresRunRepository } from '../src/runtime/repository.js';
import { PostgresEvolutionRepository, RsiService } from '../src/rsi.js';
import { RsiProposalPump } from '../src/rsi-proposal-pump.js';
import { runWithSignals } from './support/rsi-proposal.js';
import { DurableRsiProposalSynthesis, HttpRsiProposalSynthesizer } from '../src/rsi-proposal-synthesizer.js';
import type { ModelAdapter, ModelResponse } from '../src/runtime/model.js';
import type { ModelResolver } from '../src/runtime/model-router.js';

class PostgresSynthModel implements ModelAdapter {
  readonly pin = { model: 'synth', endpoint: 'https://synth.example/v1/chat/completions', promptVersion: 'synth/1' };
  calls = 0;
  async complete(_request: { idempotencyKey?: string; input: unknown }): Promise<ModelResponse> { this.calls += 1; return { value: { proposal: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Use observed evidence first', reason: 'The failed run needs a bounded recovery rule', risk: 'low', sourceReceiptRefs: ['evt_failed'] } }, usage: { inputTokens: 2, outputTokens: 3 } }; }
}
class PostgresSynthResolver implements ModelResolver {
  constructor(private readonly model: PostgresSynthModel) {}
  async resolve(): Promise<{ adapter: ModelAdapter }> { return { adapter: this.model }; }
  forPin(): ModelAdapter { return this.model; }
}

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('PostgreSQL RSI proposal claims', () => {
  it.skipIf(!databaseUrl)('admits one concurrent worker, survives restart, and expires leases', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresRsiProposalClaimStore(db.url);
    const second = new PostgresRsiProposalClaimStore(db.url);
    const scope = { owner: 'alice', tenantId: 'team-a' };
    try {
      await Promise.all([first.init(), second.init()]);
      const [a, b] = await Promise.all([
        first.claim('signal-1', scope, 1_000),
        second.claim('signal-1', scope, 1_000),
      ]);
      expect(Number(a.claimed) + Number(b.claimed)).toBe(1);
      const winner = a.claimed ? a : b;
      if (!winner.claimed) throw new Error('Expected winning claim');
      await first.close();
      const restarted = new PostgresRsiProposalClaimStore(db.url);
      await restarted.init();
      try {
        expect((await restarted.claim('signal-1', scope, 1_000)).claimed).toBe(false);
        await new Promise(resolve => setTimeout(resolve, 1_050));
        const replacement = await restarted.claim('signal-1', scope, 1_000);
        expect(replacement.claimed).toBe(true);
        if (!replacement.claimed) throw new Error('Expected replacement claim');
        await restarted.release('signal-1', scope, winner.token);
        expect((await restarted.claim('signal-1', scope, 1_000)).claimed).toBe(false);
        await restarted.release('signal-1', scope, replacement.token);
        expect((await restarted.claim('signal-1', scope, 1_000)).claimed).toBe(true);
      } finally { await restarted.close(); }
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await db.close();
    }
  });

  it.skipIf(!databaseUrl)('replays the candidate/event crash window after restart through concurrent pumps', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const runs = new PostgresRunRepository(db.url);
    const candidates = new PostgresEvolutionRepository(db.url);
    const claims = new PostgresRsiProposalClaimStore(db.url);
    const scope = { owner: 'alice', tenantId: 'team-a' };
    try {
      await Promise.all([runs.init(), candidates.init(), claims.init()]);
      const run = runWithSignals();
      run.events = run.events.filter(item => item.id === 'evt_proposal');
      await runs.create(run);
      const mutate = runs.mutate.bind(runs);
      const failure = vi.spyOn(runs, 'mutate').mockImplementation(async (id, change, ownership) => {
        const draft = await runs.get(id, ownership);
        change(draft);
        if (draft.events.some(event => event.type === 'rsi.proposal.created')) throw new Error('write-back interrupted');
        return mutate(id, change, ownership);
      });
      const result = await new RsiProposalPump(runs, new RsiService(candidates), { claimStore: claims }).pump();
      expect(result.failed).toBe(1);
      expect(await candidates.list(scope)).toHaveLength(1);
      expect((await runs.get(run.id)).events.some(event => event.type === 'rsi.proposal.created')).toBe(false);
      failure.mockRestore();
      await Promise.all([runs.close(), candidates.close(), claims.close()]);

      const workers = [0, 1].map(() => ({ runs: new PostgresRunRepository(db.url), candidates: new PostgresEvolutionRepository(db.url), claims: new PostgresRsiProposalClaimStore(db.url) }));
      try {
        await Promise.all(workers.flatMap(worker => [worker.runs.init(), worker.candidates.init(), worker.claims.init()]));
        const results = await Promise.all(workers.map(worker => new RsiProposalPump(worker.runs, new RsiService(worker.candidates), { claimStore: worker.claims }).pump()));
        expect(results.reduce((sum, item) => sum + item.failed, 0)).toBe(0);
        expect(results.reduce((sum, item) => sum + item.proposed, 0)).toBe(1);
        const worker = workers[0]!;
        expect(await worker.candidates.list(scope)).toHaveLength(1);
        expect(await worker.candidates.list({ ...scope, tenantId: 'team-b' })).toEqual([]);
        const recovered = await worker.runs.get(run.id, scope);
        expect(recovered.events.filter(event => event.type === 'rsi.proposal.created')).toHaveLength(1);
        expect(recovered.events.filter(event => event.type === 'rsi.improvement.detected')).toHaveLength(1);
      } finally { await Promise.all(workers.flatMap(worker => [worker.runs.close(), worker.candidates.close(), worker.claims.close()])); }
    } finally {
      await Promise.allSettled([runs.close(), candidates.close(), claims.close()]);
      await db.close();
    }
  });

  it.skipIf(!databaseUrl)('persists synthesized proposal attempts and candidates across process restart', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const runs = new PostgresRunRepository(db.url);
    const candidates = new PostgresEvolutionRepository(db.url);
    const claims = new PostgresRsiProposalClaimStore(db.url);
    const model = new PostgresSynthModel();
    try {
      await Promise.all([runs.init(), candidates.init(), claims.init()]);
      const run = runWithSignals();
      run.status = 'failed';
      run.events = [{ id: 'evt_failed', seq: 1, type: 'run.failed', at: new Date().toISOString(), data: { reason: 'timeout' } }];
      await runs.create(run);
      const synthesis = new DurableRsiProposalSynthesis(runs, new HttpRsiProposalSynthesizer(new PostgresSynthResolver(model)));
      const pump = new RsiProposalPump(runs, new RsiService(candidates), { claimStore: claims, synthesis });
      const otherRuns = new PostgresRunRepository(db.url); await otherRuns.init();
      try {
        const otherPump = new RsiProposalPump(otherRuns, new RsiService(candidates), { synthesis: new DurableRsiProposalSynthesis(otherRuns, new HttpRsiProposalSynthesizer(new PostgresSynthResolver(model))) });
        // Deliberately omit the lease on the second worker: durable Run
        // reservation alone must prevent a second billable model invocation.
        await Promise.all([pump.pump(), otherPump.pump()]);
        expect(await candidates.list({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(1);
        expect(model.calls).toBe(1);
      } finally { await otherRuns.close(); }
      await Promise.all([runs.close(), candidates.close(), claims.close()]);
      const restartedRuns = new PostgresRunRepository(db.url);
      const restartedCandidates = new PostgresEvolutionRepository(db.url);
      const restartedClaims = new PostgresRsiProposalClaimStore(db.url);
      await Promise.all([restartedRuns.init(), restartedCandidates.init(), restartedClaims.init()]);
      try {
        const restarted = new RsiProposalPump(restartedRuns, new RsiService(restartedCandidates), { claimStore: restartedClaims, synthesis: new DurableRsiProposalSynthesis(restartedRuns, new HttpRsiProposalSynthesizer(new PostgresSynthResolver(model))) });
        expect((await restarted.pump()).proposed).toBe(0);
        expect(model.calls).toBe(1);
        expect(await restartedCandidates.list({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(1);
        expect((await restartedRuns.get(run.id, { owner: 'alice', tenantId: 'team-a' })).events.filter(event => event.type === 'rsi.proposal.synthesis.started')).toHaveLength(1);
      } finally { await Promise.all([restartedRuns.close(), restartedCandidates.close(), restartedClaims.close()]); }
    } finally { await Promise.allSettled([runs.close(), candidates.close(), claims.close()]); await db.close(); }
  });
});
