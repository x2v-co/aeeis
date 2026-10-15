import type { AgentRun } from './contracts.js';

/** Surface partial input failures even when no artifact could be produced. */
export function populateRunLimitations(run: AgentRun): void {
  const reasons = run.events.filter(event => event.type === 'input.unavailable_partial').map(event => event.data.reason).filter((reason): reason is string => typeof reason === 'string' && Boolean(reason.trim()));
  const limitations = [...new Set([...(run.limitations ?? []), ...reasons, ...run.artifacts.flatMap(artifact => artifact.limitations ?? [])])];
  if (limitations.length) run.limitations = limitations;
}
