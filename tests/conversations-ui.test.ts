import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

let source: string, html: string, css: string;
let dom: JSDOM;
beforeAll(async () => {
  source = (await build({ entryPoints: ['src/ui/app.ts'], bundle: true, format: 'iife', target: 'es2022', write: false })).outputFiles![0]!.text;
  [html, css] = await Promise.all([readFile('public/index.html', 'utf8'), readFile('public/style.css', 'utf8')]);
});
afterEach(() => dom?.window.close());
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
const date = '2026-10-21T10:00:00Z';
const scope = JSON.stringify(['single-owner-local', 'local', 'owner']);
const runId = 'run_00000000-0000-4000-8000-000000000001';
function fixture() {
  return { id: 'conv_00000000-0000-4000-8000-000000000001', title: '项目讨论', revision: 1, focusTaskId: 'task_a' as string | undefined,
    tasks: [{ id: 'task_a', title: '发布方案', threadId: 'thread_a', status: 'discussion' }, { id: 'task_b', title: '周报', threadId: 'thread_b', status: 'succeeded', runId, latestRunId: runId }],
    messages: [] as any[], hasEarlierMessages: false };
}
function runFixture() {
  return { id: runId, revision: 1, goal: '周报执行', status: 'succeeded', canEdit: true, workingMemoryEnabled: true, privacy: 'internal',
    plans: [{ version: 1, hash: 'plan-hash', summary: 'Plan', nodes: [{ id: 'node_report', title: '核对证据', dependsOn: [] }] }],
    steps: [{ taskId: 'node_report', status: 'succeeded' }], events: [], artifacts: [], calls: [], context: { sources: [] } };
}
function harness(view = fixture(), options: { enabled?: boolean; model?: boolean; handler?: (url: string, options: any) => any } = {}) {
  const posts: Array<{ url: string; body: any; key: string; raw: string }> = [];
  const lives = new Map<string, any>();
  const conversationFor = (requestUrl: string) => {
    const match = String(requestUrl).match(/\/api\/conversations\/([^/?]+)/);
    if (!match) return undefined;
    const id = decodeURIComponent(match[1] ?? '');
    if (id === view.id) return view;
    return lives.get(id);
  };
  let principal = 'owner';
  const fetch = vi.fn(async (url: string, request: any) => {
    if (request.method === 'POST') posts.push({ url, body: JSON.parse(request.body), raw: request.body, key: request.headers['Idempotency-Key'] });
    const custom = options.handler?.(url, request);
    if (custom !== undefined) return custom;
    if (url === '/api/status') return response({ modelConfigured: options.model ?? true, runner: 'fixture', mode: 'single-owner-local', principal, tenantId: 'local', conversationRouting: options.enabled ?? true });
    if (url === '/api/tools') return response({ tools: [], defaultAllowedTools: [] });
    if (url === '/api/conversations' && request.method === 'POST') {
      const body = JSON.parse(request.body);
      if (body?.agentId) {
        const known = [view, ...lives.values()].find(item => item.agentId === body.agentId);
        if (known) return response(known);
        if (body.claimId) {
          const claimed = body.claimId === view.id ? view : lives.get(body.claimId);
          if (!claimed) return response({ error: 'Unknown conversation' }, 404);
          if (claimed.agentId && claimed.agentId !== body.agentId) return response({ error: '这条对话已经属于另一个人' }, 409);
          claimed.agentId = body.agentId;
          return response(claimed);
        }
        const created = { id: `conv_life_${lives.size + 1}`, title: body.title || body.agentId, revision: 0, agentId: body.agentId, tasks: [] as any[], messages: [] as any[], hasEarlierMessages: false };
        lives.set(created.id, created);
        return response(created);
      }
      return response(view);
    }
    if (url === '/api/conversations') return response([view, ...lives.values()]);
    if (url.endsWith('/notifications/sync')) {
      const target = conversationFor(url) ?? view;
      if (!target.messages.some((item: { id: string }) => item.id === 'notice')) target.messages.push({ id: 'notice', role: 'notification', text: '周报已完成', createdAt: date, notificationRunId: runId, route: { status: 'routed', reason: 'explicit', taskIds: ['task_b'], candidateTaskIds: [], focusEffect: 'keep' } });
      target.revision++; return response(target);
    }
    if (url.endsWith('/focus')) { const target = conversationFor(url) ?? view; const body = JSON.parse(request.body); target.focusTaskId = body.taskId ?? undefined; target.revision++; return response(target); }
    if (url.endsWith('/standing')) {
      const target = conversationFor(url);
      if (!target) return response({ error: 'Unknown conversation' }, 404);
      const body = JSON.parse(request.body);
      if (body.expectedRevision !== target.revision) return response({ error: '对话已变化，请先刷新再改这句话' }, 409);
      const text = String(body.text ?? '').trim();
      if (text) target.standingInstruction = text;
      else delete target.standingInstruction;
      target.revision++;
      return response(target);
    }
    if (url.endsWith('/messages')) {
      const target = conversationFor(url);
      if (!target) return response({ error: 'Unknown conversation' }, 404);
      const body = JSON.parse(request.body);
      const replied = target.messages.find((item: { id: string }) => item.id === body.replyTo);
      const created = body.newTask ? { id: `task_new_${target.tasks.length}`, title: body.newTask.title, threadId: `thread_new_${target.tasks.length}`, status: 'discussion' } : undefined;
      if (created) {
        target.tasks.push(created);
        if (body.focus === 'switch') target.focusTaskId = created.id;
      }
      const route = { status: 'routed', reason: created ? 'new-task' : body.replyTo ? 'reply' : body.taskIds ? 'explicit' : 'focus', taskIds: created ? [created.id] : body.taskIds ?? (body.replyTo ? replied?.effectiveTaskIds ?? replied?.route.taskIds : [target.focusTaskId]), candidateTaskIds: [], focusEffect: body.focus };
      const message = { id: `message_${target.messages.length}`, role: 'user', text: body.text, createdAt: date, route, ...(body.replyTo ? { replyTo: body.replyTo } : {}), ...(body.correctsMessageId ? { correctsMessageId: body.correctsMessageId } : {}), ...(body.intent === 'execute' ? { execution: { taskId: route.taskIds[0], runId, state: 'completed' } } : {}) };
      if (body.correctsMessageId) target.messages.find((item: { id: string }) => item.id === body.correctsMessageId).effectiveTaskIds = body.taskIds;
      target.messages.push(message); target.revision++;
      return response({ conversation: target, message, response: body.correctsMessageId ? '已追加归属纠正，仅影响后续消息和新执行上下文；已有执行记录不变。' : body.intent === 'execute' ? '已创建执行，仍需计划审批。' : '已记录讨论，未触发执行。', ...(body.intent === 'execute' ? { runId } : {}) });
    }
    if (/^\/api\/conversations\/[^/]+$/.test(url)) {
      const target = conversationFor(url);
      if (target) return response(target);
    }
    if (url === `/api/runs/${runId}`) return response(runFixture());
    if (url.endsWith('/graphs')) return response({ execution: { nodes: [], edges: [] }, evidence: { nodes: [], edges: [] } });
    if (url.endsWith('/explanation')) return response({ schemaVersion: 'run-explanation/1', run: { id: runId, status: 'succeeded', privacy: 'internal', updatedAt: date }, attention: { kind: 'none', nextAction: 'done', blockers: [] }, plan: { tasks: { total: 1, pending: 0, running: 0, succeeded: 1 }, readyTaskIds: [], pendingTaskIds: [] }, execution: { eventCount: 0, modelCalls: { total: 0, started: 0, completed: 0, failed: 0, unknown: 0, discarded: 0 }, tools: { total: 0, completed: 0, failed: 0, unknown: 0 }, delegations: { total: 0, completed: 0, failed: 0, unknown: 0 } }, evidence: { sourceCount: 0, artifactCount: 0, receiptCount: 0, evidenceNodeCount: 0, memoryRefs: [] }, governance: { tools: [], agents: [] }, budget: {} });
    if (url.includes('/page?')) return response({ items: [], goals: [] });
    return response([]);
  });
  return { view, fetch, posts, setPrincipal(value: string) { principal = value; } };
}
function start(fetch: any, saved: { local?: Record<string, string>; session?: Record<string, string> } = {}) {
  dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const style = dom.window.document.createElement('style'); style.textContent = css; dom.window.document.head.append(style);
  for (const [key, value] of Object.entries(saved.local ?? {})) dom.window.localStorage.setItem(key, value);
  for (const [key, value] of Object.entries(saved.session ?? {})) dom.window.sessionStorage.setItem(key, value);
  dom.window.fetch = fetch; dom.window.setInterval = (() => 1) as any;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any;
  dom.window.eval(source);
}
const doc = () => dom.window.document;
const el = <T extends HTMLElement = HTMLElement>(id: string) => doc().getElementById(id) as T;
function fill(id: string, value: string) { const input = el<HTMLInputElement>(id); input.value = value; input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }
function submit() { el('conversation-composer').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); }
function clickText(text: string, root: ParentNode = doc()) { const control = [...root.querySelectorAll('button')].find(button => button.textContent === text); expect(control, text).toBeDefined(); control!.click(); }
async function ready() { await vi.waitFor(() => expect(el('conversation-focus').textContent).toContain('发布方案')); }
const messagePosts = (h: ReturnType<typeof harness>) => h.posts.filter(post => post.url.endsWith('/messages'));

describe('single-entry conversation workbench', () => {
  it('defaults to discussion, uses the authoritative focus and shows an honest acknowledgement without model execution', async () => {
    const h = harness(undefined, { model: false }); start(h.fetch); await ready();
    fill('conversation-text', '补充讨论背景'); submit();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('系统回执：已记录讨论'));
    expect(messagePosts(h)[0]?.body).toEqual({ text: '补充讨论背景', expectedRevision: 1, focus: 'keep', intent: 'discuss' });
    expect(el('conversation-messages').textContent).toContain('关联任务：发布方案');
    expect(el('conversation-messages').textContent).toContain('未调用模型');
    expect(el<HTMLAnchorElement>('entry-team').textContent).toBe('多 Bot 频道');
    expect(el<HTMLAnchorElement>('entry-team').getAttribute('href')).toBe('/team/');
    expect(el<HTMLButtonElement>('conversation-execute').disabled).toBe(true);
    expect(h.posts.some(post => /\/runs$|\/approve$/.test(post.url))).toBe(false);
    expect(dom.window.getComputedStyle(el('quick-run')).display).toBe('none');
    expect(el('new-run')).not.toBeNull();
  });

  it('separates focus, notifications, reply and viewing Run details, retaining the single entry URL', async () => {
    const h = harness(); start(h.fetch); await ready();
    el('conversation-sync').click();
    await vi.waitFor(() => expect(el('conversation-messages').textContent).toContain('周报已完成'));
    expect(el('conversation-focus').textContent).toContain('发布方案');
    clickText('回复这条消息'); fill('conversation-text', '周报还有哪些问题？'); submit();
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(1));
    expect(messagePosts(h)[0]?.body).toMatchObject({ replyTo: 'notice', focus: 'keep', intent: 'discuss' });
    expect(el('conversation-focus').textContent).toContain('发布方案');
    clickText('查看此次运行');
    await vi.waitFor(() => expect(el('run-title').textContent).toBe('周报执行'));
    expect(dom.window.location.pathname).toBe('/');
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(h.posts.filter(post => post.url.endsWith('/focus'))).toHaveLength(0);
    clickText('设为讨论焦点', doc().querySelector('[data-task-id="task_b"]')!);
    await vi.waitFor(() => expect(el('conversation-focus').textContent).toContain('周报'));
    expect(h.posts.at(-1)?.body).toEqual({ taskId: 'task_b', expectedRevision: h.view.revision - 1 });
  });

  it('shows ambiguous choices without executing or silently making a new task', async () => {
    const view = fixture();
    view.messages.push({ id: 'ambiguous', role: 'user', text: '继续那个任务', createdAt: date, route: { status: 'clarify', reason: 'ambiguous', taskIds: [], candidateTaskIds: ['task_a', 'task_b'], focusEffect: 'keep' } });
    const h = harness(view); start(h.fetch); await ready();
    expect(el('conversation-messages').textContent).toContain('待澄清：未执行');
    clickText('选择任务：周报');
    expect(h.posts).toHaveLength(0);
    expect(el<HTMLSelectElement>('conversation-target').value).toBe('task_b');
    expect(el('conversation-status').textContent).toContain('尚未执行');
    submit(); await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(1));
    expect(messagePosts(h)[0]?.body).toMatchObject({ text: '继续那个任务', replyTo: 'ambiguous', taskIds: ['task_b'], focus: 'keep', intent: 'discuss' });
    expect(messagePosts(h)[0]?.body).not.toHaveProperty('newTask');
  });

  it('appends an explicit routing correction without executing, switching focus or rewriting the original route', async () => {
    const view = fixture();
    view.messages.push({ id: 'misrouted', role: 'user', text: '只属于周报的事实', createdAt: date, route: { status: 'routed', reason: 'explicit', taskIds: ['task_a'], candidateTaskIds: [], focusEffect: 'keep' } });
    const h = harness(view); start(h.fetch); await ready();
    clickText('纠正归属');
    expect(el<HTMLTextAreaElement>('conversation-text').readOnly).toBe(true);
    expect(el('conversation-correction-label').textContent).toContain('只属于周报的事实');
    expect(el<HTMLButtonElement>('conversation-execute').disabled).toBe(true);
    fill('conversation-target', 'task_b');
    el<HTMLButtonElement>('conversation-send').click();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('系统回执'));
    expect(messagePosts(h)).toHaveLength(1);
    expect(messagePosts(h)[0]?.body).toEqual({ text: '纠正这条讨论的任务归属', expectedRevision: 1, taskIds: ['task_b'], correctsMessageId: 'misrouted', intent: 'discuss', focus: 'keep' });
    expect(h.posts.some(post => /\/runs(?:\/|$)|\/approve$/.test(post.url))).toBe(false);
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(el('conversation-messages').textContent).toContain('原始关联任务（审计）：发布方案');
    expect(el('conversation-messages').textContent).toContain('当前有效归属（已纠正）：周报');
    expect(el('conversation-messages').textContent).toContain('归属纠正记录：misrouted');
    expect(el<HTMLTextAreaElement>('conversation-text').value).toBe('');
    expect(el<HTMLTextAreaElement>('conversation-text').readOnly).toBe(false);
  });

  it('creates execution only with its explicit button and forwards bounded options, never approval', async () => {
    const h = harness(); start(h.fetch); await ready();
    fill('conversation-target', '__new'); fill('conversation-task-title', '独立发布检查'); fill('conversation-text', '核查发布风险');
    fill('conversation-focus-effect', 'switch'); fill('materials', '资料 <script>unsafe</script>'); fill('allowed-tools', 'read'); fill('model-budget-tokens', '1200');
    el('conversation-execute').click();
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(1));
    expect(messagePosts(h)[0]?.body).toMatchObject({ intent: 'execute', focus: 'switch', newTask: { title: '独立发布检查' }, runOptions: { executionReview: 'required', planning: 'dag', allowedTools: ['read'], modelBudget: { tokens: 1200 }, materials: [{ content: '资料 <script>unsafe</script>' }] } });
    expect(messagePosts(h)[0]?.body.runOptions).not.toHaveProperty('goal');
    expect(messagePosts(h)[0]?.body.runOptions).not.toHaveProperty('goalId');
    expect(messagePosts(h)[0]?.body.runOptions).not.toHaveProperty('taskExecution');
    expect(h.posts.some(post => post.url.endsWith('/approve'))).toBe(false);
  });

  it('keeps the chosen execution review on the next explicit run and does not execute discussion', async () => {
    const h = harness(); start(h.fetch); await ready();
    fill('execution-review', 'yolo');
    expect(el('conversation-execution-note').textContent).toContain('自动执行');
    fill('conversation-text', '只是讨论');
    submit();
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(1));
    expect(messagePosts(h)[0]?.body.intent).toBe('discuss');
    expect(messagePosts(h)[0]?.body).not.toHaveProperty('runOptions');
    await vi.waitFor(() => expect(el<HTMLButtonElement>('conversation-execute').disabled).toBe(false));
    expect(el<HTMLSelectElement>('execution-review').value).toBe('yolo');
    fill('conversation-text', '现在执行');
    el('conversation-execute').click();
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(2));
    expect(messagePosts(h)[1]?.body).toMatchObject({ intent: 'execute', runOptions: { executionReview: 'yolo', planning: 'direct' } });
    expect(el('conversation-execution-note').textContent).toContain('直接执行');
    await vi.waitFor(() => expect(el<HTMLSelectElement>('execution-review').value).toBe('yolo'));
    expect(h.posts.some(post => post.url.endsWith('/approve'))).toBe(false);
    dom.window.localStorage.removeItem('aeeis.execution-review');
  });

  it('switches the next explicit run to a task graph when the request leaves the read-only boundary', async () => {
    const h = harness(); start(h.fetch); await ready();
    fill('conversation-text', '今天天气怎么样');
    expect(el('conversation-execution-note').textContent).toContain('先出任务图');
    expect(el('conversation-execution-note').textContent).toContain('实时数据');
    await vi.waitFor(() => expect(el<HTMLButtonElement>('conversation-execute').disabled).toBe(false));
    el('conversation-execute').click();
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(1));
    expect(messagePosts(h)[0]?.body).toMatchObject({ intent: 'execute', runOptions: { planning: 'dag' } });
    fill('allowed-tools', '');
    fill('conversation-text', '读这张纸条');
    expect(el('conversation-execution-note').textContent).toContain('直接执行');
  });

  it('blocks execution of nonterminal tasks but still accepts discussion', async () => {
    const view = fixture(); view.tasks[0]!.status = 'needs_input';
    const h = harness(view); start(h.fetch); await ready();
    expect(el<HTMLButtonElement>('conversation-execute').disabled).toBe(true);
    expect(el('conversation-execution-note').textContent).toContain('批准、回答或取消');
    fill('conversation-text', '额外背景'); submit();
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(1));
    expect(messagePosts(h)[0]?.body.intent).toBe('discuss');
  });

  it('requires an explicit refreshed resend after stale revision conflicts', async () => {
    let fail = true;
    const h = harness(undefined, { handler(url) { if (url.endsWith('/messages') && fail) { fail = false; return response({ error: 'Discussion focus changed' }, 409); } } });
    start(h.fetch); await ready(); fill('conversation-text', '继续执行'); el('conversation-execute').click();
    await vi.waitFor(() => expect(el('conversation-error').textContent).toContain('刷新对话'));
    expect(el<HTMLButtonElement>('conversation-send').disabled).toBe(true);
    h.view.focusTaskId = 'task_b'; h.view.revision = 5; el('conversation-refresh').click();
    await vi.waitFor(() => expect(el('conversation-focus').textContent).toContain('周报'));
    expect(messagePosts(h)).toHaveLength(1);
    expect(el<HTMLTextAreaElement>('conversation-text').value).toBe('继续执行');
    el('conversation-execute').click(); await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(2));
    expect(messagePosts(h)[1]?.body.expectedRevision).toBe(5);
    expect(messagePosts(h)[1]?.key).not.toBe(messagePosts(h)[0]?.key);
    expect(messagePosts(h)[0]?.body.taskIds).toEqual(['task_a']);
    expect(messagePosts(h)[1]?.body.taskIds).toEqual(['task_b']);
  });

  it('keeps the idempotency key when preparation asks to retry the same request', async () => {
    const h = harness(undefined, { handler(url) { if (url.endsWith('/messages')) return response({ error: '结果尚未确认', retrySameRequest: true }, 409); } });
    start(h.fetch); await ready(); fill('conversation-text', '继续执行'); el('conversation-execute').click();
    await vi.waitFor(() => expect(el<HTMLButtonElement>('conversation-retry').disabled).toBe(false));
    expect(el('conversation-error').textContent).toContain('结果尚未确认');
    expect(el('conversation-retry-panel').hidden).toBe(false);
    expect(dom.window.sessionStorage.getItem('aeeis.conversation-pending')).toContain('继续执行');
    el('conversation-retry').click();
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(2));
    expect(messagePosts(h)[1]?.key).toBe(messagePosts(h)[0]?.key);
    expect(messagePosts(h)[1]?.raw).toBe(messagePosts(h)[0]?.raw);
  });

  it('renders a cancelled execution as not created', async () => {
    const view = fixture();
    view.messages.push({ id: 'cancelled', role: 'user', text: '生成报告', createdAt: date, route: { status: 'routed', reason: 'explicit', taskIds: ['task_a'], candidateTaskIds: [], focusEffect: 'keep' }, execution: { taskId: 'task_a', runId, state: 'cancelled' } });
    const h = harness(view); start(h.fetch); await ready();
    expect(el('conversation-messages').textContent).toContain('这次执行没有创建，请重新发送。');
    expect(el('conversation-messages').textContent).not.toContain(runId);
  });

  it('prevents double sends and replays the exact request and key after a lost response and reload', async () => {
    let reject!: (error: Error) => void, attempts = 0;
    const h = harness(undefined, { handler(url) { if (url.endsWith('/messages') && ++attempts === 1) return new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }); } });
    start(h.fetch); await ready(); fill('conversation-text', '原始执行请求'); el('conversation-execute').click(); el('conversation-execute').click(); submit();
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(1));
    expect(el<HTMLTextAreaElement>('conversation-text').disabled).toBe(true);
    reject(new Error('Lost response'));
    await vi.waitFor(() => expect(el('conversation-error').textContent).toContain('结果尚未确认'));
    const local = Object.fromEntries(Object.keys(dom.window.localStorage).map(key => [key, dom.window.localStorage.getItem(key)!]));
    const session = Object.fromEntries(Object.keys(dom.window.sessionStorage).map(key => [key, dom.window.sessionStorage.getItem(key)!]));
    expect(session['aeeis.conversation-pending']).toContain('原始执行请求');
    h.view.revision = 20; h.view.focusTaskId = 'task_b';
    dom.window.close(); start(h.fetch, { local, session });
    await vi.waitFor(() => expect(el('conversation-retry-panel').hidden).toBe(false));
    fill('model-budget-tokens', '9999'); el('conversation-retry').click();
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(2));
    expect(messagePosts(h)[1]?.raw).toBe(messagePosts(h)[0]?.raw);
    expect(messagePosts(h)[1]?.key).toBe(messagePosts(h)[0]?.key);
    await vi.waitFor(() => expect(dom.window.sessionStorage.getItem('aeeis.conversation-pending')).toBeNull());
  });

  it('restores the selected entry but never a client-side focus, and renders untrusted names as text', async () => {
    const view = fixture(); view.title = '<img src=x onerror=alert(1)>'; view.tasks[0]!.title = '<svg onload=alert(1)>发布方案'; view.hasEarlierMessages = true;
    const h = harness(view); start(h.fetch, { local: { 'aeeis.conversation': view.id, 'aeeis.conversation-scope': scope, 'aeeis.focus': 'task_b' } }); await ready();
    expect(el('conversation-focus').textContent).toContain('<svg onload=alert(1)>');
    expect(doc().querySelector('#conversation-panel img, #conversation-panel svg, #conversation-panel script')).toBeNull();
    expect(el('conversation-earlier').hidden).toBe(false);
    expect(h.posts).toHaveLength(0);
    expect(dom.window.localStorage.getItem('aeeis.conversation')).toBe(view.id);
  });

  it('clears private drafts and pending requests on identity changes and ignores old responses', async () => {
    let resolve!: (value: any) => void;
    const h = harness(undefined, { handler(url) { if (url.endsWith('/messages')) return new Promise(done => { resolve = done; }); } });
    start(h.fetch, { session: { 'aeeis.token': 'old-token' } }); await ready(); fill('conversation-text', '私人草稿'); submit();
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(1));
    fill('token', 'new-token'); h.setPrincipal('new-owner'); h.view.title = '另一身份'; h.view.tasks = []; h.view.focusTaskId = undefined;
    el('connect').click();
    await vi.waitFor(() => expect(el<HTMLTextAreaElement>('conversation-text').value).toBe(''));
    expect(dom.window.sessionStorage.getItem('aeeis.conversation-pending')).toBeNull();
    resolve(response({ conversation: fixture(), message: { id: 'old' }, response: '私人回执' }));
    await vi.waitFor(() => expect(el('conversation-select').textContent).toContain('另一身份'));
    expect(el('conversation-panel').textContent).not.toContain('私人');
    expect(el('conversation-panel').textContent).not.toContain('发布方案');
  });

  it('keeps legacy embeddings unchanged when the feature flag is absent or false', async () => {
    const h = harness(undefined, { enabled: false }); start(h.fetch);
    await vi.waitFor(() => expect(h.fetch.mock.calls.some(([url]) => url === '/api/runs/page?limit=50')).toBe(true));
    expect(el('conversation-panel').hidden).toBe(true);
    expect(h.fetch.mock.calls.some(([url]) => url.startsWith('/api/conversations'))).toBe(false);
    expect(dom.window.getComputedStyle(el('quick-run')).display).not.toBe('none');
  });

  it('shows memory counts on the task card and opens readable summaries without moving focus', async () => {
    const view = fixture();
    view.tasks[1] = { ...view.tasks[1]!, memory: { originals: 2, activeSummaries: 1 } };
    const h = harness(view, { handler(url) {
      if (url.includes('/working-memory?')) return response({ index: { totalOriginals: 2, entries: [] }, summaries: [{ version: 1, items: [{ text: '<script>SECRET SUMMARY</script>', references: ['wm_slice_one'] }] }] });
    } });
    start(h.fetch); await ready();
    const card = doc().querySelector<HTMLElement>('[data-task-id="task_b"]')!;
    expect(card.textContent).toContain('1 份压缩摘要，2 份原文');
    expect(card.textContent).not.toContain('SECRET');
    expect(doc().querySelector('[data-task-id="task_a"]')!.textContent).not.toContain('工作记忆');
    clickText('查看任务记忆', card);
    await vi.waitFor(() => expect(el('working-memory-content').textContent).toContain('<script>SECRET SUMMARY</script>'));
    expect(el<HTMLDetailsElement>('working-memory-details').open).toBe(true);
    expect(el('working-memory-content').textContent).toContain('引用切片：wm_slice_one');
    expect(doc().querySelector('#working-memory-content script')).toBeNull();
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(h.posts).toHaveLength(0);
  });

  it('reads memory by Run plan node, searches and paginates original text without changing focus', async () => {
    const h = harness(undefined, { handler(url) {
      if (url.includes('/working-memory/original')) return response({ originalId: 'original_one', text: '<script>untrusted page</script>', page: { characterOffset: url.includes('offset=1800') ? 1800 : 0, totalChars: 2000, nextCharacterOffset: url.includes('offset=1800') ? null : 1800 } });
      if (url.includes('/working-memory/search')) return response({ total: 1, results: [{ originalId: 'original_one', locator: 'tool.output', totalChars: 2000, excerpt: 'untrusted <img>' }] });
      if (url.includes('/working-memory?')) return response({ index: { totalOriginals: 1, entries: [{ id: 'original_one', locator: 'tool.output', phase: 'executor', totalChars: 2000 }] }, summaries: [] });
    } });
    start(h.fetch); await ready(); clickText('查看运行');
    await vi.waitFor(() => expect(el('working-memory-panel').hidden).toBe(false));
    expect(el<HTMLSelectElement>('working-memory-task').value).toBe('node_report');
    clickText('读取节点索引'); await vi.waitFor(() => expect(el('working-memory-content').textContent).toContain('tool.output'));
    clickText('查看原文'); await vi.waitFor(() => expect(el('working-memory-content').textContent).toContain('<script>untrusted page</script>'));
    expect(doc().querySelector('#working-memory-content script')).toBeNull();
    clickText('下一页原文'); await vi.waitFor(() => expect(h.fetch.mock.calls.some(([url]) => url.includes('taskId=node_report&entryId=original_one&offset=1800'))).toBe(true));
    fill('working-memory-query', '*'); doc().querySelector('#working-memory-content form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(el('working-memory-content').textContent).toContain('untrusted <img>'));
    expect(doc().querySelector('#working-memory-content img')).toBeNull();
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(h.posts).toHaveLength(0);
  });

  it('names compaction in the run progress and refreshes memory counts without moving focus', async () => {
    const view = fixture();
    view.tasks[1] = { ...view.tasks[1]!, status: 'running', memory: { originals: 2, activeSummaries: 0 } };
    const events = [
      { seq: 1, type: 'model.started', at: date, data: { phase: 'compaction', callId: 'call_compact' } },
      { seq: 2, type: 'context.summary_rejected', at: date, data: { taskId: 'node_report', callId: 'call_compact' } },
      { seq: 3, type: 'context.summary_discarded', at: date, data: { taskId: 'node_report', callId: 'call_compact' } },
      { seq: 4, type: 'context.summary_failed', at: date, data: { taskId: 'node_report', callId: 'call_compact' } },
      { seq: 5, type: 'context.summary_active', at: date, data: { taskId: 'node_report', manifestId: 'manifest_1', version: 1, callId: 'call_compact' } },
    ];
    let push: ((frame: string) => void) | undefined;
    const h = harness(view, { handler(url) {
      if (url.includes('/events/stream')) {
        return { ok: true, status: 200, body: new ReadableStream({ start(controller) {
          const encoder = new TextEncoder();
          push = frame => controller.enqueue(encoder.encode(frame));
        } }) };
      }
      if (url === `/api/runs/${runId}`) return response({ ...runFixture(), status: 'running', events });
    } });
    start(h.fetch); await ready();
    expect(doc().querySelector('[data-task-id="task_b"]')!.textContent).toContain('尚未压缩');
    clickText('查看运行', doc().querySelector('[data-task-id="task_b"]')!);
    await vi.waitFor(() => expect(el('activity-stage').textContent).toBe('已整理任务记忆'));
    expect(el('activity-meta').textContent).toContain('已写入压缩摘要（不是证据，不改变讨论焦点）');
    expect(el('activity-meta').textContent).toContain('它不是证据，也不改变讨论焦点');
    expect(el('activity-trail').textContent).toContain('压缩摘要已写入');
    expect(el('activity-trail').querySelector('li:last-child')!.getAttribute('title')).toContain('不是证据，不改变讨论焦点');
    expect(el('timeline').textContent).toContain('开始整理任务记忆（摘要不是证据）');
    expect(el('timeline').textContent).toContain('压缩摘要已丢弃（不是证据）');
    expect(el('timeline').textContent).toContain('压缩摘要未生成（不是证据）');
    const items = [...el('timeline').querySelectorAll('li')];
    expect(items.find(item => item.textContent?.includes('已写入压缩摘要'))?.className).toContain('timeline-neutral');
    expect(items.find(item => item.textContent?.includes('压缩摘要未采用'))?.className).toContain('timeline-failure');
    expect(items.find(item => item.textContent?.includes('压缩摘要已丢弃'))?.className).toContain('timeline-failure');
    expect(el('events').textContent).toContain('压缩摘要未采用（不是证据）');
    expect(el('conversation-focus').textContent).toContain('发布方案');
    view.tasks[1]!.memory = { originals: 3, activeSummaries: 1 };
    view.tasks[1]!.status = 'succeeded';
    doc().dispatchEvent(new dom.window.Event('visibilitychange'));
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_b"]')!.textContent).toContain('1 份压缩摘要，3 份原文'));
    expect(doc().querySelector('[data-task-id="task_b"]')!.textContent).not.toContain('SECRET');
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(h.posts).toHaveLength(0);
    await vi.waitFor(() => expect(push).toBeTypeOf('function'));
    push!(`id: 6\nevent: model.started\ndata: ${JSON.stringify({ seq: 6, type: 'model.started', data: { phase: 'compaction', callId: 'call_compact_2' } })}\n\n`);
    await vi.waitFor(() => expect(el('run-pulse-message').textContent).toContain('开始整理任务记忆（摘要不是证据）'));
    expect(el('run-pulse').hidden).toBe(false);
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(h.posts).toHaveLength(0);
  });

  it('reorders the task dashboard and approves the visible plan without moving focus', async () => {
    const view = fixture();
    view.tasks[0] = { ...view.tasks[0]!, status: 'needs_approval', runId, latestRunId: runId, pendingApproval: { planVersion: 1, planHash: 'plan-hash', summary: '<img src=x onerror=alert(1)>发布计划' } };
    const h = harness(view, { handler(url, request) {
      if (url.includes('/priority')) {
        const id = url.split('/tasks/')[1]?.split('/')[0];
        const body = JSON.parse(request.body);
        const ordered = view.tasks.map((task, index) => ({ task, index })).sort((left, right) => (left.task.priority ?? Number.POSITIVE_INFINITY) - (right.task.priority ?? Number.POSITIVE_INFINITY) || left.index - right.index).map(item => item.task);
        const index = ordered.findIndex(task => task.id === id);
        const swap = body.direction === 'higher' ? index - 1 : index + 1;
        if (swap < 0 || swap >= ordered.length) return response({ error: '这项任务的优先级已经到头' }, 409);
        const next = ordered.slice();
        const moving = next[index]!; next[index] = next[swap]!; next[swap] = moving;
        next.forEach((task, rank) => { task.priority = rank + 1; });
        view.revision++;
        return response(view);
      }
      if (url.endsWith('/approve')) {
        const body = JSON.parse(request.body);
        if (body.planHash !== 'plan-hash' || body.planVersion !== 1) return response({ error: '计划已更新，请刷新后批准最新版本' }, 409);
        view.tasks[0]!.status = 'running';
        delete view.tasks[0]!.pendingApproval;
        view.revision++;
        return response({ id: runId, status: 'running' });
      }
    } });
    start(h.fetch); await ready();
    const ids = () => [...doc().querySelectorAll<HTMLElement>('#conversation-tasks [data-task-id]')].map(row => row.dataset.taskId);
    expect(ids()).toEqual(['task_a', 'task_b']);
    expect(doc().querySelector<HTMLButtonElement>('[data-task-id="task_a"] [data-priority="higher"]')!.disabled).toBe(true);
    expect(doc().querySelector('[data-task-id="task_a"]')!.textContent).toContain('待批计划：<img src=x onerror=alert(1)>发布计划');
    expect(doc().querySelector('#conversation-tasks img, #conversation-tasks script')).toBeNull();
    expect(doc().querySelector('[data-task-id="task_a"]')!.textContent).toContain('待批准');
    clickText('提高优先级', doc().querySelector('[data-task-id="task_b"]')!);
    await vi.waitFor(() => expect(ids()).toEqual(['task_b', 'task_a']));
    expect(h.posts.at(-1)?.body).toEqual({ expectedRevision: 1, direction: 'higher' });
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(h.posts.some(post => post.url.endsWith('/approve') || post.url.endsWith('/messages'))).toBe(false);
    await vi.waitFor(() => expect(doc().querySelector<HTMLButtonElement>('[data-task-id="task_a"] [data-approve]')!.disabled).toBe(false));
    clickText('批准并执行', doc().querySelector('[data-task-id="task_a"]')!);
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_a"]')!.textContent).toContain('执行中'));
    expect(h.posts.find(post => post.url.endsWith('/approve'))?.body).toEqual({ planHash: 'plan-hash', planVersion: 1 });
    expect(doc().querySelector('[data-task-id="task_a"]')!.textContent).not.toContain('批准并执行');
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(el('conversation-status').textContent).toContain('讨论焦点没有改变');
    expect(h.posts.filter(post => post.url.endsWith('/messages'))).toHaveLength(0);
    expect(h.posts.filter(post => post.url.endsWith('/focus'))).toHaveLength(0);
  });

  it('answers and retries in the task row without moving focus or sending a discussion message', async () => {
    const failedRunId = 'run_00000000-0000-4000-8000-000000000002';
    const view = fixture();
    view.tasks[1] = { ...view.tasks[1]!, status: 'needs_input', pendingQuestion: { text: '<img src=x onerror=alert(1)>还缺预算' } };
    view.tasks.push({ id: 'task_c', title: '复盘', threadId: 'thread_c', status: 'failed', runId: failedRunId, latestRunId: failedRunId });
    const h = harness(view, { handler(url, request) {
      if (request.method === 'POST' && url.endsWith('/answer')) {
        const body = JSON.parse(request.body);
        if (body.answer !== '预算 11 元') return response({ error: 'bad answer' }, 400);
        view.tasks[1]!.status = 'running';
        delete view.tasks[1]!.pendingQuestion;
        view.revision++;
        return response({ id: runId, status: 'running' });
      }
      if (request.method === 'POST' && url.endsWith('/retry')) {
        view.tasks[2]!.status = 'running';
        view.revision++;
        return response({ id: failedRunId, status: 'running' });
      }
      if (url.includes('/priority')) return response({ error: '这项任务的优先级已经到头' }, 409);
    } });
    start(h.fetch); await ready();
    const inputRow = doc().querySelector<HTMLElement>('[data-task-id="task_b"]')!;
    expect(inputRow.textContent).toContain('待回答：<img src=x onerror=alert(1)>还缺预算');
    expect(inputRow.textContent).toContain('待补充');
    expect(doc().querySelector('#conversation-tasks img, #conversation-tasks script')).toBeNull();
    const field = inputRow.querySelector<HTMLTextAreaElement>('textarea[data-answer]')!;
    field.value = '预算 11 元';
    clickText('提高优先级', inputRow);
    await vi.waitFor(() => expect(el('conversation-error').textContent).toContain('已经到头'));
    expect(h.posts.some(post => post.url.endsWith('/answer') || post.url.endsWith('/retry') || post.url.endsWith('/messages'))).toBe(false);
    expect(field.value).toBe('预算 11 元');
    await vi.waitFor(() => expect(inputRow.querySelector<HTMLButtonElement>('[data-answer-submit]')!.disabled).toBe(false));
    clickText('提交回答', inputRow);
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_b"]')!.textContent).toContain('执行中'));
    expect(h.posts.find(post => post.url.endsWith('/answer'))?.body).toEqual({ answer: '预算 11 元' });
    expect(doc().querySelector('[data-task-id="task_b"] textarea')).toBeNull();
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(el('conversation-status').textContent).toContain('讨论焦点没有改变');
    const failedRow = doc().querySelector<HTMLElement>('[data-task-id="task_c"]')!;
    clickText('重试', failedRow);
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_c"]')!.textContent).toContain('执行中'));
    expect(h.posts.find(post => post.url.endsWith('/retry'))?.body).toEqual({});
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(h.posts.filter(post => post.url.endsWith('/messages') || post.url.endsWith('/focus'))).toHaveLength(0);
  });
});

describe('entry bots and group chats', () => {
  it('opens a roster bot on that person\'s life thread and keeps the Run explicit', async () => {
    const rooms: Array<{ id: string; title: string; description?: string; status: string; createdAt: string; updatedAt: string }> = [];
    const h = harness(undefined, { handler: (url, request) => {
      const method = request?.method ?? 'GET';
      const body = request?.body ? JSON.parse(request.body) : undefined;
      if (url === '/api/rooms' && method === 'POST') {
        const room = { id: `room_direct_${rooms.length}`, title: body.title, description: body.description, status: 'active', createdAt: date, updatedAt: date };
        rooms.unshift(room);
        return response(room);
      }
      if (url === '/api/rooms?limit=50') return response(rooms);
      if (String(url).endsWith('/members') && method === 'POST') return response({ id: 'member_direct', roomId: rooms[0]?.id, principalId: body.principalId, role: body.role, status: 'active', invitedBy: 'owner', createdAt: date, updatedAt: date });
      if (String(url).endsWith('/members')) return response([]);
      if (String(url).includes('/session-events')) return response({ items: [] });
      if (String(url).endsWith('/goals')) return response([]);
      return undefined;
    } });
    start(h.fetch);
    await ready();
    await vi.waitFor(() => expect(el('bots').textContent).toContain('发布'));
    const bots = el('bots');
    expect(bots.textContent).toContain('工作');
    expect(bots.textContent).toContain('研究');
    expect(bots.textContent).toContain('纪要');
    expect(bots.textContent).toContain('在');
    expect(bots.textContent).toContain('2 件事');
    expect(bots.textContent).not.toContain('开始对话');
    const draft = el<HTMLTextAreaElement>('conversation-text');
    draft.value = '先别发出去';
    doc().querySelector<HTMLButtonElement>('[data-bot-id="demo.release"]')!.click();
    await vi.waitFor(() => {
      expect(el('entry-title').textContent).toBe('发布');
      expect(el('conversation-tasks').textContent ?? '').not.toContain('发布方案');
    });
    expect(el('bot-note-title').textContent).toBe('发布');
    expect(el('bot-note-copy').textContent).toContain('不会自己回复');
    expect(el('bot-note-copy').textContent).toContain('明确创建 Run');
    expect(el<HTMLButtonElement>('conversation-send').disabled).toBe(false);
    expect(el('conversation-send').textContent).toBe('发送讨论');
    expect(el('conversation-focus').textContent).not.toContain('发布方案');
    expect(h.posts.some(post => post.url.endsWith('/messages') || post.url.startsWith('/api/runs') || post.url === '/api/rooms')).toBe(false);
    expect(h.posts.find(post => post.url === '/api/conversations')?.body).toEqual({ title: '发布', agentId: 'demo.release' });
    expect(JSON.stringify(h.posts)).not.toContain('先别发出去');
    expect(draft.value).toBe('');
    expect(el('entry-presence').textContent).toBe('在');
    expect(el('group-panel').hidden).toBe(true);
    const postsBeforeComputer = h.posts.length;
    el('entry-computer').click();
    expect(doc().body.classList.contains('computer-open')).toBe(true);
    expect(el('entry-computer').textContent).toBe('关上工作台');
    expect(el('entry-computer').getAttribute('aria-pressed')).toBe('true');
    expect(h.posts).toHaveLength(postsBeforeComputer);
    el('entry-computer').click();
    expect(doc().body.classList.contains('computer-open')).toBe(false);
    expect(el('bots').textContent).not.toContain('私聊');
    expect(el('groups').textContent ?? '').not.toContain('发布');
    (el<HTMLInputElement>('bot-group-name')).value = '值班';
    el<HTMLFormElement>('bot-group-draft').requestSubmit();
    const duty = [...doc().querySelectorAll<HTMLButtonElement>('#bot-placement button')].find(button => button.textContent === '值班');
    duty?.click();
    const heading = [...doc().querySelectorAll('.bot-group-label')].find(item => item.textContent?.startsWith('值班'));
    expect(heading?.nextElementSibling?.textContent).toContain('发布');
    el('gb-bot').click();
    await vi.waitFor(() => expect(el('conversation-focus').textContent).toContain('发布方案'));
    expect(el('bot-note').hidden).toBe(true);
    expect(el<HTMLButtonElement>('conversation-send').textContent).toBe('发送讨论');
    expect(draft.value).toBe('');
    expect(doc().querySelector('[data-task-id="task_a"]')?.textContent).toContain('发布方案');
    expect(h.posts.find(post => post.body?.claimId)?.body).toEqual({ title: 'AEEIS', agentId: 'aeeis', claimId: h.view.id });
    expect(h.posts.some(post => post.url === '/api/rooms')).toBe(false);
  });

  it('replaces the demo roster when an agent is admitted', async () => {
    const h = harness(undefined, { handler: (url) => {
      if (String(url).startsWith('/api/agents')) return response([{
        agentId: 'agent.release', status: 'admitted', discoveredAt: date,
        card: { name: '发布核对', owner: 'demo', capabilities: [], cardVersion: '1' },
        reputation: { samples: 0, dimensions: {} },
      }]);
      return undefined;
    } });
    start(h.fetch);
    await ready();
    await vi.waitFor(() => expect(el('bots').textContent).toContain('发布核对'));
    const text = el('bots').textContent ?? '';
    expect(text).not.toContain('纪要');
    expect(text).toContain('AEEIS');
  });

  it('refuses a group that is only AEEIS and sends a room message without moving focus', async () => {
    const rooms: Array<{ id: string; title: string; description?: string; status: string; createdAt: string; updatedAt: string }> = [
      { id: 'room_backend', title: '后台房间', description: '长期协作', status: 'active', createdAt: date, updatedAt: date },
    ];
    const events: Array<{ id: string; operation: string; actorType: string; actorId: string; content: string; createdAt: string }> = [];
    const calls: Array<{ url: string; method: string; body: any }> = [];
    const membersByRoom = new Map<string, Array<{ id: string; roomId: string; principalId: string; role: string; status: string; invitedBy: string; createdAt: string; updatedAt: string }>>();
    const roomIdOf = (requestUrl: string) => decodeURIComponent(String(requestUrl).match(/\/rooms\/([^/?]+)/)?.[1] ?? '');
    const h = harness(undefined, { handler: (url, request) => {
      const method = request?.method ?? 'GET';
      const body = request?.body ? JSON.parse(request.body) : undefined;
      if (String(url).startsWith('/api/rooms') || String(url).includes('/goals') || String(url).includes('context-manifests') || String(url).includes('session-events')) calls.push({ url: String(url), method, body });
      if (method === 'PATCH' && String(url).startsWith('/api/rooms/')) {
        const room = rooms.find(item => String(url).includes(item.id));
        if (room) Object.assign(room, body, { id: room.id });
        return response(room ?? {});
      }
      if (url === '/api/rooms' && method === 'POST') {
        const room = { id: body.description === '私聊' ? 'room_direct' : 'room_group', title: body.title, description: body.description, status: 'active', createdAt: date, updatedAt: date };
        rooms.unshift(room);
        return response(room);
      }
      if (url === '/api/rooms?limit=50') return response(rooms);
      if (String(url).endsWith('/members') && method === 'POST') {
        const roomId = roomIdOf(String(url));
        const member = { id: 'member_1', roomId, principalId: body.principalId, role: body.role, status: 'active', invitedBy: 'owner', createdAt: date, updatedAt: date };
        membersByRoom.set(roomId, [...(membersByRoom.get(roomId) ?? []), member]);
        return response(member);
      }
      if (String(url).endsWith('/members')) return response(membersByRoom.get(roomIdOf(String(url))) ?? []);
      if (String(url).endsWith('/goals') && method === 'GET') return response([]);
      if (String(url).endsWith('/goals') && method === 'POST') return response({ id: 'goal_group', title: body.title, status: 'active', createdAt: date, roomId: body.roomId });
      if (String(url).includes('/context-manifests')) return response({ id: 'ctx_group' });
      if (String(url).includes('/session-events') && method === 'POST') {
        events.push({ id: 'evt_1', operation: 'publish', actorType: 'principal', actorId: 'owner', content: body.content, createdAt: date });
        return response(events[0]);
      }
      if (String(url).includes('/session-events')) return response({ items: events });
      return undefined;
    } });
    start(h.fetch);
    await ready();
    expect(el('groups').textContent ?? '').not.toContain('后台房间');
    el('gb-new-group').click();
    expect(el('group-draft').hidden).toBe(false);
    expect(el('group-count-live').textContent).toContain('1 / 6');
    el<HTMLInputElement>('group-title').value = '发布协作';
    el<HTMLFormElement>('group-create').requestSubmit();
    await vi.waitFor(() => expect(el('error').textContent).toContain('至少'));
    expect(calls.some(call => call.url === '/api/rooms' && call.method === 'POST')).toBe(false);
    expect(el('conversation-focus').textContent).toContain('发布方案');
    el<HTMLInputElement>('group-person').value = 'member.editor';
    el('group-add-person').click();
    el<HTMLFormElement>('group-create').requestSubmit();
    await vi.waitFor(() => expect(el('group-panel').hidden).toBe(false));
    expect(calls.find(call => call.url === '/api/rooms' && call.method === 'POST')?.body).toMatchObject({ title: '发布协作', description: '群聊' });
    expect(calls.find(call => call.url.endsWith('/members') && call.method === 'POST')?.body).toEqual({ principalId: 'member.editor', role: 'editor' });
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(h.posts.filter(post => post.url.endsWith('/messages') || post.url.endsWith('/focus'))).toHaveLength(0);
    const typed = el<HTMLTextAreaElement>('conversation-text');
    typed.value = '还留在入口';
    el<HTMLTextAreaElement>('group-text').value = '请 @发布 看一下';
    el<HTMLFormElement>('group-composer').requestSubmit();
    await vi.waitFor(() => expect(el('group-transcript').textContent).toContain('请 @发布 看一下'));
    const manifest = calls.find(call => call.url.includes('/context-manifests'));
    expect(manifest?.body).toEqual({ purpose: '群聊消息', audienceMode: 'room' });
    const message = calls.find(call => call.url.endsWith('/session-events') && call.method === 'POST');
    expect(message?.body).toMatchObject({ goalId: 'goal_group', type: 'message', content: '请 @发布 看一下', contextManifestId: 'ctx_group' });
    expect(h.posts.filter(post => post.url.endsWith('/messages') || post.url.endsWith('/focus'))).toHaveLength(0);
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(typed.value).toBe('还留在入口');
    expect(doc().querySelector('[data-task-id="task_a"]')?.textContent).toContain('发布方案');
    await vi.waitFor(() => expect(el('group-members').textContent).toContain('member.editor'));
    clickText('member.editor', el('group-members'));
    await vi.waitFor(() => expect(el('entry-presence').textContent).toBe('私聊'));
    expect(el('entry-title').textContent).toBe('member.editor');
    expect(el('chat-note').textContent).toContain('会话记录');
    expect(el<HTMLButtonElement>('conversation-send').disabled).toBe(true);
    expect(calls.find(call => call.url === '/api/rooms' && call.method === 'POST' && call.body?.description === '私聊')?.body).toMatchObject({ title: 'member.editor', description: '私聊' });
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(h.posts.filter(post => post.url.endsWith('/messages') || post.url.endsWith('/focus'))).toHaveLength(0);
    const groupRow = [...doc().querySelectorAll<HTMLButtonElement>('#groups button')].find(button => button.textContent?.includes('发布协作'));
    groupRow?.click();
    await vi.waitFor(() => expect(el('entry-presence').textContent).toBe('群聊'));
    el('chat-archive').click();
    await vi.waitFor(() => expect(el('group-panel').hidden).toBe(true));
    expect(el('groups').textContent ?? '').not.toContain('发布协作');
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(typed.value).toBe('还留在入口');
    expect(h.posts.filter(post => post.url.endsWith('/messages') || post.url.endsWith('/focus'))).toHaveLength(0);
  });

  it('records an @AEEIS mention as an entry discussion and leaves other mentions in the room', async () => {
    const view = fixture();
    view.tasks = view.tasks.map(task => task.id === 'task_a' ? { ...task, status: 'running', runId, latestRunId: runId } : task);
    const rooms: Array<{ id: string; title: string; description?: string; status: string; createdAt: string; updatedAt: string }> = [];
    const events = new Map<string, Array<{ id: string; operation: string; actorType: string; actorId: string; type: string; content: string; createdAt: string }>>();
    const membersByRoom = new Map<string, Array<{ id: string; roomId: string; principalId: string; role: string; status: string; invitedBy: string; createdAt: string; updatedAt: string }>>();
    const h = harness(view, { handler: (url, request) => {
      const method = request?.method ?? 'GET';
      const body = request?.body ? JSON.parse(request.body) : undefined;
      const roomMatch = String(url).match(/\/rooms\/([^/?]+)/);
      const roomId = roomMatch ? decodeURIComponent(roomMatch[1] ?? '') : '';
      if (url === '/api/rooms' && method === 'POST') {
        const room = { id: `room_${rooms.length}`, title: body.title, description: body.description, status: 'active', createdAt: date, updatedAt: date };
        rooms.unshift(room);
        return response(room);
      }
      if (url === '/api/rooms?limit=50') return response(rooms);
      if (String(url).endsWith('/members') && method === 'POST') {
        const member = { id: 'member_1', roomId, principalId: body.principalId, role: body.role, status: 'active', invitedBy: 'owner', createdAt: date, updatedAt: date };
        membersByRoom.set(roomId, [...(membersByRoom.get(roomId) ?? []), member]);
        return response(member);
      }
      if (String(url).endsWith('/members')) return response(membersByRoom.get(roomId) ?? []);
      if (String(url).endsWith('/goals') && method === 'GET') return response([]);
      if (String(url).endsWith('/goals') && method === 'POST') return response({ id: `goal_${roomId}`, title: body.title, status: 'active', createdAt: date, roomId: body.roomId });
      if (String(url).includes('/context-manifests')) return response({ id: `ctx_${roomId}` });
      if (String(url).includes('/session-events') && method === 'POST') {
        const list = events.get(roomId) ?? [];
        const event = { id: `evt_${list.length}`, operation: 'publish', actorType: 'principal', actorId: 'owner', type: body.type, content: body.content, createdAt: date };
        list.push(event);
        events.set(roomId, list);
        return response(event);
      }
      if (String(url).includes('/session-events')) return response({ items: events.get(roomId) ?? [] });
      return undefined;
    } });
    start(h.fetch);
    await ready();
    const typed = el<HTMLTextAreaElement>('conversation-text');
    typed.value = '还留在入口';
    el('gb-new-group').click();
    el<HTMLInputElement>('group-title').value = '发布协作';
    el<HTMLInputElement>('group-person').value = 'member.editor';
    el('group-add-person').click();
    el<HTMLFormElement>('group-create').requestSubmit();
    await vi.waitFor(() => expect(el('group-panel').hidden).toBe(false));
    expect(el<HTMLTextAreaElement>('group-text').placeholder).toContain('@AEEIS');
    el<HTMLTextAreaElement>('group-text').value = '请 @所有人 看一下';
    el<HTMLFormElement>('group-composer').requestSubmit();
    await vi.waitFor(() => expect(el('group-transcript').textContent).toContain('请 @所有人 看一下'));
    el<HTMLTextAreaElement>('group-text').value = '请 @AEEIS发布 看一下';
    el<HTMLFormElement>('group-composer').requestSubmit();
    await vi.waitFor(() => expect(el('group-transcript').textContent).toContain('请 @AEEIS发布 看一下'));
    expect(messagePosts(h)).toHaveLength(0);
    el<HTMLTextAreaElement>('group-text').value = '@AEEIS 整理发布风险';
    el<HTMLFormElement>('group-composer').requestSubmit();
    await vi.waitFor(() => expect(el('group-transcript').textContent).toContain('已记为入口讨论「整理发布风险」'));
    const mention = messagePosts(h);
    expect(mention).toHaveLength(1);
    expect(mention[0]?.body).toEqual({
      text: '来自群聊「发布协作」：@AEEIS 整理发布风险',
      expectedRevision: 1,
      newTask: { title: '整理发布风险' },
      focus: 'keep',
      intent: 'discuss',
    });
    expect(mention[0]?.body).not.toHaveProperty('runOptions');
    const roomEvents = [...events.values()].flat().filter(event => event.content.includes('整理发布风险') || event.content.includes('入口讨论'));
    expect(roomEvents.map(event => event.type)).toEqual(['message', 'system']);
    const receipt = doc().querySelector<HTMLElement>('#group-transcript [data-type="system"]');
    expect(receipt?.textContent).toContain('记录');
    expect(receipt?.textContent).toContain('未执行，讨论焦点不变');
    expect(el('conversation-focus').textContent).toContain('发布方案');
    const created = doc().querySelector<HTMLElement>('[data-task-id="task_new_2"]');
    expect(created?.textContent).toContain('整理发布风险');
    expect(created?.textContent).toContain('仅讨论，未执行');
    expect(created?.dataset.focused).toBe('false');
    expect(doc().querySelector<HTMLElement>('[data-task-id="task_a"]')?.textContent).toContain('执行中');
    expect(doc().querySelector<HTMLElement>('[data-task-id="task_a"]')?.dataset.focused).toBe('true');
    expect(typed.value).toBe('还留在入口');
    expect(el<HTMLTextAreaElement>('group-text').value).toBe('');
    expect(h.posts.some(post => /\/runs(?:\/|$)|\/approve$|\/focus$|\/cancel$/.test(post.url))).toBe(false);
    doc().querySelector<HTMLButtonElement>('[data-bot-id="demo.release"]')!.click();
    await vi.waitFor(() => {
      expect(el('entry-title').textContent).toBe('发布');
      expect(el('conversation-tasks').textContent ?? '').not.toContain('整理发布风险');
    });
    expect(el('entry-presence').textContent).toBe('在');
    expect(h.posts.find(post => post.body?.agentId === 'demo.release')?.body).toEqual({ title: '发布', agentId: 'demo.release' });
    expect(h.posts.some(post => post.url === '/api/rooms' && post.body?.description === '私聊')).toBe(false);
    el<HTMLTextAreaElement>('conversation-text').value = '发布口径先记在这里';
    el('conversation-composer').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(el('conversation-messages').textContent).toContain('发布口径先记在这里'));
    expect(messagePosts(h)).toHaveLength(2);
    expect(messagePosts(h)[1]?.url).toBe('/api/conversations/conv_life_1/messages');
    expect(messagePosts(h)[1]?.body).toMatchObject({ text: '发布口径先记在这里', expectedRevision: 0, focus: 'keep', intent: 'discuss' });
    expect(messagePosts(h)[1]?.body).not.toHaveProperty('runOptions');
    expect(el('conversation-tasks').textContent ?? '').not.toContain('整理发布风险');
    const groupRow = [...doc().querySelectorAll<HTMLButtonElement>('#groups button')].find(button => button.textContent?.includes('发布协作'));
    groupRow?.click();
    await vi.waitFor(() => expect(el('group-members').textContent).toContain('member.editor'));
    clickText('member.editor', el('group-members'));
    await vi.waitFor(() => expect(el('entry-presence').textContent).toBe('私聊'));
    expect(el('entry-title').textContent).toBe('member.editor');
    expect(el('conversation-tasks').textContent ?? '').not.toContain('整理发布风险');
    el<HTMLTextAreaElement>('group-text').value = '@AEEIS 记下私聊';
    el<HTMLFormElement>('group-composer').requestSubmit();
    await vi.waitFor(() => expect(el('group-transcript').textContent).toContain('已记为入口讨论「记下私聊」'));
    expect(messagePosts(h)).toHaveLength(3);
    expect(messagePosts(h)[2]?.url).toBe(`/api/conversations/${view.id}/messages`);
    expect(messagePosts(h)[2]?.body).toMatchObject({
      text: '来自私聊「member.editor」：@AEEIS 记下私聊',
      expectedRevision: 2,
      newTask: { title: '记下私聊' },
      focus: 'keep',
      intent: 'discuss',
    });
    expect(messagePosts(h)[2]?.body).not.toHaveProperty('runOptions');
    expect(el('conversation-tasks').textContent ?? '').not.toContain('记下私聊');
    expect(el('conversation-messages').textContent).toContain('发布口径先记在这里');
    el('gb-bot').click();
    await vi.waitFor(() => expect(el('conversation-focus').textContent).toContain('发布方案'));
    expect(doc().querySelector('[data-task-id="task_new_2"]')?.textContent).toContain('整理发布风险');
    expect(doc().querySelector<HTMLElement>('[data-task-id="task_new_2"]')?.dataset.focused).toBe('false');
    expect(doc().querySelector('[data-task-id="task_new_3"]')?.textContent).toContain('记下私聊');
    expect(doc().querySelector<HTMLElement>('[data-task-id="task_new_3"]')?.dataset.focused).toBe('false');
    expect(doc().querySelector<HTMLElement>('[data-task-id="task_a"]')?.dataset.focused).toBe('true');
    expect(el('conversation-messages').textContent).not.toContain('发布口径先记在这里');
    expect(typed.value).toBe('');
    expect(h.posts.some(post => /\/runs(?:\/|$)|\/approve$|\/focus$|\/cancel$/.test(post.url))).toBe(false);
  });
  it('pins, clears, and keeps a standing sentence on this person without sending it as execution authority', async () => {
    const h = harness();
    start(h.fetch);
    await ready();
    const sentence = '口径先内部确认';
    expect(el('standing-instruction').hidden).toBe(false);
    expect(el('standing-note').textContent).toContain('不可信');
    expect(el<HTMLTextAreaElement>('standing-text').value).toBe('');
    expect(el<HTMLButtonElement>('standing-save').disabled).toBe(false);
    fill('standing-text', sentence);
    el<HTMLFormElement>('standing-form').requestSubmit();
    await vi.waitFor(() => expect(h.posts.some(post => post.url.endsWith('/standing'))).toBe(true));
    expect(h.posts.find(post => post.url.endsWith('/standing'))?.body).toEqual({ expectedRevision: 1, text: sentence });
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('已记住这句话'));
    fill('conversation-text', '先讨论，不改嘱咐');
    submit();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('系统回执'));
    expect(h.posts.filter(post => post.url.endsWith('/standing'))).toHaveLength(1);
    expect(JSON.stringify(messagePosts(h).at(-1)?.body)).not.toContain(sentence);
    expect(messagePosts(h).at(-1)?.body.intent).toBe('discuss');
    fill('conversation-text', '开始做这一件');
    el<HTMLButtonElement>('conversation-execute').click();
    await vi.waitFor(() => {
      expect(messagePosts(h)).toHaveLength(2);
      expect(el('conversation-status').textContent).toContain('系统回执');
      expect(el<HTMLButtonElement>('standing-save').disabled).toBe(false);
    });
    const executed = messagePosts(h).at(-1);
    expect(executed?.body.intent).toBe('execute');
    expect(JSON.stringify(executed?.body)).not.toContain(sentence);
    expect(executed?.body.runOptions.materials ?? []).toEqual([]);
    doc().querySelector<HTMLButtonElement>('[data-bot-id="demo.release"]')!.click();
    await vi.waitFor(() => {
      expect(el('entry-title').textContent).toBe('发布');
      expect(el<HTMLButtonElement>('standing-save').disabled).toBe(false);
    });
    expect(el('standing-instruction').hidden).toBe(false);
    expect(el<HTMLTextAreaElement>('standing-text').value).toBe('');
    fill('standing-text', '发布单独记住');
    el<HTMLFormElement>('standing-form').requestSubmit();
    await vi.waitFor(() => {
      expect(h.posts.filter(post => post.url.endsWith('/standing'))).toHaveLength(2);
      expect(el('conversation-status').textContent).toContain('已记住这句话');
      expect(el<HTMLButtonElement>('standing-save').disabled).toBe(false);
    });
    expect(h.posts.filter(post => post.url.endsWith('/standing')).at(-1)).toMatchObject({ url: '/api/conversations/conv_life_1/standing', body: { expectedRevision: 0, text: '发布单独记住' } });
    expect(h.view.standingInstruction).toBe(sentence);
    el('gb-new-group').click();
    expect(el('standing-instruction').hidden).toBe(true);
    el('gb-bot').click();
    await vi.waitFor(() => {
      expect(el('standing-instruction').hidden).toBe(false);
      expect(el<HTMLTextAreaElement>('standing-text').value).toBe(sentence);
      expect(el<HTMLButtonElement>('standing-clear').disabled).toBe(false);
    });
    clickText('忘掉');
    await vi.waitFor(() => {
      expect(h.posts.filter(post => post.url.endsWith('/standing')).at(-1)?.body.text).toBe('');
      expect(el<HTMLTextAreaElement>('standing-text').value).toBe('');
      expect(el('conversation-status').textContent).toContain('已忘掉这句话');
    });
    expect(h.view.standingInstruction).toBeUndefined();
    const field = el<HTMLTextAreaElement>('standing-text');
    field.focus();
    field.value = '草稿还没保存';
    el('conversation-status').textContent = '';
    el('conversation-refresh').click();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('已刷新'));
    expect(field.value).toBe('草稿还没保存');
    field.blur();
    el('conversation-status').textContent = '';
    el('conversation-refresh').click();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('已刷新'));
    expect(field.value).toBe('');
  });
  it('shows the latest delivery and places it into the standing draft only when asked', async () => {
    const h = harness();
    start(h.fetch);
    await ready();
    expect(el('last-delivery').hidden).toBe(true);
    h.view.lastDelivery = { taskId: 'task_b', taskTitle: '周报', runId, planSummary: '先列已完成的条目', artifactTitles: ['周报稿'] };
    el('conversation-status').textContent = '';
    el('conversation-refresh').click();
    await vi.waitFor(() => {
      expect(el('last-delivery').hidden).toBe(false);
      expect(el('last-delivery-copy').textContent).toBe('周报。先列已完成的条目。周报稿');
      expect(el<HTMLButtonElement>('last-delivery-pin').disabled).toBe(false);
    });
    clickText('放进嘱咐');
    expect(el<HTMLTextAreaElement>('standing-text').value).toBe('周报。先列已完成的条目。周报稿');
    expect(el('conversation-status').textContent).toContain('还没记住');
    expect(h.posts.filter(post => post.url.endsWith('/standing'))).toHaveLength(0);
    el<HTMLFormElement>('standing-form').requestSubmit();
    await vi.waitFor(() => {
      expect(h.posts.filter(post => post.url.endsWith('/standing'))).toHaveLength(1);
      expect(el('conversation-status').textContent).toContain('已记住这句话');
      expect(el<HTMLButtonElement>('standing-save').disabled).toBe(false);
    });
    expect(h.posts.find(post => post.url.endsWith('/standing'))?.body).toEqual({ expectedRevision: 1, text: '周报。先列已完成的条目。周报稿' });
    fill('conversation-text', '讨论不改嘱咐');
    submit();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('系统回执'));
    expect(h.posts.filter(post => post.url.endsWith('/standing'))).toHaveLength(1);
    expect(JSON.stringify(messagePosts(h).at(-1)?.body)).not.toContain('先列已完成的条目');
    el('gb-new-group').click();
    expect(el('last-delivery').hidden).toBe(true);
  });
});
