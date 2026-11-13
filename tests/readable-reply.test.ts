import { describe, expect, it } from 'vitest';
import { readableReply } from '../src/application/conversation-service.js';
import { answerArtifact, isStandInAnswer, readableAnswer } from '../src/readable-answer.js';

describe('what the chat shows of a Run\'s answer', () => {
  // Shaped like the production 番茄钟 reply: a summary block whose empty lists lost their brackets, evidence IDs and a tokened preview link.
  const answer = `{"schemaVersion":"website-builder/1","changedFiles":[{"path":"index.html","evidenceRefs":["executor_41f4988ad8f64ade7758389c89e0e1ef"]}],"preview":{"status":"started","url":"https://32800-abc.instabox.tech/?_token=ibp_sQxW-ODGOTx6Aih"},"validation":,"artifacts":,"blockers":,"unknowns":}

交付说明：

文件清单
- index.html：纯 HTML/JS 单页番茄钟，由编码代理创建 [executor_41f4988ad8f64ade7758389c89e0e1ef] [receipt_d263a1ee-43ba-46b1-a677-fa0ced584a05]。

预览地址
- 预览链接：https://32800-abc.instabox.tech/?_token=ibp_sQxW-ODGOTx6Aih [receipt_ce9e2834-4c35-4733-bdfb-b709ad4546fa, receipt_7c3194b2-54b7-4828-a732-5a5fe256a3ae]

功能说明 [source_56b610d3-2a65-4ac0-9c25-74cc23f779f4]
- 页面标题为「番茄钟」。`;

  it('keeps the prose and drops the summary block, evidence IDs and access tokens', () => {
    const text = readableReply(answer);
    expect(text.startsWith('交付说明：')).toBe(true);
    expect(text).toContain('- index.html：纯 HTML/JS 单页番茄钟，由编码代理创建。');
    expect(text).toContain('- 预览链接：（预览链接见详情）');
    expect(text).toContain('功能说明\n- 页面标题为「番茄钟」。');
    expect(text).not.toMatch(/schemaVersion|receipt_|executor_|source_|_token|ibp_/);
  });
  it('leaves ordinary text, brackets and links alone', () => {
    const plain = '结果见 [第 2 节] 和 https://example.com/docs?page=2。\n\n{这不是 JSON}';
    expect(readableReply(plain)).toBe(plain);
    // JSON the owner asked for is the answer itself.
    expect(readableReply('{"a":1}\n\n说明')).toBe('{"a":1}\n\n说明');
  });
  it('never returns an empty reply', () => {
    expect(readableReply('[receipt_d263a1ee-43ba-46b1-a677-fa0ced584a05]')).toBe('[receipt_d263a1ee-43ba-46b1-a677-fa0ced584a05]');
  });
  it('drops the runtime\'s partial-answer caveats and says they were there', () => {
    const partial = 'Partial answer — limited evidence: 本次未提供任何源材料.\n\n你好，我是 AEEIS。\n\n有需要请直接说。\n\nUnknown:\n- Remaining work: unverified or omitted items listed below.\n- 本次未提供任何源材料';
    expect(readableAnswer(partial)).toEqual({ text: '你好，我是 AEEIS。\n\n有需要请直接说。', caveat: true });
    expect(readableAnswer('结论如下。')).toEqual({ text: '结论如下。', caveat: false });
  });
  it('keeps a model\'s own Unknown: section and what follows it', () => {
    const report = '进展如下。\n\nUnknown:\n- Remaining work: 第三节还没写\n\nConclusions:\n- 可以先发前两节';
    expect(readableAnswer(report)).toEqual({ text: report, caveat: false });
  });
  it('keeps a caveat that has no answer behind it', () => {
    const empty = 'Partial answer — limited evidence: 超时.\n\nFinal synthesis was unavailable. The following are untrusted observations.';
    expect(readableAnswer(empty)).toEqual({ text: empty, caveat: false });
  });
  it('treats a failed step\'s runtime note as no answer, and picks the last real one', () => {
    const real = { content: 'Partial answer — limited evidence: 没点过按钮.\n\n番茄钟做好了。' };
    const notes = [
      { content: 'Partial answer — repair exhausted for "汇总交付结果".\n\nUnknown: nothing verified.' },
      { content: 'Partial answer — no output.\n\nUnknown: task "汇总" produced no model output.' },
      { content: 'Partial answer — limited evidence: 超时.\n\nFinal synthesis was unavailable. Observations follow.' },
    ];
    for (const note of notes) expect(isStandInAnswer(note.content)).toBe(true);
    expect(isStandInAnswer(real.content)).toBe(false);
    expect(answerArtifact([real, ...notes])).toBe(real);
    expect(answerArtifact([{ content: '旧答案' }, real])).toBe(real);
    // Only notes: the last one is all there is, so it is shown rather than nothing.
    expect(answerArtifact(notes)).toBe(notes[2]);
    expect(answerArtifact([])).toBeUndefined();
  });
});
