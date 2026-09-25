import type { AgentRun, Event } from './runtime/contracts.js';
import type { RunRepository } from './runtime/repository.js';
import { RunEventScanner, type RunScanCursorStore } from './run-scan-cursor.js';
import {
  collaborationTriggerEventSchema,
  type CollaborationTriggerEvent,
  type CollaborationTriggerService,
} from './collaboration-triggers.js';

/**
 * Converts durable Run lifecycle events into collaboration trigger events.
 *
 * The Run repository remains the source of truth. The pump is deliberately a
 * replayable projection: if the process stops after the Run commit and before
 * trigger evaluation, the next pass sees the same event again. Trigger
 * decisions are keyed by policy/event, so replay cannot create a second
 * collaboration resource.
 */
export function runEventToCollaborationTrigger(run: AgentRun, item: Event): CollaborationTriggerEvent | undefined {
  const eventType = item.type === 'review.completed'
    ? 'review.completed'
    : item.type === 'task.completed' || item.type === 'task.execution.completed'
      ? 'task.completed'
      : item.type === 'run.failed'
        ? 'task.failed'
        : undefined;
  if (!eventType) return undefined;

  const validId = (value: string): boolean => /^[a-z][a-z0-9_.-]{1,127}$/.test(value);
  const validIds = (values: string[], max: number): string[] => values.filter(validId).slice(0, max);

  const data = item.data;
  const requestedTaskId = typeof data.taskId === 'string' && data.taskId.length > 0
    ? data.taskId
    : run.taskExecution?.taskId
      ?? run.steps.find(step => step.status === 'running')?.taskId
      ?? run.steps.at(-1)?.taskId
      ?? run.id;
  const taskId = validId(requestedTaskId) ? requestedTaskId : run.id;
  const artifactRefs = validIds(run.artifacts.map(artifact => artifact.id), 200);
  const claims = run.context.sources.filter(source => validId(source.id)).slice(-200).map(source => ({
    id: source.id,
    text: source.content.slice(0, 4000),
    evidenceRefs: [source.id],
  }));
  const evidenceRefs = validIds([
    ...run.context.sources.map(source => source.id),
    ...run.artifacts.flatMap(artifact => [artifact.id, ...artifact.evidenceRefs]),
    ...(Array.isArray(data.evidenceRefs) ? data.evidenceRefs.filter((value): value is string => typeof value === 'string') : []),
  ], 100);

  return collaborationTriggerEventSchema.parse({
    schemaVersion: 'collaboration-trigger-event/1',
    eventId: `run:${run.id}:${item.id}`,
    eventType,
    source: 'system',
    owner: run.owner,
    tenantId: run.tenantId ?? 'local',
    taskId,
    contextVersion: validId(run.context.id) ? run.context.id : run.id,
    goal: run.goal,
    // An internally-triggered collaboration may only use agents explicitly
    // admitted to this Run. An empty list intentionally matches no policy
    // whose action names participants, preventing an implicit data escape.
    // Runs created before external-agent admission was introduced may not
    // carry this optional field. Treat them as having no admitted agents so
    // replay stays fail-closed instead of crashing the background pump.
    allowedAgentIds: validIds(Array.isArray(run.allowedAgents) ? run.allowedAgents : [], 12),
    context: {
      // Legacy snapshots have no proven classification. Use the most
      // restrictive boundary until their privacy is explicitly established.
      classification: run.privacy ?? 'private',
      claims,
      artifactRefs,
      redactions: [],
    },
    evidenceRefs: [...new Set(evidenceRefs)].slice(0, 100),
    occurredAt: item.at,
    ...(typeof data.reviewConfidence === 'number' ? { reviewConfidence: data.reviewConfidence } : {}),
  });
}

export interface CollaborationTriggerPumpOptions {
  /** Maximum number of Run events evaluated during one pass. */
  maxEventsPerPass?: number;
  scanCursorStore?: RunScanCursorStore;
  scanCursorName?: string;
  scanPageSize?: number;
  onError?: (error: unknown, run: AgentRun, event: Event) => void;
}

export class CollaborationTriggerPump {
  private busy = false;
  private cursor = 0;
  private readonly maxEventsPerPass: number;
  private readonly onError: (error: unknown, run: AgentRun, event: Event) => void;
  private readonly scanner: RunEventScanner | undefined;
  private inFlight: Promise<{ evaluated: number; failed: number }> | undefined;

  constructor(
    private readonly repository: RunRepository,
    private readonly triggers: CollaborationTriggerService,
    options: CollaborationTriggerPumpOptions = {},
  ) {
    this.maxEventsPerPass = options.maxEventsPerPass ?? 500;
    if (!Number.isInteger(this.maxEventsPerPass) || this.maxEventsPerPass < 1 || this.maxEventsPerPass > 1000) throw new Error('maxEventsPerPass must be between 1 and 1000');
    this.onError = options.onError ?? (() => undefined);
    this.scanner = options.scanCursorStore && this.repository.scanPage
      ? new RunEventScanner(this.repository, options.scanCursorStore, options.scanCursorName ?? 'collaboration-trigger-pump', options.scanPageSize ?? 25, { useEventProjection: true })
      : undefined;
  }

  pump(): Promise<{ evaluated: number; failed: number }> {
    if (this.inFlight) return Promise.resolve({ evaluated: 0, failed: 0 });
    this.inFlight = this.runPass().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  async drain(): Promise<void> { await this.inFlight; }
  private async runPass(): Promise<{ evaluated: number; failed: number }> {
    if (this.busy) return { evaluated: 0, failed: 0 };
    this.busy = true;
    let evaluated = 0;
    let failed = 0;
    try {
      const pending: Array<{ run: AgentRun; item: Event; event: CollaborationTriggerEvent }> = [];
      const scanned = this.scanner ? await this.scanner.batch(this.maxEventsPerPass) : undefined;
      const entries = scanned?.entries ?? (await this.repository.list()).flatMap(run => run.events.map(item => ({ run, event: item })));
      for (const { run, event: item } of entries) {
        let event: CollaborationTriggerEvent | undefined;
        try {
          event = runEventToCollaborationTrigger(run, item);
        } catch (error) {
          failed += 1;
          this.onError(error, run, item);
          continue;
        }
        if (!event) continue;
        pending.push({ run, item, event });
      }
      if (pending.length === 0) { if (scanned) await scanned.commit(); return { evaluated, failed }; }
      const start = this.cursor % pending.length;
      const count = Math.min(this.maxEventsPerPass, pending.length);
      for (let offset = 0; offset < count; offset += 1) {
        const current = pending[(start + offset) % pending.length]!;
        try {
          await this.triggers.evaluate(current.event, { owner: current.run.owner, tenantId: current.run.tenantId ?? 'local' });
          evaluated += 1;
        } catch (error) {
          failed += 1;
          this.onError(error, current.run, current.item);
        }
      }
      if (scanned) await scanned.commit();
      this.cursor = (start + count) % pending.length;
    } finally {
      this.busy = false;
    }
    return { evaluated, failed };
  }
}
