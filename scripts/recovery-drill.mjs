#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import pg from 'pg';

const backupFile = process.argv[2] ?? process.env.AEEIS_BACKUP_FILE;
const adminDatabaseUrl = process.env.AEEIS_RESTORE_ADMIN_DATABASE_URL;
if (!backupFile) throw new Error('Set AEEIS_BACKUP_FILE or pass a PostgreSQL custom-format backup path.');
if (!adminDatabaseUrl) throw new Error('Set AEEIS_RESTORE_ADMIN_DATABASE_URL to an administrative PostgreSQL URL.');

const timeoutMs = Number(process.env.AEEIS_RECOVERY_TIMEOUT_MS ?? 60_000);
const restore = await run(process.execPath, [resolve('scripts/restore-postgres.mjs')], {
  env: {
    ...process.env,
    AEEIS_BACKUP_FILE: resolve(backupFile),
    AEEIS_RESTORE_ADMIN_DATABASE_URL: adminDatabaseUrl,
    AEEIS_RESTORE_KEEP_DATABASE: '1',
  },
});
const restored = JSON.parse(restore.stdout.trim());
if (restored.status !== 'restored' || !restored.database) throw new Error(`Restore did not return a temporary database: ${restore.stdout}`);

const adminUrl = new URL(adminDatabaseUrl);
const restoredUrl = new URL(adminUrl); restoredUrl.pathname = `/${restored.database}`;
const preflight = new pg.Pool({ connectionString: adminDatabaseUrl, max: 1 });
let preflightClosed = false;
try {
  const exists = await preflight.query('SELECT 1 FROM pg_database WHERE datname=$1', [restored.database]);
  if (!exists.rowCount) throw new Error(`Restore reported ${restored.database}, but the temporary database is not present`);
} catch (error) {
  await preflight.end().catch(() => {}); preflightClosed = true;
  await dropDatabase(adminDatabaseUrl, restored.database).catch(() => {});
  throw error;
} finally { if (!preflightClosed) await preflight.end(); }
const apiPort = await freePort();
const modelPort = await freePort();
const dataDirectory = await mkdtemp(join(tmpdir(), 'aeeis-recovery-drill-'));
let modelProcess;
let apiProcess;
const startedAt = Date.now();
try {
  modelProcess = startProcess(process.execPath, [resolve('scripts/fixture-model.mjs')], {
    env: { ...process.env, AEEIS_FIXTURE_MODEL_HOST: '127.0.0.1', AEEIS_FIXTURE_MODEL_PORT: String(modelPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHttp(`http://127.0.0.1:${modelPort}/health`, modelProcess, timeoutMs, 'fixture model');
  apiProcess = startProcess(process.execPath, [resolve('dist/server.js')], {
    env: {
      ...process.env,
      PORT: String(apiPort), AEEIS_HOST: '127.0.0.1', AEEIS_DATA_DIR: dataDirectory,
      DATABASE_URL: restoredUrl.toString(), AEEIS_RUNNER: 'local',
      AEEIS_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, AEEIS_MODEL: 'aeeis-recovery-fixture/1',
      AEEIS_MODEL_HEALTH_URL: `http://127.0.0.1:${modelPort}/health`, AEEIS_MODEL_ALLOW_INSECURE_HTTP: '1',
      AEEIS_ACCESS_TOKEN: '', AEEIS_WORKER_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const readiness = await waitForReady(`http://127.0.0.1:${apiPort}/readyz`, apiProcess, timeoutMs);
  console.log(JSON.stringify({ status: 'passed', database: restored.database, restoredTables: restored.tables.length, restoredCounts: restored.counts, readiness, elapsedMs: Date.now() - startedAt }, null, 2));
} finally {
  await stop(apiProcess);
  await stop(modelProcess);
  await dropDatabase(adminDatabaseUrl, restored.database);
  await rm(dataDirectory, { recursive: true, force: true });
}

async function waitForReady(url, child, limit) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`AEEIS exited before readiness: ${childOutput(child)}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      if (response.ok && body.status === 'ready') return body;
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Timed out waiting for AEEIS readiness: ${childOutput(child)}`);
}

async function waitForHttp(url, child, limit, label) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited: ${childOutput(child)}`);
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
  }
  throw new Error(`Timed out waiting for ${label}: ${childOutput(child)}`);
}

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`)));
  });
}

function childOutput(child) {
  return `${child?.aeeisStdout ?? ''}${child?.aeeisStderr ?? ''}`.slice(-4000);
}

function startProcess(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  child.aeeisStdout = ''; child.aeeisStderr = '';
  child.stdout.on('data', chunk => { child.aeeisStdout += chunk.toString(); });
  child.stderr.on('data', chunk => { child.aeeisStderr += chunk.toString(); });
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolvePromise => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolvePromise(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
  });
}

async function dropDatabase(connectionString, databaseName) {
  if (!/^aeeis_restore_[a-z0-9_]+$/.test(databaseName)) throw new Error(`Refusing to drop unexpected recovery database: ${databaseName}`);
  const pool = new pg.Pool({ connectionString, max: 1 });
  try { await pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
  finally { await pool.end(); }
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolvePromise(address.port)); });
  });
}
