import { z } from 'zod';
import type { AgentCard } from './protocol.js';

const clientConfigSchema = z.object({
  tokenUrl: z.string().url(),
  clientId: z.string().min(1).max(2000),
  clientSecret: z.string().min(1).max(10000),
  scopes: z.array(z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/).max(200)).max(100).optional(),
  authMethod: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic'),
}).strict();
export const oauthClientConfigsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/), clientConfigSchema);
export type OAuthClientConfig = z.input<typeof clientConfigSchema>;
export interface OAuthTokenProvider { token(agentId: string, card: AgentCard): Promise<string> }

const tokenSchema = z.object({
  access_token: z.string().min(1).max(10000).regex(/^[A-Za-z0-9\-._~+/]+=*$/),
  token_type: z.string().regex(/^Bearer$/i),
  expires_in: z.number().finite().nonnegative().optional(),
}).passthrough();

/** Machine-to-machine OAuth only. No refresh tokens or credentials are persisted. */
export class OAuthClientCredentialsProvider implements OAuthTokenProvider {
  private readonly configs: z.output<typeof oauthClientConfigsSchema>;
  private readonly cache = new Map<string, { token: string; usableUntil: number }>();
  private readonly requests = new Map<string, Promise<string>>();

  constructor(configs: Readonly<Record<string, OAuthClientConfig>>, private readonly timeoutMs = 15_000) {
    this.configs = oauthClientConfigsSchema.parse(configs);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('OAuth timeout must be a positive integer');
    for (const config of Object.values(this.configs)) {
      const url = new URL(config.tokenUrl);
      const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !loopback) throw new Error('OAuth token URL must use HTTPS except loopback HTTP');
      if (url.username || url.password || url.hash || url.search) throw new Error('OAuth token URL must not contain credentials, query or fragments');
    }
  }

  async token(agentId: string, card: AgentCard): Promise<string> {
    if (card.agentId !== agentId || !card.auth.includes('oauth')) throw new Error('OAuth token request does not match the Agent Card');
    const config = Object.hasOwn(this.configs, agentId) ? this.configs[agentId] : undefined;
    if (!config) throw new Error(`No OAuth client configuration for Agent ${agentId}`);
    const key = JSON.stringify([agentId, card.cardVersion, card.endpoint]);
    const cached = this.cache.get(key);
    if (cached && cached.usableUntil > Date.now()) return cached.token;
    this.cache.delete(key);
    const existing = this.requests.get(key);
    if (existing) return existing;
    const request = this.acquire(config, key).finally(() => this.requests.delete(key));
    this.requests.set(key, request);
    return request;
  }

  private async acquire(config: z.output<typeof clientConfigSchema>, key: string): Promise<string> {
    const startedAt = Date.now();
    const params = new URLSearchParams({ grant_type: 'client_credentials' });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (config.authMethod === 'client_secret_post') {
      params.set('client_id', config.clientId); params.set('client_secret', config.clientSecret);
    } else {
      // RFC 6749 §2.3.1: encode each component as form data before Basic encoding.
      const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
      headers.authorization = `Basic ${Buffer.from(`${encode(config.clientId)}:${encode(config.clientSecret)}`).toString('base64')}`;
    }
    if (config.scopes?.length) params.set('scope', config.scopes.join(' '));
    let response: Response;
    try {
      response = await fetch(config.tokenUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers, body: params });
    } catch { throw new Error('OAuth token request failed'); }
    if (!response.ok) throw new Error(`OAuth token endpoint returned HTTP ${response.status}`);
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error('OAuth token endpoint returned invalid JSON'); }
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) throw new Error('OAuth token endpoint returned an invalid Bearer token response');
    const { access_token, expires_in } = parsed.data;
    if (expires_in !== undefined) {
      const lifetime = expires_in * 1000;
      if (!Number.isFinite(lifetime) || startedAt + lifetime <= Date.now()) throw new Error('OAuth token expired before it could be used');
      const usableUntil = startedAt + lifetime - Math.min(30_000, lifetime * 0.1);
      if (usableUntil > Date.now()) this.cache.set(key, { token: access_token, usableUntil });
    }
    // An unspecified lifetime is never guessed: use once, then acquire again.
    return access_token;
  }
}
