import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { EvolutionEngine, evolutionCandidateSchema, rolloutObservationSchema, type EvolutionCandidate, type EvolutionEvaluation } from './evolution.js';
import { RsiEvaluator, evaluationCaseSchema, evaluationSuiteSchema, type EvaluationCase, type EvaluationMode, type EvaluationSuite, type RsiEvaluationHarness, type RsiEvaluationPolicy } from './evaluation.js';

export interface EvolutionRepository {
  create(candidate: EvolutionCandidate): Promise<void>;
  get(id: string): Promise<EvolutionCandidate>;
  list(): Promise<EvolutionCandidate[]>;
  mutate(id: string, change: (candidate: EvolutionCandidate) => EvolutionCandidate): Promise<EvolutionCandidate>;
  close(): Promise<void>;
}

export class EvolutionNotFound extends Error {}

export class FileEvolutionRepository implements EvolutionRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private lockPath: string;
  constructor(private readonly directory: string) { this.lockPath = join(directory, '.writer.lock'); }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const lock = await open(this.lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(this.lockPath, 'utf8'));
      try { process.kill(pid, 0); throw new Error('Evolution directory already has a live writer'); }
      catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError; await unlink(this.lockPath); return this.init(); }
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  private path(id: string): string { if (!/^evo_[a-f0-9-]{36}$/.test(id)) throw new EvolutionNotFound('Unknown evolution candidate'); return join(this.directory, `${id}.json`); }
  private async save(candidate: EvolutionCandidate): Promise<void> {
    const path = this.path(candidate.id), temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600); try { await file.writeFile(JSON.stringify(candidate)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path); const dir = await open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
  create(candidate: EvolutionCandidate): Promise<void> { return this.serial(async () => { try { await this.get(candidate.id); throw new Error('Evolution candidate already exists'); } catch (error) { if (!(error instanceof EvolutionNotFound)) throw error; } await this.save(candidate); }); }
  async get(id: string): Promise<EvolutionCandidate> { try { return evolutionCandidateSchema.parse(JSON.parse(await readFile(this.path(id), 'utf8'))); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new EvolutionNotFound('Unknown evolution candidate'); throw error; } }
  async list(): Promise<EvolutionCandidate[]> { const { readdir } = await import('node:fs/promises'); const files = (await readdir(this.directory)).filter(name => /^evo_[a-f0-9-]{36}\.json$/.test(name)); return Promise.all(files.map(file => this.get(file.slice(0, -5)))); }
  mutate(id: string, change: (candidate: EvolutionCandidate) => EvolutionCandidate): Promise<EvolutionCandidate> { return this.serial(async () => { const current = await this.get(id); const next = evolutionCandidateSchema.parse(change(structuredClone(current))); await this.save(next); return next; }); }
  async close(): Promise<void> { await this.queue; await unlink(this.lockPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}

const proposalInputSchema = z.object({
  target: z.enum(['profile', 'skill', 'prompt', 'workflow', 'tool-policy', 'model-policy']), baseVersion: z.string().min(1).max(200), proposedVersion: z.string().min(1).max(200), change: z.string().min(1).max(8000), sourceReceiptRefs: z.array(z.string().min(1).max(200)).min(1).max(100), reason: z.string().min(1).max(4000), risk: z.enum(['low', 'medium', 'high']),
}).strict();
const evaluationInputSchema = z.object({ kind: z.enum(['replay', 'holdout', 'safety', 'cost', 'shadow']), passed: z.boolean(), score: z.number().min(0).max(1), evidenceRefs: z.array(z.string().max(200)).max(100), id: z.string().min(1).max(200).optional(), completedAt: z.string().datetime({ offset: true }).optional() }).strict();

export class RsiService {
  private readonly engine = new EvolutionEngine();
  constructor(private readonly repository: EvolutionRepository) {}
  async propose(input: unknown): Promise<EvolutionCandidate> { const candidate = this.engine.propose(proposalInputSchema.parse(input)); await this.repository.create(candidate); return candidate; }
  async proposeFromCorrection(input: { target: EvolutionCandidate['target']; baseVersion: string; proposedVersion: string; change: string; reason: string; risk: EvolutionCandidate['risk']; correctionRef: string; sourceReceiptRefs: string[] }): Promise<EvolutionCandidate> {
    return this.propose({ target: input.target, baseVersion: input.baseVersion, proposedVersion: input.proposedVersion, change: input.change, reason: `${input.reason} (correction: ${input.correctionRef})`, risk: input.risk, sourceReceiptRefs: [...new Set([...input.sourceReceiptRefs, input.correctionRef])] });
  }
  async evaluateSuite(id: string, input: unknown, harness: RsiEvaluationHarness): Promise<EvolutionCandidate> {
    const body = z.object({ suite: evaluationSuiteSchema, requiredModes: z.array(z.enum(['replay', 'holdout', 'safety', 'cost', 'shadow'])).min(1).max(5).optional(), minimumScore: z.number().min(0).max(1).optional() }).strict().parse(input);
    const policy: RsiEvaluationPolicy = { ...(body.requiredModes ? { requiredModes: body.requiredModes } : {}), ...(body.minimumScore === undefined ? {} : { minimumScore: body.minimumScore }) };
    const evaluator = new RsiEvaluator(policy);
    const candidate = await this.repository.get(id);
    const evaluations = await evaluator.evaluate(candidate, body.suite as EvaluationSuite, harness);
    let result = candidate;
    for (const evaluation of evaluations) result = await this.repository.mutate(id, current => this.engine.evaluate(current, evaluation));
    return result;
  }
  /** Run a bounded shadow/canary observation batch through the isolated evaluator.
   * This records evidence only; explicit phase transitions and promotion remain
   * separate operations so an evaluator cannot modify production by itself. */
  async runRollout(id: string, phase: 'shadow' | 'canary', input: unknown, harness: RsiEvaluationHarness): Promise<EvolutionCandidate> {
    const body = z.object({ cases: z.array(evaluationCaseSchema).min(1).max(100) }).strict().parse(input);
    const candidate = await this.repository.get(id);
    const expectedStatus = phase === 'shadow' ? 'shadowing' : 'canarying';
    if (candidate.status !== expectedStatus) throw new Error(`Candidate must be ${expectedStatus} before rollout observations can run`);
    const ids = new Set<string>();
    for (const testCase of body.cases) {
      if (ids.has(testCase.id)) throw new Error(`Duplicate rollout case: ${testCase.id}`);
      ids.add(testCase.id);
    }
    const mode: EvaluationMode = phase;
    const settled = await Promise.allSettled(body.cases.map(testCase => harness.evaluate(candidate, mode, testCase)));
    let result = candidate;
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index]!;
      const testCase = body.cases[index]!;
      const observation = outcome.status === 'fulfilled'
        ? { id: `${phase}:${testCase.id}`, passed: outcome.value.passed, score: outcome.value.score, evidenceRefs: outcome.value.evidenceRefs }
        : { id: `${phase}:${testCase.id}`, passed: false, score: 0, evidenceRefs: [`rsi:${phase}:${testCase.id}:evaluator_error`] };
      result = phase === 'shadow'
        ? await this.recordShadow(id, observation)
        : await this.recordCanary(id, observation);
      if (result.status === 'held') break;
    }
    return result;
  }
  get(id: string): Promise<EvolutionCandidate> { return this.repository.get(id); }
  list(): Promise<EvolutionCandidate[]> { return this.repository.list(); }
  evaluate(id: string, input: unknown): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.evaluate(candidate, evaluationInputSchema.parse(input) as EvolutionEvaluation)); }
  approve(id: string, approvalRef: string): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.approve(candidate, z.string().min(1).max(200).parse(approvalRef))); }
  startShadow(id: string): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.startShadow(candidate)); }
  recordShadow(id: string, input: unknown): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.recordShadow(candidate, parseRolloutObservation(input))); }
  startCanary(id: string): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.startCanary(candidate)); }
  recordCanary(id: string, input: unknown): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.recordCanary(candidate, parseRolloutObservation(input))); }
  promote(id: string): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.promote(candidate)); }
  rollback(id: string, reason: string): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.rollback(candidate, z.string().min(1).max(4000).parse(reason))); }
}

function parseRolloutObservation(input: unknown) {
  const value = z.object({
    id: z.string().min(1).max(200), passed: z.boolean(), score: z.number().min(0).max(1),
    evidenceRefs: z.array(z.string().min(1).max(200)).min(1).max(100), recordedAt: z.string().datetime({ offset: true }).optional(),
  }).strict().parse(input);
  return rolloutObservationSchema.parse({ ...value, recordedAt: value.recordedAt ?? new Date().toISOString() });
}
