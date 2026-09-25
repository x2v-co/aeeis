import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { validateRuntimeConfig } from '../src/config-validation.js';

const production = {
  AEEIS_ENV: 'production',
  DATABASE_URL: 'postgresql://aeeis@db/aeeis',
  AEEIS_ACCESS_TOKEN: 'operator-token',
  AEEIS_RUNNER: 'local',
  AEEIS_HOST: '127.0.0.1',
};

describe('runtime configuration validation', () => {
  it('accepts a production database and authenticated local deployment', () => {
    expect(() => validateRuntimeConfig(production)).not.toThrow();
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
    expect(() => validateRuntimeConfig({ AEEIS_PLANPRICE_CACHE_TTL_MS: '-1' })).toThrow('AEEIS_PLANPRICE_CACHE_TTL_MS');
    expect(() => validateRuntimeConfig({ AEEIS_PLANPRICE_CACHE_TTL_MS: 'not-a-number' })).toThrow('AEEIS_PLANPRICE_CACHE_TTL_MS');
  });

  it('validates the explicit private-data provider policy', () => {
    expect(() => validateRuntimeConfig({ AEEIS_MODEL_PRIVATE_DATA_ALLOWED: JSON.stringify({ provider: true }) })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_MODEL_PRIVATE_DATA_ALLOWED: JSON.stringify({ provider: 'yes' }) })).toThrow('AEEIS_MODEL_PRIVATE_DATA_ALLOWED');
    expect(() => validateRuntimeConfig({ AEEIS_MODEL_PRIVATE_DATA_ALLOWED: '[]' })).toThrow('AEEIS_MODEL_PRIVATE_DATA_ALLOWED');
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
    expect(() => validateRuntimeConfig({ AEEIS_MODEL_BASE_URL: 'https://model.example/v1?token=secret', AEEIS_MODEL: 'model/1' })).toThrow('AEEIS_MODEL_BASE_URL');
    expect(() => validateRuntimeConfig({ AEEIS_MODEL_HEALTH_URL: 'https://model.example/health#secret' })).toThrow('AEEIS_MODEL_HEALTH_URL');
    expect(() => validateRuntimeConfig({ AEEIS_PLANPRICE_URL: 'http://planprice.example' })).toThrow('AEEIS_PLANPRICE_URL');
    expect(() => validateRuntimeConfig({ AEEIS_PLANPRICE_HEALTH_URL: 'https://planprice.example/health' })).toThrow('requires AEEIS_PLANPRICE_URL');
    expect(() => validateRuntimeConfig({ AEEIS_PLANPRICE_URL: 'https://planprice.example', AEEIS_PLANPRICE_HEALTH_URL: 'https://other.example/health' })).toThrow('AEEIS_PLANPRICE_HEALTH_URL');
    expect(() => validateRuntimeConfig({ AEEIS_PLANPRICE_URL: 'https://planprice.example', AEEIS_PLANPRICE_HEALTH_URL: 'https://planprice.example/health' })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_RSI_EVALUATOR_URL: 'https://evaluator.example/evaluate?token=secret' })).toThrow('AEEIS_RSI_EVALUATOR_URL');
    expect(() => validateRuntimeConfig({ AEEIS_RSI_EVALUATOR_HEALTH_URL: 'https://evaluator.example/health' })).toThrow('requires AEEIS_RSI_EVALUATOR_URL');
    expect(() => validateRuntimeConfig({ AEEIS_RSI_EVALUATOR_URL: 'https://evaluator.example/evaluate', AEEIS_RSI_EVALUATOR_HEALTH_URL: 'https://other.example/health' })).toThrow('AEEIS_RSI_EVALUATOR_HEALTH_URL');
    expect(() => validateRuntimeConfig({ AEEIS_RSI_EVALUATOR_URL: 'https://evaluator.example/evaluate', AEEIS_RSI_EVALUATOR_HEALTH_URL: 'https://evaluator.example/health' })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_MODEL_PROVIDER_ENDPOINTS: JSON.stringify({ provider: 'http://provider.example/v1' }) })).toThrow('AEEIS_MODEL_PROVIDER_ENDPOINTS');
    expect(() => validateRuntimeConfig({
      AEEIS_PLANPRICE_URL: 'http://planprice.example',
      AEEIS_PLANPRICE_ALLOW_INSECURE_HTTP: '1',
      AEEIS_MODEL_PROVIDER_ENDPOINTS: JSON.stringify({ provider: 'http://provider.example/v1' }),
      AEEIS_MODEL_PROVIDER_ALLOW_INSECURE_HTTP: '1',
      AEEIS_MODEL_PROVIDER_HEALTH_URLS: JSON.stringify({ provider: 'http://provider.example/health' }),
      AEEIS_RSI_EVALUATOR_URL: 'http://evaluator.example/evaluate',
      AEEIS_RSI_EVALUATOR_ALLOW_INSECURE_HTTP: '1',
    })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_MODEL_PROVIDER_ENDPOINTS: '{}' })).not.toThrow();
  });

  it('validates integration endpoints before opening stores', () => {
    expect(() => validateRuntimeConfig({ AEEIS_KNOWLEDGE_URL: 'http://knowledge.example/search' })).toThrow('AEEIS_KNOWLEDGE_URL');
    expect(() => validateRuntimeConfig({ AEEIS_PROJECT_SOURCES_URL: 'https://sources.example/search?token=secret' })).toThrow('AEEIS_PROJECT_SOURCES_URL');
    expect(() => validateRuntimeConfig({ AEEIS_PROJECTION_SINK_URL: 'https://sink.example/events#secret' })).toThrow('AEEIS_PROJECTION_SINK_URL');
    expect(() => validateRuntimeConfig({ AEEIS_PROJECTION_SINK_HEALTH_URL: 'https://sink.example/health' })).toThrow('requires AEEIS_PROJECTION_SINK_URL');
    expect(() => validateRuntimeConfig({ AEEIS_PROJECTION_SINK_URL: 'https://sink.example/events', AEEIS_PROJECTION_SINK_HEALTH_URL: 'https://other.example/health' })).toThrow('AEEIS_PROJECTION_SINK_HEALTH_URL');
    expect(() => validateRuntimeConfig({ AEEIS_PROJECTION_SINK_URL: 'https://sink.example/events', AEEIS_PROJECTION_SINK_HEALTH_URL: 'https://sink.example/health' })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_BRAIN_EMBEDDING_URL: 'http://127.0.0.1:8081/embeddings' })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_BRAIN_EMBEDDING_HEALTH_URL: 'https://embed.example/health' })).toThrow('requires AEEIS_BRAIN_EMBEDDING_URL');
    expect(() => validateRuntimeConfig({ AEEIS_BRAIN_EMBEDDING_URL: 'https://embed.example/v1/embeddings', AEEIS_BRAIN_EMBEDDING_HEALTH_URL: 'https://other.example/health' })).toThrow('AEEIS_BRAIN_EMBEDDING_HEALTH_URL');
    expect(() => validateRuntimeConfig({ AEEIS_BRAIN_EMBEDDING_URL: 'https://embed.example/v1/embeddings', AEEIS_BRAIN_EMBEDDING_HEALTH_URL: 'https://embed.example/health' })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_KNOWLEDGE_URL: 'ftp://localhost/knowledge' })).toThrow('must use HTTPS');
    expect(() => validateRuntimeConfig({ AEEIS_FEISHU_API_BASE_URL: 'https://open.feishu.cn?token=secret' })).toThrow('AEEIS_FEISHU_API_BASE_URL');
    expect(() => validateRuntimeConfig({ AEEIS_TOOLKIT_MANIFEST_URL: 'https://toolkit.example/manifest' })).toThrow('configured together');
    expect(() => validateRuntimeConfig({ AEEIS_HERMES_CLI_PATH: 'hermes', AEEIS_HERMES_CLI_TIMEOUT_MS: '499' })).toThrow('AEEIS_HERMES_CLI_TIMEOUT_MS');
    expect(() => validateRuntimeConfig({ AEEIS_HERMES_CLI_PATH: 'hermes', AEEIS_HERMES_CLI_TIMEOUT_MS: '30000' })).not.toThrow();
  });

  it('validates the direct Hermes Debate bridge contract', () => {
    expect(() => validateRuntimeConfig({ AEEIS_HERMES_SIGNING_KEYS: '', AEEIS_HERMES_DEBATE_ROUTES: '', AEEIS_HERMES_SENDER_AGENTS: '' })).not.toThrow();
    const keys = JSON.stringify({ local: 'hermes-signing-key-123' });
    expect(() => validateRuntimeConfig({ AEEIS_HERMES_SIGNING_KEYS: keys })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_HERMES_DEBATE_ROUTES: '[]' })).toThrow('AEEIS_HERMES_SIGNING_KEYS');
    expect(() => validateRuntimeConfig({ AEEIS_HERMES_SIGNING_KEYS: '{}' })).toThrow('AEEIS_HERMES_SIGNING_KEYS');
    expect(() => validateRuntimeConfig({ AEEIS_HERMES_SIGNING_KEYS: JSON.stringify({ local: 'short' }) })).toThrow('AEEIS_HERMES_SIGNING_KEYS');
    expect(() => validateRuntimeConfig({ AEEIS_HERMES_SIGNING_KEYS: keys, AEEIS_HERMES_DEBATE_ROUTES: '{' })).toThrow('AEEIS_HERMES_DEBATE_ROUTES');
  });

  it('validates external Agent and connector JSON endpoints', () => {
    const card = JSON.stringify([{ endpoint: 'https://agent.example/task' }]);
    expect(() => validateRuntimeConfig({ AEEIS_AGENT_CARDS: card })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_AGENT_CARDS: JSON.stringify([{ endpoint: 'http://agent.example/task' }]) })).toThrow('AEEIS_AGENT_CARDS');
    expect(() => validateRuntimeConfig({ AEEIS_AGENT_CARDS: JSON.stringify([{ endpoint: 'http://127.0.0.1:4390/task' }]), AEEIS_AGENT_ALLOW_INSECURE_HTTP: '1' })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_AGENT_OAUTH_CONFIG: JSON.stringify({ 'agent.one': { tokenUrl: 'https://issuer.example/token', clientId: 'id', clientSecret: 'secret' } }) })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_AGENT_OAUTH_CONFIG: JSON.stringify({ 'agent.one': { tokenUrl: 'https://issuer.example/token?secret=x', clientId: 'id', clientSecret: 'secret' } }) })).toThrow('tokenUrl');
    expect(() => validateRuntimeConfig({ AEEIS_LINEAR_PROJECT_SOURCES: JSON.stringify([{ id: 'linear', endpoint: 'http://linear.example/graphql', apiKey: 'key', tenantId: 'team' }]) })).toThrow('AEEIS_LINEAR_PROJECT_SOURCES');
  });

  it('validates the optional principal directory boundary', () => {
    expect(() => validateRuntimeConfig({ AEEIS_PRINCIPAL_DIRECTORY_URL: 'https://directory.example/lookup', AEEIS_PRINCIPAL_DIRECTORY_TOKEN: 'secret' })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_PRINCIPAL_DIRECTORY_URL: 'http://directory.example/lookup' })).toThrow('AEEIS_PRINCIPAL_DIRECTORY_URL');
    expect(() => validateRuntimeConfig({ AEEIS_PRINCIPAL_DIRECTORY_URL: 'http://127.0.0.1:4811/lookup', AEEIS_PRINCIPAL_DIRECTORY_ALLOW_INSECURE_HTTP: '1' })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_PRINCIPAL_DIRECTORY_URL: 'https://directory.example/lookup?token=secret' })).toThrow('AEEIS_PRINCIPAL_DIRECTORY_URL');
  });

  it('validates the optional Channel Identity boundary', () => {
    expect(() => validateRuntimeConfig({ AEEIS_CHANNEL_IDENTITY_URL: 'https://identity.example/lookup', AEEIS_CHANNEL_IDENTITY_TOKEN: 'secret' })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_CHANNEL_IDENTITY_URL: 'http://identity.example/lookup' })).toThrow('AEEIS_CHANNEL_IDENTITY_URL');
    expect(() => validateRuntimeConfig({ AEEIS_CHANNEL_IDENTITY_URL: 'http://127.0.0.1:4812/lookup', AEEIS_CHANNEL_IDENTITY_ALLOW_INSECURE_HTTP: '1' })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_CHANNEL_IDENTITY_URL: 'https://identity.example/lookup?token=secret' })).toThrow('AEEIS_CHANNEL_IDENTITY_URL');
    expect(() => validateRuntimeConfig({ AEEIS_CHANNEL_IDENTITY_TIMEOUT_MS: '99' })).toThrow('AEEIS_CHANNEL_IDENTITY_TIMEOUT_MS');
  });

  it('validates OwnHow runtime and RSI proposal synthesis boundaries', () => {
    expect(() => validateRuntimeConfig({ AEEIS_OWNHOW_ENABLED: '1' })).toThrow('AEEIS_OWNHOW_RUNTIME');
    expect(() => validateRuntimeConfig({ AEEIS_OWNHOW_RUNTIME: 'codex' })).toThrow('AEEIS_OWNHOW_ENABLED');
    expect(() => validateRuntimeConfig({ AEEIS_OWNHOW_ENABLED: '1', AEEIS_OWNHOW_RUNTIME: 'codex' })).not.toThrow();
    expect(() => validateRuntimeConfig({ AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED: '2' })).toThrow('AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED');
    expect(() => validateRuntimeConfig({ AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED: '1' })).toThrow('fixed model or AEEIS_PLANPRICE_URL');
    expect(() => validateRuntimeConfig({ AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED: '1', AEEIS_MODEL_BASE_URL: 'https://model.example/v1' })).toThrow('AEEIS_MODEL_BASE_URL and AEEIS_MODEL');
    expect(() => validateRuntimeConfig({ AEEIS_RSI_PROPOSAL_SYNTHESIS_PRIVACY: 'public,unknown' })).toThrow('AEEIS_RSI_PROPOSAL_SYNTHESIS_PRIVACY');
    expect(() => validateRuntimeConfig({ AEEIS_RSI_PROPOSAL_SYNTHESIS_MAX_CALLS: '0' })).toThrow('AEEIS_RSI_PROPOSAL_SYNTHESIS_MAX_CALLS');
    expect(() => validateRuntimeConfig({ AEEIS_RSI_PROPOSAL_SYNTHESIS_MAX_TOKENS: 'not-an-int' })).toThrow('AEEIS_RSI_PROPOSAL_SYNTHESIS_MAX_TOKENS');
    expect(() => validateRuntimeConfig({ AEEIS_RSI_PROPOSAL_INTERVAL_MS: '500' })).toThrow('AEEIS_RSI_PROPOSAL_INTERVAL_MS');
    expect(() => validateRuntimeConfig({ AEEIS_RSI_PROPOSAL_INTERVAL_MS: '0' })).not.toThrow();
    expect(() => validateRuntimeConfig({
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

  it('keeps development defaults available for local fixture work', () => {
    expect(() => validateRuntimeConfig({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => validateRuntimeConfig({})).not.toThrow();
    expect(() => validateRuntimeConfig({ NODE_ENV: 'production', AEEIS_ENV: 'development', AEEIS_MODEL_ALLOW_INSECURE_HTTP: '1' })).not.toThrow();
  });
});
