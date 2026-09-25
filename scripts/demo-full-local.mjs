#!/usr/bin/env node

/**
 * Start the complete development protocol stack without Docker. Every
 * dependency is a repository fixture, but the boundaries are real HTTP/CLI
 * boundaries: catalog routing, OwnHow governance, RSI evaluation and an
 * admitted external Agent are all enabled in the AEEIS process.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = Number(process.env.AEEIS_FULL_DEMO_TIMEOUT_MS ?? 90_000);
const startedAt = Date.now();
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
  !key.startsWith('AEEIS_') && key !== 'DATABASE_URL' && !key.startsWith('TEMPORAL_')
)));
const children = new Set();
let stopping = false;

function assertWithinTimeout() {
  if (Date.now() - startedAt > timeoutMs) throw new Error(`Full local demo timed out after ${timeoutMs}ms`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local port');
  const port = address.port;
  await new Promise(resolvePromise => server.close(resolvePromise));
  return port;
}

function start(command, args, environment) {
  const child = spawn(command, args, { cwd: root, env: environment, stdio: 'inherit' });
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('error', error => {
    if (!stopping) console.error(`Full local demo child failed: ${error.message}`);
  });
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolvePromise => {
    const timer = setTimeout(resolvePromise, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
  });
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitFor(url, label, predicate) {
  let lastError = 'not reached';
  while (true) {
    assertWithinTimeout();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const body = await response.json();
      if (response.ok && predicate(body)) return body;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  // Keep the label in the function's error path if the loop is interrupted by
  // a future timeout implementation.
  throw new Error(`${label} did not become ready (${lastError})`);
}

async function runSmoke(baseUrl, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['scripts/smoke-full-local.mjs'], {
      cwd: root,
      env: { ...environment, AEEIS_BASE_URL: baseUrl, AEEIS_SMOKE_TIMEOUT_MS: String(timeoutMs) },
      stdio: 'inherit',
    });
    children.add(child);
    child.once('exit', () => children.delete(child));
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`Full local smoke exited with ${code}`)));
  });
}

const dataDir = process.env.AEEIS_FULL_DEMO_DATA_DIR ?? join(root, 'data', 'demo-full-local');
await mkdir(dataDir, { recursive: true });
const [apiPort, modelPort, evaluatorPort, agentPort, planpricePort] = await Promise.all([
  freePort(), freePort(), freePort(), freePort(), freePort(),
]);
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const modelBaseUrl = `http://127.0.0.1:${modelPort}/v1`;
const evaluatorUrl = `http://127.0.0.1:${evaluatorPort}/evaluate`;
const agentEndpoint = `http://127.0.0.1:${agentPort}/task`;
const planpriceUrl = `http://127.0.0.1:${planpricePort}`;

// OwnHow is a CLI boundary. The fixture has a shebang but repository checkouts
// do not have to preserve executable mode, so create a tiny executable wrapper
// inside the demo data directory.
const ownhowWrapper = join(dataDir, 'ownhow-fixture-bin.mjs');
await writeFile(ownhowWrapper, `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('./fixture-ownhow.mjs', import.meta.url).href)});\n`, 'utf8');
await chmod(ownhowWrapper, 0o755);

const cards = JSON.stringify([{
  schemaVersion: 'agent-card/1', agentId: 'agent.fixture', name: 'AEEIS Fixture Agent', owner: 'aeeis-development',
  protocols: ['aeeis-task/1'], capabilities: ['research'], inputSchemas: ['task-brief/1'], outputSchemas: ['result-envelope/1'],
  auth: ['local'], privacy: { dataRetention: 'session', regions: ['local'] }, pricing: { unit: 'run' }, cardVersion: '1', endpoint: agentEndpoint,
}]);
const competitionModels = JSON.stringify(Object.fromEntries(['agent.one', 'agent.two', 'agent.moderator', 'agent.adjudicator'].map(agentId => [agentId, {
  baseUrl: modelBaseUrl, model: 'aeeis-fixture/1', provider: 'full-local-fixture',
}])));
const environment = {
  ...inherited,
  NODE_ENV: 'development', AEEIS_ENV: 'development', AEEIS_DEMO_MODE: '1',
  AEEIS_HOST: '127.0.0.1', PORT: String(apiPort), AEEIS_DATA_DIR: dataDir,
  AEEIS_FIXTURE_MODEL_HOST: '127.0.0.1', AEEIS_FIXTURE_MODEL_PORT: String(modelPort),
  AEEIS_FIXTURE_EVALUATOR_HOST: '127.0.0.1', AEEIS_FIXTURE_EVALUATOR_PORT: String(evaluatorPort),
  AEEIS_FIXTURE_AGENT_HOST: '127.0.0.1', AEEIS_FIXTURE_AGENT_PORT: String(agentPort),
  AEEIS_FIXTURE_PLANPRICE_HOST: '127.0.0.1', AEEIS_FIXTURE_PLANPRICE_PORT: String(planpricePort),
  AEEIS_PLANPRICE_URL: planpriceUrl, AEEIS_PLANPRICE_ALLOW_INSECURE_HTTP: '1',
  AEEIS_PLANPRICE_HEALTH_URL: `${planpriceUrl}/health`,
  AEEIS_MODEL_PROVIDER_ENDPOINTS: JSON.stringify({ 'compose-fixture': modelBaseUrl }),
  AEEIS_MODEL_PROVIDER_HEALTH_URLS: JSON.stringify({ 'compose-fixture': `http://127.0.0.1:${modelPort}/health` }),
  AEEIS_MODEL_PROVIDER_ALLOW_INSECURE_HTTP: '1', AEEIS_MODEL_ALLOW_INSECURE_HTTP: '1',
  AEEIS_OWNHOW_ENABLED: '1', AEEIS_OWNHOW_BIN: ownhowWrapper, AEEIS_OWNHOW_RUNTIME: 'codex', AEEIS_OWNHOW_STATE_DIR: join(dataDir, 'ownhow-state'),
  AEEIS_RSI_PROPOSAL_SYNTHESIS_ENABLED: '1', AEEIS_RSI_PROPOSAL_SYNTHESIS_PRIVACY: 'public,internal',
  AEEIS_RSI_EVALUATOR_URL: evaluatorUrl, AEEIS_RSI_EVALUATOR_HEALTH_URL: `http://127.0.0.1:${evaluatorPort}/health`, AEEIS_RSI_EVALUATOR_ALLOW_INSECURE_HTTP: '1',
  AEEIS_COMPETITION_AGENT_MODELS: competitionModels, AEEIS_COMPETITION_EVALUATOR_AGENT_ID: 'agent.evaluator',
  AEEIS_COMPETITION_EVALUATOR_BASE_URL: modelBaseUrl, AEEIS_COMPETITION_EVALUATOR_MODEL: 'aeeis-fixture/1',
  AEEIS_DEBATE_MODERATOR_AGENT_ID: 'agent.moderator', AEEIS_DEBATE_ADJUDICATOR_AGENT_ID: 'agent.adjudicator',
  AEEIS_AGENT_ALLOW_INSECURE_HTTP: '1', AEEIS_AGENT_CARDS: cards,
  AEEIS_PROJECT_SOURCES_FILE: join(root, 'fixtures', 'project-sources.json'),
  AEEIS_RUNNER: 'local',
};

let apiProcess;
let shuttingDown = false;
async function stopAll(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopping = true;
  await stop(apiProcess);
  for (const child of [...children]) await stop(child);
  if (code !== undefined) process.exit(code);
}
process.once('SIGINT', () => { void stopAll(0); });
process.once('SIGTERM', () => { void stopAll(0); });
try {
  start(process.execPath, ['scripts/fixture-model.mjs'], environment);
  start(process.execPath, ['scripts/fixture-evaluator.mjs'], environment);
  start(process.execPath, ['scripts/fixture-agent.mjs'], environment);
  start(process.execPath, ['scripts/fixture-planprice.mjs'], environment);
  // Directly invoke tsx so stopping this script also stops the API process;
  // wrapping it in `npm run dev` can leave a grandchild behind on SIGTERM.
  apiProcess = start(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], environment);

  await waitFor(`http://127.0.0.1:${modelPort}/health`, 'Fixture Model', body => body?.ok === true);
  await waitFor(`http://127.0.0.1:${evaluatorPort}/health`, 'Fixture Evaluator', body => body?.ok === true);
  await waitFor(`http://127.0.0.1:${agentPort}/health`, 'Fixture Agent', body => body?.ok === true);
  await waitFor(`http://127.0.0.1:${planpricePort}/health`, 'Planprice', body => body?.status === 'ok');
  await waitFor(`${apiBaseUrl}/health`, 'AEEIS health', body => body?.service === 'aeeis-agent' && body?.protocol === 'aeeis-health/1');
  await waitFor(`${apiBaseUrl}/readyz`, 'AEEIS readiness', body => body?.protocol === 'aeeis-readiness/1' && body?.status === 'ready');
  const status = await waitFor(`${apiBaseUrl}/api/status`, 'AEEIS full profile', body => (
    body?.executionProfile === 'fixture' && body?.runner === 'LocalDispatcher' && body?.modelRouting === 'catalog'
      && body?.skillGovernanceConfigured === true && body?.rsiEvaluatorConfigured === true && body?.agentGatewayConfigured === true
  ));
  console.log('\nAEEIS full local demo is ready at ' + apiBaseUrl);
  console.log('Workbench: ' + apiBaseUrl);
  console.log('Persistent demo data: ' + dataDir);
  console.log('Enabled boundaries: Planprice catalog, OwnHow Skill governance, RSI evaluator, Agent Gateway and LocalDispatcher.');
  console.log('\nRunning the complete local protocol smoke through the catalog-routed profile...\n');
  await runSmoke(apiBaseUrl, environment);
  console.log('\nFull local demo is still running. Press Ctrl-C to stop all fixture processes.');
  console.log(JSON.stringify({ modelRouting: status.modelRouting, skillGovernance: status.skillGovernanceConfigured, rsiEvaluator: status.rsiEvaluatorConfigured, agentGateway: status.agentGatewayConfigured, dataDir }, null, 2));
  await new Promise(() => {});
} finally {
  await stopAll();
}
