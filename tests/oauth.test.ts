import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import { OAuthClientCredentialsProvider } from '../src/oauth.js';
import type { AgentCard } from '../src/protocol.js';

const card: AgentCard = {
  schemaVersion: 'agent-card/1', agentId: 'agent.oauth', name: 'OAuth fixture', owner: 'fixture',
  protocols: ['aeeis-task/1'], capabilities: [], inputSchemas: [], outputSchemas: [], auth: ['oauth'],
  privacy: { dataRetention: 'none', regions: [] }, pricing: { unit: 'run' }, cardVersion: '1',
  endpoint: 'http://127.0.0.1:9999/agent',
};
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function tokenServer(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
}
function provider(tokenUrl: string, authMethod: 'client_secret_basic' | 'client_secret_post' = 'client_secret_basic') {
  return new OAuthClientCredentialsProvider({ [card.agentId]: { tokenUrl, clientId: 'client:one', clientSecret: 'secret + two', scopes: ['research', 'read'], authMethod } });
}

describe('OAuth client credentials', () => {
  it.each(['client_secret_basic', 'client_secret_post'] as const)('uses %s and coalesces concurrent acquisition', async authMethod => {
    const received: Array<{ authorization: string | undefined; params: URLSearchParams }> = [];
    const url = await tokenServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      received.push({ authorization: request.headers.authorization, params: new URLSearchParams(body) });
      response.end(JSON.stringify({ access_token: 'fixture-token', token_type: 'bearer', expires_in: 300 }));
    });
    const oauth = provider(url, authMethod);
    expect(await Promise.all(Array.from({ length: 8 }, () => oauth.token(card.agentId, card)))).toEqual(Array(8).fill('fixture-token'));
    expect(await oauth.token(card.agentId, card)).toBe('fixture-token');
    expect(received).toHaveLength(1);
    expect(received[0]!.params.get('grant_type')).toBe('client_credentials');
    expect(received[0]!.params.get('scope')).toBe('research read');
    if (authMethod === 'client_secret_basic') {
      expect(received[0]!.authorization).toBe(`Basic ${Buffer.from('client%3Aone:secret+%2B+two').toString('base64')}`);
      expect(received[0]!.params.has('client_secret')).toBe(false);
    } else {
      expect(received[0]!.authorization).toBeUndefined();
      expect(received[0]!.params.get('client_id')).toBe('client:one');
      expect(received[0]!.params.get('client_secret')).toBe('secret + two');
    }
  });

  it('never extends short lifetimes or guesses an omitted lifetime', async () => {
    let calls = 0;
    let lifetime: number | undefined = 2;
    const url = await tokenServer((_request, response) => {
      calls++;
      response.end(JSON.stringify({ access_token: `token-${calls}`, token_type: 'Bearer', ...(lifetime === undefined ? {} : { expires_in: lifetime }) }));
    });
    let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const oauth = provider(url);
    expect(await oauth.token(card.agentId, card)).toBe('token-1');
    clock += 1000;
    expect(await oauth.token(card.agentId, card)).toBe('token-1');
    clock += 1100;
    expect(await oauth.token(card.agentId, card)).toBe('token-2');
    clock += 2100; lifetime = undefined;
    expect(await oauth.token(card.agentId, card)).toBe('token-3');
    expect(await oauth.token(card.agentId, card)).toBe('token-4');
  });

  it.each([
    { access_token: 'sensitive-value', token_type: 'MAC', expires_in: 300 },
    { access_token: 'sensitive-value', expires_in: 300 },
    { access_token: 'sensitive-value', token_type: 'Bearer', expires_in: 0 },
  ])('rejects invalid or expired token responses without caching or echoing secrets', async invalid => {
    let calls = 0;
    const url = await tokenServer((_request, response) => {
      calls++; response.end(JSON.stringify(calls === 1 ? invalid : { access_token: 'recovered', token_type: 'Bearer', expires_in: 60 }));
    });
    const oauth = provider(url);
    const error = await oauth.token(card.agentId, card).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('sensitive-value');
    expect(await oauth.token(card.agentId, card)).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('rejects redirects without forwarding client credentials', async () => {
    let targetCalls = 0;
    const target = await tokenServer((_request, response) => { targetCalls++; response.end('{}'); });
    const url = await tokenServer((_request, response) => { response.writeHead(307, { location: target }); response.end(); });
    await expect(provider(url).token(card.agentId, card)).rejects.toThrow('request failed');
    expect(targetCalls).toBe(0);
  });

  it('rejects unsafe endpoint schemes and mismatched Agent identity', async () => {
    for (const endpoint of ['http://example.com/token', 'ftp://localhost/token', 'https://user:secret@example.com/token', 'https://example.com/token?secret=value']) {
      expect(() => provider(endpoint)).toThrow('OAuth token URL');
    }
    await expect(provider('https://example.com/token').token('agent.other', card)).rejects.toThrow('Agent Card');
  });
});
