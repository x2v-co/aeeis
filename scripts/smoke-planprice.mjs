#!/usr/bin/env node

/**
 * Verify the live Planprice catalog and its AEEIS model-routing boundary.
 *
 * This is intentionally opt-in. It reads the live catalog and exchange-rate
 * endpoints, selects a real model through the built adapter, and optionally
 * checks an already-running AEEIS instance. It does not invoke a model unless
 * AEEIS_PLANPRICE_SMOKE_RUN=1 is explicitly set.
 */

import process from 'node:process';

const planpriceUrl = process.env.AEEIS_PLANPRICE_URL;
const endpointJson = process.env.AEEIS_MODEL_PROVIDER_ENDPOINTS;
const aeeisUrl = process.env.AEEIS_BASE_URL;

if (!planpriceUrl) throw new Error('AEEIS_PLANPRICE_URL is required');
if (!endpointJson) throw new Error('AEEIS_MODEL_PROVIDER_ENDPOINTS is required');

let endpoints;
try {
  endpoints = JSON.parse(endpointJson);
} catch {
  throw new Error('AEEIS_MODEL_PROVIDER_ENDPOINTS must be valid JSON');
}
if (!endpoints || typeof endpoints !== 'object' || Array.isArray(endpoints)) {
  throw new Error('AEEIS_MODEL_PROVIDER_ENDPOINTS must be a JSON object');
}

const { PlanpriceHttpCatalog, selectModel } = await import('../dist/integrations.js');
const catalog = new PlanpriceHttpCatalog(planpriceUrl, endpoints, {
  ...(process.env.AEEIS_PLANPRICE_HEALTH_URL ? { healthUrl: process.env.AEEIS_PLANPRICE_HEALTH_URL } : {}),
});
const catalogHealth = await catalog.health?.();
if (catalogHealth && !catalogHealth.ready) throw new Error(`Planprice catalog health failed: ${catalogHealth.detail}`);
const firstRows = await catalog.list({ capability: 'agent' });
if (firstRows.length === 0) throw new Error('Planprice returned no usable agent models');
const firstDecision = selectModel(firstRows, {
  capability: 'agent',
  privacy: process.env.AEEIS_PLANPRICE_SMOKE_PRIVACY ?? 'internal',
  catalogRetrievedAt: new Date().toISOString(),
});
if (!firstDecision.selected.endpoint) throw new Error('Selected Planprice model has no provider endpoint');
if (typeof firstDecision.selected.outputPricePerMillion !== 'number') {
  throw new Error('Selected Planprice model has no normalized USD output price');
}
const secondRows = await catalog.list({ capability: 'agent' });
const secondDecision = selectModel(secondRows, { capability: 'agent', privacy: process.env.AEEIS_PLANPRICE_SMOKE_PRIVACY ?? 'internal' });
if (firstDecision.catalogHash !== secondDecision.catalogHash) throw new Error('Planprice catalog hash changed between identical reads');

let aeeis;
if (aeeisUrl) {
  const readinessResponse = await fetch(new URL('/readyz', aeeisUrl), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const readiness = await readinessResponse.json();
  if (!readinessResponse.ok || readiness.status !== 'ready') throw new Error(`AEEIS is not ready: ${JSON.stringify(readiness)}`);
  const statusResponse = await fetch(new URL('/api/status', aeeisUrl), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const status = await statusResponse.json();
  if (!statusResponse.ok || status.modelRouting !== 'catalog') throw new Error(`AEEIS is not using catalog routing: ${JSON.stringify(status)}`);
  if (!String(status.modelHealth?.detail ?? '').includes('catalog selected ')) throw new Error('AEEIS readiness did not report the selected catalog model');
  aeeis = { readiness: readiness.status, modelRouting: status.modelRouting, modelHealth: status.modelHealth };
}

if (process.env.AEEIS_PLANPRICE_SMOKE_RUN === '1') {
  if (!aeeisUrl) throw new Error('AEEIS_BASE_URL is required when AEEIS_PLANPRICE_SMOKE_RUN=1');
  const requestJson = async (path, init = {}) => {
    const response = await fetch(new URL(path, aeeisUrl), { redirect: 'error', signal: AbortSignal.timeout(15_000), ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`AEEIS request ${path} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
  };
  const created = await requestJson('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      goal: 'Planprice routing smoke: produce a short evidence-backed status',
      materials: [{ title: 'Planprice smoke source', source: 'planprice-smoke', content: 'The catalog route is available and returned a verified model selection.' }],
    }),
  });
  const runId = created.id;
  if (typeof runId !== 'string' || !runId) throw new Error('AEEIS smoke Run creation did not return an id');
  const deadline = Date.now() + Number(process.env.AEEIS_PLANPRICE_SMOKE_TIMEOUT_MS ?? 60_000);
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
  let run;
  for (;;) {
    run = await requestJson(`/api/runs/${encodeURIComponent(runId)}`);
    if (run.status === 'needs_approval' || terminal.has(run.status)) break;
    if (Date.now() >= deadline) throw new Error(`AEEIS smoke Run did not reach approval: ${run.status}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (run.status === 'needs_approval') {
    const planHash = run.approval?.planHash ?? run.plans?.[0]?.hash;
    if (typeof planHash !== 'string' || !planHash) throw new Error('AEEIS smoke Run did not expose an approval plan hash');
    run = await requestJson(`/api/runs/${encodeURIComponent(runId)}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planHash }),
    });
  }
  while (!terminal.has(run.status)) {
    if (Date.now() >= deadline) throw new Error(`AEEIS smoke Run did not reach a terminal state: ${run.status}`);
    await new Promise(resolve => setTimeout(resolve, 100));
    run = await requestJson(`/api/runs/${encodeURIComponent(runId)}`);
  }
  if (run.status !== 'succeeded') throw new Error(`AEEIS smoke Run ended in ${run.status}: ${run.error ?? 'no error detail'}`);
  aeeis.runId = runId;
  aeeis.runStatus = run.status;
}

console.log(JSON.stringify({
  schemaVersion: 'aeeis.planprice-live-smoke.v1',
  planpriceUrl,
  usableAgentModelCount: firstRows.length,
  selected: {
    provider: firstDecision.selected.provider,
    model: firstDecision.selected.model,
    endpointConfigured: Boolean(firstDecision.selected.endpoint),
    inputPricePerMillion: firstDecision.selected.inputPricePerMillion,
    outputPricePerMillion: firstDecision.selected.outputPricePerMillion,
  },
  catalogHash: firstDecision.catalogHash,
  ...(catalogHealth ? { catalogHealth } : {}),
  ...(aeeis ? { aeeis } : {}),
}, null, 2));
