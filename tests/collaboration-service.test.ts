import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollaborationService, FileCollaborationRepository } from '../src/collaboration-service.js';

const brief = {
  schemaVersion: 'competition-brief/1' as const, taskId: 'task.collab', contextVersion: 'ctx.collab', goal: 'Pick a plan',
  participantAgentIds: ['agent.one', 'agent.two'], expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: true,
};
function candidate(agentId: string) {
  return { schemaVersion: 'result-envelope/1' as const, taskId: 'task.collab', agentId, status: 'completed' as const, resultType: 'plan/1', summary: agentId, claims: [], artifacts: [], unresolved: [], requestedFollowups: [], cost: {}, capabilitiesUsed: [], contextVersion: 'ctx.collab', receiptRef: `receipt.${agentId}` };
}

describe('durable collaboration service', () => {
  it('orchestrates isolated candidates and independent blind scoring into durable state', async () => {
    const repository = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-collab-run-'))); await repository.init();
    const service = new CollaborationService(repository);
    const created = await service.createCompetition(brief);
    const seen: string[][] = [];
    const finished = await service.runCompetition(created.id, 'agent.evaluator', {
      run: async (current, isolation) => {
        seen.push(isolation.cannotSeeCandidateIds);
        return candidate(isolation.candidateId);
      },
    }, {
      evaluate: async (current, candidates) => {
        expect(current.participantAgentIds).toEqual(['candidate_1', 'candidate_2']);
        return candidates.map(item => ({ agentId: item.agentId, score: item.agentId === 'candidate_2' ? 0.9 : 0.4, accepted: true, reasons: ['evidence fit'], evidenceRefs: [] }));
      },
    });
    expect(seen).toEqual([['agent.two'], ['agent.one']]);
    expect(finished.status).toBe('completed');
    expect(finished.selectedAgentId).toBe('agent.two');
    expect((await service.getEvaluationView(created.id)).scores).toHaveLength(2);
    await repository.close();
  });

  it('persists competition collection, independent scoring and selection', async () => {
    const repository = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-collab-'))); await repository.init();
    const service = new CollaborationService(repository);
    const created = await service.createCompetition(brief);
    await service.submitCandidate(created.id, candidate('agent.one'));
    await service.submitCandidate(created.id, candidate('agent.two'));
    await service.beginEvaluation(created.id, 'agent.evaluator');
    const evaluationView = await service.getEvaluationView(created.id);
    expect(evaluationView.candidates.map(item => item.agentId)).toEqual(['candidate_1', 'candidate_2']);
    await service.submitScore(created.id, 'agent.evaluator', { agentId: 'candidate_1', score: 0.4, accepted: true, reasons: ['weak'], evidenceRefs: [] });
    const finished = await service.submitScore(created.id, 'agent.evaluator', { agentId: 'candidate_2', score: 0.9, accepted: true, reasons: ['strong'], evidenceRefs: [] });
    expect(finished.status).toBe('completed'); expect(finished.selectedAgentId).toBe('agent.two');
    expect((await new CollaborationService(repository).getCompetition(created.id)).status).toBe('completed');
    await repository.close();
  });

  it('durably marks runner and evaluator failures instead of leaving a collecting competition', async () => {
    const repository = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-collaboration-failure-')));
    await repository.init();
    try {
      const service = new CollaborationService(repository);
      const created = await service.createCompetition({ schemaVersion: 'competition-brief/1', taskId: 'task.failure', contextVersion: 'ctx.failure', goal: 'Fail safely', participantAgentIds: ['agent.one', 'agent.two'], expectedResultType: 'result/1', maxRounds: 1, blindEvaluation: false });
      const failed = await service.runCompetition(created.id, 'agent.evaluator', { run: async () => { throw new Error('candidate unavailable'); } }, { evaluate: async () => { throw new Error('should not run'); } });
      expect(failed.status).toBe('failed');
      expect(failed.failureReason).toContain('candidate unavailable');
      expect((await service.getCompetition(created.id)).status).toBe('failed');
    } finally { await repository.close(); }
  });

  it('persists bounded debate messages and close state', async () => {
    const repository = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-debate-'))); await repository.init();
    const service = new CollaborationService(repository);
    const created = await service.createDebate({ taskId: 'task.debate', contextVersion: 'ctx.debate', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 2, maxTotalMessages: 3 });
    await service.appendMessage(created.id, { schemaVersion: 'debate-message/1', messageId: 'message.one', debateId: created.id, round: 1, speakerAgentId: 'agent.one', type: 'position', content: 'Position', claimRefs: [], contextVersion: 'ctx.debate' });
    await expect(service.appendMessage(created.id, { schemaVersion: 'debate-message/1', messageId: 'message.one', debateId: created.id, round: 1, speakerAgentId: 'agent.one', type: 'position', content: 'Duplicate', claimRefs: [], contextVersion: 'ctx.debate' })).rejects.toThrow('already exists');
    expect((await service.closeDebate(created.id, 'adjudication complete')).status).toBe('closed');
    await repository.close();
  });
});
