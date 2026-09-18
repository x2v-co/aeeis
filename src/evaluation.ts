import type { EvolutionCandidate, EvolutionEvaluation } from './evolution.js';
import { z } from 'zod';

export type EvaluationMode = 'replay' | 'holdout' | 'safety' | 'cost' | 'shadow';

export interface EvaluationCase {
  id: string;
  input: unknown;
}

export interface EvaluationObservation {
  passed: boolean;
  score: number;
  evidenceRefs: string[];
  cost?: number;
}

export interface RsiEvaluationHarness {
  evaluate(candidate: EvolutionCandidate, mode: EvaluationMode, testCase: EvaluationCase): Promise<EvaluationObservation>;
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
  requiredModes?: EvaluationMode[];
  minimumScore?: number;
}

/** A separately deployed evaluator can run cases without receiving AEEIS write access. */
export class HttpRsiEvaluationHarness implements RsiEvaluationHarness {
  private readonly endpoint: string;
  constructor(endpoint: string, private readonly token?: string, private readonly timeoutMs = 60_000) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('RSI evaluator URL must use HTTPS except loopback');
    if (url.username || url.password || url.hash) throw new Error('RSI evaluator URL must not contain credentials or fragments');
    this.endpoint = url.toString();
  }
  async evaluate(candidate: EvolutionCandidate, mode: EvaluationMode, testCase: EvaluationCase): Promise<EvaluationObservation> {
    const response = await fetch(this.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ schemaVersion: 'rsi-evaluation-request/1', candidate, mode, testCase }),
    });
    if (!response.ok) throw new Error(`RSI evaluator returned HTTP ${response.status}`);
    const observation = z.object({ schemaVersion: z.literal('rsi-evaluation-observation/1'), passed: z.boolean(), score: z.number().min(0).max(1), evidenceRefs: z.array(z.string().min(1).max(200)).max(100), cost: z.number().nonnegative().optional() }).strict().parse(await response.json());
    return { passed: observation.passed, score: observation.score, evidenceRefs: observation.evidenceRefs, ...(observation.cost === undefined ? {} : { cost: observation.cost }) };
  }
}

/**
 * Runs bounded, independent gates for an RSI candidate. The harness owns the
 * actual model/skill execution; this layer only aggregates observations and
 * emits evidence-backed evaluations that EvolutionEngine can approve.
 */
export class RsiEvaluator {
  private readonly requiredModes: EvaluationMode[];
  private readonly minimumScore: number;

  constructor(policy: RsiEvaluationPolicy = {}) {
    this.requiredModes = policy.requiredModes ?? ['replay', 'holdout', 'safety'];
    this.minimumScore = policy.minimumScore ?? 0.7;
    if (this.requiredModes.length === 0) throw new Error('At least one RSI evaluation gate is required');
    if (this.minimumScore < 0 || this.minimumScore > 1) throw new Error('RSI minimum score must be between 0 and 1');
  }

  async evaluate(candidate: EvolutionCandidate, suite: EvaluationSuite, harness: RsiEvaluationHarness): Promise<EvolutionEvaluation[]> {
    const evaluations: EvolutionEvaluation[] = [];
    for (const mode of this.requiredModes) {
      const cases = suite[mode] ?? [];
      if (cases.length === 0) throw new Error(`RSI evaluation gate ${mode} has no cases`);
      evaluations.push(await this.runGate(candidate, mode, cases, harness));
    }
    for (const mode of ['cost', 'shadow'] as const) {
      const cases = suite[mode] ?? [];
      if (cases.length > 0 && !this.requiredModes.includes(mode)) evaluations.push(await this.runGate(candidate, mode, cases, harness));
    }
    return evaluations;
  }

  private async runGate(candidate: EvolutionCandidate, mode: EvaluationMode, cases: EvaluationCase[], harness: RsiEvaluationHarness): Promise<EvolutionEvaluation> {
    const settled = await Promise.allSettled(cases.map(testCase => harness.evaluate(candidate, mode, testCase)));
    const observations = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const scores = observations.map(item => item.score).filter(score => Number.isFinite(score) && score >= 0 && score <= 1);
    const passed = observations.length === cases.length && scores.length === cases.length && observations.every(item => item.passed) && average(scores) >= this.minimumScore;
    const evidenceRefs = [...new Set(observations.flatMap(item => item.evidenceRefs))];
    return {
      kind: mode,
      passed,
      score: scores.length ? average(scores) : 0,
      evidenceRefs,
    };
  }
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
