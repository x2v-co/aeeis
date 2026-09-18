import { describe, expect, it } from 'vitest';
import type { ModelAdapter } from '../src/runtime/model.js';
import { ModelPoolCandidateRunner, ModelPoolIndependentEvaluator } from '../src/collaboration-pool.js';

const pin = { model: 'fixture', endpoint: 'http://127.0.0.1:9999/chat/completions', promptVersion: 'fixture/1' } as const;
const brief = { schemaVersion: 'competition-brief/1' as const, taskId: 'task.pool', contextVersion: 'ctx.pool', goal: 'Choose a plan', context: { classification: 'internal' as const, claims: [{ id: 'claim.pool', text: 'Use evidence', evidenceRefs: ['source.pool'] }], artifactRefs: [], redactions: [] }, participantAgentIds: ['agent.one', 'agent.two'], expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: true };

describe('internal competition model pool', () => {
  it('binds candidate output to the brief and passes anonymous candidates to the evaluator', async () => {
    const candidate = new ModelPoolCandidateRunner(new Map([
      ['agent.one', { pin, complete: async request => { expect((request.input as { brief: typeof brief }).brief.context?.claims[0]?.text).toBe('Use evidence'); return { value: { summary: 'one' } }; } } as ModelAdapter],
      ['agent.two', { pin, complete: async () => ({ value: { summary: 'two' } }) } as ModelAdapter],
    ]));
    const first = await candidate.run(brief, { candidateId: 'agent.one', cannotSeeCandidateIds: ['agent.two'] });
    expect(first.agentId).toBe('agent.one'); expect(first.taskId).toBe('task.pool'); expect(first.resultType).toBe('plan/1');
    const evaluator = new ModelPoolIndependentEvaluator('agent.evaluator', { pin, complete: async request => {
      const input = request.input as { candidates: Array<{ agentId: string }> };
      expect(input.candidates.map(item => item.agentId)).toEqual(['candidate_1', 'candidate_2']);
      return { value: { scores: input.candidates.map((item, index) => ({ agentId: item.agentId, score: index ? 0.9 : 0.4, accepted: true, reasons: ['fit'], evidenceRefs: [] })) } };
    } });
    await expect(evaluator.evaluate({ ...brief, participantAgentIds: ['candidate_1', 'candidate_2'] }, [{ ...first, agentId: 'candidate_1' }, { ...first, agentId: 'candidate_2', summary: 'two', receiptRef: 'receipt_two' }])).resolves.toHaveLength(2);
  });
});
