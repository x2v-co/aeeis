import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTemporalSetupTimeoutMs, resolveTemporalTestServerExecutable } from './support/temporal-timeouts.js';

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

describe('Temporal test server executable', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aeeis-temporal-server-'));
    path = join(directory, 'temporal-test-server');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('uses the SDK default when neither variable is set', () => {
    expect(resolveTemporalTestServerExecutable({})).toBeUndefined();
  });

  it.each([undefined, '', '   '])('ignores an empty server path %j', value => {
    expect(resolveTemporalTestServerExecutable({ AEEIS_TEST_TEMPORAL_SERVER_PATH: value })).toBeUndefined();
    expect(resolveTemporalTestServerExecutable({
      AEEIS_TEST_TEMPORAL_SERVER_PATH: value,
      AEEIS_TEST_TEMPORAL_DOWNLOAD_DIR: directory,
    })).toEqual({ type: 'cached-download', downloadDir: directory });
  });

  it('gives the trimmed server path precedence over the download directory', () => {
    writeFileSync(path, '', { mode: 0o755 });
    expect(resolveTemporalTestServerExecutable({
      AEEIS_TEST_TEMPORAL_SERVER_PATH: ` ${path} `,
      AEEIS_TEST_TEMPORAL_DOWNLOAD_DIR: directory,
    })).toEqual({ type: 'existing-path', path });
  });

  it('rejects a missing server path without falling back to the download directory', () => {
    expect(() => resolveTemporalTestServerExecutable({
      AEEIS_TEST_TEMPORAL_SERVER_PATH: path,
      AEEIS_TEST_TEMPORAL_DOWNLOAD_DIR: directory,
    })).toThrow(`AEEIS_TEST_TEMPORAL_SERVER_PATH=${path} does not exist`);
  });

  it('rejects a directory as the server path', () => {
    expect(() => resolveTemporalTestServerExecutable({
      AEEIS_TEST_TEMPORAL_SERVER_PATH: directory,
    })).toThrow(`AEEIS_TEST_TEMPORAL_SERVER_PATH=${directory} is not a regular file`);
  });

  it('rejects a non-executable file with a chmod hint', () => {
    writeFileSync(path, '');
    chmodSync(path, 0o644);
    expect(() => resolveTemporalTestServerExecutable({
      AEEIS_TEST_TEMPORAL_SERVER_PATH: path,
    })).toThrow(`AEEIS_TEST_TEMPORAL_SERVER_PATH=${path} is not executable; run chmod 755 ${path}`);
  });

  it('uses an executable file as an existing path', () => {
    writeFileSync(path, '');
    chmodSync(path, 0o755);
    expect(resolveTemporalTestServerExecutable({
      AEEIS_TEST_TEMPORAL_SERVER_PATH: path,
    })).toEqual({ type: 'existing-path', path });
  });
});
