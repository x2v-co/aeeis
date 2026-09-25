import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { HttpRsiEvaluationHarness } from '../src/evaluation.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

describe('HttpRsiEvaluationHarness', () => {
  it('validates the evaluator transport boundary and observation envelope', async () => {
    const port = await new Promise<string>(resolve => {
      const server = createServer(async (request, response) => {
        expect(request.headers.authorization).toBe('Bearer evaluator-secret');
        let body = ''; for await (const chunk of request) body += chunk;
        const input = JSON.parse(body) as { schemaVersion: string; mode: string; testCase: { id: string } };
        expect(input.schemaVersion).toBe('rsi-evaluation-request/1');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ schemaVersion: 'rsi-evaluation-observation/1', passed: true, score: 0.9, evidenceRefs: [`eval:${input.mode}:${input.testCase.id}`] }));
      });
      servers.push(server); server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
    });
    const harness = new HttpRsiEvaluationHarness(`http://127.0.0.1:${port}/evaluate`, 'evaluator-secret');
    await expect(harness.evaluate({ id: 'candidate-1' } as never, 'replay', { id: 'case-1', input: { ok: true } })).resolves.toEqual({ passed: true, score: 0.9, evidenceRefs: ['eval:replay:case-1'] });
  });

  it('uses a read-only evaluator health endpoint without executing an evaluation case', async () => {
    let evaluateCalls = 0;
    const port = await new Promise<string>(resolve => {
      const server = createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.method === 'GET' && request.url === '/health') { response.end(JSON.stringify({ status: 'ok' })); return; }
        if (request.method === 'POST') { evaluateCalls += 1; response.end(JSON.stringify({ schemaVersion: 'rsi-evaluation-observation/1', passed: true, score: 1, evidenceRefs: ['eval'] })); return; }
        response.statusCode = 404; response.end('{}');
      });
      servers.push(server); server.listen(0, '127.0.0.1', () => resolve(String((server.address() as { port: number }).port)));
    });
    const harness = new HttpRsiEvaluationHarness(`http://127.0.0.1:${port}/evaluate`, 'evaluator-secret', 5000, false, `http://127.0.0.1:${port}/health`);
    await expect(harness.health()).resolves.toMatchObject({ ready: true, detail: 'provider health endpoint reachable' });
    expect(evaluateCalls).toBe(0);
  });

  it('requires HTTPS outside loopback unless development explicitly opts in', () => {
    expect(() => new HttpRsiEvaluationHarness('http://evaluator.internal/evaluate')).toThrow('HTTPS');
    expect(() => new HttpRsiEvaluationHarness('http://evaluator.internal/evaluate', undefined, 60_000, true)).not.toThrow();
  });
});
