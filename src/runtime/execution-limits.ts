import { z } from 'zod';
import type { AgentRun, ModelCall, Step } from './contracts.js';
import { isSourceReadTool } from './source-tools.js';

export const executionLimitsSchema = z.object({
  // Includes the reserved final finish call and any artifact repair calls.
  maxNodeIterations: z.number().int().min(2).max(100).default(8),
  maxNodeSourcePages: z.number().int().min(1).max(1000).default(4),
  maxRunSourcePages: z.number().int().min(1).max(10000).default(12),
  maxNodeSourceChars: z.number().int().min(1).max(1000000).default(24000),
  maxRunSourceChars: z.number().int().min(1).max(10000000).default(72000),
});
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;
export function executionLimitsConfig(env: NodeJS.ProcessEnv): ExecutionLimits {
  return executionLimitsSchema.parse(Object.fromEntries([
    ['maxNodeIterations', 'AEEIS_MAX_NODE_ITERATIONS'],
    ['maxNodeSourcePages', 'AEEIS_MAX_NODE_SOURCE_PAGES'],
    ['maxRunSourcePages', 'AEEIS_MAX_RUN_SOURCE_PAGES'],
    ['maxNodeSourceChars', 'AEEIS_MAX_NODE_SOURCE_CHARS'],
    ['maxRunSourceChars', 'AEEIS_MAX_RUN_SOURCE_CHARS'],
  ].flatMap(([key, name]) => env[name!] === undefined ? [] : [[key, Number(env[name!])]])));
}

// Count durable observations, including repeated/fragment reads. Serialization
// includes escaping and metadata so the allowance also bounds retained context.
export function sourceReadUsage(steps: Step[]): { pages: number; chars: number } {
  const reads = steps.flatMap(step => step.observations.filter(observation => isSourceReadTool(observation.tool)));
  return { pages: reads.length, chars: reads.reduce((sum, read) => sum + JSON.stringify(read.result).length, 0) };
}
export function runSourceReadUsage(run: AgentRun): { pages: number; chars: number } {
  return run.sourceReadUsage ?? sourceReadUsage(run.steps);
}
/** Node IDs may recur in later revisions, whose steps/iteration allowance start afresh. */
export function nodeModelCalls(run: AgentRun, taskId: string): ModelCall[] {
  const plan = run.plans.at(-1);
  let offset = plan?.modelCallOffset;
  if (offset === undefined && plan && plan.version > 1) {
    // Older Runs have no offset. Locate the planner receipt that emitted this
    // proposal using durable event order; timestamps can be equal or rewritten
    // during reconciliation, and a later failed replan is not a new revision.
    for (let i = run.events.length - 1; i >= 0; i--) {
      const proposal = run.events[i]!;
      if (proposal.type !== 'plan.proposed' || proposal.data.version !== plan.version) continue;
      for (let j = i - 1; j >= 0; j--) {
        const completed = run.events[j]!;
        if (completed.type !== 'model.completed') continue;
        const index = run.calls.findIndex(call => call.id === completed.data.callId && call.phase === 'planner');
        if (index >= 0) { offset = index + 1; break; }
      }
      break;
    }
  }
  return run.calls.slice(offset ?? 0).filter(call => call.phase === 'executor' && call.taskId === taskId && call.id !== run.resumeModelCallId);
}
export function executionLimitReason(run: AgentRun, step: Step, limits: ExecutionLimits, calls = nodeModelCalls(run, step.taskId)): string | undefined {
  if (step.limitReason) return step.limitReason;
  if (calls.length >= limits.maxNodeIterations - 1) return 'Node model iteration limit reached';
  const node = sourceReadUsage([step]), total = runSourceReadUsage(run);
  if (node.pages >= limits.maxNodeSourcePages) return 'Node source page limit reached';
  if (total.pages >= limits.maxRunSourcePages) return 'Run source page limit reached';
  if (node.chars >= limits.maxNodeSourceChars) return 'Node source character limit reached';
  if (total.chars >= limits.maxRunSourceChars) return 'Run source character limit reached';
  return undefined;
}
