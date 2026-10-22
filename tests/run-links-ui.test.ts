import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sharedRunView } from '../src/runtime/run-debug.js';
import type { AgentRun } from '../src/runtime/contracts.js';
import { fillPdf } from '../src/runtime/fillable-pdf.js';
import { formSource, profile, pdfArtifact } from './fillable-pdf-fixture.js';
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
describe('group chat', () => {
  it('opens a draft from the roster and refuses a group that is only AEEIS', async () => {
    const run = fixture();
    const fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url === '/api/status') return response({ modelConfigured: false, runner: 'unconfigured', mode: 'single-owner-local' });
      if (url === `/api/runs/${run.id}`) return response(run);
      if (String(url).endsWith('/graphs')) return response(sharedRunView(run).graphs);
      if (String(url).endsWith('/explanation')) return response(sharedRunView(run).explanation);
      if (String(url).includes('/page?')) return response({ items: [], goals: [] });
      if (String(url).startsWith('/api/rooms') && init?.method === 'POST') return response({ id: 'room_created', title: '发布协作', status: 'active', createdAt: run.createdAt, updatedAt: run.updatedAt });
      return response([]);
    });
    start(`/runs/${run.id}`, fetch);
    await vi.waitFor(() => expect(dom.window.document.getElementById('run-title')?.textContent).toBe(run.goal));
    dom.window.document.getElementById('gb-new-group')!.click();
    await vi.waitFor(() => expect(dom.window.document.body.classList.contains('group-draft')).toBe(true));
    const doc = dom.window.document;
    expect(doc.getElementById('group-draft')?.hidden).toBe(false);
    expect(doc.getElementById('detail')?.hidden).toBe(true);
    expect(doc.getElementById('group-count-live')?.textContent).toContain('1 / 6');
    (doc.getElementById('group-title') as HTMLInputElement).value = '发布协作';
    (doc.getElementById('group-create') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(doc.getElementById('error')?.textContent).toContain('至少'));
    expect(fetch.mock.calls.some(call => String(call[0]) === '/api/rooms' && (call[1] as { method?: string } | undefined)?.method === 'POST')).toBe(false);
  });
});
describe('run link workbench', () => {
  it('renders filled PDF fields, unknowns, evidence and a PDF download in the actual workbench', async () => {
    const run = fixture(), output = await fillPdf(formSource, profile);
    run.builtinSkill = 'fillable-pdf/1';
    run.artifacts[0]!.artifactType = 'fillable-pdf/1';
    run.artifacts[0]!.structured = pdfArtifact(output);
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/status') return response({ modelConfigured: false, runner: 'unconfigured', mode: 'single-owner-local' });
      if (url === `/api/runs/${run.id}`) return response(run);
      if (url.endsWith('/graphs')) return response(sharedRunView(run).graphs);
      if (url.endsWith('/explanation')) return response(sharedRunView(run).explanation);
      if (url.includes('/page?')) return response({ items: [], goals: [] });
      return response([]);
    });
    start(`/runs/${run.id}`, fetch);
    await vi.waitFor(() => expect(dom.window.document.querySelector('.fillable-pdf')?.textContent).toContain('Maya Chen'));
    const doc = dom.window.document;
    expect(doc.querySelector('.fillable-pdf')?.textContent).toContain('phone · No source value; left empty.');
    expect(doc.querySelector('.fillable-pdf')?.textContent).toContain('caseId · Read-only; explicitly untouched.');
    expect(doc.querySelector('.fillable-pdf')?.textContent).toContain(output.sha256);
    expect(doc.querySelector('#artifacts a[download]')?.textContent).toBe('下载 PDF');
    expect(doc.querySelector('#artifacts a[download]')?.getAttribute('download')).toBe('filled-form.pdf');
    expect(doc.querySelector('#builtin-skill option[value="fillable-pdf/1"]')).not.toBeNull();
    expect(doc.querySelector('#material-files')?.getAttribute('accept')).toContain('.pdf');
  });
  it('loads only the shared run without auth and shows all requested read-only details', async () => {
    const run = fixture(), token = 'a'.repeat(43);
    for (let seq = 2; seq <= 100; seq++) run.events.push({ id: `event_${seq}`, seq, type: 'model.completed', at: run.createdAt, data: {} });
    const fetch = vi.fn(async () => response(sharedRunView(run)));
    start(`/share/${token}`, fetch);
    await vi.waitFor(() => expect(dom.window.document.getElementById('run-title')?.textContent).toBe(run.goal));
    const doc = dom.window.document;
    expect(doc.getElementById('copy-run-link')?.textContent).toBe('复制链接');
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
  it('renders a thread timeline, paginates, links parents, and retains the key after a lost follow-up response', async () => {
    const root = fixture(), child = fixture(), threadId = `thread_${randomUUID()}`;
    root.threadId = child.threadId = threadId; root.threadSequence = 1; child.threadSequence = 2; child.parentRunId = root.id;
    root.goal = '<img src=x onerror=alert(1)> root';
    const summaries = [root, child].map(run => ({ id: run.id, threadId, threadSequence: run.threadSequence, parentRunId: run.parentRunId, status: run.status, goal: run.goal, privacy: run.privacy, outputExcerpt: 'Timeline output <script>unsafe</script>' }));
    let attempts = 0;
    const fetch = vi.fn(async (url: string, options: any) => {
      if (url === `/api/threads/${threadId}/runs`) { if (++attempts === 1) throw new Error('Lost response'); return response(child); }
      if (url.startsWith(`/api/threads/${threadId}?`)) return response({ id: threadId, title: 'Reports', runs: url.endsWith('afterSequence=0') ? [summaries[0]] : [summaries[1]], ...(url.endsWith('afterSequence=0') ? { nextAfterSequence: 1 } : {}) });
      const run = url.includes(child.id) ? child : root;
      if (url.endsWith('/graphs')) return response(sharedRunView(run).graphs);
      if (url.endsWith('/explanation')) return response(sharedRunView(run).explanation);
      return response(run);
    });
    start(`/threads/${threadId}`, fetch);
    const doc = dom.window.document;
    await vi.waitFor(() => expect(doc.getElementById('thread-timeline')?.textContent).toContain(root.goal));
    expect(doc.querySelector('#thread-timeline img')).toBeNull(); expect(doc.querySelector('#thread-timeline script')).toBeNull();
    expect(doc.getElementById('thread-timeline')?.textContent).toContain('Timeline output');
    expect((doc.getElementById('run-thread-link') as HTMLAnchorElement).pathname).toBe(`/threads/${threadId}`);
    expect(dom.window.location.pathname).toBe(`/threads/${threadId}`);
    doc.getElementById('thread-more')!.click();
    await vi.waitFor(() => expect(doc.querySelectorAll('#thread-timeline > li')).toHaveLength(2));
    expect(doc.querySelector(`#thread-timeline a[href="/runs/${root.id}"]`)).not.toBeNull();
    expect(doc.querySelectorAll('#thread-parent option')).toHaveLength(2);
    (doc.getElementById('thread-message') as HTMLTextAreaElement).value = 'Continue the report';
    const submit = () => doc.getElementById('thread-followup')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    submit(); await vi.waitFor(() => expect(doc.getElementById('error')?.textContent).toContain('Lost response'));
    submit(); await vi.waitFor(() => expect(doc.getElementById('run-title')?.textContent).toBe(child.goal));
    const posts = fetch.mock.calls.filter(([url]) => url === `/api/threads/${threadId}/runs`);
    expect(posts).toHaveLength(2);
    expect(posts[0]![1].headers['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/);
    expect(posts[1]![1].headers['Idempotency-Key']).toBe(posts[0]![1].headers['Idempotency-Key']);
    expect(JSON.parse(posts[0]![1].body)).toEqual({ request: { goal: 'Continue the report', privacy: 'internal' }, parentRunId: root.id });
    expect(fetch.mock.calls.every(([, options]) => options.headers.authorization === 'Bearer saved-auth-secret')).toBe(true);
    expect(dom.window.location.pathname).toBe(`/threads/${threadId}`);
  });
  it('shows needs_input with the existing answer control and only terminal follow-up parents', async () => {
    const root = fixture(), child = fixture(), threadId = `thread_${randomUUID()}`;
    root.threadId = child.threadId = threadId; root.threadSequence = 1; child.threadSequence = 2; child.parentRunId = root.id;
    child.status = 'needs_input'; child.question = { text: 'Which report?' };
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(`/api/threads/${threadId}?`)) return response({ id: threadId, runs: [root, child] });
      if (url.includes('/events/stream')) return new Promise(() => {});
      const run = url.includes(root.id) ? root : child;
      if (url.endsWith('/graphs')) return response(sharedRunView(run).graphs);
      if (url.endsWith('/explanation')) return response(sharedRunView(run).explanation);
      if (url.endsWith('/answer')) { child.status = 'running'; return response({}); }
      return response(run);
    });
    start(`/threads/${threadId}`, fetch);
    const doc = dom.window.document;
    await vi.waitFor(() => expect(doc.getElementById('run-title')?.textContent).toBe(child.goal));
    expect(doc.querySelectorAll('#thread-parent option')).toHaveLength(1);
    expect((doc.getElementById('thread-parent') as HTMLSelectElement).value).toBe(root.id);
    const answerButton = [...doc.querySelectorAll<HTMLButtonElement>('#thread-timeline button')].find(button => button.textContent === '回答当前问题')!;
    answerButton.click(); await vi.waitFor(() => expect(doc.getElementById('input-panel')?.hidden).toBe(false));
    expect(doc.getElementById('question')?.textContent).toBe('Which report?');
    (doc.getElementById('answer') as HTMLTextAreaElement).value = 'October report';
    doc.getElementById('answer-form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => url === `/api/runs/${child.id}/answer`)).toBe(true));
  });
  it('renders thread shares without auth or owner links, and lets readers select each redacted run', async () => {
    const root = fixture(), child = fixture(), token = 't'.repeat(43), threadId = `thread_${randomUUID()}`;
    root.threadId = child.threadId = threadId; root.threadSequence = 1; child.threadSequence = 2; child.parentRunId = root.id; child.goal = 'Second report';
    const fetch = vi.fn(async () => response({ kind: 'thread', thread: { id: threadId, title: 'Shared reports' }, throughSequence: 2, runs: [sharedRunView(root), sharedRunView(child)] }));
    start(`/share/${token}`, fetch);
    const doc = dom.window.document;
    await vi.waitFor(() => expect(doc.getElementById('run-title')?.textContent).toBe(child.goal));
    expect(doc.querySelectorAll('#thread-timeline > li')).toHaveLength(2);
    expect(doc.getElementById('thread-meta')?.textContent).toContain('#2');
    expect(doc.getElementById('thread-followup')?.hidden).toBe(true); expect(doc.getElementById('thread-share-controls')?.hidden).toBe(true);
    expect(doc.getElementById('run-thread-link')?.hidden).toBe(true);
    expect(doc.querySelector('#thread-timeline a')).toBeNull(); expect(doc.querySelector('#artifacts a[download]')).toBeNull();
    (doc.querySelector('#thread-timeline button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(doc.getElementById('run-title')?.textContent).toBe(root.goal));
    expect(fetch.mock.calls.every(([url, options]: any) => url === `/api/share/${token}` && !options.headers.authorization)).toBe(true);
    expect(doc.getElementById('controls')?.childElementCount).toBe(0);
  });
  it('keeps the root request and key when a lost response is followed by a refreshed nonempty thread', async () => {
    const root = fixture(), threadId = `thread_${randomUUID()}`;
    root.threadId = threadId; root.threadSequence = 1;
    let posted = false, attempts = 0;
    const fetch = vi.fn(async (url: string, options: any) => {
      if (url === `/api/threads/${threadId}/runs`) { posted = true; if (++attempts === 1) throw new Error('Lost root response'); return response(root); }
      if (url.startsWith(`/api/threads/${threadId}?`)) return response({ id: threadId, runs: posted ? [root] : [] });
      if (url.endsWith('/graphs')) return response(sharedRunView(root).graphs);
      if (url.endsWith('/explanation')) return response(sharedRunView(root).explanation);
      return response(root);
    });
    start(`/threads/${threadId}`, fetch);
    const doc = dom.window.document;
    await vi.waitFor(() => expect(doc.getElementById('thread-panel')?.hidden).toBe(false));
    (doc.getElementById('thread-message') as HTMLTextAreaElement).value = 'First report';
    const submit = () => doc.getElementById('thread-followup')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    submit(); await vi.waitFor(() => expect(doc.getElementById('error')?.textContent).toContain('Lost root response'));
    doc.getElementById('connect')!.click();
    await vi.waitFor(() => expect(doc.getElementById('run-title')?.textContent).toBe(root.goal));
    expect((doc.getElementById('thread-parent') as HTMLSelectElement).value).toBe('');
    submit(); await vi.waitFor(() => expect((doc.getElementById('thread-message') as HTMLTextAreaElement).value).toBe(''));
    const posts = fetch.mock.calls.filter(([url]) => url.endsWith('/runs'));
    expect(posts).toHaveLength(2); expect(posts[0]![1].body).toBe(posts[1]![1].body);
    expect(JSON.parse(posts[0]![1].body)).not.toHaveProperty('parentRunId');
    expect(posts[0]![1].headers['Idempotency-Key']).toBe(posts[1]![1].headers['Idempotency-Key']);
  });
  it('creates and revokes a thread share with a copyable URL', async () => {
    const root = fixture(), threadId = `thread_${randomUUID()}`, token = 's'.repeat(43);
    root.threadId = threadId; root.threadSequence = 1;
    const fetch = vi.fn(async (url: string, options: any) => {
      if (url === `/api/threads/${threadId}/share`) return response({ url: `/share/${token}`, id: 'share_one', expiresAt: root.updatedAt, throughSequence: 1 });
      if (options.method === 'DELETE') return response({});
      if (url.startsWith(`/api/threads/${threadId}?`)) return response({ id: threadId, runs: [root] });
      if (url.endsWith('/graphs')) return response(sharedRunView(root).graphs);
      if (url.endsWith('/explanation')) return response(sharedRunView(root).explanation);
      return response(root);
    });
    start(`/threads/${threadId}`, fetch);
    const doc = dom.window.document;
    await vi.waitFor(() => expect(doc.getElementById('thread-panel')?.hidden).toBe(false));
    doc.getElementById('create-thread-share')!.click();
    await vi.waitFor(() => expect(doc.querySelector('#thread-share-result a')?.textContent).toBe(`http://localhost/share/${token}`));
    expect(doc.getElementById('thread-share-result')?.textContent).toContain('#1');
    (doc.querySelector('#thread-share-result button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(doc.getElementById('thread-share-result')?.textContent).toBe('分享已撤销'));
    expect(fetch.mock.calls.some(([url, options]) => url === `/api/threads/${threadId}/share/share_one` && options.method === 'DELETE')).toBe(true);
  });
});

describe('plan review workbench', () => {
  async function workbench(options: { readOnly?: boolean; shared?: boolean; stale?: boolean } = {}) {
    const run = fixture();
    run.status = 'needs_approval'; run.steps = []; run.artifacts = []; delete run.error; delete run.review;
    run.plans[0]!.summary = '初始计划';
    run.plans[0]!.nodes = [
      { id: 'read', title: '读取资料', instruction: '整理资料', dependsOn: [] },
      { id: 'write', title: '生成报告', instruction: '撰写报告', dependsOn: ['read'] },
    ];
    const posts: Array<{ action: string; body: any }> = [];
    const fetch = vi.fn(async (url: string, options: any) => {
      if (options.method === 'POST') {
        const action = url.split('/').at(-1)!, body = JSON.parse(options.body); posts.push({ action, body });
        if (action === 'approve' && optionsForFetch.stale) return { ok: false, status: 409, text: async () => JSON.stringify({ error: '计划已更新，请刷新后批准最新版本' }) };
        run.revision++;
        if (action === 'edit-plan') run.plans.push({ ...body.plan, version: body.planVersion + 1, hash: `hash${body.planVersion + 1}`, createdAt: run.createdAt, author: { type: 'user', actor: 'owner' } });
        if (action === 'budgets') { run.modelBudget = body.modelBudget; run.externalBudget = body.externalBudget; }
        if (action === 'revise-plan') run.status = 'planning';
        if (action === 'approve') run.status = 'running';
        return response(run);
      }
      if (url === '/api/status') return response({ modelConfigured: false, runner: 'unconfigured', mode: 'single-owner-local' });
      if (url.startsWith('/api/share/')) return response(sharedRunView(run));
      if (url.endsWith('/graphs')) return response(sharedRunView(run).graphs);
      if (url.endsWith('/explanation')) return response(sharedRunView(run).explanation);
      if (url === `/api/runs/${run.id}`) return response({ ...run, canEdit: !optionsForFetch.readOnly });
      if (url.includes('/page?')) return response({ items: [], goals: [] });
      return response([]);
    });
    const optionsForFetch = options;
    start(options.shared ? `/share/${'s'.repeat(43)}` : `/runs/${run.id}`, fetch);
    await vi.waitFor(() => expect(dom.window.document.querySelector('.plan-review-editor')).not.toBeNull());
    const doc = dom.window.document;
    const click = (label: string, parent: ParentNode = doc) => {
      const button = [...parent.querySelectorAll('button')].find(button => button.textContent === label);
      expect(button, label).toBeDefined(); button!.click();
    };
    const fill = (label: string, value: string) => {
      const input = doc.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
      expect(input, label).not.toBeNull(); input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    return { run, posts, doc, click, fill };
  }

  it('edits tasks inline, deletes, adds, reorders and displays version changes before approval', async () => {
    const f = await workbench();
    f.fill('任务 1 标题', '核查资料'); f.fill('任务 1 目标', '核对原始资料'); f.fill('任务 1 证据要求', '引用原始文件');
    f.doc.getElementById('decision-next-button')!.click();
    await vi.waitFor(() => expect(f.doc.body.textContent).toContain('请先将任务修改保存为新版本'));
    expect(f.posts).toHaveLength(0);
    const tasks = f.doc.querySelectorAll('.plan-review-editor fieldset');
    f.click('删除任务', tasks[2]!);
    await vi.waitFor(() => expect(f.doc.querySelector('[aria-label="任务 2 标题"]')).toBeNull());
    f.click('添加任务');
    await vi.waitFor(() => expect(f.doc.querySelector('[aria-label="任务 2 标题"]')).not.toBeNull());
    f.fill('任务 2 标题', '生成简报'); f.fill('任务 2 目标', '整理简报');
    f.click('上移', f.doc.querySelectorAll('.plan-review-editor fieldset')[2]!);
    await vi.waitFor(() => expect((f.doc.querySelector('[aria-label="任务 1 标题"]') as HTMLInputElement).value).toBe('生成简报'));
    f.click('保存为新版本');
    await vi.waitFor(() => expect(f.doc.querySelector('.plan-review-editor')?.textContent).toContain('计划版本历史 · 2 个版本'));
    expect(f.posts[0]).toMatchObject({ action: 'edit-plan', body: { planVersion: 1, plan: { nodes: [
      { id: 'task_1', title: '生成简报', instruction: '整理简报' },
      { id: 'read', title: '核查资料', instruction: '核对原始资料', evidenceRequirements: '引用原始文件' },
    ] } } });
    expect(f.doc.querySelector('.plan-review-editor')?.textContent).toContain('删除任务：生成报告');
    expect(f.doc.querySelector('.plan-review-editor')?.textContent).toContain('新增任务：生成简报');
    expect(f.doc.querySelector('.plan-review-editor')?.textContent).toContain('证据要求：未设置 → 引用原始文件');
    expect(f.doc.querySelector('.plan-review-editor')?.textContent).toContain('任务顺序：');
    f.doc.getElementById('decision-next-button')!.click();
    await vi.waitFor(() => expect(f.posts.at(-1)).toMatchObject({ action: 'approve', body: { planVersion: 2, planHash: 'hash2' } }));
  });

  it('submits free-text feedback and rejects empty feedback without a request', async () => {
    const f = await workbench(); f.click('提交要求并重新规划');
    await vi.waitFor(() => expect(f.doc.querySelector('.plan-review-editor [role="alert"]')?.textContent).toContain('请填写补充要求'));
    expect(f.posts).toHaveLength(0);
    f.fill('补充要求', '  增加风险和证据核查  '); f.click('提交要求并重新规划');
    await vi.waitFor(() => expect(f.posts).toEqual([{ action: 'revise-plan', body: { planVersion: 1, feedback: '增加风险和证据核查' } }]));
    await vi.waitFor(() => expect(f.doc.getElementById('decision-review')?.hidden).toBe(true));
  });

  it('preserves draft inputs through refresh and sends all budget limits with approval', async () => {
    const f = await workbench();
    f.fill('补充要求', '保留未提交的反馈'); f.fill('任务 1 标题', '待保存的标题');
    f.fill('模型 Token 上限', '1000'); f.fill('模型金额上限（美元）', '0.5');
    f.fill('外部调用次数上限', '3'); f.fill('外部 Token 上限', '100'); f.fill('外部金额上限（美元）', '1.2');
    f.click('保存预算');
    await vi.waitFor(() => expect(f.posts).toHaveLength(1));
    await vi.waitFor(() => expect([...f.doc.querySelectorAll('.plan-review-editor button')].find(button => button.textContent === '保存预算')?.disabled).toBe(false));
    expect((f.doc.querySelector('[aria-label="补充要求"]') as HTMLTextAreaElement).value).toBe('保留未提交的反馈');
    expect((f.doc.querySelector('[aria-label="任务 1 标题"]') as HTMLInputElement).value).toBe('待保存的标题');
    f.click('保存为新版本');
    await vi.waitFor(() => expect(f.doc.querySelector('.plan-review-editor')?.textContent).toContain('2 个版本'));
    f.click('批准并执行', f.doc.getElementById('decision-review-actions')!);
    await vi.waitFor(() => expect(f.posts.at(-1)).toEqual({ action: 'approve', body: { planVersion: 2, planHash: 'hash2', modelBudget: { tokens: 1000, moneyUsd: 0.5 }, externalBudget: { calls: 3, tokens: 100, moneyUsd: 1.2 } } }));
  });

  it('shows stale approval conflicts and keeps the review form available', async () => {
    const f = await workbench({ stale: true }); f.fill('外部调用次数上限', '2');
    f.click('批准并执行', f.doc.getElementById('decision-review-actions')!);
    await vi.waitFor(() => expect(f.doc.body.textContent).toContain('计划已更新，请刷新后批准最新版本'));
    expect(f.posts[0]).toMatchObject({ action: 'approve', body: { planVersion: 1, externalBudget: { calls: 2 } } });
    expect(f.doc.getElementById('decision-review')?.hidden).toBe(false);
  });

  it.each([{ readOnly: true }, { shared: true }])('omits editing and approval controls in read-only views (%j)', async options => {
    const f = await workbench(options);
    expect(f.doc.querySelector('.plan-review-editor input, .plan-review-editor textarea, .plan-review-editor button')).toBeNull();
    expect(f.doc.getElementById('decision-review-actions')?.textContent).not.toContain('批准并执行');
    expect(f.doc.getElementById('decision-next-button')?.hidden).toBe(true);
    expect(f.doc.getElementById('controls')?.hidden).toBe(true);
    expect(f.posts).toHaveLength(0);
  });
});
