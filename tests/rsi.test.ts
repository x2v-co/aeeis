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
  it('reserves evaluator work durably, rejects duplicate calls, and stops on invalid evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-rollout-reservation-'));
    const repository = new FileEvolutionRepository(directory); await repository.init();
    try {
      const service = new RsiService(repository);
      const candidate = await service.propose({ ...proposal, risk: 'medium' });
      for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(candidate.id, { kind, passed: true, score: 1, evidenceRefs: ['eval.receipt'] });
      await service.approve(candidate.id, 'approval'); await service.startShadow(candidate.id);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      let calls = 0;
      const harness = { evaluate: async () => { calls++; entered(); await gate; return { passed: true, score: 1, evidenceRefs: ['actual.receipt'] }; } };
      const batch = { cases: [{ id: 'one', input: { goal: 'Observe' } }] };
      const work = service.runRollout(candidate.id, 'shadow', batch, harness);
      await started;
      const reserved = await service.get(candidate.id);
      expect(reserved.rolloutAttempts?.[0]).toMatchObject({ state: 'started', phase: 'shadow', caseId: 'one' });
      await expect(new RsiService(repository).runRollout(candidate.id, 'shadow', batch, harness)).rejects.toThrow('in flight or interrupted');
      release(); await work;
      await expect(service.runRollout(candidate.id, 'shadow', batch, harness)).rejects.toThrow('Duplicate');
      expect(calls).toBe(1);
      const failed = await service.runRollout(candidate.id, 'shadow', { cases: [{ id: 'bad', input: {} }, { id: 'never', input: {} }] }, {
        evaluate: async () => { calls++; return { passed: true, score: 1, evidenceRefs: [] }; },
      });
      expect(calls).toBe(2);
      expect(failed.status).toBe('held');
      const attempt = failed.rolloutAttempts!.at(-1)!;
      expect(attempt.state).toBe('failed');
      expect(failed.shadowObservations!.at(-1)!.evidenceRefs).toEqual([attempt.id]);
      expect(attempt.observation?.passed).toBe(false);
      expect((await new RsiService(repository).get(candidate.id)).rolloutAttempts).toEqual(failed.rolloutAttempts);
    } finally { await repository.close(); }
  });

  it('retains the evaluator receipt without reviving a candidate rolled back during evaluation', async () => {
    const repository = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-rollout-rollback-'))); await repository.init();
    try {
      const service = new RsiService(repository);
      const candidate = await service.propose(proposal);
      for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(candidate.id, { kind, passed: true, score: 1, evidenceRefs: ['eval.receipt'] });
      await service.approve(candidate.id, 'approval'); await service.startShadow(candidate.id);
      const result = await service.runRollout(candidate.id, 'shadow', { cases: [{ id: 'one', input: {} }, { id: 'never', input: {} }] }, {
        evaluate: async () => {
          await service.rollback(candidate.id, 'Owner halted the rollout');
          return { passed: true, score: 1, evidenceRefs: ['actual.receipt'] };
        },
      });
      expect(result.status).toBe('rolled_back');
      expect(result.shadowObservations).toEqual([]);
      expect(result.rolloutAttempts).toHaveLength(1);
      expect(result.rolloutAttempts?.[0]?.observation?.evidenceRefs).toEqual(['actual.receipt']);
    } finally { await repository.close(); }
  });

  it('reconciles an interrupted rollout attempt without issuing a second evaluator call', async () => {
    const repository = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-rollout-reconcile-'))); await repository.init();
    try {
      const service = new RsiService(repository);
      const candidate = await service.propose(proposal);
      for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(candidate.id, { kind, passed: true, score: 1, evidenceRefs: ['eval.receipt'] });
      await service.approve(candidate.id, 'approval'); await service.startShadow(candidate.id);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      let calls = 0;
      const work = service.runRollout(candidate.id, 'shadow', { cases: [{ id: 'one', input: {} }] }, { evaluate: async () => { calls++; entered(); await gate; return { passed: true, score: 1, evidenceRefs: ['late.evidence'] }; } });
      await started;
      const attemptId = (await service.get(candidate.id)).rolloutAttempts![0]!.id;
      const reconciled = await service.reconcileRollout(candidate.id, { attemptId, outcome: 'completed', passed: true, score: 0.8, evidenceRefs: ['provider.receipt'], reason: 'Provider status query confirmed completion' });
      expect(reconciled.shadowObservations?.[0]?.evidenceRefs).toEqual(['provider.receipt']);
      release();
      const finished = await work;
      expect(finished.shadowObservations?.[0]?.evidenceRefs).toEqual(['provider.receipt']);
      expect(finished.rolloutAttempts?.[0]?.state).toBe('reconciled');
      expect(calls).toBe(1);
    } finally { await repository.close(); }
  });

});
