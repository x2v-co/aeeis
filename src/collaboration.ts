import { z } from 'zod';
import { collaborationBudgetSchema, type CollaborationAccounting } from './collaboration-budget.js';
import { resultEnvelopeSchema, type ResultEnvelope } from './protocol.js';
import { channelIdentitySchema } from './security/channel-identity.js';

const id = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const isoDate = z.string().datetime({ offset: true });
const contextClaimSchema = z.object({ id, text: z.string().min(1).max(4000), evidenceRefs: z.array(id).max(100) }).strict();
/** Text that arrived from an outside channel. It is untrusted data, never the
 * goal or evidence: participants may weigh it but must not follow it. */
export const externalInputSchema = z.object({
  channel: z.enum(['feishu', 'hermes']), messageId: id, senderAgentId: id, text: z.string().min(1).max(8000), receivedAt: isoDate,
}).strict();
export type ExternalInput = z.infer<typeof externalInputSchema>;
export const competitionBriefSchema = z.object({
  schemaVersion: z.literal('competition-brief/1'), taskId: id, contextVersion: id, goal: z.string().min(1).max(8000),
  participantAgentIds: z.array(id).min(2).max(12), expectedResultType: z.string().min(1).max(200),
  context: z.object({ classification: z.enum(['public', 'internal', 'confidential', 'private']), claims: z.array(contextClaimSchema).max(200), artifactRefs: z.array(id).max(200), redactions: z.array(z.string().max(500)).max(100) }).strict().optional(),
  externalInput: externalInputSchema.optional(),
  modelBudget: collaborationBudgetSchema.optional(),
  maxRounds: z.number().int().min(1).max(12), maxCost: z.number().nonnegative().optional(), blindEvaluation: z.boolean(),
}).strict();
export type CompetitionBrief = z.infer<typeof competitionBriefSchema>;
export interface CandidateScore { agentId: string; score: number; accepted: boolean; reasons: string[]; evidenceRefs: string[] }
export const candidateScoreSchema = z.object({
  agentId: id, score: z.number().min(0).max(1), accepted: z.boolean(),
  reasons: z.array(z.string().max(2000)).max(50), evidenceRefs: z.array(id).max(100),
}).strict();
export interface CompetitionResult { brief: CompetitionBrief; candidates: ResultEnvelope[]; scores: CandidateScore[]; selected?: ResultEnvelope; status: 'completed' | 'partial' | 'failed'; failureReason?: string }
export interface CandidateRunner { run(brief: CompetitionBrief, isolation: { candidateId: string; cannotSeeCandidateIds: string[] }, accounting?: CollaborationAccounting): Promise<ResultEnvelope>; }
export interface IndependentEvaluator { evaluate(brief: CompetitionBrief, candidates: ReadonlyArray<ResultEnvelope>, accounting?: CollaborationAccounting): Promise<CandidateScore[]>; }

export async function runCompetition(briefInput: CompetitionBrief, runner: CandidateRunner, evaluator: IndependentEvaluator): Promise<CompetitionResult> {
  const brief = competitionBriefSchema.parse(briefInput);
  if (brief.modelBudget) throw new Error('Budgeted competitions require the durable CollaborationService');
  if (new Set(brief.participantAgentIds).size !== brief.participantAgentIds.length) throw new Error('Competition participants must be unique');
  const settled = await Promise.allSettled(brief.participantAgentIds.map(agentId => runner.run(brief, { candidateId: agentId, cannotSeeCandidateIds: brief.participantAgentIds.filter(id => id !== agentId) })));
  const failures = settled.flatMap(item => item.status === 'rejected' ? [item.reason instanceof Error ? item.reason.message : 'candidate runner failed'] : []);
  const candidates = settled.flatMap((item, index) => {
    if (item.status !== 'fulfilled') return [];
    const parsed = resultEnvelopeSchema.safeParse(item.value);
    if (!parsed.success) return [];
    const expectedAgentId = brief.participantAgentIds[index]!;
    const candidate = parsed.data;
    if (candidate.agentId !== expectedAgentId || candidate.taskId !== brief.taskId || candidate.contextVersion !== brief.contextVersion || candidate.resultType !== brief.expectedResultType) return [];
    return [candidate];
  });
  if (candidates.length === 0) return { brief, candidates: [], scores: [], status: 'failed', failureReason: failures.length ? `No valid candidate completed the isolated run: ${failures.slice(0, 3).join('; ')}` : 'No valid candidate completed the isolated run' };
  const aliases = new Map(candidates.map((candidate, index) => [`candidate_${index + 1}`, candidate.agentId]));
  const evaluationBrief = brief.blindEvaluation
    ? { ...brief, participantAgentIds: [...aliases.keys()] }
    : brief;
  const evaluationCandidates = brief.blindEvaluation
    ? candidates.map((candidate, index) => ({ ...candidate, agentId: `candidate_${index + 1}` }))
    : candidates;
  const rawScores = await evaluator.evaluate(evaluationBrief, evaluationCandidates);
  const scores = rawScores.map(score => ({ ...score, agentId: aliases.get(score.agentId) ?? score.agentId }));
  const candidateIds = new Set(candidates.map(candidate => candidate.agentId));
  const seenScores = new Set<string>();
  const validScores = scores.filter(score => {
    if (!candidateIds.has(score.agentId) || seenScores.has(score.agentId) || score.score < 0 || score.score > 1) return false;
    seenScores.add(score.agentId); return true;
  });
  const totalMoney = candidates.reduce((sum, candidate) => sum + (candidate.cost.money ?? 0), 0);
  if (brief.maxCost !== undefined && totalMoney > brief.maxCost) return { brief, candidates, scores: validScores, status: 'partial' };
  const selectedScore = validScores.filter(score => score.accepted).sort((a, b) => b.score - a.score)[0];
  const selected = selectedScore ? candidates.find(candidate => candidate.agentId === selectedScore.agentId) : undefined;
  return { brief, candidates, scores: validScores, ...(selected ? { selected } : {}), status: validScores.length === candidates.length ? 'completed' : 'partial' };
}

export const debateMessageTypes = ['position', 'evidence', 'challenge', 'rebuttal', 'clarification', 'concession', 'decision', 'gap', 'observation'] as const;
/** What a gap asks: the information needed, why it changes the conclusion,
 * and optionally how it could be found. */
export const debateGapSchema = z.object({
  question: z.string().trim().min(1).max(2000), impact: z.string().trim().min(1).max(2000), query: z.string().trim().min(1).max(2000).optional(),
}).strict();
/** Points a message at a gap. An `observation` answers it (no resolution);
 * the agent that raised the gap resolves it from any other message. */
export const debateGapRefSchema = z.object({ gapId: id, resolution: z.enum(['closed', 'unresolvable']).optional() }).strict();
export const debateMessageSchema = z.object({
  schemaVersion: z.literal('debate-message/1'), messageId: id, debateId: id, round: z.number().int().positive(), speakerAgentId: id,
  replyTo: id.optional(), type: z.enum(debateMessageTypes),
  content: z.string().min(1).max(8000), claimRefs: z.array(id).max(100), contextVersion: id,
  gap: debateGapSchema.optional(), gapRef: debateGapRefSchema.optional(),
  origin: z.object({ channel: z.string().min(1).max(100), externalEventId: z.string().min(1).max(500), senderRef: z.string().min(1).max(500), receivedAt: isoDate, identity: channelIdentitySchema.optional() }).strict().optional(),
}).strict().superRefine((message, context) => {
  if ((message.type === 'gap') !== (message.gap !== undefined)) context.addIssue({ code: 'custom', path: ['gap'], message: 'A gap message, and only a gap message, carries gap details' });
  if (message.type === 'gap' && message.gapRef) context.addIssue({ code: 'custom', path: ['gapRef'], message: 'A gap message cannot point at another gap' });
  if (message.type === 'observation' && (!message.gapRef || message.gapRef.resolution)) context.addIssue({ code: 'custom', path: ['gapRef'], message: 'An observation answers one gap and does not resolve it' });
  if (message.type !== 'observation' && message.gapRef && !message.gapRef.resolution) context.addIssue({ code: 'custom', path: ['gapRef'], message: 'Only an observation can answer a gap; other messages may only resolve one' });
});
export type DebateMessage = z.infer<typeof debateMessageSchema>;
/** Trust levels, highest first. AEEIS assigns them from what a reference
 * resolves to; a message cannot state its own. `observed` (AEEIS tool
 * receipts) and `reported` (external Agent findings) arrive with tools. */
export const debateAuthorities = ['context', 'observed', 'reported', 'asserted'] as const;
export type DebateAuthority = typeof debateAuthorities[number];
const debateAuthoritySchema = z.enum(debateAuthorities);
export const debateModerationSchema = z.object({
  messageId: id, status: z.enum(['accepted', 'flagged']), violations: z.array(z.string().max(500)).max(20),
  missingClaimRefs: z.array(id).max(100), checkedAt: isoDate,
  // Absent on moderation recorded before trust levels existed.
  authority: debateAuthoritySchema.optional(),
  claimAuthority: z.array(z.object({ ref: id, authority: debateAuthoritySchema }).strict()).max(100).optional(),
}).strict();
export type DebateModeration = z.infer<typeof debateModerationSchema>;
export const debateModeratorReviewSchema = z.object({
  messageId: id, reviewerAgentId: id, status: z.enum(['accepted', 'flagged']), violations: z.array(z.string().max(500)).max(20),
  missingClaimRefs: z.array(id).max(100), reviewedAt: isoDate,
}).strict();
export type DebateModeratorReview = z.infer<typeof debateModeratorReviewSchema>;
export const debateAdjudicationSchema = z.object({
  status: z.enum(['decided', 'held']), decision: z.string().min(1).max(8000), rationale: z.string().min(1).max(8000),
  selectedMessageId: id.optional(), evidenceRefs: z.array(id).max(100), decidedAt: isoDate, adjudicatorAgentId: id.optional(),
}).strict();
export type DebateAdjudication = z.infer<typeof debateAdjudicationSchema>;
export const debateRoomSchema = z.object({
  debateId: id, taskId: id, contextVersion: id, participantAgentIds: z.array(id).min(1).max(12),
  goal: z.string().max(8000).optional(),
  context: z.object({ classification: z.enum(['public', 'internal', 'confidential', 'private']), claims: z.array(contextClaimSchema).max(200), artifactRefs: z.array(id).max(200), redactions: z.array(z.string().max(500)).max(100) }).strict().optional(),
  externalInput: externalInputSchema.optional(),
  maxRounds: z.number().int().min(1).optional(), maxMessagesPerAgent: z.number().int().min(1).optional(),
  maxTotalMessages: z.number().int().min(1).max(1000).optional(), messages: z.array(debateMessageSchema).max(1000),
  moderation: z.array(debateModerationSchema).max(1000).default([]), moderatorReviews: z.array(debateModeratorReviewSchema).max(1000).default([]), adjudication: debateAdjudicationSchema.optional(),
}).strict();
export type DebateRoom = z.infer<typeof debateRoomSchema>;

/** The trust level of one reference, or undefined when it resolves to
 * nothing in the room. Context Pack claims, artifacts and their evidence are
 * `context`. A prior message is only `asserted`: citing it never raises it. */
export function debateClaimAuthority(room: DebateRoom, ref: string): DebateAuthority | undefined {
  const context = room.context;
  if (context && (context.claims.some(claim => claim.id === ref || claim.evidenceRefs.includes(ref)) || context.artifactRefs.includes(ref))) return 'context';
  if (room.messages.some(message => message.messageId === ref)) return 'asserted';
  return undefined;
}

const supportingAuthorities = new Set<DebateAuthority>(['context', 'observed']);
const evidenceBearingTypes = new Set<DebateMessage['type']>(['evidence', 'challenge', 'rebuttal', 'concession', 'decision', 'observation']);

export type DebateGapState = 'open' | 'answered' | 'closed' | 'unresolvable';
export interface DebateGap {
  /** The messageId of the gap message, so AEEIS, not the Agent, names it. */
  gapId: string; raisedBy: string; round: number; question: string; impact: string; query?: string | undefined;
  state: DebateGapState; answeredBy: string[]; resolvedBy?: string;
}

/** The gap ledger, derived from messages that passed the Moderator policy.
 * Flagged messages stay in the log but never change a gap. */
export function debateGaps(room: DebateRoom): DebateGap[] {
  const accepted = new Set((room.moderation ?? []).filter(item => item.status === 'accepted').map(item => item.messageId));
  const gaps = new Map<string, DebateGap>();
  for (const message of room.messages) {
    if (!accepted.has(message.messageId)) continue;
    if (message.type === 'gap' && message.gap) {
      gaps.set(message.messageId, { gapId: message.messageId, raisedBy: message.speakerAgentId, round: message.round, ...message.gap, state: 'open', answeredBy: [] });
      continue;
    }
    const gap = message.gapRef ? gaps.get(message.gapRef.gapId) : undefined;
    if (!gap || !message.gapRef) continue;
    if (message.type === 'observation') { gap.answeredBy.push(message.messageId); if (gap.state === 'open') gap.state = 'answered'; }
    else if (message.gapRef.resolution) { gap.state = message.gapRef.resolution; gap.resolvedBy = message.messageId; }
  }
  return [...gaps.values()];
}

/** The room as it stood before a message, which is what that message was
 * moderated against. */
export function debateRoomBefore(room: DebateRoom, messageId: string): DebateRoom {
  const index = room.messages.findIndex(message => message.messageId === messageId);
  if (index < 0) return room;
  const earlier = new Set(room.messages.slice(0, index).map(message => message.messageId));
  return { ...room, messages: room.messages.slice(0, index), moderation: (room.moderation ?? []).filter(item => earlier.has(item.messageId)) };
}

/** Moderator policy, run by AEEIS on every message against the room before
 * it. It assigns each reference its trust level, requires evidence-bearing
 * messages to cite context (or, later, observed) evidence, and checks gap
 * transitions. In this phase an observation may cite only the Context Pack.
 * A flagged message stays in the event log so the room can be audited and
 * adjudicated. */
export function moderateDebateMessage(room: DebateRoom, message: DebateMessage): DebateModeration {
  const claimAuthority: Array<{ ref: string; authority: DebateAuthority }> = [];
  const missing: string[] = [];
  for (const ref of new Set(message.claimRefs)) {
    const authority = debateClaimAuthority(room, ref);
    if (authority) claimAuthority.push({ ref, authority }); else missing.push(ref);
  }
  const authority = debateAuthorities.find(level => claimAuthority.some(item => item.authority === level)) ?? 'asserted';
  const violations: string[] = [];
  if (missing.length) violations.push('message references evidence outside the Debate Context Pack and this room');
  if (evidenceBearingTypes.has(message.type) && !claimAuthority.some(item => supportingAuthorities.has(item.authority))) {
    violations.push('evidence-bearing message must cite at least one context or observed claim or artifact');
  }
  if (message.type === 'observation' && claimAuthority.some(item => item.authority !== 'context')) {
    violations.push('an observation may cite only Debate Context Pack evidence in this phase');
  }
  if (message.gapRef) {
    const gap = debateGaps(room).find(item => item.gapId === message.gapRef!.gapId);
    if (!gap) violations.push('message points at an unknown gap');
    else if (gap.state === 'closed' || gap.state === 'unresolvable') violations.push('gap is already resolved');
    else if (message.gapRef.resolution) {
      if (gap.raisedBy !== message.speakerAgentId) violations.push('only the agent that raised a gap can resolve it');
      else if (message.gapRef.resolution === 'closed' && gap.state !== 'answered') violations.push('a gap can be closed only after it is answered');
    }
  }
  return { messageId: message.messageId, status: violations.length ? 'flagged' : 'accepted', violations, missingClaimRefs: missing, checkedAt: new Date().toISOString(), authority, claimAuthority };
}

/** The references of a message that can support a conclusion. */
export function debateSupportRefs(room: DebateRoom, message: DebateMessage): string[] {
  const before = debateRoomBefore(room, message.messageId);
  return [...new Set(message.claimRefs)].filter(ref => supportingAuthorities.has(debateClaimAuthority(before, ref) ?? 'asserted'));
}

/** Adjudicator policy: only a decision message that passed moderation can
 * close the room as decided, and only its context or observed references
 * count as evidence. A missing or flagged decision is held for a human or
 * separately configured adjudicator. */
export function adjudicateDebate(room: DebateRoom): DebateAdjudication {
  const decisions = room.messages.filter(message => message.type === 'decision').reverse();
  const supported = decisions.find(message => isSupportedDebateDecision(room, message));
  if (supported) return {
    status: 'decided', decision: supported.content, rationale: 'The latest decision message passed the Moderator evidence policy.',
    selectedMessageId: supported.messageId, evidenceRefs: debateSupportRefs(room, supported), decidedAt: new Date().toISOString(),
  };
  const flagged = decisions.find(message => !isSupportedDebateDecision(room, message));
  return {
    status: 'held', decision: 'No evidence-bound decision is available.',
    rationale: flagged ? 'A decision message was flagged by the Moderator and requires review.' : 'The debate ended without a decision message that passed moderation.',
    evidenceRefs: [], decidedAt: new Date().toISOString(),
  };
}

export function isSupportedDebateDecision(room: DebateRoom, message: DebateMessage): boolean {
  return message.type === 'decision' && moderateDebateMessage(debateRoomBefore(room, message.messageId), message).status === 'accepted'
    && !(room.moderatorReviews ?? []).some(review => review.messageId === message.messageId
      && (review.status === 'flagged' || review.violations.length > 0 || review.missingClaimRefs.length > 0));
}

export function debateIngressRound(room: DebateRoom, requested?: number): number {
  if (requested !== undefined) return requested;
  const highest = room.messages.reduce((max, message) => Math.max(max, message.round), 0);
  const round = Math.max(1, highest);
  return room.maxRounds === undefined ? round : Math.min(room.maxRounds, round);
}

export function appendDebateMessage(room: DebateRoom, messageInput: DebateMessage): DebateRoom {
  const message = debateMessageSchema.parse(messageInput);
  if (message.debateId !== room.debateId || message.contextVersion !== room.contextVersion) throw new Error('Debate message is bound to another room or context');
  if (!room.participantAgentIds.includes(message.speakerAgentId)) throw new Error('Agent is not a debate participant');
  if (new Set(room.participantAgentIds).size !== room.participantAgentIds.length) throw new Error('Debate participants must be unique');
  if (room.maxRounds !== undefined && message.round > room.maxRounds) throw new Error('Debate round limit reached');
  if (room.maxTotalMessages !== undefined && room.messages.length >= room.maxTotalMessages) throw new Error('Debate total message limit reached');
  if (room.maxMessagesPerAgent !== undefined && room.messages.filter(item => item.speakerAgentId === message.speakerAgentId).length >= room.maxMessagesPerAgent) throw new Error('Agent message limit reached');
  if (room.messages.some(item => item.messageId === message.messageId)) throw new Error('Debate message already exists');
  if (message.replyTo && !room.messages.some(item => item.messageId === message.replyTo)) throw new Error('Debate reply target is missing');
  const moderation = moderateDebateMessage(room, message);
  return { ...room, messages: [...room.messages, message], moderation: [...(room.moderation ?? []), moderation] };
}
