import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  appendDebateMessage,
  candidateScoreSchema,
  competitionBriefSchema,
  debateRoomSchema,
  type CandidateRunner,
  type CandidateScore,
  type CompetitionBrief,
  type DebateMessage,
  type DebateRoom,
  type IndependentEvaluator,
} from './collaboration.js';
import { resultEnvelopeSchema } from './protocol.js';

const id = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const isoDate = z.string().datetime({ offset: true });
const competitionStatus = z.enum(['collecting', 'running', 'evaluating', 'completed', 'partial', 'failed']);
const debateStatus = z.enum(['active', 'closed']);
const competitionAttemptSchema = z.object({
  id, participantAgentId: id, inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['started', 'completed', 'failed', 'reconciled']), startedAt: isoDate,
  endedAt: isoDate.optional(), error: z.string().max(4000).optional(), result: resultEnvelopeSchema.optional(),
}).strict();
const evaluatorAttemptSchema = z.object({
  id, inputHash: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['started', 'completed', 'failed']),
  startedAt: isoDate, endedAt: isoDate.optional(), error: z.string().max(4000).optional(), scores: z.array(candidateScoreSchema).max(12).optional(),
}).strict();

const competitionRecordSchema = z.object({
  schemaVersion: z.literal(1), id, brief: competitionBriefSchema, status: competitionStatus,
  candidates: z.array(resultEnvelopeSchema).max(12), scores: z.array(candidateScoreSchema).max(12),
  attempts: z.array(competitionAttemptSchema).max(12).default([]), evaluatorAttempt: evaluatorAttemptSchema.optional(),
  evaluatorAgentId: id.optional(), selectedAgentId: id.optional(), failureReason: z.string().max(4000).optional(), totalCost: z.number().nonnegative(),
  createdAt: isoDate, updatedAt: isoDate, completedAt: isoDate.optional(),
}).strict();
const debateRecordSchema = z.object({
  schemaVersion: z.literal(1), id, room: debateRoomSchema, status: debateStatus,
  createdAt: isoDate, updatedAt: isoDate, closedAt: isoDate.optional(), closeReason: z.string().max(4000).optional(),
}).strict();
const stateSchema = z.object({ competitions: z.array(competitionRecordSchema).max(1000), debates: z.array(debateRecordSchema).max(1000) }).strict();
const candidateInputSchema = resultEnvelopeSchema;
const debateInputSchema = z.object({
  taskId: id, contextVersion: id, goal: z.string().max(8000).optional(), participantAgentIds: z.array(id).min(1).max(12),
  context: z.object({ classification: z.enum(['public', 'internal', 'confidential', 'private']), claims: z.array(z.object({ id, text: z.string().min(1).max(4000), evidenceRefs: z.array(id).max(100) }).strict()).max(200), artifactRefs: z.array(id).max(200), redactions: z.array(z.string().max(500)).max(100) }).strict().optional(),
  maxRounds: z.number().int().min(1).max(12).default(4), maxMessagesPerAgent: z.number().int().min(1).max(20).default(4),
  maxTotalMessages: z.number().int().min(1).max(100).optional(),
}).strict();

export type CompetitionRecord = z.infer<typeof competitionRecordSchema>;
export type CompetitionAttempt = z.infer<typeof competitionAttemptSchema>;
export type DebateRecord = z.infer<typeof debateRecordSchema>;

export interface CollaborationRepository {
  createCompetition(record: CompetitionRecord): Promise<void>;
  getCompetition(id: string): Promise<CompetitionRecord>;
  listCompetitions(): Promise<CompetitionRecord[]>;
  mutateCompetition(id: string, change: (record: CompetitionRecord) => CompetitionRecord): Promise<CompetitionRecord>;
  createDebate(record: DebateRecord): Promise<void>;
  getDebate(id: string): Promise<DebateRecord>;
  listDebates(): Promise<DebateRecord[]>;
  mutateDebate(id: string, change: (record: DebateRecord) => DebateRecord): Promise<DebateRecord>;
  close(): Promise<void>;
}

export class CollaborationNotFound extends Error {}

/** Durable local collaboration state. A single writer owns the directory. */
export class FileCollaborationRepository implements CollaborationRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private lockPath: string;
  private statePath: string;

  constructor(private readonly directory: string) {
    this.lockPath = join(directory, '.writer.lock');
    this.statePath = join(directory, 'collaborations.json');
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const lock = await open(this.lockPath, 'wx', 0o600);
      await lock.writeFile(String(process.pid)); await lock.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(this.lockPath, 'utf8'));
      try { process.kill(pid, 0); throw new Error('Collaboration directory already has a live writer'); }
      catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
        await unlink(this.lockPath); return this.init();
      }
    }
    try { stateSchema.parse(JSON.parse(await readFile(this.statePath, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.save({ competitions: [], debates: [] });
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next;
  }

  private async load(): Promise<z.infer<typeof stateSchema>> {
    return stateSchema.parse(JSON.parse(await readFile(this.statePath, 'utf8')));
  }

  private async save(state: z.infer<typeof stateSchema>): Promise<void> {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.statePath);
    const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }

  createCompetition(record: CompetitionRecord): Promise<void> {
    return this.serial(async () => {
      const state = await this.load(); if (state.competitions.some(item => item.id === record.id)) throw new Error('Competition already exists');
      state.competitions.push(competitionRecordSchema.parse(record)); await this.save(state);
    });
  }

  async getCompetition(idValue: string): Promise<CompetitionRecord> {
    const item = (await this.load()).competitions.find(candidate => candidate.id === idValue);
    if (!item) throw new CollaborationNotFound('Unknown competition'); return item;
  }

  async listCompetitions(): Promise<CompetitionRecord[]> { return (await this.load()).competitions; }

  mutateCompetition(idValue: string, change: (record: CompetitionRecord) => CompetitionRecord): Promise<CompetitionRecord> {
    return this.serial(async () => {
      const state = await this.load(); const index = state.competitions.findIndex(item => item.id === idValue);
      if (index < 0) throw new CollaborationNotFound('Unknown competition');
      const next = competitionRecordSchema.parse(change(structuredClone(state.competitions[index]!)));
      state.competitions[index] = next; await this.save(state); return next;
    });
  }

  createDebate(record: DebateRecord): Promise<void> {
    return this.serial(async () => {
      const state = await this.load(); if (state.debates.some(item => item.id === record.id)) throw new Error('Debate already exists');
      state.debates.push(debateRecordSchema.parse(record)); await this.save(state);
    });
  }

  async getDebate(idValue: string): Promise<DebateRecord> {
    const item = (await this.load()).debates.find(debate => debate.id === idValue);
    if (!item) throw new CollaborationNotFound('Unknown debate'); return item;
  }

  async listDebates(): Promise<DebateRecord[]> { return (await this.load()).debates; }

  mutateDebate(idValue: string, change: (record: DebateRecord) => DebateRecord): Promise<DebateRecord> {
    return this.serial(async () => {
      const state = await this.load(); const index = state.debates.findIndex(item => item.id === idValue);
      if (index < 0) throw new CollaborationNotFound('Unknown debate');
      const next = debateRecordSchema.parse(change(structuredClone(state.debates[index]!)));
      state.debates[index] = next; await this.save(state); return next;
    });
  }

  async close(): Promise<void> { await this.queue; await unlink(this.lockPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}

export class CollaborationService {
  constructor(private readonly repository: CollaborationRepository) {}

  async createCompetition(input: unknown): Promise<CompetitionRecord> {
    const brief = competitionBriefSchema.parse(input);
    const now = new Date().toISOString();
    const record: CompetitionRecord = { schemaVersion: 1, id: `competition_${randomUUID()}`, brief, status: 'collecting', candidates: [], scores: [], attempts: [], totalCost: 0, createdAt: now, updatedAt: now };
    await this.repository.createCompetition(record); return record;
  }

  listCompetitions(): Promise<CompetitionRecord[]> { return this.repository.listCompetitions(); }
  getCompetition(idValue: string): Promise<CompetitionRecord> { return this.repository.getCompetition(idValue); }

  /** Returns the evaluator-facing view. Blind competitions never expose participant IDs here. */
  async getEvaluationView(idValue: string): Promise<CompetitionRecord> {
    const current = await this.repository.getCompetition(idValue);
    if (!current.brief.blindEvaluation) return current;
    const aliases = new Map(current.candidates.map((candidate, index) => [candidate.agentId, `candidate_${index + 1}`]));
    return {
      ...current,
      brief: { ...current.brief, participantAgentIds: current.brief.participantAgentIds.map((_agent, index) => `candidate_${index + 1}`) },
      candidates: current.candidates.map(candidate => ({ ...candidate, agentId: aliases.get(candidate.agentId)! })),
      scores: current.scores.map(score => ({ ...score, agentId: aliases.get(score.agentId) ?? score.agentId })),
      ...(current.selectedAgentId ? { selectedAgentId: aliases.get(current.selectedAgentId) ?? current.selectedAgentId } : {}),
    };
  }

  submitCandidate(idValue: string, input: unknown): Promise<CompetitionRecord> {
    return this.repository.mutateCompetition(idValue, current => {
      if (current.status !== 'collecting') throw new Error('Competition is no longer collecting candidates');
      const candidate = candidateInputSchema.parse(input);
      if (!current.brief.participantAgentIds.includes(candidate.agentId)) throw new Error('Candidate agent is not a participant');
      if (candidate.taskId !== current.brief.taskId || candidate.contextVersion !== current.brief.contextVersion || candidate.resultType !== current.brief.expectedResultType) throw new Error('Candidate is not bound to the competition brief');
      if (current.candidates.some(item => item.agentId === candidate.agentId)) throw new Error('Candidate already submitted');
      const now = new Date().toISOString(); const candidates = [...current.candidates, candidate];
      return { ...current, candidates, totalCost: candidates.reduce((sum, item) => sum + (item.cost.money ?? 0), 0), updatedAt: now };
    });
  }

  beginEvaluation(idValue: string, evaluatorAgentId: string): Promise<CompetitionRecord> {
    return this.repository.mutateCompetition(idValue, current => {
      if (current.status !== 'collecting') throw new Error('Competition is not collecting candidates');
      if (current.candidates.length === 0) throw new Error('Competition has no candidates');
      if (current.brief.participantAgentIds.includes(evaluatorAgentId)) throw new Error('Evaluator must be independent from participants');
      return { ...current, status: 'evaluating', evaluatorAgentId, updatedAt: new Date().toISOString() };
    });
  }

  submitScore(idValue: string, evaluatorAgentId: string, input: unknown): Promise<CompetitionRecord> {
    return this.repository.mutateCompetition(idValue, current => {
      if (current.status !== 'evaluating' || current.evaluatorAgentId !== evaluatorAgentId) throw new Error('Competition is not awaiting this evaluator');
      const score = candidateScoreSchema.parse(input);
      const aliases = new Map(current.candidates.map((candidate, index) => [`candidate_${index + 1}`, candidate.agentId]));
      const actualAgentId = current.brief.blindEvaluation ? aliases.get(score.agentId) : score.agentId;
      if (!actualAgentId) throw new Error('Score refers to an unknown candidate');
      if (!current.candidates.some(candidate => candidate.agentId === actualAgentId)) throw new Error('Score refers to an unknown candidate');
      if (current.scores.some(existing => existing.agentId === actualAgentId)) throw new Error('Candidate has already been scored');
      const scores = [...current.scores, { ...score, agentId: actualAgentId }];
      if (scores.length < current.candidates.length) return { ...current, scores, updatedAt: new Date().toISOString() };
      const overBudget = current.brief.maxCost !== undefined && current.totalCost > current.brief.maxCost;
      const selected = !overBudget ? scores.filter(item => item.accepted).sort((a, b) => b.score - a.score)[0] : undefined;
      const complete = current.candidates.length === current.brief.participantAgentIds.length && !overBudget;
      return { ...current, scores, status: complete ? 'completed' : 'partial', ...(selected ? { selectedAgentId: selected.agentId } : {}), completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    });
  }

  /**
   * Run an entire competition through isolated candidate runners and an
   * independent evaluator, while persisting every accepted candidate and
   * score. Candidate runners are invoked concurrently, but the evaluator only
   * receives the bounded, blind view produced by the domain workflow.
   */
  async runCompetition(idValue: string, evaluatorAgentId: string, runner: CandidateRunner, evaluator: IndependentEvaluator): Promise<CompetitionRecord> {
    const current = await this.repository.getCompetition(idValue);
    if (current.status === 'evaluating' && current.evaluatorAttempt?.state === 'started') return current;
    if (!['collecting', 'running'].includes(current.status)) throw new Error('Competition is no longer collecting candidates');
    if (current.brief.participantAgentIds.includes(evaluatorAgentId)) throw new Error('Evaluator must be independent from participants');
    try {
      await this.repository.mutateCompetition(idValue, record => ({ ...record, status: 'running', updatedAt: new Date().toISOString() }));
      for (const participantAgentId of current.brief.participantAgentIds) {
        const before = await this.repository.getCompetition(idValue);
        if (before.candidates.some(candidate => candidate.agentId === participantAgentId)) continue;
        const existing = before.attempts.find(attempt => attempt.participantAgentId === participantAgentId);
        if (existing?.state === 'started') return before;
        if (existing?.state === 'failed' || existing?.state === 'reconciled') continue;
        const attemptId = `attempt_${randomUUID()}`;
        const inputHash = createHash('sha256').update(JSON.stringify({ brief: before.brief, participantAgentId })).digest('hex');
        let reserved = false;
        await this.repository.mutateCompetition(idValue, record => {
          if (record.attempts.some(attempt => attempt.participantAgentId === participantAgentId && ['started', 'completed', 'reconciled'].includes(attempt.state))) return record;
          record.attempts.push({ id: attemptId, participantAgentId, inputHash, state: 'started', startedAt: new Date().toISOString() });
          reserved = true;
          return { ...record, status: 'running', updatedAt: new Date().toISOString() };
        });
        if (!reserved) continue;
        try {
          const candidate = resultEnvelopeSchema.parse(await runner.run(before.brief, { candidateId: participantAgentId, cannotSeeCandidateIds: before.brief.participantAgentIds.filter(id => id !== participantAgentId) }));
          if (candidate.agentId !== participantAgentId || candidate.taskId !== before.brief.taskId || candidate.contextVersion !== before.brief.contextVersion || candidate.resultType !== before.brief.expectedResultType) throw new Error('Candidate result is not bound to the competition brief');
          await this.repository.mutateCompetition(idValue, record => {
            const attempt = record.attempts.find(item => item.id === attemptId);
            if (!attempt || attempt.state !== 'started') return record;
            attempt.state = 'completed'; attempt.endedAt = new Date().toISOString(); attempt.result = candidate;
            if (!record.candidates.some(item => item.agentId === candidate.agentId)) {
              record.candidates.push(candidate); record.totalCost = record.candidates.reduce((sum, item) => sum + (item.cost.money ?? 0), 0);
            }
            return { ...record, updatedAt: new Date().toISOString() };
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Candidate runner failed';
          await this.repository.mutateCompetition(idValue, record => {
            const attempt = record.attempts.find(item => item.id === attemptId);
            if (attempt?.state === 'started') { attempt.state = 'failed'; attempt.endedAt = new Date().toISOString(); attempt.error = reason; }
            return { ...record, updatedAt: new Date().toISOString() };
          });
        }
      }
      const afterCandidates = await this.repository.getCompetition(idValue);
      if (afterCandidates.candidates.length === 0) return this.failCompetition(idValue, afterCandidates.attempts.map(attempt => attempt.error).filter(Boolean).slice(0, 3).join('; ') || 'No valid candidate completed the isolated run');
      const resultCandidates = afterCandidates.candidates;
      await this.repository.mutateCompetition(idValue, record => ({ ...record, status: 'collecting', updatedAt: new Date().toISOString() }));
      await this.beginEvaluation(idValue, evaluatorAgentId);
      const aliases = new Map(resultCandidates.map((candidate, index) => [candidate.agentId, `candidate_${index + 1}`]));
      const evaluationBrief = afterCandidates.brief.blindEvaluation ? { ...afterCandidates.brief, participantAgentIds: [...aliases.values()] } : afterCandidates.brief;
      const evaluationCandidates = afterCandidates.brief.blindEvaluation ? resultCandidates.map((candidate, index) => ({ ...candidate, agentId: `candidate_${index + 1}` })) : resultCandidates;
      const evaluatorAttemptId = `attempt_${randomUUID()}`;
      const evaluatorInputHash = createHash('sha256').update(JSON.stringify({ brief: evaluationBrief, candidates: evaluationCandidates })).digest('hex');
      await this.repository.mutateCompetition(idValue, record => ({ ...record, evaluatorAttempt: { id: evaluatorAttemptId, inputHash: evaluatorInputHash, state: 'started', startedAt: new Date().toISOString() }, updatedAt: new Date().toISOString() }));
      let rawScores: CandidateScore[];
      try {
        rawScores = await evaluator.evaluate(evaluationBrief, evaluationCandidates);
        await this.repository.mutateCompetition(idValue, record => ({ ...record, evaluatorAttempt: { ...record.evaluatorAttempt!, state: 'completed', endedAt: new Date().toISOString(), scores: rawScores }, updatedAt: new Date().toISOString() }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Evaluator failed';
        await this.repository.mutateCompetition(idValue, record => ({ ...record, evaluatorAttempt: { ...record.evaluatorAttempt!, state: 'failed', endedAt: new Date().toISOString(), error: reason }, updatedAt: new Date().toISOString() }));
        return this.failCompetition(idValue, `Competition evaluator failed: ${reason}`);
      }
      const viewScores = rawScores.map(score => ({ ...score, agentId: afterCandidates.brief.blindEvaluation ? aliases.get(score.agentId) ?? score.agentId : score.agentId }));
      let persisted = await this.repository.getCompetition(idValue);
      for (const score of viewScores) {
        if (persisted.status !== 'evaluating') break;
        persisted = await this.submitScore(idValue, evaluatorAgentId, score);
      }
      if (persisted.status === 'evaluating') return this.finalizePartialCompetition(idValue, 'Evaluator returned an incomplete score set');
      return persisted;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Competition runner or evaluator failed';
      return this.failCompetition(idValue, `Competition execution failed: ${reason}`);
    }
  }

  /** Resolve a participant attempt after a worker restart without calling the runner again. */
  async reconcileCompetitionAttempt(idValue: string, input: unknown): Promise<CompetitionRecord> {
    const body = z.object({ attemptId: id, outcome: z.enum(['completed', 'failed']), result: resultEnvelopeSchema.optional(), reason: z.string().trim().min(1).max(4000) }).strict().parse(input);
    return this.repository.mutateCompetition(idValue, current => {
      const attempt = current.attempts.find(item => item.id === body.attemptId);
      if (!attempt) throw new Error('Unknown competition attempt');
      if (attempt.state !== 'started') throw new Error(`Competition attempt is already ${attempt.state}`);
      if (body.outcome === 'completed') {
        if (!body.result || body.result.agentId !== attempt.participantAgentId || body.result.taskId !== current.brief.taskId || body.result.contextVersion !== current.brief.contextVersion || body.result.resultType !== current.brief.expectedResultType) throw new Error('Reconciled candidate result is not bound to the competition brief');
        attempt.result = body.result; attempt.state = 'reconciled';
        if (!current.candidates.some(candidate => candidate.agentId === body.result!.agentId)) { current.candidates.push(body.result); current.totalCost = current.candidates.reduce((sum, item) => sum + (item.cost.money ?? 0), 0); }
      } else { attempt.state = 'failed'; attempt.error = body.reason; }
      attempt.endedAt = new Date().toISOString();
      const stillStarted = current.attempts.some(item => item.state === 'started');
      return { ...current, status: stillStarted ? 'running' : 'collecting', updatedAt: new Date().toISOString() };
    });
  }

  /** Resolve an evaluator call after a worker restart without invoking the evaluator again. */
  async reconcileCompetitionEvaluator(idValue: string, input: unknown): Promise<CompetitionRecord> {
    const body = z.object({ attemptId: id, outcome: z.enum(['completed', 'failed']), scores: z.array(candidateScoreSchema).max(12).optional(), reason: z.string().trim().min(1).max(4000) }).strict().parse(input);
    const current = await this.repository.getCompetition(idValue);
    if (current.status !== 'evaluating' || !current.evaluatorAttempt || current.evaluatorAttempt.id !== body.attemptId || current.evaluatorAttempt.state !== 'started') throw new Error('Competition is not waiting for this evaluator reconciliation');
    if (body.outcome === 'failed') {
      await this.repository.mutateCompetition(idValue, record => ({ ...record, evaluatorAttempt: { ...record.evaluatorAttempt!, state: 'failed', endedAt: new Date().toISOString(), error: body.reason }, status: 'failed', failureReason: `Competition evaluator reconciliation failed: ${body.reason}`, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
      return this.repository.getCompetition(idValue);
    }
    if (!body.scores?.length) throw new Error('Completed evaluator reconciliation requires scores');
    await this.repository.mutateCompetition(idValue, record => ({ ...record, evaluatorAttempt: { ...record.evaluatorAttempt!, state: 'completed', endedAt: new Date().toISOString(), scores: body.scores }, updatedAt: new Date().toISOString() }));
    const persisted = await this.repository.getCompetition(idValue);
    const aliases = new Map(persisted.candidates.map((candidate, index) => [candidate.agentId, `candidate_${index + 1}`]));
    const viewScores = body.scores.map(score => ({ ...score, agentId: persisted.brief.blindEvaluation ? aliases.get(score.agentId) ?? score.agentId : score.agentId }));
    let result = await this.repository.getCompetition(idValue);
    for (const score of viewScores) {
      if (result.status !== 'evaluating') break;
      result = await this.submitScore(idValue, persisted.evaluatorAgentId!, score);
    }
    return result.status === 'evaluating' ? this.finalizePartialCompetition(idValue, 'Reconciled evaluator returned an incomplete score set') : result;
  }

  failCompetition(idValue: string, reason: string): Promise<CompetitionRecord> {
    const clean = z.string().trim().min(1).max(4000).parse(reason);
    return this.repository.mutateCompetition(idValue, current => ({ ...current, status: 'failed', failureReason: clean, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  }

  finalizePartialCompetition(idValue: string, reason: string): Promise<CompetitionRecord> {
    const clean = z.string().trim().min(1).max(4000).parse(reason);
    return this.repository.mutateCompetition(idValue, current => ({ ...current, status: 'partial', failureReason: clean, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  }

  async createDebate(input: unknown): Promise<DebateRecord> {
    const parsed = debateInputSchema.parse(input); const now = new Date().toISOString(); const idValue = `debate_${randomUUID()}`;
    const roomBase = { debateId: idValue, taskId: parsed.taskId, contextVersion: parsed.contextVersion, ...(parsed.goal === undefined ? {} : { goal: parsed.goal }), ...(parsed.context === undefined ? {} : { context: parsed.context }), participantAgentIds: parsed.participantAgentIds, maxRounds: parsed.maxRounds, maxMessagesPerAgent: parsed.maxMessagesPerAgent, messages: [] };
    const room: DebateRoom = parsed.maxTotalMessages === undefined
      ? debateRoomSchema.parse(roomBase)
      : debateRoomSchema.parse({ ...roomBase, maxTotalMessages: parsed.maxTotalMessages });
    const record: DebateRecord = { schemaVersion: 1, id: idValue, room, status: 'active', createdAt: now, updatedAt: now };
    await this.repository.createDebate(record); return record;
  }

  listDebates(): Promise<DebateRecord[]> { return this.repository.listDebates(); }
  getDebate(idValue: string): Promise<DebateRecord> { return this.repository.getDebate(idValue); }

  appendMessage(idValue: string, input: unknown): Promise<DebateRecord> {
    return this.repository.mutateDebate(idValue, current => {
      if (current.status !== 'active') throw new Error('Debate is closed');
      const room = appendDebateMessage(current.room, input as DebateMessage);
      return { ...current, room, updatedAt: new Date().toISOString() };
    });
  }

  closeDebate(idValue: string, reason: string): Promise<DebateRecord> {
    const clean = z.string().trim().min(1).max(4000).parse(reason);
    return this.repository.mutateDebate(idValue, current => {
      if (current.status !== 'active') throw new Error('Debate is already closed');
      const now = new Date().toISOString(); return { ...current, status: 'closed', closedAt: now, closeReason: clean, updatedAt: now };
    });
  }
}
