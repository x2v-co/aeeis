#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const backupFile = process.argv[2] ?? process.env.AEEIS_BACKUP_FILE;
if (!backupFile) {
  console.error('Set AEEIS_BACKUP_FILE or pass a PostgreSQL custom-format backup path.');
  process.exit(1);
}
const file = resolve(backupFile);
const manifestPath = resolve(process.argv[3] ?? process.env.AEEIS_BACKUP_MANIFEST ?? `${file}.manifest.json`);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!manifest || manifest.schemaVersion !== 'aeeis-backup-manifest/1' || manifest.format !== 'postgres-custom') {
  throw new Error('Unsupported or invalid AEEIS backup manifest');
}
if (manifest.file && resolve(manifest.file) !== file) throw new Error('Backup path does not match manifest');
if (!Number.isInteger(manifest.bytes) || manifest.bytes < 1 || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
  throw new Error('Backup manifest has invalid size or SHA-256');
}
const metadata = await stat(file);
if (metadata.size !== manifest.bytes) throw new Error(`Backup size mismatch: expected ${manifest.bytes}, got ${metadata.size}`);
const bytes = await readFile(file);
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (sha256 !== manifest.sha256) throw new Error(`Backup SHA-256 mismatch: expected ${manifest.sha256}, got ${sha256}`);
await listArchive(file);
console.log(JSON.stringify({ status: 'verified', file, manifest: manifestPath, bytes: metadata.size, sha256 }, null, 2));

function listArchive(path) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('pg_restore', ['--list', path], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`pg_restore --list exited with status ${code ?? 'unknown'}${error.trim() ? `: ${error.trim()}` : ''}`)));
  });
}
