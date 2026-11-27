import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  expect(output).toContain('replay gate, startup gate, secrets restart and stack state isolation passed');
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
  // Only the API mounts the secrets directory, and it restarts when that directory changes (bin/_lib.sh).
  expect(stack.services.api.labels['aeeis.secrets-fingerprint']).toBe('${AEEIS_SECRETS_FINGERPRINT:-none}');
  expect(stack.services.api.volumes).toContain('${AEEIS_SECRETS_DIR:-./secrets}:/run/aeeis-secrets:ro');
  expect(stack.services.worker.volumes ?? []).not.toContain('${AEEIS_SECRETS_DIR:-./secrets}:/run/aeeis-secrets:ro');
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


test('secrets fingerprint fails rather than missing files it cannot read', async () => {
  const script = resolve('deploy/stack/bin/_secrets-fingerprint.py');
  const root = mkdtempSync(resolve(tmpdir(), 'aeeis-secrets-'));
  try {
    mkdirSync(resolve(root, 'ssh')); writeFileSync(resolve(root, 'local-tools.json'), '{}'); writeFileSync(resolve(root, 'ssh', 'key'), 'k');
    // Root may ignore file modes, so the permission error is simulated where the walk lists a directory.
    const run = (target: string, denied = '') => execute('python3', ['-I', '-c',
      'import os,runpy,sys\nreal=os.scandir\ndenied=sys.argv[2]\ndef scan(path="."):\n    if denied and os.path.basename(str(path).rstrip("/"))==denied: raise PermissionError(13,"Permission denied",str(path))\n    return real(path)\nos.scandir=scan\nsys.argv=[sys.argv[1],sys.argv[3]]\nrunpy.run_path(sys.argv[0],run_name="__main__")',
      script, denied, target], { encoding: 'utf8', timeout: 10_000 });
    const whole = (await run(root)).stdout.trim();
    expect(whole).toMatch(/^[a-f0-9]{16}$/);
    await expect(run(root, 'ssh')).rejects.toMatchObject({ stderr: expect.stringContaining('PermissionError') });
    await expect(run(root, root.split('/').pop()!)).rejects.toMatchObject({ stderr: expect.stringContaining('PermissionError') });
    // A file where the directory should be is not "absent" either.
    await expect(run(resolve(root, 'local-tools.json'))).rejects.toThrow();
    expect((await run(resolve(root, 'missing'))).stdout.trim()).toBe('absent');
  } finally { rmSync(root, { recursive: true, force: true }); }
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
