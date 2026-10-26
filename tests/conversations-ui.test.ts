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
    if (url.endsWith('/practice/retract')) {
      const target = conversationFor(url);
      if (!target) return response({ error: 'Unknown conversation' }, 404);
      const body = JSON.parse(request.body);
      if (body.expectedRevision !== target.revision) return response({ error: '对话已变化，请先刷新再撤回这句' }, 409);
      if (!target.acceptedPractice || target.acceptedPractice.claimId !== body.claimId) return response({ error: '这个人还没有收下的做法' }, 409);
      delete target.acceptedPractice;
      return response(target);
    }
    if (url.endsWith('/task-kind/propose')) {
      const target = conversationFor(url);
      if (!target) return response({ error: 'Unknown conversation' }, 404);
      const body = JSON.parse(request.body);
      if (Object.keys(body).sort().join() !== 'expectedRevision,taskKind') return response({ error: 'Invalid request' }, 400);
      if (body.expectedRevision !== target.revision) return response({ error: '对话已变化，请先刷新再送去评测' }, 409);
      const compare = target.taskSettings?.comparisons?.find((item: { taskKind: string; methodId?: string; version?: string; profileMethodId?: string; profileVersion?: string }) => item.taskKind === body.taskKind);
      if (!compare?.methodId || !compare.profileMethodId || (compare.methodId === compare.profileMethodId && compare.version === compare.profileVersion)) return response({ error: '这次做成的技能和档案一样，不用送去评测' }, 409);
      compare.proposal = { candidateId: 'evo_lineup', status: 'proposed' };
      return response(target);
    }
    if (url.endsWith('/task-kind/keep')) {
      const target = conversationFor(url);
      if (!target) return response({ error: 'Unknown conversation' }, 404);
      const body = JSON.parse(request.body);
      if (body.expectedRevision !== target.revision) return response({ error: '对话已变化，请先刷新再留下这份档案' }, 409);
      const compare = target.taskSettings?.comparisons?.find((item: { taskKind: string; differs?: boolean; profileMethodId?: string; profileModel?: string; kept?: boolean }) => item.taskKind === body.taskKind);
      if (!compare || (!compare.profileMethodId && !compare.profileModel)) return response({ error: '这个任务种类还没有可留下的档案' }, 409);
      if (!compare.differs) return response({ error: '这次做成和档案一样，不用留下' }, 409);
      compare.kept = true;
      return response(target);
    }
    if (url.endsWith('/skill-profile/rollback')) {
      const target = conversationFor(url);
      if (!target) return response({ error: 'Unknown conversation' }, 404);
      const body = JSON.parse(request.body);
      if (body.expectedRevision !== target.revision) return response({ error: '对话已变化，请先刷新再回滚' }, 409);
      const skill = target.taskSettings?.skills?.find((item: { taskKind: string; previous?: { methodId: string; version: string; runId: string }; methodId: string; version: string; runId: string }) => item.taskKind === body.taskKind);
      if (!skill?.previous) return response({ error: '这个任务种类还没有可回滚的上一版' }, 409);
      skill.methodId = skill.previous.methodId;
      skill.version = skill.previous.version;
      skill.runId = skill.previous.runId;
      delete skill.previous;
      return response(target);
    }
    if (url.endsWith('/skill-profile/retract')) {
      const target = conversationFor(url);
      if (!target) return response({ error: 'Unknown conversation' }, 404);
      const body = JSON.parse(request.body);
      if (body.expectedRevision !== target.revision) return response({ error: '对话已变化，请先刷新再撤回这份档案' }, 409);
      const skills = target.taskSettings?.skills ?? [];
      if (!skills.some((item: { claimId: string }) => item.claimId === body.claimId)) return response({ error: '这个任务种类还没有技能档案' }, 409);
      target.taskSettings.skills = skills.filter((item: { claimId: string }) => item.claimId !== body.claimId);
      if (!target.taskSettings.skills.length && !(target.taskSettings.models?.length)) delete target.taskSettings;
      return response(target);
    }
    if (url.endsWith('/skill-profile')) {
      const target = conversationFor(url);
      if (!target) return response({ error: 'Unknown conversation' }, 404);
      const body = JSON.parse(request.body);
      if (body.expectedRevision !== target.revision) return response({ error: '对话已变化，请先刷新再晋升' }, 409);
      const compared = target.taskSettings?.comparisons?.some((item: { taskKind: string; runId: string }) => item.taskKind === body.taskKind && item.runId === body.runId);
      if ((!target.lastDelivery || body.runId !== target.lastDelivery.runId) && !compared) return response({ error: '只能晋升这个人做成过的那一次' }, 409);
      target.taskSettings ??= { skills: [], models: target.taskSettings?.models ?? [] };
      const existing = target.taskSettings.skills.find((item: { taskKind: string }) => item.taskKind === body.taskKind);
      const next = { claimId: 'brain_skill', taskKind: body.taskKind, methodId: 'project-pulse', version: existing ? '2' : '1', runId: body.runId, evidenceRefs: ['artifact_later'], ...(existing ? { previous: { methodId: existing.methodId, version: existing.version, runId: existing.runId } } : {}) };
      target.taskSettings.skills = [next, ...target.taskSettings.skills.filter((item: { taskKind: string }) => item.taskKind !== body.taskKind)];
      return response(target);
    }
    if (url.endsWith('/task-model')) {
      const target = conversationFor(url);
      if (!target) return response({ error: 'Unknown conversation' }, 404);
      const body = JSON.parse(request.body);
      if (body.expectedRevision !== target.revision) return response({ error: '对话已变化，请先刷新再改这个任务种类的模型' }, 409);
      target.taskSettings ??= { skills: target.taskSettings?.skills ?? [], models: [] };
      if (!body.model) {
        if (!target.taskSettings.models.some((item: { taskKind: string }) => item.taskKind === body.taskKind)) return response({ error: '这个任务种类还没有选定模型' }, 409);
        target.taskSettings.models = target.taskSettings.models.filter((item: { taskKind: string }) => item.taskKind !== body.taskKind);
      } else {
        const model = { claimId: 'brain_model', taskKind: body.taskKind, model: body.model, ...(body.provider ? { provider: body.provider } : {}) };
        target.taskSettings.models = [model, ...target.taskSettings.models.filter((item: { taskKind: string }) => item.taskKind !== body.taskKind)];
      }
      if (!target.taskSettings.skills.length && !target.taskSettings.models.length) delete target.taskSettings;
      return response(target);
    }
    if (url.endsWith('/practice')) {
      const target = conversationFor(url);
      if (!target) return response({ error: 'Unknown conversation' }, 404);
      const body = JSON.parse(request.body);
      if (body.expectedRevision !== target.revision) return response({ error: '对话已变化，请先刷新再收下这句' }, 409);
      const text = String(body.text ?? '').trim();
      if (!target.lastDelivery || body.runId !== target.lastDelivery.runId) return response({ error: '只能收下这个人上次做成的那一次' }, 409);
      target.acceptedPractice = { claimId: 'brain_practice', text, runId: body.runId, evidenceRefs: ['artifact_later'] };
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
      const message = { id: `message_${target.messages.length}`, role: 'user', speaker: body.speaker ?? { role: 'user', id: principal }, text: body.text, createdAt: date, route, ...(body.replyTo ? { replyTo: body.replyTo } : {}), ...(body.correctsMessageId ? { correctsMessageId: body.correctsMessageId } : {}), ...(body.intent === 'execute' ? { execution: { taskId: route.taskIds[0], runId, state: 'completed' } } : {}) };
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

  it('approves once or rejects the plan from the task row without moving focus', async () => {
    const view = fixture();
    view.tasks[0] = { ...view.tasks[0]!, status: 'needs_approval', runId, latestRunId: runId, pendingApproval: { planVersion: 1, planHash: 'plan-hash', summary: '发布计划' } };
    const h = harness(view, { handler(url, request) {
      if (request.method === 'POST' && url.endsWith('/approve')) {
        const body = JSON.parse(request.body);
        if (body.duration !== 'once') return response({ error: 'not once' }, 400);
        view.tasks[0]!.status = 'running';
        delete view.tasks[0]!.pendingApproval;
        view.revision++;
        return response({ id: runId, status: 'running' });
      }
      if (request.method === 'POST' && url.endsWith('/revise-plan')) {
        const body = JSON.parse(request.body);
        if (body.feedback !== '先不要外发') return response({ error: 'bad feedback' }, 400);
        view.tasks[0]!.status = 'planning';
        delete view.tasks[0]!.pendingApproval;
        view.revision++;
        return response({ id: runId, status: 'planning' });
      }
      return undefined;
    } });
    start(h.fetch); await ready();
    const row = doc().querySelector<HTMLElement>('[data-task-id="task_a"]')!;
    clickText('拒绝并说明', row);
    expect(el('conversation-error').textContent).toContain('请先写下拒绝原因');
    expect(h.posts.filter(post => post.url.endsWith('/revise-plan') || post.url.endsWith('/approve'))).toHaveLength(0);
    const field = row.querySelector<HTMLTextAreaElement>('textarea[data-reject]')!;
    field.value = '先不要外发';
    clickText('仅这一次', row);
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_a"]')!.textContent).toContain('执行中'));
    expect(h.posts.find(post => post.url.endsWith('/approve'))?.body).toEqual({ planHash: 'plan-hash', planVersion: 1, duration: 'once' });
    expect(el('conversation-status').textContent).toContain('这一次不会写成长期做法');
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(h.posts.filter(post => post.url.endsWith('/messages') || post.url.endsWith('/focus') || post.url.endsWith('/revise-plan'))).toHaveLength(0);
    view.tasks[0] = { ...view.tasks[0]!, status: 'needs_approval', pendingApproval: { planVersion: 2, planHash: 'plan-hash', summary: '第二版' } };
    view.revision++;
    el('conversation-refresh').click();
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_a"] textarea[data-reject]')).toBeTruthy());
    const again = doc().querySelector<HTMLTextAreaElement>('[data-task-id="task_a"] textarea[data-reject]')!;
    again.value = '先不要外发';
    clickText('拒绝并说明', doc().querySelector('[data-task-id="task_a"]')!);
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_a"]')!.textContent).toContain('规划中'));
    expect(h.posts.find(post => post.url.endsWith('/revise-plan'))?.body).toEqual({ planVersion: 2, feedback: '先不要外发' });
    expect(el('conversation-focus').textContent).toContain('发布方案');
  });

  it('sorts the inbox by the five kinds and opens a failure without retrying it', async () => {
    const view = fixture();
    view.messages = [{ id: 'clarify_1', role: 'user', text: '这句交给谁', createdAt: new Date(Date.now() - 3_600_000).toISOString(), route: { status: 'clarify', reason: 'ambiguous', taskIds: [], candidateTaskIds: ['task_a'], focusEffect: 'keep' } }];
    const old = new Date(Date.now() - 80 * 3_600_000).toISOString();
    const recent = new Date().toISOString();
    const h = harness(view, { handler(url) {
      if (String(url).startsWith('/api/runs/page')) return response({ items: [
        { id: 'run_failed', goal: '失败的发布', status: 'failed', updatedAt: old },
        { id: 'run_unknown', goal: '不明的回执', status: 'unknown', updatedAt: recent },
        { id: 'run_approve', goal: '待批的发布', status: 'needs_approval', updatedAt: recent },
      ] });
      return undefined;
    } });
    start(h.fetch); await ready();
    el('attention-toggle').click();
    await vi.waitFor(() => expect(doc().querySelectorAll('#attention-items [data-inbox]').length).toBe(4));
    const kinds = [...doc().querySelectorAll<HTMLElement>('#attention-items [data-inbox]')].map(item => item.dataset.inbox);
    expect(kinds).toEqual(['approval', 'unknown', 'failure', 'mention']);
    expect(doc().querySelector('[data-inbox="approval"]')?.getAttribute('data-age')).toBe('normal');
    expect(doc().querySelector('[data-inbox="failure"]')?.getAttribute('data-age')).toBe('escalate');
    expect(doc().querySelector('[data-inbox="failure"] .attention-quick-action')?.textContent).toBe('查看原因');
    clickText('查看原因', doc().querySelector('[data-inbox="failure"]')!);
    await vi.waitFor(() => expect(h.posts.some(post => post.url.endsWith('/retry'))).toBe(false));
    expect(h.posts.filter(post => post.url.endsWith('/retry') || post.url.endsWith('/approve') || post.url.endsWith('/messages'))).toHaveLength(0);
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

  it('pauses, resumes and reconciles the existing run from the task row without moving focus', async () => {
    const activeId = 'run_00000000-0000-4000-8000-000000000003';
    const pausedId = 'run_00000000-0000-4000-8000-000000000004';
    const unknownId = 'run_00000000-0000-4000-8000-000000000005';
    const view = fixture();
    view.tasks = [
      { id: 'task_a', title: '发布方案', threadId: 'thread_a', status: 'running', runId: activeId, latestRunId: activeId },
      { id: 'task_b', title: '周报', threadId: 'thread_b', status: 'paused', runId: pausedId, latestRunId: pausedId },
      { id: 'task_c', title: '回执', threadId: 'thread_c', status: 'unknown', runId: unknownId, latestRunId: unknownId },
    ];
    view.focusTaskId = 'task_a';
    const h = harness(view, { handler(url, request) {
      if (request.method !== 'POST') return undefined;
      if (url.endsWith('/pause')) { view.tasks[0]!.status = 'paused'; view.revision++; return response({ id: activeId, status: 'paused' }); }
      if (url.endsWith('/resume')) { view.tasks[1]!.status = 'running'; view.revision++; return response({ id: pausedId, status: 'running' }); }
      if (url.endsWith('/reconcile')) {
        const body = JSON.parse(request.body);
        if (body.reason !== '供应商已完成') return response({ error: 'bad reason' }, 400);
        view.tasks[2]!.status = 'running'; view.revision++; return response({ id: unknownId, status: 'running' });
      }
      return undefined;
    } });
    start(h.fetch); await ready();
    const active = doc().querySelector<HTMLElement>('[data-task-id="task_a"]')!;
    const paused = doc().querySelector<HTMLElement>('[data-task-id="task_b"]')!;
    const unknown = doc().querySelector<HTMLElement>('[data-task-id="task_c"]')!;
    expect(active.textContent).toContain('执行中');
    expect(active.querySelector('[data-run-pause]')).not.toBeNull();
    expect(paused.textContent).toContain('已暂停');
    expect(paused.querySelector('[data-run-resume]')).not.toBeNull();
    expect(unknown.querySelector('textarea[data-reconcile]')).not.toBeNull();
    expect(doc().querySelector('[data-task-id="task_a"]')!.textContent).not.toContain('提交核查');
    clickText('提交核查', unknown);
    expect(el('conversation-error').textContent).toContain('请先写下核查说明');
    expect(h.posts).toHaveLength(0);
    clickText('暂停', active);
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_a"]')!.textContent).toContain('已暂停'));
    expect(h.posts.find(post => post.url.endsWith('/pause'))?.body).toEqual({});
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(el('conversation-status').textContent).toContain('讨论焦点没有改变');
    clickText('继续', doc().querySelector('[data-task-id="task_b"]')!);
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_b"]')!.textContent).toContain('执行中'));
    expect(h.posts.find(post => post.url.endsWith('/resume'))?.body).toEqual({});
    const field = doc().querySelector<HTMLTextAreaElement>('[data-task-id="task_c"] textarea[data-reconcile]')!;
    field.value = '供应商已完成';
    clickText('提交核查', doc().querySelector('[data-task-id="task_c"]')!);
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_c"]')!.textContent).toContain('执行中'));
    expect(h.posts.find(post => post.url.endsWith('/reconcile'))?.body).toEqual({ reason: '供应商已完成' });
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(h.posts.filter(post => post.url.endsWith('/messages') || post.url.endsWith('/focus') || post.url.endsWith('/approve'))).toHaveLength(0);
  });
});

describe('entry bots and group chats', () => {
  it('shows another person waiting on the roster from the life list without opening them', async () => {
    const h = harness(undefined, { handler(url, request) {
      if (url === '/api/conversations' && request.method !== 'POST') {
        return response([
          fixture(),
          { id: 'conv_release', title: '发布', revision: 2, agentId: 'demo.release', taskCount: 1, presence: { state: 'waiting', label: '等你', taskId: 'task_r', taskTitle: '发布口径' } },
          { id: 'conv_research', title: '研究', revision: 1, agentId: 'demo.research', taskCount: 1, presence: { state: 'blocked', label: '卡住', taskId: 'task_s', taskTitle: '公开资料' } },
        ]);
      }
      return undefined;
    } });
    start(h.fetch); await ready();
    await vi.waitFor(() => expect(el('bots').textContent).toContain('发布'));
    const release = doc().querySelector<HTMLElement>('[data-bot-id="demo.release"]')!;
    const research = doc().querySelector<HTMLElement>('[data-bot-id="demo.research"]')!;
    expect(release.textContent).toContain('等你 · 发布口径');
    expect(release.querySelector('.roster-avatar')?.getAttribute('data-state')).toBe('waiting');
    expect(research.textContent).toContain('卡住 · 公开资料');
    expect(research.querySelector('.roster-avatar')?.getAttribute('data-state')).toBe('blocked');
    expect(h.posts.some(post => post.url.includes('/messages') || post.url.startsWith('/api/runs'))).toBe(false);
  });
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
    expect(bots.textContent).toContain('空闲');
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
    expect(el('bot-profile-role').textContent).toContain('对照发布清单');
    expect(el('bot-profile-boundary').textContent).toContain('不会自己回复');
    expect(el('bot-note-copy').textContent).toContain('不会自己回复');
    expect(el('bot-note-copy').textContent).toContain('明确创建 Run');
    expect(el<HTMLButtonElement>('conversation-send').disabled).toBe(false);
    expect(el('conversation-send').textContent).toBe('发送讨论');
    expect(el('conversation-focus').textContent).not.toContain('发布方案');
    expect(h.posts.some(post => post.url.endsWith('/messages') || post.url.startsWith('/api/runs') || post.url === '/api/rooms')).toBe(false);
    expect(h.posts.find(post => post.url === '/api/conversations')?.body).toEqual({ title: '发布', agentId: 'demo.release' });
    expect(JSON.stringify(h.posts)).not.toContain('先别发出去');
    expect(draft.value).toBe('');
    expect(el('entry-presence').textContent).toBe('空闲');
    expect(el('bot-status').textContent).toContain('空闲');
    expect(el('bot-status').textContent).toContain('看一眼不会执行');
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
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(1));
    expect(messagePosts(h)[0]?.body).toMatchObject({ intent: 'discuss', focus: 'keep', newTask: { title: '请 @发布 看一下' } });
    expect(messagePosts(h)[0]?.body).not.toHaveProperty('runOptions');
    expect(h.posts.filter(post => post.url.endsWith('/focus'))).toHaveLength(0);
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
    expect(h.posts.filter(post => post.url.endsWith('/messages'))).toHaveLength(1);
    expect(h.posts.filter(post => post.url.endsWith('/focus'))).toHaveLength(0);
    const groupRow = [...doc().querySelectorAll<HTMLButtonElement>('#groups button')].find(button => button.textContent?.includes('发布协作'));
    groupRow?.click();
    await vi.waitFor(() => expect(el('entry-presence').textContent).toBe('群聊'));
    el('chat-archive').click();
    await vi.waitFor(() => expect(el('group-panel').hidden).toBe(true));
    expect(el('groups').textContent ?? '').not.toContain('发布协作');
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(typed.value).toBe('还留在入口');
    expect(h.posts.filter(post => post.url.endsWith('/messages'))).toHaveLength(1);
    expect(h.posts.filter(post => post.url.endsWith('/focus'))).toHaveLength(0);
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
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(1));
    expect(messagePosts(h)[0]?.body).toMatchObject({ intent: 'discuss', focus: 'keep', newTask: { title: '请 @所有人 看一下' } });
    expect(messagePosts(h)[0]?.body).not.toHaveProperty('runOptions');
    expect(el('group-transcript').textContent).toContain('没有拆给多个人');
    el<HTMLTextAreaElement>('group-text').value = '@AEEIS 整理发布风险';
    el<HTMLFormElement>('group-composer').requestSubmit();
    await vi.waitFor(() => expect(el('group-transcript').textContent).toContain('已记为入口讨论「整理发布风险」'));
    const mention = messagePosts(h);
    expect(mention).toHaveLength(2);
    expect(mention[1]?.body).toEqual({
      text: '来自群聊「发布协作」：@AEEIS 整理发布风险',
      expectedRevision: 2,
      newTask: { title: '整理发布风险' },
      focus: 'keep',
      intent: 'discuss',
    });
    expect(mention[1]?.body).not.toHaveProperty('runOptions');
    const roomEvents = [...events.values()].flat().filter(event => event.content.includes('整理发布风险') || event.content.includes('入口讨论'));
    expect(roomEvents.map(event => event.type)).toEqual(['message', 'system']);
    const receipt = [...doc().querySelectorAll<HTMLElement>('#group-transcript [data-type="system"]')].find(item => item.textContent?.includes('整理发布风险'));
    expect(receipt?.textContent).toContain('记录');
    expect(receipt?.textContent).toContain('未执行，讨论焦点不变');
    expect(el('conversation-focus').textContent).toContain('发布方案');
    const created = doc().querySelector<HTMLElement>('[data-task-id="task_new_3"]');
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
    expect(el('entry-presence').textContent).toBe('空闲');
    expect(h.posts.find(post => post.body?.agentId === 'demo.release')?.body).toEqual({ title: '发布', agentId: 'demo.release' });
    expect(h.posts.some(post => post.url === '/api/rooms' && post.body?.description === '私聊')).toBe(false);
    el<HTMLTextAreaElement>('conversation-text').value = '发布口径先记在这里';
    el('conversation-composer').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(el('conversation-messages').textContent).toContain('发布口径先记在这里'));
    expect(messagePosts(h)).toHaveLength(3);
    expect(messagePosts(h)[2]?.url).toBe('/api/conversations/conv_life_1/messages');
    expect(messagePosts(h)[2]?.body).toMatchObject({ text: '发布口径先记在这里', expectedRevision: 0, focus: 'keep', intent: 'discuss' });
    expect(messagePosts(h)[2]?.body).not.toHaveProperty('speaker');
    expect(messagePosts(h)[2]?.body).not.toHaveProperty('runOptions');
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
    expect(messagePosts(h)).toHaveLength(4);
    expect(messagePosts(h)[3]?.url).toBe(`/api/conversations/${view.id}/messages`);
    expect(messagePosts(h)[3]?.body).toMatchObject({
      text: '来自私聊「member.editor」：@AEEIS 记下私聊',
      expectedRevision: 3,
      newTask: { title: '记下私聊' },
      focus: 'keep',
      intent: 'discuss',
    });
    expect(messagePosts(h)[3]?.body).not.toHaveProperty('runOptions');
    expect(el('conversation-tasks').textContent ?? '').not.toContain('记下私聊');
    expect(el('conversation-messages').textContent).toContain('发布口径先记在这里');
    el('gb-bot').click();
    await vi.waitFor(() => expect(el('conversation-focus').textContent).toContain('发布方案'));
    expect(doc().querySelector('[data-task-id="task_new_3"]')?.textContent).toContain('整理发布风险');
    expect(doc().querySelector<HTMLElement>('[data-task-id="task_new_3"]')?.dataset.focused).toBe('false');
    expect(doc().querySelector('[data-task-id="task_new_4"]')?.textContent).toContain('记下私聊');
    expect(doc().querySelector<HTMLElement>('[data-task-id="task_new_4"]')?.dataset.focused).toBe('false');
    expect(doc().querySelector<HTMLElement>('[data-task-id="task_a"]')?.dataset.focused).toBe('true');
    expect(el('conversation-messages').textContent).not.toContain('发布口径先记在这里');
    expect(typed.value).toBe('');
    expect(h.posts.some(post => /\/runs(?:\/|$)|\/approve$|\/focus$|\/cancel$/.test(post.url))).toBe(false);
  });
  it('hands a group sentence to a roster person and shows that task read-only in the channel', async () => {
    const rooms: Array<{ id: string; title: string; description?: string; status: string; createdAt: string; updatedAt: string }> = [];
    const events = new Map<string, Array<{ id: string; operation: string; actorType: string; actorId: string; type: string; content: string; evidenceRefs?: string[]; createdAt: string }>>();
    const membersByRoom = new Map<string, Array<{ id: string; roomId: string; principalId: string; role: string; status: string; invitedBy: string; createdAt: string; updatedAt: string }>>();
    const release = { id: 'conv_release', title: '发布', revision: 0, agentId: 'demo.release', focusTaskId: undefined as string | undefined, tasks: [] as any[], messages: [] as any[], hasEarlierMessages: false };
    const h = harness(undefined, { handler: (url, request) => {
      const method = request?.method ?? 'GET';
      const body = request?.body ? JSON.parse(request.body) : undefined;
      const roomId = decodeURIComponent(String(url).match(/\/rooms\/([^/?]+)/)?.[1] ?? '');
      if (url === '/api/rooms' && method === 'POST') {
        const room = { id: 'room_handoff', title: body.title, description: body.description, status: 'active', createdAt: date, updatedAt: date };
        rooms.unshift(room);
        return response(room);
      }
      if (url === '/api/rooms?limit=50') return response(rooms);
      if (String(url).endsWith('/members') && method === 'POST') {
        const member = { id: `member_${(membersByRoom.get(roomId) ?? []).length}`, roomId, principalId: body.principalId, role: body.role, status: 'active', invitedBy: 'owner', createdAt: date, updatedAt: date };
        membersByRoom.set(roomId, [...(membersByRoom.get(roomId) ?? []), member]);
        return response(member);
      }
      if (String(url).endsWith('/members')) return response(membersByRoom.get(roomId) ?? []);
      if (String(url).endsWith('/goals') && method === 'GET') return response([]);
      if (String(url).endsWith('/goals') && method === 'POST') return response({ id: 'goal_handoff', title: body.title, status: 'active', createdAt: date, roomId: body.roomId });
      if (String(url).includes('/context-manifests')) return response({ id: 'ctx_handoff' });
      if (String(url).includes('/session-events') && method === 'POST') {
        const list = events.get(roomId) ?? [];
        const event = { id: `evt_${list.length}`, operation: 'publish', actorType: body.actor?.type === 'agent' ? 'agent' : 'principal', actorId: body.actor?.id ?? 'owner', type: body.type, content: body.content, ...(body.evidenceRefs ? { evidenceRefs: body.evidenceRefs } : {}), createdAt: date };
        list.push(event);
        events.set(roomId, list);
        return response(event);
      }
      if (String(url).includes('/session-events')) return response({ items: events.get(roomId) ?? [] });
      if (url === '/api/conversations' && method === 'POST' && body?.agentId === 'demo.release') return response(release);
      if (url === `/api/runs/${runId}` && method === 'GET') return response({
        id: runId, revision: 1, goal: '核对发布说明', status: 'needs_approval', canEdit: true, privacy: 'internal',
        plans: [], steps: [], events: [], calls: [], context: { sources: [] },
        artifacts: [{ id: 'artifact_note', title: '工作区清单', content: '周三那一版可以发。', evidenceRefs: ['清单'] }],
      });
      if (url === '/api/conversations/conv_release' && method !== 'POST') return response(release);
      if (method === 'POST' && String(url).endsWith('/answer')) {
        const task = release.tasks.find(item => item.pendingQuestion);
        if (body.answer !== '用周三那一版') return response({ error: 'bad answer' }, 400);
        if (task) delete task.pendingQuestion;
        return response({ id: runId, status: 'needs_approval' });
      }
      if (url === '/api/conversations/conv_release/messages' && method === 'POST') {
        const created = body.newTask ? { id: `task_new_${release.tasks.length}`, title: body.newTask.title, threadId: `thread_new_${release.tasks.length}`, status: 'discussion' } : undefined;
        if (created) release.tasks.push(created);
        const route = { status: 'routed', reason: 'new-task', taskIds: created ? [created.id] : [], candidateTaskIds: [], focusEffect: body.focus };
        const message = { id: `message_${release.messages.length}`, role: 'user', text: body.text, createdAt: date, route, ...(body.speaker ? { speaker: body.speaker } : {}) };
        release.messages.push(message);
        release.revision++;
        return response({ conversation: release, message, response: '已记录讨论，未触发执行。' });
      }
      return undefined;
    } });
    start(h.fetch);
    await ready();
    el('gb-new-group').click();
    const releaseBox = [...doc().querySelectorAll('#group-candidates label')].find(label => label.textContent?.includes('发布'));
    releaseBox?.querySelector('input')?.click();
    el<HTMLInputElement>('group-title').value = '发布协作';
    el<HTMLFormElement>('group-create').requestSubmit();
    await vi.waitFor(() => expect([...el<HTMLSelectElement>('group-handoff').options].map(option => option.textContent)).toEqual(['只留在会话里', '交给AEEIS', '交给发布']));
    expect([...el<HTMLSelectElement>('group-handoff').options].map(option => option.textContent).join('')).not.toContain('研究');
    expect(el<HTMLSelectElement>('group-handoff').value).toBe('');
    const handoff = el<HTMLSelectElement>('group-handoff');
    handoff.value = 'demo.release';
    el<HTMLTextAreaElement>('group-text').value = '@AEEIS 不要记两次';
    el<HTMLFormElement>('group-composer').requestSubmit();
    await vi.waitFor(() => expect(el('group-transcript').textContent).toContain('已交给发布，记为讨论「不要记两次」。未执行，对方不会自己回复。'));
    expect(messagePosts(h)).toHaveLength(1);
    expect(messagePosts(h)[0]?.url).toBe('/api/conversations/conv_release/messages');
    expect(messagePosts(h)[0]?.body).toMatchObject({ intent: 'discuss', focus: 'keep', newTask: { title: '不要记两次' } });
    expect(messagePosts(h)[0]?.body).not.toHaveProperty('runOptions');
    expect(el('group-transcript').textContent).not.toContain('已记为入口讨论');
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(el('conversation-tasks').textContent ?? '').not.toContain('不要记两次');
    handoff.value = 'demo.release';
    el<HTMLTextAreaElement>('group-text').value = '请核对发布说明';
    el<HTMLFormElement>('group-composer').requestSubmit();
    const cards = () => [...doc().querySelectorAll<HTMLElement>('.group-run-card')];
    await vi.waitFor(() => expect(cards().find(item => item.dataset.card === 'task' && item.dataset.handoff === 'task_new_1')?.textContent).toContain('仅讨论，未执行'));
    const posted = messagePosts(h);
    expect(posted).toHaveLength(2);
    expect(h.posts.find(post => post.url === '/api/conversations' && post.body?.agentId === 'demo.release')?.body).toEqual({ title: '发布', agentId: 'demo.release' });
    expect(posted[1]?.url).toBe('/api/conversations/conv_release/messages');
    expect(posted[1]?.body).toEqual({
      text: '来自群聊「发布协作」：请核对发布说明',
      expectedRevision: 1,
      newTask: { title: '请核对发布说明' },
      focus: 'keep',
      intent: 'discuss',
    });
    expect(posted[1]?.body).not.toHaveProperty('runOptions');
    expect(posted[1]?.body).not.toHaveProperty('speaker');
    const system = h.posts.filter(post => post.url.endsWith('/session-events') && post.body?.type === 'system');
    expect(system.at(-1)?.body).toMatchObject({
      content: '已交给发布，记为讨论「请核对发布说明」。未执行，对方不会自己回复。',
      evidenceRefs: ['conv_release', 'task_new_1', 'demo.release'],
    });
    const card = cards().find(item => item.dataset.handoff === 'task_new_1');
    expect(card?.dataset.handoff).toBe('task_new_1');
    expect(card?.textContent).toContain('交给发布');
    expect(card?.textContent).toContain('请核对发布说明');
    expect(card?.querySelector('[data-approve]')).toBeNull();
    expect(card?.querySelector('textarea')).toBeNull();
    expect(card?.querySelector('button')?.textContent).toBe('打开发布');
    expect(el<HTMLSelectElement>('group-handoff').value).toBe('');
    expect(el('conversation-focus').textContent).toContain('发布方案');
    release.tasks[1] = {
      ...release.tasks[1],
      status: 'needs_approval',
      runId,
      latestRunId: runId,
      pendingApproval: { planVersion: 1, planHash: 'plan-hash', summary: '核对发布说明' },
      pendingQuestion: { text: '哪一版说明？' },
      execution: { steps: [{ title: '核对清单', state: 'waiting' }, { title: '写下结论', state: 'current' }], evidence: ['工作区清单'] },
    };
    const groupRow = [...doc().querySelectorAll<HTMLButtonElement>('#groups button')].find(button => button.textContent?.includes('发布协作'));
    groupRow?.click();
    await vi.waitFor(() => expect(cards().find(item => item.dataset.card === 'approval')?.textContent).toContain('待批准：核对发布说明'));
    const updated = cards().find(item => item.dataset.handoff === 'task_new_1' && item.dataset.card === 'handoff');
    const taskCard = cards().find(item => item.dataset.card === 'task' && item.dataset.handoff === 'task_new_1');
    const artifact = cards().find(item => item.dataset.card === 'artifact' && item.dataset.handoff === 'task_new_1');
    const approval = cards().find(item => item.dataset.card === 'approval');
    const question = cards().find(item => item.dataset.card === 'question');
    expect(taskCard?.textContent).toContain('执行步骤：核对清单 还没到 · 写下结论 正在做');
    expect(artifact?.textContent).toContain('工作区清单');
    expect(artifact?.textContent).toContain('在频道里阅读');
    clickText('阅读全文', artifact!);
    await vi.waitFor(() => expect(el('channel-artifact-body').textContent).toContain('周三那一版可以发。'));
    expect(el('channel-artifact').hidden).toBe(false);
    expect(el('channel-artifact-body').textContent).toContain('证据：清单');
    expect(el('detail').hidden).toBe(true);
    expect(el('conversation-focus').textContent).toContain('发布方案');
    el('channel-artifact-close').click();
    expect(el('channel-artifact').hidden).toBe(true);
    expect(approval?.textContent).toContain('不会改讨论焦点');
    expect(approval?.querySelector('[data-approve]')).not.toBeNull();
    expect(approval?.querySelector('[data-approve-once]')).not.toBeNull();
    expect(approval?.querySelector('[data-reject]')).not.toBeNull();
    expect(question?.textContent).toContain('待回答：哪一版说明？');
    expect(question?.textContent).toContain('不会改讨论焦点');
    expect(question?.querySelector('[data-answer]')).not.toBeNull();
    expect(question?.querySelector('[data-answer-submit]')).not.toBeNull();
    clickText('提交回答', question!);
    expect(el('conversation-error').textContent).toContain('请先写下回答');
    expect(h.posts.some(post => post.url.endsWith('/answer'))).toBe(false);
    question!.querySelector<HTMLTextAreaElement>('textarea[data-answer]')!.value = '用周三那一版';
    clickText('提交回答', question!);
    await vi.waitFor(() => expect(cards().some(item => item.dataset.card === 'question')).toBe(false));
    expect(h.posts.find(post => post.url.endsWith('/answer'))?.body).toEqual({ answer: '用周三那一版' });
    expect(h.posts.find(post => post.url.endsWith('/answer'))?.url).toBe(`/api/runs/${runId}/answer`);
    expect(el('conversation-focus').textContent).toContain('发布方案');
    expect(el('conversation-status').textContent).toContain('讨论焦点没有改变');
    expect(updated?.querySelector('[data-approve]')).toBeNull();
    expect(updated?.querySelector('textarea')).toBeNull();
    const handoffCard = cards().find(item => item.dataset.handoff === 'task_new_1' && item.dataset.card === 'handoff');
    clickText('打开发布', handoffCard!);
    await vi.waitFor(() => expect(el('entry-title').textContent).toBe('发布'));
    expect(el('conversation-tasks').textContent).toContain('请核对发布说明');
    expect(el('conversation-tasks').textContent).toContain('待批准');
    expect(h.posts.filter(post => /\/approve$|\/focus$|\/cancel$|\/retry$|\/revise-plan$/.test(post.url))).toHaveLength(0);
    expect(h.posts.filter(post => post.url.endsWith('/answer'))).toHaveLength(1);
    el('gb-bot').click();
    await vi.waitFor(() => expect(el('conversation-focus').textContent).toContain('发布方案'));
    expect(el('conversation-tasks').textContent ?? '').not.toContain('请核对发布说明');
    expect(doc().querySelector('[data-task-id="task_a"]')?.textContent).toContain('发布方案');
  });
  it('lets a group message name a member bot and copies that speaker onto the AEEIS discussion', async () => {
    const rooms: Array<{ id: string; title: string; description?: string; status: string; createdAt: string; updatedAt: string }> = [];
    const events = new Map<string, Array<{ id: string; operation: string; actorType: string; actorId: string; type: string; content: string; createdAt: string }>>();
    const membersByRoom = new Map<string, Array<{ id: string; roomId: string; principalId: string; role: string; status: string; invitedBy: string; createdAt: string; updatedAt: string }>>();
    const h = harness(undefined, { handler: (url, request) => {
      const method = request?.method ?? 'GET';
      const body = request?.body ? JSON.parse(request.body) : undefined;
      const roomId = decodeURIComponent(String(url).match(/\/rooms\/([^/?]+)/)?.[1] ?? '');
      if (url === '/api/rooms' && method === 'POST') {
        const room = { id: 'room_speaker', title: body.title, description: body.description, status: 'active', createdAt: date, updatedAt: date };
        rooms.unshift(room);
        return response(room);
      }
      if (url === '/api/rooms?limit=50') return response(rooms);
      if (String(url).endsWith('/members') && method === 'POST') {
        const member = { id: `member_${(membersByRoom.get(roomId) ?? []).length}`, roomId, principalId: body.principalId, role: body.role, status: 'active', invitedBy: 'owner', createdAt: date, updatedAt: date };
        membersByRoom.set(roomId, [...(membersByRoom.get(roomId) ?? []), member]);
        return response(member);
      }
      if (String(url).endsWith('/members')) return response(membersByRoom.get(roomId) ?? []);
      if (String(url).endsWith('/goals') && method === 'GET') return response([]);
      if (String(url).endsWith('/goals') && method === 'POST') return response({ id: 'goal_speaker', title: body.title, status: 'active', createdAt: date, roomId: body.roomId });
      if (String(url).includes('/context-manifests')) return response({ id: 'ctx_speaker' });
      if (String(url).includes('/session-events') && method === 'POST') {
        const list = events.get(roomId) ?? [];
        const event = { id: `evt_${list.length}`, operation: 'publish', actorType: body.actor?.type === 'agent' ? 'agent' : 'principal', actorId: body.actor?.id ?? 'owner', type: body.type, content: body.content, createdAt: date };
        list.push(event);
        events.set(roomId, list);
        return response(event);
      }
      if (String(url).includes('/session-events')) return response({ items: events.get(roomId) ?? [] });
      return undefined;
    } });
    start(h.fetch);
    await ready();
    expect(el<HTMLSelectElement>('group-speaker').hidden).toBe(true);
    el('gb-new-group').click();
    const release = [...doc().querySelectorAll('#group-candidates label')].find(label => label.textContent?.includes('发布'));
    release?.querySelector('input')?.click();
    el<HTMLInputElement>('group-title').value = '发布协作';
    el<HTMLFormElement>('group-create').requestSubmit();
    await vi.waitFor(() => expect([...el<HTMLSelectElement>('group-speaker').options].map(option => option.textContent)).toContain('发布'));
    expect(el<HTMLSelectElement>('group-speaker').hidden).toBe(false);
    const speaker = el<HTMLSelectElement>('group-speaker');
    speaker.value = 'demo.release';
    el<HTMLTextAreaElement>('group-text').value = '我来对照清单';
    el<HTMLFormElement>('group-composer').requestSubmit();
    await vi.waitFor(() => expect(el('group-transcript').textContent).toContain('发布'));
    expect(el('group-transcript').textContent).toContain('我来对照清单');
    const roomMessage = h.posts.find(post => post.url.endsWith('/session-events'));
    expect(roomMessage?.body).toMatchObject({ type: 'message', content: '我来对照清单', actor: { type: 'agent', id: 'demo.release' } });
    expect(roomMessage?.body).not.toHaveProperty('runOptions');
    expect(messagePosts(h)).toHaveLength(0);
    el<HTMLTextAreaElement>('group-text').value = '@AEEIS 整理发布风险';
    el<HTMLFormElement>('group-composer').requestSubmit();
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(1));
    expect(messagePosts(h)[0]?.body).toMatchObject({
      text: '来自群聊「发布协作」：@AEEIS 整理发布风险',
      intent: 'discuss',
      focus: 'keep',
      speaker: { role: 'agent', id: 'demo.release' },
    });
    expect(messagePosts(h)[0]?.body).not.toHaveProperty('runOptions');
    expect(el('conversation-focus').textContent).toContain('发布方案');
    speaker.value = '';
    el<HTMLTextAreaElement>('group-text').value = '这句是我的';
    el<HTMLFormElement>('group-composer').requestSubmit();
    await vi.waitFor(() => expect(el('group-transcript').textContent).toContain('这句是我的'));
    const own = h.posts.filter(post => post.url.endsWith('/session-events') && post.body?.type === 'message');
    expect(own.at(-1)?.body).not.toHaveProperty('actor');
    expect(h.posts.some(post => /\/runs(?:\/|$)|\/approve$|\/focus$|\/cancel$/.test(post.url))).toBe(false);
    el('gb-bot').click();
    await vi.waitFor(() => expect(el('entry-title').textContent).toBe('AEEIS'));
    expect(el<HTMLSelectElement>('group-speaker').hidden).toBe(true);
    expect(el('conversation-messages').textContent).toContain('发布');
    expect(el('conversation-messages').textContent).toContain('整理发布风险');
    expect(el<HTMLSelectElement>('life-speaker').hidden).toBe(false);
  });
  it('lets a life thread name this person and keeps the default speaker as the owner', async () => {
    const h = harness();
    start(h.fetch);
    await ready();
    const home = el<HTMLSelectElement>('life-speaker');
    expect(home.hidden).toBe(false);
    expect([...home.options].map(option => option.textContent)).toContain('AEEIS');
    expect(home.value).toBe('');
    fill('conversation-text', '这句是我的');
    submit();
    await vi.waitFor(() => {
      expect(messagePosts(h)).toHaveLength(1);
      expect(el('conversation-status').textContent).toContain('系统回执');
    });
    expect(messagePosts(h)[0]?.body).not.toHaveProperty('speaker');
    expect(messagePosts(h)[0]?.body).not.toHaveProperty('runOptions');
    doc().querySelector<HTMLButtonElement>('[data-bot-id="demo.release"]')!.click();
    await vi.waitFor(() => expect([...el<HTMLSelectElement>('life-speaker').options].map(option => option.value)).toContain('demo.release'));
    expect(el('entry-title').textContent).toBe('发布');
    expect(el<HTMLSelectElement>('life-speaker').hidden).toBe(false);
    expect(el<HTMLSelectElement>('group-speaker').hidden).toBe(true);
    const person = el<HTMLSelectElement>('life-speaker');
    person.value = 'demo.release';
    el<HTMLTextAreaElement>('conversation-text').value = '发布自己说的';
    submit();
    await vi.waitFor(() => expect(el('conversation-messages').textContent).toContain('发布自己说的'));
    const spoken = messagePosts(h).at(-1);
    expect(spoken?.url).toBe('/api/conversations/conv_life_1/messages');
    expect(spoken?.body).toMatchObject({ text: '发布自己说的', intent: 'discuss', focus: 'keep', speaker: { role: 'agent', id: 'demo.release' } });
    expect(spoken?.body).not.toHaveProperty('runOptions');
    const spokenRow = [...doc().querySelectorAll<HTMLElement>('#conversation-messages li')].find(row => row.textContent?.includes('发布自己说的'));
    expect(spokenRow?.dataset.speaker).toBe('agent');
    expect(spokenRow?.dataset.speakerId).toBe('demo.release');
    expect(spokenRow?.querySelector('small')?.textContent ?? '').toMatch(/^发布 · /);
    expect(spokenRow?.querySelector('small')?.textContent ?? '').not.toContain('对');
    person.value = '';
    el<HTMLTextAreaElement>('conversation-text').value = '我补充一句';
    submit();
    await vi.waitFor(() => expect(el('conversation-messages').textContent).toContain('我补充一句'));
    expect(messagePosts(h).at(-1)?.body).not.toHaveProperty('speaker');
    const ownRow = [...doc().querySelectorAll<HTMLElement>('#conversation-messages li')].find(row => row.textContent?.includes('我补充一句'));
    expect(ownRow?.querySelector('small')?.textContent).toContain('你 · 对发布');
    expect(h.posts.some(post => /\/runs(?:\/|$)|\/approve$|\/focus$|\/cancel$/.test(post.url))).toBe(false);
  });
  it('lets a private chat name the other person and keeps that identity off execution', async () => {
    const rooms: Array<{ id: string; title: string; description?: string; status: string; createdAt: string; updatedAt: string }> = [];
    const events = new Map<string, Array<{ id: string; operation: string; actorType: string; actorId: string; type: string; content: string; createdAt: string }>>();
    const membersByRoom = new Map<string, Array<{ id: string; roomId: string; principalId: string; role: string; status: string; invitedBy: string; createdAt: string; updatedAt: string }>>();
    const h = harness(undefined, { handler: (url, request) => {
      const method = request?.method ?? 'GET';
      const body = request?.body ? JSON.parse(request.body) : undefined;
      const roomId = decodeURIComponent(String(url).match(/\/rooms\/([^/?]+)/)?.[1] ?? '');
      if (url === '/api/rooms' && method === 'POST') {
        const room = { id: body.description === '私聊' ? 'room_direct' : 'room_group', title: body.title, description: body.description, status: 'active', createdAt: date, updatedAt: date };
        rooms.unshift(room);
        return response(room);
      }
      if (url === '/api/rooms?limit=50') return response(rooms);
      if (String(url).endsWith('/members') && method === 'POST') {
        const member = { id: `member_${(membersByRoom.get(roomId) ?? []).length}`, roomId, principalId: body.principalId, role: body.role, status: 'active', invitedBy: 'owner', createdAt: date, updatedAt: date };
        membersByRoom.set(roomId, [...(membersByRoom.get(roomId) ?? []), member]);
        return response(member);
      }
      if (String(url).endsWith('/members')) return response(membersByRoom.get(roomId) ?? []);
      if (String(url).endsWith('/goals') && method === 'GET') return response([]);
      if (String(url).endsWith('/goals') && method === 'POST') return response({ id: 'goal_direct', title: body.title, status: 'active', createdAt: date, roomId: body.roomId });
      if (String(url).includes('/context-manifests')) return response({ id: 'ctx_direct' });
      if (String(url).includes('/session-events') && method === 'POST') {
        const list = events.get(roomId) ?? [];
        const event = { id: `evt_${list.length}`, operation: 'publish', actorType: body.actor?.type === 'agent' ? 'agent' : 'principal', actorId: body.actor?.id ?? 'owner', type: body.type, content: body.content, createdAt: date };
        list.push(event);
        events.set(roomId, list);
        return response(event);
      }
      if (String(url).includes('/session-events')) return response({ items: events.get(roomId) ?? [] });
      return undefined;
    } });
    start(h.fetch);
    await ready();
    el('gb-new-group').click();
    el<HTMLInputElement>('group-person').value = 'member.editor';
    el('group-add-person').click();
    el<HTMLInputElement>('group-title').value = '发布协作';
    el<HTMLFormElement>('group-create').requestSubmit();
    await vi.waitFor(() => expect(el('group-members').textContent).toContain('member.editor'));
    expect(el<HTMLSelectElement>('group-speaker').hidden).toBe(false);
    expect([...el<HTMLSelectElement>('group-speaker').options].map(option => option.value)).toEqual(['']);
    clickText('member.editor', el('group-members'));
    await vi.waitFor(() => expect([...el<HTMLSelectElement>('group-speaker').options].map(option => option.value)).toContain('member.editor'));
    expect(el('entry-presence').textContent).toBe('私聊');
    expect(el('chat-note').textContent).toContain('说话人');
    expect(el<HTMLSelectElement>('group-speaker').hidden).toBe(false);
    expect(el<HTMLSelectElement>('life-speaker').hidden).toBe(true);
    const speaker = el<HTMLSelectElement>('group-speaker');
    speaker.value = 'member.editor';
    el<HTMLTextAreaElement>('group-text').value = '对方先说';
    el<HTMLFormElement>('group-composer').requestSubmit();
    await vi.waitFor(() => expect(el('group-transcript').textContent).toContain('对方先说'));
    expect(el('group-transcript').textContent).toContain('member.editor');
    const roomMessage = h.posts.find(post => post.url.endsWith('/session-events') && post.body?.content === '对方先说');
    expect(roomMessage?.body).toMatchObject({ type: 'message', content: '对方先说', actor: { type: 'principal', id: 'member.editor' } });
    expect(roomMessage?.body).not.toHaveProperty('runOptions');
    expect(messagePosts(h)).toHaveLength(0);
    el<HTMLTextAreaElement>('group-text').value = '@AEEIS 记下私聊';
    el<HTMLFormElement>('group-composer').requestSubmit();
    await vi.waitFor(() => expect(messagePosts(h)).toHaveLength(1));
    expect(messagePosts(h)[0]?.body).toMatchObject({
      text: '来自私聊「member.editor」：@AEEIS 记下私聊',
      intent: 'discuss',
      focus: 'keep',
    });
    expect(messagePosts(h)[0]?.body).not.toHaveProperty('speaker');
    expect(messagePosts(h)[0]?.body).not.toHaveProperty('runOptions');
    const mention = h.posts.filter(post => post.url.endsWith('/session-events') && post.body?.type === 'message').at(-1);
    expect(mention?.body.actor).toEqual({ type: 'principal', id: 'member.editor' });
    expect(el('conversation-focus').textContent).toContain('发布方案');
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
  it('accepts one practice sentence from the latest delivery and keeps discussion from saving it', async () => {
    const h = harness();
    start(h.fetch);
    await ready();
    expect(el('last-delivery').hidden).toBe(true);
    expect(el('accepted-practice').hidden).toBe(true);
    h.view.lastDelivery = { taskId: 'task_b', taskTitle: '周报', runId, planSummary: '先列已完成的条目', artifactTitles: ['周报稿'] };
    el('conversation-refresh').click();
    await vi.waitFor(() => {
      expect(el('last-delivery').hidden).toBe(false);
      expect(el<HTMLTextAreaElement>('practice-text').value).toBe('周报。先列已完成的条目。周报稿');
      expect(el<HTMLButtonElement>('practice-accept').disabled).toBe(false);
    });
    fill('practice-text', '先核对栏目再交周报');
    el('practice-accept').click();
    await vi.waitFor(() => {
      expect(el('conversation-status').textContent).toContain('已收下这句做法');
      expect(el('accepted-practice').hidden).toBe(false);
      expect(el('accepted-practice-copy').textContent).toBe('先核对栏目再交周报');
      expect(el<HTMLButtonElement>('practice-accept').disabled).toBe(false);
    });
    const accepted = h.posts.find(post => post.url.endsWith('/practice'));
    expect(accepted?.body).toEqual({ expectedRevision: 1, text: '先核对栏目再交周报', runId });
    expect(accepted?.body).not.toHaveProperty('runOptions');
    fill('conversation-text', '讨论不改做法');
    submit();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('系统回执'));
    expect(h.posts.filter(post => post.url.endsWith('/practice'))).toHaveLength(1);
    expect(JSON.stringify(messagePosts(h).at(-1)?.body)).not.toContain('先核对栏目再交周报');
    await vi.waitFor(() => expect(doc().querySelector('[data-bot-id="demo.research"]')).toBeTruthy());
    doc().querySelector<HTMLButtonElement>('[data-bot-id="demo.research"]')!.click();
    await vi.waitFor(() => {
      expect(el('entry-title').textContent).toBe('研究');
      expect(el<HTMLButtonElement>('conversation-send').disabled).toBe(false);
    });
    expect(el('accepted-practice').hidden).toBe(true);
    expect(el('last-delivery').hidden).toBe(true);
    el('gb-new-group').click();
    expect(el('entry-title').textContent).toBe('新建群聊');
    expect(el('accepted-practice').hidden).toBe(true);
    doc().querySelector<HTMLButtonElement>('[data-bot-id="aeeis"]')!.click();
    await vi.waitFor(() => {
      expect(el('entry-title').textContent).toBe('AEEIS');
      expect(el('accepted-practice').hidden).toBe(false);
      expect(el<HTMLButtonElement>('accepted-practice-retract').disabled).toBe(false);
    });
    clickText('撤回这句');
    await vi.waitFor(() => {
      expect(el('conversation-status').textContent).toContain('已撤回这句做法');
      expect(el('accepted-practice').hidden).toBe(true);
    });
    expect(h.posts.find(post => post.url.endsWith('/practice/retract'))?.body).toEqual({ expectedRevision: 2, claimId: 'brain_practice' });
    expect(h.view.acceptedPractice).toBeUndefined();
  });
  it('keeps a skill profile and a model on the task kind', async () => {
    const h = harness();
    start(h.fetch);
    await ready();
    expect(el('task-settings').hidden).toBe(false);
    expect(el<HTMLButtonElement>('skill-promote').disabled).toBe(true);
    h.view.lastDelivery = { taskId: 'task_b', taskTitle: '周报', runId, planSummary: '先列已完成的条目', artifactTitles: ['周报稿'] };
    el('conversation-refresh').click();
    await vi.waitFor(() => expect(el('last-delivery').hidden).toBe(false));
    fill('task-kind', '周报');
    await vi.waitFor(() => expect(el<HTMLButtonElement>('skill-promote').disabled).toBe(false));
    el('skill-promote').click();
    await vi.waitFor(() => expect(el('skill-profile-copy').textContent).toContain('project-pulse · 1'));
    expect(h.posts.find(post => post.url.endsWith('/skill-profile'))?.body).toEqual({ expectedRevision: 1, taskKind: '周报', runId });
    el('skill-promote').click();
    await vi.waitFor(() => expect(el('skill-profile-copy').textContent).toContain('project-pulse · 2'));
    fill('skill-rollback-reason', '口径不稳');
    el('skill-rollback').click();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('已回滚到上一版'));
    expect(el('skill-profile-copy').textContent).toContain('project-pulse · 1');
    expect(h.posts.find(post => post.url.endsWith('/skill-profile/rollback'))?.body).toEqual({ expectedRevision: 1, taskKind: '周报', reason: '口径不稳' });
    fill('task-model', 'fixture');
    el('task-model-save').click();
    await vi.waitFor(() => expect(el('task-model-copy').textContent).toContain('fixture'));
    const saved = h.posts.find(post => post.url.endsWith('/task-model'));
    expect(saved?.body).toEqual({ expectedRevision: 1, taskKind: '周报', model: 'fixture' });
    expect(saved?.body).not.toHaveProperty('runOptions');
    fill('conversation-text', '讨论不晋升');
    submit();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('系统回执'));
    expect(h.posts.filter(post => post.url.includes('/skill-profile'))).toHaveLength(3);
    expect(h.posts.filter(post => post.url.endsWith('/task-model'))).toHaveLength(1);
    expect(messagePosts(h).at(-1)?.body.taskKind).toBeUndefined();
    fill('conversation-target', '__new');
    fill('conversation-task-title', '下一版周报');
    fill('conversation-text', '按这个种类做');
    el('conversation-execute').click();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('系统回执'));
    const executed = messagePosts(h).at(-1)?.body;
    expect(executed.taskKind).toBe('周报');
    expect(executed.intent).toBe('execute');
    expect(executed.runOptions.preferredModel).toBeUndefined();
    expect(JSON.stringify(executed.runOptions)).not.toContain('fixture');
    await vi.waitFor(() => expect(doc().querySelector('[data-bot-id="demo.research"]')).toBeTruthy());
    doc().querySelector<HTMLButtonElement>('[data-bot-id="demo.research"]')!.click();
    await vi.waitFor(() => expect(el<HTMLButtonElement>('conversation-send').disabled).toBe(false));
    expect(el('task-settings').hidden).toBe(false);
    expect(el('skill-profile-copy').textContent).not.toContain('project-pulse');
    el('gb-new-group').click();
    expect(el('task-settings').hidden).toBe(true);
  });
  it('lines up a later success with the saved profile and keeps that profile', async () => {
    const h = harness();
    start(h.fetch);
    await ready();
    const later = 'run_00000000-0000-4000-8000-000000000002';
    h.view.taskSettings = {
      skills: [{ claimId: 'brain_skill', taskKind: '周报', methodId: 'project-pulse', version: '1', runId, evidenceRefs: ['artifact_pulse'] }],
      models: [{ claimId: 'brain_model', taskKind: '周报', model: 'fixture' }],
      comparisons: [
        { taskKind: '周报', runId: later, taskTitle: '第二份周报', methodId: 'brief-method', version: '2', model: 'other-model', profileMethodId: 'project-pulse', profileVersion: '1', profileRunId: runId, profileModel: 'fixture', differs: true, kept: false },
        { taskKind: '纪要', runId: 'run_00000000-0000-4000-8000-000000000003', taskTitle: '一份纪要', methodId: 'project-pulse', version: '1', model: 'fixture', profileMethodId: 'project-pulse', profileVersion: '1', profileModel: 'other-model', differs: true, kept: false },
      ],
    };
    el('conversation-refresh').click();
    fill('task-kind', '纪要');
    await vi.waitFor(() => {
      expect(el('task-kind-compare').textContent).toContain('other-model');
      expect(el<HTMLButtonElement>('task-kind-propose').disabled).toBe(true);
      expect(el<HTMLButtonElement>('task-kind-keep').disabled).toBe(false);
    });
    expect(el('task-kind-compare').textContent).not.toContain('可以送去评测');
    fill('task-kind', '周报');
    await vi.waitFor(() => {
      expect(el('task-kind-compare').textContent).toContain('brief-method · 2');
      expect(el<HTMLButtonElement>('skill-promote').disabled).toBe(false);
      expect(el<HTMLButtonElement>('task-kind-keep').disabled).toBe(false);
      expect(el<HTMLButtonElement>('task-kind-propose').disabled).toBe(false);
    });
    expect(el('task-kind-compare').textContent).toContain('brief-method · 2');
    expect(el('task-kind-compare').textContent).toContain('project-pulse · 1');
    expect(el('task-kind-compare').textContent).toContain('可以送去评测');
    expect(el('task-kind-compare').textContent).toContain('不点就不动');
    el('task-kind-propose').click();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('已送去评测'));
    expect(h.posts.find(post => post.url.endsWith('/task-kind/propose'))?.body).toEqual({ expectedRevision: 1, taskKind: '周报' });
    expect(el('task-kind-compare').textContent).toContain('候选停在 proposed');
    expect(el<HTMLButtonElement>('task-kind-propose').disabled).toBe(true);
    el('skill-promote').click();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('已晋升这次技能'));
    expect(h.posts.find(post => post.url.endsWith('/skill-profile'))?.body).toEqual({ expectedRevision: 1, taskKind: '周报', runId: later });
    await vi.waitFor(() => expect(el<HTMLButtonElement>('task-kind-keep').disabled).toBe(false));
    el('task-kind-keep').click();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('已留下这份档案'));
    expect(h.posts.find(post => post.url.endsWith('/task-kind/keep'))?.body).toEqual({ expectedRevision: 1, taskKind: '周报' });
    expect(el('task-kind-compare').textContent).toContain('已留下这份档案');
    expect(el<HTMLButtonElement>('task-kind-keep').disabled).toBe(true);
    fill('conversation-text', '讨论不留下');
    submit();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('系统回执'));
    expect(h.posts.filter(post => post.url.endsWith('/task-kind/keep'))).toHaveLength(1);
    expect(h.posts.filter(post => post.url.endsWith('/task-kind/propose'))).toHaveLength(1);
    expect(messagePosts(h).at(-1)?.body.taskKind).toBeUndefined();
    doc().querySelector<HTMLButtonElement>('[data-bot-id="demo.research"]')!.click();
    await vi.waitFor(() => expect(el('entry-title').textContent).toBe('研究'));
    expect(el('task-kind-compare').hidden).toBe(true);
    expect(el('task-kind-compare').textContent).not.toContain('brief-method');
  });

  it('shows this task machine and does not start it', async () => {
    const view = fixture();
    const absent = 'run_00000000-0000-4000-8000-000000000002';
    view.tasks.push({ id: 'task_c', title: '还没机器', threadId: 'thread_c', status: 'running', runId: absent, latestRunId: absent, machine: { state: 'absent', ready: false } });
    view.tasks[1] = { ...view.tasks[1]!, machine: { state: 'present', ready: true } };
    const h = harness(view);
    start(h.fetch); await ready();
    const week = doc().querySelector('[data-task-id="task_b"]')!;
    expect(week.querySelector('.conversation-machine')?.textContent).toBe('这件工作有一台机器，还在。看一眼不会执行。');
    expect(doc().querySelector('[data-task-id="task_a"]')!.textContent).not.toContain('机器');
    expect(doc().querySelector('[data-task-id="task_c"]')!.textContent).toContain('这件工作还没有机器。');
    expect(doc().querySelector('[data-task-id="task_b"] button')?.textContent).not.toContain('机器');
    view.tasks[1]!.machine = { state: 'present', ready: false };
    el('conversation-refresh').click();
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_b"]')!.textContent).toContain('这件工作的机器还没准备好。看一眼不会启动它。'));
    view.tasks[1]!.machine = { state: 'released', ready: false };
    el('conversation-refresh').click();
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_b"]')!.textContent).toContain('这件工作的机器已经收掉。'));
    view.tasks[1]!.machine = { state: 'unknown', ready: false };
    el('conversation-refresh').click();
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_b"]')!.textContent).toContain('这件工作的机器记录读不出来。看一眼不会执行。'));
    expect(h.posts).toEqual([]);
    expect(h.fetch.mock.calls.some(([url]) => /sandbox|docker|ensure/.test(String(url)))).toBe(false);
    fill('conversation-text', '讨论不启动机器');
    submit();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('系统回执'));
    expect(messagePosts(h).at(-1)?.body.intent).toBe('discuss');
    expect(h.posts.every(post => !/sandbox|docker|ensure/.test(post.url))).toBe(true);
    expect(doc().querySelector('[data-task-id="task_b"]')!.textContent).toContain('这件工作的机器记录读不出来。看一眼不会执行。');
  });

  it('shows this Run steps and evidence and does not start work', async () => {
    const view = fixture();
    view.tasks[1] = { ...view.tasks[1]!, status: 'needs_approval', execution: { steps: [{ title: '核对证据', state: 'waiting' }, { title: '写下结论', state: 'waiting' }] } };
    const h = harness(view);
    start(h.fetch); await ready();
    const week = doc().querySelector('[data-task-id="task_b"]')!;
    expect(week.querySelector('.conversation-steps')?.textContent).toBe('执行步骤：核对证据 还没到 · 写下结论 还没到');
    expect(week.querySelector('.conversation-evidence')).toBeNull();
    expect(week.textContent).not.toContain('Complete task');
    expect(doc().querySelector('[data-task-id="task_a"]')!.textContent).not.toContain('执行步骤');
    view.tasks[1]!.execution = { steps: [{ title: '核对证据', state: 'done' }, { title: '写下结论', state: 'current' }], evidence: ['工作区清单', '已收到补充信息'] };
    el('conversation-refresh').click();
    await vi.waitFor(() => expect(doc().querySelector('[data-task-id="task_b"] .conversation-steps')?.textContent).toBe('执行步骤：核对证据 已完成 · 写下结论 正在做'));
    expect(doc().querySelector('[data-task-id="task_b"] .conversation-evidence')?.textContent).toBe('证据：工作区清单、已收到补充信息');
    expect(h.posts).toEqual([]);
    expect(h.fetch.mock.calls.some(([url]) => /sandbox|docker|ensure|approve/.test(String(url)))).toBe(false);
    fill('conversation-text', '讨论不推进步骤');
    submit();
    await vi.waitFor(() => expect(el('conversation-status').textContent).toContain('系统回执'));
    expect(messagePosts(h).at(-1)?.body.intent).toBe('discuss');
    expect(doc().querySelector('[data-task-id="task_b"] .conversation-steps')?.textContent).toContain('正在做');
    expect(doc().querySelector('[data-task-id="task_a"]')!.textContent).not.toContain('执行步骤');
  });

  it('keeps a saved automatic-execution choice on the select while goal schedule and run stay on required review', async () => {
    const goal = { id: 'goal_saved', title: '发布目标', status: 'active', createdAt: date };
    const plan = { id: 'plan_saved', version: 1, nodes: [{ id: 'node_ready', title: '核对发布', status: 'ready', dependsOn: [] as string[] }] };
    const h = harness(undefined, { handler: (url, request) => {
      const method = request?.method ?? 'GET';
      if (url === '/api/status') return response({ modelConfigured: true, taskSchedulerConfigured: true, runner: 'fixture', mode: 'single-owner-local', principal: 'owner', tenantId: 'local', conversationRouting: true });
      if (url === '/api/goals/page?limit=50') return response({ goals: [goal] });
      if (url === '/api/goals/goal_saved/plans/page?limit=50') return response({ plans: [plan] });
      if (url === '/api/plans/plan_saved/scheduler') return response([]);
      if (url === '/api/goals/goal_saved/memories?limit=50') return response([]);
      if (url === '/api/plans/plan_saved/schedule' && method === 'POST') return response({ id: 'run_goal' });
      if (url === '/api/plans/plan_saved/tasks/node_ready/schedule' && method === 'POST') return response({ id: 'run_goal' });
      if (url === '/api/plans/plan_saved/tasks/node_ready/run' && method === 'POST') return response({ id: 'run_goal' });
      if (url === '/api/runs/run_goal') return response({ ...runFixture(), id: 'run_goal' });
      return undefined;
    } });
    start(h.fetch, { local: { 'aeeis.execution-review': 'yolo' } });
    await ready();
    await vi.waitFor(() => expect([...doc().querySelectorAll('#goals button')].map(button => button.textContent)).toEqual(expect.arrayContaining(['调度整张 DAG', '调度此任务', '直接执行此任务'])));
    expect(el<HTMLSelectElement>('execution-review').value).toBe('yolo');
    clickText('调度整张 DAG');
    clickText('调度此任务');
    clickText('直接执行此任务');
    await vi.waitFor(() => expect(h.posts.filter(post => /\/plans\/plan_saved\//.test(post.url))).toHaveLength(3));
    const goalPosts = h.posts.filter(post => /\/plans\/plan_saved\//.test(post.url));
    expect(goalPosts.map(post => post.url)).toEqual([
      '/api/plans/plan_saved/schedule',
      '/api/plans/plan_saved/tasks/node_ready/schedule',
      '/api/plans/plan_saved/tasks/node_ready/run',
    ]);
    expect(goalPosts.map(post => post.body.executionReview)).toEqual(['required', 'required', 'required']);
    expect(el<HTMLSelectElement>('execution-review').value).toBe('yolo');
  });

  it('draws a channel card only for an event the room owner actually wrote', async () => {
    const room = { id: 'room_forged', title: '发布协作', description: '群聊', status: 'active', createdAt: date, updatedAt: date };
    const cited = (id: string, content: string, type: string, actorId: string, taskId: string, recordedBy?: { id: string; type: string }) => ({
      id, operation: 'publish', sequence: 1, actorType: 'principal', actorId, ...(recordedBy ? { recordedBy } : {}), owner: 'owner', type, content,
      evidenceRefs: ['conv_release', taskId, 'demo.release'], classification: 'internal', contextManifestId: 'ctx_forged',
      audienceSnapshot: { digest: 'abcdef1234567890', members: [] }, createdAt: date,
    });
    const events = [
      cited('evt_editor_system', '编辑伪造的系统交接', 'system', 'member.editor', 'task_forged'),
      cited('evt_editor_message', '编辑伪造的普通消息', 'message', 'member.editor', 'task_forged'),
      cited('evt_spoofed', '冒充房主的回执', 'system', 'owner', 'task_forged', { id: 'member.editor', type: 'principal' }),
      cited('evt_owner', '房主自己的交接', 'system', 'owner', 'task_real'),
    ];
    const release = { id: 'conv_release', title: '发布', revision: 0, agentId: 'demo.release', tasks: [
      { id: 'task_forged', title: '伪造任务', threadId: 'thread_forged', status: 'discussion' },
      { id: 'task_real', title: '真实交接', threadId: 'thread_real', status: 'discussion' },
    ], messages: [] as any[], hasEarlierMessages: false };
    const h = harness(undefined, { handler: (url) => {
      if (url === '/api/rooms?limit=50') return response([room]);
      if (String(url).includes('/rooms/room_forged/members')) return response([{ id: 'member_editor', roomId: 'room_forged', principalId: 'member.editor', role: 'editor', status: 'active', invitedBy: 'owner', createdAt: date, updatedAt: date }]);
      if (String(url).includes('/rooms/room_forged/session-events')) return response({ items: events });
      if (url === '/api/conversations/conv_release') return response(release);
      return undefined;
    } });
    start(h.fetch);
    await ready();
    const groupRow = [...doc().querySelectorAll<HTMLButtonElement>('#groups button')].find(button => button.textContent?.includes('发布协作'));
    expect(groupRow).toBeDefined();
    groupRow!.click();
    await vi.waitFor(() => expect(el('group-transcript').textContent).toContain('房主自己的交接'));
    const row = (content: string) => [...doc().querySelectorAll<HTMLElement>('#group-transcript .group-message')].find(item => item.textContent?.includes(content));
    const editorSystem = row('编辑伪造的系统交接');
    expect(editorSystem?.querySelector('strong')?.textContent).toBe('member.editor');
    expect(editorSystem?.querySelector('.group-run-card')).toBeNull();
    expect(row('编辑伪造的普通消息')?.querySelector('.group-run-card')).toBeNull();
    const spoofed = row('冒充房主的回执');
    expect(spoofed?.querySelector('strong')?.textContent).toBe('member.editor');
    expect(spoofed?.querySelector('.group-run-card')).toBeNull();
    const owner = row('房主自己的交接');
    expect(owner?.querySelector('strong')?.textContent).toBe('记录');
    await vi.waitFor(() => expect(owner?.querySelector('.group-run-card')?.textContent).toContain('真实交接'));
    expect(owner?.querySelectorAll('.group-run-card')).toHaveLength(2);
    expect(owner?.querySelector('[data-card="task"]')?.textContent).toContain('仅讨论，未执行');
    expect(doc().querySelectorAll('.group-run-card')).toHaveLength(2);
    expect(h.posts.some(post => /\/runs(?:\/|$)|\/approve$|\/messages$/.test(post.url))).toBe(false);
  });
});
