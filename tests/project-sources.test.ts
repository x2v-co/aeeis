import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProjectSourceProvider, HttpProjectSourceProvider, projectSourceContentHash, projectSourceSyncRequestHash, projectSourceSyncResponseHash, type ProjectSourceRecord } from '../src/project-sources.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';

function source(input: Omit<ProjectSourceRecord, 'contentHash'>): ProjectSourceRecord {
  return { ...input, contentHash: projectSourceContentHash(input.content) };
}

async function withHttpFixture(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind to a TCP port');
  try { await run(`http://127.0.0.1:${address.port}/search`); } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

const modelRequests: ModelRequest[] = [];
const model: ModelAdapter = {
  pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'fixture/1' },
  complete: async request => { modelRequests.push(request); return { value: { summary: 'fixture', nodes: [{ id: 'one', title: 'One', instruction: 'One', dependsOn: [] }] } }; },
};

const projectPulseModel: ModelAdapter = {
  pin: { model: 'fixture-project-pulse', endpoint: 'http://127.0.0.1:1', promptVersion: 'fixture/1' },
  complete: async request => {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Produce a project pulse', nodes: [{ id: 'pulse', title: 'Project Pulse', instruction: 'Summarize the project snapshot', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Structured pulse is evidence bound', issues: [] } };
    const input = request.input as { sourceCatalog: Array<{ id: string }>; observations: unknown[] };
    const evidenceRefs = input.sourceCatalog.map(source => source.id);
    if (input.observations.length === 0) return { value: { type: 'tool', tool: 'sources.read', argument: evidenceRefs[0] } };
    return { value: {
      type: 'finish', title: 'Project Pulse', content: 'The release is blocked by the API migration.', evidenceRefs,
      artifactType: 'project-pulse/1', structured: {
        schemaVersion: 'project-pulse/1',
        progress: [], completedChanges: [], blockers: [{ text: 'The release is blocked by the API migration.', evidenceRefs }],
        risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [],
      },
    } };
  },
};
const invalidProjectPulseModel: ModelAdapter = {
  pin: { model: 'fixture-invalid-project-pulse', endpoint: 'http://127.0.0.1:1', promptVersion: 'fixture/1' },
  complete: async request => {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Produce a project pulse', nodes: [{ id: 'pulse', title: 'Project Pulse', instruction: 'Summarize', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'unused', issues: [] } };
    const input = request.input as { sourceCatalog: Array<{ id: string }>; observations: unknown[] };
    if (input.observations.length === 0) return { value: { type: 'tool', tool: 'sources.read', argument: input.sourceCatalog[0]!.id } };
    return { value: { type: 'finish', title: 'Unstructured pulse', content: 'Missing the machine-readable contract.', evidenceRefs: input.sourceCatalog.map(source => source.id) } };
  },
};

describe('Project Pulse source provider', () => {
  it('searches connector records with tenant and global visibility', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-project-sources-'));
    const path = join(directory, 'sources.json');
    await writeFile(path, JSON.stringify([
      source({ id: 'task:blocker', title: 'Blocked release', content: 'The release is blocked by the API migration.', source: 'linear:ABC-1', kind: 'task', tenantId: 'team-a', updatedAt: '2026-09-19T00:00:00.000Z' }),
      source({ id: 'code:global', title: 'Shared code convention', content: 'Use evidence references in reports.', source: 'repo:main', kind: 'code', updatedAt: '2026-09-18T00:00:00.000Z' }),
      source({ id: 'message:other', title: 'Other tenant message', content: 'Private blocker', source: 'chat:other', kind: 'message', tenantId: 'team-b', updatedAt: '2026-09-19T00:00:00.000Z' }),
    ]));
    const provider = new FileProjectSourceProvider(path);
    await expect(provider.health?.()).resolves.toMatchObject({ ready: true, detail: 'source file readable; content validated on use' });
    const hits = await provider.search({ query: 'blocked', maxItems: 8, tenantId: 'team-a' });
    expect(hits.map(item => item.id)).toEqual(['task:blocker']);
    const global = await provider.search({ query: 'evidence', maxItems: 8, tenantId: 'team-a' });
    expect(global.map(item => item.id)).toEqual(['code:global']);
  });

  it('returns a durable cursor and tamper-evident sync receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-project-source-sync-'));
    const path = join(directory, 'sources.json');
    const record = source({ id: 'task:sync', title: 'Sync blocker', content: 'The sync is blocked.', source: 'fixture:sync', kind: 'task', tenantId: 'team-a', updatedAt: '2026-09-19T00:00:00.000Z' });
    await writeFile(path, JSON.stringify([record]));
    const provider = new FileProjectSourceProvider(path);
    const request = { query: 'sync', maxItems: 8, tenantId: 'team-a' };
    const first = await provider.sync(request);
    expect(first.records).toEqual([record]);
    expect(first.receipt).toMatchObject({ schemaVersion: 'project-source-sync-receipt/1', provider: 'file', requestHash: projectSourceSyncRequestHash(request), responseHash: projectSourceSyncResponseHash(first.records, first.nextCursor, first.receipt.update), nextCursor: first.nextCursor, recordCount: 1, changed: true });
    const second = await provider.sync({ ...request, cursor: first.nextCursor });
    expect(second.records).toEqual([]);
    expect(second.receipt).toMatchObject({ previousCursor: first.nextCursor, nextCursor: first.nextCursor, recordCount: 0, changed: false });
  });

  it('adds bounded project sources to the immutable Run context', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-project-sources-runtime-'));
    const path = join(directory, 'sources.json');
    await writeFile(path, JSON.stringify([source({ id: 'task:one', title: 'One blocker', content: 'The task is blocked.', source: 'task-system:1', kind: 'task', tenantId: 'team-a', updatedAt: '2026-09-19T00:00:00.000Z' })]));
    const repository = new FileRunRepository(join(directory, 'runs')); await repository.init();
    const engine = new AgentEngine(repository, { model, projectSources: new FileProjectSourceProvider(path) });
    const run = await engine.create({ goal: 'Summarize blockers', projectSourceQuery: 'blocked', projectSourceMaxItems: 1 }, 'alice', 'team-a');
    expect(run.context.sources).toHaveLength(1);
    expect(run.context.sources[0]).toMatchObject({ id: 'task:one', source: 'task-system:1', content: 'The task is blocked.' });
    expect(run.context.projectSourceSync).toMatchObject({ schemaVersion: 'project-source-sync-receipt/1', provider: 'file', recordCount: 1, changed: true });
    await engine.advance(run.id);
    expect(modelRequests.at(-1)?.system).toContain('Project Pulse');
    await repository.close();
  });

  it('requires and persists a structured, evidence-bound Project Pulse final artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-project-pulse-artifact-'));
    const path = join(directory, 'sources.json');
    const record = source({ id: 'task:pulse', title: 'Blocked release', content: 'The release is blocked by the API migration.', source: 'linear:ABC-1', kind: 'task', tenantId: 'team-a', updatedAt: '2026-09-19T00:00:00.000Z' });
    await writeFile(path, JSON.stringify([record]));
    const repository = new FileRunRepository(join(directory, 'runs')); await repository.init();
    const engine = new AgentEngine(repository, { model: projectPulseModel, projectSources: new FileProjectSourceProvider(path) });
    try {
      const run = await engine.create({ goal: 'Summarize blockers', projectSourceQuery: 'blocked' }, 'alice', 'team-a');
      expect(await engine.advance(run.id)).toBe('needs_approval');
      const proposed = await repository.get(run.id);
      await engine.command(run.id, 'approve', { planHash: proposed.plans[0]!.hash });
      expect(await engine.advance(run.id)).toBe('running');
      expect(await engine.advance(run.id)).toBe('running');
      expect(await engine.advance(run.id)).toBe('reviewing');
      expect(await engine.advance(run.id)).toBe('succeeded');
      const completed = await repository.get(run.id);
      expect(completed.artifacts[0]).toMatchObject({ artifactType: 'project-pulse/1', structured: { schemaVersion: 'project-pulse/1' } });
      expect(completed.artifacts[0]?.structured?.blockers[0]?.evidenceRefs).toEqual(['task:pulse']);
    } finally { await repository.close(); }
  });

  it('rejects an unstructured terminal artifact when Project Pulse is enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-project-pulse-contract-'));
    const path = join(directory, 'sources.json');
    const record = source({ id: 'task:contract', title: 'Release blocker', content: 'Blocked by migration.', source: 'fixture:task', kind: 'task', tenantId: 'team-a', updatedAt: '2026-09-19T00:00:00.000Z' });
    await writeFile(path, JSON.stringify([record]));
    const repository = new FileRunRepository(join(directory, 'runs')); await repository.init();
    const engine = new AgentEngine(repository, { model: invalidProjectPulseModel, projectSources: new FileProjectSourceProvider(path) });
    try {
      const run = await engine.create({ goal: 'Summarize blockers', projectSourceQuery: 'blocker' }, 'alice', 'team-a');
      await engine.advance(run.id);
      const proposed = await repository.get(run.id);
      await engine.command(run.id, 'approve', { planHash: proposed.plans[0]!.hash });
      expect(await engine.advance(run.id)).toBe('running');
      expect(await engine.advance(run.id)).toBe('failed');
      expect((await repository.get(run.id)).error).toContain('final Project Pulse artifact');
    } finally { await repository.close(); }
  });

  it('calls a versioned HTTP connector with bearer auth and validates results', async () => {
    const record = source({ id: 'task:http', title: 'HTTP blocker', content: 'The HTTP source is blocked.', source: 'connector:http', kind: 'task', tenantId: 'team-a', updatedAt: '2026-09-19T00:00:00.000Z' });
    await withHttpFixture(async (request, response) => {
      expect(request.method).toBe('POST');
      expect(request.headers.authorization).toBe('Bearer secret');
      expect(await readJson(request)).toEqual({ schemaVersion: 'project-source-search/1', query: 'blocked', maxItems: 2, tenantId: 'team-a' });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ schemaVersion: 'project-source-results/1', records: [record] }));
    }, async url => {
      const hits = await new HttpProjectSourceProvider(url, 'secret').search({ query: 'blocked', maxItems: 2, tenantId: 'team-a' });
      expect(hits).toEqual([record]);
    });
  });

  it('supports incremental HTTP sync with a signed protocol receipt', async () => {
    const record = source({ id: 'task:sync-http', title: 'HTTP sync', content: 'Changed remotely.', source: 'connector:http-sync', kind: 'task', tenantId: 'team-a', updatedAt: '2026-09-19T00:00:00.000Z' });
    await withHttpFixture(async (request, response) => {
      const body = await readJson(request) as { schemaVersion: string; query: string; maxItems: number; tenantId: string; cursor?: string };
      expect(body.schemaVersion).toBe('project-source-sync/1');
      const nextCursor = 'remote-v2';
      const records = body.cursor === nextCursor ? [] : [record];
      const syncRequest = { query: body.query, maxItems: body.maxItems, tenantId: body.tenantId, ...(body.cursor ? { cursor: body.cursor } : {}) };
      const responseHash = projectSourceSyncResponseHash(records, nextCursor);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ schemaVersion: 'project-source-sync-results/1', records, nextCursor, receipt: { schemaVersion: 'project-source-sync-receipt/1', provider: 'fixture-http', requestHash: projectSourceSyncRequestHash(syncRequest), responseHash, ...(body.cursor ? { previousCursor: body.cursor } : {}), nextCursor, recordCount: records.length, changed: body.cursor !== nextCursor, completedAt: new Date().toISOString() } }));
    }, async url => {
      const provider = new HttpProjectSourceProvider(url);
      const first = await provider.sync({ query: 'sync', maxItems: 2, tenantId: 'team-a' });
      expect(first.nextCursor).toBe('remote-v2');
      const second = await provider.sync({ query: 'sync', maxItems: 2, tenantId: 'team-a', cursor: first.nextCursor });
      expect(second.records).toEqual([]);
      expect(second.receipt.changed).toBe(false);
    });
  });

  it('rejects non-success responses and malformed connector envelopes', async () => {
    await withHttpFixture((_request, response) => { response.statusCode = 502; response.end('upstream failed'); }, async url => {
      await expect(new HttpProjectSourceProvider(url).search({ query: '', maxItems: 1, tenantId: 'team-a' })).rejects.toThrow('HTTP 502');
    });
    await withHttpFixture((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ schemaVersion: 'wrong/1', records: [] }));
    }, async url => {
      await expect(new HttpProjectSourceProvider(url).search({ query: '', maxItems: 1, tenantId: 'team-a' })).rejects.toThrow();
    });
  });

  it('rejects connector records that cross tenant or hash boundaries', async () => {
    const record = source({ id: 'task:bad', title: 'Bad record', content: 'Private', source: 'connector:bad', kind: 'task', tenantId: 'team-b', updatedAt: '2026-09-19T00:00:00.000Z' });
    await withHttpFixture((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ schemaVersion: 'project-source-results/1', records: [record] }));
    }, async url => {
      await expect(new HttpProjectSourceProvider(url).search({ query: '', maxItems: 1, tenantId: 'team-a' })).rejects.toThrow(/outside the requested tenant/);
    });
    const tampered = { ...record, tenantId: 'team-a', contentHash: '0'.repeat(64) };
    await withHttpFixture((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ schemaVersion: 'project-source-results/1', records: [tampered] }));
    }, async url => {
      await expect(new HttpProjectSourceProvider(url).search({ query: '', maxItems: 1, tenantId: 'team-a' })).rejects.toThrow(/content hash/);
    });
  });

  it('rechecks project source classification at the Runtime boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-source-classification-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const record = source({ id: 'task:private', title: 'Private task', content: 'Private release details', source: 'fixture:private', kind: 'task', classification: 'private', tenantId: 'team-a', updatedAt: '2026-09-19T00:00:00.000Z' });
    const engine = new AgentEngine(repository, { model, projectSources: { search: async () => [record] } });
    try {
      await expect(engine.create({ goal: 'Public report', privacy: 'public', projectSourceQuery: 'release' }, 'alice', 'team-a')).rejects.toThrow('classification');
      const run = await engine.create({ goal: 'Private report', privacy: 'private', projectSourceQuery: 'release' }, 'alice', 'team-a');
      expect(run.context.sources[0]?.id).toBe(record.id);
    } finally { await repository.close(); }
  });
});
