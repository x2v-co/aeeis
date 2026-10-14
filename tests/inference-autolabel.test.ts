import { describe, expect, it } from 'vitest';
import { inferenceFidelityProblems, labelInferences } from '../src/runtime/sourceFidelityRules.js';
import { projectPulseArtifactSchema, type FillablePdfArtifact, type ProjectPulseArtifact, type WebsiteBuilderArtifact } from '../src/runtime/contracts.js';

const refs = ['source_tasks'];
const pulse = (items: Partial<ProjectPulseArtifact> = {}): ProjectPulseArtifact => ({ schemaVersion: 'project-pulse/1', progress: [], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [], ...items });

describe('deterministic inference labels', () => {
  it('run_8ead6d2b: labels CSV narratives and markdown sentences while preserving dates and evidence', () => {
    const structured = pulse({
      progress: [{ text: '开发完成', evidenceRefs: refs }, { text: '- 预计下周完成', evidenceRefs: refs }],
      nextActions: [{ text: '建议安排测试', evidenceRefs: refs }],
      deadlines: [{ text: '上线', date: '10-20', evidenceRefs: refs }, { text: '验收', date: '10-25', evidenceRefs: refs }, { text: '可能延后', date: '10-20 至 10-25', evidenceRefs: refs }],
      owners: [{ name: '李', responsibility: '建议负责验收', evidenceRefs: refs }],
    });
    const before = structuredClone(structured);
    const content = { content: '# 预计下周完成\n- 建议安排测试\n* 可能延后\n> 可能调整范围\n1. 建议复核。  可能延期；开发完成\n  - 预计交付 [source_tasks]  ' };
    const result = labelInferences(content, structured, () => '开发完成\n上线10-20', refs);
    expect(result.labeled).toBe(11);
    expect(result.paths).toContain('structured.deadlines[2].text');
    expect(content.content).toBe('# 推断：预计下周完成\n- 推断：建议安排测试\n* 推断：可能延后\n> 推断：可能调整范围\n1. 推断：建议复核。  推断：可能延期；开发完成\n  - 推断：预计交付 [source_tasks]  ');
    expect(structured.progress[1]).toMatchObject({ text: '推断：预计下周完成', derived: true });
    expect(structured.nextActions[0]?.derived).toBe(true);
    expect(structured.deadlines[2]?.derived).toBe(true);
    expect(structured.owners[0]).toMatchObject({ name: '李', responsibility: '推断：建议负责验收', derived: true });
    expect(structured.deadlines.map(item => item.date)).toEqual(before.deadlines.map(item => item.date));
    for (const key of ['progress', 'nextActions', 'deadlines', 'owners'] as const) expect(structured[key].map(item => item.evidenceRefs)).toEqual(before[key].map(item => item.evidenceRefs));
    expect(inferenceFidelityProblems(content.content, structured, () => '开发完成\n上线10-20', refs)).toEqual([]);
    expect(projectPulseArtifactSchema.parse(structured)).toEqual(structured);
    const labelled = structuredClone({ content, structured });
    expect(labelInferences(content, structured, () => '开发完成\n上线10-20', refs)).toMatchObject({ labeled: 0, paths: [] });
    expect({ content, structured }).toEqual(labelled);
  });

  it('run_b707484a: labels a TXT risk and content line', () => {
    const structured = pulse({ risks: [{ text: '可能导致上线延期', evidenceRefs: refs }] });
    const result = labelInferences('可能导致上线延期', structured, () => '核心集成尚未完成', refs);
    expect(result.labeled).toBe(2);
    expect(result.content).toBe('推断：可能导致上线延期');
    expect(structured.risks[0]?.derived).toBe(true);
    expect(inferenceFidelityProblems(result.content, structured, () => '核心集成尚未完成', refs)).toEqual([]);
  });

  it('leaves unsourced general assumptions as hard errors without relabelling', () => {
    const text = '负载测试通常在核心集成之后';
    const structured = pulse({ risks: [{ text, evidenceRefs: refs }] });
    const result = labelInferences(text, structured, () => '开发完成', refs);
    expect(result.labeled).toBe(0);
    expect(result.content).toBe(text);
    expect(structured.risks[0]?.text).toBe(text);
    expect(inferenceFidelityProblems(result.content, structured, () => '开发完成', refs)).toContain('content: unsourced general assumption is forbidden');
  });

  it('leaves verbatim source cues unchanged and respects item-specific evidence', () => {
    const text = '预计10-20上线';
    const structured = pulse({ deadlines: [{ text, date: '10-20', evidenceRefs: ['source_date'] }] });
    const result = labelInferences(`- ${text}`, structured, ids => ids.includes('source_date') ? text : '开发完成', ['source_date']);
    expect(result).toMatchObject({ content: `- ${text}`, labeled: 0, paths: [] });
    expect(structured.deadlines[0]).toEqual({ text, date: '10-20', evidenceRefs: ['source_date'] });
  });

  it('leaves all fillable-pdf structured values untouched', () => {
    const structured: FillablePdfArtifact = {
      schemaVersion: 'fillable-pdf/1', form: { sourceRef: 'source_form', fieldCount: 1 },
      filledFields: [{ name: '建议', value: '可能延期', evidenceRefs: refs }],
      unknowns: [{ field: '预计日期', text: '可能未提供', evidenceRefs: refs }],
      output: { filename: 'form.pdf', sha256: 'a'.repeat(64), sizeBytes: 20, ref: 'output_pdf' },
      blockers: [{ text: '建议提供资料', evidenceRefs: refs }],
    };
    const before = structuredClone(structured);
    expect(labelInferences('', structured, () => '', refs).labeled).toBe(0);
    expect(structured).toEqual(before);
  });

  it('preserves website paths, changedFiles and schema metadata', () => {
    const structured: WebsiteBuilderArtifact = { schemaVersion: 'website-builder/1', changedFiles: ['可能.html'], artifacts: [{ path: '建议/index.html', evidenceRefs: ['likely_ref'] }], validation: [], blockers: [{ text: '建议复核页面', evidenceRefs: refs }], unknowns: [] };
    labelInferences('', structured, () => '', refs);
    expect(structured).toEqual({ schemaVersion: 'website-builder/1', changedFiles: ['可能.html'], artifacts: [{ path: '建议/index.html', evidenceRefs: ['likely_ref'] }], validation: [], blockers: [{ text: '推断：建议复核页面', evidenceRefs: refs }], unknowns: [] });
  });
});
