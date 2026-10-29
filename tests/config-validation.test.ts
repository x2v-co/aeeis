import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { validateRuntimeConfig } from '../src/config-validation.js';

const development = { AEEIS_ACCESS_TOKEN: 'development-token' };

const production = {
  AEEIS_ENV: 'production',
  DATABASE_URL: 'postgresql://aeeis@db/aeeis',
  AEEIS_ACCESS_TOKEN: 'operator-token',
  AEEIS_RUNNER: 'local',
  AEEIS_HOST: '127.0.0.1',
  AEEIS_CONTENT_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  AEEIS_DATABASE_MIGRATION_URL: 'postgresql://aeeis_owner@db/aeeis',
};

describe('runtime configuration validation', () => {
  it('requires content encryption and a separate migration role in production unless one owner opts out', () => {
    const { AEEIS_CONTENT_ENCRYPTION_KEY: _key, AEEIS_DATABASE_MIGRATION_URL: _owner, ...bare } = production;
    expect(() => validateRuntimeConfig(production)).not.toThrow();
    expect(() => validateRuntimeConfig({ ...production, AEEIS_CONTENT_ENCRYPTION_KEY: undefined })).toThrow('AEEIS_CONTENT_ENCRYPTION_KEY_FILE');
    expect(() => validateRuntimeConfig({ ...production, AEEIS_DATABASE_MIGRATION_URL: undefined })).toThrow('AEEIS_DATABASE_MIGRATION_URL');
    expect(() => validateRuntimeConfig({ ...production, AEEIS_DATABASE_MIGRATION_URL: production.DATABASE_URL })).toThrow('different roles');
    expect(() => validateRuntimeConfig({ ...bare, AEEIS_ALLOW_UNENCRYPTED_SINGLE_NODE: '1' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...bare, AEEIS_ALLOW_UNENCRYPTED_SINGLE_NODE: '1', AEEIS_OIDC_ISSUER: 'https://issuer.example' })).toThrow();
    expect(() => validateRuntimeConfig({ ...development })).not.toThrow();
  });

  it('validates opt-in thinking/effort and the initial token ceiling', () => {
    for (const value of ['enabled', 'disabled', 'auto', 'provider-default']) expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_THINKING: value })).not.toThrow();
    for (const value of ['minimal', 'low', 'medium', 'high']) expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_REASONING_EFFORT: value })).not.toThrow();
    for (const name of ['AEEIS_MODEL_THINKING', 'AEEIS_MODEL_REASONING_EFFORT']) for (const value of ['', 'true', 'unknown']) expect(() => validateRuntimeConfig({ ...development, [name]: value })).toThrow(name);
    for (const value of ['1', '4096', '16384', '1000000']) expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_MAX_TOKENS: value })).not.toThrow();
    for (const value of ['', '0', '-1', '1.5', 'NaN', '1000001']) expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_MAX_TOKENS: value })).toThrow('AEEIS_MODEL_MAX_TOKENS');
    for (const value of ['12288', '32768', '65536']) expect(() => validateRuntimeConfig({ ...development, AEEIS_THREAD_CONTEXT_BUDGET_BYTES: value })).not.toThrow();
    for (const value of ['', '0', '-1', 'NaN', '65537']) expect(() => validateRuntimeConfig({ ...development, AEEIS_THREAD_CONTEXT_BUDGET_BYTES: value })).toThrow('AEEIS_THREAD_CONTEXT_BUDGET_BYTES');
  });
  it('validates durable execution allowances and explicit idle retry opt-in', () => {
    for (const value of ['0', '1', '2', '3']) expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_MIDSTREAM_RETRIES: value })).not.toThrow();
    for (const value of ['', '-1', '4', '1.5', 'NaN']) expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_MIDSTREAM_RETRIES: value })).toThrow('AEEIS_MODEL_MIDSTREAM_RETRIES');
    for (const value of ['0', '1']) expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_RETRY_EMPTY_IDLE: value })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_RETRY_EMPTY_IDLE: 'true' })).toThrow('AEEIS_MODEL_RETRY_EMPTY_IDLE');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MAX_NODE_ITERATIONS: '1' })).toThrow();
    for (const key of ['AEEIS_MAX_NODE_SOURCE_PAGES', 'AEEIS_MAX_RUN_SOURCE_PAGES', 'AEEIS_MAX_NODE_SOURCE_CHARS', 'AEEIS_MAX_RUN_SOURCE_CHARS']) {
      expect(() => validateRuntimeConfig({ ...development, [key]: '0' })).toThrow();
      expect(() => validateRuntimeConfig({ ...development, [key]: 'NaN' })).toThrow();
    }
  });
  it('validates streaming configuration and bounded idle/overall deadlines', () => {
    for (const value of ['0', '1']) expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_STREAM: value })).not.toThrow();
    for (const value of ['', 'true', '2']) expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_STREAM: value })).toThrow('AEEIS_MODEL_STREAM');
    for (const name of ['AEEIS_MODEL_IDLE_TIMEOUT_MS', 'AEEIS_MODEL_FIRST_BYTE_TIMEOUT_MS', 'AEEIS_MODEL_STREAM_OVERALL_TIMEOUT_MS', 'AEEIS_MODEL_CALL_BUDGET_MS']) {
      for (const value of ['1000', '180000', '600000']) expect(() => validateRuntimeConfig({ ...development, [name]: value })).not.toThrow();
      for (const value of ['0', '999', '-1', 'NaN', '1.5', name === 'AEEIS_MODEL_IDLE_TIMEOUT_MS' || name === 'AEEIS_MODEL_FIRST_BYTE_TIMEOUT_MS' ? '600001' : '1800001', '']) expect(() => validateRuntimeConfig({ ...development, [name]: value })).toThrow(name);
    }
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_STREAM_OVERALL_TIMEOUT_MS: '900000' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_STREAM_OVERALL_TIMEOUT_MS: '1800000' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_CALL_BUDGET_MS: '600000' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_CALL_BUDGET_MS: '1800000' })).not.toThrow();
  });
  it.each([
    {},
    { AEEIS_ENV: 'development' },
    { NODE_ENV: 'test' },
    { AEEIS_ENV: 'development', NODE_ENV: 'production' },
    { AEEIS_AUTH_DISABLED: '0' },
    { AEEIS_ACCESS_TOKEN: '' },
    { AEEIS_ACCESS_TOKEN: '   ' },
    { ...production, AEEIS_ACCESS_TOKEN: undefined },
    { ...production, AEEIS_ACCESS_TOKEN: '' },
    { ...production, AEEIS_ACCESS_TOKEN: '   ' },
  ])('requires API authentication without an explicit opt-out: %j', env => {
    expect(() => validateRuntimeConfig(env)).toThrow('API authentication requires');
  });

  it.each([undefined, '127.0.0.1', 'localhost', '::1'])('allows an explicit auth opt-out on loopback host %s', host => {
    expect(() => validateRuntimeConfig({ AEEIS_ENV: 'development', AEEIS_AUTH_DISABLED: '1', AEEIS_HOST: host })).not.toThrow();
  });

  it.each(['0.0.0.0', '::', '192.168.1.2', 'api.example', ''])('rejects disabling auth on non-loopback host %s', host => {
    expect(() => validateRuntimeConfig({ AEEIS_AUTH_DISABLED: '1', AEEIS_HOST: host })).toThrow('requires a loopback AEEIS_HOST');
  });

  it.each([
    { AEEIS_ACCESS_TOKEN: 'secret-token' },
    { AEEIS_PRINCIPAL_TOKENS: '{}' },
    { AEEIS_OIDC_ISSUER: 'https://issuer.example' },
    { AEEIS_OIDC_AUDIENCE: 'aeeis' },
    { AEEIS_OIDC_JWKS_URL: 'https://issuer.example/jwks' },
    { AEEIS_OIDC_ISSUER: 'https://issuer.example', AEEIS_OIDC_AUDIENCE: 'aeeis', AEEIS_OIDC_JWKS_URL: 'https://issuer.example/jwks' },
  ])('rejects combining disabled auth with credentials: %j', auth => {
    expect(() => validateRuntimeConfig({ AEEIS_AUTH_DISABLED: '1', ...auth })).toThrow('cannot be combined');
  });

  it('treats a blank access token as missing when auth is explicitly disabled', () => {
    expect(() => validateRuntimeConfig({ AEEIS_AUTH_DISABLED: '1', AEEIS_ACCESS_TOKEN: '   ' })).not.toThrow();
  });

  it.each(['true', 'yes', ''])('rejects invalid auth opt-out value %s', value => {
    expect(() => validateRuntimeConfig({ ...development, AEEIS_AUTH_DISABLED: value })).toThrow('AEEIS_AUTH_DISABLED must be 0 or 1');
  });

  it('accepts principal tokens and complete OIDC in development', () => {
    expect(() => validateRuntimeConfig({ AEEIS_PRINCIPAL_TOKENS: JSON.stringify({ token: { id: 'alice', tenantId: 'team', roles: ['owner'] } }) })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_ACCESS_TOKEN: '   ', AEEIS_OIDC_ISSUER: 'https://issuer.example', AEEIS_OIDC_AUDIENCE: 'aeeis', AEEIS_OIDC_JWKS_URL: 'https://issuer.example/jwks' })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_OIDC_ISSUER: 'https://issuer.example' })).toThrow('issuer, audience, and JWKS URL together');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PRINCIPAL_TOKENS: '{}' })).toThrow('cannot both be configured');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_OIDC_ISSUER: 'https://issuer.example', AEEIS_OIDC_AUDIENCE: 'aeeis', AEEIS_OIDC_JWKS_URL: 'https://issuer.example/jwks' })).toThrow('cannot be combined');
  });

  it('retains production database checks when auth is disabled on loopback', () => {
    expect(() => validateRuntimeConfig({ AEEIS_ENV: 'production', AEEIS_AUTH_DISABLED: '1' })).toThrow('requires DATABASE_URL');
  });

  it('limits local execution tools to a single-owner loopback development runtime', () => {
    const env = { ...development, AEEIS_LOCAL_TOOLS_CONFIG: 'tools.json' };
    expect(() => validateRuntimeConfig(env)).not.toThrow();
    for (const extra of [{ AEEIS_ENV: 'production' }, { NODE_ENV: 'production' }, { AEEIS_HOST: '0.0.0.0' }, { AEEIS_RUNNER: 'temporal' }, { AEEIS_PRINCIPAL_TOKENS: '{}' }, { AEEIS_OIDC_ISSUER: 'https://issuer.example' }]) {
      expect(() => validateRuntimeConfig({ ...env, ...extra })).toThrow('AEEIS_LOCAL_TOOLS_CONFIG');
    }
  });

  it('accepts a longer model timeout and rejects invalid or unbounded deadlines', () => {
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_TIMEOUT_MS: '180000' })).not.toThrow();
    for (const value of ['0', '-1', 'NaN', '1.5', '600001']) {
      expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_TIMEOUT_MS: value })).toThrow('AEEIS_MODEL_TIMEOUT_MS');
    }
  });
  it('accepts a production database and authenticated local deployment', () => {
    expect(() => validateRuntimeConfig(production)).not.toThrow();
  });

  const internal = {
    ...production,
    AEEIS_RUNNER: 'temporal', TEMPORAL_ADDRESS: 'temporal:7233',
    AEEIS_WORKER_TOKEN: 'worker-token-123456', AEEIS_BUILD_ID: 'worker-v1', AEEIS_TEMPORAL_USE_VERSIONING: '1',
    AEEIS_TRUSTED_INTERNAL_HOSTS: 'api, worker',
    AEEIS_INTERNAL_URL: 'http://api:4323', AEEIS_TEMPORAL_WORKER_HEALTH_URL: 'http://worker:4324/readyz',
  };

  it('allows exact trusted service hosts for internal production endpoints', () => {
    expect(() => validateRuntimeConfig(internal)).not.toThrow();
  });

  it.each(['api.example', '*.internal', '127.0.0.1', '10.0.0.2', '::1', '[::1]', '2130706433', '0x7f000001', 'API', 'api_worker', 'api,,worker', `a${'b'.repeat(63)}`])('rejects invalid trusted internal host list %s', hosts => {
    expect(() => validateRuntimeConfig({ ...internal, AEEIS_TRUSTED_INTERNAL_HOSTS: hosts })).toThrow('AEEIS_TRUSTED_INTERNAL_HOSTS');
  });

  it.each(['http://unlisted:4323', 'http://api.example:4323', 'http://api.:4323', 'http://10.0.0.2:4323', 'http://[fd00::2]:4323'])('rejects untrusted internal HTTP endpoint %s', endpoint => {
    expect(() => validateRuntimeConfig({ ...internal, AEEIS_INTERNAL_URL: endpoint })).toThrow('AEEIS_INTERNAL_URL');
    expect(() => validateRuntimeConfig({ ...internal, AEEIS_TEMPORAL_WORKER_HEALTH_URL: endpoint })).toThrow('AEEIS_TEMPORAL_WORKER_HEALTH_URL');
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('keeps loopback HTTP available without a trusted host list: %s', host => {
    expect(() => validateRuntimeConfig({ ...internal, AEEIS_TRUSTED_INTERNAL_HOSTS: undefined, AEEIS_INTERNAL_URL: `http://${host}:4323`, AEEIS_TEMPORAL_WORKER_HEALTH_URL: `http://${host}:4324/readyz` })).not.toThrow();
  });

  it.each([
    ['AEEIS_MODEL_BASE_URL', { AEEIS_MODEL_BASE_URL: 'http://api:4323/v1', AEEIS_MODEL: 'real-model' }],
    ['AEEIS_MODEL_HEALTH_URL', { AEEIS_MODEL_HEALTH_URL: 'http://worker:4324/health' }],
    ['AEEIS_COMPETITION_AGENT_MODELS', { AEEIS_COMPETITION_AGENT_MODELS: JSON.stringify({ agent: { baseUrl: 'http://api:4323/v1', model: 'real-model' } }) }],
    ['AEEIS_MODEL_PROVIDER_ENDPOINTS', { AEEIS_MODEL_PROVIDER_ENDPOINTS: JSON.stringify({ provider: 'http://api:4323/v1' }) }],
    ['AEEIS_MODEL_PROVIDER_HEALTH_URLS', { AEEIS_MODEL_PROVIDER_HEALTH_URLS: JSON.stringify({ provider: 'http://worker:4324/health' }) }],
    ['AEEIS_PLANPRICE_URL', { AEEIS_PLANPRICE_URL: 'http://api:4323' }],
    ['AEEIS_PROJECTION_SINK_URL', { AEEIS_PROJECTION_SINK_URL: 'http://api:4323/events' }],
  ])('does not extend internal HTTP trust to %s', (label, config) => {
    expect(() => validateRuntimeConfig({ ...internal, ...config })).toThrow(label);
  });

  it('retains the external model loopback exception in production', () => {
    expect(() => validateRuntimeConfig({ ...internal, AEEIS_MODEL_BASE_URL: 'http://127.0.0.1:4399/v1', AEEIS_MODEL: 'local-model' })).not.toThrow();
  });

  it.each([
    ['DATABASE_URL', { ...production, DATABASE_URL: undefined }],
    ['authentication', { ...production, AEEIS_ACCESS_TOKEN: undefined }],
    ['insecure model transport', { ...production, AEEIS_MODEL_ALLOW_INSECURE_HTTP: '1' }],
    ['partial OIDC', { ...production, AEEIS_ACCESS_TOKEN: undefined, AEEIS_OIDC_ISSUER: 'https://issuer.example' }],
    ['temporal worker token', { ...production, AEEIS_RUNNER: 'temporal', AEEIS_WORKER_TOKEN: undefined }],
    ['temporal versioning', { ...production, AEEIS_RUNNER: 'temporal', AEEIS_WORKER_TOKEN: 'worker', AEEIS_INTERNAL_URL: 'https://aeeis.internal', AEEIS_BUILD_ID: 'aeeis-worker-v1', AEEIS_TEMPORAL_USE_VERSIONING: undefined }],
    ['public host allowlist', { ...production, AEEIS_HOST: '0.0.0.0', AEEIS_PUBLIC_HOSTS: undefined }],
    ['partial Feishu app credentials', { ...production, AEEIS_FEISHU_APP_ID: 'app-only', AEEIS_FEISHU_APP_SECRET: undefined }],
    ['missing toolkit trust root', { ...production, AEEIS_TOOLKIT_REGISTRY_URL: 'https://toolkit.example/api/v1/registry' }],
    ['invalid toolkit trust root JSON', { ...production, AEEIS_TOOLKIT_REGISTRY_URL: 'https://toolkit.example/api/v1/registry', AEEIS_TOOLKIT_ROOT_PUBLIC_JWK: '{' }],
    ['private toolkit trust root', { ...production, AEEIS_TOOLKIT_REGISTRY_URL: 'https://toolkit.example/api/v1/registry', AEEIS_TOOLKIT_ROOT_PUBLIC_JWK: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'not-a-key', d: 'private' }) }],
    ['missing Planprice provider endpoints', { ...production, AEEIS_PLANPRICE_URL: 'https://planprice.example' }],
    ['principal directory credentials without endpoint', { ...production, AEEIS_PRINCIPAL_DIRECTORY_TOKEN: 'secret' }],
    ['principal directory URL and file', { ...production, AEEIS_PRINCIPAL_DIRECTORY_URL: 'https://directory.example/lookup', AEEIS_PRINCIPAL_DIRECTORY_PATH: '/tmp/principals.json' }],
    ['production principal directory file', { ...production, AEEIS_PRINCIPAL_DIRECTORY_PATH: '/etc/aeeis/principals.json' }],
    ['channel identity credentials without endpoint', { ...production, AEEIS_CHANNEL_IDENTITY_TOKEN: 'secret' }],
    ['channel identity URL and file', { ...production, AEEIS_CHANNEL_IDENTITY_URL: 'https://identity.example/lookup', AEEIS_CHANNEL_IDENTITY_PATH: '/tmp/channel-identities.json' }],
    ['production channel identity file', { ...production, AEEIS_CHANNEL_IDENTITY_PATH: '/etc/aeeis/channel-identities.json' }],
    ['missing Planprice provider keys', { ...production, AEEIS_PLANPRICE_URL: 'https://planprice.example', AEEIS_MODEL_PROVIDER_ENDPOINTS: JSON.stringify({ provider: 'https://provider.example/v1' }) }],
    ['insecure Planprice provider endpoint', { ...production, AEEIS_PLANPRICE_URL: 'https://planprice.example', AEEIS_MODEL_PROVIDER_ENDPOINTS: JSON.stringify({ provider: 'http://provider.example/v1' }), AEEIS_MODEL_PROVIDER_KEYS: JSON.stringify({ provider: 'secret' }) }],
  ])('rejects invalid production %s configuration', (_name, env) => {
    expect(() => validateRuntimeConfig(env)).toThrow();
  });

  it('accepts a valid public Ed25519 toolkit trust root', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const rootJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    expect(() => validateRuntimeConfig({
      ...production,
      AEEIS_TOOLKIT_REGISTRY_URL: 'https://toolkit.example/api/v1/registry',
      AEEIS_TOOLKIT_ROOT_PUBLIC_JWK: JSON.stringify(rootJwk),
    })).not.toThrow();
  });

  it('accepts a complete secure Planprice provider configuration', () => {
    expect(() => validateRuntimeConfig({
      ...production,
      AEEIS_PLANPRICE_URL: 'https://planprice.example',
      AEEIS_MODEL_PROVIDER_ENDPOINTS: JSON.stringify({ provider: 'https://provider.example/v1' }),
      AEEIS_MODEL_PROVIDER_KEYS: JSON.stringify({ provider: 'secret' }),
      AEEIS_MODEL_PROVIDER_HEALTH_URLS: JSON.stringify({ provider: 'https://provider.example/health' }),
    })).not.toThrow();
  });

  it('rejects an invalid Planprice catalog cache TTL', () => {
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PLANPRICE_CACHE_TTL_MS: '-1' })).toThrow('AEEIS_PLANPRICE_CACHE_TTL_MS');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PLANPRICE_CACHE_TTL_MS: 'not-a-number' })).toThrow('AEEIS_PLANPRICE_CACHE_TTL_MS');
  });

  it('validates the explicit private-data provider policy', () => {
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_PRIVATE_DATA_ALLOWED: JSON.stringify({ provider: true }) })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_PRIVATE_DATA_ALLOWED: JSON.stringify({ provider: 'yes' }) })).toThrow('AEEIS_MODEL_PRIVATE_DATA_ALLOWED');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_PRIVATE_DATA_ALLOWED: '[]' })).toThrow('AEEIS_MODEL_PRIVATE_DATA_ALLOWED');
  });

  it('allows the explicit development signature verification escape hatch', () => {
    expect(() => validateRuntimeConfig({
      ...production,
      AEEIS_TOOLKIT_REGISTRY_URL: 'https://toolkit.example/api/v1/registry',
      AEEIS_TOOLKIT_VERIFY_SIGNATURES: '0',
    })).not.toThrow();
  });

  it('validates a configured toolkit machine reconcile endpoint', () => {
    expect(() => validateRuntimeConfig({ ...production, AEEIS_TOOLKIT_RECONCILE_URL: 'http://127.0.0.1:4799/reconcile' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...production, AEEIS_TOOLKIT_RECONCILE_URL: 'http://toolkit.example/reconcile' })).toThrow('must use HTTPS');
    expect(() => validateRuntimeConfig({ ...production, AEEIS_TOOLKIT_RECONCILE_URL: 'https://toolkit.example/reconcile?token=secret' })).toThrow('credentials, query or fragment');
  });

  it('validates model, Planprice and evaluator endpoints before startup', () => {
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_BASE_URL: 'https://model.example/v1?token=secret', AEEIS_MODEL: 'model/1' })).toThrow('AEEIS_MODEL_BASE_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_HEALTH_URL: 'https://model.example/health#secret' })).toThrow('AEEIS_MODEL_HEALTH_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PLANPRICE_URL: 'http://planprice.example' })).toThrow('AEEIS_PLANPRICE_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PLANPRICE_HEALTH_URL: 'https://planprice.example/health' })).toThrow('requires AEEIS_PLANPRICE_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PLANPRICE_URL: 'https://planprice.example', AEEIS_PLANPRICE_HEALTH_URL: 'https://other.example/health' })).toThrow('AEEIS_PLANPRICE_HEALTH_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PLANPRICE_URL: 'https://planprice.example', AEEIS_PLANPRICE_HEALTH_URL: 'https://planprice.example/health' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_RSI_EVALUATOR_URL: 'https://evaluator.example/evaluate?token=secret' })).toThrow('AEEIS_RSI_EVALUATOR_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_RSI_EVALUATOR_HEALTH_URL: 'https://evaluator.example/health' })).toThrow('requires AEEIS_RSI_EVALUATOR_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_RSI_EVALUATOR_URL: 'https://evaluator.example/evaluate', AEEIS_RSI_EVALUATOR_HEALTH_URL: 'https://other.example/health' })).toThrow('AEEIS_RSI_EVALUATOR_HEALTH_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_RSI_EVALUATOR_URL: 'https://evaluator.example/evaluate', AEEIS_RSI_EVALUATOR_HEALTH_URL: 'https://evaluator.example/health' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_PROVIDER_ENDPOINTS: JSON.stringify({ provider: 'http://provider.example/v1' }) })).toThrow('AEEIS_MODEL_PROVIDER_ENDPOINTS');
    expect(() => validateRuntimeConfig({
      ...development,
      AEEIS_PLANPRICE_URL: 'http://planprice.example',
      AEEIS_PLANPRICE_ALLOW_INSECURE_HTTP: '1',
      AEEIS_MODEL_PROVIDER_ENDPOINTS: JSON.stringify({ provider: 'http://provider.example/v1' }),
      AEEIS_MODEL_PROVIDER_ALLOW_INSECURE_HTTP: '1',
      AEEIS_MODEL_PROVIDER_HEALTH_URLS: JSON.stringify({ provider: 'http://provider.example/health' }),
      AEEIS_RSI_EVALUATOR_URL: 'http://evaluator.example/evaluate',
      AEEIS_RSI_EVALUATOR_ALLOW_INSECURE_HTTP: '1',
    })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_MODEL_PROVIDER_ENDPOINTS: '{}' })).not.toThrow();
  });

  it('validates integration endpoints before opening stores', () => {
    expect(() => validateRuntimeConfig({ ...development, AEEIS_KNOWLEDGE_URL: 'http://knowledge.example/search' })).toThrow('AEEIS_KNOWLEDGE_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PROJECT_SOURCES_URL: 'https://sources.example/search?token=secret' })).toThrow('AEEIS_PROJECT_SOURCES_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PROJECTION_SINK_URL: 'https://sink.example/events#secret' })).toThrow('AEEIS_PROJECTION_SINK_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PROJECTION_SINK_HEALTH_URL: 'https://sink.example/health' })).toThrow('requires AEEIS_PROJECTION_SINK_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PROJECTION_SINK_URL: 'https://sink.example/events', AEEIS_PROJECTION_SINK_HEALTH_URL: 'https://other.example/health' })).toThrow('AEEIS_PROJECTION_SINK_HEALTH_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PROJECTION_SINK_URL: 'https://sink.example/events', AEEIS_PROJECTION_SINK_HEALTH_URL: 'https://sink.example/health' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_BRAIN_EMBEDDING_URL: 'http://127.0.0.1:8081/embeddings' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_BRAIN_EMBEDDING_HEALTH_URL: 'https://embed.example/health' })).toThrow('requires AEEIS_BRAIN_EMBEDDING_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_BRAIN_EMBEDDING_URL: 'https://embed.example/v1/embeddings', AEEIS_BRAIN_EMBEDDING_HEALTH_URL: 'https://other.example/health' })).toThrow('AEEIS_BRAIN_EMBEDDING_HEALTH_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_BRAIN_EMBEDDING_URL: 'https://embed.example/v1/embeddings', AEEIS_BRAIN_EMBEDDING_HEALTH_URL: 'https://embed.example/health' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_KNOWLEDGE_URL: 'ftp://localhost/knowledge' })).toThrow('must use HTTPS');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_FEISHU_API_BASE_URL: 'https://open.feishu.cn?token=secret' })).toThrow('AEEIS_FEISHU_API_BASE_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_TOOLKIT_MANIFEST_URL: 'https://toolkit.example/manifest' })).toThrow('configured together');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_HERMES_CLI_PATH: 'hermes', AEEIS_HERMES_CLI_TIMEOUT_MS: '499' })).toThrow('AEEIS_HERMES_CLI_TIMEOUT_MS');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_HERMES_CLI_PATH: 'hermes', AEEIS_HERMES_CLI_TIMEOUT_MS: '30000' })).not.toThrow();
  });

  it('validates the direct Hermes Debate bridge contract', () => {
    expect(() => validateRuntimeConfig({ ...development, AEEIS_HERMES_SIGNING_KEYS: '', AEEIS_HERMES_DEBATE_ROUTES: '', AEEIS_HERMES_SENDER_AGENTS: '' })).not.toThrow();
    const keys = JSON.stringify({ local: 'hermes-signing-key-123' });
    expect(() => validateRuntimeConfig({ ...development, AEEIS_HERMES_SIGNING_KEYS: keys })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_HERMES_DEBATE_ROUTES: '[]' })).toThrow('AEEIS_HERMES_SIGNING_KEYS');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_HERMES_SIGNING_KEYS: '{}' })).toThrow('AEEIS_HERMES_SIGNING_KEYS');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_HERMES_SIGNING_KEYS: JSON.stringify({ local: 'short' }) })).toThrow('AEEIS_HERMES_SIGNING_KEYS');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_HERMES_SIGNING_KEYS: keys, AEEIS_HERMES_DEBATE_ROUTES: '{' })).toThrow('AEEIS_HERMES_DEBATE_ROUTES');
  });

  it('validates external Agent and connector JSON endpoints', () => {
    const card = JSON.stringify([{ endpoint: 'https://agent.example/task' }]);
    expect(() => validateRuntimeConfig({ ...development, AEEIS_AGENT_CARDS: card })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_AGENT_CARDS: JSON.stringify([{ endpoint: 'http://agent.example/task' }]) })).toThrow('AEEIS_AGENT_CARDS');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_AGENT_CARDS: JSON.stringify([{ endpoint: 'http://127.0.0.1:4390/task' }]), AEEIS_AGENT_ALLOW_INSECURE_HTTP: '1' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_AGENT_OAUTH_CONFIG: JSON.stringify({ 'agent.one': { tokenUrl: 'https://issuer.example/token', clientId: 'id', clientSecret: 'secret' } }) })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_AGENT_OAUTH_CONFIG: JSON.stringify({ 'agent.one': { tokenUrl: 'https://issuer.example/token?secret=x', clientId: 'id', clientSecret: 'secret' } }) })).toThrow('tokenUrl');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_LINEAR_PROJECT_SOURCES: JSON.stringify([{ id: 'linear', endpoint: 'http://linear.example/graphql', apiKey: 'key', tenantId: 'team' }]) })).toThrow('AEEIS_LINEAR_PROJECT_SOURCES');
  });

  it('validates the optional principal directory boundary', () => {
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PRINCIPAL_DIRECTORY_URL: 'https://directory.example/lookup', AEEIS_PRINCIPAL_DIRECTORY_TOKEN: 'secret' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PRINCIPAL_DIRECTORY_URL: 'http://directory.example/lookup' })).toThrow('AEEIS_PRINCIPAL_DIRECTORY_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PRINCIPAL_DIRECTORY_URL: 'http://127.0.0.1:4811/lookup', AEEIS_PRINCIPAL_DIRECTORY_ALLOW_INSECURE_HTTP: '1' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_PRINCIPAL_DIRECTORY_URL: 'https://directory.example/lookup?token=secret' })).toThrow('AEEIS_PRINCIPAL_DIRECTORY_URL');
  });

  it('validates the optional Channel Identity boundary', () => {
    expect(() => validateRuntimeConfig({ ...development, AEEIS_CHANNEL_IDENTITY_URL: 'https://identity.example/lookup', AEEIS_CHANNEL_IDENTITY_TOKEN: 'secret' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_CHANNEL_IDENTITY_URL: 'http://identity.example/lookup' })).toThrow('AEEIS_CHANNEL_IDENTITY_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_CHANNEL_IDENTITY_URL: 'http://127.0.0.1:4812/lookup', AEEIS_CHANNEL_IDENTITY_ALLOW_INSECURE_HTTP: '1' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_CHANNEL_IDENTITY_URL: 'https://identity.example/lookup?token=secret' })).toThrow('AEEIS_CHANNEL_IDENTITY_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_CHANNEL_IDENTITY_TIMEOUT_MS: '99' })).toThrow('AEEIS_CHANNEL_IDENTITY_TIMEOUT_MS');
  });

  it('validates OwnHow runtime and RSI proposal synthesis boundaries', () => {
    expect(() => validateRuntimeConfig({ ...development, AEEIS_OWNHOW_ENABLED: '1' })).toThrow('AEEIS_OWNHOW_RUNTIME');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_OWNHOW_RUNTIME: 'codex' })).toThrow('AEEIS_OWNHOW_ENABLED');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_OWNHOW_ENABLED: '1', AEEIS_OWNHOW_RUNTIME: 'codex' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...development, AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED: '2' })).toThrow('AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED: '1' })).toThrow('fixed model or AEEIS_PLANPRICE_URL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED: '1', AEEIS_MODEL_BASE_URL: 'https://model.example/v1' })).toThrow('AEEIS_MODEL_BASE_URL and AEEIS_MODEL');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_RSI_PROPOSAL_SYNTHESIS_PRIVACY: 'public,unknown' })).toThrow('AEEIS_RSI_PROPOSAL_SYNTHESIS_PRIVACY');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_RSI_PROPOSAL_SYNTHESIS_MAX_CALLS: '0' })).toThrow('AEEIS_RSI_PROPOSAL_SYNTHESIS_MAX_CALLS');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_RSI_PROPOSAL_SYNTHESIS_MAX_TOKENS: 'not-an-int' })).toThrow('AEEIS_RSI_PROPOSAL_SYNTHESIS_MAX_TOKENS');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_RSI_PROPOSAL_INTERVAL_MS: '500' })).toThrow('AEEIS_RSI_PROPOSAL_INTERVAL_MS');
    expect(() => validateRuntimeConfig({ ...development, AEEIS_RSI_PROPOSAL_INTERVAL_MS: '0' })).not.toThrow();
    expect(() => validateRuntimeConfig({
      ...development,
      AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED: '1',
      AEEIS_MODEL_BASE_URL: 'https://model.example/v1',
      AEEIS_MODEL: 'model/1',
    })).not.toThrow();
    expect(() => validateRuntimeConfig({
      ...production,
      AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED: '1',
      AEEIS_MODEL_BASE_URL: 'https://model.example/v1',
      AEEIS_MODEL: 'model/1',
    })).toThrow('AEEIS_RSI_EVALUATOR_URL');
    expect(() => validateRuntimeConfig({
      ...production,
      AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED: '1',
      AEEIS_MODEL_BASE_URL: 'https://model.example/v1',
      AEEIS_MODEL: 'model/1',
      AEEIS_RSI_EVALUATOR_URL: 'https://evaluator.example/evaluate',
    })).not.toThrow();
  });

  it('requires an explicit compatible build for a Temporal compatible rollout', () => {
    const temporal = { ...production, AEEIS_RUNNER: 'temporal', TEMPORAL_ADDRESS: 'temporal:7233', AEEIS_WORKER_TOKEN: 'worker', AEEIS_INTERNAL_URL: 'https://aeeis.internal', AEEIS_TEMPORAL_WORKER_HEALTH_URL: 'https://worker.internal/readyz', AEEIS_BUILD_ID: 'aeeis-worker-v2', AEEIS_TEMPORAL_USE_VERSIONING: '1', AEEIS_TEMPORAL_BUILD_ID_ROLLOUT: 'compatible' };
    expect(() => validateRuntimeConfig(temporal)).toThrow();
    expect(() => validateRuntimeConfig({ ...temporal, AEEIS_TEMPORAL_COMPATIBLE_WITH: 'aeeis-worker-v1' })).not.toThrow();
  });

  it('strictly validates the Temporal Worker health transport switch', () => {
    const temporal = { ...production, AEEIS_RUNNER: 'temporal', TEMPORAL_ADDRESS: 'temporal:7233', AEEIS_WORKER_TOKEN: 'worker', AEEIS_INTERNAL_URL: 'https://aeeis.internal', AEEIS_TEMPORAL_WORKER_HEALTH_URL: 'https://worker.internal/readyz', AEEIS_BUILD_ID: 'aeeis-worker-v2', AEEIS_TEMPORAL_USE_VERSIONING: '1' };
    expect(() => validateRuntimeConfig({ ...temporal, AEEIS_TEMPORAL_WORKER_HEALTH_ALLOW_INSECURE_HTTP: 'yes' })).toThrow('AEEIS_TEMPORAL_WORKER_HEALTH_ALLOW_INSECURE_HTTP');
    expect(() => validateRuntimeConfig(temporal)).not.toThrow();
  });

  it('keeps development defaults available for explicitly unauthenticated local fixture work', () => {
    const local = { AEEIS_AUTH_DISABLED: '1' };
    expect(() => validateRuntimeConfig({ ...local, NODE_ENV: 'test' })).not.toThrow();
    expect(() => validateRuntimeConfig(local)).not.toThrow();
    expect(() => validateRuntimeConfig({ ...local, NODE_ENV: 'production', AEEIS_ENV: 'development', AEEIS_MODEL_ALLOW_INSECURE_HTTP: '1' })).not.toThrow();
  });
});
