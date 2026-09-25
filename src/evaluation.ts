import type { EvolutionCandidate, EvolutionEvaluation } from './evolution.js';
import { z } from 'zod';
import { HttpDependencyProbe, type DependencyHealth } from './dependency-health.js';

export type EvaluationMode = 'replay' | 'holdout' | 'safety' | 'cost' | 'shadow' | 'canary';
type EvaluationGateMode = Exclude<EvaluationMode, 'canary'>;

export interface EvaluationCase {
  id: string;
  input: unknown;
}

export interface EvaluationObservation {
  passed: boolean;
  score: number;
  evidenceRefs: string[];
  cost?: number;
  /** Provider-reported usage; model-authored `cost` is not a billing fact. */
  usage?: { tokens?: number; moneyUsd?: number };
}

export interface EvaluationAccounting {
  idempotencyKey: string;
}

export interface EvaluationUsage {
  tokens?: number;
  moneyUsd?: number;
}

/** Internal gate result. Usage is kept outside the candidate schema and is
 * consumed by the durable global budget ledger before the gate is persisted. */
export type EvaluationResult = EvolutionEvaluation & { usage?: EvaluationUsage };

export interface RsiEvaluationHarness {
  evaluate(candidate: EvolutionCandidate, mode: EvaluationMode, testCase: EvaluationCase, accounting?: EvaluationAccounting): Promise<EvaluationObservation>;
  /** Optional read-only evaluator dependency probe. It must not execute a case. */
  health?(): Promise<DependencyHealth>;
}

export interface EvaluationSuite {
  replay: EvaluationCase[];
  holdout: EvaluationCase[];
  safety: EvaluationCase[];
  cost?: EvaluationCase[];
  shadow?: EvaluationCase[];
}

export const evaluationCaseSchema = z.object({ id: z.string().trim().min(1).max(200), input: z.unknown() }).strict();
export const evaluationSuiteSchema = z.object({
  replay: z.array(evaluationCaseSchema).max(100),
  holdout: z.array(evaluationCaseSchema).max(100),
  safety: z.array(evaluationCaseSchema).max(100),
  cost: z.array(evaluationCaseSchema).max(100).optional(),
  shadow: z.array(evaluationCaseSchema).max(100).optional(),
}).strict();

export interface RsiEvaluationPolicy {
  requiredModes?: EvaluationGateMode[];
  minimumScore?: number;
}

/** A separately deployed evaluator can run cases without receiving AEEIS write access. */
export class HttpRsiEvaluationHarness implements RsiEvaluationHarness {
  private readonly endpoint: string;
  private readonly probe: HttpDependencyProbe;
  constructor(endpoint: string, private readonly token?: string, private readonly timeoutMs = 60_000, allowInsecureHttp = false, healthEndpoint?: string) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !(allowInsecureHttp || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('RSI evaluator URL must use HTTPS except loopback');
    if (url.username || url.password || url.hash) throw new Error('RSI evaluator URL must not contain credentials or fragments');
    this.endpoint = url.toString();
    this.probe = new HttpDependencyProbe(this.endpoint, healthEndpoint, token, Math.min(timeoutMs, 3_000));
  }
  async health(): Promise<DependencyHealth> { return this.probe.health(); }
  async evaluate(candidate: EvolutionCandidate, mode: EvaluationMode, testCase: EvaluationCase, accounting?: EvaluationAccounting): Promise<EvaluationObservation> {
    const response = await fetch(this.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ schemaVersion: 'rsi-evaluation-request/1', candidate, mode, testCase, ...(accounting ? { idempotencyKey: accounting.idempotencyKey } : {}) }),
    });
    if (!response.ok) throw new Error(`RSI evaluator returned HTTP ${response.status}`);
    const observation = z.object({ schemaVersion: z.literal('rsi-evaluation-observation/1'), passed: z.boolean(), score: z.number().min(0).max(1), evidenceRefs: z.array(z.string().min(1).max(200)).max(100), cost: z.number().nonnegative().optional(), usage: z.object({ tokens: z.number().int().nonnegative().optional(), moneyUsd: z.number().nonnegative().optional() }).strict().optional() }).strict().parse(await response.json());
    return { passed: observation.passed, score: observation.score, evidenceRefs: observation.evidenceRefs, ...(observation.cost === undefined ? {} : { cost: observation.cost }), ...(observation.usage === undefined ? {} : { usage: { ...(observation.usage.tokens === undefined ? {} : { tokens: observation.usage.tokens }), ...(observation.usage.moneyUsd === undefined ? {} : { moneyUsd: observation.usage.moneyUsd }) } }) };
  }
}

/**
 * Runs bounded, independent gates for an RSI candidate. The harness owns the
 * actual model/skill execution; this layer only aggregates observations and
 * emits evidence-backed evaluations that EvolutionEngine can approve.
 */
export class RsiEvaluator {
  private readonly requiredModes: EvaluationGateMode[];
  private readonly minimumScore: number;

  constructor(policy: RsiEvaluationPolicy = {}) {
    this.requiredModes = policy.requiredModes ?? ['replay', 'holdout', 'safety'];
    this.minimumScore = policy.minimumScore ?? 0.7;
    if (this.requiredModes.length === 0) throw new Error('At least one RSI evaluation gate is required');
    if (this.minimumScore < 0 || this.minimumScore > 1) throw new Error('RSI minimum score must be between 0 and 1');
  }

  async evaluate(candidate: EvolutionCandidate, suite: EvaluationSuite, harness: RsiEvaluationHarness, accountingPrefix?: string): Promise<EvaluationResult[]> {
    const evaluations: EvaluationResult[] = [];
    for (const mode of this.requiredModes) {
      const cases = suite[mode] ?? [];
      if (cases.length === 0) throw new Error(`RSI evaluation gate ${mode} has no cases`);
      evaluations.push(await this.runGate(candidate, mode, cases, harness, accountingPrefix));
    }
    for (const mode of ['cost', 'shadow'] as const) {
      const cases = suite[mode] ?? [];
      if (cases.length > 0 && !this.requiredModes.includes(mode)) evaluations.push(await this.runGate(candidate, mode, cases, harness, accountingPrefix));
    }
    return evaluations;
  }

  private async runGate(candidate: EvolutionCandidate, mode: EvaluationGateMode, cases: EvaluationCase[], harness: RsiEvaluationHarness, accountingPrefix?: string): Promise<EvaluationResult> {
    const settled = await Promise.allSettled(cases.map(testCase => harness.evaluate(candidate, mode, testCase, accountingPrefix ? { idempotencyKey: `${accountingPrefix}:${mode}:${testCase.id}` } : undefined)));
    const observations = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const scores = observations.map(item => item.score).filter(score => Number.isFinite(score) && score >= 0 && score <= 1);
    const passed = observations.length === cases.length && scores.length === cases.length && observations.every(item => item.passed) && average(scores) >= this.minimumScore;
    const evidenceRefs = [...new Set(observations.flatMap(item => item.evidenceRefs))];
    const usages = observations.map(item => item.usage);
    const tokens = usages.length === cases.length && usages.every(item => item?.tokens !== undefined)
      ? usages.reduce((sum, item) => sum + item!.tokens!, 0) : undefined;
    const moneyUsd = usages.length === cases.length && usages.every(item => item?.moneyUsd !== undefined)
      ? usages.reduce((sum, item) => sum + item!.moneyUsd!, 0) : undefined;
    return {
      kind: mode,
      passed,
      score: scores.length ? average(scores) : 0,
      evidenceRefs,
      ...(tokens === undefined && moneyUsd === undefined ? {} : { usage: { ...(tokens === undefined ? {} : { tokens }), ...(moneyUsd === undefined ? {} : { moneyUsd }) } }),
    };
  }
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
