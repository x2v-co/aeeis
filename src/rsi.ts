import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import pg from 'pg';
import { EvolutionEngine, evolutionCandidateSchema, rolloutObservationSchema, type EvolutionCandidate, type EvolutionEvaluation } from './evolution.js';
import { RsiEvaluator, evaluationCaseSchema, evaluationSuiteSchema, type EvaluationSuite, type RsiEvaluationHarness, type RsiEvaluationPolicy } from './evaluation.js';
import { activationTargetSchema, baselineVersions, evolutionContentHash, type EvolutionActivationStore, type ActiveEvolution } from './evolution-activation.js';

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

/** PostgreSQL candidate store for multi-process deployments. Candidate state is
 * validated JSONB, while row locks serialize each lifecycle transition. */
export class PostgresEvolutionRepository implements EvolutionRepository {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS aeeis_evolution_candidates (id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS aeeis_evolution_status_idx ON aeeis_evolution_candidates ((state->>'status'));`);
  }
  async create(candidate: EvolutionCandidate): Promise<void> { await this.pool.query('INSERT INTO aeeis_evolution_candidates(id,state) VALUES($1,$2)', [candidate.id, candidate]); }
  async get(id: string): Promise<EvolutionCandidate> {
    const result = await this.pool.query<{ state: unknown }>('SELECT state FROM aeeis_evolution_candidates WHERE id=$1', [id]);
    const row = result.rows[0]; if (!row) throw new EvolutionNotFound('Unknown evolution candidate');
    return evolutionCandidateSchema.parse(row.state);
  }
  async list(): Promise<EvolutionCandidate[]> {
    const result = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_evolution_candidates ORDER BY updated_at DESC, id`);
    return result.rows.map(row => evolutionCandidateSchema.parse(row.state));
  }
  async mutate(id: string, change: (candidate: EvolutionCandidate) => EvolutionCandidate): Promise<EvolutionCandidate> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ state: unknown }>('SELECT state FROM aeeis_evolution_candidates WHERE id=$1 FOR UPDATE', [id]);
      if (!result.rows[0]) throw new EvolutionNotFound('Unknown evolution candidate');
      const next = evolutionCandidateSchema.parse(change(structuredClone(evolutionCandidateSchema.parse(result.rows[0].state))));
      await client.query('UPDATE aeeis_evolution_candidates SET state=$2, updated_at=now() WHERE id=$1', [id, next]);
      await client.query('COMMIT'); return next;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

const proposalInputSchema = z.object({
  target: z.enum(['profile', 'skill', 'prompt', 'workflow', 'tool-policy', 'model-policy']), baseVersion: z.string().min(1).max(200), proposedVersion: z.string().min(1).max(200), change: z.string().min(1).max(8000), sourceReceiptRefs: z.array(z.string().min(1).max(200)).min(1).max(100), reason: z.string().min(1).max(4000), risk: z.enum(['low', 'medium', 'high']),
}).strict();
const evaluationInputSchema = z.object({ kind: z.enum(['replay', 'holdout', 'safety', 'cost', 'shadow']), passed: z.boolean(), score: z.number().min(0).max(1), evidenceRefs: z.array(z.string().max(200)).max(100), id: z.string().min(1).max(200).optional(), completedAt: z.string().datetime({ offset: true }).optional() }).strict();

export class RsiService {
  private readonly engine = new EvolutionEngine();
  constructor(private readonly repository: EvolutionRepository, private readonly activation?: EvolutionActivationStore) {}
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
    const body = z.object({ cases: z.array(evaluationCaseSchema.extend({ id: z.string().trim().min(1).max(193) })).min(1).max(100) }).strict().parse(input);
    const expectedStatus = phase === 'shadow' ? 'shadowing' : 'canarying';
    const assertBatch = (candidate: EvolutionCandidate): void => {
      if (candidate.status !== expectedStatus) throw new Error(`Candidate must be ${expectedStatus} before rollout observations can run`);
      if (candidate.rolloutAttempts?.some(attempt => attempt.state === 'started')) throw new Error('An evaluator request is in flight or interrupted; inspect it before further rollout');
      const observations = (phase === 'shadow' ? candidate.shadowObservations : candidate.canaryObservations) ?? [];
      if (observations.length + body.cases.length > 100 || (candidate.rolloutAttempts?.length ?? 0) + body.cases.length > 200) throw new Error('Rollout capacity exceeded');
      const ids = new Set<string>();
      for (const testCase of body.cases) {
        if (ids.has(testCase.id) || observations.some(item => item.id === `${phase}:${testCase.id}`) || candidate.rolloutAttempts?.some(attempt => attempt.phase === phase && attempt.caseId === testCase.id)) throw new Error(`Duplicate rollout case: ${testCase.id}`);
        ids.add(testCase.id);
      }
    };
    assertBatch(await this.repository.get(id));
    let result = await this.repository.get(id);
    for (const [index, testCase] of body.cases.entries()) {
      const attemptId = `rollout_${randomUUID()}`;
      const reserved = await this.repository.mutate(id, current => {
        if (index === 0) assertBatch(current);
        if (current.status !== expectedStatus) throw new Error('Rollout phase changed');
        current.rolloutAttempts ??= [];
        if (current.rolloutAttempts.some(attempt => attempt.state === 'started' || (attempt.phase === phase && attempt.caseId === testCase.id))) throw new Error('Rollout case already reserved');
        if (current.rolloutAttempts.length >= 200) throw new Error('Rollout capacity exceeded');
        current.rolloutAttempts.push({ id: attemptId, phase, caseId: testCase.id, inputHash: createHash('sha256').update(JSON.stringify(testCase)).digest('hex'), state: 'started', startedAt: new Date().toISOString() });
        return current;
      });
      let observation: z.infer<typeof rolloutObservationSchema>;
      let failed = false;
      try {
        const output = await harness.evaluate(reserved, phase, testCase);
        observation = rolloutObservationSchema.parse({ id: `${phase}:${testCase.id}`, passed: output.passed, score: output.score, evidenceRefs: output.evidenceRefs, recordedAt: new Date().toISOString() });
      } catch {
        failed = true;
        // The reference names the durable local attempt receipt, not invented evaluator evidence.
        observation = { id: `${phase}:${testCase.id}`, passed: false, score: 0, evidenceRefs: [attemptId], recordedAt: new Date().toISOString() };
      }
      result = await this.repository.mutate(id, current => {
        const attempt = current.rolloutAttempts!.find(item => item.id === attemptId)!;
        if (attempt.state !== 'started') return current;
        attempt.state = failed ? 'failed' : 'completed';
        attempt.endedAt = new Date().toISOString();
        attempt.observation = observation;
        if (failed) attempt.error = 'Evaluator request failed or returned an invalid observation; outcome may be unknown';
        // Keep the receipt even if an owner rolled back while the evaluator was running.
        if (current.status !== expectedStatus) return current;
        return phase === 'shadow' ? this.engine.recordShadow(current, observation) : this.engine.recordCanary(current, observation);
      });
      if (result.status !== expectedStatus) break;
    }
    return result;
  }
  /** Resolve a durable rollout attempt after its evaluator response was
   * ambiguous or the worker restarted. The caller must supply the provider's
   * observed result; this operation never calls the evaluator again. */
  async reconcileRollout(id: string, input: unknown): Promise<EvolutionCandidate> {
    const body = z.object({
      attemptId: z.string().min(1).max(200), outcome: z.enum(['completed', 'failed']),
      passed: z.boolean().optional(), score: z.number().min(0).max(1).optional(),
      evidenceRefs: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
      reason: z.string().trim().min(1).max(2000),
    }).strict().parse(input);
    return this.repository.mutate(id, current => {
      const attempt = current.rolloutAttempts?.find(item => item.id === body.attemptId);
      if (!attempt) throw new Error(`Unknown rollout attempt: ${body.attemptId}`);
      if (attempt.state !== 'started') throw new Error(`Rollout attempt is already ${attempt.state}`);
      const passed = body.outcome === 'completed' ? body.passed : false;
      const evidenceRefs = body.evidenceRefs ?? [attempt.id];
      if (body.outcome === 'completed' && (body.passed === undefined || body.score === undefined || !body.evidenceRefs?.length)) {
        throw new Error('Completed rollout reconciliation requires passed, score, and evidenceRefs');
      }
      const observation = rolloutObservationSchema.parse({
        id: `${attempt.phase}:${attempt.caseId}`, passed, score: body.score ?? 0,
        evidenceRefs, recordedAt: new Date().toISOString(),
      });
      attempt.state = 'reconciled'; attempt.endedAt = new Date().toISOString(); attempt.observation = observation;
      attempt.reconciliationReason = body.reason;
      if (current.status === (attempt.phase === 'shadow' ? 'shadowing' : 'canarying')) {
        return attempt.phase === 'shadow' ? this.engine.recordShadow(current, observation) : this.engine.recordCanary(current, observation);
      }
      return current;
    });
  }

  get(id: string): Promise<EvolutionCandidate> { return this.repository.get(id); }
  list(): Promise<EvolutionCandidate[]> { return this.repository.list(); }
  async listActive(): Promise<ActiveEvolution[]> {
    if (!this.activation) return [];
    const active = await this.activation.list();
    for (const release of active) {
      const candidate = await this.repository.get(release.candidateId);
      if (candidate.status !== 'promoted' || candidate.target !== release.target || candidate.baseVersion !== release.baseVersion || candidate.proposedVersion !== release.version || candidate.change !== release.change || release.contentHash !== evolutionContentHash(release)) {
        throw new Error('Active evolution no longer matches its promoted candidate; reconcile activation before creating new Runs');
      }
    }
    return active;
  }
  async activationStatus() {
    return { configured: Boolean(this.activation), baselineVersions, active: await this.listActive(), history: this.activation ? await this.activation.history() : [] };
  }
  async activate(id: string, activationRef: string): Promise<ActiveEvolution> {
    if (!this.activation) throw new Error('Evolution activation store is not configured');
    const candidate = await this.repository.get(id);
    if (candidate.status !== 'promoted') throw new Error('Only a promoted candidate can be activated');
    const target = activationTargetSchema.safeParse(candidate.target);
    if (!target.success) throw new Error(`No runtime activation adapter exists for ${candidate.target}`);
    return this.activation.activate({ target: target.data, candidateId: candidate.id, baseVersion: candidate.baseVersion, version: candidate.proposedVersion, change: candidate.change, activationRef: z.string().trim().min(1).max(200).parse(activationRef) });
  }
  evaluate(id: string, input: unknown): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.evaluate(candidate, evaluationInputSchema.parse(input) as EvolutionEvaluation)); }
  approve(id: string, approvalRef: string): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.approve(candidate, z.string().min(1).max(200).parse(approvalRef))); }
  startShadow(id: string): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.startShadow(candidate)); }
  recordShadow(id: string, input: unknown): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.recordShadow(candidate, parseRolloutObservation(input))); }
  startCanary(id: string): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.startCanary(candidate)); }
  recordCanary(id: string, input: unknown): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.recordCanary(candidate, parseRolloutObservation(input))); }
  promote(id: string): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.promote(candidate)); }
  async rollback(id: string, reason: string): Promise<EvolutionCandidate> {
    const validatedReason = z.string().trim().min(1).max(4000).parse(reason);
    const candidate = await this.repository.get(id);
    if (candidate.status !== 'rolled_back') this.engine.rollback(candidate, validatedReason);
    // Deactivate/revoke before changing candidate state. If the second write
    // fails, new Runs already use the predecessor and repeating rollback is safe.
    // A concurrent activation cannot resurrect a revoked candidate.
    if (this.activation) await this.activation.revoke(id, validatedReason);
    return this.repository.mutate(id, current => current.status === 'rolled_back' ? current : this.engine.rollback(current, validatedReason));
  }
}

function parseRolloutObservation(input: unknown) {
  const value = z.object({
    id: z.string().min(1).max(200), passed: z.boolean(), score: z.number().min(0).max(1),
    evidenceRefs: z.array(z.string().min(1).max(200)).min(1).max(100), recordedAt: z.string().datetime({ offset: true }).optional(),
  }).strict().parse(input);
  return rolloutObservationSchema.parse({ ...value, recordedAt: value.recordedAt ?? new Date().toISOString() });
}
