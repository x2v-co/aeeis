export function parseTemporalSetupTimeoutMs(value: string | undefined): number {
  const normalized = value?.trim();
  if (!normalized) return 300_000;

  const timeout = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error('AEEIS_TEST_TEMPORAL_SETUP_TIMEOUT_MS must be a positive integer in milliseconds.');
  }
  return timeout;
}
