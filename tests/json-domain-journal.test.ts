import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AeeisService } from '../src/application/aeeis-service.js';
import { JsonFileStore } from '../src/adapters/json-store.js';

describe('JsonFileStore journal', () => {
  it('replays committed operations after a writer disappears before compaction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-domain-journal-replay-'));
    const path = join(directory, 'domain.json');
    try {
      const first = new JsonFileStore(path, { compactAfterEntries: 1000 });
      await first.init();
      const goal = await new AeeisService(first).createGoal({ title: 'replay me' });
      expect(JSON.parse(readFileSync(path, 'utf8')).goals).toHaveLength(0);
      expect(statSync(`${path}.journal`).size).toBeGreaterThan(0);

      // Model a process crash: the OS has stopped the writer, so a new process
      // may reclaim its lock without asking the old object to compact first.
      unlinkSync(`${path}.lock`);
      const second = new JsonFileStore(path, { compactAfterEntries: 1000 });
      await second.init();
      expect((await second.getGoal(goal.id))?.title).toBe('replay me');
      await second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('truncates a partial final record and preserves earlier committed records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-domain-journal-tail-'));
    const path = join(directory, 'domain.json');
    try {
      const first = new JsonFileStore(path, { compactAfterEntries: 1000 });
      await first.init();
      const goal = await new AeeisService(first).createGoal({ title: 'valid record' });
      appendFileSync(`${path}.journal`, '{"schemaVersion":1,"seq":999');
      unlinkSync(`${path}.lock`);

      const second = new JsonFileStore(path, { compactAfterEntries: 1000 });
      await second.init();
      expect((await second.getGoal(goal.id))?.title).toBe('valid record');
      expect(readFileSync(`${path}.journal`, 'utf8')).not.toContain('seq":999');
      await second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when a committed journal sequence is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-domain-journal-gap-'));
    const path = join(directory, 'domain.json');
    try {
      const first = new JsonFileStore(path, { compactAfterEntries: 1000 });
      await first.init();
      const service = new AeeisService(first);
      const goal = await service.createGoal({ title: 'sequence gap' });
      await service.addMemory(goal.id, { kind: 'note', content: 'second operation' });
      const records = readFileSync(`${path}.journal`, 'utf8').trimEnd().split('\n');
      expect(records).toHaveLength(2);
      writeFileSync(`${path}.journal`, `${records[1]}\n`);
      unlinkSync(`${path}.lock`);

      const second = new JsonFileStore(path, { compactAfterEntries: 1000 });
      await expect(second.init()).rejects.toThrow('invalid record');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts the crash window after snapshot rename but before journal truncation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-domain-journal-compaction-crash-'));
    const path = join(directory, 'domain.json');
    try {
      const first = new JsonFileStore(path, { compactAfterEntries: 1000 });
      await first.init();
      const goal = await new AeeisService(first).createGoal({ title: 'snapshot already durable' });
      const committedRecord = readFileSync(`${path}.journal`, 'utf8');
      await first.close();
      // Recreate the stale journal left between persistSnapshot(rename) and
      // truncateJournal(ftruncate). The snapshot already contains seq=1.
      writeFileSync(`${path}.journal`, committedRecord);

      const second = new JsonFileStore(path, { compactAfterEntries: 1000 });
      await second.init();
      expect((await second.getGoal(goal.id))?.title).toBe('snapshot already durable');
      expect(statSync(`${path}.journal`).size).toBe(0);
      await second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('compacts the snapshot after a bounded number of journal entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-domain-journal-compact-'));
    const path = join(directory, 'domain.json');
    try {
      const store = new JsonFileStore(path, { compactAfterEntries: 2 });
      await store.init();
      const service = new AeeisService(store);
      const goal = await service.createGoal({ title: 'compact me' });
      await service.createPlan({ goalId: goal.id, nodes: [{ id: 'draft', title: 'Draft' }] });
      expect(existsSync(`${path}.journal`)).toBe(true);
      expect(statSync(`${path}.journal`).size).toBe(0);
      expect(JSON.parse(readFileSync(path, 'utf8')).plans).toHaveLength(1);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps receipt and memory history in versioned sidecars and loads it on demand', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-domain-history-sidecar-'));
    const path = join(directory, 'domain.json');
    try {
      const first = new JsonFileStore(path, { compactAfterEntries: 2 });
      await first.init();
      const service = new AeeisService(first);
      const goal = await service.createGoal({ title: 'sidecar goal' });
      await service.addMemory(goal.id, { kind: 'note', content: 'durable history' });
      const snapshot = JSON.parse(readFileSync(path, 'utf8')) as { receipts: unknown[]; memories: unknown[]; historyFiles?: { receipts: string; memories: string } };
      expect(snapshot.receipts).toHaveLength(0);
      expect(snapshot.memories).toHaveLength(0);
      expect(snapshot.historyFiles).toBeDefined();
      expect(existsSync(join(directory, snapshot.historyFiles!.memories))).toBe(true);
      expect((await first.getMemories(goal.id))).toHaveLength(1);
      await first.close();

      const second = new JsonFileStore(path, { compactAfterEntries: 1000 });
      await second.init();
      // Hot domain state is available without touching the history sidecar.
      expect((await second.getGoal(goal.id))?.title).toBe('sidecar goal');
      expect((await second.getMemories(goal.id))).toHaveLength(1);
      await second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('merges post-snapshot memory revisions without duplicating archived IDs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-domain-history-revision-'));
    const path = join(directory, 'domain.json');
    try {
      const first = new JsonFileStore(path, { compactAfterEntries: 2 });
      await first.init();
      const service = new AeeisService(first);
      const goal = await service.createGoal({ title: 'revision goal' });
      const memory = await service.addMemory(goal.id, { kind: 'note', content: 'old value' });
      await first.close();

      const second = new JsonFileStore(path, { compactAfterEntries: 1000 });
      await second.init();
      const service2 = new AeeisService(second);
      await service2.correctMemory(goal.id, memory.id, { kind: 'note', content: 'new value' });
      await second.close();

      const third = new JsonFileStore(path, { compactAfterEntries: 1000 });
      const restarted = new AeeisService(third);
      await third.init();
      const memories = await restarted.listMemories(goal.id);
      expect(memories).toHaveLength(2);
      expect(memories.find(item => item.id === memory.id)?.content).toBe('old value');
      expect(memories.find(item => item.supersedesId === memory.id)?.content).toBe('new value');
      expect(new Set(memories.map(item => item.id)).size).toBe(2);
      expect(memories.map(item => item.state).sort()).toEqual(['active', 'superseded']);
      await third.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('restores receipts from the history sidecar after a domain restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-domain-history-receipts-'));
    const path = join(directory, 'domain.json');
    try {
      const first = new JsonFileStore(path, { compactAfterEntries: 2 });
      await first.init();
      const service = new AeeisService(first);
      const goal = await service.createGoal({ title: 'receipt goal' });
      const plan = await service.createPlan({ goalId: goal.id, nodes: [{ id: 'draft', title: 'Draft' }] });
      const receipt = await service.transitionTask({ planId: plan.id, taskId: 'draft', transition: 'start' });
      await first.close();

      const second = new JsonFileStore(path, { compactAfterEntries: 1000 });
      await second.init();
      expect(await second.getReceipts(plan.id)).toEqual([receipt]);
      await second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
