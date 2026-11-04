import { describe,expect,it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresTaskBoardStore } from '../src/adapters/task-board-store.js';
import { PostgresSessionEventRepository } from '../src/session-events.js';
import { ChannelBoardService } from '../src/channel-board.js';
import { PostgresChannelNoiseStore } from '../src/channel-noise.js';
import { contentEncryption } from '../src/content-encryption.js';
import { isolatedPostgres } from './support/postgres.js';
import { taskBoardFixture,scope } from './support/task-board.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('PostgreSQL task board controls',() => {
  it('upgrades 006, initializes repeatedly/concurrently, serializes pools, persists audit/projection atomically and survives restart',async () => {
    const db = await isolatedPostgres(databaseUrl!), pool = new pg.Pool({ connectionString: db.url });
    const first = new PostgresTaskBoardStore(db.url), second = new PostgresTaskBoardStore(db.url);
    const previous = new PostgresChannelNoiseStore(db.url); await previous.init(); await previous.close();
    await Promise.all([first.init(),second.init()]); await first.init();
    const f = await taskBoardFixture(new PostgresSessionEventRepository(db.url),first);
    const repository = new PostgresSessionEventRepository(db.url); await repository.init();
    const { SessionEventService } = await import('../src/session-events.js');
    const competing = new ChannelBoardService(new SessionEventService(repository,f.domain),f.domain,f.read,undefined,second);
    try {
      const input = await f.input('blocked');
      const results = await Promise.allSettled([f.board.move(f.room.id,input,scope.owner,scope.tenantId),competing.move(f.room.id,{ ...input,idempotencyKey: 'second-window' },scope.owner,scope.tenantId)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const projection = (await pool.query('SELECT * FROM aeeis_task_board_controls')).rows[0];
      expect(Number(projection.version)).toBe(1); expect(projection.override_column).toBe('blocked'); expect(projection.observed_run_id).toBe(f.task.runId);
      const event = (await f.events.history(f.room.id,scope.owner,scope.tenantId)).find(event => event.id === projection.last_action_event_id)!;
      expect(event.taskAction).toMatchObject({ schemaVersion: 'channel-task-action/2',version: 1,reason: input.reason,expectedRunId: f.task.runId });
      if (contentEncryption()) expect(JSON.stringify((await pool.query('SELECT state FROM aeeis_session_events WHERE id=$1',[event.id])).rows[0])).not.toContain(input.reason);
      expect(await second.list(f.room.id,'bob',scope.tenantId)).toEqual([]); expect(await second.list(f.room.id,scope.owner,'team-b')).toEqual([]);
      expect((await competing.board(f.room.id,scope.owner,scope.tenantId)).cards[0]).toMatchObject({ column: 'blocked',version: 1 });
      f.task.status = 'failed'; f.task.runRevision = 2;
      await competing.pump(); await competing.pump();
      expect((await pool.query('SELECT override_column,version FROM aeeis_task_board_controls')).rows[0]).toMatchObject({ override_column: null,version: '2' });
      expect((await f.get()).cards[0]?.column).toBe('failed');
      f.task.status = 'succeeded'; f.task.runRevision = 3;
      await f.move('done');
      expect((await pool.query('SELECT accepted_run_id,override_column FROM aeeis_task_board_controls')).rows[0]).toMatchObject({ accepted_run_id: f.task.runId,override_column: null });
      f.task.runId = `run_${randomUUID()}`; f.task.runRevision = 0; f.task.status = 'queued';
      expect((await f.get()).cards[0]?.column).toBe('ready');
      expect((await pool.query('SELECT accepted_run_id FROM aeeis_task_board_controls')).rows[0].accepted_run_id).toBeNull();
      // Rollback only removes rebuildable tables. Audits remain readable; a
      // compatible init and bounded Room scan restore relations and controls.
      await pool.query('BEGIN; DROP TABLE aeeis_task_board_controls; DROP TABLE aeeis_room_tasks; COMMIT;');
      await first.init(); await f.board.pump(); expect(await first.list(f.room.id,scope.owner,scope.tenantId)).toHaveLength(1);
      expect((await f.get()).cards[0]?.column).toBe('ready');
      expect(Number((await pool.query('SELECT version FROM aeeis_task_board_controls')).rows[0].version)).toBe(4);
    } finally { await f.close(); await second.close(); await repository.close(); await pool.end(); await db.close(); }
  });
  it('rolls audit and projection back together when projection insert fails; retries only once',async () => {
    const db = await isolatedPostgres(databaseUrl!),pool = new pg.Pool({ connectionString: db.url });
    const f = await taskBoardFixture(new PostgresSessionEventRepository(db.url),new PostgresTaskBoardStore(db.url));
    try {
      await pool.query(`CREATE FUNCTION fail_board_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected board projection failure'; END $$;
        CREATE TRIGGER fail_board BEFORE INSERT OR UPDATE ON aeeis_task_board_controls FOR EACH ROW EXECUTE FUNCTION fail_board_projection()`);
      const input = await f.input('blocked');
      await expect(f.board.move(f.room.id,input,scope.owner,scope.tenantId)).rejects.toThrow('injected');
      expect((await f.events.history(f.room.id,scope.owner,scope.tenantId))).toHaveLength(1);
      expect((await pool.query('SELECT * FROM aeeis_task_board_controls')).rows).toEqual([]);
      await pool.query('DROP TRIGGER fail_board ON aeeis_task_board_controls');
      const result = await f.board.move(f.room.id,input,scope.owner,scope.tenantId);
      const replay = await f.board.move(f.room.id,input,scope.owner,scope.tenantId);
      expect(replay.event.id).toBe(result.event.id); expect(replay.board.cards[0]?.version).toBe(1);
    } finally { await f.close(); await pool.end(); await db.close(); }
  });
  it('rolls back a failed migration and safely retries fresh schema',async () => {
    const db = await isolatedPostgres(databaseUrl!),pool = new pg.Pool({ connectionString: db.url }),store = new PostgresTaskBoardStore(db.url);
    try {
      await pool.query('CREATE TABLE aeeis_task_board_controls(broken text)'); await expect(store.init()).rejects.toThrow();
      expect((await pool.query("SELECT to_regclass('aeeis_room_tasks') AS name")).rows[0].name).toBeNull();
      await pool.query('DROP TABLE aeeis_task_board_controls'); await store.init(); await store.init();
      expect(await store.list('room_test',scope.owner,scope.tenantId)).toEqual([]);
    } finally { await store.close(); await pool.end(); await db.close(); }
  });
});
