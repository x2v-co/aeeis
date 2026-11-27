import { describe, expect, it } from 'vitest';
import { populateRunLimitations } from '../src/runtime/run-limitations.js';
import { readableAnswer } from '../src/readable-answer.js';

/** A delivered partial Run whose second step never ran. Only the fields the suffix reads. */
function partialRun(title: string) {
  return {
    status: 'succeeded', partial: true, events: [], limitations: ['没有资料'],
    review: { verdict: 'accepted', summary: 'ok', issues: [] },
    plans: [{ nodes: [{ id: 'done', title: '读资料' }, { id: 'pending', title }] }],
    steps: [{ taskId: 'done', status: 'succeeded' }],
    artifacts: [{ id: 'a1', taskId: 'done', title: '答案', content: '结论如下。', evidenceRefs: [] }],
  } as any;
}

describe('the runtime\'s Unknown: suffix', () => {
  it.each(['Pending\nphase', '单行标题'])('stays one suffix however often it is written, and leaves the answer clean (%j)', title => {
    const run = partialRun(title);
    populateRunLimitations(run);
    populateRunLimitations(run);
    run.status = 'running'; populateRunLimitations(run); // Resumed: the suffix comes off while it runs.
    expect(run.artifacts[0].content).toBe('结论如下。');
    run.status = 'succeeded'; populateRunLimitations(run); populateRunLimitations(run);
    const content: string = run.artifacts[0].content;
    expect(content.match(/Unknown:/g)).toHaveLength(1);
    expect(content).toContain(`- Remaining work: ${title.replace(/\s+/g, ' ')}`);
    expect(readableAnswer(content)).toEqual({ text: '结论如下。', caveat: true });
  });
});
