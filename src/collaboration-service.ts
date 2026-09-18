import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  appendDebateMessage,
  candidateScoreSchema,
  competitionBriefSchema,
  debateRoomSchema,
  type CandidateScore,
  type CompetitionBrief,
  type DebateMessage,
  type DebateRoom,
} from './collaboration.js';
import { resultEnvelopeSchema } from './protocol.js';

const id = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const isoDate = z.string().datetime({ offset: true });
const competitionStatus = z.enum(['collecting', 'evaluating', 'completed', 'partial', 'failed']);
const debateStatus = z.enum(['active', 'closed']);

const competitionRecordSchema = z.object({
  schemaVersion: z.literal(1), id, brief: competitionBriefSchema, status: competitionStatus,
  candidates: z.array(resultEnvelopeSchema).max(12), scores: z.array(candidateScoreSchema).max(12),
  evaluatorAgentId: id.optional(), selectedAgentId: id.optional(), totalCost: z.number().nonnegative(),
  createdAt: isoDate, updatedAt: isoDate, completedAt: isoDate.optional(),
}).strict();
const debateRecordSchema = z.object({
  schemaVersion: z.literal(1), id, room: debateRoomSchema, status: debateStatus,
  createdAt: isoDate, updatedAt: isoDate, closedAt: isoDate.optional(), closeReason: z.string().max(4000).optional(),
}).strict();
const stateSchema = z.object({ competitions: z.array(competitionRecordSchema).max(1000), debates: z.array(debateRecordSchema).max(1000) }).strict();
const candidateInputSchema = resultEnvelopeSchema;
const debateInputSchema = z.object({
  taskId: id, contextVersion: id, participantAgentIds: z.array(id).min(1).max(12),
  maxRounds: z.number().int().min(1).max(12).default(4), maxMessagesPerAgent: z.number().int().min(1).max(20).default(4),
  maxTotalMessages: z.number().int().min(1).max(100).optional(),
}).strict();

export type CompetitionRecord = z.infer<typeof competitionRecordSchema>;
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
    const record: CompetitionRecord = { schemaVersion: 1, id: `competition_${randomUUID()}`, brief, status: 'collecting', candidates: [], scores: [], totalCost: 0, createdAt: now, updatedAt: now };
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

  async createDebate(input: unknown): Promise<DebateRecord> {
    const parsed = debateInputSchema.parse(input); const now = new Date().toISOString(); const idValue = `debate_${randomUUID()}`;
    const roomBase = { debateId: idValue, taskId: parsed.taskId, contextVersion: parsed.contextVersion, participantAgentIds: parsed.participantAgentIds, maxRounds: parsed.maxRounds, maxMessagesPerAgent: parsed.maxMessagesPerAgent, messages: [] };
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
