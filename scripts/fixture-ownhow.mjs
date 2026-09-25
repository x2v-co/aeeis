#!/usr/bin/env node

/**
 * Development-only OwnHow CLI fixture. It exercises AEEIS's process boundary
 * without scanning or modifying the host's real Skill installation.
 */

import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const command = args[0];
const task = args[1] ?? 'fixture task';
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);

if (command === 'resolve') {
  process.stdout.write(JSON.stringify({
    methodId: 'project-pulse',
    methodVersion: 'fixture/1',
    digest: `ownhow-fixture:plan:${digest(task)}`,
    plan: { steps: ['inspect-supplied-evidence', 'produce-evidence-linked-deliverable'], runtime: valueAfter('--runtime') ?? 'codex', task },
  }) + '\n');
} else if (command === 'record') {
  const outcome = valueAfter('--outcome') ?? 'unknown';
  process.stdout.write(JSON.stringify({ id: `ownhow-fixture:receipt:${digest(`${task}:${outcome}`)}`, receiptId: `ownhow-fixture:receipt:${digest(`${task}:${outcome}`)}` }) + '\n');
} else if (command === 'propose') {
  process.stdout.write('[]\n');
} else if (command === 'apply') {
  process.stdout.write(JSON.stringify({ id: task, methodId: 'project-pulse', version: 'fixture/1' }) + '\n');
} else if (command === 'rollback') {
  process.stdout.write(JSON.stringify({ methodId: task, version: valueAfter('--version') ?? 'fixture/1' }) + '\n');
} else if (command === 'status') {
  process.stdout.write(JSON.stringify({ stateDir: valueAfter('--state') ?? null, components: 1, receipts: 0, methods: 1, pendingImports: 0 }) + '\n');
} else {
  process.stderr.write(`Unsupported fixture OwnHow command: ${command ?? '(missing)'}\n`);
  process.exitCode = 2;
}
