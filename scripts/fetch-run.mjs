#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
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
  if (!input) throw new Error('Usage: node scripts/fetch-run.mjs <url|id>');
  let url;
  if (input.startsWith('//')) throw new Error('Protocol-relative URLs are not accepted');
  if (/^https?:\/\//i.test(input)) url = new URL(input);
  else {
    if (!env.AEEIS_BASE_URL) throw new Error('AEEIS_BASE_URL is required for a run ID or relative URL');
    url = new URL(input.startsWith('/') ? input : `/runs/${input}`, env.AEEIS_BASE_URL);
  }
  const share = url.pathname.match(/^\/share\/([A-Za-z0-9_-]{43})\/?$/);
  const run = url.pathname.match(/^\/runs\/(run_[a-f0-9-]{36})\/?$/);
  if (!share && !run) throw new Error('Expected /share/<token>, /runs/<id>, or a bare run ID');
  if (run && !env.AEEIS_TOKEN) throw new Error('AEEIS_TOKEN is required for an authenticated run URL or ID');
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) throw new Error('Only HTTPS (or loopback HTTP) AEEIS URLs are accepted');
  if (run) {
    // Never forward AEEIS_TOKEN to an origin other than the configured installation.
    if (!env.AEEIS_BASE_URL) throw new Error('AEEIS_BASE_URL is required to send AEEIS_TOKEN');
    if (url.origin !== new URL(env.AEEIS_BASE_URL).origin) throw new Error('Run URL origin does not match AEEIS_BASE_URL; refusing to send AEEIS_TOKEN');
  }
  url.pathname = share ? `/api/share/${share[1]}/debug-bundle` : `/api/runs/${run[1]}/debug-bundle`;
  url.search = ''; url.hash = ''; url.username = ''; url.password = '';
  return { url: url.href, headers: run ? { authorization: `Bearer ${env.AEEIS_TOKEN}` } : {} };
}
export async function fetchRun(input, env = process.env) {
  const target = resolveRunTarget(input, env);
  const response = await fetch(target.url, { headers: target.headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Debug bundle request failed (HTTP ${response.status})`);
  const bundle = await readBounded(response);
  const id = bundle.run?.id;
  if (!/^run_[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid run ID in debug bundle');
  const filename = `run-${id}.debug.json`;
  await writeFile(filename, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  return filename;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(await fetchRun(process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
