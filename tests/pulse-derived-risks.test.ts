// Eval baseline 2026-11-19 (pulse-csv-followup, pulse-csv-large, pulse-r79-csv; deepseek-v4.1-flash): the heading
// "八、下一步（推断/建议）" was labelled "推断：", and every labelled line, wherever it stood, was copied into
// structured.risks. Each reviewer round rejected the pulse because its risks did not match the text, and all three Runs
// failed after two revisions. Headings stay unlabelled and only lines under a risk heading become derived risks.
import { describe, expect, it } from 'vitest';
import { deriveProseInferences, inferenceFidelityProblems, labelInferences } from '../src/runtime/sourceFidelityRules.js';
import type { ProjectPulseArtifact } from '../src/runtime/contracts.js';

const refs = ['source_tasks'];
const pulse = (items: Partial<ProjectPulseArtifact> = {}): ProjectPulseArtifact => ({ schemaVersion: 'project-pulse/1', progress: [], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [], ...items });
const content = [
  '# Project Pulse',
  '## 三、进展',
  '- 推断：按各状态行数加权，整体进度约 49.5%。',
  '## 四、风险',
  '- 推断：blocked 任务的截止日期都已过，交付可能延期。',
  '## 八、下一步（推断/建议）',
  '- 建议先核查 blocked 但 progress=100 的任务。',
].join('\n');

describe('Project Pulse risks derived from labelled prose', () => {
  it('labels claims but not headings, so a section title never becomes an inference', () => {
    const holder = { content };
    labelInferences(holder, pulse(), () => '', refs);
    expect(holder.content).toContain('## 八、下一步（推断/建议）');
    expect(holder.content).not.toContain('推断：八');
    expect(holder.content).toContain('- 推断：建议先核查 blocked 但 progress=100 的任务。');
  });

  it('derives risks only from lines under a risk heading; other labelled lines are warnings', () => {
    const holder = { content }, structured = pulse();
    labelInferences(holder, structured, () => '', refs);
    const result = deriveProseInferences(holder.content, structured, refs);
    expect(structured.risks.map(risk => risk.text)).toEqual(['推断：blocked 任务的截止日期都已过，交付可能延期。']);
    expect(result.derived).toBe(1);
    expect(result.warnings.join('\n')).toContain('整体进度约 49.5%');
    expect(result.warnings.join('\n')).toContain('建议先核查 blocked');
  });

  // Review on #239: a subheading inside the risk section is still the risk section, until a same- or higher-level heading.
  it('keeps a subheading inside its risk section until the next heading of the same or a higher level', () => {
    const structured = pulse();
    const nested = ['## 风险', '### 支付联调', '推断：支付联调可能延期。', '#### 细节', '推断：密钥可能下周才到。', '## 下一步', '### 联调', '推断：建议先催供应商。'].join('\n');
    const result = deriveProseInferences(nested, structured, refs);
    expect(structured.risks.map(risk => risk.text)).toEqual(['推断：支付联调可能延期。', '推断：密钥可能下周才到。']);
    expect(result.warnings.join('\n')).toContain('建议先催供应商');
  });

  // Eval pulse-r79-csv (2026-11-19): numbered paragraphs instead of markdown headings; owners and next actions were
  // re-added to risks after every revision and the Run failed after three review rounds.
  it('reads numbered Chinese section openers as sections, even after an added "推断：" label', () => {
    const structured = pulse();
    const numbered = [
      '一、当前进度（观察事实）：60 条工作项四种状态各 15 条。推断：按 workstream 命名前缀归类，涉及 payments、search 等方向。',
      '四、风险：其一，15/60 条目处于 blocked。推断：全部 60 条 due 均早于今天，交付可能延期。',
      '推断：六、负责人（仅按 owner 字段统计，不推断职级）：owner1 9 条、owner2 9 条。',
      '八、下一步行动（推断：建议，均未发生）：推断：建议统一发起 security review 的排期确认。',
      '推断：建议逐条核对 15 条 blocked 项的 owner。',
    ].join('\n');
    const result = deriveProseInferences(numbered, structured, refs);
    expect(structured.risks.map(risk => risk.text)).toEqual(['推断：全部 60 条 due 均早于今天，交付可能延期。']);
    expect(result.warnings.join('\n')).toContain('workstream 命名前缀');
    expect(result.warnings.join('\n')).toContain('建议逐条核对');
  });

  it('keeps a numbered list or bold label under a markdown risk heading inside the risk section', () => {
    const structured = pulse();
    const listed = ['## 风险', '一、支付：推断：支付联调可能延期。', '**依赖**', '推断：评审可能拖到下周。', '## 下一步', '一、催办：推断：建议先催供应商。'].join('\n');
    deriveProseInferences(listed, structured, refs);
    expect(structured.risks.map(risk => risk.text)).toEqual(['推断：支付联调可能延期。', '推断：评审可能拖到下周。']);
  });

  // Eval pulse-r79-csv (2026-11-19, third run): plain title lines; "下一步（均为基于来源的推断）" was auto-labelled and became a risk.
  it('reads a plain Project Pulse section title line as a section', () => {
    const structured = pulse();
    const plain = ['风险', '1) 推断：45 条未完成项均已逾期，交付可能延期。', '', '负责人', '推断：owner1 可能负荷偏高。', '', '推断：下一步（均为基于来源的推断）', '1) 推断：建议先确认 security review 的解除时间。'].join('\n');
    const result = deriveProseInferences(plain, structured, refs);
    expect(structured.risks.map(risk => risk.text)).toEqual(['推断：45 条未完成项均已逾期，交付可能延期。']);
    expect(result.warnings.join('\n')).toContain('owner1 可能负荷偏高');
    expect(result.warnings.join('\n')).not.toContain('下一步（均为基于来源的推断）');
  });

  it('does not take a short risk sentence or a citation line for a title', () => {
    const structured = pulse();
    deriveProseInferences(['## 风险', '- 推断：支付联调可能延期', 'CSV query results [source_1]'].join('\n'), structured, refs);
    expect(structured.risks.map(risk => risk.text)).toEqual(['推断：支付联调可能延期']);
  });

  it('still derives risks from content without headings', () => {
    const structured = pulse();
    deriveProseInferences('登录页已上线。\n推断：支付联调可能延期。', structured, refs);
    expect(structured.risks.map(risk => risk.text)).toEqual(['推断：支付联调可能延期。']);
  });

  it('does not report a heading as an unsourced general assumption', () => {
    const problems = inferenceFidelityProblems('## 通常的做法\n推断：通常先做压测。', pulse(), () => '', refs, { sourceless: true });
    expect(problems).toEqual([]);
  });
});
