#!/usr/bin/env node
// Single-host stack smoke (deploy/stack). Verifies, against a production-mode
// API with the Temporal runner:
//   1. API /readyz ready, TemporalDispatcher healthy, Worker RUNNING;
//   2. one Run: plan -> exact approval -> execution -> review accepted -> succeeded
//      (driven by agentRunWorkflow on the configured task queue);
//   3. one Reminder: Temporal reminderWorkflow timer -> outbox -> HTTP sink
//      delivered (externalId returned by the sink).
// Prints a JSON summary including the Temporal workflow IDs, which
// bin/smoke.sh exports for the replay gate.
const baseUrl = (process.env.AEEIS_BASE_URL ?? 'http://127.0.0.1:4323').replace(/\/$/, '');
const workerUrl = (process.env.AEEIS_WORKER_URL ?? 'http://127.0.0.1:4324').replace(/\/$/, '');
const token = process.env.AEEIS_ACCESS_TOKEN ?? '';
const timeoutMs = Number(process.env.AEEIS_SMOKE_TIMEOUT_MS ?? 180_000);
const startedAt = Date.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!token) throw new Error('AEEIS_ACCESS_TOKEN is required (production stack enforces authentication)');

function assertWithinTimeout(stage) {
  if (Date.now() - startedAt > timeoutMs) throw new Error(`Stack smoke timed out after ${timeoutMs}ms during ${stage}`);
}

async function request(path, init = {}, base = baseUrl, auth = true) {
  const remaining = Math.max(1_000, timeoutMs - (Date.now() - startedAt));
  const response = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(Math.min(30_000, remaining)),
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text.slice(0, 2000)}`);
  return body;
}

async function waitFor(stage, probe) {
  let last;
  while (true) {
    assertWithinTimeout(stage);
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(500);
    if (last && Date.now() - startedAt > timeoutMs) throw last;
  }
}

const readiness = await waitFor('api readiness', async () => {
  const body = await request('/readyz');
  if (body.protocol !== 'aeeis-readiness/1') throw new Error(`Not an AEEIS API: ${JSON.stringify(body)}`);
  return body.status === 'ready' ? body : undefined;
});
const worker = await waitFor('worker readiness', async () => {
  const body = await request('/readyz', {}, workerUrl, false);
  return body.protocol === 'aeeis-worker-readiness/1' && body.status === 'ready' && body.workerState === 'RUNNING' ? body : undefined;
});
const status = await request('/api/status');
if (status.runner !== 'TemporalDispatcher' || status.dispatcherHealth?.ready !== true) {
  throw new Error(`Stack smoke requires a ready TemporalDispatcher: ${JSON.stringify({ runner: status.runner, dispatcherHealth: status.dispatcherHealth })}`);
}
if (status.executionProfile === 'fixture') throw new Error('Stack must run with AEEIS_DEMO_MODE=0 (production profile)');

// 1. Run
const runRef = await request('/api/runs', {
  method: 'POST',
  headers: { 'idempotency-key': `stack-smoke-run-${Date.now()}` },
  body: JSON.stringify({
    goal: 'Stack smoke: verify the AEEIS Temporal execution loop',
    materials: [{ title: 'Stack smoke source', source: 'smoke-stack', content: 'The configured model must produce an evidence-bound deliverable.' }],
  }),
});
const awaiting = await waitFor('run plan approval', async () => {
  const run = await request(`/api/runs/${runRef.id}`);
  if (['failed', 'cancelled', 'succeeded'].includes(run.status)) throw new Error(`Run reached ${run.status} before approval: ${run.error ?? ''}`);
  return run.status === 'needs_approval' ? run : undefined;
});
const planHash = awaiting.plans?.at(-1)?.hash;
if (!planHash) throw new Error('Run did not expose a plan hash');
await request(`/api/runs/${runRef.id}/approve`, { method: 'POST', body: JSON.stringify({ planHash, planVersion: awaiting.plans.at(-1).version }) });
const run = await waitFor('run completion', async () => {
  const value = await request(`/api/runs/${runRef.id}`);
  return ['succeeded', 'failed', 'cancelled'].includes(value.status) ? value : undefined;
});
if (run.status !== 'succeeded' || run.review?.verdict !== 'accepted' || !(run.artifacts?.length > 0)) {
  throw new Error(`Run did not succeed with an accepted review: ${JSON.stringify({ status: run.status, review: run.review?.verdict, error: run.error })}`);
}

// 2. Reminder
const reminderRef = await request('/api/reminders', {
  method: 'POST',
  body: JSON.stringify({
    title: 'Stack smoke reminder',
    message: 'Verify the Temporal reminder workflow and projection sink.',
    dueAt: new Date(Date.now() + 3_000).toISOString(),
    channel: 'stack-smoke',
    destination: 'fixture-sink',
    idempotencyKey: `stack-smoke-reminder-${Date.now()}`,
  }),
});
const reminder = await waitFor('reminder projection', async () => {
  const value = await request(`/api/reminders/${reminderRef.id}`);
  if (value.status === 'failed' || value.status === 'cancelled') throw new Error(`Reminder ${value.status}: ${value.lastError ?? ''}`);
  return value.status === 'projected' ? value : undefined;
});
// AEEIS has no background delivery pump yet: the outbox is drained only via
// POST /api/collaborations/projections/deliver-pending (or /:id/deliver).
// The smoke uses that operator path; an automatic pump is a separate change.
const projection = await waitFor('projection delivery', async () => {
  await request('/api/collaborations/projections/deliver-pending', { method: 'POST', body: JSON.stringify({ limit: 20 }) });
  const events = await request('/api/collaborations/projections?limit=100');
  const list = Array.isArray(events) ? events : events.items ?? [];
  const match = list.find(event => event.id === reminder.projectionId || event.idempotencyKey?.startsWith(`reminder:${reminder.id}`));
  return match?.status === 'delivered' ? match : undefined;
});
if (!String(projection.externalId ?? '').startsWith('fixture-sink:') && process.env.AEEIS_SMOKE_EXPECT_FIXTURE_SINK !== '0') {
  throw new Error(`Projection was not acknowledged by the fixture sink: ${JSON.stringify(projection)}`);
}

console.log(JSON.stringify({
  protocol: 'aeeis-stack-smoke/1',
  status: 'passed',
  elapsedMs: Date.now() - startedAt,
  readiness: readiness.status,
  worker: { state: worker.workerState, taskQueue: worker.taskQueue, buildId: worker.buildId },
  run: { id: run.id, status: run.status, review: run.review?.verdict, artifacts: run.artifacts.length },
  reminder: { id: reminder.id, status: reminder.status, projectionId: reminder.projectionId, projection: projection.status, externalId: projection.externalId },
}, null, 2));
