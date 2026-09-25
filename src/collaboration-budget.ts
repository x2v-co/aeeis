import { z } from 'zod';
import type { ModelAdapter, ModelRequest, ModelResponse } from './runtime/model.js';
import { ModelResponseRejected } from './runtime/model.js';
import type { ModelPin } from './runtime/contracts.js';

export const collaborationBudgetSchema = z.object({
  calls: z.number().int().positive().optional(), tokens: z.number().int().positive().optional(), moneyUsd: z.number().nonnegative().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Specify at least one budget limit');
export const collaborationPricesSchema = z.object({ inputPricePerMillion: z.number().nonnegative().max(1e12), outputPricePerMillion: z.number().nonnegative().max(1e12), currency: z.literal('USD') }).strict();
export const collaborationCallUsageSchema = z.object({
  tokens: z.number().int().nonnegative().optional(), moneyUsd: z.number().nonnegative().max(1e25).optional(),
  inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
  prices: collaborationPricesSchema.optional(),
}).strict();
export const collaborationModelPinSchema = z.object({
  model: z.string().min(1).max(300), endpoint: z.string().url().max(2000), promptVersion: z.string().min(1).max(300), provider: z.string().min(1).max(300).optional(),
  /** When Planprice selected the model, retain the normalized catalog identity
   * used for the decision so a long running collaboration can be audited. */
  catalogHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  catalogRetrievedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type CollaborationPrices = z.infer<typeof collaborationPricesSchema>;
export type CollaborationCallUsage = z.infer<typeof collaborationCallUsageSchema>;
export type CollaborationBudget = z.infer<typeof collaborationBudgetSchema>;
export type CollaborationModelPin = z.infer<typeof collaborationModelPinSchema>;
export interface CollaborationAccounting {
  idempotencyKey: string;
  recordUsage(usage: CollaborationCallUsage): Promise<void>;
  recordModel?(model: ModelPin): Promise<void>;
}
export const collaborationUsageSchema = z.object({
  calls: z.number().int().nonnegative(), tokens: z.number().nonnegative(), moneyUsd: z.number().nonnegative().optional(),
  unreportedTokenCalls: z.number().int().nonnegative(), unreportedMoneyCalls: z.number().int().nonnegative(),
}).strict();

export function collaborationUsage(attempts: ReadonlyArray<{ usage?: CollaborationCallUsage | undefined }>) {
  let tokens = 0, moneyUsd = 0, moneyReports = 0, unreportedTokenCalls = 0, unreportedMoneyCalls = 0;
  for (const attempt of attempts) {
    if (attempt.usage?.tokens === undefined) unreportedTokenCalls++;
    else tokens += attempt.usage.tokens;
    if (attempt.usage?.moneyUsd === undefined) unreportedMoneyCalls++;
    else { moneyUsd += attempt.usage.moneyUsd; moneyReports++; }
  }
  return { calls: attempts.length, tokens, ...(moneyReports ? { moneyUsd } : {}), unreportedTokenCalls, unreportedMoneyCalls };
}

/** Admission uses >=; result application uses > so exactly-budgeted outputs
 * remain usable. Unresolved attempts still occupy a durable call slot. */
export function assertCollaborationBudget(budget: CollaborationBudget | undefined, attempts: ReadonlyArray<{ usage?: CollaborationCallUsage | undefined }>, admitting = false): void {
  if (!budget) return;
  const usage = collaborationUsage(attempts);
  if (budget.tokens !== undefined && usage.unreportedTokenCalls) throw new Error('Collaboration token usage is missing; reconcile before continuing');
  if (budget.moneyUsd !== undefined && usage.unreportedMoneyCalls) throw new Error('Collaboration USD usage is missing; reconcile before continuing');
  const exceeded = (used: number, limit: number) => !Number.isFinite(used) || (admitting ? used >= limit : used > limit);
  if (budget.calls !== undefined && exceeded(usage.calls, budget.calls)) throw new Error('Collaboration call budget exhausted');
  if (budget.tokens !== undefined && (!Number.isSafeInteger(usage.tokens) || exceeded(usage.tokens, budget.tokens))) throw new Error('Collaboration token budget exhausted');
  if (budget.moneyUsd !== undefined && exceeded(usage.moneyUsd ?? 0, budget.moneyUsd)) throw new Error('Collaboration money budget exhausted');
}

export function measuredModelUsage(usage: ModelResponse['usage'], prices?: CollaborationPrices): CollaborationCallUsage {
  if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0 || !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)) return {};
  return { tokens: usage.inputTokens + usage.outputTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    ...(prices ? { prices, moneyUsd: (usage.inputTokens * prices.inputPricePerMillion + usage.outputTokens * prices.outputPricePerMillion) / 1_000_000 } : {}) };
}

/** Usage is persisted before validating generated content. Model-authored
 * cost fields never count as provider usage or trustworthy dollar amounts. */
export async function accountedComplete(adapter: ModelAdapter, request: ModelRequest, prices?: CollaborationPrices, accounting?: CollaborationAccounting): Promise<ModelResponse> {
  await accounting?.recordModel?.(adapter.pin);
  let response: ModelResponse;
  try { response = await adapter.complete({ ...request, ...(accounting ? { idempotencyKey: accounting.idempotencyKey } : {}) }); }
  catch (error) {
    if (error instanceof ModelResponseRejected) await accounting?.recordUsage(measuredModelUsage(error.usage, prices));
    throw error;
  }
  await accounting?.recordUsage(measuredModelUsage(response.usage, prices));
  return response;
}
