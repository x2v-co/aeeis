#!/usr/bin/env node

import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const timeoutMs = Number(process.env.AEEIS_SMOKE_TIMEOUT_MS ?? 90_000);
const startedAt = Date.now();
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = new Set();
let stopping = false;

function assertWithinTimeout() {
  if (Date.now() - startedAt > timeoutMs) throw new Error(`Local restart smoke timed out after ${timeoutMs}ms`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local port');
  const port = address.port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function start(command, args, env) {
  // npm/tsx create a small process tree. Put each service in its own process
  // group so stopping the npm parent also stops the actual API server and its
  // timers; otherwise a detached tsx child can keep scanning a data directory
  // after this smoke has removed it.
  const child = spawn(command, args, { env, stdio: 'inherit', detached: process.platform !== 'win32' });
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('error', error => { if (!stopping) console.error(`child process failed: ${error.message}`); });
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  } else child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (child.exitCode === null) {
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    } else child.kill('SIGKILL');
  }
}

async function request(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
  return body;
}

async function waitFor(baseUrl, path, predicate, label) {
  while (true) {
    assertWithinTimeout();
    try {
      const body = await request(baseUrl, path);
      if (predicate(body)) return body;
    } catch {
      // The process may still be compiling or binding its port.
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

const apiPort = await freePort();
const modelPort = await freePort();
const dataDir = await mkdtemp(join(tmpdir(), 'aeeis-local-restart-'));
const baseUrl = `http://127.0.0.1:${apiPort}`;
const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
  !key.startsWith('AEEIS_') && key !== 'DATABASE_URL' && !key.startsWith('TEMPORAL_')
)));
const environment = {
  ...inheritedEnvironment,
  NODE_ENV: 'development',
  AEEIS_ENV: 'development',
  AEEIS_HOST: '127.0.0.1',
  PORT: String(apiPort),
  AEEIS_DEMO_MODE: '1',
  AEEIS_DATA_DIR: dataDir,
  AEEIS_FIXTURE_MODEL_HOST: '127.0.0.1',
  AEEIS_FIXTURE_MODEL_PORT: String(modelPort),
  AEEIS_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
  AEEIS_MODEL: 'aeeis-fixture/1',
  AEEIS_MODEL_ALLOW_INSECURE_HTTP: '1',
};

let modelProcess;
let apiProcess;
try {
  modelProcess = start(process.execPath, ['scripts/fixture-model.mjs'], environment);
  apiProcess = start(npmCommand, ['run', 'dev'], environment);
  await waitFor(baseUrl, '/health', body => body.service === 'aeeis-agent' && body.protocol === 'aeeis-health/1', 'AEEIS health');
  await waitFor(baseUrl, '/readyz', body => body.protocol === 'aeeis-readiness/1' && body.status === 'ready', 'AEEIS readiness');

  const created = await request(baseUrl, '/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      goal: 'Local restart smoke: preserve a waiting Run',
      materials: [{ title: 'Restart source', source: 'smoke-local-restart', content: 'The waiting Run must survive an API restart.' }],
    }),
  });
  const waiting = await waitFor(baseUrl, `/api/runs/${created.id}`, body => body.status === 'needs_approval', 'Run approval');
  const planHash = waiting.plans?.at(-1)?.hash;
  if (!planHash) throw new Error(`Run ${created.id} did not persist an approvable plan hash`);

  await stop(apiProcess);
  apiProcess = start(npmCommand, ['run', 'dev'], environment);
  await waitFor(baseUrl, '/health', body => body.service === 'aeeis-agent' && body.protocol === 'aeeis-health/1', 'restarted AEEIS health');
  await waitFor(baseUrl, '/readyz', body => body.protocol === 'aeeis-readiness/1' && body.status === 'ready', 'restarted AEEIS readiness');
  const restored = await request(baseUrl, `/api/runs/${created.id}`);
  if (restored.status !== 'needs_approval' || restored.plans?.at(-1)?.hash !== planHash) {
    throw new Error(`Run did not restore its approval boundary: ${JSON.stringify({ status: restored.status, planHash: restored.plans?.at(-1)?.hash })}`);
  }
  await request(baseUrl, `/api/runs/${created.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ planHash }),
  });
  const completed = await waitFor(baseUrl, `/api/runs/${created.id}`, body => ['succeeded', 'failed', 'cancelled'].includes(body.status), 'restored Run completion');
  if (completed.status !== 'succeeded' || completed.review?.verdict !== 'accepted') {
    throw new Error(`Restored Run did not complete successfully: ${JSON.stringify({ status: completed.status, review: completed.review?.verdict, error: completed.error })}`);
  }
  const graphs = await request(baseUrl, `/api/runs/${created.id}/graphs`);
  console.log(JSON.stringify({
    runId: created.id,
    restoredStatus: restored.status,
    planHashRestored: true,
    finalStatus: completed.status,
    review: completed.review?.verdict,
    evidenceNodes: graphs.evidence?.nodes?.length ?? 0,
  }, null, 2));
} finally {
  stopping = true;
  await stop(apiProcess);
  await stop(modelProcess);
  for (const child of children) await stop(child);
  await rm(dataDir, { recursive: true, force: true });
}
