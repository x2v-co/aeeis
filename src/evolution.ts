import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const isoDate = z.string().datetime({ offset: true });
const id = z.string().regex(/^evo_[a-f0-9-]{36}$/);
export const rolloutObservationSchema = z.object({
  id: z.string().min(1).max(200), passed: z.boolean(), score: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string().min(1).max(200)).min(1).max(100), recordedAt: isoDate,
}).strict();
export type RolloutObservation = z.infer<typeof rolloutObservationSchema>;
export const evaluationAttemptSchema = z.object({
  globalBudgetAccountKey: z.string().max(1000).optional(),
  usage: z.object({ tokens: z.number().int().nonnegative().optional(), moneyUsd: z.number().nonnegative().optional() }).strict().optional(),
  id: z.string().min(1).max(200), mode: z.enum(['replay', 'holdout', 'safety', 'cost', 'shadow']),
  suiteHash: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['started', 'completed', 'failed', 'reconciled']),
  startedAt: isoDate, endedAt: isoDate.optional(), error: z.string().max(2000).optional(),
  reconciliationReason: z.string().min(1).max(2000).optional(),
  evaluation: z.object({ kind: z.enum(['replay', 'holdout', 'safety', 'cost', 'shadow']), passed: z.boolean(), score: z.number().min(0).max(1), evidenceRefs: z.array(z.string().max(200)).max(100), completedAt: isoDate }).strict().optional(),
}).strict();
export type EvaluationAttempt = z.infer<typeof evaluationAttemptSchema>;

export const evolutionCandidateSchema = z.object({
  schemaVersion: z.literal(1), id, owner: z.string().min(1).max(200).default('owner'), tenantId: z.string().min(1).max(200).default('local'), proposalSignalId: z.string().trim().min(1).max(200).optional(),
  target: z.enum(['profile', 'skill', 'prompt', 'workflow', 'tool-policy', 'model-policy']),
  baseVersion: z.string().min(1).max(200), proposedVersion: z.string().min(1).max(200), change: z.string().min(1).max(8000),
  sourceReceiptRefs: z.array(z.string().min(1).max(200)).min(1).max(100), reason: z.string().min(1).max(4000),
  risk: z.enum(['low', 'medium', 'high']), status: z.enum(['proposed', 'evaluating', 'held', 'approved', 'shadowing', 'canarying', 'promoted', 'rejected', 'rolled_back']),
  createdAt: isoDate, updatedAt: isoDate.optional(), evaluations: z.array(z.object({ id: z.string().min(1).max(200), kind: z.enum(['replay', 'holdout', 'safety', 'cost', 'shadow']), passed: z.boolean(), score: z.number().min(0).max(1), evidenceRefs: z.array(z.string().max(200)).max(100), completedAt: isoDate }).strict()).max(100),
  evaluationAttempts: z.array(evaluationAttemptSchema).max(100).optional(),
  shadowStartedAt: isoDate.optional(), shadowObservations: z.array(rolloutObservationSchema).max(100).optional(),
  canaryStartedAt: isoDate.optional(), canaryObservations: z.array(rolloutObservationSchema).max(100).optional(),
  rolloutAttempts: z.array(z.object({
    globalBudgetAccountKey: z.string().max(1000).optional(),
    id: z.string().min(1).max(200), phase: z.enum(['shadow', 'canary']), caseId: z.string().min(1).max(193),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['started', 'completed', 'failed', 'reconciled']),
    startedAt: isoDate, endedAt: isoDate.optional(), error: z.string().max(200).optional(),
    reconciliationReason: z.string().min(1).max(2000).optional(),
    observation: rolloutObservationSchema.optional(),
  }).strict()).max(200).optional(),
  promotedAt: isoDate.optional(), rolledBackAt: isoDate.optional(), approvalRef: z.string().max(200).optional(),
}).strict();
export type EvolutionCandidate = z.infer<typeof evolutionCandidateSchema>;
export type EvolutionEvaluation = Omit<EvolutionCandidate['evaluations'][number], 'id' | 'completedAt'> & { id?: string; completedAt?: string };

export class EvolutionEngine {
  constructor(private readonly requiredEvaluationKinds: Array<EvolutionCandidate['evaluations'][number]['kind']> = ['replay', 'holdout', 'safety']) {
    if (requiredEvaluationKinds.length === 0) throw new Error('At least one RSI evaluation gate is required');
  }

  propose(input: Pick<EvolutionCandidate, 'target' | 'baseVersion' | 'proposedVersion' | 'change' | 'sourceReceiptRefs' | 'reason' | 'risk'> & Partial<Pick<EvolutionCandidate, 'owner' | 'tenantId' | 'proposalSignalId'>> & { id?: EvolutionCandidate['id'] }): EvolutionCandidate {
    const now = new Date().toISOString();
    return evolutionCandidateSchema.parse({ schemaVersion: 1, ...input, id: input.id ?? 'evo_' + randomUUID(), status: 'proposed', createdAt: now, updatedAt: now, evaluations: [] });
  }
  evaluate(candidate: EvolutionCandidate, evaluation: EvolutionEvaluation): EvolutionCandidate {
    if (!['proposed', 'evaluating', 'held'].includes(candidate.status)) throw new Error('Candidate cannot accept evaluations in its current state');
    const next = structuredClone(candidate); next.status = 'evaluating';
    if (next.evaluations.some(item => item.kind === evaluation.kind)) throw new Error(`Evaluation gate already recorded: ${evaluation.kind}`);
    next.evaluations.push({ id: evaluation.id ?? 'evaluation_' + randomUUID(), kind: evaluation.kind, passed: evaluation.passed, score: evaluation.score, evidenceRefs: evaluation.evidenceRefs, completedAt: evaluation.completedAt ?? new Date().toISOString() });
    if (next.evaluations.some(item => !item.passed)) next.status = 'held';
    return evolutionCandidateSchema.parse(next);
  }
  approve(candidate: EvolutionCandidate, approvalRef: string): EvolutionCandidate {
    if (candidate.status !== 'evaluating' && candidate.status !== 'held') throw new Error('Candidate must be evaluated before approval');
    if (candidate.evaluations.length === 0 || candidate.evaluations.some(item => !item.passed)) throw new Error('All required evaluations must pass before approval');
    const completedKinds = new Set(candidate.evaluations.map(item => item.kind));
    const missing = this.requiredEvaluationKinds.filter(kind => !completedKinds.has(kind));
    if (missing.length > 0) throw new Error('Required evaluations are missing: ' + missing.join(', '));
    const next = structuredClone(candidate); next.status = 'approved'; next.approvalRef = approvalRef; return evolutionCandidateSchema.parse(next);
  }
  startShadow(candidate: EvolutionCandidate): EvolutionCandidate {
    if (candidate.status !== 'approved') throw new Error('Candidate requires explicit approval before shadow rollout');
    const next = structuredClone(candidate); next.status = 'shadowing'; next.shadowStartedAt = new Date().toISOString(); next.shadowObservations = [];
    return evolutionCandidateSchema.parse(next);
  }
  recordShadow(candidate: EvolutionCandidate, observation: RolloutObservation): EvolutionCandidate {
    if (candidate.status !== 'shadowing') throw new Error('Candidate is not in shadow rollout');
    const next = structuredClone(candidate); next.shadowObservations ??= [];
    if (next.shadowObservations.some(item => item.id === observation.id)) throw new Error('Shadow observation already exists');
    next.shadowObservations.push(rolloutObservationSchema.parse(observation));
    if (!observation.passed) next.status = 'held';
    return evolutionCandidateSchema.parse(next);
  }
  startCanary(candidate: EvolutionCandidate): EvolutionCandidate {
    if (candidate.rolloutAttempts?.some(attempt => attempt.state === 'started')) throw new Error('Pending rollout attempt requires completion or reconciliation');
    if (candidate.status !== 'shadowing') throw new Error('Candidate must be in shadow rollout before canary rollout');
    if (!rolloutReady(candidate.shadowObservations, candidate.risk, 'shadow')) throw new Error('Shadow rollout has not met its observation gate');
    const next = structuredClone(candidate); next.status = 'canarying'; next.canaryStartedAt = new Date().toISOString(); next.canaryObservations = [];
    return evolutionCandidateSchema.parse(next);
  }
  recordCanary(candidate: EvolutionCandidate, observation: RolloutObservation): EvolutionCandidate {
    if (candidate.status !== 'canarying') throw new Error('Candidate is not in canary rollout');
    const next = structuredClone(candidate); next.canaryObservations ??= [];
    if (next.canaryObservations.some(item => item.id === observation.id)) throw new Error('Canary observation already exists');
    next.canaryObservations.push(rolloutObservationSchema.parse(observation));
    if (!observation.passed) next.status = 'held';
    return evolutionCandidateSchema.parse(next);
  }
  promote(candidate: EvolutionCandidate): EvolutionCandidate {
    if (candidate.rolloutAttempts?.some(attempt => attempt.state === 'started')) throw new Error('Pending rollout attempt requires completion or reconciliation');
    const direct = candidate.status === 'approved' && candidate.risk === 'low';
    const canary = candidate.status === 'canarying' && rolloutReady(candidate.canaryObservations, candidate.risk, 'canary');
    if (!direct && !canary) throw new Error(candidate.status === 'approved' ? 'Medium and high risk candidates require shadow and canary rollout before promotion' : 'Candidate requires explicit approval and a completed rollout before promotion');
    const next = structuredClone(candidate); next.status = 'promoted'; next.promotedAt = new Date().toISOString(); return evolutionCandidateSchema.parse(next);
  }
  rollback(candidate: EvolutionCandidate, reason: string): EvolutionCandidate {
    if (!['promoted', 'approved', 'shadowing', 'canarying', 'held'].includes(candidate.status)) throw new Error('Only an approved or rolled out candidate can be rolled back');
    const next = structuredClone(candidate); next.status = 'rolled_back'; next.rolledBackAt = new Date().toISOString(); next.reason = next.reason + '\nRollback: ' + reason; return evolutionCandidateSchema.parse(next);
  }
}

export function requiredRolloutObservations(risk: EvolutionCandidate['risk'], phase: 'shadow' | 'canary'): number {
  if (risk === 'low') return 1;
  if (risk === 'medium') return 3;
  return 5;
}

function rolloutReady(observations: RolloutObservation[] | undefined, risk: EvolutionCandidate['risk'], phase: 'shadow' | 'canary'): boolean {
  const items = observations ?? [];
  return items.length >= requiredRolloutObservations(risk, phase) && items.every(item => item.passed);
}
