import { validateHealthEndpoint } from './dependency-health.js';
import { createPublicKey } from 'node:crypto';

function parseConfigRecord(raw: string | undefined, label: string, allowEmpty = false): Record<string, string> {
  if (!raw) throw new Error(`${label} is required when Planprice model routing is enabled`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length && !allowEmpty) throw new Error(`${label} must contain at least one entry`);
  return Object.fromEntries(entries.map(([key, item]) => {
    if (!key.trim() || typeof item !== 'string' || !item.trim()) throw new Error(`${label} entries must contain non-empty string values`);
    return [key, item];
  }));
}

function parseBooleanConfigRecord(raw: string | undefined, label: string): Record<string, boolean> {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (!key.trim() || typeof item !== 'boolean') throw new Error(`${label} entries must map names to booleans`);
    return [key, item];
  }));
}

function validateServiceUrls(values: Record<string, string>, label: string, allowInsecureHttp = false): void {
  for (const [key, raw] of Object.entries(values)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${label} entry ${key} must be a valid URL`);
    }
    if (url.username || url.password || url.search || url.hash) throw new Error(`${label} entry ${key} must not contain credentials, query or fragment`);
    const loopbackHttp = url.protocol === 'http:' && (allowInsecureHttp || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    if (url.protocol !== 'https:' && !loopbackHttp) throw new Error(`${label} entry ${key} must use HTTPS except loopback`);
  }
}

function validateEndpoint(raw: string | undefined, label: string, allowInsecureHttp = false): void {
  if (!raw?.trim()) return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, query or fragment`);
  }
  const loopbackHttp = url.protocol === 'http:' && (allowInsecureHttp || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error(`${label} must use HTTPS except loopback`);
  }
}

/** Validate an endpoint whose URL is supplied by an integration boundary.
 * Keep this check at startup as well as in the adapter constructor so a bad
 * deployment cannot open stores and only fail when the first run reaches the
 * integration. Query strings are rejected because operators routinely put
 * bearer tokens there by accident and they become part of logs/proxies. */
function validateIntegrationEndpoint(raw: string | undefined, label: string, allowInsecureHttp = false): void {
  if (!raw?.trim()) return;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be a valid URL`); }
  if (url.username || url.password || url.search || url.hash) throw new Error(`${label} must not contain credentials, query or fragment`);
  const loopbackHttp = url.protocol === 'http:' && (allowInsecureHttp || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error(`${label} must use HTTPS except loopback`);
  }
}

function parseJsonArray(raw: string | undefined, label: string): unknown[] | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`${label} must be valid JSON`); }
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array`);
  return value;
}

function validateEndpointFields(raw: string | undefined, label: string, field = 'endpoint'): void {
  const entries = parseJsonArray(raw, label);
  if (!entries) return;
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label}[${index}] must be an object`);
    const value = (entry as Record<string, unknown>)[field];
    if (value !== undefined && typeof value !== 'string') throw new Error(`${label}[${index}].${field} must be a string`);
    if (typeof value === 'string') validateIntegrationEndpoint(value, `${label}[${index}].${field}`);
  }
}

function validateAgentCards(raw: string | undefined, allowInsecureHttp = false): void {
  if (raw === undefined) return;
  const cards = parseJsonArray(raw, 'AEEIS_AGENT_CARDS')!;
  for (const [index, card] of cards.entries()) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error(`AEEIS_AGENT_CARDS[${index}] must be an object`);
    const endpoint = (card as Record<string, unknown>).endpoint;
    if (endpoint !== undefined && typeof endpoint !== 'string') throw new Error(`AEEIS_AGENT_CARDS[${index}].endpoint must be a string`);
    if (typeof endpoint === 'string') validateIntegrationEndpoint(endpoint, `AEEIS_AGENT_CARDS[${index}].endpoint`, allowInsecureHttp);
  }
}

function validateOAuthConfig(raw: string | undefined): void {
  if (raw === undefined) return;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('AEEIS_AGENT_OAUTH_CONFIG must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AEEIS_AGENT_OAUTH_CONFIG must be a JSON object');
  for (const [agentId, config] of Object.entries(value as Record<string, unknown>)) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`AEEIS_AGENT_OAUTH_CONFIG entry ${agentId} must be an object`);
    const tokenUrl = (config as Record<string, unknown>).tokenUrl;
    if (typeof tokenUrl !== 'string') throw new Error(`AEEIS_AGENT_OAUTH_CONFIG entry ${agentId} requires tokenUrl`);
    validateIntegrationEndpoint(tokenUrl, `AEEIS_AGENT_OAUTH_CONFIG entry ${agentId}.tokenUrl`);
  }
}

function validateCompetitionModels(raw: string | undefined, label: string, allowInsecureHttp = false): void {
  if (raw === undefined) return;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`${label} must be valid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  for (const [id, config] of Object.entries(value as Record<string, unknown>)) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${label} entry ${id} must be an object`);
    const baseUrl = (config as Record<string, unknown>).baseUrl;
    if (typeof baseUrl !== 'string') throw new Error(`${label} entry ${id} requires baseUrl`);
    validateEndpoint(baseUrl, `${label} entry ${id}.baseUrl`, allowInsecureHttp);
    if (typeof (config as Record<string, unknown>).model !== 'string' || !(config as Record<string, unknown>).model) {
      throw new Error(`${label} entry ${id} requires model`);
    }
  }
}

const privacyClasses = new Set(['public', 'internal', 'confidential', 'private']);

function validateIntegerConfig(env: NodeJS.ProcessEnv, name: string, options: {
  defaultValue: number;
  min: number;
  max?: number;
  allowZero?: boolean;
}): number {
  const raw = env[name];
  const value = raw === undefined ? options.defaultValue : Number(raw);
  const validMinimum = options.allowZero ? (value === 0 || value >= options.min) : value >= options.min;
  if (!Number.isSafeInteger(value) || !validMinimum || (options.max !== undefined && value > options.max)) {
    const range = options.max === undefined ? `at least ${options.min}` : `between ${options.min} and ${options.max}`;
    throw new Error(`${name} must be a safe integer ${range}${options.allowZero ? ' (or 0)' : ''}`);
  }
  return value;
}

function validateFractionConfig(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  const value = raw === undefined ? defaultValue : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be a number between 0 and 1`);
  return value;
}

function validatePrivacyList(raw: string | undefined, label: string): void {
  const values = (raw ?? 'public,internal').split(',').map(value => value.trim()).filter(Boolean);
  if (!values.length || values.some(value => !privacyClasses.has(value)) || new Set(values).size !== values.length) {
    throw new Error(`${label} must contain unique privacy classes from public, internal, confidential, private`);
  }
}

/** Startup checks for deployment-level invariants. Keep this module free of
 * stores and network calls so CI and deployment tooling can validate config
 * before opening locks or connecting to external systems. */
export function validateRuntimeConfig(env: NodeJS.ProcessEnv = process.env): void {
  // AEEIS_ENV is the deployment intent. An explicit development value is
  // allowed inside a production-built image (for example the local Compose
  // fixture stack); NODE_ENV is only the fallback when AEEIS_ENV is absent.
  const production = env.AEEIS_ENV !== undefined ? env.AEEIS_ENV === 'production' : env.NODE_ENV === 'production';
  if (env.AEEIS_DEMO_MODE !== undefined && !['0', '1'].includes(env.AEEIS_DEMO_MODE)) throw new Error('AEEIS_DEMO_MODE must be 0 or 1');
  if (production && env.AEEIS_DEMO_MODE === '1') throw new Error('Production configuration cannot enable fixture demonstration mode');
  if (env.AEEIS_OWNHOW_ENABLED !== undefined && !['0', '1'].includes(env.AEEIS_OWNHOW_ENABLED)) throw new Error('AEEIS_OWNHOW_ENABLED must be 0 or 1');
  if (env.AEEIS_OWNHOW_ENABLED === '1' && !env.AEEIS_OWNHOW_RUNTIME?.trim()) {
    throw new Error('AEEIS_OWNHOW_ENABLED=1 requires AEEIS_OWNHOW_RUNTIME');
  }
  if (env.AEEIS_OWNHOW_ENABLED !== '1' && env.AEEIS_OWNHOW_RUNTIME?.trim()) {
    throw new Error('AEEIS_OWNHOW_RUNTIME requires AEEIS_OWNHOW_ENABLED=1');
  }
  if (env.AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED !== undefined && !['0', '1'].includes(env.AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED)) {
    throw new Error('AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED must be 0 or 1');
  }
  for (const name of ['AEEIS_RSI_AUTOMATION_ENABLED', 'AEEIS_RSI_AUTO_APPROVE_LOW_RISK', 'AEEIS_RSI_AUTO_ROLLOUT', 'AEEIS_RSI_AUTO_ACTIVATE']) {
    if (env[name] !== undefined && !['0', '1'].includes(env[name]!)) throw new Error(`${name} must be 0 or 1`);
  }
  validatePrivacyList(env.AEEIS_RSI_PROPOSAL_SYNTHESIS_PRIVACY, 'AEEIS_RSI_PROPOSAL_SYNTHESIS_PRIVACY');
  validateIntegerConfig(env, 'AEEIS_RSI_PROPOSAL_SYNTHESIS_MAX_CALLS', { defaultValue: 1, min: 1, max: 20 });
  validateIntegerConfig(env, 'AEEIS_RSI_PROPOSAL_SYNTHESIS_MAX_TOKENS', { defaultValue: 16_000, min: 1, max: 10_000_000 });
  validateIntegerConfig(env, 'AEEIS_RSI_PROPOSAL_BATCH', { defaultValue: 100, min: 1, max: 100_000 });
  validateIntegerConfig(env, 'AEEIS_RSI_PROPOSAL_CLAIM_LEASE_MS', { defaultValue: 30_000, min: 1_000, max: 86_400_000 });
  validateIntegerConfig(env, 'AEEIS_RSI_PROPOSAL_INTERVAL_MS', { defaultValue: 1_000, min: 1_000, allowZero: true });
  validateIntegerConfig(env, 'AEEIS_RSI_AUTOMATION_INTERVAL_MS', { defaultValue: 30_000, min: 1_000 });
  validateIntegerConfig(env, 'AEEIS_RSI_AUTOMATION_BATCH', { defaultValue: 10, min: 1, max: 200 });
  validateFractionConfig(env, 'AEEIS_RSI_AUTOMATION_MINIMUM_SCORE', 0.7);
  validateFractionConfig(env, 'AEEIS_RSI_LOW_CONFIDENCE_THRESHOLD', 0.5);
  const hasFixedModelBase = Boolean(env.AEEIS_MODEL_BASE_URL?.trim());
  const hasFixedModelName = Boolean(env.AEEIS_MODEL?.trim());
  if (hasFixedModelBase !== hasFixedModelName) throw new Error('AEEIS_MODEL_BASE_URL and AEEIS_MODEL must be configured together');
  validateEndpoint(env.AEEIS_MODEL_BASE_URL, 'AEEIS_MODEL_BASE_URL', env.AEEIS_MODEL_ALLOW_INSECURE_HTTP === '1');
  validateEndpoint(env.AEEIS_MODEL_HEALTH_URL, 'AEEIS_MODEL_HEALTH_URL', env.AEEIS_MODEL_ALLOW_INSECURE_HTTP === '1');
  validateEndpoint(env.AEEIS_PLANPRICE_URL, 'AEEIS_PLANPRICE_URL', env.AEEIS_PLANPRICE_ALLOW_INSECURE_HTTP === '1');
  if (env.AEEIS_PLANPRICE_HEALTH_URL) {
    if (!env.AEEIS_PLANPRICE_URL) throw new Error('AEEIS_PLANPRICE_HEALTH_URL requires AEEIS_PLANPRICE_URL');
    try { validateHealthEndpoint(env.AEEIS_PLANPRICE_URL, env.AEEIS_PLANPRICE_HEALTH_URL); }
    catch { throw new Error('AEEIS_PLANPRICE_HEALTH_URL must be a credential-free HTTPS/loopback URL on the Planprice origin without query or fragment'); }
  }
  validateEndpoint(env.AEEIS_RSI_EVALUATOR_URL, 'AEEIS_RSI_EVALUATOR_URL', env.AEEIS_RSI_EVALUATOR_ALLOW_INSECURE_HTTP === '1');
  if (env.AEEIS_RSI_AUTOMATION_ENABLED === '1' && !env.AEEIS_RSI_EVALUATOR_URL?.trim()) {
    throw new Error('RSI automation requires AEEIS_RSI_EVALUATOR_URL');
  }
  if (env.AEEIS_RSI_EVALUATOR_HEALTH_URL) {
    if (!env.AEEIS_RSI_EVALUATOR_URL) throw new Error('AEEIS_RSI_EVALUATOR_HEALTH_URL requires AEEIS_RSI_EVALUATOR_URL');
    try { validateHealthEndpoint(env.AEEIS_RSI_EVALUATOR_URL, env.AEEIS_RSI_EVALUATOR_HEALTH_URL); }
    catch { throw new Error('AEEIS_RSI_EVALUATOR_HEALTH_URL must be a credential-free HTTPS/loopback URL on the evaluator origin without query or fragment'); }
  }
  // Integration endpoints are checked before any repository is opened. The
  // adapters repeat the check at construction time for defense in depth.
  validateIntegrationEndpoint(env.AEEIS_PROJECTION_SINK_URL, 'AEEIS_PROJECTION_SINK_URL');
  if (env.AEEIS_PROJECTION_SINK_HEALTH_URL) {
    if (!env.AEEIS_PROJECTION_SINK_URL) throw new Error('AEEIS_PROJECTION_SINK_HEALTH_URL requires AEEIS_PROJECTION_SINK_URL');
    try { validateHealthEndpoint(env.AEEIS_PROJECTION_SINK_URL, env.AEEIS_PROJECTION_SINK_HEALTH_URL); }
    catch { throw new Error('AEEIS_PROJECTION_SINK_HEALTH_URL must be a credential-free HTTPS/loopback URL on the projection sink origin without query or fragment'); }
  }
  validateIntegrationEndpoint(env.AEEIS_FEISHU_WEBHOOK_URL, 'AEEIS_FEISHU_WEBHOOK_URL');
  validateIntegrationEndpoint(env.AEEIS_FEISHU_API_BASE_URL, 'AEEIS_FEISHU_API_BASE_URL');
  validateIntegrationEndpoint(env.AEEIS_KNOWLEDGE_URL, 'AEEIS_KNOWLEDGE_URL');
  validateIntegrationEndpoint(env.AEEIS_KNOWLEDGE_EMBEDDING_URL, 'AEEIS_KNOWLEDGE_EMBEDDING_URL');
  validateIntegrationEndpoint(env.AEEIS_BRAIN_EMBEDDING_URL, 'AEEIS_BRAIN_EMBEDDING_URL');
  for (const [embedding, health] of [['AEEIS_BRAIN_EMBEDDING_URL', 'AEEIS_BRAIN_EMBEDDING_HEALTH_URL']] as const) {
    if (!env[health]) continue;
    if (!env[embedding]) throw new Error(`${health} requires ${embedding}`);
    try { validateHealthEndpoint(env[embedding]!, env[health]!); }
    catch { throw new Error(`${health} must be a credential-free HTTPS/loopback URL on the embedding origin without query or fragment`); }
  }
  validateIntegrationEndpoint(env.AEEIS_PROJECT_SOURCES_URL, 'AEEIS_PROJECT_SOURCES_URL');
  for (const [source, health] of [['AEEIS_KNOWLEDGE_URL', 'AEEIS_KNOWLEDGE_HEALTH_URL'], ['AEEIS_PROJECT_SOURCES_URL', 'AEEIS_PROJECT_SOURCES_HEALTH_URL']] as const) {
    if (!env[health]) continue;
    if (!env[source]) throw new Error(`${health} requires ${source}`);
    try { validateHealthEndpoint(env[source]!, env[health]!); }
    catch { throw new Error(`${health} must be a credential-free HTTPS/loopback URL on the connector origin without query or fragment`); }
  }
  validateIntegrationEndpoint(env.AEEIS_OIDC_ISSUER, 'AEEIS_OIDC_ISSUER');
  validateIntegrationEndpoint(env.AEEIS_OIDC_JWKS_URL, 'AEEIS_OIDC_JWKS_URL');
  validateIntegrationEndpoint(env.AEEIS_PRINCIPAL_DIRECTORY_URL, 'AEEIS_PRINCIPAL_DIRECTORY_URL', env.AEEIS_PRINCIPAL_DIRECTORY_ALLOW_INSECURE_HTTP === '1');
  validateIntegerConfig(env, 'AEEIS_PRINCIPAL_DIRECTORY_TIMEOUT_MS', { defaultValue: 5_000, min: 100, max: 120_000 });
  validateIntegerConfig(env, 'AEEIS_PRINCIPAL_DIRECTORY_CACHE_TTL_MS', { defaultValue: 10_000, min: 0, max: 300_000 });
  validateIntegerConfig(env, 'AEEIS_PRINCIPAL_DIRECTORY_CACHE_MAX_ENTRIES', { defaultValue: 10_000, min: 1, max: 100_000 });
  if (env.AEEIS_PRINCIPAL_DIRECTORY_URL && env.AEEIS_PRINCIPAL_DIRECTORY_PATH) {
    throw new Error('AEEIS_PRINCIPAL_DIRECTORY_URL and AEEIS_PRINCIPAL_DIRECTORY_PATH cannot both be configured');
  }
  if (production && env.AEEIS_PRINCIPAL_DIRECTORY_PATH) {
    throw new Error('Production configuration requires AEEIS_PRINCIPAL_DIRECTORY_URL for the principal directory');
  }
  if (env.AEEIS_PRINCIPAL_DIRECTORY_TOKEN && !env.AEEIS_PRINCIPAL_DIRECTORY_URL) {
    throw new Error('AEEIS_PRINCIPAL_DIRECTORY_TOKEN requires AEEIS_PRINCIPAL_DIRECTORY_URL');
  }
  validateIntegrationEndpoint(env.AEEIS_CHANNEL_IDENTITY_URL, 'AEEIS_CHANNEL_IDENTITY_URL', env.AEEIS_CHANNEL_IDENTITY_ALLOW_INSECURE_HTTP === '1');
  validateIntegerConfig(env, 'AEEIS_CHANNEL_IDENTITY_TIMEOUT_MS', { defaultValue: 5_000, min: 100, max: 120_000 });
  if (env.AEEIS_CHANNEL_IDENTITY_URL && env.AEEIS_CHANNEL_IDENTITY_PATH) {
    throw new Error('AEEIS_CHANNEL_IDENTITY_URL and AEEIS_CHANNEL_IDENTITY_PATH cannot both be configured');
  }
  if (production && env.AEEIS_CHANNEL_IDENTITY_PATH) {
    throw new Error('Production configuration requires AEEIS_CHANNEL_IDENTITY_URL for channel identity resolution');
  }
  if (env.AEEIS_CHANNEL_IDENTITY_TOKEN && !env.AEEIS_CHANNEL_IDENTITY_URL) {
    throw new Error('AEEIS_CHANNEL_IDENTITY_TOKEN requires AEEIS_CHANNEL_IDENTITY_URL');
  }
  validateIntegrationEndpoint(env.AEEIS_INTERNAL_URL, 'AEEIS_INTERNAL_URL');
  validateAgentCards(env.AEEIS_AGENT_CARDS, env.AEEIS_AGENT_ALLOW_INSECURE_HTTP === '1');
  validateOAuthConfig(env.AEEIS_AGENT_OAUTH_CONFIG);
  validateEndpointFields(env.AEEIS_LINEAR_PROJECT_SOURCES, 'AEEIS_LINEAR_PROJECT_SOURCES');
  validateEndpointFields(env.AEEIS_JIRA_PROJECT_SOURCES, 'AEEIS_JIRA_PROJECT_SOURCES');
  validateEndpoint(env.AEEIS_TOOLKIT_REGISTRY_URL, 'AEEIS_TOOLKIT_REGISTRY_URL');
  validateEndpoint(env.AEEIS_TOOLKIT_MANIFEST_URL, 'AEEIS_TOOLKIT_MANIFEST_URL');
  validateEndpoint(env.AEEIS_TOOLKIT_INVOKE_URL, 'AEEIS_TOOLKIT_INVOKE_URL');
  const toolkitLegacyFields = [env.AEEIS_TOOLKIT_MANIFEST_URL, env.AEEIS_TOOLKIT_INVOKE_URL].filter(value => Boolean(value));
  if (toolkitLegacyFields.length === 1) throw new Error('AEEIS_TOOLKIT_MANIFEST_URL and AEEIS_TOOLKIT_INVOKE_URL must be configured together');
  validateCompetitionModels(env.AEEIS_COMPETITION_AGENT_MODELS, 'AEEIS_COMPETITION_AGENT_MODELS', env.AEEIS_MODEL_ALLOW_INSECURE_HTTP === '1');
  validateEndpoint(env.AEEIS_COMPETITION_EVALUATOR_BASE_URL, 'AEEIS_COMPETITION_EVALUATOR_BASE_URL', env.AEEIS_MODEL_ALLOW_INSECURE_HTTP === '1');
  const evaluatorBase = Boolean(env.AEEIS_COMPETITION_EVALUATOR_BASE_URL?.trim());
  const evaluatorModel = Boolean(env.AEEIS_COMPETITION_EVALUATOR_MODEL?.trim());
  if (evaluatorBase !== evaluatorModel) throw new Error('AEEIS_COMPETITION_EVALUATOR_BASE_URL and AEEIS_COMPETITION_EVALUATOR_MODEL must be configured together');
  if (env.AEEIS_MODEL_PROVIDER_ENDPOINTS) {
    const endpoints = parseConfigRecord(env.AEEIS_MODEL_PROVIDER_ENDPOINTS, 'AEEIS_MODEL_PROVIDER_ENDPOINTS', true);
    validateServiceUrls(endpoints, 'AEEIS_MODEL_PROVIDER_ENDPOINTS', env.AEEIS_MODEL_PROVIDER_ALLOW_INSECURE_HTTP === '1');
  }
  if (env.AEEIS_MODEL_PROVIDER_HEALTH_URLS) {
    const healthUrls = parseConfigRecord(env.AEEIS_MODEL_PROVIDER_HEALTH_URLS, 'AEEIS_MODEL_PROVIDER_HEALTH_URLS', true);
    validateServiceUrls(healthUrls, 'AEEIS_MODEL_PROVIDER_HEALTH_URLS', env.AEEIS_MODEL_PROVIDER_ALLOW_INSECURE_HTTP === '1');
  }
  if (env.AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED === '1' && !hasFixedModelBase && !env.AEEIS_PLANPRICE_URL?.trim()) {
    throw new Error('RSI proposal synthesis requires a fixed model or AEEIS_PLANPRICE_URL');
  }
  if (production && env.AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED === '1' && !env.AEEIS_RSI_EVALUATOR_URL?.trim()) {
    throw new Error('Production RSI proposal synthesis requires an independent AEEIS_RSI_EVALUATOR_URL');
  }
  const insecureFlags = [
    ['AEEIS_MODEL_ALLOW_INSECURE_HTTP', env.AEEIS_MODEL_ALLOW_INSECURE_HTTP],
    ['AEEIS_PLANPRICE_ALLOW_INSECURE_HTTP', env.AEEIS_PLANPRICE_ALLOW_INSECURE_HTTP],
    ['AEEIS_MODEL_PROVIDER_ALLOW_INSECURE_HTTP', env.AEEIS_MODEL_PROVIDER_ALLOW_INSECURE_HTTP],
    ['AEEIS_RSI_EVALUATOR_ALLOW_INSECURE_HTTP', env.AEEIS_RSI_EVALUATOR_ALLOW_INSECURE_HTTP],
    ['AEEIS_AGENT_ALLOW_INSECURE_HTTP', env.AEEIS_AGENT_ALLOW_INSECURE_HTTP],
    ['AEEIS_PRINCIPAL_DIRECTORY_ALLOW_INSECURE_HTTP', env.AEEIS_PRINCIPAL_DIRECTORY_ALLOW_INSECURE_HTTP],
    ['AEEIS_CHANNEL_IDENTITY_ALLOW_INSECURE_HTTP', env.AEEIS_CHANNEL_IDENTITY_ALLOW_INSECURE_HTTP],
  ];
  if (production && insecureFlags.some(([, value]) => value === '1')) {
    throw new Error('Production configuration cannot enable insecure HTTP endpoints');
  }
  const feishuAppFields = [env.AEEIS_FEISHU_APP_ID, env.AEEIS_FEISHU_APP_SECRET].filter(value => Boolean(value));
  if (feishuAppFields.length === 1) throw new Error('Feishu application projection requires AEEIS_FEISHU_APP_ID and AEEIS_FEISHU_APP_SECRET together');
  if (env.AEEIS_HERMES_CLI_PATH?.trim()) {
    const timeout = Number(env.AEEIS_HERMES_CLI_TIMEOUT_MS ?? '30000');
    if (!Number.isInteger(timeout) || timeout < 500 || timeout > 300000) throw new Error('AEEIS_HERMES_CLI_TIMEOUT_MS must be an integer between 500 and 300000');
  }
  const hermesSigningKeysRaw = env.AEEIS_HERMES_SIGNING_KEYS?.trim();
  const hermesBridgeFields = [hermesSigningKeysRaw, env.AEEIS_HERMES_DEBATE_ROUTES?.trim(), env.AEEIS_HERMES_SENDER_AGENTS?.trim()].filter(Boolean);
  if (hermesBridgeFields.length > 0 && !hermesSigningKeysRaw) {
    throw new Error('Hermes Debate bridge requires AEEIS_HERMES_SIGNING_KEYS');
  }
  if (hermesSigningKeysRaw) {
    let value: unknown;
    try { value = JSON.parse(hermesSigningKeysRaw); } catch { throw new Error('AEEIS_HERMES_SIGNING_KEYS must be valid JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value as object).length) throw new Error('AEEIS_HERMES_SIGNING_KEYS must be a non-empty JSON object');
    for (const [keyId, key] of Object.entries(value as Record<string, unknown>)) {
      if (!keyId.trim() || typeof key !== 'string' || key.length < 16) throw new Error('AEEIS_HERMES_SIGNING_KEYS values must be strings of at least 16 characters');
    }
    for (const [raw, label] of [[env.AEEIS_HERMES_DEBATE_ROUTES, 'AEEIS_HERMES_DEBATE_ROUTES'], [env.AEEIS_HERMES_SENDER_AGENTS, 'AEEIS_HERMES_SENDER_AGENTS']] as const) {
      if (raw === undefined) continue;
      try { JSON.parse(raw); } catch { throw new Error(`${label} must be valid JSON`); }
    }
  }

  // A signed toolkit Registry is an independent trust boundary. Validate its
  // root key before the server opens stores so a production process cannot
  // start in a state where the first tool lookup will fail unexpectedly.
  const toolkitRegistryConfigured = Boolean(env.AEEIS_TOOLKIT_REGISTRY_URL);
  const toolkitVerifySignatures = env.AEEIS_TOOLKIT_VERIFY_SIGNATURES === '1'
    || (production && env.AEEIS_TOOLKIT_VERIFY_SIGNATURES !== '0');
  if (toolkitRegistryConfigured && toolkitVerifySignatures) {
    const rawRootJwk = env.AEEIS_TOOLKIT_ROOT_PUBLIC_JWK;
    if (!rawRootJwk) throw new Error('Toolkit Registry signature verification requires AEEIS_TOOLKIT_ROOT_PUBLIC_JWK');
    let parsedRootJwk: unknown;
    try {
      parsedRootJwk = JSON.parse(rawRootJwk);
    } catch {
      throw new Error('AEEIS_TOOLKIT_ROOT_PUBLIC_JWK must be valid JSON');
    }
    if (!parsedRootJwk || typeof parsedRootJwk !== 'object' || Array.isArray(parsedRootJwk)) {
      throw new Error('AEEIS_TOOLKIT_ROOT_PUBLIC_JWK must be a JSON Web Key object');
    }
    const rootJwk = parsedRootJwk as Record<string, unknown>;
    if (rootJwk.kty !== 'OKP' || rootJwk.crv !== 'Ed25519' || typeof rootJwk.x !== 'string' || !rootJwk.x || rootJwk.d !== undefined) {
      throw new Error('AEEIS_TOOLKIT_ROOT_PUBLIC_JWK must be a public Ed25519 JWK');
    }
    try {
      createPublicKey({ key: rootJwk as any, format: 'jwk' });
    } catch {
      throw new Error('AEEIS_TOOLKIT_ROOT_PUBLIC_JWK is not a valid public JWK');
    }
  }
  if (env.AEEIS_TOOLKIT_RECONCILE_URL) {
    let reconcileUrl: URL;
    try {
      reconcileUrl = new URL(env.AEEIS_TOOLKIT_RECONCILE_URL);
    } catch {
      throw new Error('AEEIS_TOOLKIT_RECONCILE_URL must be a valid URL');
    }
    if (reconcileUrl.username || reconcileUrl.password || reconcileUrl.search || reconcileUrl.hash) {
      throw new Error('AEEIS_TOOLKIT_RECONCILE_URL must not contain credentials, query or fragment');
    }
    if (reconcileUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(reconcileUrl.hostname)) {
      throw new Error('AEEIS_TOOLKIT_RECONCILE_URL must use HTTPS except loopback');
    }
  }
  if (env.AEEIS_TOOLKIT_PINNED_TOOLS) {
    let value: unknown;
    try { value = JSON.parse(env.AEEIS_TOOLKIT_PINNED_TOOLS); } catch { throw new Error('AEEIS_TOOLKIT_PINNED_TOOLS must be valid JSON'); }
    if (!Array.isArray(value) || value.length > 20) throw new Error('AEEIS_TOOLKIT_PINNED_TOOLS must be an array with at most 20 tools');
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('AEEIS_TOOLKIT_PINNED_TOOLS entries must be objects');
      const tool = item as Record<string, unknown>;
      if (typeof tool.id !== 'string' || !tool.id.trim() || typeof tool.version !== 'string' || !tool.version.trim() || typeof tool.endpoint !== 'string') throw new Error('AEEIS_TOOLKIT_PINNED_TOOLS entries require id, version and endpoint');
      validateEndpoint(tool.endpoint, 'AEEIS_TOOLKIT_PINNED_TOOLS endpoint');
      if (tool.endpoint.startsWith('http://') && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(tool.endpoint).hostname)) throw new Error('AEEIS_TOOLKIT_PINNED_TOOLS endpoints must use HTTPS except loopback');
    }
  }
  const planpriceRouting = Boolean(env.AEEIS_PLANPRICE_URL) && !env.AEEIS_MODEL_BASE_URL;
  if (env.AEEIS_PLANPRICE_PROTOCOL !== undefined && !['compatibility', 'v1'].includes(env.AEEIS_PLANPRICE_PROTOCOL)) throw new Error('AEEIS_PLANPRICE_PROTOCOL must be compatibility or v1');
  if (planpriceRouting && production && env.AEEIS_PLANPRICE_PROTOCOL === 'v1') {
    if (!env.AEEIS_PLANPRICE_BEARER_TOKEN?.trim()) throw new Error('AEEIS_PLANPRICE_BEARER_TOKEN is required for Planprice v1 production routing');
    if (!env.AEEIS_PLANPRICE_MAPPINGS?.trim()) throw new Error('AEEIS_PLANPRICE_MAPPINGS is required for Planprice v1 production routing');
    let mappings: unknown;
    try { mappings = JSON.parse(env.AEEIS_PLANPRICE_MAPPINGS); } catch { throw new Error('AEEIS_PLANPRICE_MAPPINGS must be valid JSON'); }
    if (!Array.isArray(mappings) || mappings.length === 0) throw new Error('AEEIS_PLANPRICE_MAPPINGS must contain at least one mapping');
    for (const item of mappings) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('AEEIS_PLANPRICE_MAPPINGS entries must be objects');
      const mapping = item as Record<string, unknown>;
      for (const key of ['offeringId', 'providerId', 'channelId', 'endpointRef', 'requestModel']) if (typeof mapping[key] !== 'string' || !String(mapping[key]).trim()) throw new Error(`AEEIS_PLANPRICE_MAPPINGS entries require ${key}`);
      validateIntegrationEndpoint(String(mapping.endpointRef), 'AEEIS_PLANPRICE_MAPPINGS endpointRef');
    }
  }
  if (env.AEEIS_PLANPRICE_CACHE_TTL_MS !== undefined) {
    const cacheTtlMs = Number(env.AEEIS_PLANPRICE_CACHE_TTL_MS);
    if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) throw new Error('AEEIS_PLANPRICE_CACHE_TTL_MS must be a finite non-negative number');
  }
  parseBooleanConfigRecord(env.AEEIS_MODEL_PRIVATE_DATA_ALLOWED, 'AEEIS_MODEL_PRIVATE_DATA_ALLOWED');
  if (planpriceRouting && production) {
    let planpriceUrl: URL;
    try {
      planpriceUrl = new URL(env.AEEIS_PLANPRICE_URL!);
    } catch {
      throw new Error('AEEIS_PLANPRICE_URL must be a valid URL');
    }
    if (planpriceUrl.username || planpriceUrl.password || planpriceUrl.search || planpriceUrl.hash) throw new Error('AEEIS_PLANPRICE_URL must not contain credentials, query or fragment');
    if (planpriceUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(planpriceUrl.hostname)) throw new Error('AEEIS_PLANPRICE_URL must use HTTPS except loopback');
    const endpoints = parseConfigRecord(env.AEEIS_MODEL_PROVIDER_ENDPOINTS, 'AEEIS_MODEL_PROVIDER_ENDPOINTS');
    parseConfigRecord(env.AEEIS_MODEL_PROVIDER_KEYS, 'AEEIS_MODEL_PROVIDER_KEYS');
    validateServiceUrls(endpoints, 'AEEIS_MODEL_PROVIDER_ENDPOINTS', env.AEEIS_MODEL_PROVIDER_ALLOW_INSECURE_HTTP === '1');
    if (env.AEEIS_MODEL_PROVIDER_HEALTH_URLS) {
      const healthUrls = parseConfigRecord(env.AEEIS_MODEL_PROVIDER_HEALTH_URLS, 'AEEIS_MODEL_PROVIDER_HEALTH_URLS');
      validateServiceUrls(healthUrls, 'AEEIS_MODEL_PROVIDER_HEALTH_URLS', env.AEEIS_MODEL_PROVIDER_ALLOW_INSECURE_HTTP === '1');
    }
  }
  if (!production) return;

  if (!env.DATABASE_URL) throw new Error('Production configuration requires DATABASE_URL');
  const hasAuthentication = Boolean(env.AEEIS_ACCESS_TOKEN || env.AEEIS_PRINCIPAL_TOKENS || env.AEEIS_OIDC_ISSUER || env.AEEIS_OIDC_AUDIENCE || env.AEEIS_OIDC_JWKS_URL);
  if (!hasAuthentication) throw new Error('Production configuration requires AEEIS_ACCESS_TOKEN, AEEIS_PRINCIPAL_TOKENS, or complete OIDC authentication');
  const oidcFields = ['AEEIS_OIDC_ISSUER', 'AEEIS_OIDC_AUDIENCE', 'AEEIS_OIDC_JWKS_URL'];
  const presentOidc = oidcFields.filter(name => Boolean(env[name])).length;
  if (presentOidc !== 0 && presentOidc !== oidcFields.length) throw new Error('Production OIDC configuration requires issuer, audience, and JWKS URL together');
  if (env.AEEIS_PRINCIPAL_TOKENS && env.AEEIS_ACCESS_TOKEN) throw new Error('AEEIS_ACCESS_TOKEN and AEEIS_PRINCIPAL_TOKENS cannot both be configured');
  if (presentOidc && (env.AEEIS_ACCESS_TOKEN || env.AEEIS_PRINCIPAL_TOKENS)) throw new Error('OIDC cannot be combined with static token authentication');

  const runner = env.AEEIS_RUNNER ?? 'local';
  if (!['local', 'temporal'].includes(runner)) throw new Error(`Unsupported AEEIS_RUNNER: ${runner}`);
  if (runner === 'temporal') {
    if (!env.TEMPORAL_ADDRESS) throw new Error('Temporal production configuration requires TEMPORAL_ADDRESS');
    if (!env.AEEIS_WORKER_TOKEN) throw new Error('Temporal production configuration requires AEEIS_WORKER_TOKEN');
    if (!env.AEEIS_INTERNAL_URL) throw new Error('Temporal production configuration requires AEEIS_INTERNAL_URL');
    if (production && !env.AEEIS_TEMPORAL_WORKER_HEALTH_URL) throw new Error('Temporal production configuration requires AEEIS_TEMPORAL_WORKER_HEALTH_URL');
    if (env.AEEIS_TEMPORAL_WORKER_HEALTH_ALLOW_INSECURE_HTTP !== undefined && !['0', '1'].includes(env.AEEIS_TEMPORAL_WORKER_HEALTH_ALLOW_INSECURE_HTTP)) throw new Error('AEEIS_TEMPORAL_WORKER_HEALTH_ALLOW_INSECURE_HTTP must be 0 or 1');
    validateEndpoint(env.AEEIS_TEMPORAL_WORKER_HEALTH_URL, 'AEEIS_TEMPORAL_WORKER_HEALTH_URL', env.AEEIS_TEMPORAL_WORKER_HEALTH_ALLOW_INSECURE_HTTP === '1');
    if (production && env.AEEIS_TEMPORAL_WORKER_HEALTH_ALLOW_INSECURE_HTTP === '1') throw new Error('Production Temporal Worker health cannot use insecure HTTP');
    if (!env.AEEIS_BUILD_ID) throw new Error('Temporal production configuration requires stable AEEIS_BUILD_ID');
    if (env.AEEIS_TEMPORAL_USE_VERSIONING !== '1') throw new Error('Temporal production configuration requires AEEIS_TEMPORAL_USE_VERSIONING=1');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(env.AEEIS_BUILD_ID)) throw new Error('AEEIS_BUILD_ID must be 1-128 characters using letters, digits, ., _, :, / or -');
    const rollout = env.AEEIS_TEMPORAL_BUILD_ID_ROLLOUT ?? 'none';
    if (!['none', 'bootstrap', 'new-default', 'compatible', 'promote'].includes(rollout)) throw new Error(`Unsupported AEEIS_TEMPORAL_BUILD_ID_ROLLOUT: ${rollout}`);
    if (rollout === 'compatible' && !env.AEEIS_TEMPORAL_COMPATIBLE_WITH) throw new Error('Compatible Temporal rollout requires AEEIS_TEMPORAL_COMPATIBLE_WITH');
  }
  if (env.AEEIS_HOST === '0.0.0.0' && !env.AEEIS_PUBLIC_HOSTS) {
    throw new Error('AEEIS_PUBLIC_HOSTS is required when production listens on 0.0.0.0');
  }
}
