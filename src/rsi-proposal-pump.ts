import { z } from 'zod';
import type { RsiService, EvolutionScope } from './rsi.js';
import type { AgentRun, Event } from './runtime/contracts.js';
import type { RunRepository } from './runtime/repository.js';
import type { RsiProposalClaimStore } from './rsi-proposal-claims.js';
import type { DurableRsiProposalSynthesis } from './rsi-proposal-synthesizer.js';
import { RunEventScanner, type RunScanCursorStore } from './run-scan-cursor.js';

/** A proposal is intentionally declarative. A detector may discover a signal
 * without being allowed to invent a change; only a proposal carrying an
 * explicit, evidence-backed change can enter the governed RSI lifecycle. */
export const rsiProposalSchema = z.object({
  target: z.enum(['profile', 'skill', 'prompt', 'workflow', 'tool-policy', 'model-policy']),
  baseVersion: z.string().trim().min(1).max(200), proposedVersion: z.string().trim().min(1).max(200),
  change: z.string().trim().min(1).max(8000), reason: z.string().trim().min(1).max(4000),
  risk: z.enum(['low', 'medium', 'high']), sourceReceiptRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
}).strict();
export type RsiProposal = z.infer<typeof rsiProposalSchema>;
export type ImprovementSignalKind = 'review_low_confidence' | 'review_needs_revision' | 'run_failed' | 'correction';
export interface ImprovementSignal {
  schemaVersion: 'rsi-improvement-signal/1'; id: string; kind: ImprovementSignalKind;
  runId: string; eventId: string; owner: string; tenantId: string; sourceRefs: string[];
  reason: string; occurredAt: string; proposal?: RsiProposal;
}
export interface RsiProposalPumpOptions { maxSignalsPerPass?: number; lowConfidenceThreshold?: number; claimLeaseMs?: number; claimStore?: RsiProposalClaimStore; synthesis?: DurableRsiProposalSynthesis; scanCursorStore?: RunScanCursorStore; scanCursorName?: string; scanPageSize?: number; onError?: (error: unknown, run: AgentRun, event: Event) => void }
export interface RsiProposalPumpResult { inspected: number; signalled: number; proposed: number; skipped: number; failed: number }

function validRef(value: string): boolean { return value.length > 0 && value.length <= 200; }
function evidenceRefs(run: AgentRun): Set<string> {
  return new Set([
    ...run.context.sources.map(item => item.id), ...run.artifacts.map(item => item.id),
    ...(run.toolReceipts ?? []).filter(item => item.authorization?.decision !== 'isolated').map(item => item.receiptId), ...(run.delegationOutcomes ?? []).filter(item => item.disposition !== 'isolated').map(item => item.receiptRef),
    ...run.calls.map(item => item.id), ...run.events.filter(item => !item.type.startsWith('rsi.')).map(item => item.id),
  ]);
}
export function improvementSignalFor(run: AgentRun, item: Event, threshold = 0.5): ImprovementSignal | undefined {
  let kind: ImprovementSignalKind | undefined;
  let reason = '';
  const proposalValue = item.data.proposal;
  const parsedProposal = proposalValue === undefined ? undefined : rsiProposalSchema.safeParse(proposalValue);
  if (item.type === 'review.completed' && ((typeof item.data.reviewConfidence === 'number' && item.data.reviewConfidence <= threshold) || item.data.verdict === 'needs_revision' || parsedProposal?.success)) {
    kind = item.data.verdict === 'needs_revision' ? 'review_needs_revision' : 'review_low_confidence';
    reason = item.data.verdict === 'needs_revision' ? 'Review requires revision' : 'Review confidence is below the configured RSI proposal threshold';
  } else if (item.type === 'run.failed') {
    kind = 'run_failed';
    reason = typeof item.data.reason === 'string' ? item.data.reason : 'Run failed';
    const validation = item.data.validation as { issues?: Array<{ path?: unknown; message?: unknown }> } | undefined;
    if (validation?.issues?.length) {
      const details = validation.issues.slice(0, 3).map(issue => `${typeof issue.path === 'string' ? issue.path : '$'}: ${typeof issue.message === 'string' ? issue.message : 'invalid'}`).join('; ');
      reason += ` (${details})`;
    }
  }
  else if (item.type === 'rsi.correction.recorded') { kind = 'correction'; reason = 'An owner correction was recorded'; }
  if (!kind) return undefined;
  const refs = parsedProposal?.success
    ? parsedProposal.data.sourceReceiptRefs
    : Array.isArray(item.data.sourceReceiptRefs) ? item.data.sourceReceiptRefs.filter((ref): ref is string => typeof ref === 'string' && validRef(ref)) : [];
  const fallback = [...evidenceRefs(run)].filter(validRef).slice(-20);
  const sourceRefs = [...new Set(refs.length ? refs : fallback)];
  if (!sourceRefs.length) return undefined;
  const proposal = parsedProposal;
  return {
    schemaVersion: 'rsi-improvement-signal/1', id: `rsi-signal:${run.id}:${item.id}`, kind,
    runId: run.id, eventId: item.id, owner: run.owner, tenantId: run.tenantId ?? 'local', sourceRefs,
    reason, occurredAt: item.at, ...(proposal?.success ? { proposal: proposal.data } : {}),
  };
}
export function improvementSignalsForRun(run: AgentRun, threshold = 0.5): ImprovementSignal[] {
  return run.events.flatMap(item => { const signal = improvementSignalFor(run, item, threshold); return signal ? [signal] : []; });
}

/** Replayable detector for Run evidence. It only creates `proposed` candidates
 * when the originating event includes a complete proposal. Detection alone is
 * observable and harmless; evaluation, approval and activation stay separate. */
export class RsiProposalPump {
  private inFlight: Promise<RsiProposalPumpResult> | undefined;
  private cursor = 0;
  private readonly maxSignalsPerPass: number;
  private readonly threshold: number;
  private readonly onError: NonNullable<RsiProposalPumpOptions['onError']>;
  private readonly claimLeaseMs: number;
  private readonly claimStore: RsiProposalClaimStore | undefined;
  private synthesis: DurableRsiProposalSynthesis | undefined;
  private readonly scanner: RunEventScanner | undefined;
  constructor(private readonly repository: RunRepository, private readonly rsi: RsiService, options: RsiProposalPumpOptions = {}) {
    this.maxSignalsPerPass = options.maxSignalsPerPass ?? 100;
    if (!Number.isInteger(this.maxSignalsPerPass) || this.maxSignalsPerPass < 1 || this.maxSignalsPerPass > 1000) throw new Error('maxSignalsPerPass must be an integer between 1 and 1000');
    this.threshold = options.lowConfidenceThreshold ?? 0.5;
    if (!Number.isFinite(this.threshold) || this.threshold < 0 || this.threshold > 1) throw new Error('lowConfidenceThreshold must be between 0 and 1');
    this.claimLeaseMs = options.claimLeaseMs ?? 30_000;
    if (!Number.isInteger(this.claimLeaseMs) || this.claimLeaseMs < 1000 || this.claimLeaseMs > 86_400_000) throw new Error('claimLeaseMs must be between 1000 and 86400000');
    this.claimStore = options.claimStore;
    this.synthesis = options.synthesis;
    this.scanner = options.scanCursorStore && this.repository.scanPage
      ? new RunEventScanner(this.repository, options.scanCursorStore, options.scanCursorName ?? 'rsi-proposal-pump', options.scanPageSize ?? 25, { useEventProjection: true })
      : undefined;
    this.onError = options.onError ?? (() => undefined);
  }
  setSynthesis(synthesis: DurableRsiProposalSynthesis | undefined): void { this.synthesis = synthesis; }
  pump(): Promise<RsiProposalPumpResult> {
    if (this.inFlight) return Promise.resolve({ inspected: 0, signalled: 0, proposed: 0, skipped: 0, failed: 0 });
    this.inFlight = this.runPass().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  async drain(): Promise<void> { await this.inFlight; }
  private async runPass(): Promise<RsiProposalPumpResult> {
    const result: RsiProposalPumpResult = { inspected: 0, signalled: 0, proposed: 0, skipped: 0, failed: 0 };
    const pending: Array<{ run: AgentRun; event: Event; signal: ImprovementSignal }> = [];
    const append = (run: AgentRun, only?: Event): void => { for (const item of only ? [only] : run.events) {
      result.inspected += 1;
      const signal = improvementSignalFor(run, item, this.threshold);
      if (signal) pending.push({ run, event: item, signal });
    }};
    const batch = this.scanner ? await this.scanner.batch(this.maxSignalsPerPass) : undefined;
    if (batch) for (const entry of batch.entries) append(entry.run, entry.event);
    else for (const run of await this.repository.list()) append(run);
    if (!pending.length) { if (batch) await batch.commit(); return result; }
    const start = this.cursor % pending.length;
    const count = Math.min(this.maxSignalsPerPass, pending.length);
    for (let offset = 0; offset < count; offset += 1) {
      const current = pending[(start + offset) % pending.length]!;
      result.signalled += 1;
      const scope = { owner: current.run.owner, tenantId: current.run.tenantId ?? 'local' };
      let claimToken: string | undefined;
      try {
        if (this.claimStore) {
          const claim = await this.claimStore.claim(current.signal.id, scope, this.claimLeaseMs);
          if (!claim.claimed) { result.skipped += 1; continue; }
          claimToken = claim.token;
        }
        // Another worker may have finished since list() returned. Re-read
        // under the scope after admission before using any evidence.
        current.run = await this.repository.get(current.run.id, scope);
        if (current.run.events.some(event => event.type === 'rsi.proposal.created' && event.data.signalId === current.signal.id)) { result.skipped += 1; continue; }
        const known = evidenceRefs(current.run);
        if (current.signal.sourceRefs.some(ref => !known.has(ref))) { result.skipped += 1; continue; }
        if (!current.run.events.some(event => event.type === 'rsi.improvement.detected' && event.data.signalId === current.signal.id)) {
          await this.repository.mutate(current.run.id, run => {
            if (run.events.some(event => event.type === 'rsi.improvement.detected' && event.data.signalId === current.signal.id)) return;
            run.events.push({ id: `evt_rsi_signal_${current.signal.id.replaceAll(':', '_')}`, seq: run.events.length + 1, type: 'rsi.improvement.detected', at: new Date().toISOString(), data: { signalId: current.signal.id, kind: current.signal.kind, reason: current.signal.reason, sourceRefs: current.signal.sourceRefs, proposalAvailable: Boolean(current.signal.proposal) } });
          });
        }
        let proposal = current.signal.proposal;
        if (!proposal && this.synthesis) {
          await this.synthesis.generate(current.run, current.signal);
          current.run = await this.repository.get(current.run.id, scope);
          const { synthesizedProposal } = await import('./rsi-proposal-synthesizer.js');
          proposal = synthesizedProposal(current.run, current.signal.id);
        }
        if (!proposal) { result.skipped += 1; continue; }
        if (proposal.sourceReceiptRefs.some(ref => !known.has(ref))) { result.skipped += 1; continue; }
        const candidate = await this.rsi.propose({ ...proposal, sourceReceiptRefs: proposal.sourceReceiptRefs, proposalSignalId: current.signal.id }, { owner: current.run.owner, tenantId: current.run.tenantId ?? 'local' } satisfies EvolutionScope);
        await this.repository.mutate(current.run.id, run => {
          if (run.events.some(event => event.type === 'rsi.proposal.created' && event.data.signalId === current.signal.id)) return;
          run.events.push({ id: `evt_rsi_proposal_${current.signal.id.replaceAll(':', '_')}`, seq: run.events.length + 1, type: 'rsi.proposal.created', at: new Date().toISOString(), data: { signalId: current.signal.id, candidateId: candidate.id, kind: current.signal.kind, sourceRefs: current.signal.sourceRefs } });
        });
        result.proposed += 1;
      } catch (error) { result.failed += 1; this.onError(error, current.run, current.event); }
      finally {
        if (claimToken && this.claimStore) {
          try { await this.claimStore.release(current.signal.id, scope, claimToken); }
          catch (error) { result.failed += 1; this.onError(error, current.run, current.event); }
        }
      }
    }
    // Individual failures are retried next sweep, so one poison signal cannot
    // starve every later Run. A crash before this commit replays the batch.
    if (batch) await batch.commit();
    this.cursor = (start + count) % pending.length;
    return result;
  }
}
