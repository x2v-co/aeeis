#!/usr/bin/env node
/**
 * Offline acceptance for task-scoped compaction.
 *
 * Starts a scrubbed file-store server and the deterministic fixture model,
 * then proves one entry can compact 任务甲 without letting 任务乙 or the
 * sibling deliver node read 任务甲's original fact. No paid model, database,
 * or production token is used.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const host = '127.0.0.1';
const apiPort = Number(process.env.AEEIS_WORKING_MEMORY_DEMO_PORT ?? 4422);
const modelPort = Number(process.env.AEEIS_FIXTURE_MODEL_PORT ?? 4423);
const api = `http://${host}:${apiPort}`;
const dataDir = await mkdtemp(join(tmpdir(), 'aeeis-working-memory-compaction-'));
const serverFile = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const fixtureFile = fileURLToPath(new URL('./fixture-model.mjs', import.meta.url));
const alphaFact = `ALPHA-FACT-ONLY ${'alpha evidence detail. '.repeat(180)}`;

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
  const child = spawn(process.execPath, [file], { cwd: dataDir, env: cleanEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', chunk => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[${label}] ${chunk}`));
  child.once('exit', (code, signal) => {
    if (!stopping && code !== 0) console.error(`${label} exited unexpectedly (${code ?? signal})`);
  });
  return child;
}

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  await new Promise(resolve => setTimeout(resolve, 400));
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  await rm(dataDir, { recursive: true, force: true });
  process.exit(code);
}

async function waitFor(url, label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const body = await response.json();
      if (response.ok && predicate(body)) return body;
      lastError = `HTTP ${response.status} ${JSON.stringify(body).slice(0, 300)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms (${lastError})`);
}

async function request(method, path, body) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; }
  catch { parsed = { raw: text }; }
  if (!response.ok) throw new Error(`${method} ${path} failed with HTTP ${response.status}: ${JSON.stringify(parsed).slice(0, 800)}`);
  return parsed;
}

async function untilStatus(id, wanted, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let run;
  while (Date.now() < deadline) {
    run = await request('GET', `/api/runs/${id}`);
    if (wanted.includes(run.status)) return run;
    if (['failed', 'unknown', 'cancelled'].includes(run.status) && !wanted.includes(run.status)) {
      throw new Error(`Run ${id} entered ${run.status}: ${run.error ?? ''} phases=${run.calls?.map(call => call.phase).join(',')}`);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Run ${id} stayed ${run?.status ?? 'missing'}; phases=${run?.calls?.map(call => call.phase).join(',')}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log(`Isolated data directory: ${dataDir}`);
  start('fixture', fixtureFile);
  start('aeeis', serverFile);
  await waitFor(`http://${host}:${modelPort}/health`, 'Fixture model', body => body.ok === true && body.mode === 'development-fixture');
  const status = await waitFor(`${api}/api/status`, 'AEEIS fixture status', body => body.modelConfigured === true && body.conversationRouting === true);
  assert(status.model?.model === cleanEnvironment.AEEIS_MODEL, `AEEIS is using ${status.model?.model ?? 'no model'} instead of the local fixture`);

  let conversation = await request('POST', '/api/conversations', { title: '单入口压缩验收' });
  const createdAlpha = await request('POST', `/api/conversations/${conversation.id}/messages`, {
    text: '开始处理任务甲。', expectedRevision: conversation.revision, newTask: { title: '任务甲' }, focus: 'switch',
  });
  conversation = createdAlpha.conversation;
  const alpha = conversation.tasks.find(task => task.title === '任务甲');
  assert(conversation.focusTaskId === alpha.id, 'Creating 任务甲 did not take focus');

  const createdBeta = await request('POST', `/api/conversations/${conversation.id}/messages`, {
    text: '任务乙只记录 BETA-PRIVATE，不要和任务甲混用。', expectedRevision: conversation.revision, newTask: { title: '任务乙' }, focus: 'keep',
  });
  conversation = createdBeta.conversation;
  const beta = conversation.tasks.find(task => task.title === '任务乙');
  assert(conversation.focusTaskId === alpha.id, 'Creating 任务乙 moved the entry focus');

  const side = await request('POST', `/api/conversations/${conversation.id}/messages`, {
    text: '任务乙的预算是多少？BETA-PRIVATE 只属于任务乙。', expectedRevision: conversation.revision,
  });
  conversation = side.conversation;
  assert(side.message.route.reason === 'name' && side.message.route.taskIds.includes(beta.id), 'The side note did not route to 任务乙 by name');
  assert(conversation.focusTaskId === alpha.id, 'The side note stole focus from 任务甲');
  assert(!side.runId, 'The side note created a Run');

  const executed = await request('POST', `/api/conversations/${conversation.id}/messages`, {
    text: 'WORKING-MEMORY-COMPACTION 请只依据任务甲原文处理。',
    expectedRevision: conversation.revision,
    intent: 'execute',
    taskIds: [alpha.id],
    runOptions: { materials: [{ title: '任务甲原文', source: 'acceptance:alpha', content: alphaFact }] },
  });
  assert(executed.runId, 'Explicit execution did not create a Run');
  let run = await untilStatus(executed.runId, ['needs_approval']);
  const plan = run.plans.at(-1);
  await request('POST', `/api/runs/${run.id}/approve`, { planHash: plan.hash, planVersion: plan.version });
  run = await untilStatus(run.id, ['succeeded']);

  const phases = run.calls.map(call => call.phase);
  const compaction = run.calls.filter(call => call.phase === 'compaction');
  assert(phases[0] === 'planner' && phases.at(-1) === 'reviewer', `Unexpected call sequence: ${phases.join(' -> ')}`);
  assert(compaction.length === 1, `Expected one compaction call, saw ${compaction.length}: ${phases.join(' -> ')}`);
  assert(compaction[0].state === 'completed', `Compaction call is ${compaction[0].state}`);
  assert(!('modelRequest' in compaction[0]) && !('rawOutput' in compaction[0]), 'Public Run projection leaked the compaction transcript');
  assert(run.workingMemory === undefined && run.workingMemoryEnabled === true, 'Public Run projection did not reduce working memory to the enabled flag');
  assert(!JSON.stringify(compaction[0]).includes('alpha evidence detail'), 'Compaction call metadata still contains the original fact');

  const events = await request('GET', `/api/runs/${run.id}/events?limit=100`);
  assert(events.events.some(event => event.type === 'context.summary_active'), 'No active summary event was recorded');
  assert(events.events.filter(event => event.type === 'model.failed' || event.type === 'model.unknown' || event.type === 'run.failed').every(event => !event.data?.rawOutput), 'A failure event exposed raw output');

  const memory = await request('GET', `/api/runs/${run.id}/working-memory?taskId=inspect`);
  assert(memory.untrusted === true && memory.citationAuthority === false, 'Working memory was presented as authority');
  const summary = memory.summaries?.[0];
  assert(summary?.items?.[0]?.text?.includes('MODEL GENERATED'), 'The active summary was not the fixture model text');
  const sliceId = summary.items[0].references?.[0];
  assert(typeof sliceId === 'string' && sliceId.startsWith('wm_slice_'), 'The summary does not cite a supplied slice');
  const found = await request('GET', `/api/runs/${run.id}/working-memory/search?taskId=inspect&q=${encodeURIComponent('alpha evidence detail')}`);
  assert(found.total >= 1 && found.results[0]?.originalId, '任务甲 did not retain a searchable original');
  const original = await request('GET', `/api/runs/${run.id}/working-memory/original?taskId=inspect&entryId=${encodeURIComponent(found.results[0].originalId)}`);
  assert(String(original.text).includes('alpha evidence detail'), 'The bounded original no longer contains the fact');
  const sibling = await request('GET', `/api/runs/${run.id}/working-memory/search?taskId=deliver&q=${encodeURIComponent('alpha evidence detail')}`);
  assert(sibling.total === 0, `Sibling deliver node saw ${sibling.total} matches`);

  conversation = (await request('GET', `/api/conversations/${conversation.id}`));
  const betaRun = await request('POST', `/api/conversations/${conversation.id}/messages`, {
    text: '请只确认任务乙自己的短说明。',
    expectedRevision: conversation.revision,
    intent: 'execute',
    taskIds: [beta.id],
  });
  let other = await untilStatus(betaRun.runId, ['needs_approval']);
  const otherPlan = other.plans.at(-1);
  await request('POST', `/api/runs/${other.id}/approve`, { planHash: otherPlan.hash, planVersion: otherPlan.version });
  other = await untilStatus(other.id, ['succeeded']);
  assert(!other.calls.some(call => call.phase === 'compaction'), '任务乙 was compacted by 任务甲\'s large source');
  const isolated = await request('GET', `/api/runs/${other.id}/working-memory/search?taskId=inspect&q=${encodeURIComponent('alpha evidence detail')}`);
  assert(isolated.total === 0, `任务乙 found ${isolated.total} copies of 任务甲's fact`);
  const privateNote = await request('GET', `/api/runs/${run.id}/working-memory/search?taskId=inspect&q=${encodeURIComponent('BETA-PRIVATE')}`);
  assert(privateNote.total === 0, '任务甲 search returned 任务乙\'s private note');

  const entry = await request('GET', `/api/conversations/${conversation.id}`);
  const alphaTask = entry.tasks.find(task => task.id === alpha.id);
  const betaTask = entry.tasks.find(task => task.id === beta.id);
  assert(alphaTask.memory?.activeSummaries >= 1 && alphaTask.memory.originals >= 1, '任务甲的入口卡片没有记忆计数');
  assert(!betaTask.memory || betaTask.memory.activeSummaries === 0, '任务乙的入口卡片显示了压缩摘要');
  const entryJson = JSON.stringify(entry);
  assert(!entryJson.includes('alpha evidence detail') && !entryJson.includes('MODEL GENERATED'), '对话视图带出了摘要或原文');

  console.log('CASE PASSED：任务甲完成了一次模型压缩；任务乙和 deliver 节点都没有读到 ALPHA-FACT-ONLY。');
  console.log(JSON.stringify({ runId: run.id, phases, summary: summary.items[0].text, siblingMatches: sibling.total, otherTaskMatches: isolated.total, api }));
  if (process.env.AEEIS_ACCEPTANCE_HOLD === '1') {
    console.log(`Holding the fixture server at ${api}`);
    await new Promise(() => {});
  }
}

main().then(() => { if (process.env.AEEIS_ACCEPTANCE_HOLD !== '1') return shutdown(0); }).catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  return shutdown(1);
});
