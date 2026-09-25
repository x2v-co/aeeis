import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileEvolutionRepository, RsiService } from '../src/rsi.js';
import { FileEvolutionActivationStore } from '../src/evolution-activation.js';
import { createGlobalBudgetSelector, InMemoryGlobalBudgetLedger } from '../src/global-budget.js';

const proposal = { target: 'skill' as const, baseVersion: 'skill/1', proposedVersion: 'skill/2', change: 'Require evidence citations', sourceReceiptRefs: ['receipt.1'], reason: 'User correction', risk: 'low' as const };

describe('persistent RSI service', () => {
  it('charges RSI evaluator gates against the shared tenant budget', async () => {
    const repository = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-evolution-global-budget-'))); await repository.init();
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    const select = createGlobalBudgetSelector([{ tenantId: 'local', window: 'day', budget: { calls: 2 } }]);
    const service = new RsiService(repository, undefined, { ledger, select });
    try {
      const candidate = await service.propose(proposal);
      const suite = { replay: [{ id: 'r', input: {} }], holdout: [{ id: 'h', input: {} }], safety: [{ id: 's', input: {} }] };
      await expect(service.evaluateSuite(candidate.id, { suite }, { evaluate: async () => ({ passed: true, score: 1, evidenceRefs: ['eval.global'] }) })).rejects.toThrow('Global call budget exhausted');
      const account = await ledger.get(select(undefined, new Date().toISOString())!.accountKey);
      expect(account).toMatchObject({ usedCalls: 2 });
    } finally { await ledger.close(); await repository.close(); }
  });

  it('settles provider reported evaluator usage in the shared budget and records it on the attempt', async () => {
    const repository = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-evolution-global-usage-'))); await repository.init();
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    const select = createGlobalBudgetSelector([{ tenantId: 'local', window: 'day', budget: { calls: 3, tokens: 6, moneyUsd: 0.31 } }]);
    const service = new RsiService(repository, undefined, { ledger, select });
    try {
      const candidate = await service.propose(proposal);
      const suite = { replay: [{ id: 'r', input: {} }], holdout: [{ id: 'h', input: {} }], safety: [{ id: 's', input: {} }] };
      const result = await service.evaluateSuite(candidate.id, { suite }, { evaluate: async () => ({ passed: true, score: 1, evidenceRefs: ['eval.usage'], usage: { tokens: 2, moneyUsd: 0.1 } }) });
      const account = await ledger.get(select(undefined, new Date().toISOString())!.accountKey);
      expect(account).toMatchObject({ usedCalls: 3, usedTokens: 6, unreportedTokenCalls: 0, unreportedMoneyCalls: 0 });
      expect(account?.usedMoneyUsd).toBeCloseTo(0.3, 10);
      expect(result.evaluationAttempts?.every(attempt => attempt.usage)).toBe(true);
    } finally { await ledger.close(); await repository.close(); }
  });

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

  it('activates only promoted prompt releases, enforces the base version, and restores the predecessor on rollback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-evolution-activation-'));
    const repository = new FileEvolutionRepository(directory); await repository.init();
    const activation = new FileEvolutionActivationStore(directory); await activation.init();
    const service = new RsiService(repository, activation);
    const first = await service.propose({ target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Always cite the evidence graph.', sourceReceiptRefs: ['receipt.prompt.1'], reason: 'Observed unsupported claim', risk: 'low' });
    await expect(service.activate(first.id, 'before-approval')).rejects.toThrow('promoted');
    for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(first.id, { kind, passed: true, score: 1, evidenceRefs: [`${kind}.1`] });
    await service.approve(first.id, 'owner.approval.1'); await service.promote(first.id);
    const active = await service.activate(first.id, 'owner.activation.1');
    expect(active).toMatchObject({ target: 'prompt', version: 'prompt/2', candidateId: first.id });
    const second = await service.propose({ target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/3', change: 'Use shorter answers.', sourceReceiptRefs: ['receipt.prompt.2'], reason: 'Observed verbosity', risk: 'low' });
    for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(second.id, { kind, passed: true, score: 1, evidenceRefs: [`${kind}.2`] });
    await service.approve(second.id, 'owner.approval.2'); await service.promote(second.id);
    await expect(service.activate(second.id, 'owner.activation.2')).rejects.toThrow('base version conflict');
    const third = await service.propose({ target: 'prompt', baseVersion: 'prompt/2', proposedVersion: 'prompt/3', change: 'Use shorter answers.', sourceReceiptRefs: ['receipt.prompt.3'], reason: 'Observed verbosity', risk: 'low' });
    for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(third.id, { kind, passed: true, score: 1, evidenceRefs: [`${kind}.3`] });
    await service.approve(third.id, 'owner.approval.3'); await service.promote(third.id); await service.activate(third.id, 'owner.activation.3');
    expect((await service.listActive())[0]).toMatchObject({ candidateId: third.id, version: 'prompt/3', parentCandidateId: first.id });
    expect((await service.rollback(third.id, 'Shorter prompt regressed quality')).status).toBe('rolled_back');
    expect((await service.listActive())[0]).toMatchObject({ candidateId: first.id, version: 'prompt/2' });
    expect((await service.rollback(first.id, 'Prompt regression')).status).toBe('rolled_back');
    expect((await service.listActive())).toEqual([]);
    expect((await service.activationStatus()).history.at(-1)).toMatchObject({ action: 'rolled_back', candidateId: first.id });
    await activation.close(); await repository.close();
  });

  it('does not mutate a File activation store on an unauthorized cross-tenant revoke', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-evolution-activation-scope-'));
    const repository = new FileEvolutionRepository(directory); await repository.init();
    const activation = new FileEvolutionActivationStore(directory); await activation.init();
    const service = new RsiService(repository, activation);
    const ownerScope = { owner: 'alice', tenantId: 'tenant-a' };
    try {
      const candidate = await service.propose({ ...proposal, target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/scope-1' }, ownerScope);
      for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(candidate.id, { kind, passed: true, score: 1, evidenceRefs: [`scope.${kind}`] }, ownerScope);
      await service.approve(candidate.id, 'scope.approval', ownerScope); await service.promote(candidate.id, ownerScope); await service.activate(candidate.id, 'scope.activation', ownerScope);
      await expect(activation.revoke(candidate.id, 'unauthorized attempt', { owner: 'bob', tenantId: 'tenant-b' })).rejects.toThrow('Unknown evolution candidate');
      expect((await activation.list(ownerScope)).map(item => item.candidateId)).toEqual([candidate.id]);
      expect((await activation.history(ownerScope)).map(item => item.action)).toEqual(['activated']);
      expect((await activation.list({ owner: 'bob', tenantId: 'tenant-b' }))).toEqual([]);
    } finally { await activation.close(); await repository.close(); }
  });

  it('routes promoted RSI versions through a durable deterministic traffic canary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-evolution-traffic-'));
    const repository = new FileEvolutionRepository(directory); await repository.init();
    const activation = new FileEvolutionActivationStore(directory); await activation.init();
    const service = new RsiService(repository, activation);
    try {
      const base = await service.propose({ ...proposal, target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/traffic-base', change: 'Base release' });
      for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(base.id, { kind, passed: true, score: 1, evidenceRefs: [`base.${kind}`] });
      await service.approve(base.id, 'base.approval'); await service.promote(base.id); await service.activate(base.id, 'base.activation');
      const candidate = await service.propose({ ...proposal, target: 'prompt', baseVersion: 'prompt/traffic-base', proposedVersion: 'prompt/traffic-candidate', change: 'Candidate release' });
      for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(candidate.id, { kind, passed: true, score: 1, evidenceRefs: [`candidate.${kind}`] });
      await service.approve(candidate.id, 'candidate.approval'); await service.promote(candidate.id);
      const route = await service.startTraffic(candidate.id, 2500, 'traffic.start');
      expect(route).toMatchObject({ candidateId: candidate.id, baseCandidateId: base.id, percentage: 2500, status: 'active' });
      const keyFor = (selected: boolean): string => {
        for (let index = 0; index < 10000; index++) {
          const key = `run-${index}`, bucket = createHash('sha256').update(`${key}:${route.id}`).digest().readUInt32BE(0) % 10000;
          if ((bucket < route.percentage) === selected) return key;
        }
        throw new Error('No matching routing key');
      };
      const routingKey = keyFor(true);
      const selected = await service.selectActive({ owner: 'owner', tenantId: 'local' }, routingKey);
      expect(selected).toHaveLength(1); expect(selected[0]).toMatchObject({ candidateId: candidate.id, version: 'prompt/traffic-candidate' });
      expect(await service.selectActive({ owner: 'owner', tenantId: 'local' }, routingKey)).toEqual(selected);
      expect((await service.selectActiveWithTraffic({ owner: 'owner', tenantId: 'local' }, keyFor(false))).traffic).toEqual([expect.objectContaining({ routeId: route.id, selected: false })]);
      await activation.close(); await activation.init();
      expect(await service.selectActive({ owner: 'owner', tenantId: 'local' }, routingKey)).toEqual(selected);
      const foreign = { owner: 'other', tenantId: 'other' };
      await expect(service.pauseTraffic(candidate.id, 'unauthorized', foreign)).rejects.toThrow();
      await expect(activation.revoke(candidate.id, 'unauthorized', foreign)).rejects.toThrow();
      expect(await service.listTraffic(foreign)).toEqual([]);
      await service.updateTraffic(candidate.id, 1, 'traffic.reduce');
      const observed = await service.recordTraffic(candidate.id, { id: 'traffic.observation.1', passed: true, score: 0.97, evidenceRefs: ['metric.latency', 'metric.acceptance'], recordedAt: new Date().toISOString() });
      expect(observed.observations).toEqual([expect.objectContaining({ id: 'traffic.observation.1', score: 0.97 })]);
      await expect(service.recordTraffic(candidate.id, { id: 'traffic.observation.1', passed: true, score: 1, evidenceRefs: ['duplicate'], recordedAt: new Date().toISOString() })).rejects.toThrow('already exists');
      await service.pauseTraffic(candidate.id, 'traffic.pause');
      await expect(service.startTraffic(candidate.id, 1000, 'duplicate.paused')).rejects.toThrow('already exists');
      expect((await service.listTraffic())[0]).toMatchObject({ status: 'paused', lastReason: 'traffic.pause', rolloutRef: 'traffic.reduce' });
      expect((await service.selectActive({ owner: 'owner', tenantId: 'local' }, 'run-stable'))[0]?.candidateId).toBe(base.id);
      await service.resumeTraffic(candidate.id, 'traffic.resume');
      expect((await service.listTraffic())[0]).toMatchObject({ status: 'active', rolloutRef: 'traffic.resume' });
      await service.stopTraffic(candidate.id, 'traffic.rollback');
      expect((await service.listTraffic())[0]).toMatchObject({ status: 'stopped', rolloutRef: 'traffic.resume', lastReason: 'traffic.rollback' });
      await expect(service.resumeTraffic(candidate.id, 'stopped.resume')).rejects.toThrow();
      const restarted = await service.startTraffic(candidate.id, 2500, 'traffic.restart');
      expect(restarted.id).not.toBe(route.id);
      await service.stopTraffic(candidate.id, 'traffic.guard.stop');
      await service.startTraffic(candidate.id, 2500, 'traffic.guard.start', undefined, { minScore: 0.9, maxFailedObservations: 1, autoPause: true });
      const autoPaused = await service.recordTraffic(candidate.id, { id: 'traffic.observation.failed', passed: false, score: 0.2, evidenceRefs: ['metric.regression'], recordedAt: new Date().toISOString() });
      expect(autoPaused).toMatchObject({ status: 'paused', lastReason: expect.stringContaining('Automatic pause'), safety: { minScore: 0.9, maxFailedObservations: 1, autoPause: true } });
      await service.activate(candidate.id, 'traffic.full');
      expect((await service.listTraffic()).every(item => item.status === 'stopped')).toBe(true);
      expect((await service.selectActive({ owner: 'owner', tenantId: 'local' }, routingKey))[0]?.candidateId).toBe(candidate.id);
      await service.rollback(candidate.id, 'regression');
      expect((await service.selectActive({ owner: 'owner', tenantId: 'local' }, routingKey))[0]?.candidateId).toBe(base.id);
      expect((await service.selectActive({ owner: 'owner', tenantId: 'local' }, 'run-stable'))[0]?.candidateId).toBe(base.id);
    } finally { await activation.close(); await repository.close(); }
  });

  it('requires typed JSON payloads before activating operational RSI targets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-evolution-typed-'));
    const repository = new FileEvolutionRepository(directory); await repository.init();
    const activation = new FileEvolutionActivationStore(directory); await activation.init();
    const service = new RsiService(repository, activation);
    const invalid = await service.propose({ target: 'tool-policy', baseVersion: 'tool-policy/1', proposedVersion: 'tool-policy/2', change: 'deny everything', sourceReceiptRefs: ['receipt.tool-policy.invalid'], reason: 'Unsafe policy candidate', risk: 'low' });
    for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(invalid.id, { kind, passed: true, score: 1, evidenceRefs: [`${kind}.invalid`] });
    await service.approve(invalid.id, 'approval.invalid'); await service.promote(invalid.id);
    await expect(service.activate(invalid.id, 'activation.invalid')).rejects.toThrow('valid JSON');
    const valid = await service.propose({ target: 'tool-policy', baseVersion: 'tool-policy/1', proposedVersion: 'tool-policy/2', change: JSON.stringify({ allow: ['sources.read'], deny: ['send_message'], requireApproval: ['write_file'] }), sourceReceiptRefs: ['receipt.tool-policy.valid'], reason: 'Restrict side effects', risk: 'low' });
    for (const kind of ['replay', 'holdout', 'safety'] as const) await service.evaluate(valid.id, { kind, passed: true, score: 1, evidenceRefs: [`${kind}.valid`] });
    await service.approve(valid.id, 'approval.valid'); await service.promote(valid.id);
    expect((await service.activate(valid.id, 'activation.valid')).target).toBe('tool-policy');
    expect((await service.listActive())[0]).toMatchObject({ target: 'tool-policy', version: 'tool-policy/2' });
    await activation.close(); await repository.close();
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

  it('reserves evaluation gates durably and reconciles an ambiguous evaluator without a second call', async () => {
    const repository = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-evaluation-reconcile-'))); await repository.init();
    try {
      const service = new RsiService(repository);
      const candidate = await service.propose(proposal);
      const suite = { replay: [{ id: 'replay.1', input: { goal: 'same' } }], holdout: [{ id: 'holdout.1', input: { goal: 'new' } }], safety: [{ id: 'safety.1', input: { goal: 'safe' } }] };
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
      let calls = 0;
      const work = service.evaluateSuite(candidate.id, { suite }, { evaluate: async () => { calls++; entered(); await gate; return { passed: true, score: 1, evidenceRefs: ['late.evaluator'] }; } });
      await started;
      const reserved = await service.get(candidate.id);
      const attempt = reserved.evaluationAttempts?.[0];
      expect(attempt).toMatchObject({ state: 'started', mode: 'replay' });
      await expect(new RsiService(repository).evaluateSuite(candidate.id, { suite }, { evaluate: async () => { throw new Error('must not call'); } })).rejects.toThrow('in flight');
      const reconciled = await service.reconcileEvaluation(candidate.id, { attemptId: attempt!.id, outcome: 'completed', reason: 'Provider receipt confirmed the response', evaluation: { kind: 'replay', passed: true, score: 0.9, evidenceRefs: ['provider.receipt'] } });
      expect(reconciled.evaluations[0]?.evidenceRefs).toEqual(['provider.receipt']);
      release(); const finished = await work;
      expect(finished.evaluations.map(item => item.kind)).toEqual(['replay', 'holdout', 'safety']);
      expect(finished.evaluationAttempts?.[0]?.state).toBe('reconciled');
      expect(calls).toBe(3);
    } finally { await repository.close(); }
  });

  it('does not invoke or append duplicate evaluation gates after a successful suite', async () => {
    const repository = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-evaluation-idempotent-'))); await repository.init();
    try {
      const service = new RsiService(repository); const candidate = await service.propose(proposal);
      const suite = { replay: [{ id: 'r', input: {} }], holdout: [{ id: 'h', input: {} }], safety: [{ id: 's', input: {} }] };
      let calls = 0; const harness = { evaluate: async (_candidate: unknown, mode: string, testCase: { id: string }) => { calls++; return { passed: true, score: 1, evidenceRefs: [`${mode}:${testCase.id}`] }; } };
      const first = await service.evaluateSuite(candidate.id, { suite }, harness); const second = await service.evaluateSuite(candidate.id, { suite }, harness);
      expect(first.evaluations).toHaveLength(3); expect(second.evaluations).toHaveLength(3); expect(calls).toBe(3);
    } finally { await repository.close(); }
  });

  it('provides stable bounded candidate pages for projection scans', async () => {
    const repository = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-evolution-page-'))); await repository.init();
    try {
      const service = new RsiService(repository);
      await service.propose({ ...proposal, proposedVersion: 'skill/page-1', sourceReceiptRefs: ['receipt.page.1'] });
      await service.propose({ ...proposal, proposedVersion: 'skill/page-2', sourceReceiptRefs: ['receipt.page.2'] });
      await service.propose({ ...proposal, proposedVersion: 'skill/page-3', sourceReceiptRefs: ['receipt.page.3'] });
      const first = await service.page(undefined, 2);
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBeDefined();
      const second = await service.page(undefined, 2, first.nextCursor);
      expect(second.items).toHaveLength(1);
      expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(3);
      await expect(service.page(undefined, 2, 'malformed')).rejects.toThrow('Invalid collection cursor');
    } finally { await repository.close(); }
  });

});
