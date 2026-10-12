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
    expect(parseTemporalWorkerConfig(base)).toMatchObject({ api: 'http://aeeis:4323', taskQueue: 'aeeis-agent', address: 'temporal:7233', versioning: { defaultVersioningBehavior: 'PINNED' } });
  });

  it('passes AUTO_UPGRADE through the worker startup configuration', () => {
    expect(parseTemporalWorkerConfig({
      ...base,
      AEEIS_TEMPORAL_USE_VERSIONING: '1',
      AEEIS_TEMPORAL_DEFAULT_VERSIONING_BEHAVIOR: 'AUTO_UPGRADE',
    }).versioning).toMatchObject({ useVersioning: true, defaultVersioningBehavior: 'AUTO_UPGRADE' });
  });

  it.each([
    ['missing token', { ...base, AEEIS_WORKER_TOKEN: undefined }],
    ['short token', { ...base, AEEIS_WORKER_TOKEN: 'short' }],
    ['query in API URL', { ...base, AEEIS_INTERNAL_URL: 'https://aeeis:4323?token=secret', AEEIS_WORKER_ALLOW_INSECURE_HTTP: '0' }],
    ['invalid protocol', { ...base, AEEIS_INTERNAL_URL: 'ftp://aeeis:4323', AEEIS_WORKER_ALLOW_INSECURE_HTTP: '1' }],
    ['force timeout before grace', { ...base, AEEIS_WORKER_SHUTDOWN_GRACE_MS: '5000', AEEIS_WORKER_SHUTDOWN_FORCE_MS: '1000' }],
    ['whitespace in Temporal address', { ...base, TEMPORAL_ADDRESS: 'temporal:7233 ' }],
    ['invalid versioning behavior', { ...base, AEEIS_TEMPORAL_DEFAULT_VERSIONING_BEHAVIOR: 'AUTO' }],
  ])('rejects %s before connecting', (_name, env) => {
    expect(() => parseTemporalWorkerConfig(env)).toThrow();
  });

  it('requires secure explicit settings in production', () => {
    expect(() => parseTemporalWorkerConfig({ ...base, AEEIS_ENV: 'production', AEEIS_INTERNAL_URL: undefined })).toThrow('AEEIS_INTERNAL_URL');
    expect(() => parseTemporalWorkerConfig({ ...base, AEEIS_ENV: 'production', AEEIS_WORKER_ALLOW_INSECURE_HTTP: '0', AEEIS_INTERNAL_URL: 'https://aeeis.internal', AEEIS_TEMPORAL_USE_VERSIONING: undefined })).toThrow('AEEIS_TEMPORAL_USE_VERSIONING');
    expect(parseTemporalWorkerConfig({ ...base, AEEIS_ENV: 'production', AEEIS_WORKER_ALLOW_INSECURE_HTTP: '0', AEEIS_INTERNAL_URL: 'https://aeeis.internal', AEEIS_TEMPORAL_USE_VERSIONING: '1' })).toMatchObject({ api: 'https://aeeis.internal' });
  });

  const production = { ...base, AEEIS_ENV: 'production', AEEIS_WORKER_ALLOW_INSECURE_HTTP: '0', AEEIS_TEMPORAL_USE_VERSIONING: '1', AEEIS_TRUSTED_INTERNAL_HOSTS: 'api,worker', AEEIS_INTERNAL_URL: 'http://api:4323' };

  it('allows a trusted internal API in production without an insecure override', () => {
    expect(parseTemporalWorkerConfig(production)).toMatchObject({ api: 'http://api:4323' });
    expect(() => parseTemporalWorkerConfig({ ...production, AEEIS_WORKER_ALLOW_INSECURE_HTTP: '1' })).toThrow('cannot enable insecure HTTP');
  });

  it.each(['http://unlisted:4323', 'http://api.example:4323', 'http://10.0.0.2:4323', 'ftp://api:4323', 'http://api:4323?token=secret', 'http://user:pass@api:4323', 'http://api:4323#fragment'])('rejects unsafe internal API %s', api => {
    expect(() => parseTemporalWorkerConfig({ ...production, AEEIS_INTERNAL_URL: api })).toThrow('AEEIS_INTERNAL_URL');
  });

  it('validates the trusted host list in the Worker as well as the API', () => {
    expect(() => parseTemporalWorkerConfig({ ...production, AEEIS_TRUSTED_INTERNAL_HOSTS: 'api.example' })).toThrow('AEEIS_TRUSTED_INTERNAL_HOSTS');
  });
});
