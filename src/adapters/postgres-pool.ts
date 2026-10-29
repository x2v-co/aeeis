import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

/**
 * Database scope for row-level security. An HTTP request with a principal runs
 * as its tenant; everything else (startup, pumps, workers, signed webhooks,
 * share links) runs as the system. Each connection checkout writes the scope
 * into `aeeis.tenant_id` / `aeeis.system`, so a query that forgot its tenant
 * filter still only sees the requester's tenant once the app connects as a role
 * that does not own the tables. A raw session that sets neither sees nothing.
 */
export type DbScope = { kind: 'tenant'; tenantId: string } | { kind: 'system' };
const storage = new AsyncLocalStorage<DbScope>();
export function withTenantScope<T>(tenantId: string, fn: () => T): T { return storage.run({ kind: 'tenant', tenantId }, fn); }
export function withSystemScope<T>(fn: () => T): T { return storage.run({ kind: 'system' }, fn); }
export function currentDbScope(): DbScope { return storage.getStore() ?? { kind: 'system' }; }

const SCOPE_SQL = "SELECT set_config('aeeis.tenant_id', $1, false), set_config('aeeis.system', $2, false)";
function scopeValues(scope: DbScope): [string, string] { return scope.kind === 'tenant' ? [scope.tenantId, 'off'] : ['', 'on']; }

/**
 * Wraps a pg.Pool: stamps the caller's scope on every checkout and routes DDL to
 * the owner role. Adapters only use connect, query and end.
 */
export class ScopedPool {
  private readonly inner: pg.Pool;
  /** Owner-role pool for migrations; missing when the app connects as the owner. */
  readonly migrationPool: pg.Pool | undefined;
  /** The login the application uses; granted DML on every table when the owner is separate. */
  readonly appRole: string | undefined;
  constructor(config: pg.PoolConfig, migrationConnectionString?: string) {
    this.inner = new pg.Pool(config);
    const user = config.user ?? (config.connectionString ? decodeURIComponent(new URL(config.connectionString).username) : '');
    this.appRole = user || process.env.PGUSER || undefined;
    this.migrationPool = migrationConnectionString ? new pg.Pool({ connectionString: migrationConnectionString, max: 2, idleTimeoutMillis: 5_000 }) : undefined;
  }
  async connect(): Promise<pg.PoolClient> {
    // Read the scope before awaiting: the client may be handed over later, from another request's release.
    const values = scopeValues(currentDbScope());
    const client = await this.inner.connect();
    try { await client.query(SCOPE_SQL, values); return client; }
    catch (error) { client.release(error as Error); throw error; }
  }
  async query(text: string | pg.QueryConfig, values?: unknown[]): Promise<pg.QueryResult> {
    const client = await this.connect();
    try { return await (values === undefined ? client.query(text as string) : client.query(text as string, values)); }
    finally { client.release(); }
  }
  async end(): Promise<void> {
    await this.inner.end();
    await this.migrationPool?.end();
  }
}

/** Every Postgres adapter builds its pool here. `AEEIS_DATABASE_MIGRATION_URL` names the owner role for DDL. */
export function createPostgresPool(connectionString: string, options: Omit<pg.PoolConfig, 'connectionString'> = {}): ScopedPool & pg.Pool {
  return new ScopedPool({ ...options, connectionString }, process.env.AEEIS_DATABASE_MIGRATION_URL || undefined) as ScopedPool & pg.Pool;
}

/** DDL runs as the owner role when one is configured. */
export function migrationPoolFor(pool: pg.Pool): pg.Pool {
  return (pool as unknown) instanceof ScopedPool && (pool as unknown as ScopedPool).migrationPool ? (pool as unknown as ScopedPool).migrationPool! : pool;
}

const visible = (tenant: string) => `current_setting('aeeis.system', true) = 'on' OR ${tenant} = current_setting('aeeis.tenant_id', true)`;
const child = (parent: string, table: string, column: string) => `current_setting('aeeis.system', true) = 'on' OR EXISTS (SELECT 1 FROM ${parent} parent WHERE parent.id = ${table}.${column})`;

/** Tables whose rows belong to one tenant, and how a row names its tenant. */
export const TENANT_POLICIES: ReadonlyArray<{ table: string; using: string }> = [
  ...['aeeis_conversations', 'aeeis_session_events', 'aeeis_run_events', 'aeeis_threads', 'aeeis_routines', 'aeeis_routine_deliveries', 'aeeis_reminders',
    'aeeis_action_policies', 'aeeis_owned_bots', 'aeeis_device_sessions', 'aeeis_room_memberships', 'aeeis_task_dispatches', 'aeeis_projection_events',
    'aeeis_competitions', 'aeeis_debates', 'aeeis_collaboration_trigger_policies', 'aeeis_collaboration_trigger_decisions', 'aeeis_global_budget_accounts',
    'aeeis_project_source_checkpoints'].map(table => ({ table, using: visible('tenant_id') })),
  ...['aeeis_rooms', 'aeeis_memories', 'aeeis_context_manifests'].map(table => ({ table, using: visible("COALESCE(tenant_id, 'local')") })),
  ...['aeeis_runs', 'aeeis_goals'].map(table => ({ table, using: visible("COALESCE(state->>'tenantId', 'local')") })),
  // Knowledge without a tenant is shared by the installation.
  { table: 'aeeis_knowledge_records', using: `tenant_id IS NULL OR ${visible('tenant_id')}` },
  { table: 'aeeis_plans', using: child('aeeis_goals', 'aeeis_plans', 'goal_id') },
  { table: 'aeeis_receipts', using: child('aeeis_plans', 'aeeis_receipts', 'plan_id') },
  { table: 'aeeis_run_shares', using: child('aeeis_runs', 'aeeis_run_shares', 'run_id') },
  { table: 'aeeis_thread_shares', using: child('aeeis_threads', 'aeeis_thread_shares', 'thread_id') },
  { table: 'aeeis_thread_followups', using: child('aeeis_threads', 'aeeis_thread_followups', 'thread_id') },
];
/** Installation-wide state: one row for everyone, or no tenant on the row. Access stays in application code. */
export const INSTALLATION_TABLES = ['aeeis_brain_state', 'aeeis_brain_embeddings', 'aeeis_agent_registry', 'aeeis_agent_registry_entries', 'aeeis_agent_registry_audit',
  'aeeis_agent_registry_reputations', 'aeeis_agent_registry_observations', 'aeeis_agent_grant_ledger', 'aeeis_agent_grant_registry', 'aeeis_change_audit',
  'aeeis_evolution_candidates', 'aeeis_evolution_activation', 'aeeis_rsi_proposal_claims', 'aeeis_run_scan_cursors', 'aeeis_knowledge_embeddings',
  'aeeis_knowledge_embedding_reindex', 'aeeis_projection_intents',
  // Wrapped data keys are useless without the master key; a save that rewrites several tenants' rows needs each tenant's key.
  'aeeis_content_keys'] as const;

/**
 * Enables row-level security on every tenant table that exists, (re)creates the
 * policy, and grants the app role plain DML. Run as the owner after all stores
 * have migrated. Idempotent.
 */
export async function applyRowLevelSecurity(client: pg.PoolClient | pg.Pool, appRole?: string): Promise<{ secured: string[] }> {
  const secured: string[] = [];
  for (const { table, using } of TENANT_POLICIES) {
    const exists = await client.query<{ name: string | null }>('SELECT to_regclass($1)::text AS name', [table]);
    if (!exists.rows[0]?.name) continue;
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await client.query(`DROP POLICY IF EXISTS aeeis_tenant ON ${table}`);
    await client.query(`CREATE POLICY aeeis_tenant ON ${table} USING (${using}) WITH CHECK (${using})`);
    secured.push(table);
  }
  if (appRole) await grantAppRole(client, appRole);
  return { secured };
}

/** Plain DML for the app role on everything the owner created; never ownership or DDL. */
export async function grantAppRole(client: pg.PoolClient | pg.Pool, appRole: string): Promise<void> {
  const role = pg.escapeIdentifier(appRole);
  const schema = pg.escapeIdentifier((await client.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0]!.schema);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
}

export interface AppRoleReport { role: string; superuser: boolean; bypassRls: boolean; ownedTables: number }
/** What the application's own login can do. A safe app role is not a superuser, cannot bypass RLS and owns no AEEIS table. */
export async function inspectAppRole(pool: pg.Pool): Promise<AppRoleReport> {
  const result = await pool.query<{ role: string; superuser: boolean; bypass: boolean; owned: string }>(`SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
    (SELECT count(*) FROM pg_tables t WHERE t.schemaname = current_schema() AND t.tableowner = current_user AND t.tablename LIKE 'aeeis\\_%') AS owned
    FROM pg_roles r WHERE r.rolname = current_user`);
  const row = result.rows[0]!;
  return { role: row.role, superuser: row.superuser, bypassRls: row.bypass, ownedTables: Number(row.owned) };
}
export function appRoleProblems(report: AppRoleReport): string[] {
  return [
    report.superuser ? `${report.role} is a superuser` : '',
    report.bypassRls ? `${report.role} can bypass row-level security` : '',
    report.ownedTables ? `${report.role} owns ${report.ownedTables} AEEIS tables` : '',
  ].filter(Boolean);
}
