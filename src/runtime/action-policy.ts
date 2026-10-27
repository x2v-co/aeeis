import { z } from 'zod';

/**
 * Action-level review on top of plan approval. The approved plan says which
 * steps run; this decides whether one external side effect inside a step may
 * happen now, must wait for the owner, or is refused.
 */

/** Exact references only: `toolId`, `toolId@version`, or `agent:<agentId>`. */
export const actionRefSchema = z.string().trim().regex(/^(?:agent:)?[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}(?:@[A-Za-z0-9._-]{1,50})?$/);
export const actionPolicySchema = z.object({
  allow: z.array(actionRefSchema).max(100).default([]),
  block: z.array(actionRefSchema).max(100).default([]),
}).strict();
export const actionOriginSchema = z.enum(['owner', 'routine', 'webhook', 'channel', 'agent']);
export const approveActionSchema = z.object({
  idempotencyKey: z.string().min(1).max(500),
  decision: z.enum(['once', 'always', 'deny', 'block']),
}).strict();

export type ActionPolicy = z.infer<typeof actionPolicySchema>;
export type ActionOrigin = z.infer<typeof actionOriginSchema>;
export type ActionDecision = z.infer<typeof approveActionSchema>['decision'];
export interface ActionCandidate { kind: 'tool' | 'agent'; id: string; version?: string | undefined; capabilities?: readonly string[] | undefined }
export interface ActionVerdict { decision: 'allow' | 'ask' | 'refuse'; rule: 'block' | 'external' | 'allow' | 'plan'; reason: string }

/** Frozen on the Run: deduplicated, ordered, and never widened by later edits. */
export function normalizeActionPolicy(policy: z.input<typeof actionPolicySchema> | undefined): ActionPolicy | undefined {
  if (!policy) return undefined;
  const parsed = actionPolicySchema.parse(policy);
  const allow = [...new Set(parsed.allow)].sort();
  const block = [...new Set(parsed.block)].sort();
  return allow.length || block.length ? { allow, block } : undefined;
}

export function actionRef(candidate: ActionCandidate): string {
  if (candidate.kind === 'agent') return `agent:${candidate.id}`;
  return candidate.version ? `${candidate.id}@${candidate.version}` : candidate.id;
}

/** A tool reference matches with or without its version; an agent only by its exact id. */
function matches(list: readonly string[], candidate: ActionCandidate): boolean {
  if (candidate.kind === 'agent') return list.includes(`agent:${candidate.id}`);
  return list.includes(candidate.id) || (candidate.version !== undefined && list.includes(`${candidate.id}@${candidate.version}`));
}

/** Only a tool that declares read and nothing else is read-only. Delegation hands context to another party. */
export function isReadOnlyAction(candidate: ActionCandidate): boolean {
  if (candidate.kind === 'agent') return false;
  const capabilities = candidate.capabilities ?? [];
  return capabilities.length > 0 && capabilities.every(capability => capability === 'read');
}

/**
 * 1. Blocked refs are refused in every mode, without a card.
 * 2. A Run started from outside the owner (routine, webhook, channel, another agent) cannot take a
 *    non-read-only action by itself: required and auto ask, yolo refuses because it cannot wait.
 * 3. Allowed refs proceed.
 * 4. Anything else proceeds under the approved plan, as before.
 */
export function decideAction(policy: ActionPolicy | undefined, origin: ActionOrigin | undefined, mode: 'required' | 'auto' | 'yolo' | undefined, candidate: ActionCandidate): ActionVerdict {
  const ref = actionRef(candidate);
  if (policy && matches(policy.block, candidate)) return { decision: 'refuse', rule: 'block', reason: `${ref} is on the owner's block list` };
  if ((origin ?? 'owner') !== 'owner' && !isReadOnlyAction(candidate)) {
    return (mode ?? 'required') === 'yolo'
      ? { decision: 'refuse', rule: 'external', reason: `${ref} is not read-only, this run was started by a ${origin}, and yolo cannot wait for the owner` }
      : { decision: 'ask', rule: 'external', reason: `${ref} is not read-only, and this run was started by a ${origin}` };
  }
  if (policy && matches(policy.allow, candidate)) return { decision: 'allow', rule: 'allow', reason: `${ref} is on the owner's allow list` };
  return { decision: 'allow', rule: 'plan', reason: 'Covered by the approved plan' };
}

/** "Always" and "block" decisions widen only this Run's frozen policy. */
export function withActionDecision(policy: ActionPolicy | undefined, ref: string, decision: ActionDecision): ActionPolicy | undefined {
  if (decision !== 'always' && decision !== 'block') return policy;
  const current = policy ?? { allow: [], block: [] };
  const allow = decision === 'always' ? [...new Set([...current.allow, ref])].sort() : current.allow.filter(item => item !== ref);
  const block = decision === 'block' ? [...new Set([...current.block, ref])].sort() : current.block;
  return { allow, block };
}
