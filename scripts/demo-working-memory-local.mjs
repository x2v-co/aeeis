#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const apiPort = Number(process.env.AEEIS_WORKING_MEMORY_DEMO_PORT ?? 4412);
const modelPort = Number(process.env.AEEIS_FIXTURE_MODEL_PORT ?? 4413);
const keepData = process.env.AEEIS_DEMO_KEEP_DATA === '1';
const dataDir = await mkdtemp(join(tmpdir(), 'aeeis-working-memory-'));
const serverFile = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const fixtureFile = fileURLToPath(new URL('./fixture-model.mjs', import.meta.url));

// Deliberately do not inherit AEEIS_*, DATABASE_URL, TEMPORAL_*, proxy, token or
// credential settings. This demo must remain usable on a machine whose normal
// shell is configured for production.
const cleanEnvironment = {
  PATH: process.env.PATH ?? '/usr/bin:/bin:/opt/homebrew/bin',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  LANG: process.env.LANG ?? 'en_US.UTF-8',
  LC_ALL: process.env.LC_ALL ?? '',
  NODE_ENV: 'development',
  AEEIS_ENV: 'development',
  AEEIS_AUTH_DISABLED: '1',
  AEEIS_HOST: host,
  PORT: String(apiPort),
  AEEIS_DEMO_MODE: '1',
  AEEIS_DATA_DIR: dataDir,
  AEEIS_FIXTURE_MODEL_HOST: host,
  AEEIS_FIXTURE_MODEL_PORT: String(modelPort),
  AEEIS_MODEL_BASE_URL: `http://${host}:${modelPort}/v1`,
  AEEIS_MODEL: 'aeeis-working-memory-fixture/1',
  AEEIS_MODEL_HEALTH_URL: `http://${host}:${modelPort}/health`,
  AEEIS_MODEL_ALLOW_INSECURE_HTTP: '1',
  AEEIS_MODEL_STREAM: '0',
  AEEIS_MODEL_MAX_ATTEMPTS: '1',
};

const children = [];
let stopping = false;

function start(label, file) {
  const child = spawn(process.execPath, [file], { cwd: dataDir, env: cleanEnvironment, stdio: 'inherit' });
  children.push({ label, child });
  child.once('error', error => {
    if (!stopping) {
      console.error(`${label} failed to start: ${error.message}`);
      void shutdown(1);
    }
  });
  child.once('exit', (code, signal) => {
    if (!stopping && code !== 0) {
      console.error(`${label} exited unexpectedly (${code ?? signal})`);
      void shutdown(code ?? 1);
    }
  });
  return child;
}

async function waitFor(url, label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const body = await response.json();
      if (response.ok && predicate(body)) return body;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms (${lastError})`);
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const { label, child } of children) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 250));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    console.log(`${label} stopped`);
  }
  if (keepData) console.log(`Isolated demo data retained at: ${dataDir}`);
  else {
    await rm(dataDir, { recursive: true, force: true });
    console.log('Temporary isolated demo data removed');
  }
  process.exit(code);
}

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

console.log('AEEIS working-memory offline demo');
console.log(`Isolated data directory: ${dataDir}`);
console.log(`Fixture model: http://${host}:${modelPort}`);
console.log(`AEEIS UI: http://${host}:${apiPort}`);
console.log('Live/provider model calls: 0; database: file store in temporary directory');

start('Fixture model', fixtureFile);
start('AEEIS server', serverFile);

await waitFor(`http://${host}:${modelPort}/health`, 'Fixture model', body => body.ok === true && body.mode === 'development-fixture');
await waitFor(`http://${host}:${apiPort}/health`, 'AEEIS health', body => body.service === 'aeeis-agent');
const status = await waitFor(
  `http://${host}:${apiPort}/api/status`,
  'AEEIS fixture status',
  body => body.modelConfigured === true && body.conversationRouting === true,
);

if (status.model?.model !== cleanEnvironment.AEEIS_MODEL) {
  throw new Error(`AEEIS is using ${status.model?.model ?? 'no model'} instead of the local fixture`);
}

console.log('Ready. The server has no production token, DATABASE_URL, Temporal or external model configuration.');
console.log('Press Ctrl-C to stop and remove the temporary data directory.');
await new Promise(() => {});
