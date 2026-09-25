import { digest } from './runtime/engine.js';
import type { ProjectionTarget } from './application/aeeis-service.js';
import type { ProjectionEvent, ProjectionOutbox } from './collaboration-projection.js';

export interface ProjectionSnapshot {
  aggregateType: ProjectionEvent['aggregateType'];
  aggregateId: string;
  owner: string;
  tenantId: string;
  payload: unknown;
}

/**
 * Reconcile canonical aggregate snapshots into the transport outbox. The
 * snapshot digest is part of the idempotency key, so restarting the pump can
 * safely rediscover the current state without creating duplicate deliveries.
 * This is intentionally separate from the Goal/Plan/Task transactional
 * intents: RSI and collaboration repositories may be hosted independently,
 * therefore their projection is an explicit eventual-consistency boundary.
 */
export async function reconcileProjectionSnapshots(
  targets: readonly ProjectionTarget[],
  outbox: ProjectionOutbox,
  snapshots: readonly ProjectionSnapshot[],
): Promise<{ attempted: number; failed: number }> {
  let attempted = 0;
  let failed = 0;
  for (const snapshot of snapshots) {
    for (const target of targets) {
      if (target.aggregateTypes && !target.aggregateTypes.includes(snapshot.aggregateType)) continue;
      attempted += 1;
      try {
        const snapshotHash = digest(snapshot.payload);
        await outbox.enqueue({
          channel: target.channel,
          destination: target.destination,
          aggregateType: snapshot.aggregateType,
          aggregateId: snapshot.aggregateId,
          idempotencyKey: `${target.channel}:${target.destination}:${snapshot.aggregateType}:${snapshot.aggregateId}:${snapshotHash}`,
          payload: snapshot.payload,
          owner: snapshot.owner,
          tenantId: snapshot.tenantId,
        });
      } catch {
        failed += 1;
      }
    }
  }
  return { attempted, failed };
}

