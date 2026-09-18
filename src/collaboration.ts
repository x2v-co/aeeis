import { z } from 'zod';
import { resultEnvelopeSchema, type ResultEnvelope } from './protocol.js';

const id = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const contextClaimSchema = z.object({ id, text: z.string().min(1).max(4000), evidenceRefs: z.array(id).max(100) }).strict();
export const competitionBriefSchema = z.object({
  schemaVersion: z.literal('competition-brief/1'), taskId: id, contextVersion: id, goal: z.string().min(1).max(8000),
  participantAgentIds: z.array(id).min(2).max(12), expectedResultType: z.string().min(1).max(200),
  context: z.object({ classification: z.enum(['public', 'internal', 'confidential', 'private']), claims: z.array(contextClaimSchema).max(200), artifactRefs: z.array(id).max(200), redactions: z.array(z.string().max(500)).max(100) }).strict().optional(),
  maxRounds: z.number().int().min(1).max(12), maxCost: z.number().nonnegative().optional(), blindEvaluation: z.boolean(),
}).strict();
export type CompetitionBrief = z.infer<typeof competitionBriefSchema>;
export interface CandidateScore { agentId: string; score: number; accepted: boolean; reasons: string[]; evidenceRefs: string[] }
export const candidateScoreSchema = z.object({
  agentId: id, score: z.number().min(0).max(1), accepted: z.boolean(),
  reasons: z.array(z.string().max(2000)).max(50), evidenceRefs: z.array(id).max(100),
}).strict();
export interface CompetitionResult { brief: CompetitionBrief; candidates: ResultEnvelope[]; scores: CandidateScore[]; selected?: ResultEnvelope; status: 'completed' | 'partial' | 'failed'; failureReason?: string }
export interface CandidateRunner { run(brief: CompetitionBrief, isolation: { candidateId: string; cannotSeeCandidateIds: string[] }): Promise<ResultEnvelope>; }
export interface IndependentEvaluator { evaluate(brief: CompetitionBrief, candidates: ReadonlyArray<ResultEnvelope>): Promise<CandidateScore[]>; }

export async function runCompetition(briefInput: CompetitionBrief, runner: CandidateRunner, evaluator: IndependentEvaluator): Promise<CompetitionResult> {
  const brief = competitionBriefSchema.parse(briefInput);
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
}).strict();
export type DebateMessage = z.infer<typeof debateMessageSchema>;
export const debateRoomSchema = z.object({
  debateId: id, taskId: id, contextVersion: id, participantAgentIds: z.array(id).min(1).max(12),
  goal: z.string().max(8000).optional(),
  context: z.object({ classification: z.enum(['public', 'internal', 'confidential', 'private']), claims: z.array(contextClaimSchema).max(200), artifactRefs: z.array(id).max(200), redactions: z.array(z.string().max(500)).max(100) }).strict().optional(),
  maxRounds: z.number().int().min(1).max(12), maxMessagesPerAgent: z.number().int().min(1).max(100),
  maxTotalMessages: z.number().int().min(1).max(1000).optional(), messages: z.array(debateMessageSchema).max(1000),
}).strict();
export interface DebateRoom { debateId: string; taskId: string; contextVersion: string; participantAgentIds: string[]; maxRounds: number; maxMessagesPerAgent: number; maxTotalMessages?: number | undefined; messages: DebateMessage[]; }

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
  return { ...room, messages: [...room.messages, message] };
}
