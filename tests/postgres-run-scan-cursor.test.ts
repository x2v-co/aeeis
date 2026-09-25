import { describe, expect, it, vi } from 'vitest';
import { PostgresRunRepository } from '../src/runtime/repository.js';
import { PostgresRunScanCursorStore, RunEventScanner } from '../src/run-scan-cursor.js';
import { isolatedPostgres } from './support/postgres.js';
import { runScanContract } from './support/run-scan-contract.js';
import { runWithSignals } from './support/rsi-proposal.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('PostgreSQL durable Run event scanner', () => {
  runScanContract(async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const f = {
      runs: new PostgresRunRepository(db.url), cursors: new PostgresRunScanCursorStore(db.url),
      async restart() {
        await f.runs.close(); await f.cursors.close();
        f.runs = new PostgresRunRepository(db.url); f.cursors = new PostgresRunScanCursorStore(db.url);
        await f.runs.init(); await f.cursors.init();
      },
      async close() { await f.runs.close(); await f.cursors.close(); await db.close(); },
    };
    await f.runs.init(); await f.cursors.init(); return f;
  });

  it('admits only one concurrent checkpoint writer across database connections', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresRunScanCursorStore(db.url), second = new PostgresRunScanCursorStore(db.url);
    try {
      await Promise.all([first.init(), second.init()]);
      const result = await Promise.all([first.advance('rsi', 0, {}), second.advance('rsi', 0, {})]);
      expect(result.filter(Boolean)).toHaveLength(1);
      expect((await first.get('rsi')).revision).toBe(1);
      const later = await Promise.all([first.advance('rsi', 1, {}), second.advance('rsi', 1, {})]);
      expect(later.filter(Boolean)).toHaveLength(1);
      expect((await second.get('rsi')).revision).toBe(2);
    } finally { await first.close(); await second.close(); await db.close(); }
  });

  it('scans the event projection and loads canonical state only for non-empty Runs', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const runs = new PostgresRunRepository(db.url), cursors = new PostgresRunScanCursorStore(db.url);
    await runs.init(); await cursors.init();
    try {
      const withEvents = runWithSignals(); withEvents.id = 'run_00000000-0000-4000-8000-000000000001';
      const empty = runWithSignals(); empty.id = 'run_00000000-0000-4000-8000-000000000002'; empty.events = [];
      await runs.create(withEvents); await runs.create(empty);
      const fullScan = vi.spyOn(runs, 'scanPage').mockRejectedValue(new Error('Full aggregate scan forbidden'));
      const get = vi.spyOn(runs, 'get');
      const scanner = new RunEventScanner(runs, cursors, 'projection', 10, { useEventProjection: true });
      const batch = await scanner.batch(10);
      expect(batch.entries).toHaveLength(2);
      expect(get).toHaveBeenCalledTimes(1);
      expect(fullScan).not.toHaveBeenCalled();
      await batch.commit();
    } finally { await runs.close(); await cursors.close(); await db.close(); }
  });
});
