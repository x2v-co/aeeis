import { describe, expect, it } from 'vitest';
import { readableReply } from '../src/application/conversation-service.js';

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
});
