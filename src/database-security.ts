import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { appRoleProblems, applyRowLevelSecurity, createPostgresPool, inspectAppRole, migrationPoolFor } from './adapters/postgres-pool.js';
import { backfillContent } from './content-backfill.js';
import { ContentCipher, PostgresContentKeyStore, configureContentEncryption, contentKeysMigration, parseMasterKey } from './content-encryption.js';

export interface DatabaseSecurity {
  /** Content encryption for the stores, when a key is configured and the stores are PostgreSQL. */
  cipher: ContentCipher | undefined;
  /** After every store has migrated: row-level security, the app-role check and the final warnings. */
  finalize(): Promise<{ secured: string[] }>;
  /** Seals rows written before the key existed, in batches, until done or stopped. */
  backfill(stop: () => boolean): Promise<number>;
  close(): Promise<void>;
}

function production(env: NodeJS.ProcessEnv): boolean {
  return env.AEEIS_ENV !== undefined ? env.AEEIS_ENV === 'production' : env.NODE_ENV === 'production';
}

/**
 * Called before any store opens, so nothing is written in plaintext once a key
 * is configured. `AEEIS_ALLOW_UNENCRYPTED_SINGLE_NODE=1` lets a one-owner
 * production node start without a key or a separate app role, with a warning
 * on every start.
 */
export async function prepareDatabaseSecurity(env: NodeJS.ProcessEnv = process.env): Promise<DatabaseSecurity> {
  const singleNode = env.AEEIS_ALLOW_UNENCRYPTED_SINGLE_NODE === '1';
  const keyText = env.AEEIS_CONTENT_ENCRYPTION_KEY?.trim();
  if (!env.DATABASE_URL) {
    if (keyText) console.warn('WARNING: AEEIS_CONTENT_ENCRYPTION_KEY applies to PostgreSQL stores. File stores under AEEIS_DATA_DIR stay plaintext; protect that directory with disk encryption.');
    else console.warn('WARNING: content at rest is not encrypted (File stores). Use disk encryption for AEEIS_DATA_DIR, or PostgreSQL with AEEIS_CONTENT_ENCRYPTION_KEY_FILE.');
    configureContentEncryption(undefined);
    return { cipher: undefined, finalize: async () => ({ secured: [] }), backfill: async () => 0, close: async () => undefined };
  }
  const pool = createPostgresPool(env.DATABASE_URL, { max: 2 });
  let cipher: ContentCipher | undefined;
  try {
    if (keyText) {
      await withPostgresMigrationLock(pool, 'content-keys', async client => { await client.query(contentKeysMigration); });
      const previous = (env.AEEIS_CONTENT_ENCRYPTION_PREVIOUS_KEYS ?? '').split(/[\s,]+/).filter(Boolean).map(parseMasterKey);
      cipher = new ContentCipher(parseMasterKey(keyText), new PostgresContentKeyStore(pool), previous);
    } else {
      console.warn(`WARNING: content at rest is not encrypted. Set AEEIS_CONTENT_ENCRYPTION_KEY_FILE${singleNode ? '' : ' before storing user content'}.`);
    }
  } catch (error) { await pool.end(); throw error; }
  configureContentEncryption(cipher);
  return {
    cipher,
    async finalize() {
      const split = migrationPoolFor(pool) !== pool;
      const appRole = split ? pool.appRole : undefined;
      let secured: string[] = [];
      await withPostgresMigrationLock(pool, 'row-level-security', async client => { secured = (await applyRowLevelSecurity(client, appRole)).secured; });
      const problems = appRoleProblems(await inspectAppRole(pool));
      if (problems.length) {
        const message = `DATABASE_URL must log in as a role that row-level security applies to: ${problems.join('; ')}. Create a login role without table ownership and keep the owner in AEEIS_DATABASE_MIGRATION_URL.`;
        if (production(env) && !singleNode) throw new Error(message);
        console.warn(`WARNING: row-level security is not enforced. ${message}`);
      }
      return { secured };
    },
    backfill: stop => cipher ? backfillContent(pool, { batch: 100, pauseMs: 200, stop }) : Promise.resolve(0),
    close: () => pool.end(),
  };
}
