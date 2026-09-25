import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileProjectSourceCheckpointStore, FileProjectSourceProvider, ProjectSourceCheckpointConflict, makeSyncReceipt, projectSourceContentHash, projectSourceCheckpointKey, synchronizeProjectSources, type ProjectSourceRecord, type ProjectSourceUpdate } from '../src/project-sources.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter } from '../src/runtime/model.js';

const model: ModelAdapter = {
  pin: { model: 'checkpoint-fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test/1' },
  complete: async () => ({ value: { summary: 'fixture', nodes: [{ id: 'one', title: 'One', instruction: 'One', dependsOn: [] }] } }),
};
const key = { provider: 'fixture', tenantId: 'team-a', query: 'release', maxItems: 8, allowedClassifications: ['public', 'internal'] as ('public' | 'internal')[] };
function record(id = 'task:one', content = 'Release is blocked.'): ProjectSourceRecord {
  return { id, title: 'Release blocker', content, source: 'fixture:task', kind: 'task', tenantId: 'team-a', updatedAt: '2026-09-19T00:00:00.000Z', contentHash: projectSourceContentHash(content) };
}
function result(records: ProjectSourceRecord[], nextCursor: string, previousCursor?: string, update: ProjectSourceUpdate = { mode: 'snapshot' }) {
  const request = { ...key, ...(previousCursor ? { cursor: previousCursor } : {}) };
  return { records, nextCursor, receipt: makeSyncReceipt('fixture', request, records, nextCursor, update) };
}
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-project-source-checkpoint-'));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const path = join(directory, 'checkpoints.json');
  const store = new FileProjectSourceCheckpointStore(path); await store.init();
  cleanup.push(() => store.close());
  return { directory, path, store };
}

describe('Project source durable evidence checkpoints', () => {
  it('persists evidence and cursor together across reloads and rejects stale writers', async () => {
    const { path, store } = await fixture();
    await expect(new FileProjectSourceCheckpointStore(path).init()).rejects.toThrow('live writer');
    expect((await store.save(key, undefined, result([record()], 'cursor-1'))).revision).toBe(1);
    await expect(store.save(key, undefined, result([], 'cursor-2'))).rejects.toBeInstanceOf(ProjectSourceCheckpointConflict);
    await store.close();
    const reopened = new FileProjectSourceCheckpointStore(path); await reopened.init(); cleanup.push(() => reopened.close());
    expect(await reopened.get(key)).toMatchObject({ revision: 1, cursor: 'cursor-1', records: [record()] });
  });

  it('normalizes the legacy cursor save overload with a hash that includes update semantics', async () => {
    const { store } = await fixture();
    const legacyReceipt = makeSyncReceipt('fixture', key, [], 'cursor-1');
    const saved = await store.save(key, undefined, 'cursor-1', legacyReceipt);
    expect(saved).toMatchObject({ revision: 1, cursor: 'cursor-1', records: [] });
    expect(saved.receipt.update).toEqual({ mode: 'snapshot' });
  });

  it('preserves unchanged context through an actual store and runtime restart', async () => {
    const { directory, path, store } = await fixture();
    const sourcePath = join(directory, 'sources.json'); await writeFile(sourcePath, JSON.stringify([record()]));
    const repository = new FileRunRepository(join(directory, 'runs')); await repository.init(); cleanup.push(() => repository.close());
    const first = await new AgentEngine(repository, { model, projectSources: new FileProjectSourceProvider(sourcePath), projectSourceCheckpoints: store }).create({ goal: 'Summarize release', projectSourceQuery: 'release' }, 'alice', 'team-a');
    await store.close();
    const reopened = new FileProjectSourceCheckpointStore(path); await reopened.init(); cleanup.push(() => reopened.close());
    const engine = new AgentEngine(repository, { model, projectSources: new FileProjectSourceProvider(sourcePath), projectSourceCheckpoints: reopened });
    const second = await engine.create({ goal: 'Summarize release', projectSourceQuery: 'release' }, 'alice', 'team-a');
    expect(second.context.sources).toEqual(first.context.sources);
    expect(second.context.projectSourceSync).toMatchObject({ checkpointRevision: 2, changed: false, recordCount: 0, previousCursor: first.context.projectSourceSync?.nextCursor });
    expect((await repository.get(first.id)).context).toEqual(first.context);
  });

  it('reuses received evidence when Run creation fails after the checkpoint commit', async () => {
    const { directory, path, store } = await fixture();
    const sourcePath = join(directory, 'sources.json'); await writeFile(sourcePath, JSON.stringify([record()]));
    const provider = new FileProjectSourceProvider(sourcePath);
    const repository = new FileRunRepository(join(directory, 'runs')); await repository.init(); cleanup.push(() => repository.close());
    const engine = new AgentEngine(repository, { model, projectSources: provider, projectSourceCheckpoints: store });
    await expect(engine.create({ goal: 'Summarize release', projectSourceQuery: 'release', allowedTools: ['missing.tool'] }, 'alice', 'team-a')).rejects.toThrow('no toolkit gateway');
    expect(await repository.list()).toHaveLength(0);
    const scope = projectSourceCheckpointKey(provider, { query: 'release', maxItems: 8, tenantId: 'team-a' });
    expect(await store.get(scope)).toMatchObject({ revision: 1, records: [record()] });
    await store.close();
    const reopened = new FileProjectSourceCheckpointStore(path); await reopened.init(); cleanup.push(() => reopened.close());
    const retry = await new AgentEngine(repository, { model, projectSources: provider, projectSourceCheckpoints: reopened }).create({ goal: 'Summarize release', projectSourceQuery: 'release' }, 'alice', 'team-a');
    expect(retry.context.sources[0]?.content).toBe(record().content);
    expect(retry.context.projectSourceSync).toMatchObject({ recordCount: 0, checkpointRevision: 2 });
  });

  it('removes deleted records on fresh snapshots without changing earlier Run evidence', async () => {
    const { directory, store } = await fixture();
    const sourcePath = join(directory, 'sources.json');
    const provider = new FileProjectSourceProvider(sourcePath);
    const request = { query: 'release', maxItems: 8, tenantId: 'team-a' };
    await writeFile(sourcePath, JSON.stringify([record(), record('task:two')]));
    expect((await synchronizeProjectSources(provider, request, store)).records).toHaveLength(2);
    await writeFile(sourcePath, JSON.stringify([record('task:two', 'Release completed.')]));
    expect((await synchronizeProjectSources(provider, request, store)).records).toEqual([record('task:two', 'Release completed.')]);
    await writeFile(sourcePath, '[]');
    expect((await synchronizeProjectSources(provider, request, store)).records).toEqual([]);
    expect((await synchronizeProjectSources(provider, request, store)).records).toEqual([]);
  });

  it('keeps snapshots isolated by tenant, classification, query and result bound', async () => {
    const { store } = await fixture();
    await store.save(key, undefined, result([record()], 'one'));
    for (const other of [{ ...key, tenantId: 'team-b' }, { ...key, query: 'other' }, { ...key, maxItems: 1 }, { ...key, allowedClassifications: ['public'] as const }]) expect(await store.get(other)).toBeUndefined();
    await expect(store.save(key, 1, result([{ ...record(), tenantId: 'team-b' }], 'two', 'one'))).rejects.toThrow('tenant');
    await expect(store.save(key, 1, result([{ ...record(), classification: 'private' }], 'two', 'one'))).rejects.toThrow('classification');
    expect((await store.get(key))?.revision).toBe(1);
  });

  it('atomically applies delta updates and tombstones', async () => {
    const { store } = await fixture();
    await store.save(key, undefined, result([record(), record('task:two')], 'one'));
    const updated = record('task:two', 'Release finished.');
    await store.save(key, 1, result([updated], 'two', 'one', { mode: 'delta', deletedIds: ['task:one'] }));
    expect((await store.get(key))?.records).toEqual([updated]);
    const tampered = result([], 'three', 'two', { mode: 'delta', deletedIds: [] });
    tampered.receipt.update = { mode: 'delta', deletedIds: ['task:two'] };
    await expect(store.save(key, 2, tampered)).rejects.toThrow('response hash');
    expect((await store.get(key))?.records).toEqual([updated]);
  });

  it('retains unseen records until a refresh scan finishes, including across restart', async () => {
    const { store, path } = await fixture();
    await store.save(key, undefined, result([record(), record('task:removed')], 'one'));
    await store.save(key, 1, result([record('task:one', 'Release updated.')], 'page-1', 'one', { mode: 'scan', start: true, complete: false }));
    expect((await store.get(key))?.records?.map(item => item.id)).toEqual(['task:one', 'task:removed']);
    await store.close();
    const reopened = new FileProjectSourceCheckpointStore(path); await reopened.init(); cleanup.push(() => reopened.close());
    await reopened.save(key, 2, result([record('task:new')], 'done', 'page-1', { mode: 'scan', start: false, complete: true }));
    expect((await reopened.get(key))?.records?.map(item => item.id)).toEqual(['task:one', 'task:new']);
    expect((await reopened.get(key))?.scanRecords).toBeUndefined();
  });

  it('does not publish an in-memory cursor when an atomic file replacement fails', async () => {
    const { path, store } = await fixture();
    await store.save(key, undefined, result([record()], 'one'));
    await rename(path, `${path}.backup`); await mkdir(path);
    await expect(store.save(key, 1, result([], 'two', 'one'))).rejects.toThrow();
    expect(await store.get(key)).toMatchObject({ revision: 1, cursor: 'one', records: [record()] });
    await rm(path, { recursive: true }); await rename(`${path}.backup`, path);
    await store.save(key, 1, result([], 'two', 'one'));
    expect(JSON.parse(await readFile(path, 'utf8'))[0]).toMatchObject({ revision: 2, cursor: 'two', records: [] });
  });

  it('re-fetches legacy cursor-only state instead of trusting an empty context', async () => {
    const { path, directory, store } = await fixture();
    const sourcePath = join(directory, 'sources.json'); await writeFile(sourcePath, JSON.stringify([record()]));
    const provider = new FileProjectSourceProvider(sourcePath);
    const request = { query: 'release', maxItems: 8, tenantId: 'team-a' };
    const synced = await synchronizeProjectSources(provider, request, store);
    await store.close();
    const values = JSON.parse(await readFile(path, 'utf8')); delete values[0].records;
    await writeFile(path, JSON.stringify(values));
    const reopened = new FileProjectSourceCheckpointStore(path); await reopened.init(); cleanup.push(() => reopened.close());
    const restored = await synchronizeProjectSources(provider, { ...request, cursor: synced.nextCursor }, reopened);
    expect(restored.records).toEqual([record()]);
    expect(restored.receipt.previousCursor).toBeUndefined();
    expect(restored.receipt.checkpointRevision).toBe(2);
  });

  it('requires declared update semantics for durable HTTP-style adapters', async () => {
    const { store } = await fixture();
    const legacy = result([record()], 'one'); delete legacy.receipt.update;
    // Recalculate the legacy hash to distinguish unsupported semantics from tampering.
    legacy.receipt = makeSyncReceipt('fixture', key, legacy.records, legacy.nextCursor);
    await expect(store.save(key, undefined, legacy)).rejects.toThrow('explicit update semantics');
    expect(await store.get(key)).toBeUndefined();
  });

  it('rejects unchanged or incomplete continuation responses without their evidence base', async () => {
    const { store } = await fixture();
    await expect(store.save(key, undefined, result([], 'one', undefined, { mode: 'scan', start: false, complete: true }))).rejects.toThrow('saved first page');
    await store.save(key, undefined, result([record()], 'one'));
    await expect(store.save(key, 1, result([record()], 'one', 'one', { mode: 'unchanged' }))).rejects.toThrow('no records');
    expect((await store.get(key))?.revision).toBe(1);
  });
});
