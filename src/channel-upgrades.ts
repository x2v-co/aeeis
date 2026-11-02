import type { EvolutionCandidate } from './evolution.js';
import { requiredRolloutObservations } from './evolution.js';

/** Interaction-design §8.9: a Bot upgrade enters the channel as a card instead of replacing anything silently.
 * Upgrades belong to the room owner and apply to every Bot's new Runs, so every group chat of that owner shows them. */
export type ChannelUpgradeCard = ChannelUpgradeFull | ChannelUpgradeSummary;
export interface ChannelUpgradeSummary {
  kind: 'summary';
  id: string;
  target: EvolutionCandidate['target'];
  version: string;
  status: EvolutionCandidate['status'];
  updatedAt: string;
}
export interface ChannelUpgradeFull extends Omit<ChannelUpgradeSummary, 'kind'> {
  kind: 'full';
  baseVersion: string;
  change: string;
  reason: string;
  risk: EvolutionCandidate['risk'];
  evaluations: Array<{ kind: string; passed: boolean; score: number }>;
  /** Every required evaluation has passed, so the owner can approve. */
  evaluated: boolean;
  shadow: { passed: number; failed: number; needed: number };
  canary: { passed: number; failed: number; needed: number };
  sources: number;
  /** A task in this channel produced the signal the upgrade came from. */
  fromThisChannel: boolean;
  /** How many of the owner's group chats start new Runs with it once it is live. */
  affectedChannels: number;
  /** New Runs already use it. A promoted upgrade does nothing until it is activated. */
  active: boolean;
  /** This installation can make a promoted upgrade live for new Runs. */
  canActivate: boolean;
}

const REQUIRED_EVALUATIONS = ['replay', 'holdout', 'safety'] as const;
const OPEN_STATUSES = new Set<EvolutionCandidate['status']>(['proposed', 'evaluating', 'held', 'approved', 'shadowing', 'canarying']);
/** Settled upgrades stay on the channel this long, so people see what changed. */
export const SETTLED_UPGRADE_DAYS = 7;

/** Run id of the signal an upgrade was proposed from (`rsi-signal:<runId>:<eventId>`). */
export function upgradeSourceRunId(candidate: Pick<EvolutionCandidate, 'proposalSignalId'>): string | undefined {
  const [prefix, runId] = candidate.proposalSignalId?.split(':') ?? [];
  return prefix === 'rsi-signal' && runId ? runId : undefined;
}

export function channelUpgradeCards(candidates: readonly EvolutionCandidate[], input: { manager: boolean; roomRunIds: ReadonlySet<string>; affectedChannels: number; activation?: { configured: boolean; active: ReadonlySet<string> }; now: string }): ChannelUpgradeCard[] {
  const since = Date.parse(input.now) - SETTLED_UPGRADE_DAYS * 86_400_000;
  return candidates
    .filter(candidate => OPEN_STATUSES.has(candidate.status) || Date.parse(candidate.updatedAt ?? candidate.createdAt) >= since)
    .sort((left, right) => (left.updatedAt ?? left.createdAt).localeCompare(right.updatedAt ?? right.createdAt))
    .map(candidate => {
      const summary = { id: candidate.id, target: candidate.target, version: candidate.proposedVersion, status: candidate.status, updatedAt: candidate.updatedAt ?? candidate.createdAt };
      if (!input.manager) return { kind: 'summary', ...summary };
      const tally = (observations: EvolutionCandidate['shadowObservations'], phase: 'shadow' | 'canary') => ({
        passed: (observations ?? []).filter(item => item.passed).length, failed: (observations ?? []).filter(item => !item.passed).length, needed: requiredRolloutObservations(candidate.risk, phase),
      });
      const sourceRun = upgradeSourceRunId(candidate);
      return {
        kind: 'full', ...summary, baseVersion: candidate.baseVersion, change: clip(candidate.change, 2000), reason: clip(candidate.reason, 1000), risk: candidate.risk,
        evaluations: candidate.evaluations.map(item => ({ kind: item.kind, passed: item.passed, score: item.score })),
        evaluated: REQUIRED_EVALUATIONS.every(kind => candidate.evaluations.some(item => item.kind === kind && item.passed)) && candidate.evaluations.every(item => item.passed),
        shadow: tally(candidate.shadowObservations, 'shadow'), canary: tally(candidate.canaryObservations, 'canary'),
        sources: candidate.sourceReceiptRefs.length, fromThisChannel: Boolean(sourceRun && input.roomRunIds.has(sourceRun)), affectedChannels: input.affectedChannels,
        active: Boolean(input.activation?.active.has(candidate.id)), canActivate: Boolean(input.activation?.configured),
      };
    });
}

function clip(text: string, length: number): string { return text.length > length ? `${text.slice(0, length)}…` : text; }
