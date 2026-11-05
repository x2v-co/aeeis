import { z } from 'zod';

/**
 * Where an automatically derived object sits in its derivation chain.
 *
 * `rootId` names the object a person (or an outside event) started; `depth`
 * counts the automatic hops since then. Only the creator computes it, from the
 * parent it derives from (`depth = parent.depth + 1`). Request bodies and model
 * output never carry it, so nothing outside the runtime can reset a chain.
 * A record without lineage is its own root at depth 0.
 */
export const lineageSchema = z.object({
  rootId: z.string().min(1).max(300),
  depth: z.number().int().min(0).max(10_000),
}).strict();
export type Lineage = z.infer<typeof lineageSchema>;

export const DEFAULT_MAX_DERIVATION_DEPTH = 8;

/** The lineage of a record, treating a record without one as a depth-0 root. */
export function lineageOf(record: { id: string; lineage?: Lineage | undefined }): Lineage {
  return record.lineage ?? { rootId: record.id, depth: 0 };
}

/** The lineage of an object derived from `parent`. */
export function childLineage(parent: Lineage): Lineage {
  return { rootId: parent.rootId, depth: parent.depth + 1 };
}

/** Deployment limit: how many automatic hops a chain may take. Events and
 * request bodies cannot raise it. */
export function maxDerivationDepthFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AEEIS_MAX_DERIVATION_DEPTH;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_DERIVATION_DEPTH;
  return validMaxDerivationDepth(Number(raw), 'AEEIS_MAX_DERIVATION_DEPTH');
}

export function validMaxDerivationDepth(value: number, name = 'maxDerivationDepth'): number {
  if (!Number.isInteger(value) || value < 1 || value > 1000) throw new RangeError(`${name} must be an integer between 1 and 1000`);
  return value;
}

/** A derivation the runtime refused because the chain reached its depth limit.
 * Stored on the source Run so the inbox can ask a person to look at it. */
export const derivationBlockSchema = z.object({
  kind: z.enum(['collaboration_trigger', 'project_pulse']),
  /** Lineage the refused object would have had. */
  lineage: lineageSchema,
  limit: z.number().int().min(1),
  reason: z.string().min(1).max(4000),
  decisionId: z.string().min(1).max(200).optional(),
  policyId: z.string().min(1).max(200).optional(),
  at: z.string().datetime({ offset: true }),
  acknowledgedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type DerivationBlock = z.infer<typeof derivationBlockSchema>;
