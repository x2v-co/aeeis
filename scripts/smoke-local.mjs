#!/usr/bin/env node

const baseUrl = (process.env.AEEIS_BASE_URL ?? 'http://127.0.0.1:4323').replace(/\/$/, '');
const timeoutMs = Number(process.env.AEEIS_SMOKE_TIMEOUT_MS ?? 60_000);
const startedAt = Date.now();

function assertWithinTimeout() {
  if (Date.now() - startedAt > timeoutMs) {
    throw new Error(`Local smoke timed out after ${timeoutMs}ms`);
  }
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
  return body;
}

async function waitForRun(runId, statuses, { allowQueuedReservation = false } = {}) {
  while (true) {
    assertWithinTimeout();
    let run;
    try {
      run = await request(`/api/runs/${runId}`);
    } catch (error) {
      // A scheduler response may expose a durable queued reservation before
      // its create lease publishes the Run. The dispatch ID is trusted from
      // the scheduler response, so retry only this narrow not-yet-readable
      // window; permission and other HTTP failures remain fatal.
      if (!allowQueuedReservation || !(error instanceof Error) || !error.message.startsWith(`404 /api/runs/${runId}:`)) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    if (statuses.includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

async function approveRun(runId, options = {}) {
  const awaitingApproval = await waitForRun(runId, ['needs_approval', 'succeeded', 'failed', 'cancelled'], options);
  if (awaitingApproval.status !== 'needs_approval') {
    throw new Error(`Expected ${runId} to reach exact plan approval, got ${awaitingApproval.status}: ${awaitingApproval.error ?? ''}`);
  }
  const plan = awaitingApproval.plans?.at(-1);
  if (!plan?.hash) throw new Error(`Run ${runId} did not return a plan hash`);
  await request(`/api/runs/${runId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ planHash: plan.hash }),
  });
  return waitForRun(runId, ['succeeded', 'failed', 'cancelled']);
}

const health = await request('/health');
if (health.service !== 'aeeis-agent' || health.protocol !== 'aeeis-health/1') {
  throw new Error(`Local smoke target is not AEEIS: ${JSON.stringify(health)}`);
}
const readiness = await request('/readyz');
if (readiness.protocol !== 'aeeis-readiness/1' || readiness.status !== 'ready') {
  throw new Error(`AEEIS is not ready: ${JSON.stringify(readiness)}`);
}
const status = await request('/api/status');
if (status.executionProfile !== 'fixture' || status.runner !== 'LocalDispatcher') {
  throw new Error(`Local smoke requires the Fixture/LocalDispatcher profile: ${JSON.stringify({ executionProfile: status.executionProfile, runner: status.runner })}`);
}

const created = await request('/api/runs', {
  method: 'POST',
  body: JSON.stringify({
    goal: 'Local smoke: verify the AEEIS agent execution loop',
    materials: [{
      title: 'Local smoke source',
      source: 'smoke-local',
      content: 'The local Fixture Model must produce an evidence-bound deliverable.',
    }],
  }),
});
const completed = await approveRun(created.id);
if (completed.status !== 'succeeded') {
  throw new Error(`Expected a succeeded local smoke Run, got ${completed.status}: ${completed.error ?? ''}`);
}
const graphs = await request(`/api/runs/${created.id}/graphs`);
const summary = {
  runId: completed.id,
  status: completed.status,
  review: completed.review?.verdict,
  artifacts: completed.artifacts?.length ?? 0,
  planNodes: graphs.plan?.nodes?.length ?? 0,
  executionNodes: graphs.execution?.nodes?.length ?? 0,
  evidenceNodes: graphs.evidence?.nodes?.length ?? 0,
  evidenceEdges: graphs.evidence?.edges?.length ?? 0,
};
if (summary.review !== 'accepted' || summary.artifacts < 1 || summary.evidenceNodes < 1) {
  throw new Error(`Local smoke completed without the expected evidence-bound result: ${JSON.stringify(summary)}`);
}

const goal = await request('/api/goals', {
  method: 'POST',
  body: JSON.stringify({ title: `Local DAG smoke ${new Date().toISOString()}` }),
});
const domainPlan = await request(`/api/goals/${goal.id}/plans`, {
  method: 'POST',
  body: JSON.stringify({ nodes: [
    { id: 'inspect', title: 'Inspect smoke evidence', instruction: 'Inspect the supplied smoke evidence.' },
    { id: 'deliver', title: 'Deliver smoke result', instruction: 'Deliver the verified smoke result.', dependsOn: ['inspect'] },
  ] }),
});
const scheduled = await request(`/api/plans/${domainPlan.id}/schedule`, {
  method: 'POST',
  body: JSON.stringify({ materials: [{ title: 'DAG smoke source', source: 'smoke-local', content: 'A bounded source for DAG scheduling.' }] }),
});
const firstDispatch = scheduled.dispatches?.find(item => item.taskId === 'inspect');
if (!firstDispatch?.runId) throw new Error(`DAG scheduler did not dispatch the first task: ${JSON.stringify(scheduled)}`);
const firstTaskRun = await approveRun(firstDispatch.runId, { allowQueuedReservation: true });
if (firstTaskRun.status !== 'succeeded') throw new Error(`First DAG task did not succeed: ${firstTaskRun.status}: ${firstTaskRun.error ?? ''}`);

let secondDispatch;
while (true) {
  assertWithinTimeout();
  const scheduler = await request(`/api/plans/${domainPlan.id}/scheduler`);
  secondDispatch = scheduler.find(item => item.taskId === 'deliver' && item.runId);
  if (secondDispatch) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
const secondTaskRun = await approveRun(secondDispatch.runId, { allowQueuedReservation: true });
if (secondTaskRun.status !== 'succeeded') throw new Error(`Dependent DAG task did not succeed: ${secondTaskRun.status}: ${secondTaskRun.error ?? ''}`);

let finalGoal;
let finalPlan;
while (true) {
  assertWithinTimeout();
  finalGoal = await request(`/api/goals/${goal.id}`);
  finalPlan = await request(`/api/plans/${domainPlan.id}/snapshot`);
  const allTasksSucceeded = finalPlan.plan?.nodes?.length > 0
    && finalPlan.plan.nodes.every(node => node.status === 'succeeded');
  if (finalGoal.status === 'completed' && allTasksSucceeded) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
summary.dag = {
  goalId: goal.id,
  planId: domainPlan.id,
  firstTask: firstTaskRun.status,
  secondTask: secondTaskRun.status,
  goal: finalGoal.status,
  planTasks: finalPlan.plan.nodes.map(node => ({ id: node.id, status: node.status })),
};
console.log(JSON.stringify(summary, null, 2));
