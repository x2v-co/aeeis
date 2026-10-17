import { digest } from './digest.js';
import type { AgentRun } from './contracts.js';

/** Surface partial input failures even when no artifact could be produced. */
export function populateRunLimitations(run: AgentRun): void {
  const reasons = run.events.filter(event => event.type === 'input.unavailable_partial').map(event => event.data.reason).filter((reason): reason is string => typeof reason === 'string' && Boolean(reason.trim()));
  const limitations = [...new Set([...(run.limitations ?? []), ...reasons, ...run.artifacts.flatMap(artifact => artifact.limitations ?? [])])];
  if (limitations.length) run.limitations = limitations;
  if (run.partial) {
    const unknown = partialUnknownSection(run);
    for (const artifact of run.artifacts) {
      // Replace only the runtime-generated suffix as tasks and review finish.
      const content = artifact.content.replace(/\n\nUnknown:\n- Remaining work:[\s\S]*$/, '') + `\n\n${unknown}`;
      if (artifact.content === content) continue;
      artifact.content = content;
      artifact.hash = digest({ type: 'finish', title: artifact.title, content, evidenceRefs: artifact.evidenceRefs,
        ...(artifact.artifactType ? { artifactType: artifact.artifactType } : {}), ...(artifact.structured ? { structured: artifact.structured } : {}),
        ...(artifact.limitations ? { limitations: artifact.limitations } : {}) });
    }
  }
}

/** Explicit gaps shared by the retained output and the run.partial diagnostic. */
export function partialUnknownSection(run: AgentRun): string {
  const missing = (run.plans.at(-1)?.nodes ?? []).filter(node => {
    const step = run.steps.find(step => step.taskId === node.id);
    return step?.status !== 'succeeded';
  }).map(node => node.title);
  const problems = run.steps.filter(step => step.status !== 'succeeded').flatMap(step => [...(step.finishRepair?.problems ?? []), ...(step.outputRecovery?.problems ?? [])]
    .map(problem => `${step.taskId}: ${problem.message}`));
  const sourceUnknowns = run.artifacts.flatMap(artifact => artifact.structured?.unknowns.map(item => item.text) ?? []);
  const gaps = [...new Set([...(run.limitations ?? []), ...run.artifacts.flatMap(artifact => artifact.limitations ?? []), ...sourceUnknowns, ...problems])];
  const review = run.review?.verdict === 'accepted' || !['succeeded', 'unknown'].includes(run.status) ? [] : [run.review
    ? `Independent review remains unresolved: ${run.review.summary}; ${run.review.issues.join('; ')}`
    : 'Independent review was not completed.'];
  return ['Unknown:', `- Remaining work: ${missing.length ? missing.join('; ') : 'unverified or omitted items listed below.'}`,
    ...[...new Set([...gaps, ...review])].map(gap => `- ${gap.replace(/\s+/g, ' ').trim()}`)].join('\n');
}
