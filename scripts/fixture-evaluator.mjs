#!/usr/bin/env node
import { createServer } from 'node:http';

const host = process.env.AEEIS_FIXTURE_EVALUATOR_HOST ?? '127.0.0.1';
const port = Number(process.env.AEEIS_FIXTURE_EVALUATOR_PORT ?? 4499);

function observationFor(input) {
  const mode = String(input?.mode ?? 'unknown');
  const testCase = input?.testCase;
  if (!input || input.schemaVersion !== 'rsi-evaluation-request/1' || !input.candidate || !testCase || typeof testCase.id !== 'string') {
    throw new Error('invalid rsi evaluation request');
  }
  // This service is deliberately deterministic and bounded. It verifies the
  // HTTP evaluator contract in local Compose; it is not an evaluator for
  // production model quality.
  const evidenceRef = `fixture-evaluation:${mode}:${testCase.id}`;
  return {
    schemaVersion: 'rsi-evaluation-observation/1',
    passed: true,
    score: 1,
    evidenceRefs: [evidenceRef],
    cost: 0,
  };
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, mode: 'development-fixture' }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/evaluate') {
    response.writeHead(404); response.end(); return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  try {
    const value = observationFor(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request' }));
  }
});

server.listen(port, host, () => {
  console.log(`AEEIS development fixture evaluator listening at http://${host}:${port}`);
});

function shutdown(signal) {
  server.close(() => { console.log(`Fixture evaluator stopped (${signal})`); process.exit(0); });
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
