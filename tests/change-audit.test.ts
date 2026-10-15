import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChangeAuditLog, ChangeAuditService, InMemoryChangeAuditStore, verifyChain } from '../src/change-audit.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { JsonFileStore } from '../src/adapters/json-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { BrainAccessDenied, FileBrainStore, GovernedBrain, brainBundleContentHash } from '../src/brain.js';
import { InMemoryKnowledgeProvider, makeKnowledgeRecord } from '../src/knowledge.js';

const actor = { kind: 'agent' as const, id: 'agent.test' };
const reason = { runId: 'run.test', trigger: 'verified correction' };
const input = { subjectKind: 'memory' as const, subjectId: 'memory.test', op: 'create' as const, actor, reason, before: null, after: { content: 'first' } };

describe('change audit chain', () => {
  it('hashes all metadata and snapshots, and protects stored entries from caller mutation', () => {
    const log = new ChangeAuditLog();
    const first = log.append(input);
    const second = log.append({ ...input, op: 'update', before: first.after, after: { content: 'second' } });
    expect(first).toMatchObject({ prevHash: null, actor, reason, hash: expect.stringMatching(/^[a-f0-9]{64}$/), at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(second.prevHash).toBe(first.hash);
    (first.after as { content: string }).content = 'outside mutation';
    log.list()[0]!.actor.id = 'outside actor';
    expect(log.list()[0]!.after).toEqual({ content: 'first' });
    expect(log.verifyChain(second.hash)).toBe(true);
  });
  it.each(['before', 'after', 'actor', 'reason', 'at', 'subjectId', 'op', 'prevHash', 'hash'] as const)('detects tampering with %s', field => {
    const entries = new ChangeAuditLog();
    entries.append(input);
    const changed = entries.list() as Array<Record<string, unknown>>;
    changed[0]![field] = field === 'before' || field === 'after' ? { content: 'tampered' } : 'tampered';
    expect(verifyChain(changed as never)).toBe(false);
  });
  it('detects deletion, reordering, duplicate ids and a removed suffix with a pinned head', () => {
    const log = new ChangeAuditLog();
    log.append(input); log.append(input); log.append(input);
    const entries = log.list();
    expect(verifyChain([entries[0]!, entries[2]!])).toBe(false);
    expect(verifyChain([...entries].reverse())).toBe(false);
    expect(verifyChain([entries[0]!, entries[0]!])).toBe(false);
    expect(verifyChain(entries.slice(0, -1), entries.at(-1)!.hash)).toBe(false);
  });
  it('uses canonical JSON independent of JSONB key order', () => {
    const log = new ChangeAuditLog(); log.append({ ...input, after: { z: 1, a: { y: 2, b: 3 } } });
    const reordered = log.list(); reordered[0]!.after = { a: { b: 3, y: 2 }, z: 1 };
    expect(verifyChain(reordered)).toBe(true);
  });
  it('normalizes context before hashing it', () => {
    const log = new ChangeAuditLog();
    const entry = log.append({ ...input, actor: { ...actor, id: ' agent.test ' }, reason: { runId: ' run.test ', trigger: ' verified correction ' } });
    expect(entry).toMatchObject({ actor, reason });
    expect(log.verifyChain()).toBe(true);
  });
  it('restores the selected before snapshot, records the current snapshot, and can undo rollback', async () => {
    let current: unknown = null;
    const store = new InMemoryChangeAuditStore();
    const service = new ChangeAuditService(store, { read: () => current, restore: (_entry, snapshot) => { current = snapshot; } });
    const created = await store.transaction(log => { current = input.after; return log.append(input); });
    const updated = await store.transaction(log => { const before = current; current = { content: 'second' }; return log.append({ ...input, op: 'update', before, after: current }); });
    current = { content: 'third, unselected change' };
    const rollback = await service.rollback(updated.id, { kind: 'user', id: 'owner' }, reason);
    expect(current).toEqual(input.after);
    expect(rollback).toMatchObject({ op: 'rollback', before: { content: 'third, unselected change' }, after: input.after });
    await service.rollback(rollback.id, actor, reason);
    expect(current).toEqual({ content: 'third, unselected change' });
    await service.rollback(created.id, actor, reason);
    expect(current).toBeNull();
    expect((await service.list()).slice(0, 2)).toEqual([created, updated]);
    expect(await service.verifyChain()).toBe(true);
  });
  it('rejects unknown ids and invalid context without applying a restore or appending', async () => {
    let restored = false;
    const store = new InMemoryChangeAuditStore();
    const service = new ChangeAuditService(store, { read: () => null, restore: () => { restored = true; } });
    await expect(service.rollback('missing', actor, reason)).rejects.toThrow('Unknown');
    expect(() => service.rollback('missing', actor, { trigger: 'missing task/run id' })).toThrow();
    expect(restored).toBe(false); expect(await service.list()).toEqual([]);
  });
  it('serializes concurrent appends and discards a failed transaction', async () => {
    const store = new InMemoryChangeAuditStore();
    await Promise.all(Array.from({ length: 10 }, (_, index) => store.transaction(async log => { await Promise.resolve(); log.append({ ...input, subjectId: String(index) }); })));
    await expect(store.transaction(log => { log.append(input); throw new Error('failed write'); })).rejects.toThrow('failed write');
    expect(store.list()).toHaveLength(10); expect(verifyChain(store.list())).toBe(true);
  });
});

describe.each(['memory', 'json'] as const)('%s domain memory audit', storage => {
  it('rolls back a correction atomically, then a creation, without rewriting history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-audit-domain-'));
    let store = storage === 'memory' ? new InMemoryStore() : new JsonFileStore(join(directory, 'domain.json'), { compactAfterEntries: 2 });
    if (store instanceof JsonFileStore) await store.init();
    try {
      let service = new AeeisService(store);
      const goal = await service.createGoal({ title: 'Audit' });
      const original = await service.addMemory(goal.id, { kind: 'fact', content: 'first' }, undefined, 'owner', 'local', { actor, reason });
      const created = (await service.changeAudit.list())[0]!;
      const corrected = await service.correctMemory(goal.id, original.id, { kind: 'fact', content: 'second' });
      const correction = (await service.changeAudit.list()).at(-1)!;
      await service.retractMemory(goal.id, corrected.id, 'invalid evidence');
      const retraction = (await service.changeAudit.list()).at(-1)!;
      expect(retraction.reason.trigger).toBe('invalid evidence');
      await service.changeAudit.rollback(retraction.id, actor, reason);
      expect((await service.listMemories(goal.id)).find(memory => memory.id === corrected.id)?.state).toBe('active');
      const prefix = await service.changeAudit.list();
      await service.changeAudit.rollback(correction.id, actor, reason);
      expect(await service.listMemories(goal.id)).toEqual([original]);
      expect((await service.changeAudit.list()).slice(0, prefix.length)).toEqual(prefix);
      if (store instanceof JsonFileStore) {
        await store.close(); store = new JsonFileStore(join(directory, 'domain.json')); await store.init();
        service = new AeeisService(store);
        expect(await service.listMemories(goal.id)).toEqual([original]);
      }
      await service.changeAudit.rollback(created.id, actor, reason);
      expect(await service.listMemories(goal.id)).toEqual([]);
      expect(await service.changeAudit.verifyChain()).toBe(true);
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('does not audit rejected competing corrections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-audit-conflict-'));
    const store = storage === 'memory' ? new InMemoryStore() : new JsonFileStore(join(directory, 'domain.json'));
    if (store instanceof JsonFileStore) await store.init();
    try {
      const service = new AeeisService(store), goal = await service.createGoal({ title: 'Audit' });
      const original = await service.addMemory(goal.id, { kind: 'note', content: 'first' });
      await service.correctMemory(goal.id, original.id, { kind: 'note', content: 'second' });
      await expect(service.correctMemory(goal.id, original.id, { kind: 'note', content: 'third' })).rejects.toThrow('active memory');
      expect(await service.changeAudit.list()).toHaveLength(2);
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

it.each([false, true])('does not resurrect archived memories after rollback deletion (journal replay: %s)', async replay => {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-audit-archive-')), path = join(directory, 'domain.json');
  let store = new JsonFileStore(path, { compactAfterEntries: 2 }); await store.init();
  try {
    let service = new AeeisService(store);
    const goal = await service.createGoal({ title: 'Archive' });
    await service.addMemory(goal.id, { kind: 'fact', content: 'archived' });
    const created = (await service.changeAudit.list())[0]!;
    await store.close(); store = new JsonFileStore(path); await store.init(); service = new AeeisService(store);
    await service.changeAudit.rollback(created.id, actor, reason);
    const snapshot = await readFile(path), journal = await readFile(`${path}.journal`);
    await store.close();
    if (replay) { await writeFile(path, snapshot); await writeFile(`${path}.journal`, journal); }
    store = new JsonFileStore(path); await store.init(); service = new AeeisService(store);
    expect(await service.listMemories(goal.id)).toEqual([]);
    expect(await service.changeAudit.verifyChain()).toBe(true);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

describe('Brain and knowledge mutation hooks', () => {
  const claimInput = { owner: 'owner', scope: 'task' as const, scopeRef: 'task.test', classification: 'internal' as const, kind: 'fact' as const, content: 'first', sourceRefs: ['run.test'], confidence: 1 };
  it('audits Brain creation, retraction, import and scope deletion, and restores persisted snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-audit-brain-'));
    const store = new FileBrainStore(directory); await store.init();
    try {
      const brain = await store.load(), claim = brain.addClaim(claimInput, 'owner', { actor, reason });
      brain.retract(claim.scopeRef, claim.id, 'owner');
      const retracted = brain.changeAudit.list().at(-1)!;
      brain.rollbackChange(retracted.id, 'owner', reason);
      expect(brain.read(claim.scopeRef, 'owner')).toEqual([claim]);
      brain.deleteScope(claim.scopeRef, 'owner');
      const deleted = brain.changeAudit.list().at(-1)!;
      expect(deleted.op).toBe('delete');
      brain.rollbackChange(deleted.id, 'owner', reason);
      await store.save(brain);
      const restored = await store.load();
      expect(restored.read(claim.scopeRef, 'owner')).toEqual([claim]);
      expect(restored.changeAudit.list()).toEqual(brain.changeAudit.list());
      expect(() => restored.rollbackChange(deleted.id, { id: 'owner', tenantId: 'other', roles: ['owner'] }, reason)).toThrow(BrainAccessDenied);
      restored.rollbackChange(restored.changeAudit.list()[0]!.id, 'owner', reason);
      expect(restored.read(claim.scopeRef, 'owner')).toEqual([]);
      expect(restored.changeAudit.verifyChain()).toBe(true);
      expect(GovernedBrain.fromState({ schemaVersion: 1, claims: [], grants: [], audit: [] }).changeAudit.list()).toEqual([]);
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects tampered Brain checkpoint history', () => {
    const brain = new GovernedBrain(); brain.addClaim(claimInput, 'owner');
    const state = brain.state(); state.changes![0]!.after = { content: 'tampered' };
    expect(() => GovernedBrain.fromState(state)).toThrow('chain is invalid');
  });
  it('audits imported claims once and rejects replacing file-backed history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-audit-brain-import-'));
    const store = new FileBrainStore(directory); await store.init();
    try {
      const source = new GovernedBrain(), destination = new GovernedBrain();
      source.addClaim(claimInput, 'owner');
      const claims = source.state().claims;
      const bundle = { schemaVersion: 'aeeis-brain-bundle/1', owner: 'owner', tenantId: 'local', scopeRef: 'task.test', exportedAt: new Date().toISOString(), claims, contentHash: brainBundleContentHash(claims) };
      destination.importBundle(bundle, 'owner');
      destination.importBundle(bundle, 'owner');
      expect(destination.changeAudit.list()).toHaveLength(1);
      expect(destination.changeAudit.list()[0]).toMatchObject({ op: 'create', before: null, reason: { trigger: 'brain.importBundle' } });
      await store.save(destination);
      await expect(store.save(new GovernedBrain())).rejects.toThrow('Cannot replace change audit history');
      expect((await store.load()).changeAudit.list()).toEqual(destination.changeAudit.list());
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('audits knowledge upsert/bulk/remove and restores the actual searchable record', async () => {
    const provider = new InMemoryKnowledgeProvider([]);
    const first = makeKnowledgeRecord({ id: 'knowledge.test', title: 'Audit', content: 'first', source: 'fixture', classification: 'internal', tags: [], updatedAt: new Date().toISOString() });
    await provider.upsert(first, { actor, reason });
    const created = (await provider.changeAudit.list())[0]!;
    await provider.upsertMany([makeKnowledgeRecord({ ...first, content: 'second' })]);
    const updated = (await provider.changeAudit.list()).at(-1)!;
    await provider.remove(first.id);
    const deleted = (await provider.changeAudit.list()).at(-1)!;
    expect(deleted.op).toBe('delete');
    await provider.changeAudit.rollback(deleted.id, actor, reason);
    await provider.changeAudit.rollback(updated.id, actor, reason);
    const search = () => provider.search({ query: 'first', maxItems: 10, allowedClassifications: ['internal'], audience: 'owner' });
    expect((await search())[0]?.record).toEqual(first);
    await provider.changeAudit.rollback(created.id, actor, reason);
    expect(await search()).toEqual([]);
    const count = (await provider.changeAudit.list()).length;
    await provider.remove('not-found');
    await expect(provider.upsert({ ...first, contentHash: '0'.repeat(64) })).rejects.toThrow('content hash');
    expect(await provider.changeAudit.list()).toHaveLength(count);
    expect(await provider.changeAudit.verifyChain()).toBe(true);
  });
});
