import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sharedRunView } from '../src/runtime/run-debug.js';
import type { AgentRun } from '../src/runtime/contracts.js';
let source: string, html: string, css: string;
let dom: JSDOM;
beforeAll(async () => {
  const result = await build({ entryPoints: ['src/ui/app.ts'], bundle: true, format: 'iife', target: 'es2022', write: false });
  source = result.outputFiles![0]!.text;
  [html, css] = await Promise.all([readFile('public/index.html', 'utf8'), readFile('public/style.css', 'utf8')]);
});
afterEach(() => dom?.window.close());
function fixture(): AgentRun {
  const now = new Date().toISOString();
  return { schemaVersion: 1, id: `run_${randomUUID()}`, owner: 'owner', tenantId: 'local', revision: 1,
    goal: 'Linked failure', status: 'failed', createdAt: now, updatedAt: now,
    model: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, maxModelCalls: 20,
    plans: [{ summary: 'Investigate', nodes: [{ id: 'task', title: 'Task', instruction: 'Do task', dependsOn: [] }], version: 1, hash: 'hash', createdAt: now }],
    steps: [{ taskId: 'task', status: 'running', attempts: 1, observations: [], error: 'Model failed', failureReason: 'Missing structured output' }],
    events: [{ id: 'event', seq: 1, type: 'run.failed', at: now, data: { reason: 'Missing structured output' } }],
    artifacts: [{ id: 'artifact', taskId: 'task', title: 'Result', content: 'Visible result', evidenceRefs: ['source'], hash: 'hash', createdAt: now }],
    context: { id: 'context', audience: ['owner'], sources: [{ id: 'source', title: 'Evidence', content: 'Evidence body', source: 'local', hash: 'hash' }] },
    calls: [], answers: [], toolReceipts: [], allowedTools: [], allowedAgents: [], privacy: 'internal', brainMaxItems: 1, knowledgeMaxItems: 1, memoryMaxItems: 1,
    review: { verdict: 'needs_revision', summary: 'Missing data', issues: ['Missing structured output'] }, error: 'Model failed' };
}
function start(path: string, fetch: any) {
  dom = new JSDOM(html, { url: `http://localhost${path}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const style = dom.window.document.createElement('style'); style.textContent = css; dom.window.document.head.append(style);
  dom.window.localStorage.setItem('aeeis.run', `run_${randomUUID()}`);
  dom.window.sessionStorage.setItem('aeeis.token', 'saved-auth-secret');
  dom.window.fetch = fetch;
  dom.window.setInterval = (() => 1) as any;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any;
  dom.window.eval(source);
}
const response = (data: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
describe('run link workbench', () => {
  it('loads only the shared run without auth and shows all requested read-only details', async () => {
    const run = fixture(), token = 'a'.repeat(43);
    for (let seq = 2; seq <= 100; seq++) run.events.push({ id: `event_${seq}`, seq, type: 'model.completed', at: run.createdAt, data: {} });
    const fetch = vi.fn(async () => response(sharedRunView(run)));
    start(`/share/${token}`, fetch);
    await vi.waitFor(() => expect(dom.window.document.getElementById('run-title')?.textContent).toBe(run.goal));
    const doc = dom.window.document;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(`/api/share/${token}`);
    expect(fetch.mock.calls[0]![1].headers).not.toHaveProperty('authorization');
    expect(doc.getElementById('detail')?.hidden).toBe(false);
    expect(doc.body.classList.contains('run-details-mode')).toBe(true);
    expect(doc.getElementById('graph')?.textContent).toContain('Missing structured output');
    expect(doc.getElementById('timeline')?.textContent).toContain('#1');
    expect(doc.querySelectorAll('#timeline > li')).toHaveLength(100);
    expect(doc.querySelector('#timeline > li:first-child pre')?.textContent).toContain('Missing structured output');
    expect(doc.getElementById('artifacts')?.textContent).toContain('Visible result');
    expect(doc.getElementById('run-explanation')?.textContent).toContain('needs_revision');
    expect(doc.getElementById('evidence-graph')?.textContent).toContain('Evidence');
    expect(doc.getElementById('controls')?.childElementCount).toBe(0);
    expect(doc.getElementById('decision-review-actions')?.childElementCount).toBe(0);
    expect(doc.getElementById('decision-next-button')?.hidden).toBe(true);
    expect(dom.window.getComputedStyle(doc.getElementById('create-run-share')!).display).toBe('none');
  });
  it('selects the run in the URL over saved state and expands the workbench', async () => {
    const run = fixture();
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/status') return response({ modelConfigured: false, runner: 'unconfigured', mode: 'single-owner-local' });
      if (url === '/api/tools') return response({ tools: [], defaultAllowedTools: [] });
      if (url === `/api/runs/${run.id}`) return response(run);
      if (url === `/api/runs/${run.id}/graphs`) return response(sharedRunView(run).graphs);
      if (url === `/api/runs/${run.id}/explanation`) return response(sharedRunView(run).explanation);
      if (url.includes('/page?')) return response({ items: [], goals: [] });
      return response([]);
    });
    start(`/runs/${run.id}`, fetch);
    await vi.waitFor(() => expect(dom.window.document.getElementById('run-title')?.textContent).toBe(run.goal));
    expect(dom.window.document.getElementById('detail')?.hidden).toBe(false);
    expect(dom.window.document.body.classList.contains('run-details-mode')).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url === `/api/runs/${run.id}`)).toBe(true);
    expect(dom.window.location.pathname).toBe(`/runs/${run.id}`);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    dom.window.document.getElementById('copy-run-link')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(`http://localhost/runs/${run.id}`));
  });
  it('keeps a copyable URL visible when clipboard access is unavailable', async () => {
    const run = fixture(), token = 'a'.repeat(43);
    start(`/share/${token}`, vi.fn(async () => response(sharedRunView(run))));
    await vi.waitFor(() => expect(dom.window.document.getElementById('run-title')?.textContent).toBe(run.goal));
    dom.window.document.getElementById('copy-run-link')!.click();
    await vi.waitFor(() => expect(dom.window.document.querySelector('#run-share-result a')?.textContent).toBe(`http://localhost/share/${token}`));
  });
});
