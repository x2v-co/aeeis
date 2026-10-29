#!/usr/bin/env node
// Real-model evaluation layer. Never part of `npm test` or `npm run verify`.
//
//   npm run test:evals -- --live [--model <name>] [--case <id|tag>]... [--judge]
//   npm run test:evals -- --fixture            # harness self-check on the local fixture model, not a quality result
//   npm run test:evals -- --list
//   npm run test:evals -- --compare <before.json> <after.json>
//
// --live uses AEEIS_MODEL_BASE_URL, AEEIS_MODEL (or --model) and AEEIS_MODEL_API_KEY,
// read from the environment or .env. Without them the run is recorded as `not_run`
// and exits 2: a missing credential is never a pass.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_SCHEMA, REPORT_SCHEMA, caseResult, checkRun, compareReports, judgeCase, loadCases, reportStatus, runCase } from './evals-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXIT = { passed: 0, failed: 1, not_run: 2, usage: 2 };

function parseArgs(argv) {
  const args = { cases: [], live: false, fixture: false, judge: false, list: false, compare: undefined, out: join(root, 'test-report', 'evals'), model: undefined };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    const next = () => { const item = argv[++index]; if (item === undefined) throw new Error(`${value} needs a value`); return item; };
    if (value === '--live') args.live = true;
    else if (value === '--fixture') args.fixture = true;
    else if (value === '--judge') args.judge = true;
    else if (value === '--list') args.list = true;
    else if (value === '--model') args.model = next();
    else if (value === '--case') args.cases.push(next());
    else if (value === '--out') args.out = resolve(next());
    else if (value === '--compare') args.compare = [next(), next()];
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`Unknown option ${value}`);
  }
  return args;
}

const usage = `Usage:
  npm run test:evals -- --live [--model <name>] [--case <id|tag>]... [--judge] [--out <dir>]
  npm run test:evals -- --fixture [--case <id|tag>]...
  npm run test:evals -- --list
  npm run test:evals -- --compare <before.json> <after.json>`;

function gitCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; }
}
function stamp(date = new Date()) { return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }
function slug(value) { return String(value).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'model'; }

function writeReport(args, report) {
  mkdirSync(args.out, { recursive: true });
  const file = join(args.out, `${stamp(new Date(report.startedAt))}-${report.mode}-${slug(report.model?.model ?? 'none')}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
  });
}

async function startFixtureModel() {
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, 'scripts', 'fixture-model.mjs')], { env: { ...process.env, AEEIS_FIXTURE_MODEL_HOST: '127.0.0.1', AEEIS_FIXTURE_MODEL_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture model did not start')), 15_000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolveReady(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture model exited with ${code}`)); });
  });
  return { baseUrl: `http://127.0.0.1:${port}/v1`, stop: () => child.kill('SIGTERM') };
}

/** Same path as a follow-up in the workbench: a thread rooted at the finished Run. */
async function askFollowUp(ThreadService, repository, engine, parent, request) {
  const scope = { owner: parent.owner, tenantId: parent.tenantId ?? 'local' };
  const thread = { id: `thread_${randomUUID()}`, ...scope, createdAt: new Date().toISOString() };
  await repository.createThread(thread, parent.id);
  return new ThreadService(repository, engine).followUp(thread.id, { idempotencyKey: `eval-follow:${parent.id}`, parentRunId: parent.id, request }, scope);
}

function printCase(result) {
  const failed = result.checks.filter(check => !check.passed);
  const mark = { passed: 'PASS', failed: 'FAIL', error: 'ERR ', timeout: 'TIME' }[result.status] ?? result.status;
  console.log(`${mark} ${result.id.padEnd(28)} ${String(result.runStatus ?? '-').padEnd(14)} ${String(Math.round(result.durationMs / 1000)).padStart(4)}s ${String(result.usage.tokens).padStart(7)} tok${result.judge ? `  judge=${result.judge.verdict}` : ''}`);
  for (const check of failed) console.log(`       ${check.required ? '✗' : '·'} ${check.id}: ${check.detail}`);
  if (result.error) console.log(`       error: ${result.error}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage); return 0; }
  if (args.compare) {
    const [before, after] = args.compare.map(file => ({ ...JSON.parse(readFileSync(file, 'utf8')), file }));
    const diff = compareReports(before, after);
    console.log(`before: ${diff.before.file} (${diff.before.model}, ${diff.before.status})\nafter:  ${diff.after.file} (${diff.after.model}, ${diff.after.status})`);
    for (const row of diff.rows) {
      const tokens = row.tokens ? `  tokens ${row.tokens.before} → ${row.tokens.after}` : '';
      console.log(`${row.change.padEnd(7)} ${row.caseId.padEnd(28)} ${row.before} → ${row.after}${tokens}`);
      for (const check of row.checks ?? []) console.log(`        ${check.checkId}: ${check.before} → ${check.after} (${check.detail})`);
      if (row.judge) console.log(`        judge: ${row.judge.before} → ${row.judge.after}`);
    }
    return 0;
  }
  const cases = loadCases(root, args.cases);
  if (args.list) { for (const item of cases) console.log(`${item.id.padEnd(28)} ${(item.tags ?? []).join(',').padEnd(24)} ${item.title}`); return 0; }
  if (args.live === args.fixture) { console.error(`Choose --live (paid inference) or --fixture (harness check).\n${usage}`); return EXIT.usage; }

  const startedAt = new Date().toISOString();
  const base = { schemaVersion: REPORT_SCHEMA, caseSchema: CASE_SCHEMA, mode: args.live ? 'live' : 'fixture', startedAt, gitCommit: gitCommit(), caseIds: cases.map(item => item.id) };
  let modelConfig;
  let fixture;
  if (args.live) {
    const baseUrl = process.env.AEEIS_MODEL_BASE_URL, model = args.model ?? process.env.AEEIS_MODEL;
    if (!baseUrl || !model) {
      const missing = [!baseUrl ? 'AEEIS_MODEL_BASE_URL' : '', !model ? 'AEEIS_MODEL（或 --model）' : ''].filter(Boolean);
      const report = { ...base, status: 'not_run', reason: `missing model credentials: ${missing.join(', ')}`, finishedAt: new Date().toISOString(), model: null, cases: [] };
      const file = writeReport(args, report);
      console.log(`未运行（not_run）：缺少 ${missing.join('、')}。这不是通过。报告：${file}`);
      return EXIT.not_run;
    }
    modelConfig = { baseUrl, model, apiKey: process.env.AEEIS_MODEL_API_KEY ?? '', allowInsecureHttp: process.env.AEEIS_MODEL_ALLOW_INSECURE_HTTP === '1' };
  } else {
    fixture = await startFixtureModel();
    modelConfig = { baseUrl: fixture.baseUrl, model: 'aeeis-fixture/1', apiKey: '', allowInsecureHttp: true };
  }

  // The built runtime, so evals exercise the same code the server runs.
  const runtime = join(root, 'dist', 'runtime');
  const [{ AgentEngine, runClock }, { HttpModelAdapter, modelTransportConfig }, { InMemoryRunRepository }, contracts, { baseEvidenceRef }, { executionLimitsConfig }, { ThreadService }] = await Promise.all([
    import(join(runtime, 'engine.js')), import(join(runtime, 'model.js')), import(join(root, 'dist', 'adapters', 'in-memory-run-repository.js')),
    import(join(runtime, 'contracts.js')), import(join(runtime, 'evidence-refs.js')), import(join(runtime, 'execution-limits.js')), import(join(root, 'dist', 'application', 'thread-service.js')),
  ]);
  const model = new HttpModelAdapter(modelConfig.baseUrl, modelConfig.model, modelConfig.apiKey, undefined, Number(process.env.AEEIS_MODEL_TIMEOUT_MS ?? 180_000), undefined, modelConfig.allowInsecureHttp, undefined, modelTransportConfig(process.env));
  let judge;
  if (args.judge) {
    const judgeUrl = process.env.AEEIS_EVAL_JUDGE_BASE_URL, judgeModel = process.env.AEEIS_EVAL_JUDGE_MODEL;
    if (!judgeUrl || !judgeModel) { console.error('--judge needs AEEIS_EVAL_JUDGE_BASE_URL and AEEIS_EVAL_JUDGE_MODEL'); fixture?.stop(); return EXIT.usage; }
    judge = new HttpModelAdapter(judgeUrl, judgeModel, process.env.AEEIS_EVAL_JUDGE_API_KEY ?? '', undefined, 120_000, undefined, process.env.AEEIS_EVAL_JUDGE_ALLOW_INSECURE_HTTP === '1');
  }
  const deps = {
    root, clock: runClock,
    createEngine: () => {
      const repository = new InMemoryRunRepository();
      const engine = new AgentEngine(repository, { model, executionLimits: executionLimitsConfig(process.env) });
      return { repository, engine, followUp: (parent, request) => askFollowUp(ThreadService, repository, engine, parent, request) };
    },
    schemas: { 'project-pulse/1': contracts.projectPulseArtifactSchema, 'fillable-pdf/1': contracts.fillablePdfArtifactSchema },
    baseEvidenceRef,
  };
  console.log(`AEEIS evals · ${base.mode} · ${model.pin.model} · prompt ${model.pin.promptVersion} · ${cases.length} cases`);
  const results = [];
  try {
    for (const testCase of cases) {
      const outcome = await runCase(testCase, deps);
      const checks = checkRun(testCase, outcome, deps);
      const judged = judge ? await judgeCase(testCase, outcome.run, judge) : undefined;
      const result = caseResult(testCase, outcome, checks, judged);
      printCase(result);
      results.push(result);
    }
  } finally { fixture?.stop(); }
  const totals = results.reduce((sum, item) => ({
    passed: sum.passed + (item.status === 'passed' ? 1 : 0), failed: sum.failed + (item.status === 'passed' ? 0 : 1),
    tokens: sum.tokens + item.usage.tokens, modelCalls: sum.modelCalls + item.usage.modelCalls,
    moneyUsd: item.usage.moneyUsd === null || sum.moneyUsd === null ? null : sum.moneyUsd + item.usage.moneyUsd, durationMs: sum.durationMs + item.durationMs,
  }), { passed: 0, failed: 0, tokens: 0, modelCalls: 0, moneyUsd: 0, durationMs: 0 });
  const report = {
    ...base, status: reportStatus(results), finishedAt: new Date().toISOString(),
    model: { ...model.pin, ...(judge ? { judge: judge.pin } : {}) }, totals, cases: results,
    ...(base.mode === 'fixture' ? { note: 'Fixture model: checks the harness and the runtime path, not model quality.' } : {}),
  };
  const file = writeReport(args, report);
  console.log(`${report.status} · ${totals.passed}/${results.length} cases · ${totals.tokens} tokens · ${totals.moneyUsd === null ? 'money not reported' : `$${totals.moneyUsd.toFixed(4)}`} · ${file}`);
  // A fixture run checks that the harness and runtime path work; only an errored or timed-out case fails it.
  if (report.mode === 'fixture') return results.some(item => item.status === 'error' || item.status === 'timeout') ? EXIT.failed : EXIT.passed;
  return EXIT[report.status];
}

main().then(code => { process.exitCode = code; }, error => { console.error(error instanceof Error ? error.message : error); process.exitCode = EXIT.usage; });
