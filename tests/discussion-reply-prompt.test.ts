import { expect, it } from 'vitest';
import { DISCUSSION_REPLY_SYSTEM } from '../src/runtime/http.js';

it('asks the Bot to answer what was asked, and to mention its limits only when asked to act', () => {
  expect(DISCUSSION_REPLY_SYSTEM).toContain('只讨论，不执行、不批准');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('只回答对方这条消息问的或说的');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('不要主动说明你不能执行');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('对方要你动手时，再简短说明');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('{"reply":"..."}');
});
