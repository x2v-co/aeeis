import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { HttpModelAdapter, ModelOutcomeUnknown, ModelResponseRejected } from '../src/runtime/model.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

function fixture(body: unknown, status = 200): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body));
    });
    servers.push(server); server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
  });
}

describe('HttpModelAdapter', () => {
  it.each([false, true])('identifies timeout before or after headers (headers sent: %s) without retrying', async headersSent => {
    let requests = 0;
    const port = await new Promise<string>(resolve => {
      const server = createServer((_request, response) => {
        requests++;
        if (headersSent) { response.setHeader('content-type', 'application/json'); response.flushHeaders(); }
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
    });
    const result = new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', 'secret', undefined, 100)
      .complete({ system: 's', input: {}, idempotencyKey: 'timeout-test' });
    await expect(result).rejects.toBeInstanceOf(ModelOutcomeUnknown);
    await expect(result).rejects.toThrow('timed out after 100ms');
    expect(requests).toBe(1);
  });

  it('accepts a slow response within a longer configured deadline', async () => {
    const port = await new Promise<string>(resolve => {
      const server = createServer((_request, response) => {
        setTimeout(() => response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] })), 150);
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
    });
    await expect(new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', '', undefined, 1000)
      .complete({ system: 's', input: {} })).resolves.toEqual({ value: { ok: true } });
  });

  it.each([
    { content: '{"partial":', finish_reason: 'length' },
    { content: 'not-json', finish_reason: 'stop' },
  ])('preserves billable usage when provider output is unusable: %j', async choice => {
    const port = await fixture({ choices: [{ message: { content: choice.content }, finish_reason: choice.finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const request = new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', '').complete({ system: 's', input: {} });
    await expect(request).rejects.toBeInstanceOf(ModelResponseRejected);
    await expect(request).rejects.toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 } });
  });
  it('parses an OpenAI-compatible JSON response and reports usage', async () => {
    const port = await fixture({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5 } });
    const adapter = new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', 'secret');
    await expect(adapter.complete({ system: 's', input: { x: 1 } })).resolves.toEqual({ value: { ok: true }, usage: { inputTokens: 3, outputTokens: 5 } });
  });
  it('rejects incomplete provider responses and unsafe endpoint URLs', async () => {
    const port = await fixture({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] });
    await expect(new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', '').complete({ system: 's', input: {} })).rejects.toThrow('incomplete');
    expect(() => new HttpModelAdapter('https://example.com?secret=1', 'fixture', '')).toThrow('query');
    expect(() => new HttpModelAdapter('http://example.com', 'fixture', '')).toThrow('HTTPS');
    expect(() => new HttpModelAdapter('http://example.com', 'fixture', '', undefined, 60000, undefined, true)).not.toThrow();
  });

  it('forwards the durable provider idempotency key', async () => {
    let request: IncomingMessage | undefined;
    const port = await new Promise<string>((resolve) => {
      const server = createServer((_request, response) => {
        request = _request;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }));
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
    });
    const adapter = new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', '');
    await adapter.complete({ system: 's', input: {}, idempotencyKey: 'model:run_1:call_1' });
    expect(request?.headers['idempotency-key']).toBe('model:run_1:call_1');
  });

  it('probes a configured provider health endpoint without exposing credentials', async () => {
    const port = await new Promise<string>((resolve) => {
      const server = createServer((request, response) => {
        expect(request.headers.authorization).toBe('Bearer secret');
        response.statusCode = 200; response.end('ok');
      });
      servers.push(server); server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
    });
    const adapter = new HttpModelAdapter(`http://127.0.0.1:${port}`, 'fixture', 'secret', undefined, 2000, `http://127.0.0.1:${port}/health`);
    await expect(adapter.health?.()).resolves.toMatchObject({ ready: true, detail: 'provider health probe passed' });
  });
});
