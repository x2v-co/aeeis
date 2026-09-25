import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { LinearProjectSourceProvider } from '../src/adapters/linear-project-sources.js';
import { projectSourceContentHash, projectSourceSyncRequestHash, projectSourceSyncResponseHash } from '../src/project-sources.js';

async function readJson(request: IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

async function withFixture(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  try { await run(`http://127.0.0.1:${address.port}/graphql`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

const issue = {
  id: 'issue-id-1', identifier: 'AEEIS-42', title: 'Stabilize long tasks',
  description: 'Temporal worker migration is blocked on deployment review.',
  updatedAt: '2026-09-19T00:00:00.000Z', url: 'https://linear.app/acme/issue/AEEIS-42',
  state: { name: 'In Progress' }, team: { id: 'team-1', key: 'AEEIS', name: 'AEEIS' }, assignee: { name: 'Ada' },
};

describe('Linear project source connector', () => {
  it('normalizes a GraphQL issue into a tenant-scoped evidence record', async () => {
    await withFixture(async (request, response) => {
      expect(request.headers.authorization).toBe('lin_api_key');
      const body = await readJson(request);
      expect(body.variables).toMatchObject({ query: 'Temporal', first: 5, after: null });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { issueSearch: { nodes: [issue], pageInfo: { hasNextPage: false, endCursor: 'cursor-1' } } } }));
    }, async endpoint => {
      const provider = new LinearProjectSourceProvider({ id: 'acme', endpoint, apiKey: 'lin_api_key', tenantId: 'team-a', maxPageSize: 5 });
      const records = await provider.search({ query: 'Temporal', maxItems: 5, tenantId: 'team-a' });
      expect(records[0]).toMatchObject({ id: 'linear:acme:issue:AEEIS-42', source: 'linear:acme:AEEIS-42', kind: 'task', tenantId: 'team-a', classification: 'internal' });
      expect(records[0]?.content).toContain('deployment review');
      expect(records[0]?.contentHash).toBe(projectSourceContentHash(records[0]!.content));
    });
  });

  it('persists a tamper-evident cursor receipt and applies team filtering', async () => {
    let calls = 0;
    await withFixture(async (request, response) => {
      calls += 1;
      const body = await readJson(request);
      expect(body.variables.after).toBeNull();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { issueSearch: { nodes: [issue, { ...issue, id: 'issue-id-2', identifier: 'OTHER-1', team: { id: 'team-2', key: 'OTHER', name: 'Other' } }], pageInfo: { hasNextPage: false, endCursor: 'cursor-1' } } } }));
    }, async endpoint => {
      const provider = new LinearProjectSourceProvider({ id: 'acme', endpoint, apiKey: 'secret', tenantId: 'team-a', teamId: 'team-1', maxPageSize: 10 });
      const request = { query: 'issue', maxItems: 10, tenantId: 'team-a' };
      const first = await provider.sync(request);
      expect(first.records).toHaveLength(1);
      expect(first.nextCursor).toMatch(/^linear-v2:/);
      expect(first.receipt).toMatchObject({ provider: 'linear:acme', requestHash: projectSourceSyncRequestHash(request), responseHash: projectSourceSyncResponseHash(first.records, first.nextCursor, first.receipt.update), changed: true });
      const second = await provider.sync({ ...request, cursor: first.nextCursor });
      expect(second.records).toHaveLength(1);
      expect(second.receipt.previousCursor).toBe(first.nextCursor);
      expect(second.receipt.changed).toBe(false);
    });
  });

  it('fails closed on GraphQL errors and malformed issue data', async () => {
    await withFixture((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ errors: [{ message: 'forbidden' }] }));
    }, async endpoint => {
      const provider = new LinearProjectSourceProvider({ id: 'acme', endpoint, apiKey: 'secret', tenantId: 'team-a' });
      await expect(provider.search({ query: 'x', maxItems: 5, tenantId: 'team-a' })).rejects.toThrow('forbidden');
    });
    await withFixture((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { issueSearch: { nodes: [{ id: 'bad' }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
    }, async endpoint => {
      const provider = new LinearProjectSourceProvider({ id: 'acme', endpoint, apiKey: 'secret', tenantId: 'team-a' });
      await expect(provider.search({ query: 'x', maxItems: 5, tenantId: 'team-a' })).rejects.toThrow('supported schema');
    });
  });
});
