import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { FileEvolutionActivationStore } from '../src/evolution-activation.js';
import { FileEvolutionRepository, RsiService } from '../src/rsi.js';
import { RsiAutomationPump } from '../src/rsi-automation.js';

describe('RSI internal-test automation', () => {
  it('runs a fixed suite through evaluation, rollout and promotion', async () => {
    const dir = await mkdtemp(`${tmpdir()}/aeeis-rsi-auto-`);
    const repository = new FileEvolutionRepository(`${dir}/candidates`);
    const activation = new FileEvolutionActivationStore(`${dir}/activation`);
    await repository.init(); await activation.init();
    try {
      const rsi = new RsiService(repository, activation);
      const candidate = await rsi.propose({ target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/auto-1', change: 'Use evidence citations', sourceReceiptRefs: ['receipt.test'], reason: 'Internal test', risk: 'low' }, { owner: 'owner', tenantId: 'local' });
      const pump = new RsiAutomationPump(rsi, { evaluate: async (_candidate, mode, testCase) => ({ passed: true, score: 1, evidenceRefs: [`fixed:${mode}:${testCase.id}`] }) }, {
        enabled: true, autoApproveLowRisk: true, autoRollout: true, autoActivate: false, intervalMs: 30_000, maxCandidatesPerPass: 10, suiteVersion: 'test-v1',
        suite: { replay: [{ id: 'r', input: {} }], holdout: [{ id: 'h', input: {} }], safety: [{ id: 's', input: {} }], shadow: [{ id: 'x', input: {} }] },
      });
      const result = await pump.pump();
      expect(result).toMatchObject({ inspected: 1, evaluated: 1, approved: 1, shadowed: 1, canaried: 1, promoted: 1, activated: 0, failed: 0 });
      expect((await rsi.get(candidate.id)).status).toBe('promoted');
    } finally { await repository.close(); await activation.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('skips a promoted candidate whose base version is stale', async () => {
    const dir = await mkdtemp(`${tmpdir()}/aeeis-rsi-auto-stale-`);
    const repository = new FileEvolutionRepository(`${dir}/candidates`);
    const activation = new FileEvolutionActivationStore(`${dir}/activation`);
    await repository.init(); await activation.init();
    const suite = { replay: [{ id: 'r', input: {} }], holdout: [{ id: 'h', input: {} }], safety: [{ id: 's', input: {} }] };
    const harness = { evaluate: async (_candidate: unknown, mode: string, testCase: { id: string }) => ({ passed: true, score: 1, evidenceRefs: [`fixed:${mode}:${testCase.id}`] }) };
    try {
      const rsi = new RsiService(repository, activation);
      const base = await rsi.propose({ target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/active-1', change: 'Base', sourceReceiptRefs: ['receipt.base'], reason: 'Base', risk: 'low' }, { owner: 'owner', tenantId: 'local' });
      await rsi.evaluateSuite(base.id, { suite }, harness);
      await rsi.approve(base.id, 'base-approval'); await rsi.promote(base.id); await rsi.activate(base.id, 'base-activation');
      const stale = await rsi.propose({ target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/stale-1', change: 'Stale', sourceReceiptRefs: ['receipt.stale'], reason: 'Stale', risk: 'low' }, { owner: 'owner', tenantId: 'local' });
      await rsi.evaluateSuite(stale.id, { suite }, harness); await rsi.approve(stale.id, 'stale-approval'); await rsi.promote(stale.id);
      const pump = new RsiAutomationPump(rsi, harness, {
        enabled: true, autoApproveLowRisk: true, autoRollout: true, autoActivate: true, intervalMs: 30_000, maxCandidatesPerPass: 10, suiteVersion: 'test-v1', suite,
      });
      expect(await pump.pump()).toMatchObject({ skipped: 1, failed: 0 });
      expect((await rsi.get(stale.id)).status).toBe('promoted');
      expect((await activation.list()).find(item => item.target === 'prompt')?.candidateId).toBe(base.id);
    } finally { await repository.close(); await activation.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
