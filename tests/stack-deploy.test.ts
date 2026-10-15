import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { expect, test } from 'vitest';

const execute = promisify(execFile);

test('production stack deployment, online backup, notifications and systemd paths', async () => {
  const { stdout: output } = await execute('bash', [resolve('deploy/stack/bin/selftest.sh')], {
    encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL',
    // selftest.sh is hermetic but CPU-bound (~45s alone: hundreds of fake docker/python spawns);
    // under parallel vitest load on small hosts it exceeded 60s. Budget generously.
    // Exercise root-run containers mounting a checkout owned by the host user.
    env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' },
  }).catch((error: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`${error.message}\nstdout:\n${error.stdout ?? ''}\nstderr:\n${error.stderr ?? ''}`, { cause: error });
  });
  expect(output).toContain('replay gate and stack state isolation passed');
  expect(output).toContain('git commit build, label/tag fallback, env precedence and restart persistence passed');
  expect(output).toContain('post-pull startup metadata and unlabeled image environment preservation passed');
  expect(output).toContain('online atomic backups, failure exits, retention, notifications and configurable systemd paths passed');
}, 310_000);

test('container release metadata reaches both stack services without empty env_file overrides', () => {
  const stack = parse(readFileSync('deploy/stack/compose.yml', 'utf8'), { merge: true });
  const commit = parse(readFileSync('deploy/stack/compose.commit.yml', 'utf8'));
  for (const name of ['api', 'worker']) {
    expect(stack.services[name].environment).not.toHaveProperty('AEEIS_GIT_COMMIT');
    expect(commit.services[name].environment.AEEIS_GIT_COMMIT).toContain('${AEEIS_GIT_COMMIT:?');
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


test('workflow-list parser accepts CLI JSON, JSONL and envelopes and rejects ambiguous records', async () => {
  const record = { type: { name: 'agentRunWorkflow' }, execution: { workflowId: 'run', runId: 'execution' } };
  const parse = (input: string) => new Promise<string>((resolveOutput, reject) => {
    const child = execFile('python3', [resolve('deploy/stack/bin/_workflow-list.py')], { encoding: 'utf8', timeout: 5000 },
      (error, stdout) => error ? reject(error) : resolveOutput(stdout));
    child.stdin!.end(input);
  });
  expect(await parse(JSON.stringify([record]))).toBe('run\texecution\n');
  expect(await parse([record, record].map(r => JSON.stringify(r)).join('\n'))).toBe('run\texecution\nrun\texecution\n');
  expect(await parse(JSON.stringify({ executions: [record] }))).toBe('run\texecution\n');
  expect(await parse('[]')).toBe('');
  await expect(parse('')).rejects.toThrow();
  await expect(parse('{bad')).rejects.toThrow();
  await expect(parse(JSON.stringify([{ execution: { workflowId: 'run' } }]))).rejects.toThrow();
});
