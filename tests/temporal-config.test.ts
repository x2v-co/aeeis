import { describe, expect, it } from 'vitest';
import { parseTemporalWorkerConfig } from '../src/temporal/config.js';

const base = {
  AEEIS_ENV: 'development',
  AEEIS_WORKER_TOKEN: 'worker-token-123456',
  AEEIS_INTERNAL_URL: 'http://aeeis:4323',
  AEEIS_WORKER_ALLOW_INSECURE_HTTP: '1',
  TEMPORAL_ADDRESS: 'temporal:7233',
  AEEIS_TASK_QUEUE: 'aeeis-agent',
  TEMPORAL_NAMESPACE: 'default',
  AEEIS_BUILD_ID: 'worker-v1',
};

describe('Temporal Worker startup configuration', () => {
  it('parses an explicit development HTTP configuration', () => {
    expect(parseTemporalWorkerConfig(base)).toMatchObject({ api: 'http://aeeis:4323', taskQueue: 'aeeis-agent', address: 'temporal:7233' });
  });

  it.each([
    ['missing token', { ...base, AEEIS_WORKER_TOKEN: undefined }],
    ['short token', { ...base, AEEIS_WORKER_TOKEN: 'short' }],
    ['query in API URL', { ...base, AEEIS_INTERNAL_URL: 'https://aeeis:4323?token=secret', AEEIS_WORKER_ALLOW_INSECURE_HTTP: '0' }],
    ['invalid protocol', { ...base, AEEIS_INTERNAL_URL: 'ftp://aeeis:4323', AEEIS_WORKER_ALLOW_INSECURE_HTTP: '1' }],
    ['force timeout before grace', { ...base, AEEIS_WORKER_SHUTDOWN_GRACE_MS: '5000', AEEIS_WORKER_SHUTDOWN_FORCE_MS: '1000' }],
    ['whitespace in Temporal address', { ...base, TEMPORAL_ADDRESS: 'temporal:7233 ' }],
  ])('rejects %s before connecting', (_name, env) => {
    expect(() => parseTemporalWorkerConfig(env)).toThrow();
  });

  it('requires secure explicit settings in production', () => {
    expect(() => parseTemporalWorkerConfig({ ...base, AEEIS_ENV: 'production', AEEIS_INTERNAL_URL: undefined })).toThrow('AEEIS_INTERNAL_URL');
    expect(() => parseTemporalWorkerConfig({ ...base, AEEIS_ENV: 'production', AEEIS_WORKER_ALLOW_INSECURE_HTTP: '0', AEEIS_INTERNAL_URL: 'https://aeeis.internal', AEEIS_TEMPORAL_USE_VERSIONING: undefined })).toThrow('AEEIS_TEMPORAL_USE_VERSIONING');
    expect(parseTemporalWorkerConfig({ ...base, AEEIS_ENV: 'production', AEEIS_WORKER_ALLOW_INSECURE_HTTP: '0', AEEIS_INTERNAL_URL: 'https://aeeis.internal', AEEIS_TEMPORAL_USE_VERSIONING: '1' })).toMatchObject({ api: 'https://aeeis.internal' });
  });
});
