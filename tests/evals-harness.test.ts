import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, runClock } from '../src/runtime/engine.js';
import { REPLY_SYSTEM, replySchema, replyTasks } from '../src/bot-team.js';
import { DISCUSSION_REPLY_SYSTEM } from '../src/runtime/http.js';
import { HttpModelAdapter } from '../src/runtime/model.js';
import { fillablePdfArtifactSchema, projectPulseArtifactSchema, requestSchema } from '../src/runtime/contracts.js';
import { baseEvidenceRef } from '../src/runtime/evidence-refs.js';
// @ts-expect-error plain ESM helper shared with scripts/evals.mjs
import { buildRequest, caseResult, chatReplyParsers, checkRun, compareReports, loadCases, partialMatch, runCase, shiftDate } from '../scripts/evals-lib.mjs';

const root = process.cwd();
const schemas = { 'project-pulse/1': projectPulseArtifactSchema, 'fillable-pdf/1': fillablePdfArtifactSchema };
const deps = { schemas, baseEvidenceRef, chatParsers: chatReplyParsers({ replySchema, replyTasks }) };

describe('eval cases', () => {
  it('load with unique ids, resolve every material and build valid Run requests', () => {
    const cases = loadCases(root);
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(cases.filter((item: any) => item.tags?.includes('pulse')).length).toBeGreaterThanOrEqual(6);
    expect(cases.filter((item: any) => item.tags?.includes('pdf')).length).toBe(6);
    for (const item of cases.filter((entry: any) => !entry.request.chat)) {
      for (const material of item.request.materials ?? []) if (material.file) expect(existsSync(join(root, material.file)), material.file).toBe(true);
      const request = buildRequest(item, root, '2026-10-29');
      expect(requestSchema.safeParse(request).success, item.id).toBe(true);
      expect(JSON.stringify(request)).not.toContain('{{date:');
    }
    expect(loadCases(root, ['pdf']).every((item: any) => item.tags.includes('pdf'))).toBe(true);
    expect(() => loadCases(root, ['nope'])).toThrow('Unknown eval case or tag');
    // Chat cases time one Bot reply through the team chat prompt; their checks read the reply, not a Run.
    const chats = loadCases(root, ['chat']);
    expect(chats.map((item: any) => item.id).sort()).toEqual(['chat-dm-question', 'chat-dm-thanks', 'chat-group-split']);
    for (const item of chats) expect(item.checks.some((check: any) => check.kind === 'withinBudget'), item.id).toBe(true);
  });

  it('places relative dates against the Run clock', () => {
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    const overdue = loadCases(root, ['pulse-csv-overdue'])[0];
    const content = buildRequest(overdue, root, '2026-10-29').materials[0].content;
    expect(content).toContain('1,Fix login,open,2026-10-19,');
    expect(content).toContain('3,Ship v2,in_progress,2026-11-05,');
  });
});

describe('deterministic checks', () => {
  const source = { id: 'source_1', title: 'notes.md', content: 'x', source: 'upload' };
  const run = (overrides: Record<string, unknown> = {}) => ({
    id: 'run_1', status: 'succeeded', events: [{ type: 'tool.completed', data: { tool: 'sources.csvQuery' } }], calls: [], context: { sources: [source] },
    artifacts: [{ id: 'artifact_1', artifactType: 'project-pulse/1', content: 'Login shipped [source_1]', evidenceRefs: ['source_1'],
      structured: { schemaVersion: 'project-pulse/1', progress: [{ text: 'Login shipped', evidenceRefs: ['source_1'] }], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] } }],
    ...overrides,
  });
  const testCase = { id: 'unit', checks: [
    { id: 'ok', kind: 'runStatus' }, { id: 'type', kind: 'artifactType', expect: 'project-pulse/1' }, { id: 'schema', kind: 'artifactSchema', schema: 'project-pulse/1' },
    { id: 'refs', kind: 'evidenceResolvable' }, { id: 'placeholders', kind: 'noPlaceholderRefs' }, { id: 'tool', kind: 'toolUsed', tool: 'sources.csvQuery' },
    { id: 'has', kind: 'contentIncludes', all: ['Login'] }, { id: 'not', kind: 'contentExcludes', any: ['Ship v2'] },
    { id: 'log', kind: 'logProtocol', protocol: 'aeeis-csv-date-filter/1', where: { filters: { op: 'lt', effective: true } } },
    { id: 'time', kind: 'withinBudget', timeoutMs: 1000 }, { id: 'repair', kind: 'noRepair', required: false },
  ] };
  const outcome = (value: unknown, logs: unknown[] = [{ protocol: 'aeeis-csv-date-filter/1', filters: [{ op: 'gte', effective: true }, { op: 'lt', effective: true }] }], durationMs = 10) => ({ run: value, logs, durationMs, timedOut: false, approvals: 1 });

  it('pass on a well-formed Run', () => {
    const checks = checkRun(testCase, outcome(run()), deps);
    expect(checks.filter((check: any) => !check.passed)).toEqual([]);
    expect(caseResult(testCase, outcome(run()), checks).status).toBe('passed');
  });

  it('fail on placeholders, unknown refs, wrong status, missing tool and missing logs', () => {
    const bad = run({
      status: 'failed', partial: true, events: [{ type: 'artifact.repair_requested' }],
      artifacts: [{ id: 'artifact_1', artifactType: 'other', content: 'Ship v2 [证据]', evidenceRefs: ['TBD', 'source_9'], structured: { schemaVersion: 'project-pulse/1' } }],
    });
    const checks = Object.fromEntries(checkRun(testCase, outcome(bad, [], 5000), deps).map((check: any) => [check.id, check]));
    for (const id of ['ok', 'type', 'schema', 'refs', 'placeholders', 'tool', 'has', 'not', 'log', 'time', 'repair']) expect(checks[id].passed, id).toBe(false);
    expect(checks.refs.detail).toContain('source_9');
    expect(caseResult(testCase, outcome(bad, [], 5000), Object.values(checks)).status).toBe('failed');
    // A required:false check never fails the case on its own.
    const onlyInfo = { id: 'info', checks: [{ id: 'repair', kind: 'noRepair', required: false }] };
    expect(caseResult(onlyInfo, outcome(bad), checkRun(onlyInfo, outcome(bad), deps)).status).toBe('passed');
  });

  it('checks PDF writes exactly and the unknowns that must be reported', () => {
    const pdfCase = { id: 'pdf', checks: [{ id: 'filled', kind: 'pdfFilled', fields: { name: 'Maya', interests: ['Travel', 'Music'] }, exact: true }, { id: 'unknown', kind: 'pdfUnknowns', fields: ['phone', 'caseId'] }] };
    const pdfRun = (filledFields: unknown[], unknowns: unknown[]) => run({ artifacts: [{ id: 'a', artifactType: 'fillable-pdf/1', evidenceRefs: [], structured: { filledFields, unknowns } }] });
    const good = checkRun(pdfCase, outcome(pdfRun([{ name: 'name', value: 'Maya' }, { name: 'interests', value: ['Music', 'Travel'] }], [{ field: 'phone' }, { field: 'caseId' }])), deps);
    expect(good.every((check: any) => check.passed)).toBe(true);
    const bad = checkRun(pdfCase, outcome(pdfRun([{ name: 'name', value: 'Maya' }, { name: 'interests', value: ['Music'] }, { name: 'country', value: 'SG' }], [{ field: 'phone' }])), deps);
    expect(bad.map((check: any) => check.detail)).toEqual(['interests=["Music"] (want ["Travel","Music"]); unexpected country="SG"', 'not reported: caseId']);
  });

  it('sectionContent reads only the results section the goal asks for (pulse-csv-overdue)', () => {
    const testCase = loadCases(process.cwd(), ['pulse-csv-overdue'])[0];
    // The check depends on a layout, so the request must ask for it (Codex review on #232).
    expect(testCase.request.goal).toContain('标题「## 逾期任务」');
    const sectionCase = { id: 'section', checks: [testCase.checks.find((item: any) => item.id === 'overdue-section')] };
    const answer = (content: string) => run({ artifacts: [
      { id: 'a_1', taskId: 'query', content: '## 逾期任务\n| 1 | Fix login |\n| 4 | Audit logs |', evidenceRefs: [] },
      { id: 'a_2', taskId: 'final', content, evidenceRefs: [] },
    ] });
    const check = (content: string) => checkRun(sectionCase, outcome(answer(content)), deps)[0];
    // As requested: results, then excluded rows in a sibling section; what-ifs elsewhere may mention other counts.
    const requested = [
      '# Project Pulse', '## 结论', '共 2 条逾期。若 Write docs 的状态被回退为 open，则逾期数将变为 3。',
      '## 逾期任务', '共 2 条（按 due 升序）：', '- Fix login，due 2026-11-08 [source_1]', '- Audit logs，due 2026-11-17 [source_1]',
      '## 被排除的行', '| 2 | Write docs | done | status 为 done |', '| 3 | Ship v2 | in_progress | 未来日期 |', '| 5 | Plan Q4 | open | tbd |',
    ].join('\n');
    expect(check(requested)).toMatchObject({ passed: true, detail: 'matches' });
    // Subsections belong to the results section: a sub-table inside it still counts as the result.
    expect(check('## 逾期任务\n### 明细\n- Fix login\n- Audit logs\n## 排除\n- Write docs')).toMatchObject({ passed: true });
    expect(check('## 逾期任务\n- Fix login\n- Audit logs\n### 排除\n- Write docs')).toMatchObject({ passed: false, detail: 'found: Write docs' });
    // Codex review on #232: a wrong overdue list fails even when an excluded count happens to be 2.
    const wrong = '## 逾期任务（总数：3）\nFix login、Write docs、Audit logs [source_1]\n## 已排除\n已排除共 2 条：Ship v2、Plan Q4 [source_1]';
    expect(check(wrong)).toMatchObject({ passed: false, detail: 'found: Write docs' });
    expect(check('## 逾期任务\n- Audit logs\n## 已排除\n- Fix login')).toMatchObject({ passed: false, detail: 'missing: Fix login' });
    // Not following the requested layout fails, with the reason.
    expect(check('逾期未完成任务共 2 条：\n- Fix login\n- Audit logs')).toMatchObject({ passed: false, detail: 'no section headed /^##\\s*逾期任务/' });
  });

  it('matches nested log fields partially', () => {
    expect(partialMatch({ filters: [{ op: 'lt', effective: true, passed: 2 }] }, { filters: { op: 'lt', effective: true } })).toBe(true);
    expect(partialMatch({ filters: [{ op: 'lt', effective: false }] }, { filters: { op: 'lt', effective: true } })).toBe(false);
  });

  it('compares two reports case by case and check by check', () => {
    const report = (status: string, passed: boolean, tokens: number) => ({ startedAt: 'x', status, model: { model: 'm' }, cases: [{ id: 'a', status, usage: { tokens }, durationMs: 1, checks: [{ id: 'refs', passed, detail: 'd' }] }] });
    const diff = compareReports(report('passed', true, 10), report('failed', false, 12));
    expect(diff.rows).toEqual([{ caseId: 'a', change: 'status', before: 'passed', after: 'failed', checks: [{ checkId: 'refs', before: true, after: false, detail: 'd' }], tokens: { before: 10, after: 12 }, durationMs: { before: 1, after: 1 } }]);
    expect(compareReports(report('passed', true, 10), report('passed', true, 10)).rows[0].change).toBe('same');
  });
});

describe('chat reply cases', () => {
  const chatCase = (checks: unknown[]) => ({ id: 'chat-x', request: { chat: { system: 'team-reply', input: {} } }, budget: { timeoutMs: 10_000 }, checks });
  it('score the reply text, its fields, its length and how long it took', () => {
    const testCase = chatCase([
      { id: 'names', kind: 'replyIncludes', any: ['密钥'], none: ['我已经'] },
      { id: 'split', kind: 'replyField', field: 'tasks', min: 2, oneOf: ['小研', '小文'], key: 'for' },
      { id: 'short', kind: 'replyLength', maxChars: 10 },
      { id: 'fast', kind: 'withinBudget' },
    ]);
    const outcome = { chat: { reply: { reply: '在等供应商的密钥', tasks: [{ title: '查定价', for: '小研' }, { title: '列风险', for: 'AEEIS' }] }, usage: [{ inputTokens: 100, outputTokens: 20 }] }, logs: [], durationMs: 12_000 };
    const checks = checkRun(testCase, outcome, deps);
    expect(Object.fromEntries(checks.map((check: any) => [check.id, check.passed]))).toEqual({ 'reply-format': true, names: true, split: false, short: true, fast: false });
    expect(checks.find((check: any) => check.id === 'split').detail).toBe('tasks: 2 (not all in 小研, 小文)');
    const result = caseResult(testCase, outcome, checks);
    expect(result).toMatchObject({ status: 'failed', runId: null, usage: { modelCalls: 1, tokens: 120 }, reply: { reply: '在等供应商的密钥' } });
  });
  // Review on #238: the eval must read a reply the way the server does, or it passes replies the server refuses or acts on.
  it('fail a reply the server would refuse, before any other check', () => {
    const split = loadCases(root, ['chat-group-split'])[0];
    for (const reply of [{ reply: '已拆分。', tasks: [null, null] }, { reply: '已拆分。', tasks: [{ reason: '没有标题', for: '小研' }, { title: '写说明', for: '小文' }] }]) {
      const outcome = { chat: { reply, usage: [] }, logs: [], durationMs: 1_000 };
      const checks = checkRun(split, outcome, deps);
      expect(checks[0]).toMatchObject({ id: 'reply-format', required: true, passed: false });
      expect(checks.slice(1).every((check: any) => !check.passed)).toBe(true);
      expect(caseResult(split, outcome, checks).status).toBe('failed');
    }
  });
  it('count the tasks a reply proposes the way the server does: tasks, else proposeTask', () => {
    const thanks = loadCases(root, ['chat-dm-thanks'])[0];
    const proposing = { chat: { reply: { reply: '不客气！', proposeTask: { title: '新建发布报告', for: '小文' } }, usage: [] }, logs: [], durationMs: 1_000 };
    const checks = checkRun(thanks, proposing, deps);
    expect(checks.find((check: any) => check.id === 'no-task')).toMatchObject({ passed: false, detail: 'tasks: 1' });
    expect(caseResult(thanks, proposing, checks).status).toBe('failed');
    const both = { reply: '好', tasks: [{ title: '查定价', for: '小研' }, { title: '写说明', for: '小文' }], proposeTask: { title: '另一件' } };
    expect(chatReplyParsers({ replySchema, replyTasks })['team-reply'](both).value.tasks.map((task: any) => task.title)).toEqual(['查定价', '写说明']);
  });
  it('fail every check when no reply came back', () => {
    const testCase = chatCase([{ id: 'fast', kind: 'withinBudget' }]);
    const outcome = { chat: { reply: undefined, usage: [] }, logs: [], error: '回复没有生成', durationMs: 1_000 };
    const checks = checkRun(testCase, outcome, deps);
    expect(checks[0]).toMatchObject({ id: 'reply-format', passed: false, detail: '回复没有生成' });
    expect(caseResult(testCase, outcome, checks).status).toBe('error');
  });
});

describe('harness on the runtime with the fixture model over HTTP', () => {
  let child: ReturnType<typeof spawn>;
  let baseUrl = '';
  beforeAll(async () => {
    child = spawn(process.execPath, ['scripts/fixture-model.mjs'], { env: { ...process.env, AEEIS_FIXTURE_MODEL_HOST: '127.0.0.1', AEEIS_FIXTURE_MODEL_PORT: '0' }, stdio: ['ignore', 'pipe', 'ignore'] });
    baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture model did not start')), 15_000);
      child.stdout!.on('data', chunk => { const match = /listening at (\S+)/.exec(String(chunk)); if (match) { clearTimeout(timer); resolve(match[1]!); } });
    });
  });
  afterAll(() => { child?.kill('SIGTERM'); });

  it('runs a case to the end, approving only the plan, and scores it', async () => {
    const model = new HttpModelAdapter(baseUrl, 'aeeis-fixture/1', '', undefined, 30_000, undefined, true);
    const harness = { ...deps, root, clock: runClock, createEngine: () => { const repository = new InMemoryRunRepository(); return { repository, engine: new AgentEngine(repository, { model }) }; } };
    for (const id of ['pulse-json', 'pdf-profile-json']) {
      const testCase = loadCases(root, [id])[0];
      const outcome = await runCase(testCase, harness);
      const result = caseResult(testCase, outcome, checkRun(testCase, outcome, harness));
      expect(result.status, JSON.stringify(result.checks.filter((check: any) => !check.passed))).toBe('passed');
      expect(result.approvals).toBe(1);
      expect(result.usage.modelCalls).toBeGreaterThan(0);
    }
    // The fixture model does not read the Markdown blocker; the content check says so.
    const md = loadCases(root, ['pulse-md'])[0];
    const outcome = await runCase(md, harness);
    expect(checkRun(md, outcome, harness).find((check: any) => check.id === 'blocker-found').passed).toBe(false);
  }, 60_000);

  it('times a chat reply through the engine with the team chat prompt', async () => {
    const model = new HttpModelAdapter(baseUrl, 'aeeis-fixture/1', '', undefined, 30_000, undefined, true);
    const harness = { ...deps, root, chatSystems: { 'team-reply': REPLY_SYSTEM, 'discussion-reply': DISCUSSION_REPLY_SYSTEM },
      createEngine: () => { const repository = new InMemoryRunRepository(); return { repository, engine: new AgentEngine(repository, { model }) }; } };
    const testCase = loadCases(root, ['chat-group-split'])[0];
    const outcome = await runCase(testCase, harness);
    const result = caseResult(testCase, outcome, checkRun(testCase, outcome, harness));
    // The fixture front door deals the three parts to the two members in turn.
    expect(result.status, JSON.stringify(result.checks)).toBe('passed');
    expect(result.reply.tasks.map((task: any) => task.for)).toEqual(['小研', '小文', '小研']);
  }, 30_000);
});

describe('evals CLI', () => {
  it('records not_run and exits 2 when --live has no model credentials', () => {
    const out = mkdtempSync(join(tmpdir(), 'aeeis-evals-'));
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AEEIS_MODEL')));
      const result = spawnSync(process.execPath, ['scripts/evals.mjs', '--live', '--out', out], { env, encoding: 'utf8' });
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('not_run');
      const [file] = readdirSync(out);
      const report = JSON.parse(readFileSync(join(out, file!), 'utf8'));
      expect(report).toMatchObject({ schemaVersion: 'aeeis-eval-report/1', mode: 'live', status: 'not_run', cases: [] });
      expect(report.reason).toContain('AEEIS_MODEL_BASE_URL');
      const usage = spawnSync(process.execPath, ['scripts/evals.mjs'], { env, encoding: 'utf8' });
      expect(usage.status).toBe(2);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});
