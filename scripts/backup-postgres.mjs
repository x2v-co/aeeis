#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Set DATABASE_URL before creating a PostgreSQL backup.');
  process.exit(1);
}

const directory = process.env.AEEIS_BACKUP_DIR ?? 'backups';
await mkdir(directory, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replaceAll(/[^0-9]/g, '').slice(0, 14);
const output = join(directory, `aeeis-${stamp}.dump`);
await runPgDump(databaseUrl, output);
const bytes = await readFile(output);
const manifest = {
  schemaVersion: 'aeeis-backup-manifest/1',
  createdAt: new Date().toISOString(),
  format: 'postgres-custom',
  file: output,
  bytes: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const manifestPath = `${output}.manifest.json`;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(manifest));

function runPgDump(url, file) {
  return new Promise((resolve, reject) => {
    const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--file', file, url], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`pg_dump exited with status ${code ?? 'unknown'}`)));
  });
}
