import { z } from 'zod';
import { resultEnvelopeSchema, type ResultEnvelope } from './protocol.js';

const id = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
export const competitionBriefSchema = z.object({
  schemaVersion: z.literal('competition-brief/1'), taskId: id, contextVersion: id, goal: z.string().min(1).max(8000),
  participantAgentIds: z.array(id).min(2).max(12), expectedResultType: z.string().min(1).max(200),
  maxRounds: z.number().int().min(1).max(12), maxCost: z.number().nonnegative().optional(), blindEvaluation: z.boolean(),
}).strict();
export type CompetitionBrief = z.infer<typeof competitionBriefSchema>;
export interface CandidateScore { agentId: string; score: number; accepted: boolean; reasons: string[]; evidenceRefs: string[] }
export interface CompetitionResult { brief: CompetitionBrief; candidates: ResultEnvelope[]; scores: CandidateScore[]; selected?: ResultEnvelope; status: 'completed' | 'partial' | 'failed'; }
export interface CandidateRunner { run(brief: CompetitionBrief, isolation: { candidateId: string; cannotSeeCandidateIds: string[] }): Promise<ResultEnvelope>; }
export interface IndependentEvaluator { evaluate(brief: CompetitionBrief, candidates: ReadonlyArray<ResultEnvelope>): Promise<CandidateScore[]>; }

export async function runCompetition(briefInput: CompetitionBrief, runner: CandidateRunner, evaluator: IndependentEvaluator): Promise<CompetitionResult> {
  const brief = competitionBriefSchema.parse(briefInput);
  const settled = await Promise.allSettled(brief.participantAgentIds.map(agentId => runner.run(brief, { candidateId: agentId, cannotSeeCandidateIds: brief.participantAgentIds.filter(id => id !== agentId) })));
  const candidates = settled.flatMap(item => item.status === 'fulfilled' && resultEnvelopeSchema.safeParse(item.value).success ? [item.value] : []);
  if (candidates.length === 0) return { brief, candidates: [], scores: [], status: 'failed' };
  const scores = await evaluator.evaluate(brief, candidates);
  const validScores = scores.filter(score => candidates.some(candidate => candidate.agentId === score.agentId) && score.score >= 0 && score.score <= 1);
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
export interface DebateRoom { debateId: string; taskId: string; contextVersion: string; participantAgentIds: string[]; maxRounds: number; maxMessagesPerAgent: number; messages: DebateMessage[]; }

export function appendDebateMessage(room: DebateRoom, messageInput: DebateMessage): DebateRoom {
  const message = debateMessageSchema.parse(messageInput);
  if (message.debateId !== room.debateId || message.contextVersion !== room.contextVersion) throw new Error('Debate message is bound to another room or context');
  if (!room.participantAgentIds.includes(message.speakerAgentId)) throw new Error('Agent is not a debate participant');
  if (message.round > room.maxRounds) throw new Error('Debate round limit reached');
  if (room.messages.filter(item => item.speakerAgentId === message.speakerAgentId).length >= room.maxMessagesPerAgent) throw new Error('Agent message limit reached');
  if (message.replyTo && !room.messages.some(item => item.messageId === message.replyTo)) throw new Error('Debate reply target is missing');
  return { ...room, messages: [...room.messages, message] };
}
