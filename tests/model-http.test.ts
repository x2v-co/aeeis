import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { HttpModelAdapter } from '../src/runtime/model.js';

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
  });
});
