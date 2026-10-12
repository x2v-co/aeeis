import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test('production stack guards and image preflight fail closed', () => {
  const output = execFileSync('bash', [resolve('deploy/stack/bin/selftest.sh')], {
    encoding: 'utf8', timeout: 20_000,
  });
  expect(output).toContain('stack selftest:');
}, 25_000);
