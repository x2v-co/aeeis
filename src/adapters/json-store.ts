import { afterCollectionCursor, afterVersionCursor, decodeCollectionCursor, decodeVersionCursor, encodeCollectionCursor, encodeVersionCursor, recentFirst, scopedRecent, validateCollectionLimit, visibleRooms } from './collection-query.js';
import { isOwnedBy, type Ownership } from '../security/principal.js';
import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import type { ContextManifest, Goal, Id, MemoryEntry, Plan, ProjectionIntent, RunReceipt, Room } from '../contracts.js';
import type { AeeisStore, RoomPage } from './in-memory-store.js';
import { assertMemoryCommit, assertRoomCommit, assertTaskCommit } from './task-commit.js';

interface StoreState {
  rooms: Room[];
  goals: Goal[];
  plans: Plan[];
  receipts: RunReceipt[];
  memories: MemoryEntry[];
  manifests: ContextManifest[];
  projectionIntents: ProjectionIntent[];
  /** Sequence represented by the last compacted snapshot. */
  journalSeq?: number;
  /** Versioned cold-history files. Empty arrays in the snapshot are the hot tail. */
  historyFiles?: DomainHistoryFiles;
}

interface DomainHistoryFiles {
  seq: number;
  receipts: string;
  memories: string;
}

/**
 * Domain-level journal operations preserve the atomic Task transition while
 * avoiding a full rewrite of unrelated historical receipts and memories.
 */
type JournalOperation =
  | { kind: 'room.upsert'; room: Room; intents: ProjectionIntent[] }
  | { kind: 'goal.upsert'; goal: Goal; intents: ProjectionIntent[] }
  | { kind: 'plan.upsert'; plan: Plan; reopenedGoal?: Goal; intents: ProjectionIntent[] }
  | { kind: 'task.commit'; plan: Plan; goal?: Goal; receipt: RunReceipt; intents: ProjectionIntent[] }
  | { kind: 'receipt.append'; receipt: RunReceipt }
  | { kind: 'memory.upsert'; memory: MemoryEntry }
  | { kind: 'memory.revision'; previous: MemoryEntry; next: MemoryEntry }
  | { kind: 'manifest.upsert'; manifest: ContextManifest }
  | { kind: 'intent.dispatch'; id: Id; dispatchedAt: string };

interface JournalRecord {
  schemaVersion: 1;
  seq: number;
  operation: JournalOperation;
  checksum: string;
}

const emptyState = (): StoreState => ({
  rooms: [],
  goals: [],
  plans: [],
  receipts: [],
  memories: [],
  manifests: [],
  projectionIntents: [],
  journalSeq: 0,
});

export class JsonFileStore implements AeeisStore {
  private state: StoreState = emptyState();
  private loaded = false;
  private lockOwned = false;
  private journalSeq = 0;
  private journalEntriesSinceSnapshot = 0;
  private journalBytesSinceSnapshot = 0;
  private archivedHistory?: DomainHistoryFiles;
  private receiptsLoaded = true;
  private memoriesLoaded = true;

  public constructor(
    private readonly filePath: string,
    private readonly journalOptions: { compactAfterEntries?: number; compactAfterBytes?: number } = {},
  ) {}

  private get journalPath(): string { return `${this.filePath}.journal`; }
  private get compactAfterEntries(): number { return this.journalOptions.compactAfterEntries ?? 64; }
  private get compactAfterBytes(): number { return this.journalOptions.compactAfterBytes ?? 4 * 1024 * 1024; }

  async commitRoomCreation(room: Room, intents: ProjectionIntent[] = []): Promise<void> {
    if (this.state.rooms.some(existing => existing.id === room.id)) throw new Error('Room already exists');
    this.commit({ kind: 'room.upsert', room: structuredClone(room), intents: cloneMany(intents) });
  }

  async commitRoomUpdate(expected: Room, next: Room, intents: ProjectionIntent[] = []): Promise<void> {
    assertRoomCommit(this.state.rooms.find(room => room.id === expected.id), expected, next);
    this.commit({ kind: 'room.upsert', room: structuredClone(next), intents: cloneMany(intents) });
  }

  async getRoom(id: Id): Promise<Room | undefined> { return clone(this.state.rooms.find(room => room.id === id)); }
  async getRooms(scope?: Ownership, limit?: number, memberRoomIds?: string[]): Promise<Room[]> { return structuredClone(visibleRooms(this.state.rooms, scope, limit, memberRoomIds)); }
  async getRoomsPage(limit: number, cursor?: string): Promise<RoomPage> {
    validateCollectionLimit(limit);
    const pageCursor = decodeCollectionCursor(cursor);
    const selected = this.state.rooms.filter(room => afterCollectionCursor(room, room.updatedAt, pageCursor)).sort(recentFirst(room => room.updatedAt));
    const page = selected.slice(0, limit + 1); const hasMore = page.length > limit; const visible = hasMore ? page.slice(0, limit) : page;
    return { rooms: structuredClone(visible), ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt, id: visible.at(-1)!.id }) } : {}) };
  }

  async commitGoalCreation(goal: Goal, intents: ProjectionIntent[] = []): Promise<void> {
    this.commit({ kind: 'goal.upsert', goal: structuredClone(goal), intents: cloneMany(intents) });
  }

  async commitPlanCreation(plan: Plan, intents: ProjectionIntent[] = [], reopenGoal = false): Promise<void> {
    const goal = this.state.goals.find(item => item.id === plan.goalId);
    if (!goal) throw new Error('Plan creation references missing goal');
    if (this.state.plans.some(existing => existing.goalId === plan.goalId && existing.version === plan.version && existing.id !== plan.id)) {
      throw new Error('Plan version already exists');
    }
    const reopenedGoal = reopenGoal && goal.status !== 'active' ? { ...goal, status: 'active' as const } : undefined;
    this.commit(reopenedGoal
      ? { kind: 'plan.upsert', plan: structuredClone(plan), reopenedGoal, intents: cloneMany(intents) }
      : { kind: 'plan.upsert', plan: structuredClone(plan), intents: cloneMany(intents) });
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    // Separate instances must not overwrite each other's cached snapshots.
    // Only reclaim a lock when its owner is confirmed dead.
    try {
      const lock = openSync(`${this.filePath}.lock`, 'wx', 0o600);
      try { writeFully(lock, String(process.pid)); } finally { closeSync(lock); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(`${this.filePath}.lock`, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid domain store lock; inspect before recovery');
      try { process.kill(pid, 0); }
      catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
        unlinkSync(`${this.filePath}.lock`);
        return this.init();
      }
      throw new Error('Domain store already has a live writer');
    }
    this.lockOwned = true;
    try {
      const snapshot = { ...emptyState(), ...(JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoreState>) };
      this.state = snapshot;
      if (snapshot.historyFiles) {
        this.validateHistoryFiles(snapshot.historyFiles);
        this.archivedHistory = structuredClone(snapshot.historyFiles);
        // Only the post-snapshot journal tail belongs in memory at startup.
        // The versioned sidecars are loaded on the first history query.
        this.state = { ...snapshot, receipts: [], memories: [] };
        this.receiptsLoaded = false;
        this.memoriesLoaded = false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await this.close(); throw error; }
      this.state = emptyState();
    }
    this.journalSeq = Number.isInteger(this.state.journalSeq) && this.state.journalSeq! >= 0 ? this.state.journalSeq! : 0;
    try { this.replayJournal(); }
    catch (error) { await this.close(); throw error; }
    this.state = { ...this.state, journalSeq: this.journalSeq };
    this.loaded = true;
    // Keep the legacy canonical path present even when all current changes
    // live in the journal. This also gives operators a stable snapshot path.
    if (!existsSync(this.filePath)) this.compactSnapshot();
  }

  async saveGoal(goal: Goal): Promise<void> {
    this.commit({ kind: 'goal.upsert', goal: structuredClone(goal), intents: [] });
  }

  async getGoal(id: Id): Promise<Goal | undefined> {
    return clone(this.state.goals.find((goal) => goal.id === id));
  }

  async getGoals(scope?: Ownership, limit?: number): Promise<Goal[]> {
    return structuredClone(scopedRecent(this.state.goals, goal => goal.createdAt, scope, limit));
  }
  async getReadableGoals(scope: Ownership, memberRoomIds: readonly string[]): Promise<Goal[]> {
    const roomIds = new Set(memberRoomIds);
    return structuredClone(this.state.goals.filter(goal => isOwnedBy(goal, scope) || ((goal.tenantId ?? 'local') === scope.tenantId && goal.roomId !== undefined && roomIds.has(goal.roomId))));
  }

  async getGoalsPage(scope: Ownership, limit: number, cursor?: string) {
    validateCollectionLimit(limit);
    const pageCursor = decodeCollectionCursor(cursor);
    const selected = this.state.goals.filter(goal => isOwnedBy(goal, scope) && afterCollectionCursor(goal, goal.createdAt, pageCursor)).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const page = selected.slice(0, limit + 1); const hasMore = page.length > limit; const visible = hasMore ? page.slice(0, limit) : page;
    return { goals: structuredClone(visible), ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.createdAt, id: visible.at(-1)!.id }) } : {}) };
  }

  async savePlan(plan: Plan): Promise<void> {
    if (this.state.plans.some(existing => existing.goalId === plan.goalId && existing.version === plan.version && existing.id !== plan.id)) {
      throw new Error('Plan version already exists');
    }
    this.commit({ kind: 'plan.upsert', plan: structuredClone(plan), intents: [] });
  }

  async commitTaskTransition(expected: Plan, next: Plan, receipt: RunReceipt, intents: ProjectionIntent[] = []): Promise<void> {
    assertTaskCommit(this.state.plans.find(plan => plan.id === expected.id), expected, next, receipt);
    const goal = this.state.goals.find(item => item.id === next.goalId);
    if (!goal) throw new Error('Task commit references missing goal');
    const completedGoal = next.nodes.every(node => node.status === 'succeeded') ? { ...goal, status: 'completed' as const } : undefined;
    this.commit(completedGoal
      ? { kind: 'task.commit', plan: structuredClone(next), goal: completedGoal, receipt: structuredClone(receipt), intents: cloneMany(intents) }
      : { kind: 'task.commit', plan: structuredClone(next), receipt: structuredClone(receipt), intents: cloneMany(intents) });
  }

  async getPlan(id: Id): Promise<Plan | undefined> {
    return clone(this.state.plans.find((plan) => plan.id === id));
  }

  async getPlans(goalId?: Id): Promise<Plan[]> {
    return structuredClone(this.state.plans.filter((plan) => goalId === undefined || plan.goalId === goalId));
  }

  async getPlansPage(goalId: Id, limit: number, cursor?: string) {
    validateCollectionLimit(limit);
    const pageCursor = decodeVersionCursor(cursor);
    const selected = this.state.plans.filter(plan => plan.goalId === goalId && afterVersionCursor(plan, pageCursor)).sort((left, right) => right.version - left.version || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const page = selected.slice(0, limit + 1); const hasMore = page.length > limit; const visible = hasMore ? page.slice(0, limit) : page;
    return { plans: structuredClone(visible), ...(hasMore && visible.length ? { nextCursor: encodeVersionCursor({ version: visible.at(-1)!.version, id: visible.at(-1)!.id }) } : {}) };
  }

  async appendReceipt(receipt: RunReceipt): Promise<void> {
    this.commit({ kind: 'receipt.append', receipt: structuredClone(receipt) });
  }

  async getReceipts(planId: Id): Promise<RunReceipt[]> {
    this.loadReceiptsHistory();
    return structuredClone(this.state.receipts.filter((receipt) => receipt.planId === planId));
  }

  async saveMemory(memory: MemoryEntry): Promise<void> {
    this.loadMemoriesHistory();
    this.commit({ kind: 'memory.upsert', memory: structuredClone(memory) });
  }

  async commitMemoryUpdate(expected: MemoryEntry, next: MemoryEntry): Promise<void> {
    this.loadMemoriesHistory();
    assertMemoryCommit(this.state.memories.find(memory => memory.id === expected.id), expected, next);
    this.commit({ kind: 'memory.upsert', memory: structuredClone(next) });
  }

  async commitMemoryRevision(previous: MemoryEntry, next: MemoryEntry): Promise<void> {
    this.loadMemoriesHistory();
    assertMemoryCommit(this.state.memories.find(memory => memory.id === previous.id), previous, previous);
    if (this.state.memories.some(memory => memory.id === next.id)) throw new Error('Memory revision already exists');
    this.commit({ kind: 'memory.revision', previous: structuredClone(previous), next: structuredClone(next) });
  }

  async getMemories(goalId?: Id, limit?: number): Promise<MemoryEntry[]> {
    this.loadMemoriesHistory();
    validateCollectionLimit(limit);
    const memories = this.state.memories.filter((memory) => goalId === undefined || memory.goalId === goalId);
    if (limit !== undefined) memories.sort(recentFirst(memory => memory.updatedAt));
    return structuredClone(limit === undefined ? memories : memories.slice(0, limit));
  }

  async saveContextManifest(manifest: ContextManifest): Promise<void> {
    this.commit({ kind: 'manifest.upsert', manifest: structuredClone(manifest) });
  }

  async getContextManifest(id: Id): Promise<ContextManifest | undefined> {
    return clone(this.state.manifests.find((manifest) => manifest.id === id));
  }

  async listProjectionIntents(): Promise<ProjectionIntent[]> { return structuredClone(this.state.projectionIntents.filter(intent => intent.status === 'pending')); }

  async markProjectionIntentDispatched(id: Id, dispatchedAt = new Date().toISOString()): Promise<void> {
    if (!this.state.projectionIntents.some(item => item.id === id)) return;
    this.commit({ kind: 'intent.dispatch', id, dispatchedAt });
  }

  async close(): Promise<void> {
    let error: unknown;
    try { if (this.loaded && this.journalEntriesSinceSnapshot > 0) this.compactSnapshot(); }
    catch (caught) { error = caught; }
    finally {
      if (this.lockOwned) { unlinkSync(`${this.filePath}.lock`); this.lockOwned = false; }
      this.loaded = false;
    }
    if (error) throw error;
  }

  private commit(operation: JournalOperation): void {
    this.ensureSnapshotPathUsable();
    // Validate and stage the complete result before touching durable storage.
    // If append/fsync fails, the in-memory state remains unchanged.
    const next = applyOperation(this.state, operation);
    this.appendJournal(operation);
    this.state = { ...next, journalSeq: this.journalSeq };
    if (this.journalEntriesSinceSnapshot >= this.compactAfterEntries || this.journalBytesSinceSnapshot >= this.compactAfterBytes) this.compactSnapshot();
  }

  private appendJournal(operation: JournalOperation): void {
    const seq = this.journalSeq + 1;
    const body = { seq, operation };
    const record: JournalRecord = { schemaVersion: 1, seq, operation, checksum: checksum(body) };
    const serialized = `${JSON.stringify(record)}\n`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.journalPath, 'a', 0o600);
      writeFully(descriptor, serialized);
      fsyncSync(descriptor);
      closeSync(descriptor); descriptor = undefined;
      this.journalSeq = seq;
      this.journalEntriesSinceSnapshot += 1;
      this.journalBytesSinceSnapshot += Buffer.byteLength(serialized);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw error;
    }
  }

  private replayJournal(): void {
    if (!existsSync(this.journalPath)) return;
    const content = readFileSync(this.journalPath, 'utf8');
    let offset = 0;
    let lastValidOffset = 0;
    let entries = 0;
    let bytes = 0;
    let lastSeenSeq = 0;
    let firstAppliedSeq: number | undefined;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const lineBytes = Buffer.byteLength(line) + (index < lines.length - 1 ? 1 : 0);
      offset += lineBytes;
      if (!line) { lastValidOffset = offset; continue; }
      let record: JournalRecord;
      try { record = JSON.parse(line) as JournalRecord; }
      catch (error) {
        if (index === lines.length - 1 || lines.slice(index + 1).every(rest => rest === '')) { this.truncateJournal(lastValidOffset); break; }
        throw new Error(`Domain journal is corrupt at line ${index + 1}`, { cause: error });
      }
      const snapshotSeq = this.journalSeq;
      const sequenceIsContiguous = record.seq > snapshotSeq
        ? (firstAppliedSeq === undefined ? record.seq === snapshotSeq + 1 : record.seq === lastSeenSeq + 1)
        : record.seq === lastSeenSeq + 1 || lastSeenSeq === 0;
      if (record.schemaVersion !== 1 || !Number.isInteger(record.seq) || !sequenceIsContiguous || record.checksum !== checksum({ seq: record.seq, operation: record.operation })) {
        throw new Error(`Domain journal has invalid record at line ${index + 1}`);
      }
      lastSeenSeq = record.seq;
      lastValidOffset = offset;
      if (record.seq <= this.journalSeq) continue;
      firstAppliedSeq ??= record.seq;
      this.state = applyOperation(this.state, record.operation);
      this.journalSeq = record.seq;
      entries += 1;
      bytes += lineBytes;
    }
    if (entries === 0 && content.length > 0 && lastValidOffset === Buffer.byteLength(content)) {
      // A crash after snapshot rename but before journal truncation leaves only
      // records already represented by the snapshot. Reclaim that stale prefix
      // after validating it, so every later startup stays bounded.
      this.truncateJournal(0);
    }
    this.journalEntriesSinceSnapshot = entries;
    this.journalBytesSinceSnapshot = bytes;
  }

  private truncateJournal(length: number): void {
    const descriptor = openSync(this.journalPath, 'r+');
    try { ftruncateSync(descriptor, length); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }

  private compactSnapshot(): void {
    // Materialize cold history before publishing a snapshot that references it.
    this.loadReceiptsHistory();
    this.loadMemoriesHistory();
    const historyFiles = this.writeHistorySidecars();
    const snapshot: StoreState = {
      ...this.state,
      receipts: [],
      memories: [],
      journalSeq: this.journalSeq,
      ...(historyFiles ? { historyFiles } : {}),
    };
    this.persistSnapshot(snapshot);
    if (existsSync(this.journalPath)) {
      const descriptor = openSync(this.journalPath, 'r+');
      try { ftruncateSync(descriptor, 0); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
    this.journalEntriesSinceSnapshot = 0;
    this.journalBytesSinceSnapshot = 0;
  }

  private ensureSnapshotPathUsable(): void {
    try {
      if (statSync(this.filePath).isDirectory()) throw new Error(`Domain snapshot path is a directory: ${this.filePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private persistSnapshot(snapshot: StoreState): void {
    if (!this.loaded || !this.lockOwned) throw new Error('Domain store is not open');
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(tempPath, 'wx', 0o600);
      writeFully(descriptor, serialized);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(tempPath, this.filePath);
      // After rename, reads must match the committed file even if the directory
      // durability barrier fails. Before rename a rejected commit stays invisible.
      const directoryDescriptor = openSync(directory, 'r');
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(tempPath); } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
      }
      throw error;
    }
  }

  private loadReceiptsHistory(): void {
    if (this.receiptsLoaded) return;
    const history = this.archivedHistory;
    if (!history) { this.receiptsLoaded = true; return; }
    const records = this.readHistoryArray<RunReceipt>(history.receipts, 'receipts');
    this.state = { ...this.state, receipts: mergeHistory(records, this.state.receipts) };
    this.receiptsLoaded = true;
  }

  private loadMemoriesHistory(): void {
    if (this.memoriesLoaded) return;
    const history = this.archivedHistory;
    if (!history) { this.memoriesLoaded = true; return; }
    const records = this.readHistoryArray<MemoryEntry>(history.memories, 'memories');
    this.state = { ...this.state, memories: mergeHistory(records, this.state.memories) };
    this.memoriesLoaded = true;
  }

  private readHistoryArray<T>(fileName: string, label: string): T[] {
    const path = this.historyFilePath(fileName);
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { throw new Error(`Domain ${label} history is missing or corrupt`, { cause: error }); }
    if (!Array.isArray(value)) throw new Error(`Domain ${label} history is not an array`);
    return structuredClone(value) as T[];
  }

  private writeHistorySidecars(): DomainHistoryFiles | undefined {
    if (this.state.receipts.length === 0 && this.state.memories.length === 0) return undefined;
    const seq = this.journalSeq;
    const receipts = `${basename(this.filePath)}.history.${seq}.receipts.json`;
    const memories = `${basename(this.filePath)}.history.${seq}.memories.json`;
    this.writeHistoryFile(receipts, this.state.receipts);
    this.writeHistoryFile(memories, this.state.memories);
    const directory = dirname(this.filePath);
    const directoryDescriptor = openSync(directory, 'r');
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    return { seq, receipts, memories };
  }

  private writeHistoryFile<T>(fileName: string, value: T[]): void {
    const path = this.historyFilePath(fileName);
    const tempPath = `${path}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(value)}\n`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(tempPath, 'wx', 0o600);
      writeFully(descriptor, serialized);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(tempPath, path);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(tempPath); } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
      }
      throw error;
    }
  }

  private historyFilePath(fileName: string): string {
    if (basename(fileName) !== fileName || !fileName.startsWith(`${basename(this.filePath)}.history.`)) {
      throw new Error('Invalid domain history file reference');
    }
    return `${dirname(this.filePath)}/${fileName}`;
  }

  private validateHistoryFiles(history: DomainHistoryFiles): void {
    if (!Number.isInteger(history.seq) || history.seq < 0 || typeof history.receipts !== 'string' || typeof history.memories !== 'string') {
      throw new Error('Invalid domain history manifest');
    }
    // Fail closed before replaying a journal that may otherwise appear valid.
    this.historyFilePath(history.receipts);
    this.historyFilePath(history.memories);
    if (!existsSync(this.historyFilePath(history.receipts)) || !existsSync(this.historyFilePath(history.memories))) {
      throw new Error('Domain history sidecar is missing');
    }
  }
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function applyOperation(state: StoreState, operation: JournalOperation): StoreState {
  switch (operation.kind) {
    case 'room.upsert':
      return { ...state, rooms: replace(state.rooms, operation.room), projectionIntents: [...state.projectionIntents, ...cloneMany(operation.intents)] };
    case 'goal.upsert':
      return { ...state, goals: replace(state.goals, operation.goal), projectionIntents: [...state.projectionIntents, ...cloneMany(operation.intents)] };
    case 'plan.upsert':
      return { ...state, plans: replace(state.plans, operation.plan), goals: operation.reopenedGoal ? replace(state.goals, operation.reopenedGoal) : state.goals, projectionIntents: [...state.projectionIntents, ...cloneMany(operation.intents)] };
    case 'task.commit':
      return {
        ...state,
        plans: replace(state.plans, operation.plan),
        receipts: [...state.receipts, structuredClone(operation.receipt)],
        projectionIntents: [...state.projectionIntents, ...cloneMany(operation.intents)],
        goals: operation.goal ? replace(state.goals, operation.goal) : state.goals,
      };
    case 'receipt.append':
      return { ...state, receipts: [...state.receipts, structuredClone(operation.receipt)] };
    case 'memory.upsert':
      return { ...state, memories: replace(state.memories, operation.memory) };
    case 'memory.revision': {
      const superseded = { ...operation.previous, state: 'superseded' as const, updatedAt: operation.next.updatedAt };
      return { ...state, memories: replace(replace(state.memories, superseded), operation.next) };
    }
    case 'manifest.upsert':
      return { ...state, manifests: replace(state.manifests, operation.manifest) };
    case 'intent.dispatch':
      return { ...state, projectionIntents: state.projectionIntents.map(item => item.id === operation.id ? { ...item, status: 'dispatched', dispatchedAt: operation.dispatchedAt } : item) };
  }
}

function replace<T extends { id: Id }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, structuredClone(item)];
  return items.map((candidate, candidateIndex) =>
    candidateIndex === index ? structuredClone(item) : candidate,
  );
}

function mergeHistory<T extends { id: Id }>(base: T[], tail: T[]): T[] {
  let result = base.map(value => structuredClone(value));
  for (const value of tail) result = replace(result, value);
  return result;
}

function cloneMany<T>(values: T[]): T[] { return values.map(value => structuredClone(value)); }

function writeFully(descriptor: number, value: string | Buffer): void {
  const buffer = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = writeSync(descriptor, buffer, offset, buffer.byteLength - offset);
    if (written <= 0) throw new Error('Domain store write made no progress');
    offset += written;
  }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
