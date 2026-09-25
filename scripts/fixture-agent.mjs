#!/usr/bin/env node
import { createServer } from 'node:http';

const host = process.env.AEEIS_FIXTURE_AGENT_HOST ?? '127.0.0.1';
const port = Number(process.env.AEEIS_FIXTURE_AGENT_PORT ?? 4599);
const agentId = process.env.AEEIS_FIXTURE_AGENT_ID ?? 'agent.fixture';

function json(response, status, value) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }
function responseFor(request) {
  const taskBrief = request.taskBrief; const contextPack = request.contextPack;
  if (!taskBrief || !contextPack || taskBrief.taskId !== contextPack.taskId) throw new Error('invalid task/context binding');
  const receiptRef = `receipt_${agentId.replaceAll('.', '_')}_${taskBrief.taskId}`;
  const acknowledgement = { schemaVersion: 'context-ack/1', taskId: taskBrief.taskId, contextVersion: contextPack.id, understoodGoal: true, missingInformation: [], assumptions: [], conflicts: [], ready: true };
  const result = { schemaVersion: 'result-envelope/1', taskId: taskBrief.taskId, agentId, status: 'completed', resultType: taskBrief.expectedOutput, summary: `Fixture Agent completed: ${taskBrief.goal}`, claims: contextPack.claims.slice(0, 3).map(claim => ({ text: claim.text, confidence: 0.9, evidenceRefs: claim.evidenceRefs })), artifacts: [], unresolved: [], requestedFollowups: [], cost: { tokens: 1 }, capabilitiesUsed: [], contextVersion: contextPack.id, receiptRef };
  return { status: 'completed', receiptRef, acknowledgement, result };
}
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { ok: true, agentId, mode: 'development-fixture' });
  if (request.method !== 'POST' || !['/task', '/reconcile'].includes(request.url)) return json(response, 404, { error: 'not found' });
  let body = ''; for await (const chunk of request) body += chunk;
  try {
    const parsed = JSON.parse(body); if (!['agent-task/1', 'agent-reconcile/1'].includes(parsed.schemaVersion)) throw new Error('unsupported protocol');
    const output = responseFor(parsed);
    if (parsed.mode === 'stream' && parsed.schemaVersion === 'agent-task/1') {
      const progress = { schemaVersion: 'agent-progress/1', taskId: parsed.taskBrief.taskId, agentId, contextVersion: parsed.contextPack.id, sequence: 1, status: 'running', message: 'fixture agent prepared the bounded result', percent: 50, evidenceRefs: [], artifactRefs: [], at: new Date().toISOString() };
      response.writeHead(200, { 'content-type': 'application/x-ndjson' }); response.write(JSON.stringify(progress) + '\n'); response.end(JSON.stringify(output) + '\n'); return;
    }
    return json(response, 200, output);
  }
  catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : 'invalid request' }); }
});
server.listen(port, host, () => console.log(`AEEIS development fixture Agent listening at http://${host}:${port}`));
function shutdown(signal) { server.close(() => { console.log(`Fixture Agent stopped (${signal})`); process.exit(0); }); }
process.once('SIGINT', () => shutdown('SIGINT')); process.once('SIGTERM', () => shutdown('SIGTERM'));
