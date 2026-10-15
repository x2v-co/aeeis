#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const isLoopback = host => host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
async function readBounded(response) {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BUNDLE_BYTES) throw new Error('Debug bundle exceeds size limit');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_BUNDLE_BYTES) throw new Error('Debug bundle exceeds size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function resolveRunTarget(input, env = process.env) {
  if (!input) throw new Error('Usage: node scripts/fetch-run.mjs <url|id> | --from-db <run_id>');
  let url;
  if (input.startsWith('//')) throw new Error('Protocol-relative URLs are not accepted');
  if (/^https?:\/\//i.test(input)) url = new URL(input);
  else {
    if (!env.AEEIS_BASE_URL) throw new Error('AEEIS_BASE_URL is required for an ID, share token or relative URL');
    const path = input.startsWith('/') ? input : /^thread_[a-f0-9-]{36}$/.test(input) ? `/threads/${input}` : /^[A-Za-z0-9_-]{43}$/.test(input) ? `/share/${input}` : `/runs/${input}`;
    url = new URL(path, env.AEEIS_BASE_URL);
  }
  const share = url.pathname.match(/^\/share\/([A-Za-z0-9_-]{43})\/?$/);
  const run = url.pathname.match(/^\/runs\/(run_[a-f0-9-]{36})\/?$/);
  const thread = url.pathname.match(/^\/threads\/(thread_[a-f0-9-]{36})\/?$/);
  if (!share && !run && !thread) throw new Error('Expected /share/<token>, /runs/<id>, /threads/<id>, a bare run/thread ID or share token');
  const authenticated = run || thread;
  if (authenticated && !env.AEEIS_TOKEN) throw new Error('AEEIS_TOKEN is required for an authenticated run/thread URL or ID');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) throw new Error('Only HTTPS (or loopback HTTP) AEEIS URLs are accepted');
  if (authenticated) {
    // Never forward AEEIS_TOKEN to an origin other than the configured installation.
    if (!env.AEEIS_BASE_URL) throw new Error('AEEIS_BASE_URL is required to send AEEIS_TOKEN');
    if (url.origin !== new URL(env.AEEIS_BASE_URL).origin) throw new Error('Run/thread URL origin does not match AEEIS_BASE_URL; refusing to send AEEIS_TOKEN');
  }
  url.pathname = share ? `/api/share/${share[1]}/debug-bundle` : thread ? `/api/threads/${thread[1]}/debug-bundle` : `/api/runs/${run[1]}/debug-bundle`;
  url.search = ''; url.hash = ''; url.username = ''; url.password = '';
  return { url: url.href, headers: authenticated ? { authorization: `Bearer ${env.AEEIS_TOKEN}` } : {} };
}
export async function fetchRun(input, env = process.env) {
  const target = resolveRunTarget(input, env);
  const response = await fetch(target.url, { headers: target.headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Debug bundle request failed (HTTP ${response.status})`);
  const bundle = await readBounded(response);
  const thread = bundle.kind === 'thread';
  const id = thread ? bundle.thread?.id : bundle.run?.id;
  if (thread ? !/^thread_[a-f0-9-]{36}$/.test(id) || bundle.schemaVersion !== 'aeeis-thread-debug-bundle/1' || !Array.isArray(bundle.runs) : !/^run_[a-f0-9-]{36}$/.test(id)) throw new Error(`Invalid ${thread ? 'thread' : 'run'} ID in debug bundle`);
  const filename = `${thread ? 'thread' : 'run'}-${id}.debug.json`;
  const file = await open(filename, 'w', 0o600);
  try { await file.chmod(0o600); await file.writeFile(`${JSON.stringify(bundle, null, 2)}\n`); }
  finally { await file.close(); }
  return filename;
}
const runIdPattern = /^run_[a-f0-9-]{36}$/;
/**
 * Read-only export straight from Postgres for operators inside the api
 * container (no access token, no curl). Uses a READ ONLY transaction, applies
 * the same redaction as /api/runs/:id/debug-bundle and writes a 0600 file.
 * deps.query / deps.debugBundle are injectable for tests.
 */
export async function exportRunFromDb(runId, env = process.env, deps = {}) {
  if (!runIdPattern.test(runId ?? '')) throw new Error('Usage: node scripts/fetch-run.mjs --from-db <run_id>');
  const debugBundle = deps.debugBundle ?? (await import(new URL('../dist/runtime/run-debug.js', import.meta.url).href)).debugBundle;
  let state;
  if (deps.query) state = await deps.query(runId);
  else {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for --from-db');
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN READ ONLY');
      state = (await client.query('SELECT state FROM aeeis_runs WHERE id=$1', [runId])).rows[0]?.state;
      await client.query('ROLLBACK');
    } finally { await client.end(); }
  }
  if (!state) throw new Error('Unknown run');
  const bundle = debugBundle(state);
  const filename = `run-${runId}.debug.json`;
  const file = await open(filename, 'w', 0o600);
  try { await file.chmod(0o600); await file.writeFile(`${JSON.stringify(bundle, null, 2)}\n`); }
  finally { await file.close(); }
  return filename;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(process.argv[2] === '--from-db' ? await exportRunFromDb(process.argv[3]) : await fetchRun(process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
