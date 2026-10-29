import { describe, expect, it } from 'vitest';
import { parseTemporalSetupTimeoutMs } from './support/temporal-timeouts.js';

describe('Temporal setup timeout', () => {
  it.each([undefined, '', '   '])('defaults to 300000ms for %j', value => {
    expect(parseTemporalSetupTimeoutMs(value)).toBe(300_000);
  });

  it.each(['1', '120000', ' 600000 '])('accepts a positive integer %j', value => {
    expect(parseTemporalSetupTimeoutMs(value)).toBe(Number(value));
  });

  it.each(['0', '-1', '1.5', '1.0', '1e3', '0x10', '120000ms', 'NaN', 'Infinity', '9007199254740992'])('rejects %j', value => {
    expect(() => parseTemporalSetupTimeoutMs(value)).toThrow('AEEIS_TEST_TEMPORAL_SETUP_TIMEOUT_MS must be a positive integer');
  });
});
