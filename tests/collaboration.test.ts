import { describe, expect, it } from 'vitest';
import { appendDebateMessage, runCompetition } from '../src/collaboration.js';
import type { CompetitionBrief, DebateRoom } from '../src/collaboration.js';

const brief: CompetitionBrief = { schemaVersion: 'competition-brief/1', taskId: 'task.1', contextVersion: 'ctx.1', goal: 'Choose a supported plan', participantAgentIds: ['agent.1', 'agent.2'], expectedResultType: 'plan/1', maxRounds: 2, blindEvaluation: true };
function result(agentId: string, summary: string) { return { schemaVersion: 'result-envelope/1' as const, taskId: 'task.1', agentId, status: 'completed' as const, resultType: 'plan/1', summary, claims: [], artifacts: [], unresolved: [], requestedFollowups: [], cost: {}, capabilitiesUsed: [], contextVersion: 'ctx.1', receiptRef: 'receipt.1' }; }

describe('multi-agent competition', () => {
  it('isolates candidates and selects through an independent evaluator', async () => {
    const seen: string[][] = [];
    const output = await runCompetition(brief, { run: async (current, isolation) => { seen.push(isolation.cannotSeeCandidateIds); return result(isolation.candidateId, isolation.candidateId); } }, { evaluate: async (_brief, candidates) => candidates.map(candidate => ({ agentId: candidate.agentId, score: candidate.agentId === 'agent.2' ? 0.9 : 0.4, accepted: true, reasons: ['evidence fit'], evidenceRefs: [] })) });
    expect(output.selected?.agentId).toBe('agent.2');
    expect(seen).toEqual([['agent.2'], ['agent.1']]);
  });

  it('rejects malformed candidates and enforces the competition cost ceiling', async () => {
    const output = await runCompetition({ ...brief, maxCost: 1 }, { run: async (_current, isolation) => ({ ...result(isolation.candidateId, 'candidate'), cost: { money: 0.75 } }) }, { evaluate: async (_brief, candidates) => candidates.map(candidate => ({ agentId: candidate.agentId, score: 0.9, accepted: true, reasons: [], evidenceRefs: [] })) });
    expect(output.status).toBe('partial');
    expect(output.selected).toBeUndefined();
    await expect(runCompetition({ ...brief, participantAgentIds: ['agent.1', 'agent.1'] }, { run: async () => result('agent.1', 'candidate') }, { evaluate: async () => [] })).rejects.toThrow('unique');
  });
});

describe('bounded debate', () => {
  it('enforces participant and round limits', () => {
    const room: DebateRoom = { debateId: 'debate.1', taskId: 'task.1', contextVersion: 'ctx.1', participantAgentIds: ['agent.1'], maxRounds: 1, maxMessagesPerAgent: 1, maxTotalMessages: 1, messages: [] };
    const message = { schemaVersion: 'debate-message/1' as const, messageId: 'message.1', debateId: 'debate.1', round: 1, speakerAgentId: 'agent.1', type: 'position' as const, content: 'Position', claimRefs: [], contextVersion: 'ctx.1' };
    expect(appendDebateMessage(room, message).messages).toHaveLength(1);
    expect(() => appendDebateMessage(appendDebateMessage(room, message), message)).toThrow('message limit');
    expect(() => appendDebateMessage({ ...room, messages: [message] }, { ...message, messageId: 'message.2' })).toThrow('total message');
  });
});
