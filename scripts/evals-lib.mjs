// Real-model evaluation harness: case loading, one Run per case, deterministic
// checks, reports and comparison. The runtime modules are injected so the same
// code drives the built runtime (scripts/evals.mjs) and the TypeScript sources
// (tests/evals-harness.test.ts). Nothing here calls a model on its own.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const CASE_SCHEMA = 'aeeis-eval-case/1';
export const REPORT_SCHEMA = 'aeeis-eval-report/1';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
const CHECK_KINDS = new Set(['runStatus', 'artifactType', 'artifactSchema', 'evidenceResolvable', 'noPlaceholderRefs', 'contentIncludes', 'contentExcludes', 'toolUsed', 'logProtocol', 'pdfFilled', 'pdfUnknowns', 'withinBudget', 'noRepair']);

/** Reads evals/cases/*.json in name order and validates their shape. */
export function loadCases(root, only = []) {
  const directory = join(root, 'evals', 'cases');
  const cases = readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => {
    const value = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    validateCase(value, name);
    return value;
  });
  const ids = new Set();
  for (const item of cases) { if (ids.has(item.id)) throw new Error(`Duplicate eval case id ${item.id}`); ids.add(item.id); }
  if (!only.length) return cases;
  const unknown = only.filter(id => !ids.has(id) && !cases.some(item => item.tags?.includes(id)));
  if (unknown.length) throw new Error(`Unknown eval case or tag: ${unknown.join(', ')}`);
  return cases.filter(item => only.includes(item.id) || item.tags?.some(tag => only.includes(tag)));
}

function validateCase(value, name) {
  const fail = message => { throw new Error(`${name}: ${message}`); };
  if (value?.schemaVersion !== CASE_SCHEMA) fail(`schemaVersion must be ${CASE_SCHEMA}`);
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(value.id ?? '')) fail('id must be lowercase letters, digits and dashes');
  if (typeof value.title !== 'string' || typeof value.source !== 'string') fail('title and source are required');
  if (typeof value.request?.goal !== 'string') fail('request.goal is required');
  if (!Array.isArray(value.checks) || !value.checks.length) fail('at least one check is required');
  const checkIds = new Set();
  for (const check of value.checks) {
    if (!CHECK_KINDS.has(check.kind)) fail(`unknown check kind ${check.kind}`);
    if (!check.id || checkIds.has(check.id)) fail(`check ids must be present and unique (${check.id})`);
    checkIds.add(check.id);
  }
}

/** YYYY-MM-DD for `today` shifted by whole days. `today` is the Run clock's currentDate. */
export function shiftDate(today, days) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Materials: inline `content`, a text or PDF `file`, or a JSON `file` plus `pointer`. `{{date:-10}}` is relative to today. */
export function buildRequest(testCase, root, today) {
  const materials = (testCase.request.materials ?? []).map(material => {
    let content;
    if (material.content !== undefined) content = material.content;
    else if (material.file && material.encoding === 'pdf') content = `data:application/pdf;base64,${readFileSync(join(root, material.file)).toString('base64')}`;
    else if (material.file && material.pointer) content = pointer(JSON.parse(readFileSync(join(root, material.file), 'utf8')), material.pointer);
    else if (material.file) content = readFileSync(join(root, material.file), 'utf8');
    else throw new Error(`${testCase.id}: material ${material.title} has no content or file`);
    if (typeof content !== 'string') throw new Error(`${testCase.id}: material ${material.title} did not resolve to text`);
    content = content.replace(/\{\{date:([+-]?\d+)\}\}/g, (_, days) => shiftDate(today, Number(days)));
    return { title: material.title, source: material.source ?? `eval:${testCase.id}/${material.title}`, content };
  });
  const { materials: _materials, ...rest } = testCase.request;
  return { ...rest, materials };
}

function pointer(value, path) {
  return path.split('/').slice(1).reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], value);
}

/**
 * Runs one case to an end state: approves exactly the plan the Run proposed,
 * stops at needs_input (a question is an answer for some cases), and gives up at
 * the case deadline. A case with `followUp` asks it on the same thread after the
 * first Run succeeds, and the checks read the follow-up. Console JSON protocol
 * lines are captured for checks.
 */
export async function runCase(testCase, deps) {
  const { createEngine, root, clock, now = () => Date.now() } = deps;
  const { engine, repository, followUp } = createEngine();
  const started = now();
  const timeoutMs = testCase.budget?.timeoutMs ?? 600_000;
  const logs = [];
  const restore = captureLogs(logs);
  let run, parent, error, timedOut = false, approvals = 0;
  const drive = async id => {
    for (let tick = 0; tick < 1000; tick++) {
      if (now() - started > timeoutMs) { timedOut = true; break; }
      const status = await engine.advance(id);
      const current = await repository.get(id);
      // Only the plan gate is approved. A pending side effect stays with its owner: the eval stops there.
      if (status === 'needs_approval' && current.actionApproval?.status !== 'pending') {
        const plan = current.plans.at(-1);
        if (!plan || approvals >= 5 || (current.approval?.approved && current.approval.planHash === plan.hash)) break;
        await engine.command(id, 'approve', { planHash: plan.hash, planVersion: plan.version });
        approvals += 1;
        continue;
      }
      if (TERMINAL.has(status) || status === 'needs_input' || status === 'needs_approval' || status === 'paused') break;
    }
    return repository.get(id);
  };
  try {
    const placeholder = { createdAt: new Date(started).toISOString() };
    const request = buildRequest(testCase, root, clock(placeholder).currentDate);
    run = await engine.create(request, 'eval', 'local');
    run = await drive(run.id);
    if (testCase.followUp && !timedOut) {
      if (run.status !== 'succeeded') throw new Error(`first Run ended ${run.status}; follow-up not asked`);
      if (!followUp) throw new Error('follow-up is not available in this harness');
      parent = run;
      run = await followUp(parent, { ...testCase.followUp, materials: [] });
      run = await drive(run.id);
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    if (run) run = await repository.get(run.id).catch(() => run);
  } finally { restore(); }
  return { run, parent, logs, error, timedOut, approvals, durationMs: now() - started };
}

function captureLogs(sink) {
  const original = { warn: console.warn, info: console.info };
  const capture = level => (...args) => {
    if (args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('{')) {
      try { const value = JSON.parse(args[0]); if (value && typeof value.protocol === 'string') { sink.push(value); return; } } catch { /* not a protocol line */ }
    }
    original[level](...args);
  };
  console.warn = capture('warn'); console.info = capture('info');
  return () => { console.warn = original.warn; console.info = original.info; };
}

const PLACEHOLDER = /\[(?:证据|evidence|来源|source|ref|引用)\]|\[(?:证据|evidence)\s*\d*\]/i;
const PLACEHOLDER_REF = /^(?:TBD|TODO|N\/A|XX+|\?+|证据|evidence|source|ref|placeholder)$/i;

function artifactText(run) {
  return (run?.artifacts ?? []).map(artifact => `${artifact.content ?? ''}\n${artifact.structured === undefined ? '' : JSON.stringify(artifact.structured)}`).join('\n');
}
function collectRefs(value, into = []) {
  if (Array.isArray(value)) { for (const item of value) collectRefs(item, into); return into; }
  if (!value || typeof value !== 'object') return into;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'evidenceRefs' && Array.isArray(item)) into.push(...item.filter(ref => typeof ref === 'string'));
    else collectRefs(item, into);
  }
  return into;
}
function knownRefs(run) {
  return new Set([
    ...(run.context?.sources ?? []).map(source => source.id),
    ...(run.artifacts ?? []).map(artifact => artifact.id),
    ...(run.pdfOutputs ?? []).map(output => output.ref),
    ...(run.toolReceipts ?? []).flatMap(receipt => [receipt.receiptId, ...(receipt.outputRefs ?? [])]),
    // Follow-ups cite frozen thread history by the ids the runtime presented (thread-context.ts).
    ...(run.context?.threadHistory?.entries ?? []).flatMap(entry => (entry.excerpts ?? []).map(excerpt => `history:${entry.runId}:${excerpt.ref}`)),
  ].filter(Boolean));
}
/** Every expected key/value appears in actual; arrays match when some element matches. */
export function partialMatch(actual, expected) {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (Array.isArray(actual) && !Array.isArray(expected)) return actual.some(item => partialMatch(item, expected));
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every(part => actual.some(item => partialMatch(item, part)));
  return Boolean(actual) && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => partialMatch(actual[key], value));
}
const sameValue = (left, right) => JSON.stringify(Array.isArray(left) ? [...left].sort() : left) === JSON.stringify(Array.isArray(right) ? [...right].sort() : right);

/** Deterministic checks only. Each returns { id, kind, required, passed, detail }. */
export function checkRun(testCase, outcome, deps) {
  const { run, logs, durationMs } = outcome;
  const artifact = run?.artifacts?.at(-1);
  const text = artifactText(run);
  return testCase.checks.map(check => {
    const required = check.required !== false;
    const result = (passed, detail) => ({ id: check.id, kind: check.kind, required, passed: Boolean(passed), detail });
    if (!run) return result(false, outcome.error ?? 'no Run was created');
    switch (check.kind) {
      case 'runStatus': {
        const expected = check.expect ?? ['succeeded'];
        return result(expected.includes(run.status) && (check.allowPartial !== false || !run.partial), `status ${run.status}${run.partial ? ' (partial)' : ''}${run.error ? `: ${run.error}` : ''}`);
      }
      case 'artifactType': return result(artifact?.artifactType === check.expect, `artifactType ${artifact?.artifactType ?? 'none'}`);
      case 'artifactSchema': {
        const schema = deps.schemas[check.schema];
        if (!schema) return result(false, `no schema ${check.schema}`);
        const parsed = schema.safeParse(artifact?.structured);
        return result(parsed.success, parsed.success ? 'valid' : parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
      }
      case 'evidenceResolvable': {
        const refs = collectRefs((run.artifacts ?? []).map(item => ({ evidenceRefs: item.evidenceRefs, structured: item.structured })));
        const known = knownRefs(run);
        const missing = [...new Set(refs.filter(ref => !known.has(deps.baseEvidenceRef(ref, known, known))))];
        return result(refs.length > 0 && missing.length === 0, refs.length === 0 ? 'no evidence refs' : missing.length ? `unresolved: ${missing.slice(0, 5).join(', ')}` : `${refs.length} refs resolve`);
      }
      case 'noPlaceholderRefs': {
        const refs = collectRefs((run.artifacts ?? []).map(item => ({ evidenceRefs: item.evidenceRefs, structured: item.structured })));
        const bad = refs.filter(ref => PLACEHOLDER_REF.test(ref.trim()));
        const inline = PLACEHOLDER.exec(text)?.[0];
        return result(!bad.length && !inline, bad.length ? `placeholder refs: ${bad.join(', ')}` : inline ? `placeholder text ${inline}` : 'none');
      }
      case 'contentIncludes': {
        const missing = (check.all ?? []).filter(needle => !text.includes(needle));
        const any = check.any ? check.any.some(needle => text.includes(needle)) : true;
        return result(!missing.length && any, missing.length ? `missing: ${missing.join(', ')}` : any ? 'present' : `none of: ${check.any.join(', ')}`);
      }
      case 'contentExcludes': {
        const found = (check.any ?? []).filter(needle => new RegExp(needle, 'u').test(text));
        return result(!found.length, found.length ? `found: ${found.join(', ')}` : 'absent');
      }
      case 'toolUsed': {
        const used = (run.events ?? []).filter(event => event.type === 'tool.completed').map(event => event.data?.tool ?? event.data?.toolId);
        return result(used.includes(check.tool), `tools: ${[...new Set(used)].join(', ') || 'none'}`);
      }
      case 'logProtocol': {
        const matched = logs.filter(log => log.protocol === check.protocol && (!check.where || partialMatch(log, check.where)));
        return result(matched.length >= (check.min ?? 1), `${matched.length} matching ${check.protocol}`);
      }
      case 'pdfFilled': {
        const filled = Object.fromEntries((artifact?.structured?.filledFields ?? []).map(field => [field.name, field.value]));
        const wrong = Object.entries(check.fields).filter(([name, value]) => !sameValue(filled[name], value)).map(([name, value]) => `${name}=${JSON.stringify(filled[name])} (want ${JSON.stringify(value)})`);
        const extra = check.exact ? Object.keys(filled).filter(name => !(name in check.fields)) : [];
        return result(!wrong.length && !extra.length, wrong.length || extra.length ? [...wrong, ...extra.map(name => `unexpected ${name}=${JSON.stringify(filled[name])}`)].join('; ') : `${Object.keys(check.fields).length} fields match`);
      }
      case 'pdfUnknowns': {
        const reported = new Set((artifact?.structured?.unknowns ?? []).map(item => item.field).filter(Boolean));
        const missing = check.fields.filter(field => !reported.has(field));
        return result(!missing.length, missing.length ? `not reported: ${missing.join(', ')}` : `${check.fields.length} reported`);
      }
      case 'withinBudget': {
        const limit = check.timeoutMs ?? testCase.budget?.timeoutMs ?? 600_000;
        const explained = Boolean(run.partial && run.limitations?.length);
        return result(!outcome.timedOut && (durationMs <= limit || explained), `${Math.round(durationMs / 1000)}s of ${Math.round(limit / 1000)}s${explained ? ' (partial with limitations)' : ''}`);
      }
      case 'noRepair': {
        const repairs = (run.events ?? []).filter(event => event.type === 'artifact.repair_requested').length;
        return result(repairs === 0, `${repairs} repair requests`);
      }
      default: return result(false, `unsupported check ${check.kind}`);
    }
  });
}

/** Tokens, calls and money from the Run's own accounting. Money stays null when the provider did not price it. */
export function usageOf(run, parent) {
  const calls = [...(parent?.calls ?? []), ...(run?.calls ?? [])];
  const byPhase = {};
  let inputTokens = 0, outputTokens = 0;
  for (const call of calls) {
    byPhase[call.phase] = (byPhase[call.phase] ?? 0) + 1;
    inputTokens += call.usage?.inputTokens ?? 0;
    outputTokens += call.usage?.outputTokens ?? 0;
  }
  const runs = [parent, run].filter(Boolean);
  const reported = runs.every(item => item.modelUsage?.moneyUsd !== undefined);
  return {
    modelCalls: calls.length, byPhase, inputTokens, outputTokens,
    tokens: runs.reduce((sum, item) => sum + (item.modelUsage?.tokens ?? 0), 0) || inputTokens + outputTokens,
    moneyUsd: runs.length && reported ? runs.reduce((sum, item) => sum + item.modelUsage.moneyUsd, 0) : null,
    unpricedCalls: runs.reduce((sum, item) => sum + (item.modelUsage?.unreportedCalls ?? 0), 0),
  };
}

export function caseResult(testCase, outcome, checks, judge) {
  const status = outcome.error && !outcome.run ? 'error' : outcome.timedOut ? 'timeout' : checks.every(check => check.passed || !check.required) ? 'passed' : 'failed';
  const protocols = {};
  for (const log of outcome.logs) protocols[log.protocol] = (protocols[log.protocol] ?? 0) + 1;
  return {
    id: testCase.id, title: testCase.title, source: testCase.source, status,
    runId: outcome.run?.id ?? null, runStatus: outcome.run?.status ?? null, partial: Boolean(outcome.run?.partial),
    ...(outcome.parent ? { parentRunId: outcome.parent.id } : {}), durationMs: outcome.durationMs, approvals: outcome.approvals, usage: usageOf(outcome.run, outcome.parent), protocols,
    ...(outcome.error ? { error: outcome.error } : {}), checks, ...(judge ? { judge } : {}),
  };
}

export function reportStatus(cases) {
  if (!cases.length) return 'not_run';
  return cases.every(item => item.status === 'passed') ? 'passed' : 'failed';
}

/** Case-by-case, check-by-check differences between two reports. */
export function compareReports(before, after) {
  const rows = [];
  const index = report => new Map((report.cases ?? []).map(item => [item.id, item]));
  const left = index(before), right = index(after);
  for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(id), b = right.get(id);
    if (!a || !b) { rows.push({ caseId: id, change: a ? 'removed' : 'added', before: a?.status ?? null, after: b?.status ?? null }); continue; }
    const checks = [];
    const checkIds = [...new Set([...a.checks.map(check => check.id), ...b.checks.map(check => check.id)])];
    for (const checkId of checkIds) {
      const x = a.checks.find(check => check.id === checkId), y = b.checks.find(check => check.id === checkId);
      if (x?.passed !== y?.passed) checks.push({ checkId, before: x ? x.passed : null, after: y ? y.passed : null, detail: y?.detail ?? x?.detail });
    }
    const judge = a.judge?.verdict !== b.judge?.verdict ? { before: a.judge?.verdict ?? null, after: b.judge?.verdict ?? null } : undefined;
    rows.push({
      caseId: id, change: a.status === b.status ? (checks.length ? 'checks' : 'same') : 'status', before: a.status, after: b.status, checks,
      tokens: { before: a.usage.tokens, after: b.usage.tokens }, durationMs: { before: a.durationMs, after: b.durationMs }, ...(judge ? { judge } : {}),
    });
  }
  return {
    before: { file: before.file ?? null, model: before.model?.model ?? null, startedAt: before.startedAt, status: before.status },
    after: { file: after.file ?? null, model: after.model?.model ?? null, startedAt: after.startedAt, status: after.status },
    rows,
  };
}

export const judgeSystem = 'You are an independent evaluator of an AI assistant\'s deliverable. You receive the task goal, a rubric, the input material titles, and the final deliverable. Judge only against the rubric. Do not reward length. Reply with JSON {"verdict":"pass"|"fail"|"unsure","score":1-5,"rationale":"one short paragraph"}.';

/** Optional quality judgment by a separate model, recorded apart from the deterministic checks. */
export async function judgeCase(testCase, run, judge) {
  if (!testCase.judge?.rubric) return undefined;
  const artifact = run?.artifacts?.at(-1);
  if (!artifact) return { model: judge.pin.model, verdict: 'unsure', score: null, rationale: 'no deliverable to judge' };
  try {
    const response = await judge.complete({
      system: judgeSystem, idempotencyKey: `eval-judge:${testCase.id}:${run.id}`,
      input: { goal: testCase.request.goal, rubric: testCase.judge.rubric, materials: (testCase.request.materials ?? []).map(material => material.title), deliverable: { content: String(artifact.content ?? '').slice(0, 20000), structured: artifact.structured ?? null } },
    });
    const value = response.value ?? {};
    const verdict = ['pass', 'fail', 'unsure'].includes(value.verdict) ? value.verdict : 'unsure';
    return { model: judge.pin.model, verdict, score: Number.isInteger(value.score) ? value.score : null, rationale: String(value.rationale ?? '').slice(0, 2000), usage: response.usage ?? null };
  } catch (error) {
    return { model: judge.pin.model, verdict: 'unsure', score: null, rationale: `judge failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
