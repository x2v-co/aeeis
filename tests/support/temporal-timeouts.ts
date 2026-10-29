import { accessSync, constants, existsSync, statSync } from 'node:fs';
import type { EphemeralServerExecutable } from '@temporalio/testing';

export function resolveTemporalTestServerExecutable(env: Readonly<Record<string, string | undefined>>): EphemeralServerExecutable | undefined {
  const path = env.AEEIS_TEST_TEMPORAL_SERVER_PATH?.trim();
  if (path) {
    const setting = `AEEIS_TEST_TEMPORAL_SERVER_PATH=${path}`;
    if (!existsSync(path)) throw new Error(`${setting} does not exist`);
    if (!statSync(path).isFile()) throw new Error(`${setting} is not a regular file`);
    try {
      accessSync(path, constants.X_OK);
    } catch {
      throw new Error(`${setting} is not executable; run chmod 755 ${path}`);
    }
    return { type: 'existing-path', path };
  }

  const downloadDir = env.AEEIS_TEST_TEMPORAL_DOWNLOAD_DIR;
  return downloadDir ? { type: 'cached-download', downloadDir } : undefined;
}

export function parseTemporalSetupTimeoutMs(value: string | undefined): number {
  const normalized = value?.trim();
  if (!normalized) return 300_000;

  const timeout = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error('AEEIS_TEST_TEMPORAL_SETUP_TIMEOUT_MS must be a positive integer in milliseconds.');
  }
  return timeout;
}
