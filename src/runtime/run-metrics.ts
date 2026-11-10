import type { AgentRun } from './contracts.js';

export interface RunMetrics {
  runId: string; status: string; completed: boolean;
  /** Every requirement passed on the first independent check, with no revision. */
  acceptedWithoutRework: boolean;
  revisions: number;
  /** Times a person had to step in. Approvals by a Work Grant are not people. */
  humanInterventions: number;
  elapsedSeconds: number | null;
  modelTokens: number; externalTokens: number; costUsd: number | null;
}

const PERSON_STEPPED_IN = new Set(['input.received', 'run.taken_over', 'run.paused', 'run.reconciled', 'plan.revision_requested']);

/** The milestone's measures for one Run, from its durable record only. */
export function runMetrics(run: AgentRun): RunMetrics {
  const events = run.events ?? [];
  const revisions = events.filter(item => item.type === 'review.revision_requested').length;
  const checks = run.acceptanceChecks ?? [];
  const asked = events.filter(item => PERSON_STEPPED_IN.has(item.type) && (item.data as { reason?: string } | undefined)?.reason !== 'work_grant_revoked').length;
  const approvedByPerson = run.approval?.approved && !String(run.approval.actor ?? '').startsWith('grant:') ? 1 : 0;
  const actionApprovals = events.filter(item => item.type === 'action.approved').length;
  const started = Date.parse(events[0]?.at ?? ''), ended = Date.parse(events.at(-1)?.at ?? '');
  const external = [...(run.delegationOutcomes ?? []).map(item => (item.result as { cost?: { tokens?: number; money?: number } } | undefined)?.cost), ...checks.map(item => item.cost)];
  const money = external.map(item => item?.money).filter((item): item is number => typeof item === 'number');
  const modelMoney = run.modelUsage?.moneyUsd;
  return {
    runId: run.id, status: run.status, completed: run.status === 'succeeded',
    acceptedWithoutRework: run.status === 'succeeded' && revisions === 0 && checks.some(item => !item.ignored) && checks.filter(item => !item.ignored).every(item => item.passed),
    revisions, humanInterventions: asked + approvedByPerson + actionApprovals,
    elapsedSeconds: Number.isNaN(started) || Number.isNaN(ended) ? null : Math.round((ended - started) / 1000),
    modelTokens: run.modelUsage?.tokens ?? 0,
    externalTokens: external.reduce((sum, item) => sum + (item?.tokens ?? 0), 0),
    // Null rather than a low number when part of the spend was never priced.
    costUsd: money.length === external.length && modelMoney !== undefined ? money.reduce((sum, item) => sum + item, modelMoney) : money.length ? null : modelMoney ?? null,
  };
}
