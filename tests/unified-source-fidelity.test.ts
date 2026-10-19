import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { inferenceFidelityProblems, maxSourceUnknowns, normalizeSourceUnknowns, sourceFidelityGuidance, deriveProseInferences } from '../src/runtime/sourceFidelityRules.js';
import type { ProjectPulseArtifact } from '../src/runtime/contracts.js';
import type { ModelRequest } from '../src/runtime/model.js';
import { stripRuntimeUnknown } from '../src/runtime/run-limitations.js';

afterEach(() => vi.restoreAllMocks());
const pulse = (items: Partial<ProjectPulseArtifact> = {}): ProjectPulseArtifact => ({ schemaVersion: 'project-pulse/1', progress: [], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [], ...items });
const nodes = ['read_csv', 'analyze_owners_dates', 'synthesis'].map((id, index, ids) => ({ id, title: id, instruction: id, dependsOn: index ? [ids[index - 1]!] : [] }));

async function fixture(source: { title: string; content: string }, decide: (input: any) => unknown, multiTask = false, limited = false, iterations = false) {
  const logs: any[] = [];
  vi.spyOn(console, 'warn').mockImplementation(line => logs.push(JSON.parse(String(line))));
  const repository = new InMemoryRunRepository();
  const systems: { executor: string[]; reviewer: string[] } = { executor: [], reviewer: [] };
  const reviewerInputs: any[] = [];
  const complete = vi.fn(async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Pulse', nodes: multiTask ? nodes : [nodes[0]] } };
    if (request.system.includes('Independently review')) { systems.reviewer.push(request.system); reviewerInputs.push(request.input); return { value: { verdict: 'accepted', summary: 'Evidence supported' } }; }
    systems.executor.push(request.system);
    return { value: decide(request.input) };
  });
  const engine = new AgentEngine(repository, { model: { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete }, ...(iterations ? { executionLimits: { maxNodeIterations: 8 } } : limited ? { executionLimits: { maxNodeSourcePages: 1 } } : {}) });
  const created = await engine.create({ goal: '项目进展', builtinSkill: 'project-pulse/1', materials: [{ ...source, source: 'upload' }] }, 'owner', 'local');
  await engine.advance(created.id);
  await engine.command(created.id, 'approve', { planHash: (await repository.get(created.id)).plans[0]!.hash, planVersion: (await repository.get(created.id)).plans[0]!.version });
  for (let attempt = 0; attempt < 20; attempt++) if (['succeeded', 'failed'].includes(await engine.advance(created.id))) break;
  return { run: await repository.get(created.id), logs, systems, reviewerInputs };
}

describe('production source-fidelity regressions', () => {
  it('emits output.fidelity API logs even when no inferences were labelled', async () => {
    const { run, logs } = await fixture({ title: 'notes.txt', content: '开发完成' }, input => {
      const ref = input.sourceCatalog[0].id;
      return { type: 'finish', title: 'Pulse', content: '开发完成', evidenceRefs: [ref], artifactType: 'project-pulse/1', structured: pulse({ progress: [{ text: '开发完成', evidenceRefs: [ref] }] }) };
    });
    expect(run.status, run.error).toBe('succeeded');
    expect(logs).toContainEqual(expect.objectContaining({ protocol: 'aeeis-output-fidelity/1', runId: run.id, labeled: 0, paths: [] }));
    expect(logs.filter(log => log.protocol === 'aeeis-inference-autolabel/1')).toEqual([]);
  });

  it('run_2867fbfd: labels risks and body before review without repair on a limited CSV finish', async () => {
    const { run, logs, reviewerInputs, systems } = await fixture({ title: 'tasks.csv', content: 'status,due\nopen,10-20' }, input => {
      const ref = input.sourceCatalog[0].id;
      if (!input.executionBudget.finalOnly) return { type: 'tool', tool: 'sources.csvQuery', argument: ref };
      return { type: 'finish', title: 'Pulse', content: '可能需要调整顺序', evidenceRefs: [ref], artifactType: 'project-pulse/1', structured: pulse({ risks: [{ text: '预计可能延期', evidenceRefs: [ref] }] }) };
    }, false, true);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.events.some(event => event.type === 'artifact.repair_requested')).toBe(false);
    expect(run.artifacts[0]?.content).toContain('推断：可能需要调整顺序');
    expect(run.artifacts[0]?.structured).toMatchObject({ risks: [{ text: '推断：预计可能延期', derived: true }, { text: '推断：可能需要调整顺序', derived: true }] });
    expect(logs.filter(log => log.rule === 'inference_label')).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ protocol: 'aeeis-output-fidelity/1', runId: run.id, labeled: 2, paths: ['structured.risks[0].text', 'content[0][0]'] }));
    expect(logs).toContainEqual(expect.objectContaining({ protocol: 'aeeis-inference-autolabel/1', runId: run.id, labeled: 2, paths: ['structured.risks[0].text', 'content[0][0]'] }));
    expect(logs).toContainEqual(expect.objectContaining({ protocol: 'aeeis-finish-content-check/1', autoLabeledInferences: 2 }));
    // r79 md: the reviewer judges the model's content; the runtime Unknown: suffix is attached only after acceptance.
    expect(run.artifacts[0]?.content).toContain('\n\nUnknown:\n- Remaining work:');
    expect(reviewerInputs[0].artifacts[0]).toMatchObject({ ...run.artifacts[0], content: stripRuntimeUnknown(run.artifacts[0]!.content), hash: expect.any(String) });
    expect(reviewerInputs[0].fidelityNotes).toEqual([{ taskId: 'read_csv', labeled: 2, paths: ['structured.risks[0].text', 'content[0][0]'] }]);
    expect(systems.reviewer[0]).toContain('不能让无依据的断言冒充事实');
    expect(systems.reviewer[0]).toContain('Do not require revision solely for inference label wording or format');
    expect(systems.reviewer[0]).toContain('Reject unsupported assertions presented as fact');
  });
  it('run_597734ec: repeated weather searches finish early and accept missing inference label', async () => {
    const { run, logs } = await fixture({ title: 'weather.txt', content: '北京天气资料有限，明天天气未确认' }, input => {
      const ref = input.sourceCatalog[0].id;
      if (!input.executionBudget.finalOnly) return { type: 'tool', tool: 'sources.search', argument: '天气' };
      return { type: 'finish', title: '北京明天天气', content: '可能有降雨，天气未确认', evidenceRefs: [ref], artifactType: 'project-pulse/1', structured: pulse() };
    }, false, false, true);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.calls.filter(call => call.phase === 'executor')).toHaveLength(4);
    expect(run.artifacts[0]?.limitations).toContain('Repeated tool calls made no progress');
    expect(run.events.some(event => event.type === 'artifact.repair_requested')).toBe(false);
    expect(run.artifacts[0]?.content).toContain('推断：可能有降雨');
    expect(logs).toContainEqual(expect.objectContaining({ protocol: 'aeeis-inference-autolabel/1', runId: run.id, paths: ['content[0][0]'] }));
  });

  it.each([false, true])('run_3ed71d04: maps artifact refs after string coercion, including intermediate and limited finishes (limited=%s)', async limited => {
    const { run, logs } = await fixture({ title: 'tasks.csv', content: 'owner,deadline\n李,10-20 至 10-25' }, input => {
      const sourceRef = input.sourceCatalog[0].id;
      if (limited && input.task.id === 'analyze_owners_dates' && !input.executionBudget.finalOnly) return { type: 'tool', tool: 'sources.csvQuery', argument: sourceRef };
      const refs = input.dependencies.length ? [input.dependencies[0].id] : [sourceRef];
      const structured = input.task.id === 'analyze_owners_dates' ? pulse({
        deadlines: [{ text: '交付', date: '10-20 至 10-25', evidenceRefs: refs }],
        unknowns: ['负责人职责未说明', { text: 'csvQuery 结果被截断', evidenceRefs: refs }] as any,
        risks: [{ text: '无证据的结论', evidenceRefs: ['artifact_unresolved'] }],
      }) : input.task.id === 'synthesis' ? pulse() : undefined;
      return { type: 'finish', title: '项目', content: '项目资料已整理', evidenceRefs: refs, ...(structured ? { artifactType: 'project-pulse/1', structured } : {}) };
    }, true, limited);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.partial).toBe(true); // Runtime represents partial status as succeeded + partial.
    const sourceRef = run.context.sources[0]!.id;
    const artifact = run.artifacts.find(item => item.taskId === 'analyze_owners_dates')!;
    expect(artifact.evidenceRefs).toEqual([sourceRef]);
    expect(artifact.partial).toBe(true);
    expect(artifact.limitations).toContain('csvQuery 结果被截断');
    expect(artifact.limitations?.join(' ')).toContain('Unavailable evidence refs removed');
    expect(run.events).toContainEqual(expect.objectContaining({ type: 'artifact.evidence_pruned', data: { taskId: 'analyze_owners_dates', invalidRefs: ['artifact_unresolved'] } }));
    expect(artifact.structured).toMatchObject({ deadlines: [{ date: '10-20 至 10-25', evidenceRefs: [sourceRef] }], unknowns: [{ text: '负责人职责未说明', evidenceRefs: [sourceRef] }], risks: [] });
    expect(run.artifacts[2]!.evidenceRefs).toEqual([sourceRef]);
    expect(logs.find(log => log.protocol === 'aeeis-finish-content-check/1' && log.taskId === 'analyze_owners_dates')).toMatchObject({ movedUnknowns: 1 });
    expect(logs.find(log => log.protocol === 'aeeis-finish-evidence-check/1' && log.taskId === 'analyze_owners_dates')).toMatchObject({ removedRefs: 1, droppedClaims: 1 });
    for (const protocol of ['aeeis-finish-content-check/1', 'aeeis-finish-evidence-check/1']) {
      const checks = logs.filter(log => log.protocol === protocol);
      expect(checks).toHaveLength(3);
      expect(checks.map(log => log.result)).toEqual(['ok', 'fixed', protocol.includes('evidence') ? 'fixed' : 'ok']);
    }
  });

  it('run_843e7e3d: preserves 10-20, shares the rules in both prompts, and labels nextActions inference', async () => {
    const { run, systems, logs } = await fixture({ title: 'plan.md', content: '# 计划\n截止 10-20，开发完成后测试' }, input => {
      const ref = input.sourceCatalog[0].id;
      return { type: 'finish', title: '项目', content: '截止 10-20', evidenceRefs: [ref], artifactType: 'project-pulse/1', structured: pulse({
        deadlines: [{ text: '截止', date: '10-20', evidenceRefs: [ref] }],
        nextActions: [{ text: `${input.finishRepair ? '推断：' : ''}建议优先安排测试`, evidenceRefs: [ref] }],
      }) };
    });
    expect(run.status, run.error).toBe('succeeded');
    expect(run.artifacts[0]!.structured).toMatchObject({ deadlines: [{ date: '10-20' }], nextActions: [{ text: '推断：建议优先安排测试', derived: true }] });
    expect(run.events.some(event => event.type === 'artifact.repair_requested')).toBe(false);
    expect(logs).toContainEqual(expect.objectContaining({ protocol: 'aeeis-inference-autolabel/1', runId: run.id, paths: ['structured.nextActions[0].text'] }));
    for (const system of [...systems.executor, ...systems.reviewer]) {
      expect(system.split(sourceFidelityGuidance)).toHaveLength(2);
      expect(system).not.toMatch(/(?:full date or leave empty|完整日期或留空)/i);
    }
    expect(systems.reviewer[0]).toContain('Reviewers must not demand a full date or an empty date');
    expect(logs.filter(log => log.protocol === 'aeeis-finish-content-check/1').map(log => log.result)).toEqual(['fixed']);
    expect(logs.filter(log => log.protocol === 'aeeis-finish-evidence-check/1')).toHaveLength(1);
  });

  it('run_3fdf9e2f: caps unknowns, repairs unsourced assumptions and derives prose counterparts', async () => {
    const { run, reviewerInputs } = await fixture({ title: 'notes.txt', content: '开发已完成，测试负责人、范围、日期尚未说明' }, input => {
      const ref = input.sourceCatalog[0].id;
      return { type: 'finish', title: '项目', content: input.finishRepair ? '开发已完成\n推断：可能需要调整测试顺序' : '负载测试通常在核心集成之后\n可能需要调整测试顺序', evidenceRefs: [ref], artifactType: 'project-pulse/1', structured: pulse({ unknowns: Array.from({ length: 40 }, (_, i) => `源文档未说明字段 ${i}`) as any }) };
    });
    expect(run.status, run.error).toBe('succeeded');
    expect((run.artifacts[0]!.structured as ProjectPulseArtifact).unknowns).toHaveLength(maxSourceUnknowns);
    const reason = run.events.find(event => event.type === 'artifact.repair_requested')?.data.reason;
    expect(reason).toContain('unsourced general assumption');
    expect(reason).not.toContain('prose inference requires a corresponding structured entry');
    expect(reviewerInputs[0].fidelityNotes).toEqual([{ taskId: 'read_csv', labeled: 1, paths: ['content[1][0]'] }]);
  });

  it('emits both check logs once for each schema-rejected finish', async () => {
    const { run, logs } = await fixture({ title: 'notes.txt', content: '开发完成' }, input => ({ type: 'finish', title: '项目', content: '开发完成', evidenceRefs: [input.sourceCatalog[0].id], artifactType: 'project-pulse/1', structured: { schemaVersion: 'project-pulse/1' } }));
    expect(run.status).toBe('succeeded');
    expect(run.partial).toBe(true);
    for (const protocol of ['aeeis-finish-content-check/1', 'aeeis-finish-evidence-check/1']) {
      expect(logs.filter(log => log.protocol === protocol).map(log => log.result)).toEqual(['rejected', 'ok']);
    }
  });

  it('preserves explicit finish.limitations and logs decision-schema rejection', async () => {
    const valid = await fixture({ title: 'notes.txt', content: '开发完成' }, input => ({ type: 'finish', title: '项目', content: '开发完成', evidenceRefs: [input.sourceCatalog[0].id], artifactType: 'project-pulse/1', structured: pulse(), limitations: ['工具读取范围受限'] }));
    expect(valid.run.status, valid.run.error).toBe('succeeded');
    expect(valid.run.artifacts[0]).toMatchObject({ partial: true, limitations: ['工具读取范围受限'], structured: { unknowns: [] } });
    const invalid = await fixture({ title: 'notes.txt', content: '开发完成' }, () => ({ type: 'finish', content: '', evidenceRefs: [] }));
    expect(invalid.run.status).toBe('failed');
    for (const protocol of ['aeeis-finish-content-check/1', 'aeeis-finish-evidence-check/1']) {
      expect(invalid.logs.filter(log => log.protocol === protocol).map(log => log.result)).toEqual(['rejected', 'rejected']);
    }
  });
});

describe('inference checks in every field', () => {
  it('derives each labelled sentence, accepts prefix aliases, and avoids duplicate entries', () => {
    const structured = pulse({ nextActions: [{ text: '推断：可能延期', evidenceRefs: ['s'] }] });
    const content = '推断:可能延期。推断：预计需要复核。\nInference: likely needs review.';
    expect(deriveProseInferences(content, structured, ['s'])).toEqual({ derived: 2, warnings: [] });
    expect(deriveProseInferences(content, structured, ['s'])).toEqual({ derived: 0, warnings: [] });
    expect(structured.risks.every(item => item.derived && item.evidenceRefs[0] === 's')).toBe(true);
    expect(inferenceFidelityProblems(content, structured, () => '开发完成', ['s'])).toEqual([]);
  });
  it('records a non-blocking warning when derivation cannot fit the artifact shape', () => {
    const content = 'Inference: likely needs review';
    expect(deriveProseInferences(content, undefined, ['s'])).toEqual({ derived: 0, warnings: [expect.stringContaining('no structured counterpart')] });
    expect(inferenceFidelityProblems(content, undefined, () => '开发完成', ['s'])).toEqual([]);
    const full = pulse({ risks: Array.from({ length: 30 }, () => ({ text: '开发完成', evidenceRefs: ['s'] })) });
    expect(deriveProseInferences(content, full, ['s']).warnings).toHaveLength(1);
    expect(full.risks).toHaveLength(30);
  });
  it.each(['progress', 'completedChanges', 'blockers', 'risks', 'decisions', 'nextActions', 'unknowns'] as const)('checks %s', field => {
    expect(inferenceFidelityProblems('', pulse({ [field]: [{ text: '可能延期', evidenceRefs: ['s'] }] }), () => '开发完成', ['s']).join(' ')).toContain('inference must start');
  });
  it('forbids general assumptions even when labelled, and derives missing prose counterparts', () => {
    expect(inferenceFidelityProblems('推断：负载测试通常在核心集成之后', pulse(), () => '开发完成', ['s']).join(' ')).toContain('unsourced general assumption');
    expect(inferenceFidelityProblems('推断：可能延期', pulse({ risks: [{ text: '推断：可能延期', evidenceRefs: ['s'] }] }), () => '开发完成', ['s'])).toEqual([]);
    const structured = pulse({ deadlines: [{ text: '截止', date: '10-20', evidenceRefs: ['s'] }] });
    expect(inferenceFidelityProblems('推断：可能在 10-20 延期', structured, () => '截止 10-20', ['s'])).toEqual([]);
    expect(deriveProseInferences('推断：可能在 10-20 延期', structured, ['s'])).toEqual({ derived: 1, warnings: [] });
    expect(structured.risks).toEqual([{ text: '推断：可能在 10-20 延期', evidenceRefs: ['s'], derived: true }]);
  });
  it('keeps source gaps about timeout policy in unknowns', () => {
    const structured = { unknowns: ['服务超时策略未说明', 'csvQuery 结果被截断'] };
    expect(normalizeSourceUnknowns(structured)).toEqual({ limitations: ['csvQuery 结果被截断'], moved: 1, capped: 0 });
    expect(structured.unknowns).toEqual(['服务超时策略未说明']);
  });
});
