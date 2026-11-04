import { PostgresTaskBoardStore } from '../src/adapters/task-board-store.js';
import { PostgresBotDialogueStore, type BotDialogue } from '../src/bot-dialogues.js';
import { PostgresChannelNoiseStore } from '../src/channel-noise.js';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostgresConversationStore } from '../src/adapters/conversation-store.js';
import { PostgresAeeisStore } from '../src/adapters/postgres-store.js';
import { createPostgresPool, withSystemScope, withTenantScope } from '../src/adapters/postgres-pool.js';
import { backfillContent, plaintextCounts } from '../src/content-backfill.js';
import { configureContentEncryption, contentEncryption } from '../src/content-encryption.js';
import type { Conversation } from '../src/conversations.js';
import { prepareDatabaseSecurity } from '../src/database-security.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { buildApp } from '../src/runtime/http.js';
import { materialContentHash } from '../src/runtime/materials.js';
import type { ModelRequest } from '../src/runtime/model.js';
import { PostgresRunRepository } from '../src/runtime/repository.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!().catch(() => undefined); });

const SECRET = { material: `SECRET-MATERIAL-${randomUUID()}`, conversation: `SECRET-CONVERSATION-${randomUUID()}`, memory: `SECRET-MEMORY-${randomUUID()}` };
const model = { pin: { model: 'rls-fixture', endpoint: 'http://localhost', promptVersion: 'rls/1' }, complete: vi.fn(async (request: ModelRequest) => {
  if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Summarize', nodes: [{ id: 'summarize', title: 'Summarize', instruction: 'Summarize the material', dependsOn: [] }] } };
  throw new Error('not needed');
}) };

/** An owner schema plus a separate login that owns nothing, the way production runs. */
async function splitRoles() {
  const db = await isolatedPostgres(databaseUrl!);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const role = `aeeis_app_${randomBytes(6).toString('hex')}`, password = randomBytes(12).toString('hex');
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  const appUrl = new URL(db.url); appUrl.username = role; appUrl.password = password;
  const previous = process.env.AEEIS_DATABASE_MIGRATION_URL;
  process.env.AEEIS_DATABASE_MIGRATION_URL = db.url;
  cleanup.push(async () => {
    if (previous === undefined) delete process.env.AEEIS_DATABASE_MIGRATION_URL; else process.env.AEEIS_DATABASE_MIGRATION_URL = previous;
    await db.close();
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });
  return { ownerUrl: db.url, appUrl: appUrl.toString() };
}

function conversation(tenantId: string, owner: string, text: string): Conversation {
  const at = new Date().toISOString();
  return { schemaVersion: 'conversation/1', id: `conv_${randomUUID()}`, owner, tenantId, title: 'AEEIS', revision: 0, createdAt: at, updatedAt: at, recentTaskIds: [], tasks: [],
    messages: [{ id: `message_${randomUUID()}`, keyHash: 'a'.repeat(64), requestHash: 'b'.repeat(64), role: 'user', text, createdAt: at, route: { status: 'general', reason: 'unassigned', taskIds: [], candidateTaskIds: [], focusEffect: 'keep' } }] };
}

async function dump(url: string): Promise<string> {
  const pool = new pg.Pool({ connectionString: url });
  try {
    const tables = await pool.query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()");
    const parts: string[] = [];
    for (const { name } of tables.rows) parts.push(...(await pool.query<{ row: string }>(`SELECT t::text AS row FROM ${pg.escapeIdentifier(name)} t`)).rows.map(row => row.row));
    return parts.join('\n');
  } finally { await pool.end(); }
}

describe('PostgreSQL row-level security and content encryption', () => {
  it.skipIf(!databaseUrl)('keeps tenants apart in the database, seals content, and keeps every hash', async () => {
    const { ownerUrl, appUrl } = await splitRoles();
    const env = { DATABASE_URL: appUrl, AEEIS_CONTENT_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
    const security = await prepareDatabaseSecurity(env);
    cleanup.push(async () => { configureContentEncryption(undefined); await security.close(); });
    const runs = new PostgresRunRepository(appUrl); await runs.init();
    const conversations = new PostgresConversationStore(appUrl); await conversations.init();
    const domain = new PostgresAeeisStore(appUrl); await domain.init();
    cleanup.push(async () => { await runs.close(); await conversations.close(); await domain.close(); });
    const noise = new PostgresChannelNoiseStore(appUrl); await noise.init();
    cleanup.push(() => noise.close());
    const dialogues = new PostgresBotDialogueStore(appUrl); await dialogues.init();
    cleanup.push(() => dialogues.close());
    const taskBoards = new PostgresTaskBoardStore(appUrl); await taskBoards.init(); cleanup.push(() => taskBoards.close());
    const { secured } = await security.finalize();
    expect(secured).toContain('aeeis_channel_noise_settings');
    const dialogueTables = ['aeeis_bot_dialogues', 'aeeis_bot_dialogue_room_aliases', 'aeeis_bot_dialogue_operations'];
    expect(secured).toEqual(expect.arrayContaining(dialogueTables));
    const dialogueAt = new Date().toISOString();
    const binding: BotDialogue = { tenantId: 'team-a', owner: 'alice', botId: 'bot-a', conversationId: 'conversation-a', roomId: 'room-a', phase: 'ready', version: 1, createdAt: dialogueAt, updatedAt: dialogueAt, state: { roomIds: [], revision: 0, highWater: {} } };
    await withTenantScope('team-a', async () => {
      await dialogues.put(binding);
      await dialogues.alias({ tenantId: 'team-a', owner: 'alice', botId: 'bot-a', aliasRoomId: 'old-a', canonicalRoomId: 'room-a' });
      await dialogues.operation({ tenantId: 'team-a', owner: 'alice', botId: 'bot-a', operationKey: 'ensure:a', sourceId: 'bot-a', targetId: 'room-a', kind: 'ensure', status: 'pending', state: {} });
    });
    expect(await withTenantScope('team-b', () => dialogues.list(binding))).toEqual([]);
    expect(await withTenantScope('team-b', () => dialogues.aliases(binding))).toEqual([]);
    expect(await withTenantScope('team-b', () => dialogues.operations(binding))).toEqual([]);
    expect(await withSystemScope(() => dialogues.list(binding))).toHaveLength(1);
    await expect(withTenantScope('team-b', () => dialogues.put(binding))).rejects.toThrow(/row-level security/);
    const scopedPool = createPostgresPool(appUrl); cleanup.push(() => scopedPool.end());
    for (const table of dialogueTables) {
      const original = await withTenantScope('team-a', () => scopedPool.query(`SELECT * FROM ${table}`));
      expect(original.rows).toHaveLength(1);
      expect((await withTenantScope('team-b', () => scopedPool.query(`SELECT * FROM ${table}`))).rows).toHaveLength(0);
      await expect(withTenantScope('team-a', () => scopedPool.query(`UPDATE ${table} SET tenant_id='team-b'`))).rejects.toThrow(/row-level security/);
      // Raw INSERT tests exercise WITH CHECK for every table, independent of service WHERE clauses.
      await expect(withTenantScope('team-b', () => scopedPool.query(`INSERT INTO ${table} SELECT * FROM json_populate_record(NULL::${table}, $1::json)`, [JSON.stringify(original.rows[0])]))).rejects.toThrow(/row-level security/);
    }

    const boardTables = ['aeeis_room_tasks','aeeis_task_board_controls'];
    expect(secured).toEqual(expect.arrayContaining(boardTables));
    await withTenantScope('team-a',async () => {
      await taskBoards.link({ tenantId: 'team-a',owner: 'alice',roomId: 'room-board',conversationId: 'conv-board',taskId: 'task-board',sourceId: 'source-board' });
      await scopedPool.query(`INSERT INTO aeeis_task_board_controls(tenant_id,owner,room_id,conversation_id,task_id) VALUES('team-a','alice','room-board','conv-board','task-board')`);
    });
    for (const table of boardTables) {
      const original = await withTenantScope('team-a',() => scopedPool.query(`SELECT * FROM ${table}`)); expect(original.rows).toHaveLength(1);
      expect((await withTenantScope('team-b',() => scopedPool.query(`SELECT * FROM ${table}`))).rows).toHaveLength(0);
      expect((await withSystemScope(() => scopedPool.query(`SELECT * FROM ${table}`))).rows).toHaveLength(1);
      await expect(withTenantScope('team-a',() => scopedPool.query(`UPDATE ${table} SET tenant_id='team-b'`))).rejects.toThrow(/row-level security/);
      await expect(withTenantScope('team-b',() => scopedPool.query(`INSERT INTO ${table} SELECT * FROM json_populate_record(NULL::${table},$1::json)`,[JSON.stringify(original.rows[0])]))).rejects.toThrow(/row-level security/);
    }
    expect(await withTenantScope('team-a',() => taskBoards.list('room-board','bob','team-a'))).toEqual([]);
    const appPrivileges = await scopedPool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(appPrivileges.rows[0]).toEqual({ rolsuper: false,rolbypassrls: false });

    const channel = { roomId: 'room.noise', owner: 'alice', tenantId: 'team-a' };
    await withTenantScope('team-a', () => noise.put(channel, { mode: 'lively', digestMinutes: 25 }));
    expect(await withTenantScope('team-a', () => noise.get(channel))).toMatchObject({ mode: 'lively', digestMinutes: 25 });
    expect(await withTenantScope('team-b', () => noise.get(channel))).toMatchObject({ mode: 'quiet', digestMinutes: 15 });
    await expect(withTenantScope('team-b', () => noise.put(channel, { mode: 'quiet' }))).rejects.toThrow(/row-level security/);
    expect(secured).toEqual(expect.arrayContaining(['aeeis_runs', 'aeeis_conversations', 'aeeis_memories', 'aeeis_run_events', 'aeeis_goals', 'aeeis_threads']));

    // Tenant A's content goes in through the normal paths.
    const engine = new AgentEngine(runs, model);
    const created = await withTenantScope('team-a', () => engine.create({ goal: 'Summarize', materials: [{ title: 'notes.md', content: SECRET.material, source: 'upload' }] }, 'alice', 'team-a'));
    expect(await withTenantScope('team-a', () => engine.advance(created.id))).toBe('needs_approval');
    const proposed = await withTenantScope('team-a', () => runs.get(created.id));
    const a = conversation('team-a', 'alice', SECRET.conversation);
    await withTenantScope('team-a', () => conversations.create(a));
    const at = new Date().toISOString();
    await withTenantScope('team-a', () => domain.saveMemory({ id: `memory_${randomUUID()}`, owner: 'alice', tenantId: 'team-a', kind: 'fact', scope: 'project', content: SECRET.memory, source: 'test', confidence: 1, version: 1, state: 'active', createdAt: at, updatedAt: at }));
    await withTenantScope('team-b', () => conversations.create(conversation('team-b', 'bob', 'tenant b note')));

    // Hashes are computed on plaintext before sealing and survive the round trip; the exact plan approval still works.
    const source = proposed.context.sources.find(item => item.content === SECRET.material)!;
    expect(source.contentHash).toBe(materialContentHash(SECRET.material));
    expect(proposed.context.manifestHash).toBe(created.context.manifestHash);
    expect(proposed.plans[0]!.hash).toMatch(/^[a-f0-9]{64}$/);
    const approved = await withTenantScope('team-a', () => engine.command(created.id, 'approve', { planHash: proposed.plans[0]!.hash, planVersion: proposed.plans[0]!.version }));
    expect(approved.approval).toMatchObject({ approved: true, planHash: proposed.plans[0]!.hash });

    // A raw session as the app role that never set a tenant sees nothing.
    const raw = new pg.Client({ connectionString: appUrl }); await raw.connect();
    try {
      for (const table of ['aeeis_runs', 'aeeis_conversations', 'aeeis_memories', 'aeeis_run_events']) expect(Number((await raw.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n), table).toBe(0);
    } finally { await raw.end(); }

    // Queries without a tenant filter still only return the caller's tenant.
    expect((await withTenantScope('team-b', () => runs.list())).map(run => run.id)).toEqual([]);
    expect((await withTenantScope('team-a', () => runs.list())).map(run => run.id)).toEqual([created.id]);
    expect((await withTenantScope('team-b', () => domain.getMemories())).length).toBe(0);
    expect((await withTenantScope('team-a', () => domain.getMemories())).map(memory => memory.content)).toEqual([SECRET.memory]);
    await expect(withTenantScope('team-b', () => conversations.get(a.id, { owner: 'alice', tenantId: 'team-a' }))).rejects.toThrow('Unknown conversation');
    await expect(withTenantScope('team-b', () => conversations.create(conversation('team-a', 'mallory', 'cross-tenant write')))).rejects.toThrow(/row-level security/);
    expect((await withSystemScope(() => runs.list())).length).toBe(1);

    // Through HTTP: a handler that forgot its tenant filter only sees the requester's tenant.
    const app = buildApp({ repository: runs, conversationStore: conversations, principalTokens: { a: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, b: { id: 'bob', tenantId: 'team-b', roles: ['owner'] } } });
    app.post('/api/rls-probe', async () => ({ runs: (await runs.list()).map(run => run.id) }));
    cleanup.push(() => app.close());
    const probe = (token: string) => app.inject({ method: 'POST', url: '/api/rls-probe', headers: { host: '127.0.0.1:4323', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: { any: 'body' } });
    expect((await probe('b')).json()).toEqual({ runs: [] });
    expect((await probe('a')).json()).toEqual({ runs: [created.id] });

    // The dump has none of the plaintext; the stores still read it back.
    const everything = await dump(ownerUrl);
    for (const secret of Object.values(SECRET)) expect(everything).not.toContain(secret);
    expect(everything).toContain('aeeis-enc/1:');
    expect((await withTenantScope('team-a', () => conversations.get(a.id, { owner: 'alice', tenantId: 'team-a' }))).messages[0]!.text).toBe(SECRET.conversation);
  }, 60_000);

  it.skipIf(!databaseUrl)('seals rows written before the key existed, and still reads both forms meanwhile', async () => {
    const { ownerUrl, appUrl } = await splitRoles();
    const plain = await prepareDatabaseSecurity({ DATABASE_URL: appUrl });
    configureContentEncryption(undefined);
    const runs = new PostgresRunRepository(appUrl); await runs.init();
    const conversations = new PostgresConversationStore(appUrl); await conversations.init();
    cleanup.push(async () => { await runs.close(); await conversations.close(); await plain.close(); configureContentEncryption(undefined); });
    await plain.finalize();
    const engine = new AgentEngine(runs, model);
    const run = await engine.create({ goal: 'Summarize', materials: [{ title: 'notes.md', content: SECRET.material, source: 'upload' }] }, 'alice', 'team-a');
    const old = conversation('team-a', 'alice', SECRET.conversation);
    await conversations.create(old);
    expect(await dump(ownerUrl)).toContain(SECRET.material);

    const security = await prepareDatabaseSecurity({ DATABASE_URL: appUrl, AEEIS_CONTENT_ENCRYPTION_KEY: randomBytes(32).toString('hex') });
    cleanup.push(() => security.close());
    expect(contentEncryption()).toBeDefined();
    // Dual read: the plaintext row is still readable with the key configured.
    expect((await runs.get(run.id)).context.sources.some(source => source.content === SECRET.material)).toBe(true);
    const pool = new pg.Pool({ connectionString: appUrl });
    cleanup.push(() => pool.end());
    await pool.query("SELECT set_config('aeeis.system', 'on', false)");
    expect(Object.values(await plaintextCounts(pool)).some(count => count > 0)).toBe(true);
    expect(await security.backfill(() => false)).toBeGreaterThan(0);
    expect(Object.values(await plaintextCounts(pool)).every(count => count === 0)).toBe(true);
    expect(await dump(ownerUrl)).not.toContain(SECRET.material);
    expect(await dump(ownerUrl)).not.toContain(SECRET.conversation);
    expect((await runs.get(run.id)).context.sources.find(source => source.content === SECRET.material)?.contentHash).toBe(materialContentHash(SECRET.material));
    expect((await conversations.get(old.id, { owner: 'alice', tenantId: 'team-a' })).messages[0]!.text).toBe(SECRET.conversation);
    expect(await backfillContent(pool)).toBe(0);
  }, 60_000);

  it.skipIf(!databaseUrl)('refuses a production start when the app logs in as the table owner', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    cleanup.push(() => db.close());
    const security = await prepareDatabaseSecurity({ DATABASE_URL: db.url, AEEIS_ENV: 'production', AEEIS_CONTENT_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    cleanup.push(async () => { configureContentEncryption(undefined); await security.close(); });
    const runs = new PostgresRunRepository(db.url); await runs.init();
    cleanup.push(() => runs.close());
    await expect(security.finalize()).rejects.toThrow(/owns \d+ AEEIS tables|superuser/);
    const singleNode = await prepareDatabaseSecurity({ DATABASE_URL: db.url, AEEIS_ENV: 'production', AEEIS_ALLOW_UNENCRYPTED_SINGLE_NODE: '1' });
    cleanup.push(() => singleNode.close());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(singleNode.finalize()).resolves.toMatchObject({ secured: expect.arrayContaining(['aeeis_runs']) });
    expect(warn.mock.calls.flat().join('\n')).toContain('row-level security is not enforced');
    warn.mockRestore();
  }, 60_000);
});
