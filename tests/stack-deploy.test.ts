import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test('production stack deployment, online backup, notifications and systemd paths', () => {
  const output = execFileSync('bash', [resolve('deploy/stack/bin/selftest.sh')], {
    encoding: 'utf8', timeout: 60_000,
  });
  expect(output).toContain('replay gate and stack state isolation passed');
  expect(output).toContain('online atomic backups, failure exits, retention, notifications and configurable systemd paths passed');
}, 65_000);


test('workflow-list parser accepts CLI JSON, JSONL and envelopes and rejects ambiguous records', () => {
  const record = { type: { name: 'agentRunWorkflow' }, execution: { workflowId: 'run', runId: 'execution' } };
  const parse = (input: string) => execFileSync('python3', [resolve('deploy/stack/bin/_workflow-list.py')], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  expect(parse(JSON.stringify([record]))).toBe('run\texecution\n');
  expect(parse([record, record].map(r => JSON.stringify(r)).join('\n'))).toBe('run\texecution\nrun\texecution\n');
  expect(parse(JSON.stringify({ executions: [record] }))).toBe('run\texecution\n');
  expect(parse('[]')).toBe('');
  expect(() => parse('')).toThrow();
  expect(() => parse('{bad')).toThrow();
  expect(() => parse(JSON.stringify([{ execution: { workflowId: 'run' } }]))).toThrow();
});
