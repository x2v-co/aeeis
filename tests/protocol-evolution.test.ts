import { describe, expect, it } from 'vitest';
import { createContextPack, delegationGrantSchema, resultEnvelopeSchema, validateResultForGrant } from '../src/protocol.js';
import { EvolutionEngine } from '../src/evolution.js';
import { RsiEvaluator } from '../src/evaluation.js';

const date = '2030-01-01T00:00:00.000Z';
describe('versioned agent protocol', () => {
  it('binds context digest and rejects a result outside its grant', () => {
    const pack = createContextPack({ schemaVersion: 'context-pack/1', id: 'ctx.1', taskId: 'task.1', version: 1, audience: ['agent.1'], classification: 'internal', expiresAt: date, sourceRefs: [], artifactRefs: [], claims: [], redactions: [] });
    expect(pack.digest).toHaveLength(64);
    const grant = delegationGrantSchema.parse({ schemaVersion: 'delegation-grant/1', grantId: 'grant.1', subjectAgentId: 'agent.1', issuerAgentId: 'aeeis.1', taskId: 'task.1', purpose: 'research', actions: ['return_result'], resourceRefs: [], dataScope: 'internal', issuedAt: '2029-01-01T00:00:00.000Z', expiresAt: date, budget: {}, delegationChain: [], revocationRef: 'revoke.1', nonce: '0123456789012345' });
    const result = resultEnvelopeSchema.parse({ schemaVersion: 'result-envelope/1', taskId: 'task.1', agentId: 'agent.1', status: 'completed', resultType: 'report/1', summary: 'done', claims: [], artifacts: [], unresolved: [], requestedFollowups: [], cost: {}, capabilitiesUsed: [], contextVersion: 'ctx.1', receiptRef: 'receipt.1' });
    expect(() => validateResultForGrant(result, grant)).not.toThrow();
    expect(() => validateResultForGrant({ ...result, taskId: 'task.2' }, grant)).toThrow('task');
  });
});

describe('controlled RSI evolution', () => {
  it('requires independent evaluation and approval, then supports rollback', () => {
    const engine = new EvolutionEngine();
    let candidate = engine.propose({ target: 'skill', baseVersion: 'skill/1', proposedVersion: 'skill/2', change: 'Cite the observed evidence before summarizing', sourceReceiptRefs: ['receipt.1'], reason: 'User corrected unsupported claim', risk: 'low' });
    candidate = engine.evaluate(candidate, { kind: 'replay', passed: true, score: 0.9, evidenceRefs: ['eval.1'] });
    expect(() => engine.promote(candidate)).toThrow('approval');
    candidate = engine.approve(candidate, 'approval.1');
    candidate = engine.promote(candidate);
    expect(candidate.status).toBe('promoted');
    expect(engine.rollback(candidate, 'holdout regression').status).toBe('rolled_back');
  });
  it('holds a candidate when an evaluation fails', () => {
    const engine = new EvolutionEngine();
    let candidate = engine.propose({ target: 'workflow', baseVersion: 'workflow/1', proposedVersion: 'workflow/2', change: 'Change retry policy', sourceReceiptRefs: ['receipt.1'], reason: 'Reduce timeout failures', risk: 'medium' });
    candidate = engine.evaluate(candidate, { kind: 'safety', passed: false, score: 0.2, evidenceRefs: ['eval.2'] });
    expect(candidate.status).toBe('held');
    expect(() => engine.approve(candidate, 'approval.2')).toThrow('pass');
  });

  it('executes replay, holdout and safety gates before a candidate can be approved', async () => {
    const engine = new EvolutionEngine();
    const evaluator = new RsiEvaluator({ minimumScore: 0.75 });
    const candidate = engine.propose({ target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Require explicit uncertainty', sourceReceiptRefs: ['receipt.1'], reason: 'Reduce unsupported claims', risk: 'medium' });
    const evaluations = await evaluator.evaluate(candidate, {
      replay: [{ id: 'replay.1', input: { goal: 'summarize' } }],
      holdout: [{ id: 'holdout.1', input: { goal: 'compare' } }],
      safety: [{ id: 'safety.1', input: { goal: 'refuse' } }],
    }, { evaluate: async (_candidate, mode, testCase) => ({ passed: true, score: 0.9, evidenceRefs: [`${mode}.${testCase.id}`] }) });
    expect(evaluations).toHaveLength(3);
    expect(evaluations.every(item => item.passed)).toBe(true);
    let evaluated = candidate;
    for (const evaluation of evaluations) evaluated = engine.evaluate(evaluated, evaluation);
    expect(engine.approve(evaluated, 'approval.3').status).toBe('approved');
  });
});
