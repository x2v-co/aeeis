const usage = 'Usage: node scripts/run-admin.mjs cancel <runId> [--reason TEXT] | reconcile <runId> [--apply] | reconcile --all [--apply] [--limit N]';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['cancel', 'reconcile'].includes(command)) throw new Error(usage);
  let runId, reason, limit, all = false, apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all' && command === 'reconcile' && !all) all = true;
    else if (arg === '--apply' && command === 'reconcile' && !apply) apply = true;
    else if (arg === '--reason' && command === 'cancel' && reason === undefined && args[i + 1] !== undefined) reason = args[++i];
    else if (arg === '--limit' && command === 'reconcile' && limit === undefined && args[i + 1] !== undefined) limit = Number(args[++i]);
    else if (!arg.startsWith('-') && runId === undefined) runId = arg;
    else throw new Error(usage);
  }
  if ((all ? runId !== undefined : !runId) || (limit !== undefined && (!all || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) || (reason?.length ?? 0) > 2000) throw new Error(usage);
  const token = process.env.AEEIS_TOKEN;
  if (!token) throw new Error('AEEIS_TOKEN is required');
  const baseUrl = (process.env.AEEIS_BASE_URL ?? 'http://127.0.0.1:4323').replace(/\/$/, '');
  const path = all ? '/api/admin/reconcile' : `/api/runs/${encodeURIComponent(runId)}/${command}`;
  const body = command === 'cancel' ? (reason === undefined ? {} : { reason }) : { dry_run: !apply, ...(all ? (limit === undefined ? {} : { limit }) : { source: 'temporal' }) };
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok) process.exitCode = 1;
}

try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : 'Run administration failed'); process.exitCode = 1; }
