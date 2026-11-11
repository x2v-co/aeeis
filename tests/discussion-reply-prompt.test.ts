import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DISCUSSION_REPLY_SYSTEM } from '../src/runtime/http.js';

it('asks the Bot to answer what was asked, and to mention its limits only when asked to act', () => {
  expect(DISCUSSION_REPLY_SYSTEM).toContain('只讨论，不执行、不批准');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('只回答对方这条消息问的或说的');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('不要主动说明你不能执行');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('对方要你动手时，再简短说明');
  expect(DISCUSSION_REPLY_SYSTEM).toContain('{"reply":"..."}');
});

it('is the instruction for both the reply to a new message and the sweep after a restart', () => {
  const source = readFileSync(new URL('../src/runtime/http.ts', import.meta.url), 'utf8');
  expect(source.match(/completeForBot\(\{\s*system: DISCUSSION_REPLY_SYSTEM,/g)).toHaveLength(2);
  // No second, drifting copy of the instruction.
  expect(source.match(/你是用户的 Bot。/g)).toHaveLength(1);
});
