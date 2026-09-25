#!/usr/bin/env node

import { spawn } from 'node:child_process';

const host = process.env.AEEIS_HOST ?? '127.0.0.1';
const apiPort = Number(process.env.PORT ?? 4323);
const modelPort = Number(process.env.AEEIS_FIXTURE_MODEL_PORT ?? 4399);
const dataDir = process.env.AEEIS_DEMO_DATA_DIR ?? 'data/demo-local';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// A local demo must never inherit a deployment's database, Temporal cluster,
// credentials, or integration endpoints. Keep ordinary process settings such
// as PATH and proxy configuration, then add only the fixture settings below.
const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
  return !key.startsWith('AEEIS_') && key !== 'DATABASE_URL' && !key.startsWith('TEMPORAL_');
}));
const demoEnvironment = {
  ...inheritedEnvironment,
  NODE_ENV: 'development',
  AEEIS_ENV: 'development',
  AEEIS_HOST: host,
  PORT: String(apiPort),
  AEEIS_DEMO_MODE: '1',
  AEEIS_FIXTURE_MODEL_HOST: host,
  AEEIS_FIXTURE_MODEL_PORT: String(modelPort),
  AEEIS_MODEL_BASE_URL: `http://${host}:${modelPort}/v1`,
  AEEIS_MODEL: 'aeeis-fixture/1',
  AEEIS_MODEL_ALLOW_INSECURE_HTTP: '1',
  AEEIS_DATA_DIR: dataDir,
};

const children = [];
let stopping = false;

function start(command, args) {
  const child = spawn(command, args, { env: demoEnvironment, stdio: 'inherit' });
  children.push(child);
  child.once('error', error => {
    if (!stopping) {
      console.error(`AEEIS local demo process failed: ${error.message}`);
      void shutdown(1);
    }
  });
  child.once('exit', (code, signal) => {
    if (!stopping && code !== 0) {
      console.error(`AEEIS local demo process exited with ${code ?? signal}`);
      void shutdown(code ?? 1);
    }
  });
  return child;
}

async function waitFor(url, label, expected = body => body?.status === 'ok' || body?.status === 'ready', timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not reached';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const body = await response.json();
      if (response.ok && expected(body)) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms (${lastError})`);
}

async function isHealthy(url, expected) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return false;
    const body = await response.json();
    return expected(body);
  } catch {
    return false;
  }
}

async function isFixtureAeeisHealthy() {
  if (!await isHealthy(`http://${host}:${apiPort}/health`, body => (
    body?.service === 'aeeis-agent' && body?.protocol === 'aeeis-health/1'
  ))) return false;
  return isHealthy(`http://${host}:${apiPort}/api/status`, body => (
    body?.executionProfile === 'fixture'
      && body?.runner === 'LocalDispatcher'
      && body?.model?.model === 'aeeis-fixture/1'
  ));
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 250));
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  process.exit(code);
}

process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });

// Re-running the demo command should be harmless when a previous demo is
// already serving the requested ports. Only processes started by this
// invocation are owned by this script and will be stopped on Ctrl-C.
const modelAlreadyRunning = await isHealthy(`http://${host}:${modelPort}/health`, body => (
  body?.ok === true && body?.mode === 'development-fixture'
));
// Probe the AEEIS health identity rather than only accepting a 200 /readyz.
// Temporal workers intentionally expose the same path, so status-only checks
// can accidentally reuse a worker port as if it were the API server.
const aeeisAlreadyRunning = await isFixtureAeeisHealthy();

if (!modelAlreadyRunning) start(process.execPath, ['scripts/fixture-model.mjs']);
if (!aeeisAlreadyRunning) start(npmCommand, ['run', 'dev']);

try {
  await waitFor(`http://${host}:${modelPort}/health`, 'Fixture Model', body => (
    body?.ok === true && body?.mode === 'development-fixture'
  ));
  await waitFor(`http://${host}:${apiPort}/health`, 'AEEIS health', body => (
    body?.service === 'aeeis-agent' && body?.protocol === 'aeeis-health/1'
  ));
  await waitFor(`http://${host}:${apiPort}/readyz`, 'AEEIS readiness', body => (
    body?.protocol === 'aeeis-readiness/1' && body?.status === 'ready'
  ));
  await waitFor(`http://${host}:${apiPort}/api/status`, 'AEEIS fixture profile', body => (
    body?.executionProfile === 'fixture'
      && body?.runner === 'LocalDispatcher'
      && body?.model?.model === 'aeeis-fixture/1'
  ));
  console.log(`AEEIS local demo is ready at http://${host}:${apiPort}`);
  console.log(`Persistent demo data: ${dataDir}`);
  if (modelAlreadyRunning || aeeisAlreadyRunning) {
    console.log('Reused an already healthy local demo process.');
  }
  console.log('Press Ctrl-C to stop both processes.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await shutdown(1);
}

// When both services were already running there is nothing for this process
// to supervise; return successfully instead of leaving an unresolved
// top-level await that Node terminates with exit code 13.
if (children.length > 0) await new Promise(() => {});
