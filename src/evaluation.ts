import type { EvolutionCandidate, EvolutionEvaluation } from './evolution.js';

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

export interface RsiEvaluationPolicy {
  requiredModes?: EvaluationMode[];
  minimumScore?: number;
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
