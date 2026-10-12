import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, test } from 'vitest';

test('production stack deployment, online backup, notifications and systemd paths', () => {
  const output = execFileSync('bash', [resolve('deploy/stack/bin/selftest.sh')], {
    encoding: 'utf8', timeout: 60_000,
  });
  expect(output).toContain('replay gate and stack state isolation passed');
  expect(output).toContain('git commit build, label/tag fallback, env precedence and restart persistence passed');
  expect(output).toContain('online atomic backups, failure exits, retention, notifications and configurable systemd paths passed');
}, 65_000);

test('container release metadata reaches both stack services without empty env_file overrides', () => {
  const stack = parse(readFileSync('deploy/stack/compose.yml', 'utf8'), { merge: true });
  for (const name of ['api', 'worker']) {
    expect(stack.services[name].environment.AEEIS_GIT_COMMIT).toContain('${AEEIS_GIT_COMMIT:?');
  }
  const production = parse(readFileSync('deploy/production/compose.yml', 'utf8'));
  for (const name of ['api', 'worker']) {
    expect(production.services[name].build.args.AEEIS_GIT_COMMIT).toBe('${AEEIS_GIT_COMMIT:-unknown}');
    expect(production.services[name].environment).not.toHaveProperty('AEEIS_GIT_COMMIT');
    expect(production.services[name].env_file).toBe('.env.production');
  }
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  expect(dockerfile).toContain('ARG AEEIS_GIT_COMMIT=unknown');
  expect(dockerfile).toContain('ENV AEEIS_GIT_COMMIT=${AEEIS_GIT_COMMIT}');
  expect(dockerfile).toContain('LABEL org.opencontainers.image.revision=${AEEIS_GIT_COMMIT}');
});


test('workflow-list parser accepts CLI JSON, JSONL and envelopes and rejects ambiguous records', () => {
  const record = { type: { name: 'agentRunWorkflow' }, execution: { workflowId: 'run', runId: 'execution' } };
  const parse = (input: string) => execFileSync('python3', [resolve('deploy/stack/bin/_workflow-list.py')], { encoding: 'utf8', input, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
  expect(parse(JSON.stringify([record]))).toBe('run\texecution\n');
  expect(parse([record, record].map(r => JSON.stringify(r)).join('\n'))).toBe('run\texecution\nrun\texecution\n');
  expect(parse(JSON.stringify({ executions: [record] }))).toBe('run\texecution\n');
  expect(parse('[]')).toBe('');
  expect(() => parse('')).toThrow();
  expect(() => parse('{bad')).toThrow();
  expect(() => parse(JSON.stringify([{ execution: { workflowId: 'run' } }]))).toThrow();
});
