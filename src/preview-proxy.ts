import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, request, type RequestOptions, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type RequestListener, type Server, type ServerResponse } from 'node:http';
import type { Duplex as DuplexType } from 'node:stream';
import { Duplex } from 'node:stream';

/**
 * Live previews for sandbox hosts that cannot share a port themselves (a plain VPS). A visitor opens
 * https://p-<id>.<domain>/; AEEIS finds the Run and port the id was issued for and carries the connection to that
 * port through one long-lived `docker exec` in the Run's proxy container, over the SSH connection AEEIS already uses
 * for the host. The host needs no open port, no tunnel and no SSH forwarding.
 *
 * Each preview is its own origin, on a domain that is not AEEIS's, so a page cannot reach AEEIS or another preview's
 * storage. The id is the only key: 130 random bits, valid while the Run's machine is kept.
 */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const PREVIEW_ID = /^[a-z2-7]{26}$/;
export function newPreviewId(): string {
  return [...randomBytes(26)].map(byte => ID_ALPHABET[byte & 31]).join('');
}
export const previewUrl = (domain: string, id: string) => `https://p-${id}.${domain}/`;

/**
 * Runs in the Run's proxy container (python3 -I -c, so nothing in the image changes) and multiplexes connections to
 * one preview port over its standard input and output. A frame is stream id (u32), type (u8) and length (u32), then
 * the data. 1 opens a stream, 2 carries data, 3 ends one direction, 4 drops the stream, 5 grants the relay credit (u32
 * bytes) to send more on it. Each stream starts with WINDOW bytes of credit and gets more only as its reader takes
 * data, so a visitor who stops reading stops that stream alone, and AEEIS holds at most that much of it. The proxy
 * already forwards the preview port to the Run's container, so the relay only ever dials 127.0.0.1 on that port.
 */
export const PREVIEW_WINDOW = 256 * 1024;
export const PREVIEW_RELAY = `
import asyncio, struct, sys
PORT = int(sys.argv[1])
HEAD = struct.Struct('>IBI')
WINDOW = int(sys.argv[2]) if len(sys.argv) > 2 else 262144
async def main():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=1 << 22)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, sys.stdout.buffer)
    out = asyncio.StreamWriter(transport, protocol, None, loop)
    lock = asyncio.Lock()
    streams = {}
    async def send(sid, kind, data=b''):
        async with lock:
            out.write(HEAD.pack(sid, kind, len(data)) + data)
            await out.drain()
    async def pump(sid, upstream):
        entry = streams.get(sid)
        try:
            while True:
                while entry['window'] <= 0:
                    entry['credit'].clear()
                    await entry['credit'].wait()
                    if streams.get(sid) is not entry:
                        return
                chunk = await upstream.read(min(65536, entry['window']))
                if not chunk:
                    break
                entry['window'] -= len(chunk)
                await send(sid, 2, chunk)
            await send(sid, 3)
        except Exception:
            drop(sid)
            await send(sid, 4)
    def drop(sid):
        entry = streams.pop(sid, None)
        if entry:
            entry['credit'].set()
        if entry and entry['writer']:
            entry['writer'].close()
    async def connect(sid):
        entry = streams[sid]
        try:
            upstream, writer = await asyncio.wait_for(asyncio.open_connection('127.0.0.1', PORT), 10)
        except Exception:
            streams.pop(sid, None)
            await send(sid, 4)
            return
        if streams.get(sid) is not entry:
            writer.close()
            return
        entry['writer'] = writer
        for item in entry['pending']:
            writer.write(item) if item is not None else writer.write_eof()
        entry['pending'] = []
        asyncio.ensure_future(pump(sid, upstream))
    while True:
        try:
            sid, kind, size = HEAD.unpack(await reader.readexactly(HEAD.size))
            data = await reader.readexactly(size) if size else b''
        except asyncio.IncompleteReadError:
            break
        if kind == 1 and sid not in streams and len(streams) < 256:
            streams[sid] = {'writer': None, 'pending': [], 'window': WINDOW, 'credit': asyncio.Event()}
            asyncio.ensure_future(connect(sid))
        elif kind == 1:
            await send(sid, 4)
        elif sid in streams:
            entry = streams[sid]
            if kind == 4:
                drop(sid)
            elif kind == 5:
                entry['window'] += struct.unpack('>I', data)[0]
                entry['credit'].set()
            elif entry['writer'] is None:
                entry['pending'].append(data if kind == 2 else None)
            elif kind == 2:
                entry['writer'].write(data)
                await entry['writer'].drain()
            elif kind == 3 and entry['writer'].can_write_eof():
                entry['writer'].write_eof()
    for sid in list(streams):
        drop(sid)
asyncio.run(main())
`;

const OPEN = 1, DATA = 2, END = 3, DROP = 4, CREDIT = 5;
const HEADER = 9;
const MAX_FRAME = 1 << 20;
const MAX_STREAMS = 200;
function frame(id: number, type: number, data?: Buffer): Buffer {
  const head = Buffer.alloc(HEADER);
  head.writeUInt32BE(id, 0); head.writeUInt8(type, 4); head.writeUInt32BE(data?.length ?? 0, 5);
  return data?.length ? Buffer.concat([head, data]) : head;
}

/** Many connections to one preview port over one relay process. */
export class PreviewChannel {
  private next = 1;
  private readonly streams = new Map<number, Duplex>();
  private readonly received = new Map<number, (size: number) => void>();
  private pending: Buffer = Buffer.alloc(0);
  private closed = false;
  private idleTimer: NodeJS.Timeout | undefined;
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly idleMs = 5 * 60_000) {
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.stderr.resume();
    child.stdin.on('error', () => this.close());
    child.once('error', () => this.close());
    child.once('close', () => this.close());
    this.idle();
  }
  get alive() { return !this.closed; }
  get size() { return this.streams.size; }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    for (const stream of this.streams.values()) stream.destroy(new Error('The preview relay closed'));
    this.streams.clear();
    if (this.child.exitCode === null && this.child.signalCode === null) { this.child.stdin.end(); this.child.kill('SIGTERM'); }
  }
  /** Ends the relay once nothing has used it for a while, so a forgotten tab does not keep a process on the host. */
  private idle() {
    clearTimeout(this.idleTimer);
    if (!this.streams.size && !this.closed) this.idleTimer = setTimeout(() => this.close(), this.idleMs).unref();
  }
  private send(id: number, type: number, data?: Buffer): boolean {
    if (this.closed) return true;
    return this.child.stdin.write(frame(id, type, data));
  }
  /** A new connection to the preview port, usable as an HTTP client socket. */
  open(): DuplexType {
    if (this.closed) throw new Error('The preview relay closed');
    if (this.streams.size >= MAX_STREAMS) throw new Error('Too many connections to this preview');
    const id = this.next;
    this.next = this.next >= 0xffff_fff0 ? 1 : this.next + 1;
    const channel = this;
    // Bytes received but not yet given back as credit. The reader asking for more (read) means they were taken.
    let taken = 0;
    const stream = new Duplex({
      read() {
        if (!taken) return;
        const grant = Buffer.alloc(4); grant.writeUInt32BE(taken, 0); taken = 0;
        channel.send(id, CREDIT, grant);
      },
      write(chunk: Buffer, _encoding, callback) {
        let ok = true;
        for (let offset = 0; offset < chunk.length; offset += MAX_FRAME) ok = channel.send(id, DATA, chunk.subarray(offset, offset + MAX_FRAME)) && ok;
        if (ok || channel.closed) callback(); else channel.child.stdin.once('drain', () => callback());
      },
      final(callback) { channel.send(id, END); callback(); },
      destroy(error, callback) {
        channel.received.delete(id);
        if (channel.streams.delete(id)) channel.send(id, DROP);
        channel.idle();
        callback(error);
      },
    });
    // What an http.ClientRequest may call on its socket.
    Object.assign(stream, { setNoDelay() { return stream; }, setKeepAlive() { return stream; }, setTimeout() { return stream; }, ref() { return stream; }, unref() { return stream; } });
    this.streams.set(id, stream);
    this.received.set(id, size => { taken += size; });
    clearTimeout(this.idleTimer);
    this.send(id, OPEN);
    return stream;
  }
  private receive(chunk: Buffer) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= HEADER) {
      const size = this.pending.readUInt32BE(5);
      if (size > MAX_FRAME * 4) { this.close(); return; }
      if (this.pending.length < HEADER + size) break;
      const id = this.pending.readUInt32BE(0), type = this.pending.readUInt8(4);
      const data = this.pending.subarray(HEADER, HEADER + size);
      this.pending = this.pending.subarray(HEADER + size);
      const stream = this.streams.get(id);
      if (!stream) continue;
      if (type === DATA) { this.received.get(id)?.(data.length); stream.push(Buffer.from(data)); }
      else if (type === END) stream.push(null);
      else if (type === DROP) { this.streams.delete(id); this.received.delete(id); stream.destroy(new Error('The preview is not answering on its port')); this.idle(); }
    }
  }
}

/** Where a preview id leads: the port to show, and how to start a relay to it. */
export interface PreviewTarget { port: number; relay(): Promise<ChildProcessWithoutNullStreams> }
export type PreviewResolver = (id: string) => Promise<PreviewTarget | undefined>;

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
/** What reaches the dev server: the visitor's request, addressed to localhost so dev servers that check the Host
 * header accept it, without the edge's own headers. */
export function upstreamHeaders(headers: IncomingHttpHeaders, port: number, host: string, upgrade = false): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name.startsWith('cf-') || name.startsWith('x-forwarded-') || ['x-real-ip', 'true-client-ip', 'cdn-loop'].includes(name)) continue;
    out[name] = value;
  }
  out.host = `localhost:${port}`;
  out['x-forwarded-host'] = host;
  out['x-forwarded-proto'] = 'https';
  if (upgrade) { out.connection = 'Upgrade'; if (headers.upgrade) out.upgrade = headers.upgrade; }
  return out;
}
function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
  out['x-robots-tag'] = 'noindex, nofollow';
  return out;
}
function page(response: ServerResponse, status: number, message: string) {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff' });
  response.end(message);
}

interface Entry { target: PreviewTarget; checkedAt: number; channel?: PreviewChannel; starting?: Promise<PreviewChannel> | undefined }
export class PreviewProxy {
  private readonly hostPattern: RegExp;
  private readonly entries = new Map<string, Entry>();
  /** One lookup per id at a time: every request that arrives meanwhile waits for the same one. */
  private readonly lookups = new Map<string, Promise<Entry | undefined>>();
  constructor(readonly domain: string, private readonly resolve: PreviewResolver, private readonly options: { recheckMs?: number; now?: () => number } = {}) {
    this.hostPattern = new RegExp(`^p-([a-z2-7]{26})\\.${domain.replace(/[.]/g, '\\.')}(?::\\d+)?$`);
  }
  /** The preview id a request is for, or undefined for anything that is not a preview host. */
  idFor(host: string | undefined): string | undefined {
    return host ? this.hostPattern.exec(host.toLowerCase())?.[1] : undefined;
  }
  /** The target is looked up again every half minute, so a link stops working soon after its machine is released.
   * Nothing here waits before the lookup is registered, so requests arriving together share one lookup and one Entry,
   * and with it one relay. */
  private entry(id: string): Promise<Entry | undefined> {
    const now = this.options.now?.() ?? Date.now();
    const cached = this.entries.get(id);
    if (cached && now - cached.checkedAt < (this.options.recheckMs ?? 30_000)) return Promise.resolve(cached);
    const running = this.lookups.get(id);
    if (running) return running;
    const lookup = this.resolve(id).then(target => {
      if (!target) { cached?.channel?.close(); this.entries.delete(id); return undefined; }
      // The same port keeps the same Entry, and so its relay.
      if (cached && cached.target.port === target.port) { cached.target = target; cached.checkedAt = now; return cached; }
      cached?.channel?.close();
      const entry: Entry = { target, checkedAt: now };
      this.entries.set(id, entry);
      return entry;
    }, () => cached).finally(() => { this.lookups.delete(id); });
    this.lookups.set(id, lookup);
    return lookup;
  }
  private async connect(id: string): Promise<{ port: number; socket: () => DuplexType } | undefined> {
    const entry = await this.entry(id);
    if (!entry) return undefined;
    if (!entry.channel?.alive) {
      entry.starting ??= entry.target.relay().then(child => (entry.channel = new PreviewChannel(child))).finally(() => { entry.starting = undefined; });
      await entry.starting;
    }
    const channel = entry.channel!;
    return { port: entry.target.port, socket: () => channel.open() };
  }
  async handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const id = this.idFor(incoming.headers.host);
    const found = id ? await this.connect(id).catch(() => undefined) : undefined;
    if (!found) { incoming.resume(); return page(response, 404, 'This preview link is not active. It ends when the task\'s machine is released.'); }
    let upstream;
    try {
      upstream = request({ createConnection: found.socket, method: incoming.method, path: incoming.url, headers: upstreamHeaders(incoming.headers, found.port, incoming.headers.host!) } as unknown as RequestOptions);
    } catch (error) { incoming.resume(); return page(response, 503, error instanceof Error ? error.message : 'The preview is busy'); }
    upstream.on('response', answer => {
      response.writeHead(answer.statusCode ?? 502, answer.statusMessage, responseHeaders(answer.headers));
      answer.pipe(response);
      answer.on('error', () => response.destroy());
    });
    upstream.on('error', () => page(response, 502, `Nothing is answering on port ${found.port}. Is the dev server running and listening on 0.0.0.0:${found.port}?`));
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    incoming.pipe(upstream);
  }
  async upgrade(incoming: IncomingMessage, socket: DuplexType, head: Buffer): Promise<void> {
    socket.on('error', () => socket.destroy());
    const id = this.idFor(incoming.headers.host);
    const found = id ? await this.connect(id).catch(() => undefined) : undefined;
    if (!found) { socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); return; }
    let upstream: DuplexType;
    try { upstream = found.socket(); } catch { socket.end('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); return; }
    const headers = upstreamHeaders(incoming.headers, found.port, incoming.headers.host!, true);
    const lines = [`${incoming.method} ${incoming.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) lines.push(`${name}: ${item}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.on('error', () => socket.destroy());
    upstream.pipe(socket); socket.pipe(upstream);
    // The server keeps half-open connections, but a websocket has no use for them: when the visitor goes, so does the
    // relay stream, which closes the dev server's side.
    socket.on('end', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  }
  close() {
    for (const entry of this.entries.values()) entry.channel?.close();
    this.entries.clear();
  }
}

/** An HTTP server that hands preview hosts to the proxy before anything else sees them, and everything else to the app. */
export function previewServerFactory(proxy: PreviewProxy) {
  return (handler: RequestListener): Server => {
    const server = createServer((incoming, response) => {
      if (proxy.idFor(incoming.headers.host)) void proxy.handle(incoming, response);
      else handler(incoming, response);
    });
    server.on('upgrade', (incoming: IncomingMessage, socket: DuplexType, head: Buffer) => {
      if (proxy.idFor(incoming.headers.host)) void proxy.upgrade(incoming, socket, head);
      else socket.destroy();
    });
    server.on('close', () => proxy.close());
    return server;
  };
}
