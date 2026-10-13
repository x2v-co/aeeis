import { z } from 'zod';
import type { AgentRun, Step } from './contracts.js';

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
  const reads = steps.flatMap(step => step.observations.filter(observation => observation.tool === 'sources.read'));
  return { pages: reads.length, chars: reads.reduce((sum, read) => sum + JSON.stringify(read.result).length, 0) };
}
export function runSourceReadUsage(run: AgentRun): { pages: number; chars: number } {
  return run.sourceReadUsage ?? sourceReadUsage(run.steps);
}
export function executionLimitReason(run: AgentRun, step: Step, limits: ExecutionLimits): string | undefined {
  if (step.limitReason) return step.limitReason;
  const calls = run.calls.filter(call => call.phase === 'executor' && call.taskId === step.taskId && call.id !== run.resumeModelCallId);
  if (calls.length >= limits.maxNodeIterations - 1) return 'Node model iteration limit reached';
  const node = sourceReadUsage([step]), total = runSourceReadUsage(run);
  if (node.pages >= limits.maxNodeSourcePages) return 'Node source page limit reached';
  if (total.pages >= limits.maxRunSourcePages) return 'Run source page limit reached';
  if (node.chars >= limits.maxNodeSourceChars) return 'Node source character limit reached';
  if (total.chars >= limits.maxRunSourceChars) return 'Run source character limit reached';
  return undefined;
}
