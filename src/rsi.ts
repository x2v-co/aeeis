import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import pg from 'pg';
import { EvolutionEngine, evolutionCandidateSchema, rolloutObservationSchema, type EvolutionCandidate, type EvolutionEvaluation } from './evolution.js';
import { RsiEvaluator, evaluationCaseSchema, evaluationSuiteSchema, type EvaluationResult, type EvaluationSuite, type RsiEvaluationHarness, type RsiEvaluationPolicy } from './evaluation.js';
import { activationTargetSchema, baselineVersions, evolutionContentHash, parseActivationChange, type EvolutionActivationStore, type ActiveEvolution, type EvolutionTrafficSelection, type EvolutionTrafficObservation, type EvolutionTrafficSafety } from './evolution-activation.js';
import type { Ownership } from './security/principal.js';
import type { GlobalBudgetLedger, GlobalBudgetSelector } from './global-budget.js';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { afterCollectionCursor, decodeCollectionCursor, encodeCollectionCursor, recentFirst, scopedRecent, validateCollectionLimit } from './adapters/collection-query.js';

export type EvolutionScope = Ownership;
export interface EvolutionPage { items: EvolutionCandidate[]; nextCursor?: string }
function matchesScope(value: { owner?: string; tenantId?: string }, scope?: EvolutionScope): boolean {
  return scope === undefined || (value.owner ?? 'owner') === scope.owner && (value.tenantId ?? 'local') === scope.tenantId;
}
function assertScope(value: { owner?: string; tenantId?: string }, scope?: EvolutionScope): void {
  if (!matchesScope(value, scope)) throw new EvolutionNotFound('Unknown evolution candidate');
}

export interface EvolutionRepository {
  create(candidate: EvolutionCandidate): Promise<void>;
  get(id: string, scope?: EvolutionScope): Promise<EvolutionCandidate>;
  list(scope?: EvolutionScope, limit?: number): Promise<EvolutionCandidate[]>;
  listPage?(scope: EvolutionScope | undefined, limit: number, cursor?: string): Promise<EvolutionPage>;
  mutate(id: string, change: (candidate: EvolutionCandidate) => EvolutionCandidate, scope?: EvolutionScope): Promise<EvolutionCandidate>;
  close(): Promise<void>;
}

export class EvolutionNotFound extends Error {}

function candidateUpdate(current: EvolutionCandidate, change: (candidate: EvolutionCandidate) => EvolutionCandidate): EvolutionCandidate {
  const next = evolutionCandidateSchema.parse(change(structuredClone(current)));
  if (next.id !== current.id || next.owner !== current.owner || next.tenantId !== current.tenantId || next.createdAt !== current.createdAt) {
    throw new Error('Evolution candidate identity, ownership and creation time are immutable');
  }
  // The repository stamps the commit time; evaluator-reported timestamps do
  // not determine which candidate is most recently changed.
  next.updatedAt = new Date().toISOString();
  return next;
}

export class FileEvolutionRepository implements EvolutionRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private lockPath: string;
  private summaries: Map<string, { id: string; owner: string; tenantId: string; updatedAt: string }> | undefined;
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
    await rename(temporary, path);
    this.summaries?.set(candidate.id, this.summary(candidate));
    const dir = await open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
  create(candidate: EvolutionCandidate): Promise<void> { return this.serial(async () => { const parsed = evolutionCandidateSchema.parse(candidate); try { await this.get(parsed.id); throw new Error('Evolution candidate already exists'); } catch (error) { if (!(error instanceof EvolutionNotFound)) throw error; } await this.save(parsed); }); }
  async get(id: string, scope?: EvolutionScope): Promise<EvolutionCandidate> { try { const candidate = evolutionCandidateSchema.parse(JSON.parse(await readFile(this.path(id), 'utf8'))); assertScope(candidate, scope); return candidate; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new EvolutionNotFound('Unknown evolution candidate'); throw error; } }
  private summary(candidate: EvolutionCandidate) {
    return { id: candidate.id, owner: candidate.owner, tenantId: candidate.tenantId, updatedAt: candidate.updatedAt ?? candidate.createdAt };
  }
  private async ensureSummaries(): Promise<void> {
    if (this.summaries) return;
    const { readdir } = await import('node:fs/promises');
    const summaries = new Map<string, ReturnType<FileEvolutionRepository['summary']>>();
    // Single-writer serialization prevents commits racing this rebuild.
    // Only metadata is retained; full evaluation evidence stays on disk.
    for (const file of await readdir(this.directory)) {
      if (!/^evo_[a-f0-9-]{36}\.json$/.test(file)) continue;
      const candidate = await this.get(file.slice(0, -5));
      summaries.set(candidate.id, this.summary(candidate));
    }
    this.summaries = summaries;
  }
  list(scope?: EvolutionScope, limit?: number): Promise<EvolutionCandidate[]> {
    return this.serial(async () => {
      validateCollectionLimit(limit);
      await this.ensureSummaries();
      const selected = scopedRecent([...this.summaries!.values()], item => item.updatedAt, scope, limit);
      return Promise.all(selected.map(item => this.get(item.id, scope)));
    });
  }
  listPage(scope: EvolutionScope | undefined, limit: number, cursor?: string): Promise<EvolutionPage> {
    return this.serial(async () => {
      validateCollectionLimit(limit);
      const pageCursor = decodeCollectionCursor(cursor);
      await this.ensureSummaries();
      const selected = [...this.summaries!.values()]
        .filter(item => (!scope || matchesScope(item, scope)) && afterCollectionCursor(item, item.updatedAt, pageCursor))
        .sort(recentFirst(item => item.updatedAt));
      const page = selected.slice(0, limit + 1);
      const visible = page.length > limit ? page.slice(0, limit) : page;
      return {
        items: await Promise.all(visible.map(item => this.get(item.id, scope))),
        ...(page.length > limit && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt, id: visible.at(-1)!.id }) } : {}),
      };
    });
  }
  mutate(id: string, change: (candidate: EvolutionCandidate) => EvolutionCandidate, scope?: EvolutionScope): Promise<EvolutionCandidate> { return this.serial(async () => { const current = await this.get(id, scope); const next = candidateUpdate(current, change); await this.save(next); return next; }); }
  async close(): Promise<void> { await this.queue; this.summaries = undefined; await unlink(this.lockPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}

/** PostgreSQL candidate store for multi-process deployments. Candidate state is
 * validated JSONB, while row locks serialize each lifecycle transition. */
export class PostgresEvolutionRepository implements EvolutionRepository {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'evolution-candidates', async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_evolution_candidates (id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS aeeis_evolution_status_idx ON aeeis_evolution_candidates ((state->>'status'));`);
      // Legacy PostgreSQL rows already record commit time. Preserve it when
      // adding the canonical timestamp instead of treating them as new work.
      await client.query(`UPDATE aeeis_evolution_candidates SET state=state || jsonb_build_object('updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE NOT (state ? 'updatedAt')`);
      await client.query(`UPDATE aeeis_evolution_candidates SET updated_at=(state->>'updatedAt')::timestamptz WHERE updated_at IS DISTINCT FROM (state->>'updatedAt')::timestamptz`);
      await client.query(`CREATE INDEX IF NOT EXISTS aeeis_evolution_recent_scope_idx ON aeeis_evolution_candidates ((COALESCE(state->>'owner', 'owner')), (COALESCE(state->>'tenantId', 'local')), updated_at DESC, id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS aeeis_evolution_recent_idx ON aeeis_evolution_candidates (updated_at DESC, id)`);
    });
  }
  async create(candidate: EvolutionCandidate): Promise<void> { const parsed = evolutionCandidateSchema.parse(candidate); await this.pool.query('INSERT INTO aeeis_evolution_candidates(id,state,updated_at) VALUES($1,$2,$3)', [parsed.id, parsed, parsed.updatedAt ?? parsed.createdAt]); }
  async get(id: string, scope?: EvolutionScope): Promise<EvolutionCandidate> {
    const result = await this.pool.query<{ state: unknown }>('SELECT state FROM aeeis_evolution_candidates WHERE id=$1', [id]);
    const row = result.rows[0]; if (!row) throw new EvolutionNotFound('Unknown evolution candidate');
    const candidate = evolutionCandidateSchema.parse(row.state); assertScope(candidate, scope); return candidate;
  }
  async list(scope?: EvolutionScope, limit?: number): Promise<EvolutionCandidate[]> {
    validateCollectionLimit(limit);
    const values: unknown[] = scope ? [scope.owner, scope.tenantId] : [];
    if (limit !== undefined) values.push(limit);
    const result = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_evolution_candidates${scope ? " WHERE COALESCE(state->>'owner', 'owner')=$1 AND COALESCE(state->>'tenantId', 'local')=$2" : ''} ORDER BY updated_at DESC, id${limit === undefined ? '' : ` LIMIT $${values.length}`}`, values);
    return result.rows.map(row => evolutionCandidateSchema.parse(row.state));
  }
  async listPage(scope: EvolutionScope | undefined, limit: number, cursor?: string): Promise<EvolutionPage> {
    validateCollectionLimit(limit);
    const pageCursor = decodeCollectionCursor(cursor);
    const values: unknown[] = [];
    const where: string[] = [];
    if (scope) { values.push(scope.owner, scope.tenantId); where.push(`COALESCE(state->>'owner', 'owner')=$${values.length - 1}`, `COALESCE(state->>'tenantId', 'local')=$${values.length}`); }
    if (pageCursor) { values.push(pageCursor.timestamp, pageCursor.id); where.push(`(updated_at < $${values.length - 1}::timestamptz OR (updated_at = $${values.length - 1}::timestamptz AND id > $${values.length}))`); }
    values.push(limit + 1);
    const result = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_evolution_candidates${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC,id ASC LIMIT $${values.length}`, values);
    const items = result.rows.map(row => evolutionCandidateSchema.parse(row.state));
    const hasMore = items.length > limit;
    const visible = hasMore ? items.slice(0, limit) : items;
    return { items: visible, ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt ?? visible.at(-1)!.createdAt, id: visible.at(-1)!.id }) } : {}) };
  }
  async mutate(id: string, change: (candidate: EvolutionCandidate) => EvolutionCandidate, scope?: EvolutionScope): Promise<EvolutionCandidate> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ state: unknown }>('SELECT state FROM aeeis_evolution_candidates WHERE id=$1 FOR UPDATE', [id]);
      if (!result.rows[0]) throw new EvolutionNotFound('Unknown evolution candidate');
      const current = evolutionCandidateSchema.parse(result.rows[0].state); assertScope(current, scope);
      const next = candidateUpdate(current, change);
      await client.query('UPDATE aeeis_evolution_candidates SET state=$2, updated_at=$3 WHERE id=$1', [id, next, next.updatedAt]);
      await client.query('COMMIT'); return next;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

const proposalInputSchema = z.object({
  target: z.enum(['profile', 'skill', 'prompt', 'workflow', 'tool-policy', 'model-policy']), baseVersion: z.string().min(1).max(200), proposedVersion: z.string().min(1).max(200), change: z.string().min(1).max(8000), sourceReceiptRefs: z.array(z.string().min(1).max(200)).min(1).max(100), reason: z.string().min(1).max(4000), risk: z.enum(['low', 'medium', 'high']), proposalSignalId: z.string().trim().min(1).max(200).optional(),
}).strict();
const evaluationInputSchema = z.object({ kind: z.enum(['replay', 'holdout', 'safety', 'cost', 'shadow']), passed: z.boolean(), score: z.number().min(0).max(1), evidenceRefs: z.array(z.string().max(200)).max(100), id: z.string().min(1).max(200).optional(), completedAt: z.string().datetime({ offset: true }).optional() }).strict();
function hashEvaluationSuite(suite: unknown, mode: EvolutionCandidate['evaluations'][number]['kind'], minimumScore?: number): string {
  return createHash('sha256').update(JSON.stringify({ mode, minimumScore: minimumScore ?? null, suite })).digest('hex');
}
function proposalCandidateId(signalId: string): EvolutionCandidate['id'] {
  const hex = createHash('sha256').update(`aeeis:rsi:proposal:${signalId}`).digest('hex').slice(0, 32);
  return `evo_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class RsiService {
  private readonly engine = new EvolutionEngine();
  constructor(private readonly repository: EvolutionRepository, private readonly activation?: EvolutionActivationStore, private readonly globalBudget?: { ledger: GlobalBudgetLedger; select: GlobalBudgetSelector }) {}
  private globalKey(candidateId: string, attemptId: string): string { return `aeeis:rsi:${candidateId}:${attemptId}`; }
  private async reserveGlobal(candidateId: string, attemptId: string, scope: EvolutionScope | undefined, startedAt: string): Promise<{ accountKey?: string; reserved: boolean }> {
    if (!this.globalBudget) return { reserved: true };
    const selection = this.globalBudget.select(scope, startedAt);
    if (!selection) return { reserved: true };
    const result = await this.globalBudget.ledger.reserve(selection, this.globalKey(candidateId, attemptId));
    return { accountKey: selection.accountKey, reserved: result.reserved };
  }
  private async settleGlobal(candidateId: string, attemptId: string, accountKey: string | undefined, usage: { tokens?: number | undefined; moneyUsd?: number | undefined } = {}): Promise<void> {
    if (this.globalBudget && accountKey) await this.globalBudget.ledger.settle(accountKey, this.globalKey(candidateId, attemptId), usage);
  }
  private async markGlobalUnknown(candidateId: string, attemptId: string, accountKey: string | undefined): Promise<void> {
    if (this.globalBudget && accountKey) await this.globalBudget.ledger.markUnknown(accountKey, this.globalKey(candidateId, attemptId));
  }
  async propose(input: unknown, scope?: EvolutionScope): Promise<EvolutionCandidate> {
    const parsed = proposalInputSchema.parse(input);
    if (parsed.proposalSignalId) {
      const existing = (await this.repository.list(scope)).find(item => item.proposalSignalId === parsed.proposalSignalId);
      if (existing) return existing;
    }
    const candidate = this.engine.propose({ ...parsed, ...(parsed.proposalSignalId ? { id: proposalCandidateId(parsed.proposalSignalId) } : {}), ...(scope ? { owner: scope.owner, tenantId: scope.tenantId } : {}) });
    try { await this.repository.create(candidate); return candidate; }
    catch (error) {
      if (parsed.proposalSignalId) {
        const existing = await this.repository.get(candidate.id, scope).catch(() => undefined);
        if (existing?.proposalSignalId === parsed.proposalSignalId) return existing;
      }
      throw error;
    }
  }
  async proposeFromCorrection(input: { target: EvolutionCandidate['target']; baseVersion: string; proposedVersion: string; change: string; reason: string; risk: EvolutionCandidate['risk']; correctionRef: string; sourceReceiptRefs: string[] }, scope?: EvolutionScope): Promise<EvolutionCandidate> {
    return this.propose({ target: input.target, baseVersion: input.baseVersion, proposedVersion: input.proposedVersion, change: input.change, reason: `${input.reason} (correction: ${input.correctionRef})`, risk: input.risk, sourceReceiptRefs: [...new Set([...input.sourceReceiptRefs, input.correctionRef])] }, scope);
  }
  async evaluateSuite(id: string, input: unknown, harness: RsiEvaluationHarness, scope?: EvolutionScope): Promise<EvolutionCandidate> {
    const body = z.object({ suite: evaluationSuiteSchema, requiredModes: z.array(z.enum(['replay', 'holdout', 'safety', 'cost', 'shadow'])).min(1).max(5).optional(), minimumScore: z.number().min(0).max(1).optional() }).strict().parse(input);
    const modes = body.requiredModes ?? ['replay', 'holdout', 'safety'];
    let result = await this.repository.get(id, scope);
    for (const mode of modes) {
      if (result.evaluations.some(evaluation => evaluation.kind === mode)) continue;
      const suiteHash = hashEvaluationSuite(body.suite, mode, body.minimumScore);
      const previous = result.evaluationAttempts?.find(attempt => attempt.mode === mode && attempt.suiteHash === suiteHash);
      if (previous?.state === 'started') throw new Error(`RSI evaluation ${mode} is in flight or interrupted; reconcile it before retrying`);
      if ((previous?.state === 'completed' || previous?.state === 'reconciled') && previous.evaluation) {
        result = await this.repository.mutate(id, current => {
          if (current.evaluations.some(evaluation => evaluation.kind === mode)) return current;
          return this.engine.evaluate(current, previous.evaluation!);
        }, scope);
        continue;
      }
      const attemptId = `evaluation_${randomUUID()}`;
      const startedAt = new Date().toISOString();
      const global = await this.reserveGlobal(id, attemptId, scope, startedAt);
      if (!global.reserved) throw new Error('Global RSI evaluator reservation already exists; reconcile before retrying');
      const reserved = await this.repository.mutate(id, current => {
        if (current.evaluations.some(evaluation => evaluation.kind === mode)) return current;
        if (current.evaluationAttempts?.some(attempt => attempt.state === 'started')) throw new Error('Another RSI evaluation is in flight or interrupted; reconcile it before retrying');
        current.evaluationAttempts ??= [];
        current.evaluationAttempts.push({ id: attemptId, mode, suiteHash, ...(global.accountKey ? { globalBudgetAccountKey: global.accountKey } : {}), state: 'started', startedAt });
        return current;
      }, scope);
      if (reserved.evaluations.some(evaluation => evaluation.kind === mode)) { result = reserved; continue; }
      const evaluator = new RsiEvaluator({ requiredModes: [mode], ...(body.minimumScore === undefined ? {} : { minimumScore: body.minimumScore }) });
      const singleSuite: EvaluationSuite = {
        replay: mode === 'replay' ? body.suite.replay : [], holdout: mode === 'holdout' ? body.suite.holdout : [], safety: mode === 'safety' ? body.suite.safety : [],
        ...(mode === 'cost' ? { cost: body.suite.cost ?? [] } : {}), ...(mode === 'shadow' ? { shadow: body.suite.shadow ?? [] } : {}),
      };
      let evaluation: EvaluationResult | undefined;
      try {
        evaluation = (await evaluator.evaluate(reserved, singleSuite, harness, this.globalBudget ? `${this.globalKey(id, attemptId)}:case` : undefined))[0];
        await this.settleGlobal(id, attemptId, global.accountKey, evaluation?.usage ?? {});
      } catch (error) {
        const latest = await this.repository.mutate(id, current => {
          const attempt = current.evaluationAttempts?.find(item => item.id === attemptId);
          if (attempt?.state === 'started') { attempt.state = 'failed'; attempt.endedAt = new Date().toISOString(); attempt.error = error instanceof Error ? error.message : 'RSI evaluator failed'; }
          return current;
        }, scope);
        if (error instanceof Error && /unknown|timeout|network|transport/i.test(error.message)) await this.markGlobalUnknown(id, attemptId, global.accountKey);
        result = latest;
        throw error;
      }
      if (!evaluation) throw new Error(`RSI evaluation ${mode} returned no gate result`);
      result = await this.repository.mutate(id, current => {
        const attempt = current.evaluationAttempts?.find(item => item.id === attemptId);
        if (!attempt || attempt.state !== 'started') return current;
        const { usage: _usage, ...evaluationRecord } = evaluation;
        const persistedEvaluation = { ...evaluationRecord, completedAt: evaluation.completedAt ?? new Date().toISOString() };
        attempt.state = 'completed'; attempt.endedAt = new Date().toISOString(); attempt.usage = evaluation.usage; attempt.evaluation = persistedEvaluation;
        if (!current.evaluations.some(item => item.kind === mode)) return this.engine.evaluate(current, persistedEvaluation);
        return current;
      }, scope);
    }
    return result;
  }
  /** Resolve a gate whose evaluator response was ambiguous or whose worker
   * stopped after reservation. This never calls the evaluator again. */
  async reconcileEvaluation(id: string, input: unknown, scope?: EvolutionScope): Promise<EvolutionCandidate> {
    const body = z.object({ attemptId: z.string().min(1).max(200), outcome: z.enum(['completed', 'failed']), reason: z.string().trim().min(1).max(2000), evaluation: evaluationInputSchema.optional(), usage: z.object({ tokens: z.number().int().nonnegative().optional(), moneyUsd: z.number().nonnegative().optional() }).strict().optional() }).strict().parse(input);
    const before = await this.repository.get(id, scope);
    const beforeAttempt = before.evaluationAttempts?.find(item => item.id === body.attemptId);
    if (!beforeAttempt) throw new Error('Unknown RSI evaluation attempt');
    await this.settleGlobal(id, body.attemptId, beforeAttempt.globalBudgetAccountKey, body.usage ?? {});
    return this.repository.mutate(id, current => {
      const attempt = current.evaluationAttempts?.find(item => item.id === body.attemptId);
      if (!attempt) throw new Error('Unknown RSI evaluation attempt');
      if (attempt.state !== 'started') return current;
      attempt.reconciliationReason = body.reason; attempt.endedAt = new Date().toISOString();
      if (body.outcome === 'failed') { attempt.state = 'failed'; attempt.error = body.reason; return current; }
      if (!body.evaluation) throw new Error('Completed RSI evaluation reconciliation requires an evaluation');
      if (body.evaluation.kind !== attempt.mode) throw new Error('Reconciled RSI evaluation kind does not match the attempt');
      const evaluation = { kind: body.evaluation.kind, passed: body.evaluation.passed, score: body.evaluation.score, evidenceRefs: body.evaluation.evidenceRefs, completedAt: body.evaluation.completedAt ?? new Date().toISOString() };
      attempt.state = 'reconciled'; attempt.usage = body.usage; attempt.evaluation = evaluation;
      return current.evaluations.some(item => item.kind === attempt.mode) ? current : this.engine.evaluate(current, evaluation);
    }, scope);
  }
  /** Run a bounded shadow/canary observation batch through the isolated evaluator.
   * This records evidence only; explicit phase transitions and promotion remain
   * separate operations so an evaluator cannot modify production by itself. */
  async runRollout(id: string, phase: 'shadow' | 'canary', input: unknown, harness: RsiEvaluationHarness, scope?: EvolutionScope): Promise<EvolutionCandidate> {
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
    assertBatch(await this.repository.get(id, scope));
    let result = await this.repository.get(id, scope);
    for (const [index, testCase] of body.cases.entries()) {
      const attemptId = `rollout_${randomUUID()}`;
      const startedAt = new Date().toISOString();
      const global = await this.reserveGlobal(id, attemptId, scope, startedAt);
      if (!global.reserved) throw new Error('Global RSI evaluator reservation already exists; reconcile before retrying');
      const reserved = await this.repository.mutate(id, current => {
        if (index === 0) assertBatch(current);
        if (current.status !== expectedStatus) throw new Error('Rollout phase changed');
        current.rolloutAttempts ??= [];
        if (current.rolloutAttempts.some(attempt => attempt.state === 'started' || (attempt.phase === phase && attempt.caseId === testCase.id))) throw new Error('Rollout case already reserved');
        if (current.rolloutAttempts.length >= 200) throw new Error('Rollout capacity exceeded');
        current.rolloutAttempts.push({ id: attemptId, phase, caseId: testCase.id, inputHash: createHash('sha256').update(JSON.stringify(testCase)).digest('hex'), ...(global.accountKey ? { globalBudgetAccountKey: global.accountKey } : {}), state: 'started', startedAt });
        return current;
      }, scope);
      let observation: z.infer<typeof rolloutObservationSchema>;
      let failed = false;
      try {
        const output = await harness.evaluate(reserved, phase, testCase, { idempotencyKey: this.globalKey(id, attemptId) });
        await this.settleGlobal(id, attemptId, global.accountKey, output.usage ?? {});
        observation = rolloutObservationSchema.parse({ id: `${phase}:${testCase.id}`, passed: output.passed, score: output.score, evidenceRefs: output.evidenceRefs, recordedAt: new Date().toISOString() });
      } catch {
        failed = true;
        await this.markGlobalUnknown(id, attemptId, global.accountKey);
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
      }, scope);
      if (result.status !== expectedStatus) break;
    }
    return result;
  }
  /** Resolve a durable rollout attempt after its evaluator response was
   * ambiguous or the worker restarted. The caller must supply the provider's
   * observed result; this operation never calls the evaluator again. */
  async reconcileRollout(id: string, input: unknown, scope?: EvolutionScope): Promise<EvolutionCandidate> {
    const body = z.object({
      attemptId: z.string().min(1).max(200), outcome: z.enum(['completed', 'failed']),
      passed: z.boolean().optional(), score: z.number().min(0).max(1).optional(),
      evidenceRefs: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
      reason: z.string().trim().min(1).max(2000),
      usage: z.object({ tokens: z.number().int().nonnegative().optional(), moneyUsd: z.number().nonnegative().optional() }).strict().optional(),
    }).strict().parse(input);
    const before = await this.repository.get(id, scope);
    const beforeAttempt = before.rolloutAttempts?.find(item => item.id === body.attemptId);
    if (!beforeAttempt) throw new Error(`Unknown rollout attempt: ${body.attemptId}`);
    await this.settleGlobal(id, body.attemptId, beforeAttempt.globalBudgetAccountKey, body.usage ?? {});
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
    }, scope);
  }

  get(id: string, scope?: EvolutionScope): Promise<EvolutionCandidate> { return this.repository.get(id, scope); }
  list(scope?: EvolutionScope, limit?: number): Promise<EvolutionCandidate[]> { return this.repository.list(scope, limit); }
  page(scope: EvolutionScope | undefined, limit: number, cursor?: string): Promise<EvolutionPage> {
    if (this.repository.listPage) return this.repository.listPage(scope, limit, cursor);
    return this.repository.list(scope).then(items => {
      validateCollectionLimit(limit);
      const pageCursor = decodeCollectionCursor(cursor);
      const ordered = items.filter(item => afterCollectionCursor(item, item.updatedAt ?? item.createdAt, pageCursor)).sort(recentFirst(item => item.updatedAt ?? item.createdAt));
      const selected = ordered.slice(0, limit + 1);
      const visible = selected.length > limit ? selected.slice(0, limit) : selected;
      return { items: visible, ...(selected.length > limit && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt ?? visible.at(-1)!.createdAt, id: visible.at(-1)!.id }) } : {}) };
    });
  }
  async listActive(scope?: EvolutionScope): Promise<ActiveEvolution[]> {
    if (!this.activation) return [];
    const active = await this.activation.list(scope);
    for (const release of active) {
      parseActivationChange(release.target, release.change);
      const candidate = await this.repository.get(release.candidateId, scope);
      if (candidate.status !== 'promoted' || candidate.target !== release.target || candidate.baseVersion !== release.baseVersion || candidate.proposedVersion !== release.version || candidate.change !== release.change || release.contentHash !== evolutionContentHash(release)) {
        throw new Error('Active evolution no longer matches its promoted candidate; reconcile activation before creating new Runs');
      }
    }
    return active;
  }
  async listTraffic(scope?: EvolutionScope) {
    return this.activation?.listTraffic ? this.activation.listTraffic(scope) : [];
  }
  async startTraffic(id: string, percentage: number, rolloutRef: string, scope?: EvolutionScope, safety?: EvolutionTrafficSafety) {
    if (!this.activation?.startTraffic) throw new Error('Evolution traffic routing is not configured');
    const candidate = await this.repository.get(id, scope);
    if (candidate.status !== 'promoted') throw new Error('Only a promoted candidate can enter traffic canary');
    const ownership = { owner: candidate.owner ?? 'owner', tenantId: candidate.tenantId ?? 'local' };
    const active = await this.listActive(ownership);
    const base = active.find(release => release.target === candidate.target);
    if (!base) throw new Error(`No active base release exists for ${candidate.target}`);
    if (candidate.baseVersion !== base.version) throw new Error(`Traffic canary base version conflict: expected ${base.version}`);
    parseActivationChange(candidate.target, candidate.change);
    return this.activation.startTraffic({ target: candidate.target, candidateId: candidate.id, baseCandidateId: base.candidateId, baseVersion: base.version, version: candidate.proposedVersion, contentHash: evolutionContentHash({ target: candidate.target, version: candidate.proposedVersion, change: candidate.change }), percentage: z.number().int().min(1).max(9999).parse(percentage), rolloutRef: z.string().trim().min(1).max(200).parse(rolloutRef), ...(safety ? { safety } : {}), ...ownership });
  }
  async updateTraffic(id: string, percentage: number, rolloutRef: string, scope?: EvolutionScope) {
    if (!this.activation?.updateTraffic) throw new Error('Evolution traffic routing is not configured');
    return this.activation.updateTraffic(id, percentage, rolloutRef, scope);
  }
  async pauseTraffic(id: string, reason: string, scope?: EvolutionScope) {
    if (!this.activation?.pauseTraffic) throw new Error('Evolution traffic routing is not configured');
    return this.activation.pauseTraffic(id, reason, scope);
  }
  async resumeTraffic(id: string, rolloutRef: string, scope?: EvolutionScope) {
    if (!this.activation?.resumeTraffic) throw new Error('Evolution traffic routing is not configured');
    const route = (await this.activation.listTraffic?.(scope) ?? []).find(item => item.candidateId === id && item.status === 'paused');
    if (!route) throw new Error('Unknown paused traffic canary');
    const candidate = await this.repository.get(id, scope);
    if (candidate.status !== 'promoted' || candidate.target !== route.target || candidate.proposedVersion !== route.version || candidate.baseVersion !== route.baseVersion || (route.contentHash !== undefined && evolutionContentHash({ target: candidate.target, version: candidate.proposedVersion, change: candidate.change }) !== route.contentHash)) throw new Error('Traffic canary candidate no longer matches its promoted release');
    parseActivationChange(candidate.target, candidate.change);
    return this.activation.resumeTraffic(id, rolloutRef, scope);
  }
  async stopTraffic(id: string, reason: string, scope?: EvolutionScope) {
    if (!this.activation?.stopTraffic) throw new Error('Evolution traffic routing is not configured');
    return this.activation.stopTraffic(id, reason, scope);
  }
  async recordTraffic(id: string, observation: EvolutionTrafficObservation, scope?: EvolutionScope) {
    if (!this.activation?.recordTraffic) throw new Error('Evolution traffic routing is not configured');
    const routes = await this.activation.listTraffic?.(scope) ?? [];
    const route = routes.find(item => item.candidateId === id && item.status !== 'stopped');
    if (!route) throw new Error('Unknown traffic canary');
    const candidate = await this.repository.get(id, scope);
    if (candidate.status !== 'promoted' || candidate.target !== route.target || candidate.proposedVersion !== route.version || candidate.baseVersion !== route.baseVersion || (route.contentHash !== undefined && evolutionContentHash({ target: candidate.target, version: candidate.proposedVersion, change: candidate.change }) !== route.contentHash)) throw new Error('Traffic canary candidate no longer matches its promoted release');
    return this.activation.recordTraffic(id, observation, scope);
  }
  async selectActiveWithTraffic(scope: EvolutionScope, routingKey: string): Promise<EvolutionTrafficSelection> {
    const active = await this.listActive(scope);
    if (!this.activation?.listTraffic) return { active, traffic: [] };
    const traffic = await this.activation.listTraffic(scope);
    const selected = new Map(active.map(release => [release.target, release]));
    const decisions: EvolutionTrafficSelection['traffic'] = [];
    for (const route of traffic.filter(item => item.status === 'active')) {
      const base = selected.get(route.target);
      if (!base || base.candidateId !== route.baseCandidateId) throw new Error('Traffic canary base release no longer matches the active release');
      const bucket = createHash('sha256').update(`${routingKey}:${route.id}`).digest().readUInt32BE(0) % 10000;
      const candidate = await this.repository.get(route.candidateId, scope);
      if (candidate.status !== 'promoted' || candidate.target !== route.target || candidate.proposedVersion !== route.version || candidate.baseVersion !== route.baseVersion || (route.contentHash !== undefined && evolutionContentHash({ target: candidate.target, version: candidate.proposedVersion, change: candidate.change }) !== route.contentHash)) throw new Error('Traffic canary candidate no longer matches its promoted release');
      parseActivationChange(candidate.target, candidate.change);
      if (bucket >= route.percentage) {
        decisions.push({ routeId: route.id, target: route.target, candidateId: route.candidateId, percentage: route.percentage, bucket, selected: false });
        continue;
      }
      selected.set(route.target, { target: route.target, candidateId: candidate.id, baseVersion: candidate.baseVersion, version: candidate.proposedVersion, change: candidate.change, contentHash: evolutionContentHash({ target: candidate.target, version: candidate.proposedVersion, change: candidate.change }), activationRef: route.rolloutRef, activatedAt: route.updatedAt, owner: route.owner, tenantId: route.tenantId, schemaVersion: 1 });
      decisions.push({ routeId: route.id, target: route.target, candidateId: route.candidateId, percentage: route.percentage, bucket, selected: true });
    }
    return { active: [...selected.values()].sort((a, b) => a.target.localeCompare(b.target)), traffic: decisions };
  }
  async selectActive(scope: EvolutionScope, routingKey: string): Promise<ActiveEvolution[]> {
    return (await this.selectActiveWithTraffic(scope, routingKey)).active;
  }
  async activationStatus(scope?: EvolutionScope) {
    return { configured: Boolean(this.activation), baselineVersions, active: await this.listActive(scope), traffic: await this.listTraffic(scope), history: this.activation ? await this.activation.history(scope) : [] };
  }
  async activate(id: string, activationRef: string, scope?: EvolutionScope): Promise<ActiveEvolution> {
    if (!this.activation) throw new Error('Evolution activation store is not configured');
    const candidate = await this.repository.get(id, scope);
    if (candidate.status !== 'promoted') throw new Error('Only a promoted candidate can be activated');
    const target = activationTargetSchema.safeParse(candidate.target);
    if (!target.success) throw new Error(`No runtime activation adapter exists for ${candidate.target}`);
    parseActivationChange(target.data, candidate.change);
    return this.activation.activate({ target: target.data, candidateId: candidate.id, baseVersion: candidate.baseVersion, version: candidate.proposedVersion, change: candidate.change, activationRef: z.string().trim().min(1).max(200).parse(activationRef), ...(scope ? { owner: scope.owner, tenantId: scope.tenantId } : {}) });
  }
  evaluate(id: string, input: unknown, scope?: EvolutionScope): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.evaluate(candidate, evaluationInputSchema.parse(input) as EvolutionEvaluation), scope); }
  approve(id: string, approvalRef: string, scope?: EvolutionScope): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.approve(candidate, z.string().min(1).max(200).parse(approvalRef)), scope); }
  startShadow(id: string, scope?: EvolutionScope): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.startShadow(candidate), scope); }
  recordShadow(id: string, input: unknown, scope?: EvolutionScope): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.recordShadow(candidate, parseRolloutObservation(input)), scope); }
  startCanary(id: string, scope?: EvolutionScope): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.startCanary(candidate), scope); }
  recordCanary(id: string, input: unknown, scope?: EvolutionScope): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.recordCanary(candidate, parseRolloutObservation(input)), scope); }
  promote(id: string, scope?: EvolutionScope): Promise<EvolutionCandidate> { return this.repository.mutate(id, candidate => this.engine.promote(candidate), scope); }
  async rollback(id: string, reason: string, scope?: EvolutionScope): Promise<EvolutionCandidate> {
    const validatedReason = z.string().trim().min(1).max(4000).parse(reason);
    const candidate = await this.repository.get(id, scope);
    if (candidate.status !== 'rolled_back') this.engine.rollback(candidate, validatedReason);
    // Deactivate/revoke before changing candidate state. If the second write
    // fails, new Runs already use the predecessor and repeating rollback is safe.
    // A concurrent activation cannot resurrect a revoked candidate.
    if (this.activation) await this.activation.revoke(id, validatedReason, scope);
    return this.repository.mutate(id, current => current.status === 'rolled_back' ? current : this.engine.rollback(current, validatedReason), scope);
  }
}

function parseRolloutObservation(input: unknown) {
  const value = z.object({
    id: z.string().min(1).max(200), passed: z.boolean(), score: z.number().min(0).max(1),
    evidenceRefs: z.array(z.string().min(1).max(200)).min(1).max(100), recordedAt: z.string().datetime({ offset: true }).optional(),
  }).strict().parse(input);
  return rolloutObservationSchema.parse({ ...value, recordedAt: value.recordedAt ?? new Date().toISOString() });
}
