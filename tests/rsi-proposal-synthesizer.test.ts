import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRunRepository } from '../src/runtime/repository.js';
import { FileEvolutionRepository, RsiService } from '../src/rsi.js';
import { RsiProposalPump } from '../src/rsi-proposal-pump.js';
import { DurableRsiProposalSynthesis, HttpRsiProposalSynthesizer, synthesisAttempts } from '../src/rsi-proposal-synthesizer.js';
import { HttpModelAdapter, ModelOutcomeUnknown } from '../src/runtime/model.js';
import { StaticModelResolver } from '../src/runtime/model-router.js';
import { createFixtureModelServer } from '../scripts/fixture-model.mjs';
import { FileGlobalBudgetLedger, createGlobalBudgetSelector } from '../src/global-budget.js';
import { buildApp } from '../src/runtime/http.js';
import type { ModelAdapter, ModelResponse } from '../src/runtime/model.js';
import type { ModelResolver } from '../src/runtime/model-router.js';
import { runWithSignals } from './support/rsi-proposal.js';

class FakeModel implements ModelAdapter {
  readonly pin = { model: 'synth', endpoint: 'https://synth.example/v1/chat/completions', promptVersion: 'synth/1' };
  calls: Array<{ key?: string; input: unknown }> = [];
  constructor(private readonly response: ModelResponse | Error) {}
  async complete(request: { idempotencyKey?: string; input: unknown }): Promise<ModelResponse> { this.calls.push({ key: request.idempotencyKey, input: request.input }); if (this.response instanceof Error) throw this.response; return this.response; }
}
class FakeResolver implements ModelResolver {
  constructor(readonly model: FakeModel) {}
  async resolve(): Promise<{ adapter: ModelAdapter }> { return { adapter: this.model }; }
  forPin(): ModelAdapter { return this.model; }
}

function failedRun() {
  const run = runWithSignals();
  run.status = 'failed';
  run.events = [{ id: 'evt_failed', seq: 1, type: 'run.failed', at: new Date().toISOString(), data: { reason: 'provider timeout' } }];
  return run;
}

describe('durable RSI proposal synthesis', () => {
  it('uses the real HTTP fixture transport to publish one governed candidate and record usage', async () => {
    const server = createFixtureModelServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-synth-http-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const evolution = new FileEvolutionRepository(join(directory, 'evolution')); await evolution.init();
    try {
      const model = new HttpModelAdapter(`http://127.0.0.1:${port}/v1`, 'aeeis-fixture/1', '');
      const synthesis = new DurableRsiProposalSynthesis(runs, new HttpRsiProposalSynthesizer(new StaticModelResolver(model)));
      const run = failedRun(); await runs.create(run);
      const pump = new RsiProposalPump(runs, new RsiService(evolution), { synthesis });
      expect((await pump.pump()).proposed).toBe(1);
      expect((await pump.pump()).proposed).toBe(0);
      expect(synthesisAttempts(await runs.get(run.id))).toMatchObject([{ state: 'completed', settled: true, usage: { inputTokens: 1, outputTokens: 1, tokens: 2 } }]);
      expect(await evolution.list({ owner: 'alice', tenantId: 'team-a' })).toMatchObject([{ status: 'proposed', target: 'prompt', sourceReceiptRefs: ['source_1'] }]);
    } finally {
      await runs.close(); await evolution.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('keeps synthesized versions distinct when the active prompt has a semantic suffix', async () => {
    const server = createFixtureModelServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const model = new HttpModelAdapter(`http://127.0.0.1:${port}/v1`, 'aeeis-fixture/1', '');
      const response = await model.complete({
        system: 'You are the governed AEEIS RSI proposal synthesizer.',
        input: { targetVersions: { prompt: 'prompt/compose-smoke-1790061635683' }, evidence: [{ id: 'evt_failed' }] },
      });
      expect(response.value).toMatchObject({ proposal: {
        baseVersion: 'prompt/compose-smoke-1790061635683',
        proposedVersion: 'prompt/compose-smoke-1790061635683-next',
      } });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('refuses private evidence before resolving or calling a model', async () => {
    const run = failedRun(); run.privacy = 'private';
    const model = new FakeModel({ value: { proposal: null } });
    const resolver = new FakeResolver(model);
    const resolve = vi.spyOn(resolver, 'resolve');
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-synth-privacy-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const evolution = new FileEvolutionRepository(join(directory, 'evolution')); await evolution.init();
    try {
      await runs.create(run);
      const pump = new RsiProposalPump(runs, new RsiService(evolution), { synthesis: new DurableRsiProposalSynthesis(runs, new HttpRsiProposalSynthesizer(resolver)) });
      expect((await pump.pump()).failed).toBe(1);
      expect(resolve).not.toHaveBeenCalled(); expect(model.calls).toHaveLength(0);
      expect(synthesisAttempts(await runs.get(run.id))).toEqual([]);
      expect(await evolution.list()).toEqual([]);
    } finally { await runs.close(); await evolution.close(); }
  });

  it('keeps an unknown attempt blocked across a repository restart until audited reconciliation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-synth-restart-'));
    let runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const evolution = new FileEvolutionRepository(join(directory, 'evolution')); await evolution.init();
    const model = new FakeModel(new ModelOutcomeUnknown('connection lost'));
    try {
      const run = failedRun(); await runs.create(run);
      const makeSynthesis = () => new DurableRsiProposalSynthesis(runs, new HttpRsiProposalSynthesizer(new FakeResolver(model)));
      await new RsiProposalPump(runs, new RsiService(evolution), { synthesis: makeSynthesis() }).pump();
      await runs.close();
      runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
      const synthesis = makeSynthesis();
      const pump = new RsiProposalPump(runs, new RsiService(evolution), { synthesis });
      await pump.pump();
      const attempt = synthesisAttempts(await runs.get(run.id))[0]!;
      expect(attempt.state).toBe('unknown'); expect(model.calls).toHaveLength(1);
      await synthesis.reconcile(run.id, { attemptId: attempt.id, inputHash: attempt.inputHash, idempotencyKey: attempt.idempotencyKey, outcome: 'completed', output: { proposal: null }, usage: { inputTokens: 3, outputTokens: 2 }, reconciliation: { source: 'provider', reference: 'restart-audit', reason: 'Provider confirmed final response' } }, { owner: 'alice', tenantId: 'team-a' });
      await pump.pump();
      const restored = await runs.get(run.id);
      expect(synthesisAttempts(restored)[0]).toMatchObject({ state: 'completed', settled: true, usage: { tokens: 5 } });
      expect(restored.events.filter(item => item.type === 'rsi.proposal.synthesis.result')[0]!.data.result).toMatchObject({ state: 'unknown' });
      expect(model.calls).toHaveLength(1); expect(await evolution.list()).toEqual([]);
    } finally { await runs.close(); await evolution.close(); }
  });

  it('creates an evidence-bound candidate from a concrete synthesized change', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-rsi-synth-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const evolution = new FileEvolutionRepository(join(directory, 'evolution')); await evolution.init();
    const model = new FakeModel({ value: { proposal: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Require evidence before synthesis', reason: 'The run failed without a recoverable evidence-bound output', risk: 'low', sourceReceiptRefs: ['evt_failed'] } }, usage: { inputTokens: 5, outputTokens: 7 } });
    const synth = new DurableRsiProposalSynthesis(runs, new HttpRsiProposalSynthesizer(new FakeResolver(model)));
    try {
      await runs.create(failedRun());
      const pump = new RsiProposalPump(runs, new RsiService(evolution), { synthesis: synth });
      expect((await pump.pump()).proposed).toBe(1);
      expect(model.calls).toHaveLength(1);
      expect(await evolution.list({ owner: 'alice', tenantId: 'team-a' })).toMatchObject([{ status: 'proposed', proposalSignalId: expect.stringContaining('evt_failed') }]);
      const run = await runs.get('run_00000000-0000-4000-8000-000000000011', { owner: 'alice', tenantId: 'team-a' });
      expect(run.events.filter(item => item.type === 'rsi.proposal.synthesis.started')).toHaveLength(1);
      expect(run.events.filter(item => item.type === 'rsi.proposal.synthesis.result')).toHaveLength(1);
      expect(run.events.filter(item => item.type === 'rsi.proposal.synthesis.settled')).toHaveLength(1);
      expect((await pump.pump()).proposed).toBe(0);
      expect(model.calls).toHaveLength(1);
    } finally { await evolution.close(); await runs.close(); }
  });

  it('records null as a terminal abstention and does not keep spending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-rsi-synth-null-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const evolution = new FileEvolutionRepository(join(directory, 'evolution')); await evolution.init();
    const model = new FakeModel({ value: { proposal: null }, usage: { inputTokens: 2, outputTokens: 1 } });
    try {
      await runs.create(failedRun());
      const pump = new RsiProposalPump(runs, new RsiService(evolution), { synthesis: new DurableRsiProposalSynthesis(runs, new HttpRsiProposalSynthesizer(new FakeResolver(model))) });
      await pump.pump(); await pump.pump();
      expect(model.calls).toHaveLength(1);
      expect(await evolution.list({ owner: 'alice', tenantId: 'team-a' })).toEqual([]);
    } finally { await evolution.close(); await runs.close(); }
  });

  it('holds an unknown provider outcome until explicit reconciliation with the same binding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-rsi-synth-unknown-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const evolution = new FileEvolutionRepository(join(directory, 'evolution')); await evolution.init();
    const model = new FakeModel(new ModelOutcomeUnknown('transport')); 
    try {
      const run = failedRun(); await runs.create(run);
      const synthesis = new DurableRsiProposalSynthesis(runs, new HttpRsiProposalSynthesizer(new FakeResolver(model)));
      const pump = new RsiProposalPump(runs, new RsiService(evolution), { synthesis });
      await pump.pump();
      expect(model.calls).toHaveLength(1);
      expect((await pump.pump()).proposed).toBe(0);
      const held = await runs.get(run.id, { owner: 'alice', tenantId: 'team-a' });
      const attempt = held.events.find(item => item.type === 'rsi.proposal.synthesis.started')!.data.attempt as { id: string; inputHash: string; idempotencyKey: string };
      await synthesis.reconcile(run.id, { attemptId: attempt.id, inputHash: attempt.inputHash, idempotencyKey: attempt.idempotencyKey, outcome: 'completed', output: { proposal: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/3', change: 'Add a validation step', reason: 'The failure was recoverable after provider inspection', risk: 'low', sourceReceiptRefs: ['evt_failed'] } }, usage: { inputTokens: 3, outputTokens: 4 }, reconciliation: { source: 'operator', reference: 'audit-1', reason: 'Provider logs confirmed the response' } }, { owner: 'alice', tenantId: 'team-a' });
      expect((await pump.pump()).proposed).toBe(1);
      expect(model.calls).toHaveLength(1);
      expect(await evolution.list({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(1);
    } finally { await evolution.close(); await runs.close(); }
  });
  it.each([
    ['invented evidence', { proposal: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Change', reason: 'Reason', risk: 'low', sourceReceiptRefs: ['foreign'] } }, { inputTokens: 1, outputTokens: 1 }, 10],
    ['bad version', { proposal: { target: 'prompt', baseVersion: 'prompt/99', proposedVersion: 'prompt/2', change: 'Change', reason: 'Reason', risk: 'low', sourceReceiptRefs: ['evt_failed'] } }, { inputTokens: 1, outputTokens: 1 }, 10],
    ['overspend', { proposal: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Change', reason: 'Reason', risk: 'low', sourceReceiptRefs: ['evt_failed'] } }, { inputTokens: 10, outputTokens: 10 }, 10],
    ['missing usage', { proposal: null }, undefined, 10],
  ])('withholds %s and never retries a consumed attempt', async (_label, value, usage, limit) => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-synth-invalid-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const evolution = new FileEvolutionRepository(join(directory, 'evolution')); await evolution.init();
    const model = new FakeModel({ value, ...(usage ? { usage } : {}) });
    try {
      const run = failedRun(); await runs.create(run);
      const synthesis = new DurableRsiProposalSynthesis(runs, new HttpRsiProposalSynthesizer(new FakeResolver(model)), { maxTokensPerRun: limit as number });
      const pump = new RsiProposalPump(runs, new RsiService(evolution), { synthesis });
      await pump.pump(); await pump.pump();
      expect(model.calls).toHaveLength(1);
      expect(await evolution.list()).toEqual([]);
      const attempt = synthesisAttempts(await runs.get(run.id))[0]!;
      expect(attempt.error ?? attempt.settlementError).toBeTruthy();
      expect(attempt.settled).toBe(true);
    } finally { await runs.close(); await evolution.close(); }
  });

  it('settles shared USD/token budgets and blocks overshoot, including replay after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-synth-ledger-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const evolution = new FileEvolutionRepository(join(directory, 'evolution')); await evolution.init();
    const ledger = new FileGlobalBudgetLedger(join(directory, 'budget.json')); await ledger.init();
    const select = createGlobalBudgetSelector([{ tenantId: 'team-a', window: 'none', budget: { calls: 10, tokens: 5, moneyUsd: 1 } }]);
    const model = new FakeModel({ value: { proposal: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Cite evidence', reason: 'Reason', risk: 'low', sourceReceiptRefs: ['evt_failed'] } }, usage: { inputTokens: 4, outputTokens: 4 } });
    try {
      const run = failedRun(); await runs.create(run);
      const makeSynthesis = () => new DurableRsiProposalSynthesis(runs, new HttpRsiProposalSynthesizer(new FakeResolver(model), ['internal'], { currency: 'USD', inputPricePerMillion: 1, outputPricePerMillion: 2 }), { globalBudget: { ledger, select } });
      await new RsiProposalPump(runs, new RsiService(evolution), { synthesis: makeSynthesis() }).pump();
      await new RsiProposalPump(runs, new RsiService(evolution), { synthesis: makeSynthesis() }).pump();
      const attempt = synthesisAttempts(await runs.get(run.id))[0]!;
      expect(attempt.settled).toBe(true); expect(attempt.settlementError).toMatch(/Global/);
      const account = await ledger.get(attempt.globalSelection!.accountKey);
      expect(account).toMatchObject({ usedCalls: 1, usedTokens: 8, usedMoneyUsd: 0.000012 });
      expect(account!.entries[attempt.idempotencyKey]!.state).toBe('rejected');
      expect(await evolution.list()).toEqual([]); expect(model.calls).toHaveLength(1);
    } finally { await runs.close(); await evolution.close(); await ledger.close(); }
  });

  it('exposes owner-only reconciliation and preserves its result against a late response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-synth-late-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const evolution = new FileEvolutionRepository(join(directory, 'evolution')); await evolution.init();
    const model = new FakeModel({ value: { proposal: null } });
    let finish!: (response: ModelResponse) => void;
    let entered!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    const complete = vi.spyOn(model, 'complete').mockImplementation(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
    const synthesis = new DurableRsiProposalSynthesis(runs, new HttpRsiProposalSynthesizer(new FakeResolver(model)));
    const app = buildApp({ repository: runs, rsiProposalSynthesis: synthesis, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'alice', tenantId: 'other', roles: ['owner'] } } });
    try {
      const run = failedRun(); await runs.create(run);
      const pump = new RsiProposalPump(runs, new RsiService(evolution), { synthesis });
      const pending = pump.pump(); await called;
      const attempt = synthesisAttempts(await runs.get(run.id))[0]!;
      const body = { attemptId: attempt.id, inputHash: attempt.inputHash, idempotencyKey: attempt.idempotencyKey, outcome: 'completed', output: { proposal: null }, usage: { inputTokens: 2, outputTokens: 3 }, reconciliation: { source: 'provider', reference: 'receipt-123', reason: 'Provider confirmed abstention' } };
      const inject = (token: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/runs/${run.id}/rsi-proposal-synthesis-reconcile`, headers: { authorization: `Bearer ${token}` }, payload });
      expect((await inject('bob', body)).statusCode).toBe(404);
      expect((await inject('alice', { ...body, inputHash: '0'.repeat(64) })).statusCode).toBe(409);
      expect((await inject('alice', body)).statusCode).toBe(200);
      finish({ value: { proposal: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'late', reason: 'late', risk: 'low', sourceReceiptRefs: ['evt_failed'] } }, usage: { inputTokens: 100, outputTokens: 100 } });
      await pending;
      expect(complete).toHaveBeenCalledTimes(1);
      expect(synthesisAttempts(await runs.get(run.id))[0]).toMatchObject({ state: 'completed', usage: { tokens: 5 } });
      expect(await evolution.list()).toEqual([]);
    } finally { complete.mockRestore(); await app.close(); await runs.close(); await evolution.close(); }
  });

  it('waits for durable budget settlement before admitting another signal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-synth-settlement-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const evolution = new FileEvolutionRepository(join(directory, 'evolution')); await evolution.init();
    const ledger = new FileGlobalBudgetLedger(join(directory, 'budget.json')); await ledger.init();
    const select = createGlobalBudgetSelector([{ tenantId: 'team-a', window: 'none', budget: { calls: 5, tokens: 100 } }]);
    const model = new FakeModel({ value: { proposal: null }, usage: { inputTokens: 1, outputTokens: 1 } });
    const settle = vi.spyOn(ledger, 'settle').mockRejectedValueOnce(new Error('storage temporarily unavailable'));
    try {
      const run = failedRun();
      run.events.push({ ...run.events[0]!, id: 'evt_failed_again', seq: 2 });
      await runs.create(run);
      const synthesis = new DurableRsiProposalSynthesis(runs, new HttpRsiProposalSynthesizer(new FakeResolver(model)), { maxCallsPerRun: 2, globalBudget: { ledger, select } });
      const pump = new RsiProposalPump(runs, new RsiService(evolution), { synthesis });
      expect((await pump.pump()).failed).toBe(1);
      expect(model.calls).toHaveLength(1);
      const pending = synthesisAttempts(await runs.get(run.id));
      expect(pending).toHaveLength(1); expect(pending[0]!.settled).not.toBe(true);
      await pump.pump();
      expect(model.calls).toHaveLength(2);
      expect(synthesisAttempts(await runs.get(run.id)).every(item => item.settled)).toBe(true);
      expect((await ledger.get(pending[0]!.globalSelection!.accountKey))?.usedCalls).toBe(2);
    } finally { settle.mockRestore(); await ledger.close(); await runs.close(); await evolution.close(); }
  });

});
