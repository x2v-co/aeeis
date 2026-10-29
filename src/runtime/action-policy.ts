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
/** `judge` means the approval model decides; any error or doubt turns it into `ask`. */
export interface ActionVerdict { decision: 'allow' | 'ask' | 'refuse' | 'judge'; rule: 'block' | 'external' | 'untrusted' | 'allow' | 'read' | 'review' | 'auto' | 'yolo'; reason: string }
/** What the Run has already taken in. Text from an external tool or agent may
 * try to steer the next step, so after it arrives a write is treated like one
 * in a Run started from outside. */
export interface ActionContext { untrusted?: boolean }

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

/** A tool that declares read, optionally over the network, and nothing else is read-only: fetching a page
 * changes nothing. Its output still counts as external text for later writes. Delegation hands context to
 * another party and is never read-only. */
export function isReadOnlyAction(candidate: ActionCandidate): boolean {
  if (candidate.kind === 'agent') return false;
  const capabilities = candidate.capabilities ?? [];
  return capabilities.includes('read') && capabilities.every(capability => capability === 'read' || capability === 'network');
}

/**
 * 1. Blocked refs are refused in every mode, without a card.
 * 2. A non-read-only action in a Run started from outside the owner (routine, webhook, channel, another
 *    agent), or after text from an external tool or agent entered this Run: required and auto ask, yolo
 *    refuses because it cannot wait. The allow list does not lift this.
 * 3. Allowed refs proceed.
 * 4. Read-only actions proceed. Any other action: required asks, auto lets the approval model decide
 *    (asking on error or doubt), yolo proceeds.
 */
export function decideAction(policy: ActionPolicy | undefined, origin: ActionOrigin | undefined, mode: 'required' | 'auto' | 'yolo' | undefined, candidate: ActionCandidate, context: ActionContext = {}): ActionVerdict {
  const ref = actionRef(candidate);
  const review = mode ?? 'required';
  if (policy && matches(policy.block, candidate)) return { decision: 'refuse', rule: 'block', reason: `${ref} is on the owner's block list` };
  const readOnly = isReadOnlyAction(candidate);
  const outside = (origin ?? 'owner') !== 'owner';
  if (!readOnly && (outside || context.untrusted)) {
    const rule = outside ? 'external' as const : 'untrusted' as const;
    const why = outside ? `this run was started by a ${origin}` : 'text from an external tool or agent has entered this run';
    return review === 'yolo'
      ? { decision: 'refuse', rule, reason: `${ref} is not read-only, ${why}, and yolo cannot wait for the owner` }
      : { decision: 'ask', rule, reason: `${ref} is not read-only, and ${why}` };
  }
  if (policy && matches(policy.allow, candidate)) return { decision: 'allow', rule: 'allow', reason: `${ref} is on the owner's allow list` };
  if (readOnly) return { decision: 'allow', rule: 'read', reason: `${ref} only reads` };
  if (review === 'required') return { decision: 'ask', rule: 'review', reason: `${ref} is not read-only and is not on the owner's allow list` };
  if (review === 'auto') return { decision: 'judge', rule: 'auto', reason: `${ref} is not read-only; the approval model decides, and asks on doubt` };
  return { decision: 'allow', rule: 'yolo', reason: 'yolo runs the approved plan without stopping' };
}

/** "Always" and "block" change this Run's frozen policy; the engine also writes them to the owner's lists for later Runs. */
export function withActionDecision(policy: ActionPolicy | undefined, ref: string, decision: ActionDecision): ActionPolicy | undefined {
  if (decision !== 'always' && decision !== 'block') return policy;
  const current = policy ?? { allow: [], block: [] };
  const allow = decision === 'always' ? [...new Set([...current.allow, ref])].sort() : current.allow.filter(item => item !== ref);
  const block = decision === 'block' ? [...new Set([...current.block, ref])].sort() : current.block;
  return { allow, block };
}
