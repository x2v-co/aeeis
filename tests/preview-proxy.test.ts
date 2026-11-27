import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { connect, createServer as createTcpServer } from 'node:net';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/runtime/http.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { PREVIEW_ID, PREVIEW_RELAY, PREVIEW_WINDOW, PreviewChannel, PreviewProxy, newPreviewId, previewServerFactory, previewUrl, upstreamHeaders } from '../src/preview-proxy.js';

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
const stop = (server: Server) => {
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  closers.push(() => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  return sockets;
};

/** A dev server stand-in: echoes what reached it, and answers websocket upgrades by echoing raw bytes. */
async function devServer() {
  const seen: { method: string; url: string; headers: IncomingHttpHeaders; body: number }[] = [];
  const server = createServer((incoming, response) => {
    let body = 0;
    incoming.on('data', (chunk: Buffer) => { body += chunk.length; });
    incoming.on('end', () => {
      seen.push({ method: incoming.method!, url: incoming.url!, headers: incoming.headers, body });
      response.writeHead(200, { 'content-type': 'text/plain', 'x-dev': 'yes' });
      response.end(incoming.url === '/big' ? 'x'.repeat(3_000_000) : `got ${incoming.method} ${incoming.url} ${body}`);
    });
  });
  server.on('upgrade', (_incoming, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
    socket.on('data', (chunk: Buffer) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])));
    // As websocket servers do: the other side ending closes the connection.
    socket.on('end', () => socket.end());
  });
  const port = await listen(server); const sockets = stop(server);
  return { port, seen, sockets };
}

/** AEEIS's side: the preview proxy in front of an app, with the real relay script run locally instead of in a container. */
async function front(targets: Map<string, number>, options: { lookupMs?: number } = {}) {
  const relays: ChildProcessWithoutNullStreams[] = [];
  const lookups: string[] = [];
  const proxy = new PreviewProxy('aeeis.link', async id => {
    lookups.push(id);
    // Reading the machines' records takes a moment.
    if (options.lookupMs) await new Promise(resolve => setTimeout(resolve, options.lookupMs));
    const port = targets.get(id);
    return port === undefined ? undefined : { port, relay: async () => { const child = spawn('python3', ['-I', '-u', '-c', PREVIEW_RELAY, String(port)], { stdio: ['pipe', 'pipe', 'pipe'] }); relays.push(child); return child; } };
  }, { recheckMs: 50 });
  const server = previewServerFactory(proxy)((_incoming, response) => { response.writeHead(200); response.end('the app'); });
  const port = await listen(server); stop(server);
  closers.push(() => { for (const child of relays) child.kill('SIGKILL'); });
  const call = (host: string, path = '/', options: { method?: string; body?: Buffer; headers?: Record<string, string> } = {}) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host, ...options.headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    outgoing.on('error', reject); outgoing.end(options.body);
  });
  return { port, proxy, relays, lookups, call };
}

describe('preview links', () => {
  it('are random, one origin each, on the configured domain', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newPreviewId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(PREVIEW_ID);
    const id = [...ids][0]!;
    expect(previewUrl('aeeis.link', id)).toBe(`https://p-${id}.aeeis.link/`);
    const proxy = new PreviewProxy('aeeis.link', async () => undefined);
    expect(proxy.idFor(`p-${id}.aeeis.link`)).toBe(id);
    expect(proxy.idFor(`P-${id.toUpperCase()}.AEEIS.LINK:443`)).toBe(id);
    for (const host of ['aeeis.link', `p-${id}.aeeis.com`, `p-${id}.aeeis.link.evil.com`, `x.p-${id}.aeeis.link`, 'p-short.aeeis.link', `p-${id}1.aeeis.link`, undefined]) expect(proxy.idFor(host)).toBeUndefined();
  });
  it('address the dev server as localhost, without the edge\'s own headers', () => {
    const headers = upstreamHeaders({ host: 'p-x.aeeis.link', 'cf-ray': '1', 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4', connection: 'keep-alive', 'transfer-encoding': 'chunked', cookie: 'a=1', accept: 'text/html' }, 3000, 'p-x.aeeis.link');
    expect(headers).toEqual({ host: 'localhost:3000', 'x-forwarded-host': 'p-x.aeeis.link', 'x-forwarded-proto': 'https', cookie: 'a=1', accept: 'text/html' });
  });
});

describe('preview proxy through the relay', () => {
  it('carries requests, bodies and large answers to the Run\'s port over one relay', async () => {
    const dev = await devServer();
    const id = newPreviewId();
    const { call, relays } = await front(new Map([[id, dev.port]]));
    const host = `p-${id}.aeeis.link`;
    const page = await call(host, '/index.html?x=1', { headers: { 'cf-ray': 'abc', cookie: 'session=1' } });
    expect(page).toMatchObject({ status: 200, body: 'got GET /index.html?x=1 0' });
    expect(page.headers).toMatchObject({ 'x-dev': 'yes', 'x-robots-tag': 'noindex, nofollow' });
    expect(dev.seen[0]!.headers).toMatchObject({ host: `localhost:${dev.port}`, 'x-forwarded-host': host, cookie: 'session=1' });
    expect(dev.seen[0]!.headers['cf-ray']).toBeUndefined();
    const body = Buffer.alloc(2_500_000, 7);
    expect(await call(host, '/upload', { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } })).toMatchObject({ status: 200, body: 'got POST /upload 2500000' });
    expect((await call(host, '/big')).body).toHaveLength(3_000_000);
    const many = await Promise.all(Array.from({ length: 25 }, (_, index) => call(host, `/asset/${index}`)));
    expect(many.map(item => item.body)).toEqual(Array.from({ length: 25 }, (_, index) => `got GET /asset/${index} 0`));
    expect(relays).toHaveLength(1);
  }, 30_000);
  it('carries websocket upgrades, so live reload works', async () => {
    const dev = await devServer();
    const id = newPreviewId();
    const { port } = await front(new Map([[id, dev.port]]));
    const socket = connect(port, '127.0.0.1');
    const received: Buffer[] = [];
    socket.on('data', chunk => received.push(chunk));
    socket.write(`GET /hmr HTTP/1.1\r\nhost: p-${id}.aeeis.link\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: abc\r\nsec-websocket-version: 13\r\n\r\n`);
    await expect.poll(() => Buffer.concat(received).toString()).toContain('101 Switching Protocols');
    socket.write('ping');
    await expect.poll(() => Buffer.concat(received).toString()).toContain('echo:ping');
    expect(dev.sockets.size).toBe(1);
    // The visitor leaving closes the connection on the dev server's side too.
    socket.destroy();
    await expect.poll(() => dev.sockets.size).toBe(0);
  }, 15_000);
  it('leaves every other host to the app, and answers unknown or stopped previews plainly', async () => {
    const id = newPreviewId(), idle = newPreviewId();
    const closed = createServer(); const closedPort = await listen(closed); await new Promise(resolve => closed.close(resolve));
    const { call } = await front(new Map([[idle, closedPort]]));
    expect(await call('aeeis.com', '/')).toMatchObject({ status: 200, body: 'the app' });
    expect(await call(`p-${id}.aeeis.com`, '/')).toMatchObject({ status: 200, body: 'the app' });
    const unknown = await call(`p-${id}.aeeis.link`, '/');
    expect(unknown.status).toBe(404); expect(unknown.body).toContain('not active');
    const notListening = await call(`p-${idle}.aeeis.link`, '/');
    expect(notListening.status).toBe(502); expect(notListening.body).toContain(`0.0.0.0:${closedPort}`);
  }, 15_000);
  it('starts one relay for requests that arrive together on a new link, and keeps it when the link is checked again', async () => {
    const dev = await devServer();
    const id = newPreviewId();
    const { port, relays, lookups } = await front(new Map([[id, dev.port]]), { lookupMs: 20 });
    const host = `p-${id}.aeeis.link`;
    // 25 requests pipelined on one connection reach the proxy in the same turn, before any lookup has finished.
    const burst = () => new Promise<number>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let text = '';
      socket.on('data', chunk => { text += chunk; const answers = text.match(/HTTP\/1\.1 200/g)?.length ?? 0; if (answers === 25) { socket.destroy(); resolve(answers); } });
      socket.on('error', reject);
      socket.write(Array.from({ length: 25 }, (_, index) => `GET /a/${index} HTTP/1.1\r\nhost: ${host}\r\n\r\n`).join(''));
    });
    expect(await burst()).toBe(25);
    expect(lookups).toHaveLength(1); expect(relays).toHaveLength(1);
    // Once the check is due, requests arriving together share one new lookup and the relay already running.
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(await burst()).toBe(25);
    expect(lookups).toHaveLength(2); expect(relays).toHaveLength(1);
  }, 30_000);
  it('stops a link soon after its machine is released, and ends its relay', async () => {
    const dev = await devServer();
    const id = newPreviewId();
    const targets = new Map([[id, dev.port]]);
    const { call, relays } = await front(targets);
    expect((await call(`p-${id}.aeeis.link`, '/')).status).toBe(200);
    targets.delete(id);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect((await call(`p-${id}.aeeis.link`, '/')).status).toBe(404);
    await expect.poll(() => relays[0]!.exitCode !== null || relays[0]!.signalCode !== null).toBe(true);
  }, 15_000);
});

describe('the AEEIS server with previews', () => {
  it('serves the app as before and hands only preview hosts to the proxy', async () => {
    const id = newPreviewId();
    const app = buildApp({ repository: new InMemoryRunRepository(), publicHosts: ['aeeis.com'], previewProxy: new PreviewProxy('aeeis.link', async () => undefined) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    closers.push(() => app.close());
    const port = (app.server.address() as AddressInfo).port;
    const get = (host: string, path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path, headers: { host } }, response => { let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, body })); }).on('error', reject).end();
    });
    expect((await get('aeeis.com', '/health')).status).toBe(200);
    expect(await get('elsewhere.example', '/health')).toMatchObject({ status: 403 });
    const preview = await get(`p-${id}.aeeis.link`, '/health');
    expect(preview.status).toBe(404); expect(preview.body).toContain('preview link is not active');
    expect(await app.inject({ method: 'GET', url: '/health', headers: { host: 'aeeis.com' } })).toMatchObject({ statusCode: 200 });
  });
});

describe('relay flow control', () => {
  it('holds at most a window of a stream whose reader stopped, while other streams keep flowing', async () => {
    const big = Buffer.alloc(24 * 1024 * 1024, 1);
    const server = createTcpServer(socket => {
      socket.once('data', chunk => { if (String(chunk) === 'big') socket.end(big); else socket.end('hello'); });
      socket.on('error', () => undefined);
    });
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
    const child = spawn('python3', ['-I', '-u', '-c', PREVIEW_RELAY, String(port), String(PREVIEW_WINDOW)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const channel = new PreviewChannel(child);
    closers.push(() => { channel.close(); child.kill('SIGKILL'); return new Promise<void>(resolve => server.close(() => resolve())); });
    const stalled = channel.open();
    stalled.on('error', () => undefined);
    stalled.write('big');
    await new Promise(resolve => setTimeout(resolve, 1500));
    // Nobody reads it: AEEIS keeps at most the relay's window plus the stream's own small buffer, not 24 MiB.
    expect(stalled.readableLength).toBeGreaterThan(0);
    expect(stalled.readableLength).toBeLessThanOrEqual(PREVIEW_WINDOW + 64 * 1024);
    // The stalled stream holds up no other stream on the same relay.
    const other = channel.open();
    other.on('error', () => undefined);
    const answer: Buffer[] = [];
    other.on('data', chunk => answer.push(chunk));
    other.write('small');
    await expect.poll(() => Buffer.concat(answer).toString()).toBe('hello');
    // Reading again gets everything, in full.
    let total = 0, wrong = false;
    stalled.on('data', (chunk: Buffer) => { total += chunk.length; if (chunk.some(byte => byte !== 1)) wrong = true; });
    await expect.poll(() => total, { timeout: 20_000 }).toBe(big.length);
    expect(wrong).toBe(false);
  }, 40_000);
});
