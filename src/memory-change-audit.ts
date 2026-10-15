import type { MemoryEntry } from './contracts.js';
import type { ChangeAuditEntry, ChangeAuditInput, ChangeContext } from './change-audit.js';

export type MemoryChanges = Record<string, MemoryEntry | null>;
export function memoryAuditInput(memory: MemoryEntry, before: MemoryChanges | null, after: MemoryChanges, trigger: string, context?: ChangeContext): ChangeAuditInput {
  return {
    subjectKind: 'memory', subjectId: memory.id, op: before === null ? 'create' : 'update',
    actor: context?.actor ?? { kind: 'user', id: memory.owner ?? 'owner' },
    reason: context?.reason ?? { ...(memory.evidenceRunId ? { runId: memory.evidenceRunId } : { taskId: memory.goalId ?? memory.id }), trigger },
    before: before === null ? null : { records: before }, after: { records: after },
  };
}
/** A correction changes two records atomically, so its snapshot includes both ids. */
export function memorySnapshot(entry: ChangeAuditEntry, snapshot: unknown): MemoryChanges {
  if (snapshot === null) return { [entry.subjectId]: null };
  return (snapshot as { records: MemoryChanges }).records;
}
export function memorySnapshotIds(entry: ChangeAuditEntry): string[] {
  return [...new Set([...Object.keys(memorySnapshot(entry, entry.before)), ...Object.keys(memorySnapshot(entry, entry.after))])];
}
