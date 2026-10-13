import type pg from 'pg';
import type { AgentRun } from './contracts.js';
import type { Thread } from './threads.js';
import { FileShareStore, InMemoryShareStore, newRunShare, type Share } from './run-shares.js';
import { redactRunData, sharedRunView } from './run-debug.js';
import { isSourceReadTool } from './source-tools.js';

export interface ThreadShare extends Share { threadId: string; throughSequence: number }
export interface ThreadShareStore {
  create(share: ThreadShare): Promise<void>;
  find(tokenHash: string): Promise<ThreadShare | undefined>;
  list(threadId: string): Promise<ThreadShare[]>;
  revoke(threadId: string, id: string, at: string): Promise<boolean>;
}
export function newThreadShare(threadId: string, throughSequence: number, ttlSeconds: number): { token: string; share: ThreadShare } {
  const { token, share: { runId: _runId, ...share } } = newRunShare(threadId, ttlSeconds);
  return { token, share: { ...share, threadId, throughSequence } };
}
export class InMemoryThreadShareStore extends InMemoryShareStore<ThreadShare> implements ThreadShareStore {
  constructor() { super((share, id) => share.threadId === id); }
}
export class FileThreadShareStore extends FileShareStore<ThreadShare> implements ThreadShareStore {
  constructor(directory: string) { super(directory, '.thread-shares.json', (share, id) => share.threadId === id); }
}
// Keep in sync with src/adapters/migrations/004-thread-shares.sql.
export const threadSharesMigration = `CREATE TABLE IF NOT EXISTS aeeis_thread_shares (
  id text PRIMARY KEY, token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  thread_id text NOT NULL REFERENCES aeeis_threads(id) ON DELETE CASCADE,
  through_sequence integer NOT NULL CHECK (through_sequence >= 0),
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS aeeis_thread_shares_thread_idx ON aeeis_thread_shares(thread_id, created_at);`;
type ShareRow = { id: string; token_hash: string; thread_id: string; through_sequence: number; expires_at: Date; revoked_at: Date | null; created_at: Date };
const fromRow = (s: ShareRow): ThreadShare => ({ id: s.id, tokenHash: s.token_hash, threadId: s.thread_id, throughSequence: s.through_sequence,
  expiresAt: s.expires_at.toISOString(), revokedAt: s.revoked_at?.toISOString() ?? null, createdAt: s.created_at.toISOString() });
export class PostgresThreadShareStore implements ThreadShareStore {
  constructor(private pool: pg.Pool) {}
  async create(s: ThreadShare): Promise<void> { await this.pool.query('INSERT INTO aeeis_thread_shares(id,token_hash,thread_id,through_sequence,expires_at,revoked_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [s.id, s.tokenHash, s.threadId, s.throughSequence, s.expiresAt, s.revokedAt, s.createdAt]); }
  async find(hash: string): Promise<ThreadShare | undefined> { const result = await this.pool.query<ShareRow>('SELECT * FROM aeeis_thread_shares WHERE token_hash=$1', [hash]); return result.rows[0] && fromRow(result.rows[0]); }
  async list(threadId: string): Promise<ThreadShare[]> { return (await this.pool.query<ShareRow>('SELECT * FROM aeeis_thread_shares WHERE thread_id=$1 ORDER BY created_at DESC', [threadId])).rows.map(fromRow); }
  async revoke(threadId: string, id: string, at: string): Promise<boolean> { return Boolean((await this.pool.query('UPDATE aeeis_thread_shares SET revoked_at=COALESCE(revoked_at,$3) WHERE thread_id=$1 AND id=$2', [threadId, id, at])).rowCount); }
}

function shareableSource(value: unknown): value is { id: string } {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  return typeof source.id === 'string' && !source.id.startsWith('history:') && !source.origin
    && source.classification !== 'private' && source.classification !== 'confidential';
}

export function sharedThreadView(thread: Thread, throughSequence: number, runs: AgentRun[]) {
  const visible = runs.filter(run => run.threadSequence! <= throughSequence && ['public', 'internal'].includes(run.privacy ?? 'internal'));
  const ids = new Set(visible.map(run => run.id));
  const views = Object.fromEntries(visible.map(run => {
    const copy = structuredClone(run);
    // History is owner evidence, including ancestry outside this share's view.
    delete copy.context.threadHistory;
    copy.context.sources = copy.context.sources.filter(shareableSource);
    const sourceIds = new Set(copy.context.sources.map(source => source.id));
    const visibleResult = (result: unknown) => shareableSource(result) && sourceIds.has(result.id);
    // Source tools copy history and restricted content into durable observations.
    // Search results lack origin metadata, so also require a retained catalog ID.
    for (const step of copy.steps) step.observations = step.observations.flatMap(observation => {
      if (isSourceReadTool(observation.tool)) return visibleResult(observation.result) ? [observation] : [];
      if (observation.tool === 'sources.search') {
        if (!Array.isArray(observation.result)) return [];
        const result = observation.result.filter(visibleResult);
        if (observation.result.length && !result.length) return [];
        return [{ ...observation, result }];
      }
      return [observation];
    });
    if (copy.parentRunId && !ids.has(copy.parentRunId)) delete copy.parentRunId;
    return [run.id, sharedRunView(copy)];
  }));
  // Preserve all runs (the debug redactor caps arrays) and collect credentials
  // from every run, including omitted fields, before redacting copied prose.
  const redacted = redactRunData({
    kind: 'thread' as const, thread: { id: thread.id, ...(thread.title ? { title: thread.title } : {}), createdAt: thread.createdAt }, throughSequence, runs: views,
  }, { credentialSource: Object.fromEntries(runs.map(run => [run.id, run])), omitRawProviderText: true });
  return { ...redacted, runs: Object.values(redacted.runs) };
}
