#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';

const backupFile = process.argv[2] ?? process.env.AEEIS_BACKUP_FILE;
if (!backupFile) {
  console.error('Set AEEIS_BACKUP_FILE or pass a PostgreSQL custom-format backup path.');
  process.exit(1);
}
const adminDatabaseUrl = process.env.AEEIS_RESTORE_ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  console.error('Set AEEIS_RESTORE_ADMIN_DATABASE_URL to an administrative PostgreSQL URL.');
  process.exit(1);
}

const file = resolve(backupFile);
const manifestPath = resolve(process.env.AEEIS_BACKUP_MANIFEST ?? `${file}.manifest.json`);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!manifest || manifest.schemaVersion !== 'aeeis-backup-manifest/1' || manifest.format !== 'postgres-custom') {
  throw new Error('Unsupported or invalid AEEIS backup manifest');
}
if (manifest.file && resolve(manifest.file) !== file) throw new Error('Backup path does not match manifest');
if (!Number.isInteger(manifest.bytes) || manifest.bytes < 1 || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Backup manifest has invalid size or SHA-256');
const metadata = await stat(file);
if (metadata.size !== manifest.bytes) throw new Error(`Backup size mismatch: expected ${manifest.bytes}, got ${metadata.size}`);
const hash = createHash('sha256');
for await (const chunk of createReadStream(file)) hash.update(chunk);
const sha256 = hash.digest('hex');
if (sha256 !== manifest.sha256) throw new Error(`Backup SHA-256 mismatch: expected ${manifest.sha256}, got ${sha256}`);

const adminUrl = new URL(adminDatabaseUrl);
if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol)) throw new Error('AEEIS_RESTORE_ADMIN_DATABASE_URL must be a PostgreSQL URL');
const databaseName = `aeeis_restore_${new Date().toISOString().replaceAll(/[^0-9]/g, '').slice(0, 14)}_${randomBytes(4).toString('hex')}`;
const targetUrl = new URL(adminUrl);
targetUrl.pathname = `/${databaseName}`;
const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
let target;
let dropped = false;
let created = false;
try {
  await admin.query(`CREATE DATABASE ${identifier(databaseName)}`);
  created = true;
  await runPgRestore(targetUrl.toString(), file);
  target = new pg.Pool({ connectionString: targetUrl.toString(), max: 1 });
  const tables = await target.query(`
    SELECT tablename
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND tablename LIKE 'aeeis_%'
    ORDER BY tablename
  `);
  const expected = ['aeeis_runs', 'aeeis_goals', 'aeeis_plans', 'aeeis_receipts', 'aeeis_memories', 'aeeis_context_manifests'];
  const tableNames = tables.rows.map(row => row.tablename);
  const missing = expected.filter(name => !tableNames.includes(name));
  if (missing.length) throw new Error(`Restored database is missing required AEEIS tables: ${missing.join(', ')}`);
  const counts = {};
  for (const table of tableNames) {
    const result = await target.query(`SELECT count(*)::int AS count FROM ${identifier(table)}`);
    counts[table] = result.rows[0].count;
  }
  await target.end(); target = undefined;
  if (process.env.AEEIS_RESTORE_KEEP_DATABASE !== '1') {
    await admin.query(`DROP DATABASE ${identifier(databaseName)} WITH (FORCE)`);
    dropped = true;
  }
  console.log(JSON.stringify({ status: 'restored', backup: file, database: databaseName, dropped, tables: tableNames, counts }, null, 2));
} catch (error) {
  // A failed restore must not leave an orphan database, even when the caller
  // requested KEEP_DATABASE for post-success inspection.
  if (created && !dropped) {
    await admin.query(`DROP DATABASE IF EXISTS ${identifier(databaseName)} WITH (FORCE)`).catch(() => {});
    dropped = true;
  }
  throw error;
} finally {
  if (target) await target.end().catch(() => {});
  if (!dropped && process.env.AEEIS_RESTORE_KEEP_DATABASE !== '1') {
    await admin.query(`DROP DATABASE IF EXISTS ${identifier(databaseName)} WITH (FORCE)`).catch(() => {});
  }
  await admin.end();
}

function identifier(value) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  return `"${value}"`;
}

function runPgRestore(databaseUrl, file) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('pg_restore', ['--exit-on-error', '--no-owner', '--no-acl', '--dbname', databaseUrl, file], { stdio: ['ignore', 'inherit', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`pg_restore exited with status ${code ?? 'unknown'}${error.trim() ? `: ${error.trim()}` : ''}`)));
  });
}
