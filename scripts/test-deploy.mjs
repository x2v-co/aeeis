#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

const workerOverride = process.env.AEEIS_TEST_MAX_WORKERS;
let workers = Math.max(1, availableParallelism() - 1);
if (workerOverride?.trim()) {
  const normalized = workerOverride.trim();
  workers = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(workers) || workers <= 0) {
    console.error('AEEIS_TEST_MAX_WORKERS must be a positive integer.');
    process.exit(2);
  }
}

const extraArgs = process.argv.slice(2);
const temporalTest = 'tests/temporal-workflow.test.ts';
const phases = [
  // Vitest 2.1 appends CLI --exclude to the config/default exclusions.
  ['phase 1 (other tests)', workers, ['--exclude', temporalTest]],
  ['phase 2 (Temporal workflow)', 1, [temporalTest]],
];

console.log(`[test:deploy] workers=${workers}; Temporal workflow runs separately with 1 worker.`);
let failed = false;
for (const [label, phaseWorkers, filters] of phases) {
  console.log(`\n[test:deploy] ${label}`);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run',
    '--pool=forks', `--maxWorkers=${phaseWorkers}`, '--minWorkers=1',
    ...filters, ...extraArgs,
  ], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(`[test:deploy] ${label} could not start: ${result.error.message}`);
  }
  const exitCode = result.status ?? 1;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[test:deploy] ${label}: exit code ${exitCode}, ${seconds}s, workers=${phaseWorkers}.`);
  if (result.error || exitCode !== 0) failed = true;
}

process.exitCode = failed ? 1 : 0;
