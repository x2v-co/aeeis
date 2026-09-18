import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** Each test owns a generated schema; no application tables are truncated. */
export async function isolatedPostgres(connectionString: string) {
  const schema = `aeeis_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  try { await admin.query(`CREATE SCHEMA "${schema}"`); }
  catch (error) { await admin.end(); throw error; }
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return {
    url: url.toString(),
    async close() {
      try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await admin.end(); }
    },
  };
}
