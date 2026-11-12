import { expect, it } from 'vitest';
import { DISCUSSION_REPLY_SYSTEM } from '../src/runtime/http.js';

it('asks the Bot to answer what was asked, and to mention its limits only when asked to act', () => {
  expect(DISCUSSION_REPLY_SYSTEM).toContain('只讨论，不执行、不批准');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('只回答对方这条消息问的或说的');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('不要主动说明你不能执行');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('对方要你动手时，再简短说明');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('{"reply":"...","ask":{...},"handoff":{...}}');
});

it('lets a Bot in a private chat ask another Bot or suggest a handoff, only when it helps', () => {
  expect(DISCUSSION_REPLY_SYSTEM).toContain('给了 team');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('ask:{"to":"名字","question":"..."}');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('handoff:{"to":"名字","task":"任务标题","note":"为什么"}');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('要用户点头（或按你的自主程度）');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('不要为了用而用');
});
