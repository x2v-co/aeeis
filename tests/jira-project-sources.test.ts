import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { JiraProjectSourceProvider } from '../src/adapters/jira-project-sources.js';
import { projectSourceContentHash, projectSourceSyncRequestHash, projectSourceSyncResponseHash } from '../src/project-sources.js';

async function readJson(request: IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

async function withFixture(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  try { await run(`http://127.0.0.1:${address.port}/rest/api/3/search/jql`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

const issue = {
  id: '10001', key: 'AEEIS-42', self: 'https://jira.example/rest/api/3/issue/10001',
  fields: {
    summary: 'Stabilize long tasks',
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Temporal worker migration is blocked.' }] }] },
    updated: '2026-09-19T00:00:00.000+0000', status: { name: 'In Progress' }, assignee: { displayName: 'Ada' }, project: { key: 'AEEIS', name: 'AEEIS' },
  },
};

describe('Jira project source connector', () => {
  it('normalizes a Jira issue into a tenant-scoped evidence record', async () => {
    await withFixture(async (request, response) => {
      expect(request.headers.authorization).toBe('Bearer jira-token');
      const body = await readJson(request);
      expect(body).toMatchObject({ jql: 'project = \'AEEIS\' AND (Temporal)', maxResults: 5 });
      expect(body.nextPageToken).toBeUndefined();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ issues: [issue], isLast: true }));
    }, async endpoint => {
      const provider = new JiraProjectSourceProvider({ id: 'acme', endpoint, apiToken: 'jira-token', tenantId: 'team-a', projectKey: 'AEEIS', maxPageSize: 5 });
      const records = await provider.search({ query: 'Temporal', maxItems: 5, tenantId: 'team-a' });
      expect(records[0]).toMatchObject({ id: 'jira:acme:issue:AEEIS-42', source: 'jira:acme:AEEIS-42', kind: 'task', tenantId: 'team-a', classification: 'internal' });
      expect(records[0]?.content).toContain('Temporal worker migration is blocked.');
      expect(records[0]?.contentHash).toBe(projectSourceContentHash(records[0]!.content));
    });
  });

  it('persists an opaque cursor receipt and advances Jira pagination', async () => {
    let calls = 0;
    await withFixture(async (request, response) => {
      calls += 1;
      const body = await readJson(request);
      expect(body.jql).toBe("project = 'AEEIS' AND (updated >= -7d) ORDER BY updated DESC");
      if (calls === 1) {
        expect(body.nextPageToken).toBeUndefined();
        response.end(JSON.stringify({ issues: [issue], isLast: false, nextPageToken: 'jira-next-1' }));
      } else {
        expect(body.nextPageToken).toBe('jira-next-1');
        response.end(JSON.stringify({ issues: [{ ...issue, id: '10002', key: 'AEEIS-43', fields: { ...issue.fields, summary: 'Follow up' } }], isLast: true }));
      }
    }, async endpoint => {
      const provider = new JiraProjectSourceProvider({ id: 'acme', endpoint, apiToken: 'secret', tenantId: 'team-a', projectKey: 'AEEIS', maxPageSize: 10 });
      const request = { query: 'updated >= -7d ORDER BY updated DESC', maxItems: 10, tenantId: 'team-a' };
      const first = await provider.sync(request);
      expect(first.records).toHaveLength(1);
      expect(first.nextCursor).toMatch(/^jira-v1:/);
      expect(first.receipt).toMatchObject({ provider: 'jira:acme', requestHash: projectSourceSyncRequestHash(request), responseHash: projectSourceSyncResponseHash(first.records, first.nextCursor, first.receipt.update), changed: true });
      const second = await provider.sync({ ...request, cursor: first.nextCursor });
      expect(second.records).toHaveLength(1);
      expect(second.receipt.previousCursor).toBe(first.nextCursor);
      expect(second.receipt.update).toMatchObject({ mode: 'scan', complete: true });
    });
  });

  it('supports basic auth and fails closed on malformed Jira responses', async () => {
    await withFixture(async (request, response) => {
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from('ada@example.com:secret').toString('base64')}`);
      response.end(JSON.stringify({ issues: [], isLast: true }));
    }, async endpoint => {
      const provider = new JiraProjectSourceProvider({ id: 'basic', endpoint, auth: 'basic', username: 'ada@example.com', apiToken: 'secret', tenantId: 'team-a' });
      await expect(provider.search({ query: 'x', maxItems: 5, tenantId: 'team-a' })).resolves.toEqual([]);
    });
    await withFixture((_request, response) => response.end(JSON.stringify({ issues: [{ id: 'bad' }], isLast: true })), async endpoint => {
      const provider = new JiraProjectSourceProvider({ id: 'bad', endpoint, apiToken: 'secret', tenantId: 'team-a' });
      await expect(provider.search({ query: 'x', maxItems: 5, tenantId: 'team-a' })).rejects.toThrow('supported schema');
    });
  });
});
