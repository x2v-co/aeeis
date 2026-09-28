#!/usr/bin/env node

// Development-only read-only web capability for exercising AEEIS autonomy.
// The AEEIS runtime still controls admission, version pinning, idempotency and
// evidence receipts. Keep the host allowlist narrow while testing.
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const host = process.env.AEEIS_LOCAL_WEB_TOOL_HOST ?? '127.0.0.1';
const port = Number(process.env.AEEIS_LOCAL_WEB_TOOL_PORT ?? 4398);
const allowedHosts = new Set((process.env.AEEIS_LOCAL_WEB_HOSTS ?? 'weather.cma.cn,api.open-meteo.com').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function textFromHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}

function receipt(request, status, requestHash, responseHash, errorCode) {
  return {
    schemaVersion: 'receipt/1', receiptId: `receipt_${randomUUID()}`, provider: 'aeeis-local-web', operation: request.toolId,
    requestHash, ...(responseHash ? { responseHash } : {}), inputRefs: [request.taskId], outputRefs: [], capabilitiesUsed: ['read', 'network'],
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), status, ...(errorCode ? { errorCode } : {}),
  };
}

async function invoke(request) {
  const requestHash = digest(request);
  const url = typeof request.input?.input === 'string' ? request.input.input : typeof request.input === 'string' ? request.input : '';
  let parsed;
  try { parsed = new URL(url); } catch { return { schemaVersion: 'tool-result/1', status: 'failed', output: { error: 'A valid URL is required.' }, receipt: receipt(request, 'failed', requestHash, undefined, 'invalid_url') }; }
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname.toLowerCase())) {
    return { schemaVersion: 'tool-result/1', status: 'failed', output: { error: `Host is outside the local web allowlist: ${parsed.hostname}` }, receipt: receipt(request, 'failed', requestHash, undefined, 'host_not_allowed') };
  }
  try {
    // Redirect targets have not passed the host allowlist check.
    const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(Math.min(request.timeoutMs ?? 60_000, 60_000)), headers: { 'user-agent': 'AEEIS-local-web-tool/1' } });
    const body = await response.text();
    const summary = response.headers.get('content-type')?.includes('html') ? textFromHtml(body) : body.slice(0, 12000).trim();
    const output = { url, finalUrl: response.url, status: response.status, contentType: response.headers.get('content-type') ?? 'unknown', fetchedAt: new Date().toISOString(), summary };
    const responseHash = digest(output);
    const blocked = /人机识别|验证码|滑动填充|captcha|challenge/i.test(summary);
    const completed = response.ok && !blocked;
    const resultReceipt = receipt(request, completed ? 'completed' : 'failed', requestHash, responseHash, completed ? undefined : blocked ? 'blocked_by_challenge' : `http_${response.status}`);
    resultReceipt.outputRefs = [resultReceipt.receiptId];
    return { schemaVersion: 'tool-result/1', status: completed ? 'completed' : 'failed', output, outputRefs: [resultReceipt.receiptId], receipt: resultReceipt };
  } catch (error) {
    return { schemaVersion: 'tool-result/1', status: 'failed', output: { error: error instanceof Error ? error.message : 'web fetch failed' }, receipt: receipt(request, 'failed', requestHash, undefined, 'fetch_failed') };
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.method === 'GET' && request.url === '/health') { response.end(JSON.stringify({ ok: true, mode: 'development-local-web-tool', allowedHosts: [...allowedHosts] })); return; }
  if (request.method === 'GET' && request.url === '/manifest') {
    response.end(JSON.stringify({ schemaVersion: 'tool-manifest/1', tools: [{ id: 'web-fetch', version: '1', capabilities: ['read', 'network'], description: 'Read an allowlisted HTTPS webpage and return bounded text evidence.', inputSchema: { type: 'object', properties: { input: { type: 'string', format: 'uri' } }, required: ['input'], additionalProperties: false }, outputSchema: { type: 'object' } }] }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/invoke') { response.statusCode = 404; response.end(JSON.stringify({ error: 'not found' })); return; }
  let raw = ''; for await (const chunk of request) raw += chunk;
  try { response.end(JSON.stringify(await invoke(JSON.parse(raw)))); } catch { response.statusCode = 400; response.end(JSON.stringify({ error: 'invalid invocation' })); }
});
server.listen(port, host, () => console.log(`AEEIS local web tool listening at http://${host}:${port} (hosts: ${[...allowedHosts].join(', ')})`));
process.once('SIGINT', () => server.close(() => process.exit(0)));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
