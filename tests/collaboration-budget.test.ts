import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollaborationService, FileCollaborationRepository } from '../src/collaboration-service.js';
import { ModelPoolCandidateRunner, ModelPoolIndependentEvaluator, ModelPoolDebateOrchestrator } from '../src/collaboration-pool.js';
import { ModelOutcomeUnknown, ModelResponseRejected, type ModelAdapter, type ModelRequest, type ModelResponse } from '../src/runtime/model.js';
import type { CollaborationBudget } from '../src/collaboration-budget.js';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';

const pin = { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test/1' };
const usage = { inputTokens: 2, outputTokens: 3 };
const prices = { inputPricePerMillion: 1, outputPricePerMillion: 2, currency: 'USD' as const };
const brief = { schemaVersion: 'competition-brief/1' as const, taskId: 'task.budget', contextVersion: 'ctx.budget', goal: 'Choose a plan', participantAgentIds: ['agent.one', 'agent.two'], expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: true };
const resources: Array<{ directory: string; repository: FileCollaborationRepository }> = [];
afterEach(async () => { for (const { directory, repository } of resources.splice(0)) { await repository.close(); await rm(directory, { recursive: true, force: true }); } });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-collaboration-budget-'));
  const repository = new FileCollaborationRepository(directory); await repository.init(); resources.push({ directory, repository });
  return { repository, service: new CollaborationService(repository) };
}
function candidateResult(agentId = 'agent.one') {
  return { schemaVersion: 'result-envelope/1' as const, taskId: brief.taskId, agentId, status: 'completed' as const, resultType: brief.expectedResultType, summary: 'Plan', claims: [], artifacts: [], unresolved: [], requestedFollowups: [], cost: {}, capabilitiesUsed: [], contextVersion: brief.contextVersion, receiptRef: `receipt.${agentId}` };
}
function pool(options: { candidate?: ModelAdapter['complete']; evaluator?: ModelAdapter['complete']; priced?: boolean } = {}) {
  const calls: Array<{ role: string; request: ModelRequest }> = [];
  const candidates = new Map<string, ModelAdapter>(brief.participantAgentIds.map(role => [role, { pin, complete: async request => {
    calls.push({ role, request });
    return options.candidate ? options.candidate(request) : { value: { summary: 'Plan', cost: { money: 999, currency: 'CNY', tokens: 0 } }, usage };
  } }]));
  const priceMap = options.priced === false ? new Map() : new Map(brief.participantAgentIds.map(id => [id, prices]));
  const runner = new ModelPoolCandidateRunner(candidates, priceMap);
  const evaluator = new ModelPoolIndependentEvaluator('agent.evaluator', { pin, complete: async request => {
    calls.push({ role: 'evaluator', request });
    if (options.evaluator) return options.evaluator(request);
    return { value: { scores: (request.input as { candidates: Array<{ agentId: string }> }).candidates.map(item => ({ agentId: item.agentId, score: 0.8, accepted: true, reasons: [], evidenceRefs: [] })) }, usage };
  } }, options.priced === false ? undefined : prices);
  return { calls, runner, evaluator };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('durable collaboration model accounting', () => {
  it('includes the independent evaluator, ignores generated costs and persists usage across restart', async () => {
    const { repository, service } = await setup(); const { runner, evaluator, calls } = pool();
    const created = await service.createCompetition({ ...brief, modelBudget: { calls: 3, tokens: 15, moneyUsd: 1 } });
    const result = await service.runCompetition(created.id, evaluator.agentId, runner, evaluator);
    expect(result.status).toBe('completed');
    expect(result.usage).toMatchObject({ calls: 3, tokens: 15, unreportedTokenCalls: 0, unreportedMoneyCalls: 0 });
    expect(result.usage?.moneyUsd).toBeCloseTo(0.000024, 10);
    expect(result.evaluatorAttempt?.usage?.tokens).toBe(5);
    expect(result.evaluatorAttempt?.usage).toMatchObject({ inputTokens: 2, outputTokens: 3, prices });
    expect(result.attempts.every(attempt => attempt.model?.model === 'fixture')).toBe(true);
    expect(result.evaluatorAttempt?.model).toMatchObject({ model: 'fixture', promptVersion: 'test/1' });
    expect(result.candidates[0]?.cost).toMatchObject({ tokens: 5, currency: 'USD' });
    expect(calls.every(call => call.request.idempotencyKey?.startsWith(`competition:${created.id}:attempt_`))).toBe(true);
    await repository.close(); await repository.init();
    expect((await new CollaborationService(repository).getCompetition(created.id)).usage).toEqual(result.usage);
  });

  it.each([{ calls: 1 }, { tokens: 5 }, { moneyUsd: 0.000008 }])('checks before the next candidate call: %j', async modelBudget => {
    const { service } = await setup(); const { runner, evaluator, calls } = pool();
    const created = await service.createCompetition({ ...brief, modelBudget });
    const result = await service.runCompetition(created.id, evaluator.agentId, runner, evaluator);
    expect(result.status).toBe('failed'); expect(result.selectedAgentId).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('does not invoke any model for a zero USD threshold', async () => {
    const { service } = await setup(); const { runner, evaluator, calls } = pool();
    const created = await service.createCompetition({ ...brief, modelBudget: { moneyUsd: 0 } });
    expect((await service.runCompetition(created.id, evaluator.agentId, runner, evaluator)).status).toBe('failed');
    expect(calls).toEqual([]);
  });

  it('records evaluator overshoot and withholds selection and scores', async () => {
    const { service } = await setup(); const { runner, evaluator, calls } = pool();
    const created = await service.createCompetition({ ...brief, modelBudget: { tokens: 12 } });
    const result = await service.runCompetition(created.id, evaluator.agentId, runner, evaluator);
    expect(calls).toHaveLength(3); expect(result.usage?.tokens).toBe(15);
    expect(result.status).toBe('failed'); expect(result.scores).toEqual([]); expect(result.selectedAgentId).toBeUndefined();
  });

  it.each(['missing', 'invalid', 'truncated'] as const)('retains usage boundaries for %s candidate output', async mode => {
    const { service } = await setup(); const { runner, evaluator, calls } = pool({ candidate: async () => {
      if (mode === 'truncated') throw new ModelResponseRejected('truncated', usage);
      return mode === 'missing' ? { value: { summary: 'No provider usage', cost: { tokens: 0 } } } : { value: { summary: 42 }, usage };
    } });
    const created = await service.createCompetition({ ...brief, modelBudget: { tokens: 5 } });
    const result = await service.runCompetition(created.id, evaluator.agentId, runner, evaluator);
    expect(result.status).toBe('failed'); expect(calls).toHaveLength(1);
    expect(result.usage?.tokens).toBe(mode === 'missing' ? 0 : 5);
    expect(result.candidates).toEqual([]);
  });

  it('does not use generated money to satisfy an unpriced USD budget', async () => {
    const { service } = await setup(); const { runner, evaluator, calls } = pool({ priced: false });
    const created = await service.createCompetition({ ...brief, modelBudget: { moneyUsd: 1 } });
    const result = await service.runCompetition(created.id, evaluator.agentId, runner, evaluator);
    expect(result.status).toBe('failed'); expect(result.usage?.moneyUsd).toBeUndefined(); expect(calls).toHaveLength(0);
  });

  it('admits each candidate and evaluator once under concurrent run requests', async () => {
    const { service } = await setup(); const gate = deferred<ModelResponse>(); const started = deferred<void>();
    let first = true;
    const { runner, evaluator, calls } = pool({ candidate: async () => { if (first) { first = false; started.resolve(); return gate.promise; } return { value: { summary: 'second' }, usage }; } });
    const created = await service.createCompetition({ ...brief, modelBudget: { calls: 3, tokens: 15 } });
    const running = service.runCompetition(created.id, evaluator.agentId, runner, evaluator); await started.promise;
    const concurrent = await service.runCompetition(created.id, evaluator.agentId, runner, evaluator);
    expect(concurrent.status).toBe('running'); expect(calls).toHaveLength(1);
    gate.resolve({ value: { summary: 'first' }, usage });
    expect((await running).status).toBe('completed'); expect(calls).toHaveLength(3);
  });

  it('holds ambiguous candidate transport without retry, then reconciles once with measured usage', async () => {
    const { service, repository } = await setup(); let first = true;
    const { runner, evaluator, calls } = pool({ candidate: async () => { if (first) { first = false; throw new ModelOutcomeUnknown('network'); } return { value: { summary: 'second' }, usage }; } });
    const created = await service.createCompetition({ ...brief, modelBudget: { calls: 3, tokens: 15 } });
    const pending = await service.runCompetition(created.id, evaluator.agentId, runner, evaluator);
    expect(pending.attempts[0]?.state).toBe('unknown'); expect(pending.usage?.unreportedTokenCalls).toBe(1);
    await repository.close(); await repository.init(); const resumed = new CollaborationService(repository);
    await resumed.runCompetition(created.id, evaluator.agentId, runner, evaluator); expect(calls).toHaveLength(1);
    await resumed.reconcileCompetitionAttempt(created.id, { attemptId: pending.attempts[0]!.id, outcome: 'completed', result: candidateResult(), usage: { tokens: 5 }, reason: 'Provider receipt verified' });
    const result = await resumed.runCompetition(created.id, evaluator.agentId, runner, evaluator);
    expect(result.status).toBe('completed'); expect(result.usage?.tokens).toBe(15); expect(calls).toHaveLength(3);
  });

  it('reconciles unknown evaluator spend without making another evaluation call', async () => {
    const { service } = await setup(); const { runner, evaluator, calls } = pool({ evaluator: async () => { throw new ModelOutcomeUnknown('network'); } });
    const created = await service.createCompetition({ ...brief, modelBudget: { calls: 3, tokens: 15 } });
    const pending = await service.runCompetition(created.id, evaluator.agentId, runner, evaluator);
    expect(pending.evaluatorAttempt?.state).toBe('unknown');
    const result = await service.reconcileCompetitionEvaluator(created.id, { attemptId: pending.evaluatorAttempt!.id, outcome: 'completed', usage: { tokens: 5 }, scores: ['candidate_1', 'candidate_2'].map(agentId => ({ agentId, score: 0.8, accepted: true, reasons: [], evidenceRefs: [] })), reason: 'Provider receipt verified' });
    expect(result.status).toBe('completed'); expect(result.usage).toMatchObject({ calls: 3, tokens: 15 }); expect(calls).toHaveLength(3);
  });

  it('finishes a settled evaluator after a crash without charging it again', async () => {
    const { service, repository } = await setup(); const { runner, evaluator, calls } = pool();
    const created = await service.createCompetition({ ...brief, modelBudget: { calls: 3, tokens: 15 } });
    await repository.mutateCompetition(created.id, record => ({ ...record, status: 'evaluating', evaluatorAgentId: evaluator.agentId,
      candidates: [candidateResult(), candidateResult('agent.two')],
      attempts: brief.participantAgentIds.map(participantAgentId => ({ id: `attempt.${participantAgentId}`, participantAgentId, inputHash: 'b'.repeat(64), state: 'completed', usage: { tokens: 5 }, startedAt: new Date().toISOString(), result: candidateResult(participantAgentId) })),
      evaluatorAttempt: { id: 'attempt.settled', inputHash: 'a'.repeat(64), state: 'completed', usage: { tokens: 5 }, startedAt: new Date().toISOString(), scores: ['candidate_1', 'candidate_2'].map(agentId => ({ agentId, score: 0.8, accepted: true, reasons: [], evidenceRefs: [] })) },
    }));
    expect((await service.runCompetition(created.id, evaluator.agentId, runner, evaluator)).status).toBe('completed'); expect(calls).toEqual([]);
  });

  it('retains evaluator usage on a billable invalid provider response', async () => {
    const { service } = await setup(); const { runner, evaluator } = pool({ evaluator: async () => { throw new ModelResponseRejected('invalid JSON', usage); } });
    const created = await service.createCompetition({ ...brief, modelBudget: { calls: 3, tokens: 20 } });
    const result = await service.runCompetition(created.id, evaluator.agentId, runner, evaluator);
    expect(result.status).toBe('failed'); expect(result.usage?.tokens).toBe(15);
    expect(result.evaluatorAttempt?.usage?.tokens).toBe(5); expect(result.selectedAgentId).toBeUndefined();
  });

  it('late evaluator response cannot overwrite a reconciled result or its usage', async () => {
    const { service } = await setup(); const started = deferred<void>(); const gate = deferred<ModelResponse>();
    const { runner, evaluator } = pool({ evaluator: async () => { started.resolve(); return gate.promise; } });
    const created = await service.createCompetition({ ...brief, modelBudget: { calls: 3, tokens: 20 } });
    const running = service.runCompetition(created.id, evaluator.agentId, runner, evaluator); await started.promise;
    const pending = await service.getCompetition(created.id);
    await service.reconcileCompetitionEvaluator(created.id, { attemptId: pending.evaluatorAttempt!.id, outcome: 'completed', usage: { tokens: 5 }, scores: [{ agentId: 'candidate_2', score: 1, accepted: true, reasons: [], evidenceRefs: [] }], reason: 'Provider confirms' });
    gate.resolve({ value: { scores: [{ agentId: 'candidate_1', score: 1, accepted: true, reasons: [], evidenceRefs: [] }] }, usage: { inputTokens: 50, outputTokens: 50 } });
    const result = await running;
    expect(result.selectedAgentId).toBe('agent.two'); expect(result.usage?.tokens).toBe(15);
  });

  it('accepts and validates budgets on both collaboration HTTP creation routes', async () => {
    const { service, repository } = await setup();
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-budget-http-'));
    const runs = new FileRunRepository(directory); await runs.init();
    const app = buildApp({ repository: runs, collaboration: service });
    try {
      const comp = await app.inject({ method: 'POST', url: '/api/collaborations/competitions', payload: { ...brief, modelBudget: { calls: 3, tokens: 20 } } });
      expect(comp.statusCode).toBe(200); expect(comp.json().brief.modelBudget.tokens).toBe(20);
      const payload = { taskId: 'task.http', contextVersion: 'ctx.http', participantAgentIds: ['agent.one'], modelBudget: { calls: 3, tokens: 20 } };
      const room = await app.inject({ method: 'POST', url: '/api/collaborations/debates', payload });
      expect(room.statusCode).toBe(200); expect(room.json().modelBudget.tokens).toBe(20);
      for (const modelBudget of [{}, { tokens: -1 }, { moneyUsd: -1 }, { calls: 0 }, { moneyUsd: 1, currency: 'CNY' }]) {
        expect((await app.inject({ method: 'POST', url: '/api/collaborations/debates', payload: { ...payload, modelBudget } })).statusCode).toBe(400);
        expect((await app.inject({ method: 'POST', url: '/api/collaborations/competitions', payload: { ...brief, modelBudget } })).statusCode).toBe(400);
      }
      expect((await repository.listCompetitions())[0]?.brief.modelBudget).toEqual({ calls: 3, tokens: 20 });
    } finally { await app.close(); await runs.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('blocks manual candidate injection into a budgeted competition', async () => {
    const { service } = await setup(); const created = await service.createCompetition({ ...brief, modelBudget: { calls: 3 } });
    await expect(service.submitCandidate(created.id, candidateResult())).rejects.toThrow('durable model attempt');
  });
});

async function debate(modelBudget: CollaborationBudget, options: { usage?: ModelResponse['usage']; unknown?: boolean } = {}) {
  const { repository, service } = await setup(); const calls: string[] = [];
  const created = await service.createDebate({ taskId: 'task.debate', contextVersion: 'ctx.debate', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1, modelBudget,
    context: { classification: 'internal', claims: [{ id: 'claim.fact', text: 'Fact', evidenceRefs: [] }], artifactRefs: [], redactions: [] },
  });
  const agents = new Map<string, ModelAdapter>();
  for (const role of ['agent.one', 'agent.moderator', 'agent.adjudicator']) agents.set(role, { pin, complete: async request => {
    calls.push(role);
    if (options.unknown && role === 'agent.one') throw new ModelOutcomeUnknown('network');
    const value = role === 'agent.one' ? { type: 'decision', content: 'Supported', claimRefs: ['claim.fact'] }
      : role === 'agent.moderator' ? { status: 'accepted', violations: [], missingClaimRefs: [] }
      : { status: 'decided', decision: 'Supported', rationale: 'Evidence', selectedMessageId: (request.input as { room: { messages: Array<{ messageId: string }> } }).room.messages[0]!.messageId, evidenceRefs: ['claim.fact'] };
    return { value, ...('usage' in options ? options.usage ? { usage: options.usage } : {} : { usage }) };
  } });
  const runner = new ModelPoolDebateOrchestrator(service, agents, { moderatorAgentId: 'agent.moderator', adjudicatorAgentId: 'agent.adjudicator' }, new Map([...agents.keys()].map(role => [role, prices])));
  return { repository, service, created, runner, calls };
}

describe('Debate model budgets', () => {
  it('charges participant, Moderator and Adjudicator at the exact aggregate limit', async () => {
    const { runner, created, calls } = await debate({ calls: 3, tokens: 15, moneyUsd: 1 });
    const result = await runner.run(created.id);
    expect(result.room.adjudication?.status).toBe('decided'); expect(calls).toHaveLength(3);
    expect(result.usage).toMatchObject({ calls: 3, tokens: 15, unreportedTokenCalls: 0 });
    expect(result.usage?.moneyUsd).toBeCloseTo(0.000024, 10);
  });

  it.each([{ calls: 1 }, { tokens: 5 }, { tokens: 12 }, { moneyUsd: 0.000001 }])('holds rather than decides when any role exhausts the budget: %j', async modelBudget => {
    const { runner, created, calls } = await debate(modelBudget);
    const result = await runner.run(created.id);
    expect(result.status).toBe('closed'); expect(result.room.adjudication?.status).toBe('held');
    expect(result.room.adjudication?.selectedMessageId).toBeUndefined();
    expect(calls.length).toBe('tokens' in modelBudget && modelBudget.tokens === 12 ? 3 : 1);
  });

  it('does not turn missing provider usage into a free budgeted debate', async () => {
    const { runner, created, calls } = await debate({ tokens: 100 }, { usage: undefined });
    const result = await runner.run(created.id);
    expect(result.room.adjudication?.status).toBe('held'); expect(result.usage?.unreportedTokenCalls).toBe(1); expect(calls).toHaveLength(1);
    expect(result.room.messages).toEqual([]);
  });

  it('reconciles unknown participant usage once and resumes into independent roles', async () => {
    const { runner, service, created, calls } = await debate({ calls: 3, tokens: 15 }, { unknown: true });
    const pending = await runner.run(created.id); expect(pending.status).toBe('active');
    await service.reconcileDebateAttempt(created.id, { attemptId: pending.attempts[0]!.id, outcome: 'completed', output: { type: 'decision', content: 'Supported', claimRefs: ['claim.fact'] }, usage: { tokens: 5 }, reason: 'Provider receipt verified' });
    const result = await runner.run(created.id);
    expect(result.room.adjudication?.status).toBe('decided'); expect(result.usage?.tokens).toBe(15); expect(calls).toHaveLength(3);
  });
});
