import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelAdapter } from '../src/runtime/model.js';
import { ModelPoolCandidateRunner, ModelPoolDebateOrchestrator, ModelPoolIndependentEvaluator } from '../src/collaboration-pool.js';
import { CollaborationService, FileCollaborationRepository } from '../src/collaboration-service.js';

const pin = { model: 'fixture', endpoint: 'http://127.0.0.1:9999/chat/completions', promptVersion: 'fixture/1' } as const;
const brief = { schemaVersion: 'competition-brief/1' as const, taskId: 'task.pool', contextVersion: 'ctx.pool', goal: 'Choose a plan', context: { classification: 'internal' as const, claims: [{ id: 'claim.pool', text: 'Use evidence', evidenceRefs: ['source.pool'] }], artifactRefs: [], redactions: [] }, participantAgentIds: ['agent.one', 'agent.two'], expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: true };

describe('internal competition model pool', () => {
  it('resolves logical collaboration agents through the governed model resolver', async () => {
    const selected: string[] = [];
    const resolver = {
      resolve: async (request: { capability: string; privacy: string }) => {
        selected.push(`${request.capability}:${request.privacy}`);
        return {
          adapter: { pin, complete: async request => ({ value: request.system.includes('evaluator') ? { scores: [] } : { summary: 'resolved' }, usage: { inputTokens: 2, outputTokens: 3 } }) } as ModelAdapter,
          decision: { schemaVersion: 'model-decision/1' as const, selected: { model: 'fixture', provider: 'fixture', endpoint: pin.endpoint, inputPricePerMillion: 1, outputPricePerMillion: 2, priceCurrency: 'USD' }, candidates: [], reason: 'test resolver', decidedAt: new Date().toISOString() },
        };
      },
    };
    const candidate = new ModelPoolCandidateRunner(new Map(), new Map(), resolver);
    const result = await candidate.run({ ...brief, modelBudget: { moneyUsd: 1 } }, { candidateId: 'logical.one', cannotSeeCandidateIds: [] });
    expect(result.agentId).toBe('logical.one');
    expect(result.cost).toMatchObject({ tokens: 5, money: 0.000008, currency: 'USD' });
    expect(selected).toEqual(['agent:internal']);
    const evaluator = new ModelPoolIndependentEvaluator('logical.evaluator', undefined, undefined, resolver);
    await expect(evaluator.evaluate({ ...brief, modelBudget: { moneyUsd: 1 } }, [{ ...result, agentId: 'candidate_1' }])).resolves.toHaveLength(0);
    expect(selected).toEqual(['agent:internal', 'agent:internal']);
  });

  it('persists Planprice catalog provenance on durable Competition attempts', async () => {
    const repository = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-competition-catalog-'))); await repository.init();
    try {
      const service = new CollaborationService(repository);
      const catalogHash = 'a'.repeat(64);
      const catalogRetrievedAt = '2026-09-20T00:00:00.000Z';
      const resolver = {
        resolve: async (request: { capability: string; privacy: string }) => ({
          adapter: { pin, complete: async modelRequest => {
            if (modelRequest.system.includes('evaluator')) {
              return { value: { scores: ['candidate_1', 'candidate_2'].map(agentId => ({ agentId, score: 0.8, accepted: true, reasons: [], evidenceRefs: [] })) }, usage: { inputTokens: 1, outputTokens: 1 } };
            }
            return { value: { summary: 'candidate' }, usage: { inputTokens: 1, outputTokens: 1 } };
          } } as ModelAdapter,
          decision: { schemaVersion: 'model-decision/1' as const, selected: { model: 'fixture', provider: 'fixture', endpoint: pin.endpoint, inputPricePerMillion: 1, outputPricePerMillion: 2, priceCurrency: 'USD' }, candidates: [], reason: `${request.capability}:${request.privacy}`, catalogHash, catalogRetrievedAt, decidedAt: catalogRetrievedAt },
        }),
      };
      const created = await service.createCompetition({ ...brief, modelBudget: { calls: 3, tokens: 6, moneyUsd: 1 } });
      const runner = new ModelPoolCandidateRunner(new Map(), new Map(), resolver);
      const evaluator = new ModelPoolIndependentEvaluator('logical.evaluator', undefined, undefined, resolver);
      const finished = await service.runCompetition(created.id, 'logical.evaluator', runner, evaluator);
      expect(finished.status).toBe('completed');
      expect(finished.attempts.every(attempt => attempt.model?.catalogHash === catalogHash && attempt.model?.catalogRetrievedAt === catalogRetrievedAt)).toBe(true);
      expect(finished.evaluatorAttempt?.model).toMatchObject({ catalogHash, catalogRetrievedAt });
    } finally { await repository.close(); }
  });

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

  it('uses independent Moderator and Adjudicator roles without bypassing evidence policy', async () => {
    let record: any = { id: 'debate.roles', status: 'active', room: {
      debateId: 'debate.roles', taskId: 'task.pool', contextVersion: 'ctx.pool', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 2,
      messages: [], moderation: [], moderatorReviews: [], context: { classification: 'internal', claims: [{ id: 'claim.pool', text: 'Supported', evidenceRefs: [] }], artifactRefs: [], redactions: [], },
    } };
    const calls: string[] = [];
    const service = {
      getDebate: async () => record,
      appendMessage: async (_id: string, message: any) => {
        const moderation = { messageId: message.messageId, status: message.claimRefs.includes('claim.pool') ? 'accepted' : 'flagged', violations: [], missingClaimRefs: [], checkedAt: new Date().toISOString() };
        record = { ...record, room: { ...record.room, messages: [...record.room.messages, message], moderation: [...record.room.moderation, moderation] } }; return record;
      },
      recordModeratorReview: async (_id: string, review: any) => { record = { ...record, room: { ...record.room, moderatorReviews: [...record.room.moderatorReviews, review] } }; return record; },
      closeDebate: async (_id: string, reason: string, _scope?: unknown, adjudication?: unknown) => { record = { ...record, status: 'closed', closeReason: reason, room: { ...record.room, adjudication } }; return record; },
    };
    const runner = new ModelPoolDebateOrchestrator(service, new Map([
      ['agent.one', { pin, complete: async () => ({ value: { type: 'decision', content: 'Use supported fact', claimRefs: ['claim.pool'] } }) } as ModelAdapter],
      ['agent.moderator', { pin, complete: async request => { calls.push('moderator'); expect((request.input as { policy: { status: string } }).policy.status).toBe('accepted'); return { value: { status: 'accepted', violations: [], missingClaimRefs: [] } }; } } as ModelAdapter],
      ['agent.adjudicator', { pin, complete: async request => { calls.push('adjudicator'); const room = (request.input as { room: { messages: Array<{ messageId: string }> } }).room; return { value: { status: 'decided', decision: 'Use supported fact', rationale: 'Evidence bound', selectedMessageId: room.messages.at(-1)!.messageId, evidenceRefs: ['claim.pool'] } }; } } as ModelAdapter],
    ]), { moderatorAgentId: 'agent.moderator', adjudicatorAgentId: 'agent.adjudicator' });
    const finished = await runner.run('debate.roles');
    expect(calls).toEqual(['moderator', 'adjudicator']);
    expect(finished.room.adjudication).toMatchObject({ status: 'decided', adjudicatorAgentId: 'agent.adjudicator' });
  });

  it('runs durable participant, Moderator, and Adjudicator attempts through the real service', async () => {
    const repository = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-debate-model-'))); await repository.init();
    try {
      const service = new CollaborationService(repository);
      const created = await service.createDebate({ taskId: 'task.durable', contextVersion: 'ctx.durable', participantAgentIds: ['agent.one'], context: { classification: 'internal', claims: [{ id: 'claim.durable', text: 'Supported', evidenceRefs: [] }], artifactRefs: [], redactions: [] }, maxRounds: 1, maxMessagesPerAgent: 1 });
      const agents = new Map<string, ModelAdapter>();
      agents.set('agent.one', { pin, complete: async () => ({ value: { type: 'decision', content: 'Use the supported fact', claimRefs: ['claim.durable'] } }) });
      agents.set('agent.moderator', { pin, complete: async () => ({ value: { status: 'accepted', violations: [], missingClaimRefs: [] } }) });
      agents.set('agent.adjudicator', { pin, complete: async request => { const room = (request.input as { room: { messages: Array<{ messageId: string }> } }).room; return { value: { status: 'decided', decision: 'Use the supported fact', rationale: 'The evidence is bound', selectedMessageId: room.messages.at(-1)!.messageId, evidenceRefs: ['claim.durable'] } }; } });
      const finished = await new ModelPoolDebateOrchestrator(service, agents, { moderatorAgentId: 'agent.moderator', adjudicatorAgentId: 'agent.adjudicator' }).run(created.id);
      expect(finished.status).toBe('closed');
      expect(finished.room.adjudication?.status).toBe('decided');
      expect(finished.attempts).toHaveLength(3);
      expect(finished.attempts.every(attempt => attempt.state === 'completed')).toBe(true);
      expect(finished.attempts.every(attempt => attempt.model?.model === 'fixture' && attempt.model?.promptVersion === 'fixture/1')).toBe(true);
    } finally { await repository.close(); }
  });
});
