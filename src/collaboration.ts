import { z } from 'zod';
import { collaborationBudgetSchema, type CollaborationAccounting } from './collaboration-budget.js';
import { resultEnvelopeSchema, type ResultEnvelope } from './protocol.js';
import { channelIdentitySchema } from './security/channel-identity.js';

const id = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const isoDate = z.string().datetime({ offset: true });
const contextClaimSchema = z.object({ id, text: z.string().min(1).max(4000), evidenceRefs: z.array(id).max(100) }).strict();
export const competitionBriefSchema = z.object({
  schemaVersion: z.literal('competition-brief/1'), taskId: id, contextVersion: id, goal: z.string().min(1).max(8000),
  participantAgentIds: z.array(id).min(2).max(12), expectedResultType: z.string().min(1).max(200),
  context: z.object({ classification: z.enum(['public', 'internal', 'confidential', 'private']), claims: z.array(contextClaimSchema).max(200), artifactRefs: z.array(id).max(200), redactions: z.array(z.string().max(500)).max(100) }).strict().optional(),
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

export const debateMessageSchema = z.object({
  schemaVersion: z.literal('debate-message/1'), messageId: id, debateId: id, round: z.number().int().positive(), speakerAgentId: id,
  replyTo: id.optional(), type: z.enum(['position', 'evidence', 'challenge', 'rebuttal', 'clarification', 'concession', 'decision']),
  content: z.string().min(1).max(8000), claimRefs: z.array(id).max(100), contextVersion: id,
  origin: z.object({ channel: z.string().min(1).max(100), externalEventId: z.string().min(1).max(500), senderRef: z.string().min(1).max(500), receivedAt: isoDate, identity: channelIdentitySchema.optional() }).strict().optional(),
}).strict();
export type DebateMessage = z.infer<typeof debateMessageSchema>;
export const debateModerationSchema = z.object({
  messageId: id, status: z.enum(['accepted', 'flagged']), violations: z.array(z.string().max(500)).max(20),
  missingClaimRefs: z.array(id).max(100), checkedAt: isoDate,
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
  maxRounds: z.number().int().min(1).max(12), maxMessagesPerAgent: z.number().int().min(1).max(100),
  maxTotalMessages: z.number().int().min(1).max(1000).optional(), messages: z.array(debateMessageSchema).max(1000),
  moderation: z.array(debateModerationSchema).max(1000).default([]), moderatorReviews: z.array(debateModeratorReviewSchema).max(1000).default([]), adjudication: debateAdjudicationSchema.optional(),
}).strict();
export type DebateRoom = z.infer<typeof debateRoomSchema>;

/** Moderator policy: message claims may only point at context evidence or
 * source references in the admitted context. Prior messages cannot introduce
 * new authority. The message remains in
 * the event log when flagged so the room can be audited and adjudicated. */
export function moderateDebateMessage(room: DebateRoom, message: DebateMessage): DebateModeration {
  const allowed = new Set<string>([
    ...(room.context?.claims.map(claim => claim.id) ?? []),
    ...(room.context?.artifactRefs ?? []),
    ...(room.context?.claims.flatMap(claim => claim.evidenceRefs) ?? []),
  ]);
  const missingClaimRefs = [...new Set(message.claimRefs.filter(ref => !allowed.has(ref)))];
  const violations: string[] = [];
  if (missingClaimRefs.length) violations.push('message references evidence outside the Debate Context Pack');
  const evidenceBearingTypes = new Set(['evidence', 'challenge', 'rebuttal', 'concession', 'decision']);
  if (evidenceBearingTypes.has(message.type) && message.claimRefs.length === 0) {
    violations.push('evidence-bearing message must cite at least one claim or artifact');
  }
  return { messageId: message.messageId, status: violations.length ? 'flagged' : 'accepted', violations, missingClaimRefs, checkedAt: new Date().toISOString() };
}

/** Adjudicator policy: only a decision message that passed moderation can
 * close the room as decided. A missing or flagged decision is held for a
 * human or separately configured adjudicator. */
export function adjudicateDebate(room: DebateRoom): DebateAdjudication {
  const decisions = room.messages.filter(message => message.type === 'decision').reverse();
  const supported = decisions.find(message => isSupportedDebateDecision(room, message));
  if (supported) return {
    status: 'decided', decision: supported.content, rationale: 'The latest decision message passed the Moderator evidence policy.',
    selectedMessageId: supported.messageId, evidenceRefs: supported.claimRefs, decidedAt: new Date().toISOString(),
  };
  const flagged = decisions.find(message => !isSupportedDebateDecision(room, message));
  return {
    status: 'held', decision: 'No evidence-bound decision is available.',
    rationale: flagged ? 'A decision message was flagged by the Moderator and requires review.' : 'The debate ended without a decision message that passed moderation.',
    evidenceRefs: [], decidedAt: new Date().toISOString(),
  };
}

export function isSupportedDebateDecision(room: DebateRoom, message: DebateMessage): boolean {
  return message.type === 'decision' && moderateDebateMessage(room, message).status === 'accepted'
    && !(room.moderatorReviews ?? []).some(review => review.messageId === message.messageId
      && (review.status === 'flagged' || review.violations.length > 0 || review.missingClaimRefs.length > 0));
}

export function appendDebateMessage(room: DebateRoom, messageInput: DebateMessage): DebateRoom {
  const message = debateMessageSchema.parse(messageInput);
  if (message.debateId !== room.debateId || message.contextVersion !== room.contextVersion) throw new Error('Debate message is bound to another room or context');
  if (!room.participantAgentIds.includes(message.speakerAgentId)) throw new Error('Agent is not a debate participant');
  if (new Set(room.participantAgentIds).size !== room.participantAgentIds.length) throw new Error('Debate participants must be unique');
  if (message.round > room.maxRounds) throw new Error('Debate round limit reached');
  if (room.maxTotalMessages !== undefined && room.messages.length >= room.maxTotalMessages) throw new Error('Debate total message limit reached');
  if (room.messages.filter(item => item.speakerAgentId === message.speakerAgentId).length >= room.maxMessagesPerAgent) throw new Error('Agent message limit reached');
  if (room.messages.some(item => item.messageId === message.messageId)) throw new Error('Debate message already exists');
  if (message.replyTo && !room.messages.some(item => item.messageId === message.replyTo)) throw new Error('Debate reply target is missing');
  const moderation = moderateDebateMessage(room, message);
  return { ...room, messages: [...room.messages, message], moderation: [...(room.moderation ?? []), moderation] };
}
