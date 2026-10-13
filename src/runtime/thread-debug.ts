import type { AgentRun } from './contracts.js';
import type { RunRepository } from './repository.js';
import type { Thread } from './threads.js';
import { redactRunData, debugRunView } from './run-debug.js';
import { sharedThreadView } from './thread-shares.js';

export const MAX_THREAD_BUNDLE_BYTES = 32 * 1024 * 1024;
export class ThreadBundleTooLarge extends Error {
  readonly statusCode = 413;
  constructor() { super('Thread debug bundle exceeds size limit'); }
}

/** Freeze membership at the cutoff and bound storage reads and retained data. */
export async function readThreadBundleRuns(repository: RunRepository, thread: Thread, throughSequence: number): Promise<AgentRun[]> {
  const runs: AgentRun[] = [];
  let afterSequence = 0, bytes = 0;
  while (afterSequence < throughSequence) {
    const page = await repository.listRunsByThread(thread.id, thread, 100, afterSequence);
    if (!page.length) break;
    for (const run of page) {
      if (run.threadSequence! > throughSequence) break;
      bytes += Buffer.byteLength(JSON.stringify(run));
      if (bytes > MAX_THREAD_BUNDLE_BYTES) throw new ThreadBundleTooLarge();
      runs.push(run);
    }
    afterSequence = page.at(-1)!.threadSequence!;
  }
  return runs;
}

export function threadDebugBundle(thread: Thread, throughSequence: number, runs: AgentRun[], access: 'owner' | 'share') {
  const view = access === 'share' ? sharedThreadView(thread, throughSequence, runs) : (() => {
    // Object keys preserve the complete sequence beyond the redactor's array cap.
    const redacted = redactRunData({ kind: 'thread' as const, thread, throughSequence,
      runs: Object.fromEntries(runs.map(run => [run.id, debugRunView(run)])),
    }, { credentialSource: Object.fromEntries(runs.map(run => [run.id, run])) });
    return { ...redacted, runs: Object.values(redacted.runs) };
  })();
  const expected = access === 'owner' ? runs : runs.filter(run => ['public', 'internal'].includes(run.privacy ?? 'internal'));
  if (view.runs.length !== expected.length || view.runs.some((run, index) => run?.id !== expected[index]?.id)) throw new ThreadBundleTooLarge();
  const bundle = { schemaVersion: 'aeeis-thread-debug-bundle/1' as const, ...view, access, exportedAt: new Date().toISOString() };
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_THREAD_BUNDLE_BYTES) throw new ThreadBundleTooLarge();
  return bundle;
}
