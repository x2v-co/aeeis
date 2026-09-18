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

  it('requires shadow and canary observations for medium-risk promotion', async () => {
    const repository = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-evolution-rollout-')));
    await repository.init();
    const service = new RsiService(repository);
    const candidate = await service.propose({ ...proposal, risk: 'medium', proposedVersion: 'skill/3' });
    for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(candidate.id, { kind, passed: true, score: 0.95, evidenceRefs: [`eval.${kind}`] });
    await service.approve(candidate.id, 'approval.rollout');
    await expect(service.promote(candidate.id)).rejects.toThrow('shadow and canary');
    await service.startShadow(candidate.id);
    for (let index = 1; index <= 2; index++) {
      await service.recordShadow(candidate.id, { id: `shadow.${index}`, passed: true, score: 0.9, evidenceRefs: [`shadow-evidence.${index}`] });
    }
    await expect(service.startCanary(candidate.id)).rejects.toThrow('observation gate');
    await service.recordShadow(candidate.id, { id: 'shadow.3', passed: true, score: 0.9, evidenceRefs: ['shadow-evidence.3'] });
    expect((await service.startCanary(candidate.id)).status).toBe('canarying');
    for (let index = 1; index <= 3; index++) {
      await service.recordCanary(candidate.id, { id: `canary.${index}`, passed: true, score: 0.9, evidenceRefs: [`canary-evidence.${index}`] });
    }
    expect((await service.promote(candidate.id)).status).toBe('promoted');
    await repository.close();
  });

  it('holds and permits rollback after a failed rollout observation', async () => {
    const repository = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-evolution-rollout-failed-')));
    await repository.init();
    const service = new RsiService(repository);
    const candidate = await service.propose({ ...proposal, risk: 'high', proposedVersion: 'skill/4' });
    for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(candidate.id, { kind, passed: true, score: 0.95, evidenceRefs: [`eval.${kind}`] });
    await service.approve(candidate.id, 'approval.failed-rollout');
    await service.startShadow(candidate.id);
    const held = await service.recordShadow(candidate.id, { id: 'shadow.bad', passed: false, score: 0.2, evidenceRefs: ['shadow-failure'] });
    expect(held.status).toBe('held');
    expect((await service.rollback(candidate.id, 'shadow regression')).status).toBe('rolled_back');
    await repository.close();
  });

  it('runs bounded rollout batches through the isolated evaluator and preserves evidence', async () => {
    const repository = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-evolution-rollout-runner-')));
    await repository.init();
    const service = new RsiService(repository);
    const candidate = await service.propose({ ...proposal, risk: 'medium', proposedVersion: 'skill/5' });
    for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(candidate.id, { kind, passed: true, score: 0.95, evidenceRefs: [`eval.${kind}`] });
    await service.approve(candidate.id, 'approval.runner');
    await service.startShadow(candidate.id);
    let current = await service.runRollout(candidate.id, 'shadow', { cases: [{ id: 'one', input: {} }, { id: 'two', input: {} }, { id: 'three', input: {} }] }, {
      evaluate: async (_candidate, mode, testCase) => ({ passed: true, score: 0.9, evidenceRefs: [`${mode}:${testCase.id}`] }),
    });
    expect(current.status).toBe('shadowing');
    expect(current.shadowObservations?.map(item => item.id)).toEqual(['shadow:one', 'shadow:two', 'shadow:three']);
    await service.startCanary(candidate.id);
    current = await service.runRollout(candidate.id, 'canary', { cases: [{ id: 'one', input: {} }, { id: 'two', input: {} }, { id: 'three', input: {} }] }, {
      evaluate: async (_candidate, mode, testCase) => ({ passed: true, score: 0.9, evidenceRefs: [`${mode}:${testCase.id}`] }),
    });
    expect(current.status).toBe('canarying');
    expect(current.canaryObservations?.every(item => item.evidenceRefs.length > 0)).toBe(true);
    await repository.close();
  });
});
