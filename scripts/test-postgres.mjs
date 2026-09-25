import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (!process.env.AEEIS_TEST_DATABASE_URL) {
  console.error('Set AEEIS_TEST_DATABASE_URL to a PostgreSQL test database. Tests create and drop isolated schemas.');
  process.exit(1);
}
const testFiles = readdirSync('tests')
  .filter(name => /^postgres-.*\.test\.ts$/.test(name))
  .sort()
  .map(name => `tests/${name}`);
if (testFiles.length === 0) {
  console.error('No PostgreSQL integration tests found.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...testFiles], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
