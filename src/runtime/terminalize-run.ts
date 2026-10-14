import type { AgentRun } from './contracts.js';
import { event } from './engine.js';
import type { RunRepository } from './repository.js';

/** Close execution while preserving unknown provider receipts for later billing reconciliation.
 * Only model-produced artifacts count. Source dumps are not salvage: a run with zero produced
 * output must end failed (or another clear error status), never succeeded/partial. */
export async function terminalizeRun(repository: RunRepository, runId: string, reason: string): Promise<AgentRun> {
  return repository.mutate(runId, run => {
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return;
    // A late timeout must not close a business wait that won the race.
    if (!['queued', 'planning', 'running', 'reviewing', 'unknown'].includes(run.status)) return;
    const limitation = `Execution stopped: ${reason}. Independent review was not completed.`;
    for (const call of run.calls) if (call.state === 'started') { call.state = 'unknown'; call.endedAt = new Date().toISOString(); }
    // Retain real executor finish artifacts only. Do not synthesize evidence from sources.
    const produced = run.artifacts.filter(artifact => artifact.evidenceRefs.length);
    if (produced.length) {
      run.status = 'succeeded';
      run.partial = true;
      for (const artifact of run.artifacts) {
        artifact.partial = true;
        artifact.limitations = [...new Set([...(artifact.limitations ?? []), limitation])];
      }
      delete run.error;
      event(run, 'run.partial', { reason, terminalized: true, producedArtifacts: produced.length });
    } else {
      run.status = 'failed';
      run.error = limitation;
      // Drop empty placeholder artifacts so operators never see a green partial with no output.
      run.artifacts = run.artifacts.filter(artifact => artifact.content.trim() || artifact.evidenceRefs.length);
      event(run, 'run.failed', { reason, terminalized: true, producedArtifacts: 0 });
    }
    delete run.resumeStatus;
  });
}
