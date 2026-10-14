import { randomUUID } from 'node:crypto';
import type { AgentRun } from './contracts.js';
import { digest, event } from './engine.js';
import { threadHistorySources } from './thread-context.js';
import { isBinaryPdf } from './pdf-material.js';
import type { RunRepository } from './repository.js';

/** Close execution while preserving unknown provider receipts for later billing reconciliation. */
export async function terminalizeRun(repository: RunRepository, runId: string, reason: string): Promise<AgentRun> {
  return repository.mutate(runId, run => {
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return;
    // A late timeout must not close a business wait that won the race.
    if (!['queued', 'planning', 'running', 'reviewing', 'unknown'].includes(run.status)) return;
    const limitation = `Execution stopped: ${reason}. Independent review was not completed.`;
    for (const call of run.calls) if (call.state === 'started') { call.state = 'unknown'; call.endedAt = new Date().toISOString(); }
    if (!run.artifacts.length) {
      const sources = [...run.context.sources, ...threadHistorySources(run)].filter(source => source.content.trim() && !isBinaryPdf(source.content)).slice(0, 5);
      if (sources.length) {
        const content = sources.map(source => `[${source.id}] ${source.content.slice(0, 2000)}`).join('\n\n');
        const structured = run.builtinSkill === 'project-pulse/1' ? { schemaVersion: 'project-pulse/1' as const, progress: [], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] } : undefined;
        run.artifacts.push({ id: `artifact_${randomUUID()}`, taskId: run.steps.find(step => step.status !== 'succeeded')?.taskId ?? 'partial', title: 'Partial source evidence', content, evidenceRefs: sources.map(source => source.id), hash: digest(content), createdAt: new Date().toISOString(), ...(structured ? { artifactType: 'project-pulse/1', structured } : {}) });
      }
    }
    const evidence = run.artifacts.some(artifact => artifact.evidenceRefs.length);
    run.status = evidence ? 'succeeded' : 'failed';
    if (evidence) {
      run.partial = true;
      for (const artifact of run.artifacts) { artifact.partial = true; artifact.limitations = [...new Set([...(artifact.limitations ?? []), limitation])]; }
      delete run.error;
    } else run.error = limitation;
    delete run.resumeStatus;
    event(run, evidence ? 'run.partial' : 'run.failed', { reason, terminalized: true });
  });
}
