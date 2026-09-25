const baseUrl = (process.env.AEEIS_BASE_URL ?? 'http://127.0.0.1:4323').replace(/\/$/, '');
const workerUrl = (process.env.AEEIS_WORKER_URL ?? `${new URL(baseUrl).protocol}//${new URL(baseUrl).hostname}:4324`).replace(/\/$/, '');
const timeoutMs = Number(process.env.AEEIS_SMOKE_TIMEOUT_MS ?? 120_000);
const startedAt = Date.now();

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

async function requestAt(url, path) {
  const response = await fetch(`${url}${path}`);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`${response.status} ${url}${path}: ${text}`);
  return body;
}

function assertWithinTimeout() {
  if (Date.now() - startedAt > timeoutMs) throw new Error(`Compose smoke test timed out after ${timeoutMs}ms`);
}

async function waitForReady() {
  while (true) {
    assertWithinTimeout();
    let readiness;
    try {
      readiness = await request('/readyz');
    } catch {
      // Compose services may still be starting. The bounded loop is the timeout.
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }
    if (readiness.protocol && readiness.protocol !== 'aeeis-readiness/1') {
      throw new Error(`AEEIS_BASE_URL returned ${readiness.protocol}; expected aeeis-readiness/1`);
    }
    if (readiness.protocol === 'aeeis-readiness/1' && readiness.status === 'ready') return readiness;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function waitForWorkerReady() {
  while (true) {
    assertWithinTimeout();
    let readiness;
    try {
      readiness = await requestAt(workerUrl, '/readyz');
    } catch {
      // The API can become ready before the worker has bound its health port.
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }
    if (readiness.protocol && readiness.protocol !== 'aeeis-worker-readiness/1') {
      throw new Error(`AEEIS_WORKER_URL returned ${readiness.protocol}; expected aeeis-worker-readiness/1`);
    }
    if (readiness.protocol === 'aeeis-worker-readiness/1' && readiness.status === 'ready' && readiness.workerState === 'RUNNING') return readiness;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

const readiness = await waitForReady();
const health = await request('/health');
if (health.service !== 'aeeis-agent' || health.protocol !== 'aeeis-health/1') {
  throw new Error(`Compose smoke target is not an AEEIS API (check AEEIS_BASE_URL; got ${JSON.stringify(health)})`);
}
const status = await request('/api/status');
if (status.runner !== 'TemporalDispatcher' || status.dispatcherHealth?.ready !== true) {
  throw new Error(`Compose smoke requires TemporalDispatcher readiness, got ${JSON.stringify({ runner: status.runner, dispatcherHealth: status.dispatcherHealth })}`);
}
if (status.modelRouting !== 'catalog' || !String(status.modelHealth?.detail ?? '').includes('catalog selected compose-fixture/aeeis-fixture/1')) {
  throw new Error(`Compose smoke requires Planprice catalog routing, got ${JSON.stringify({ modelRouting: status.modelRouting, modelHealth: status.modelHealth })}`);
}
if (status.executionProfile !== 'fixture') throw new Error('Compose must identify itself as a fixture demonstration');
if (status.skillGovernanceConfigured !== true || status.skillGovernanceHealth?.ready !== true || status.rsiProposalSynthesisConfigured !== true) {
  throw new Error(`Compose smoke requires OwnHow health and RSI proposal synthesis wiring, got ${JSON.stringify({ skillGovernanceConfigured: status.skillGovernanceConfigured, skillGovernanceHealth: status.skillGovernanceHealth, rsiProposalSynthesisConfigured: status.rsiProposalSynthesisConfigured })}`);
}
const workerReadiness = await waitForWorkerReady();

// Exercise the actual RSI discovery loop. The fixture reviewer intentionally
// emits one bounded low-confidence result for this goal; the background pump
// must synthesize an evidence-bound candidate before any human approval gate.
const synthesisRunRef = await request('/api/runs', {
  method: 'POST',
  body: JSON.stringify({
    goal: 'RSI synthesis smoke: turn a bounded review signal into a proposal',
    materials: [{ title: 'RSI smoke evidence', source: 'compose-rsi', content: 'The controlled review signal is evidence for this development smoke.' }],
  }),
});
const synthesisRun = await approveRun(synthesisRunRef.id);
if (synthesisRun.status !== 'failed') throw new Error(`Expected controlled RSI synthesis run to fail review, got ${JSON.stringify(synthesisRun)}`);
let synthesizedSignal;
while (true) {
  assertWithinTimeout();
  const signals = await request('/api/evolution/signals?limit=100');
  synthesizedSignal = signals.find((signal) => signal.runId === synthesisRun.id && signal.synthesis?.state === 'completed' && signal.candidateId);
  if (synthesizedSignal) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
const synthesizedCandidate = await request(`/api/evolution/candidates/${synthesizedSignal.candidateId}`);
if (synthesizedCandidate.status !== 'proposed' || synthesizedCandidate.target !== 'prompt') {
  throw new Error(`Expected an evidence-bound synthesized RSI candidate, got ${JSON.stringify(synthesizedCandidate)}`);
}

// The Compose API disables the periodic reminder pump so this verifies the
// cross-container Temporal timer workflow and its authenticated advance
// activity. Projection Outbox remains the durable reminder side effect.
const timerReminder = await request('/api/reminders', {
  method: 'POST',
  body: JSON.stringify({
    title: 'Compose timer reminder',
    message: 'Verify the Temporal reminder workflow.',
    dueAt: new Date(Date.now() + 250).toISOString(),
    channel: 'compose-smoke',
    destination: 'timer-workflow',
    idempotencyKey: `compose-timer-${Date.now()}`,
  }),
});
let timerReminderState;
while (true) {
  assertWithinTimeout();
  timerReminderState = await request(`/api/reminders/${timerReminder.id}`);
  if (timerReminderState.status === 'projected') break;
  if (timerReminderState.status === 'failed' || timerReminderState.status === 'cancelled') {
    throw new Error(`Expected Temporal reminder to project, got ${JSON.stringify(timerReminderState)}`);
  }
  await new Promise(resolve => setTimeout(resolve, 250));
}

// Verify a durable external trigger can create and run a blind Competition
// through the configured cross-container model pool. The fixture model only
// proves the protocol, attempt lifecycle, and idempotency boundary.
const triggerPolicy = await request('/api/collaborations/triggers/policies', {
  method: 'POST',
  body: JSON.stringify({
    id: `policy.compose.${Date.now()}`,
    name: 'Compose trigger competition',
    enabled: true,
    eventTypes: ['review.completed'],
    sources: ['system'],
    riskAtLeast: 'high',
    reviewConfidenceAtMost: 0.5,
    requiredDiversityAtLeast: 2,
    action: {
      type: 'competition',
      participantAgentIds: ['agent.one', 'agent.two'],
      evaluatorAgentId: 'agent.evaluator',
      expectedResultType: 'plan/1',
      maxRounds: 1,
      blindEvaluation: true,
      dispatch: 'run',
    },
  }),
});
const triggerEvent = {
  eventId: `review:compose:${Date.now()}`,
  eventType: 'review.completed',
  source: 'system',
  taskId: 'task.compose.trigger',
  contextVersion: 'ctx.compose.trigger',
  goal: 'Choose the bounded Compose smoke result',
  risk: 'high',
  reviewConfidence: 0.2,
  requiredDiversity: 2,
  allowedAgentIds: ['agent.one', 'agent.two'],
  occurredAt: new Date().toISOString(),
};
const triggered = await request('/api/collaborations/triggers/evaluate', { method: 'POST', body: JSON.stringify(triggerEvent) });
const triggerResult = triggered.find((item) => item.policyId === triggerPolicy.id);
if (!triggerResult?.created || triggerResult.decision.dispatchState !== 'completed' || !triggerResult.decision.resourceId) {
  throw new Error(`Expected trigger dispatch to complete, got ${JSON.stringify(triggered)}`);
}
const triggerDuplicate = await request('/api/collaborations/triggers/evaluate', { method: 'POST', body: JSON.stringify(triggerEvent) });
const triggerDuplicateForPolicy = triggerDuplicate.find((item) => item.policyId === triggerPolicy.id);
if (!triggerDuplicateForPolicy || triggerDuplicateForPolicy.created !== false || triggerDuplicateForPolicy.decision.resourceId !== triggerResult.decision.resourceId) {
  throw new Error(`Expected trigger event idempotency, got ${JSON.stringify(triggerDuplicate)}`);
}
const triggeredCompetition = await request(`/api/collaborations/competitions/${triggerResult.decision.resourceId}`);
if (triggeredCompetition.status !== 'completed' || triggeredCompetition.candidates?.length !== 2 || triggeredCompetition.scores?.length !== 2 || !triggeredCompetition.selectedAgentId) {
  throw new Error(`Expected completed triggered Competition, got ${JSON.stringify(triggeredCompetition)}`);
}

const debatePolicy = await request('/api/collaborations/triggers/policies', {
  method: 'POST',
  body: JSON.stringify({
    id: `policy.compose.debate.${Date.now()}`,
    name: 'Compose trigger debate',
    enabled: true,
    eventTypes: ['task.failed'],
    sources: ['system'],
    riskAtLeast: 'high',
    action: {
      type: 'debate',
      participantAgentIds: ['agent.one', 'agent.two'],
      maxRounds: 1,
      maxMessagesPerAgent: 1,
      maxTotalMessages: 2,
      dispatch: 'run',
    },
  }),
});
const debateEvent = {
  eventId: `task:compose-debate:${Date.now()}`,
  eventType: 'task.failed',
  source: 'system',
  taskId: 'task.compose.debate',
  contextVersion: 'ctx.compose.debate',
  goal: 'Debate the bounded recovery response',
  risk: 'high',
  occurredAt: new Date().toISOString(),
};
const debated = await request('/api/collaborations/triggers/evaluate', { method: 'POST', body: JSON.stringify(debateEvent) });
const debateResult = debated.find((item) => item.policyId === debatePolicy.id);
if (!debateResult?.created || debateResult.decision.dispatchState !== 'completed' || !debateResult.decision.resourceId) {
  throw new Error(`Expected trigger Debate dispatch to complete, got ${JSON.stringify(debated)}`);
}
const debateDuplicate = await request('/api/collaborations/triggers/evaluate', { method: 'POST', body: JSON.stringify(debateEvent) });
const debateDuplicateForPolicy = debateDuplicate.find((item) => item.policyId === debatePolicy.id);
if (!debateDuplicateForPolicy || debateDuplicateForPolicy.created !== false || debateDuplicateForPolicy.decision.resourceId !== debateResult.decision.resourceId) {
  throw new Error(`Expected Debate trigger event idempotency, got ${JSON.stringify(debateDuplicate)}`);
}
const triggeredDebate = await request(`/api/collaborations/debates/${debateResult.decision.resourceId}`);
if (triggeredDebate.status !== 'closed' || triggeredDebate.room?.messages?.length !== 2 || triggeredDebate.room?.adjudication?.status !== 'held' || triggeredDebate.attempts?.some((attempt) => attempt.state !== 'completed')) {
  throw new Error(`Expected closed triggered Debate with settled role attempts, got ${JSON.stringify(triggeredDebate)}`);
}
const goal = await request('/api/goals', {
  method: 'POST',
  body: JSON.stringify({ title: `Compose smoke ${new Date().toISOString()}` }),
});
const plan = await request(`/api/goals/${goal.id}/plans`, {
  method: 'POST',
  body: JSON.stringify({ nodes: [
    { id: 'inspect', title: 'Inspect smoke evidence', instruction: 'Inspect the Compose smoke evidence.' },
    { id: 'deliver', title: 'Deliver smoke result', instruction: 'Deliver the verified Compose smoke result.', dependsOn: ['inspect'] },
  ] }),
});

const scheduled = await request(`/api/plans/${plan.id}/schedule`, { method: 'POST', body: JSON.stringify({
  materials: [{ title: 'Smoke source', source: 'compose-fixture', content: 'AEEIS Compose smoke evidence.' }],
}) });
const firstDispatch = scheduled.dispatches?.find(item => item.taskId === 'inspect');
if (!firstDispatch?.runId || firstDispatch.state !== 'dispatched') {
  throw new Error(`Expected first DAG dispatch, got ${JSON.stringify(scheduled)}`);
}

async function waitForRun(runId, statuses) {
  let current;
  while (true) {
    assertWithinTimeout();
    current = await request(`/api/runs/${runId}`);
    if (statuses.includes(current.status)) return current;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function approveRun(runId) {
  const run = await waitForRun(runId, ['needs_approval', 'succeeded', 'failed', 'cancelled']);
  if (run.status !== 'needs_approval') throw new Error(`Expected ${runId} to need approval, got ${run.status}: ${run.error ?? 'no error'}`);
  const latestPlan = run.plans?.at(-1);
  if (!latestPlan?.hash) throw new Error(`Run ${runId} did not return an approvable plan hash`);
  await request(`/api/runs/${runId}/approve`, { method: 'POST', body: JSON.stringify({ planHash: latestPlan.hash }) });
  return waitForRun(runId, ['succeeded', 'failed', 'cancelled']);
}

// Verify the configured File project-source connector is part of the real
// Compose path. The first run reads the configured source snapshot (or resumes
// an existing durable snapshot when smoke is rerun against a persistent DB),
// creates an evidence-bound Project Pulse artifact, and projects its next
// action into a successor Plan.
const pulseGoal = await request('/api/goals', {
  method: 'POST',
  body: JSON.stringify({ title: `Compose Project Pulse ${new Date().toISOString()}` }),
});
const pulseCreated = await request(`/api/goals/${pulseGoal.id}/runs`, {
  method: 'POST',
  body: JSON.stringify({ builtinSkill: 'project-pulse/1', projectSourceQuery: 'release', projectSourceMaxItems: 10 }),
});
const pulseRun = await approveRun(pulseCreated.id);
const firstProjectSync = pulseRun.context?.projectSourceSync;
if (pulseRun.status !== 'succeeded' || !['snapshot', 'unchanged'].includes(firstProjectSync?.update?.mode)
  || !Number.isInteger(firstProjectSync?.checkpointRevision) || firstProjectSync.checkpointRevision < 1 || (pulseRun.context?.sources?.length ?? 0) < 3
  || !pulseRun.artifacts?.some(item => item.artifactType === 'project-pulse/1' && item.structured?.nextActions?.length)) {
  throw new Error(`Expected evidence-bound Project Pulse snapshot, got ${JSON.stringify({ status: pulseRun.status, sync: pulseRun.context?.projectSourceSync, sources: pulseRun.context?.sources?.length, artifacts: pulseRun.artifacts })}`);
}
const pulseGoalAfter = await request(`/api/goals/${pulseGoal.id}`);
const pulsePlans = await request(`/api/goals/${pulseGoal.id}/plans`);
if (!pulseRun.followUpPlanId || pulsePlans.length < 2 || pulseGoalAfter.status !== 'active') {
  throw new Error(`Expected Project Pulse successor plan, got ${JSON.stringify({ followUpPlanId: pulseRun.followUpPlanId, planCount: pulsePlans.length, goalStatus: pulseGoalAfter.status })}`);
}

// A second run with the same query resumes the durable checkpoint and should
// reuse the stored snapshot instead of dropping source context. The combined
// provider may express this as a complete snapshot with changed=false because
// it reassembles child provider views.
const pulseSecond = await request(`/api/goals/${pulseGoal.id}/runs`, {
  method: 'POST',
  body: JSON.stringify({ builtinSkill: 'project-pulse/1', projectSourceQuery: 'release', projectSourceMaxItems: 10 }),
});
const pulseSecondRun = await approveRun(pulseSecond.id);
if (pulseSecondRun.status !== 'succeeded' || !['snapshot', 'unchanged'].includes(pulseSecondRun.context?.projectSourceSync?.update?.mode)
  || pulseSecondRun.context?.projectSourceSync?.changed !== false
  || pulseSecondRun.context?.projectSourceSync?.checkpointRevision !== firstProjectSync.checkpointRevision + 1 || (pulseSecondRun.context?.sources?.length ?? 0) < 3) {
  throw new Error(`Expected Project Pulse checkpoint resume, got ${JSON.stringify({ status: pulseSecondRun.status, sync: pulseSecondRun.context?.projectSourceSync, sources: pulseSecondRun.context?.sources?.length })}`);
}

const firstRun = await approveRun(firstDispatch.runId);
if (firstRun.status !== 'succeeded') throw new Error(`Expected first DAG task to succeed, got ${firstRun.status}: ${firstRun.error ?? 'no error'}`);

let scheduler;
let secondDispatch;
while (true) {
  assertWithinTimeout();
  scheduler = await request(`/api/plans/${plan.id}/scheduler`);
  secondDispatch = scheduler.find(item => item.taskId === 'deliver');
  if (secondDispatch?.runId) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}

const secondRun = await approveRun(secondDispatch.runId);
if (secondRun.status !== 'succeeded') throw new Error(`Expected second DAG task to succeed, got ${secondRun.status}: ${secondRun.error ?? 'no error'}`);

let finalScheduler;
let snapshot;
let finalGoal;
while (true) {
  assertWithinTimeout();
  finalScheduler = await request(`/api/plans/${plan.id}/scheduler`);
  snapshot = await request(`/api/plans/${plan.id}/snapshot`);
  finalGoal = await request(`/api/goals/${goal.id}`);
  if (finalScheduler.length === 2 && finalScheduler.every(item => item.state === 'succeeded')
    && snapshot.plan.nodes.every(node => node.status === 'succeeded') && finalGoal.status === 'completed') break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (finalScheduler.length !== 2 || finalScheduler.some(item => item.state !== 'succeeded')) {
  throw new Error(`Expected both DAG dispatches to succeed, got ${JSON.stringify(finalScheduler)}`);
}
if (snapshot.plan.nodes.some(node => node.status !== 'succeeded') || finalGoal.status !== 'completed') {
  throw new Error(`Expected completed DAG and Goal, got ${JSON.stringify({ plan: snapshot.plan, goal: finalGoal })}`);
}

// Verify the external Agent boundary through the real Compose network. The
// fixture Agent receives a task-scoped Context Pack and Grant over HTTP; its
// Result Envelope must then become evidence for the AEEIS Run.
// This policy intentionally uses dispatch=create and is evaluated only by the
// internal Run Event Pump. The assertion below proves a normal Run's durable
// review.completed event can create a Debate without a manual /evaluate call.
const runEventPolicy = await request('/api/collaborations/triggers/policies', {
  method: 'POST',
  body: JSON.stringify({
    id: `policy.compose.run-event.${Date.now()}`,
    name: 'Compose Run review collaboration',
    enabled: true,
    eventTypes: ['review.completed'],
    sources: ['system'],
    action: {
      type: 'debate',
      participantAgentIds: ['agent.fixture'],
      maxRounds: 1,
      maxMessagesPerAgent: 1,
      maxTotalMessages: 1,
      dispatch: 'create',
    },
  }),
});
const externalRun = await request('/api/runs', {
  method: 'POST',
  body: JSON.stringify({
    goal: 'Use the admitted fixture Agent to return a bounded research result',
    materials: [{ title: 'External smoke source', source: 'compose-fixture-agent', content: 'The fixture Agent must preserve this evidence boundary.' }],
    allowedAgents: ['agent.fixture'],
    externalBudget: { calls: 1 },
  }),
});
const externalCompleted = await approveRun(externalRun.id);
if (externalCompleted.status !== 'succeeded' || !externalCompleted.delegationOutcomes?.some((outcome) => (outcome.agentId ?? outcome.receipt?.agentId ?? outcome.result?.agentId) === 'agent.fixture' && outcome.status === 'completed')) {
  throw new Error(`Expected external Agent Run to succeed with a completed delegation, got ${JSON.stringify({ status: externalCompleted.status, error: externalCompleted.error, delegations: externalCompleted.delegationOutcomes })}`);
}
let runEventDecision;
while (true) {
  assertWithinTimeout();
  const decisions = await request(`/api/collaborations/triggers/decisions?policyId=${encodeURIComponent(runEventPolicy.id)}`);
  runEventDecision = decisions.find((decision) => decision.eventId.startsWith(`run:${externalRun.id}:`));
  if (runEventDecision?.state === 'triggered' && runEventDecision.resourceId) {
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 500));
}
const runEventDebate = await request(`/api/collaborations/debates/${runEventDecision.resourceId}`);
if (runEventDebate.status !== 'active') throw new Error(`Expected Run Event Pump to create an active Debate, got ${JSON.stringify(runEventDebate)}`);

// Verify the RSI boundary through the real Compose evaluator. The evaluator
// is intentionally deterministic: this checks the network protocol and the
// candidate lifecycle, while production quality remains a separate concern.
const activationBeforeRsi = await request('/api/evolution/activation');
let activePrompt = activationBeforeRsi.active?.find((release) => release.target === 'prompt');
if (!activePrompt) {
  const baselineVersion = `prompt/compose-baseline-${Date.now()}`;
  const baseline = await request('/api/evolution/candidates', { method: 'POST', body: JSON.stringify({
    target: 'prompt', baseVersion: 'prompt/1', proposedVersion: baselineVersion,
    change: 'Preserve evidence citations in the Compose smoke baseline.',
    sourceReceiptRefs: ['receipt.compose.baseline'], reason: 'Establish a canary base release', risk: 'low',
  }) });
  const evaluatedBaseline = await request(`/api/evolution/candidates/${baseline.id}/evaluate-suite`, { method: 'POST', body: JSON.stringify({ suite: {
    replay: [{ id: 'replay.compose-baseline', input: { goal: 'baseline' } }],
    holdout: [{ id: 'holdout.compose-baseline', input: { goal: 'baseline' } }],
    safety: [{ id: 'safety.compose-baseline', input: { goal: 'safe' } }],
  } }) });
  if (evaluatedBaseline.evaluations?.some((evaluation) => !evaluation.passed)) throw new Error(`Baseline RSI evaluation failed: ${JSON.stringify(evaluatedBaseline)}`);
  await request(`/api/evolution/candidates/${baseline.id}/approve`, { method: 'POST', body: JSON.stringify({ approvalRef: 'compose-baseline-approval' }) });
  await request(`/api/evolution/candidates/${baseline.id}/promote`, { method: 'POST', body: JSON.stringify({}) });
  await request(`/api/evolution/candidates/${baseline.id}/activate`, { method: 'POST', body: JSON.stringify({ activationRef: 'compose-baseline-activation' }) });
  const afterBaseline = await request('/api/evolution/activation');
  activePrompt = afterBaseline.active?.find((release) => release.target === 'prompt');
  if (!activePrompt) throw new Error(`Expected an active RSI baseline release, got ${JSON.stringify(afterBaseline)}`);
}
const rsiBaseVersion = activePrompt?.version ?? 'prompt/1';
const rsiProposedVersion = `prompt/compose-smoke-${Date.now()}`;
const candidate = await request('/api/evolution/candidates', {
  method: 'POST',
  body: JSON.stringify({
    target: 'prompt',
    baseVersion: rsiBaseVersion,
    proposedVersion: rsiProposedVersion,
    change: 'Always cite the evidence graph.',
    sourceReceiptRefs: ['receipt.compose.rsi'],
    reason: 'Compose RSI evaluator smoke',
    risk: 'low',
  }),
});
const evaluatedCandidate = await request(`/api/evolution/candidates/${candidate.id}/evaluate-suite`, {
  method: 'POST',
  body: JSON.stringify({
    suite: {
      replay: [{ id: 'replay.compose', input: { goal: 'compose-rsi' } }],
      holdout: [{ id: 'holdout.compose', input: { goal: 'compose-rsi' } }],
      safety: [{ id: 'safety.compose', input: { goal: 'safe' } }],
    },
  }),
});
if (evaluatedCandidate.status !== 'evaluating' || evaluatedCandidate.evaluations?.length !== 3 || evaluatedCandidate.evaluations.some((evaluation) => !evaluation.passed)) {
  throw new Error(`Expected all RSI evaluation gates to pass, got ${JSON.stringify(evaluatedCandidate)}`);
}
const approvedCandidate = await request(`/api/evolution/candidates/${candidate.id}/approve`, {
  method: 'POST',
  body: JSON.stringify({ approvalRef: 'compose-rsi-approval' }),
});
if (approvedCandidate.status !== 'approved') throw new Error(`Expected RSI candidate to be approved, got ${JSON.stringify(approvedCandidate)}`);
const promotedCandidate = await request(`/api/evolution/candidates/${candidate.id}/promote`, { method: 'POST', body: JSON.stringify({}) });
if (promotedCandidate.status !== 'promoted') throw new Error(`Expected RSI candidate to be promoted, got ${JSON.stringify(promotedCandidate)}`);

// Verify the production traffic canary boundary before full activation. A
// route must be durable, observations must be evidence-bound, and every new
// Run must freeze its deterministic route/bucket decision.
const trafficRoute = await request(`/api/evolution/candidates/${candidate.id}/start-traffic`, {
  method: 'POST',
  body: JSON.stringify({ percentage: 2500, rolloutRef: 'compose-rsi-traffic-start' }),
});
if (trafficRoute.status !== 'active' || trafficRoute.candidateId !== candidate.id || trafficRoute.percentage !== 2500) {
  throw new Error(`Expected active production traffic route, got ${JSON.stringify(trafficRoute)}`);
}
const trafficRunRef = await request('/api/runs', {
  method: 'POST',
  body: JSON.stringify({ goal: 'Freeze the Compose production traffic decision' }),
});
const trafficRun = await request(`/api/runs/${trafficRunRef.id}`);
if (!trafficRun.evolutionTraffic?.some((selection) => selection.routeId === trafficRoute.id && selection.candidateId === candidate.id && Number.isInteger(selection.bucket))) {
  throw new Error(`Expected Run to freeze the production traffic route and bucket, got ${JSON.stringify(trafficRun.evolutionTraffic)}`);
}
const observedTraffic = await request(`/api/evolution/candidates/${candidate.id}/record-traffic`, {
  method: 'POST',
  body: JSON.stringify({ id: 'traffic.compose.observation', passed: true, score: 0.98, evidenceRefs: ['metric.compose.acceptance', 'metric.compose.latency'] }),
});
if (observedTraffic.observations?.length !== 1 || observedTraffic.observations[0]?.id !== 'traffic.compose.observation') {
  throw new Error(`Expected durable production traffic observation, got ${JSON.stringify(observedTraffic)}`);
}
const stoppedTraffic = await request(`/api/evolution/candidates/${candidate.id}/stop-traffic`, {
  method: 'POST',
  body: JSON.stringify({ reason: 'Compose smoke completed the traffic observation window' }),
});
if (stoppedTraffic.status !== 'stopped' || stoppedTraffic.observations?.length !== 1) {
  throw new Error(`Expected stopped traffic route with observation, got ${JSON.stringify(stoppedTraffic)}`);
}
const activatedCandidate = await request(`/api/evolution/candidates/${candidate.id}/activate`, {
  method: 'POST',
  body: JSON.stringify({ activationRef: 'compose-rsi-activation' }),
});
if (activatedCandidate.candidateId !== candidate.id || activatedCandidate.version !== rsiProposedVersion) {
  throw new Error(`Expected RSI activation release for ${rsiProposedVersion}, got ${JSON.stringify(activatedCandidate)}`);
}
const activatedCandidateState = await request(`/api/evolution/candidates/${candidate.id}`);
if (activatedCandidateState.status !== 'promoted') throw new Error(`Expected activated RSI candidate to remain promoted, got ${JSON.stringify(activatedCandidateState)}`);
const activation = await request('/api/evolution/activation');
if (!activation.active?.some((release) => release.candidateId === candidate.id && release.target === 'prompt' && release.version === rsiProposedVersion)) {
  throw new Error(`Expected ${rsiProposedVersion} to be active after RSI activation, got ${JSON.stringify(activation)}`);
}

console.log(JSON.stringify({
  status: 'passed',
  goalId: goal.id,
  planId: plan.id,
  runIds: [firstDispatch.runId, secondDispatch.runId],
  externalRunId: externalRun.id,
  trafficRouteId: trafficRoute.id,
  trafficRunId: trafficRunRef.id,
  trafficObservationId: observedTraffic.observations[0].id,
  rsiCandidateId: candidate.id,
  runStatus: secondRun.status,
  dagTasks: snapshot.plan.nodes.map(node => ({ id: node.id, status: node.status })),
  artifacts: (firstRun.artifacts?.length ?? 0) + (secondRun.artifacts?.length ?? 0),
  reviews: [firstRun.review?.verdict ?? null, secondRun.review?.verdict ?? null],
  goalStatus: finalGoal.status,
  rsiStatus: activatedCandidateState.status,
  activeEvolution: activation.active.map((release) => ({ target: release.target, version: release.version })),
  readiness: readiness.status,
  worker: workerReadiness.workerState,
  timerReminderId: timerReminder.id,
  timerReminderStatus: timerReminderState.status,
  triggeredCompetitionId: triggeredCompetition.id,
  triggeredCompetitionStatus: triggeredCompetition.status,
  triggeredDebateId: triggeredDebate.id,
  triggeredDebateStatus: triggeredDebate.status,
  runEventDebateId: runEventDebate.id,
  runEventDebateStatus: runEventDebate.status,
}, null, 2));
