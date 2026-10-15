import { describe, expect, it } from 'vitest';
import { receiptSchema, toolkitCredits } from '../src/integrations.js';

describe('toolkit credits', () => {
  it('prefers receipt.credits, falls back to cost.amount, rounds to integer', () => {
    expect(toolkitCredits({ receipt: { id: 'x', credits: 3 }, cost: { amount: 9 } })).toBe(3);
    expect(toolkitCredits({ cost: { amount: 2.4 } })).toBe(2);
    expect(toolkitCredits({ receipt: { id: 'x' } })).toBeUndefined();
    expect(toolkitCredits(undefined)).toBeUndefined();
    expect(toolkitCredits({ cost: { amount: -1 } })).toBeUndefined();
  });
  it('receipt schema accepts integer credits and costStatus', () => {
    const base = { schemaVersion: 'receipt/1', receiptId: 'receipt_00000000-0000-0000-0000-000000000000', provider: 'toolkit_new', operation: 't', requestHash: 'a'.repeat(64), inputRefs: [], outputRefs: [], capabilitiesUsed: [], startedAt: new Date().toISOString(), status: 'completed' };
    expect(receiptSchema.parse({ ...base, cost: { credits: 2 }, costStatus: 'reported' }).cost?.credits).toBe(2);
    expect(() => receiptSchema.parse({ ...base, cost: { credits: 1.5 } })).toThrow();
    expect(receiptSchema.parse({ ...base, status: 'unknown', costStatus: 'interrupted' }).costStatus).toBe('interrupted');
  });
});
