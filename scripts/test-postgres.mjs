import { spawnSync } from 'node:child_process';

if (!process.env.AEEIS_TEST_DATABASE_URL) {
  console.error('Set AEEIS_TEST_DATABASE_URL to a PostgreSQL test database. Tests create and drop isolated schemas.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/postgres-domain.test.ts', 'tests/postgres-evolution.test.ts', 'tests/postgres-runtime.test.ts'], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
