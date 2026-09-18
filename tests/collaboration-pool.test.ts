import { describe, expect, it } from 'vitest';
import type { ModelAdapter } from '../src/runtime/model.js';
import { ModelPoolCandidateRunner, ModelPoolDebateOrchestrator, ModelPoolIndependentEvaluator } from '../src/collaboration-pool.js';

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

  it('drives a bounded debate room and closes after a decision', async () => {
    let record: any = { id: 'debate.pool', status: 'active', room: { debateId: 'debate.pool', taskId: 'task.pool', contextVersion: 'ctx.pool', participantAgentIds: ['agent.one', 'agent.two'], maxRounds: 2, maxMessagesPerAgent: 2, messages: [] } };
    const service = {
      getDebate: async () => record,
      appendMessage: async (_id: string, message: any) => { record = { ...record, room: { ...record.room, messages: [...record.room.messages, message] } }; return record; },
      closeDebate: async (_id: string, reason: string) => { record = { ...record, status: 'closed', closeReason: reason }; return record; },
    };
    const runner = new ModelPoolDebateOrchestrator(service, new Map([
      ['agent.one', { pin, complete: async () => ({ value: { type: 'position', content: 'Position', claimRefs: [] } }) } as ModelAdapter],
      ['agent.two', { pin, complete: async () => ({ value: { type: 'decision', content: 'Decision', claimRefs: [] } }) } as ModelAdapter],
    ]));
    const finished = await runner.run('debate.pool');
    expect(finished.status).toBe('closed'); expect(finished.room.messages).toHaveLength(2); expect(finished.closeReason).toContain('decision');
  });

  it('resumes a persisted debate round without duplicating messages after restart', async () => {
    let record: any = { id: 'debate.resume', status: 'active', room: { debateId: 'debate.resume', taskId: 'task.pool', contextVersion: 'ctx.pool', participantAgentIds: ['agent.one', 'agent.two'], maxRounds: 2, maxMessagesPerAgent: 2, messages: [{ schemaVersion: 'debate-message/1', messageId: 'message.existing', debateId: 'debate.resume', round: 1, speakerAgentId: 'agent.one', type: 'position', content: 'Already persisted', claimRefs: [], contextVersion: 'ctx.pool' }] } };
    const calls: string[] = [];
    const service = {
      getDebate: async () => record,
      appendMessage: async (_id: string, message: any) => { record = { ...record, room: { ...record.room, messages: [...record.room.messages, message] } }; return record; },
      closeDebate: async (_id: string, reason: string) => { record = { ...record, status: 'closed', closeReason: reason }; return record; },
    };
    const runner = new ModelPoolDebateOrchestrator(service, new Map([
      ['agent.one', { pin, complete: async () => { calls.push('one'); return { value: { type: 'position', content: 'Continued', claimRefs: [] } }; } } as ModelAdapter],
      ['agent.two', { pin, complete: async () => { calls.push('two'); return { value: { type: 'decision', content: 'Decision', claimRefs: [] } }; } } as ModelAdapter],
    ]));
    const finished = await runner.run('debate.resume');
    expect(calls).toEqual(['two']);
    expect(finished.room.messages).toHaveLength(2);
    expect(finished.room.messages.at(-1)?.speakerAgentId).toBe('agent.two');
  });
});
