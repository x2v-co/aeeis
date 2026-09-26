#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const stages = [
  ['typecheck', ['run', 'typecheck']],
  ['unit tests', ['run', 'test:serial']],
  ['build', ['run', 'build']],
];

if (process.env.AEEIS_VERIFY_POSTGRES === '1') {
  if (!process.env.AEEIS_TEST_DATABASE_URL) {
    console.error('AEEIS_VERIFY_POSTGRES=1 requires AEEIS_TEST_DATABASE_URL.');
    process.exit(2);
  }
  stages.push(['PostgreSQL integration tests', ['run', 'test:postgres']]);
}

if (process.env.AEEIS_VERIFY_MONITORING === '1') {
  stages.push(['monitoring configuration tests', ['run', 'test:monitoring']]);
}

if (process.env.AEEIS_VERIFY_FULL_LOCAL === '1') {
  stages.push(['full local protocol smoke', ['run', 'demo:full-local']]);
}

const startedAt = Date.now();
for (const [label, args] of stages) {
  console.log(`\n[verify] ${label}`);
  const result = spawnSync(npm, args, {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(`[verify] ${label} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[verify] ${label} failed with exit code ${result.status ?? 'unknown'}.`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\n[verify] passed ${stages.length} stage(s) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
