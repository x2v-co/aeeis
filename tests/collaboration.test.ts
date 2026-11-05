import { describe, expect, it } from 'vitest';
import { adjudicateDebate, appendDebateMessage, debateGaps, debateIngressRound, debateMessageSchema, isSupportedDebateDecision, runCompetition } from '../src/collaboration.js';
import type { CompetitionBrief, DebateMessage, DebateRoom } from '../src/collaboration.js';

const brief: CompetitionBrief = { schemaVersion: 'competition-brief/1', taskId: 'task.1', contextVersion: 'ctx.1', goal: 'Choose a supported plan', participantAgentIds: ['agent.1', 'agent.2'], expectedResultType: 'plan/1', maxRounds: 2, blindEvaluation: true };
function result(agentId: string, summary: string) { return { schemaVersion: 'result-envelope/1' as const, taskId: 'task.1', agentId, status: 'completed' as const, resultType: 'plan/1', summary, claims: [], artifacts: [], unresolved: [], requestedFollowups: [], cost: {}, capabilitiesUsed: [], contextVersion: 'ctx.1', receiptRef: 'receipt.1' }; }

describe('multi-agent competition', () => {
  it('isolates candidates and selects through an independent evaluator', async () => {
    const seen: string[][] = [];
    const output = await runCompetition(brief, { run: async (current, isolation) => { seen.push(isolation.cannotSeeCandidateIds); return result(isolation.candidateId, isolation.candidateId); } }, { evaluate: async (currentBrief, candidates) => { expect(currentBrief.participantAgentIds).toEqual(['candidate_1', 'candidate_2']); expect(candidates.every(candidate => candidate.agentId.startsWith('candidate_'))).toBe(true); return candidates.map(candidate => ({ agentId: candidate.agentId, score: candidate.agentId === 'candidate_2' ? 0.9 : 0.4, accepted: true, reasons: ['evidence fit'], evidenceRefs: [] })); } });
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
    const open: DebateRoom = { debateId: 'debate.open', taskId: 'task.1', contextVersion: 'ctx.1', participantAgentIds: ['agent.1'], messages: [] };
    expect(appendDebateMessage(open, { ...message, debateId: 'debate.open', messageId: 'message.open', round: 30 }).messages).toHaveLength(1);
    expect(debateIngressRound(open)).toBe(1);
    expect(debateIngressRound({ ...open, maxRounds: 2, messages: [{ ...message, round: 5 }] })).toBe(2);
  });

  it('records Moderator evidence violations and holds unsupported decisions', () => {
    const room: DebateRoom = {
      debateId: 'debate.evidence', taskId: 'task.1', contextVersion: 'ctx.1', participantAgentIds: ['agent.1'],
      maxRounds: 1, maxMessagesPerAgent: 2, messages: [], moderation: [],
      context: { classification: 'internal', claims: [{ id: 'claim.one', text: 'Supported fact', evidenceRefs: ['claim.one'] }], artifactRefs: ['artifact.one'], redactions: [], },
    };
    const flagged = appendDebateMessage(room, { schemaVersion: 'debate-message/1', messageId: 'message.bad', debateId: 'debate.evidence', round: 1, speakerAgentId: 'agent.1', type: 'decision', content: 'Unsupported decision', claimRefs: ['claim.missing'], contextVersion: 'ctx.1' });
    expect(flagged.moderation?.at(-1)).toMatchObject({ status: 'flagged', missingClaimRefs: ['claim.missing'] });
    expect(adjudicateDebate(flagged).status).toBe('held');
    const supported = appendDebateMessage(room, { schemaVersion: 'debate-message/1', messageId: 'message.good', debateId: 'debate.evidence', round: 1, speakerAgentId: 'agent.1', type: 'decision', content: 'Supported decision', claimRefs: ['claim.one'], contextVersion: 'ctx.1' });
    expect(adjudicateDebate(supported)).toMatchObject({ status: 'decided', selectedMessageId: 'message.good', evidenceRefs: ['claim.one'] });
  });
});

describe('debate trust levels and information gaps', () => {
  const room: DebateRoom = {
    debateId: 'debate.gaps', taskId: 'task.1', contextVersion: 'ctx.1', participantAgentIds: ['agent.1', 'agent.2'], messages: [], moderation: [],
    context: { classification: 'internal', claims: [{ id: 'claim.ci', text: 'CI run 412 passed', evidenceRefs: ['source.ci'] }], artifactRefs: ['artifact.plan'], redactions: [] },
  };
  let counter = 0;
  const say = (speakerAgentId: string, fields: Partial<DebateMessage> & Pick<DebateMessage, 'type'>): DebateMessage => ({
    schemaVersion: 'debate-message/1', messageId: `message.${++counter}`, debateId: 'debate.gaps', round: 1, speakerAgentId, content: 'text', claimRefs: [], contextVersion: 'ctx.1', ...fields,
  });
  const append = (current: DebateRoom, message: DebateMessage) => appendDebateMessage(current, message);
  const last = (current: DebateRoom) => current.moderation!.at(-1)!;

  it('assigns trust levels itself and never lets a citation raise one', () => {
    // A message cannot carry its own trust level.
    expect(() => debateMessageSchema.parse({ ...say('agent.1', { type: 'position' }), authority: 'context' })).toThrow();
    let current = append(room, say('agent.1', { type: 'position', content: 'Ship it', claimRefs: [] }));
    expect(last(current)).toMatchObject({ status: 'accepted', authority: 'asserted', claimAuthority: [] });
    const position = current.messages.at(-1)!.messageId;
    // Citing a prior message is only asserted, so it cannot carry evidence on its own.
    current = append(current, say('agent.2', { type: 'evidence', content: 'As agent.1 said', claimRefs: [position] }));
    expect(last(current)).toMatchObject({ status: 'flagged', authority: 'asserted', claimAuthority: [{ ref: position, authority: 'asserted' }] });
    expect(last(current).violations).toContain('evidence-bearing message must cite at least one context or observed claim or artifact');
    // Context Pack claims, their evidence and artifacts are context.
    current = append(current, say('agent.2', { type: 'evidence', claimRefs: ['claim.ci', 'source.ci', 'artifact.plan', position] }));
    expect(last(current)).toMatchObject({ status: 'accepted', authority: 'context' });
    expect(last(current).claimAuthority).toEqual([{ ref: 'claim.ci', authority: 'context' }, { ref: 'source.ci', authority: 'context' }, { ref: 'artifact.plan', authority: 'context' }, { ref: position, authority: 'asserted' }]);
    // Only the context-level references of a decision become adjudication evidence.
    current = append(current, say('agent.1', { type: 'decision', claimRefs: ['claim.ci', position] }));
    expect(adjudicateDebate(current)).toMatchObject({ status: 'decided', evidenceRefs: ['claim.ci'] });
  });

  it('opens, answers and resolves gaps only through valid transitions', () => {
    let current = append(room, say('agent.1', { type: 'gap', content: 'To judge the release I need the CI result', gap: { question: 'Did CI pass?', impact: 'A failing CI blocks the release' } }));
    const gapId = current.messages.at(-1)!.messageId;
    expect(debateGaps(current)).toEqual([expect.objectContaining({ gapId, raisedBy: 'agent.1', state: 'open', answeredBy: [] })]);
    // Only the raiser closes, and only once the gap is answered.
    current = append(current, say('agent.1', { type: 'clarification', gapRef: { gapId, resolution: 'closed' } }));
    expect(last(current).violations).toContain('a gap can be closed only after it is answered');
    // In this phase an observation cites only the Context Pack.
    const earlier = current.messages[0]!.messageId;
    current = append(current, say('agent.2', { type: 'observation', gapRef: { gapId }, claimRefs: ['claim.ci', earlier] }));
    expect(last(current).violations).toContain('an observation may cite only Debate Context Pack evidence in this phase');
    expect(debateGaps(current)[0]!.state).toBe('open');
    current = append(current, say('agent.2', { type: 'observation', gapRef: { gapId }, claimRefs: ['claim.ci'] }));
    const answer = current.messages.at(-1)!.messageId;
    expect(last(current).status).toBe('accepted');
    expect(debateGaps(current)[0]).toMatchObject({ state: 'answered', answeredBy: [answer] });
    current = append(current, say('agent.2', { type: 'clarification', gapRef: { gapId, resolution: 'closed' } }));
    expect(last(current).violations).toContain('only the agent that raised a gap can resolve it');
    current = append(current, say('agent.1', { type: 'concession', gapRef: { gapId, resolution: 'closed' }, claimRefs: ['claim.ci'] }));
    expect(last(current).status).toBe('accepted');
    expect(debateGaps(current)[0]).toMatchObject({ state: 'closed', resolvedBy: current.messages.at(-1)!.messageId });
    current = append(current, say('agent.2', { type: 'observation', gapRef: { gapId }, claimRefs: ['claim.ci'] }));
    expect(last(current).violations).toContain('gap is already resolved');
    current = append(current, say('agent.2', { type: 'observation', gapRef: { gapId: 'message.unknown' }, claimRefs: ['claim.ci'] }));
    expect(last(current).violations).toContain('message points at an unknown gap');
    // Flagged messages never changed the ledger.
    expect(debateGaps(current)[0]).toMatchObject({ state: 'closed', answeredBy: [answer] });
  });

  it('lets the raiser mark an open gap unresolvable', () => {
    let current = append(room, say('agent.1', { type: 'gap', gap: { question: 'What did legal say?', impact: 'Legal can block launch', query: 'Ask legal' } }));
    const gapId = current.messages.at(-1)!.messageId;
    current = append(current, say('agent.1', { type: 'position', gapRef: { gapId, resolution: 'unresolvable' } }));
    expect(debateGaps(current)[0]).toMatchObject({ state: 'unresolvable', query: 'Ask legal' });
  });

  it('rejects malformed gap messages before they reach the room', () => {
    expect(() => debateMessageSchema.parse(say('agent.1', { type: 'gap' }))).toThrow('carries gap details');
    expect(() => debateMessageSchema.parse(say('agent.1', { type: 'position', gap: { question: 'q', impact: 'i' } }))).toThrow('carries gap details');
    expect(() => debateMessageSchema.parse(say('agent.1', { type: 'observation', claimRefs: ['claim.ci'] }))).toThrow('answers one gap');
    expect(() => debateMessageSchema.parse(say('agent.1', { type: 'observation', gapRef: { gapId: 'g', resolution: 'closed' } }))).toThrow('answers one gap');
    expect(() => debateMessageSchema.parse(say('agent.1', { type: 'position', gapRef: { gapId: 'g' } }))).toThrow('Only an observation');
    expect(() => debateMessageSchema.parse(say('agent.1', { type: 'gap', gap: { question: 'q', impact: 'i' }, gapRef: { gapId: 'g', resolution: 'closed' } }))).toThrow('cannot point at another gap');
  });

  it('judges a decision against the room it was sent into, not the room after it', () => {
    let current = append(room, say('agent.1', { type: 'gap', gap: { question: 'Did CI pass?', impact: 'Blocks release' } }));
    const gapId = current.messages.at(-1)!.messageId;
    current = append(current, say('agent.2', { type: 'observation', gapRef: { gapId }, claimRefs: ['claim.ci'] }));
    current = append(current, say('agent.1', { type: 'decision', gapRef: { gapId, resolution: 'closed' }, claimRefs: ['claim.ci'] }));
    const decision = current.messages.at(-1)!;
    current = append(current, say('agent.2', { type: 'position', claimRefs: [] }));
    // Rechecked against the full room the gap would already be closed.
    expect(isSupportedDebateDecision(current, decision)).toBe(true);
    expect(adjudicateDebate(current)).toMatchObject({ status: 'decided', selectedMessageId: decision.messageId });
  });
});
