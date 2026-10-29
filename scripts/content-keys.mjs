#!/usr/bin/env node
// Content encryption operations against DATABASE_URL (run with the API's own environment).
//
//   npm run content:keys -- status     rows still in plaintext, per table
//   npm run content:keys -- backfill   seal every plaintext row now (the API also does this in the background)
//   npm run content:keys -- rewrap     rewrap every tenant data key with the current master key
//
// Rotation: put the new key in AEEIS_CONTENT_ENCRYPTION_KEY_FILE, the old one in
// AEEIS_CONTENT_ENCRYPTION_PREVIOUS_KEYS_FILE, run `rewrap`, then drop the old key.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = path => import(join(root, 'dist', path));
const [command] = process.argv.slice(2);
if (!['status', 'backfill', 'rewrap'].includes(command)) {
  console.error('Usage: npm run content:keys -- status | backfill | rewrap');
  process.exit(2);
}
const { loadFileEnvironment } = await dist('config-secrets.js');
loadFileEnvironment();
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }
if (command !== 'status' && !process.env.AEEIS_CONTENT_ENCRYPTION_KEY) { console.error('AEEIS_CONTENT_ENCRYPTION_KEY_FILE is required'); process.exit(2); }

const { prepareDatabaseSecurity } = await dist('database-security.js');
const { plaintextCounts, backfillContent } = await dist('content-backfill.js');
const { createPostgresPool } = await dist('adapters/postgres-pool.js');
const security = await prepareDatabaseSecurity(process.env);
const pool = createPostgresPool(process.env.DATABASE_URL, { max: 2 });
try {
  if (command === 'status') {
    const counts = await plaintextCounts(pool);
    for (const [name, count] of Object.entries(counts)) console.log(`${String(count).padStart(8)}  ${name}`);
    console.log(security.cipher ? 'encryption: configured' : 'encryption: not configured');
  } else if (command === 'backfill') {
    const sealed = await backfillContent(pool, { batch: 200, onProgress: total => console.log(`sealed ${total}`) });
    console.log(`done: ${sealed} rows sealed`);
  } else {
    const result = await security.cipher.rewrap();
    console.log(`rewrapped ${result.rewrapped} data keys; ${result.current} already used the current master key (${security.cipher.currentMasterId})`);
  }
} finally {
  await pool.end();
  await security.close();
}
