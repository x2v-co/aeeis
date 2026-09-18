import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileEvolutionRepository, RsiService } from '../src/rsi.js';

const proposal = { target: 'skill' as const, baseVersion: 'skill/1', proposedVersion: 'skill/2', change: 'Require evidence citations', sourceReceiptRefs: ['receipt.1'], reason: 'User correction', risk: 'low' as const };

describe('persistent RSI service', () => {
  it('persists the candidate lifecycle and only promotes after evaluation and approval', async () => {
    const repository = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-evolution-')));
    await repository.init();
    const service = new RsiService(repository);
    const candidate = await service.propose(proposal);
    await expect(service.promote(candidate.id)).rejects.toThrow('approval');
    let current = await service.evaluate(candidate.id, { kind: 'replay', passed: true, score: 0.9, evidenceRefs: ['eval.1'] });
    current = await service.evaluate(candidate.id, { kind: 'holdout', passed: true, score: 0.9, evidenceRefs: ['eval.2'] });
    current = await service.evaluate(candidate.id, { kind: 'safety', passed: true, score: 0.9, evidenceRefs: ['eval.3'] });
    current = await service.approve(current.id, 'approval.1');
    expect((await service.promote(current.id)).status).toBe('promoted');
    const restored = new RsiService(repository);
    expect((await restored.get(candidate.id)).status).toBe('promoted');
    await repository.close();
  });

  it('holds a failed evaluation and keeps it non-promotable', async () => {
    const repository = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-evolution-held-')));
    await repository.init();
    const service = new RsiService(repository);
    const candidate = await service.propose(proposal);
    const held = await service.evaluate(candidate.id, { kind: 'safety', passed: false, score: 0.1, evidenceRefs: ['eval.bad'] });
    expect(held.status).toBe('held');
    await expect(service.approve(candidate.id, 'approval.bad')).rejects.toThrow('pass');
    await repository.close();
  });

  it('runs a bounded evaluation suite and persists one evidence-backed gate per mode', async () => {
    const repository = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-evolution-suite-')));
    await repository.init();
    const service = new RsiService(repository);
    const candidate = await service.propose(proposal);
    const evaluated = await service.evaluateSuite(candidate.id, {
      suite: {
        replay: [{ id: 'replay.1', input: { goal: 'same' } }],
        holdout: [{ id: 'holdout.1', input: { goal: 'new' } }],
        safety: [{ id: 'safety.1', input: { goal: 'safe' } }],
      },
      minimumScore: 0.8,
    }, {
      evaluate: async (_candidate, mode, testCase) => ({ passed: true, score: 0.95, evidenceRefs: [`${mode}:${testCase.id}`] }),
    });
    expect(evaluated.status).toBe('evaluating');
    expect(evaluated.evaluations.map(item => item.kind)).toEqual(['replay', 'holdout', 'safety']);
    expect(evaluated.evaluations.every(item => item.passed)).toBe(true);
    await repository.close();
  });
});
