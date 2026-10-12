#!/usr/bin/env node
// Development-only HTTP Projection Sink (aeeis-projection-event/1 ->
// aeeis-projection-ack/1). Used by the single-host stack smoke test to prove a
// Reminder leaves the outbox and reaches an external delivery boundary.
import { createServer } from 'node:http';

const host = process.env.AEEIS_FIXTURE_SINK_HOST ?? '127.0.0.1';
const port = Number(process.env.AEEIS_FIXTURE_SINK_PORT ?? 4799);
const token = process.env.AEEIS_FIXTURE_SINK_TOKEN ?? '';
const received = [];

const server = createServer((request, response) => {
  const reply = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (request.method === 'GET' && request.url === '/health') return reply(200, { status: 'ok', received: received.length });
  if (request.method === 'GET' && request.url === '/received') return reply(200, received);
  if (request.method !== 'POST' || request.url !== '/events') return reply(404, { error: 'not found' });
  if (token && request.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { raw += chunk; if (raw.length > 1_000_000) request.destroy(); });
  request.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch { return reply(400, { error: 'invalid json' }); }
    if (body?.schemaVersion !== 'aeeis-projection-event/1' || !body.event?.id) return reply(400, { error: 'unexpected payload' });
    const externalId = `fixture-sink:${body.event.id}`;
    if (!received.some(item => item.id === body.event.id)) received.push({ id: body.event.id, channel: body.event.channel, kind: body.event.kind, at: new Date().toISOString() });
    console.log(JSON.stringify({ fixture: 'projection-sink', delivered: body.event.id, channel: body.event.channel }));
    reply(200, { schemaVersion: 'aeeis-projection-ack/1', accepted: true, externalId });
  });
});
server.listen(port, host, () => console.log(`fixture projection sink on http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
