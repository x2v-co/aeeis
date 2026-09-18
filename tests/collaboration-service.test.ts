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

  it('does not rerun a started candidate after restart and accepts an explicit reconciliation', async () => {
    const repository = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-collaboration-attempt-'))); await repository.init();
    try {
      const service = new CollaborationService(repository);
      const created = await service.createCompetition(brief);
      const attemptId = 'attempt.recovered';
      await repository.mutateCompetition(created.id, current => ({ ...current, status: 'running', attempts: [{ id: attemptId, participantAgentId: 'agent.one', inputHash: 'a'.repeat(64), state: 'started', startedAt: new Date().toISOString() }] }));
      let calls = 0;
      const runner = { run: async (current: typeof brief, isolation: { candidateId: string; cannotSeeCandidateIds: string[] }) => { calls++; return candidate(isolation.candidateId); } };
      const evaluator = { evaluate: async (_brief: typeof brief, candidates: ReadonlyArray<ReturnType<typeof candidate>>) => candidates.map(item => ({ agentId: item.agentId, score: 0.8, accepted: true, reasons: [], evidenceRefs: [] })) };
      expect((await service.runCompetition(created.id, 'agent.evaluator', runner, evaluator)).status).toBe('running');
      expect(calls).toBe(0);
      expect((await service.reconcileCompetitionAttempt(created.id, { attemptId, outcome: 'completed', result: candidate('agent.one'), reason: 'Provider receipt confirmed the candidate result' })).status).toBe('collecting');
      const finished = await service.runCompetition(created.id, 'agent.evaluator', runner, evaluator);
      expect(calls).toBe(1); expect(finished.status).toBe('completed');
      expect(finished.attempts.find(attempt => attempt.id === attemptId)?.state).toBe('reconciled');
    } finally { await repository.close(); }
  });

  it('reconciles an interrupted evaluator attempt without invoking it again', async () => {
    const repository = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-collaboration-evaluator-'))); await repository.init();
    try {
      const service = new CollaborationService(repository);
      const created = await service.createCompetition(brief);
      await repository.mutateCompetition(created.id, current => ({
        ...current, status: 'evaluating', evaluatorAgentId: 'agent.evaluator',
        candidates: [candidate('agent.one'), candidate('agent.two')],
        evaluatorAttempt: { id: 'attempt.evaluator', inputHash: 'b'.repeat(64), state: 'started', startedAt: new Date().toISOString() },
      }));
      const reconciled = await service.reconcileCompetitionEvaluator(created.id, {
        attemptId: 'attempt.evaluator', outcome: 'completed', reason: 'Evaluator receipt confirmed',
        scores: [
          { agentId: 'candidate_1', score: 0.7, accepted: true, reasons: [], evidenceRefs: [] },
          { agentId: 'candidate_2', score: 0.9, accepted: true, reasons: [], evidenceRefs: [] },
        ],
      });
      expect(reconciled.status).toBe('completed'); expect(reconciled.selectedAgentId).toBe('agent.two');
      expect((await service.getCompetition(created.id)).evaluatorAttempt?.state).toBe('completed');
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
