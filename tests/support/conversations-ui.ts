/**
 * The page harness shared by the jsdom UI tests: the built app, a mock server, and DOM helpers.
 * Importing it registers the build (beforeAll) and window cleanup (afterEach) for the importing file.
 * The UI tests are split across files because one jsdom file holding them all ran past the worker's heap.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { projectChannelBoard, taskActionLine, type BoardConversationView } from '../../src/channel-task-action.js';

// slow on 2-core sg deploy host (5990ms observed at 0f59391).
vi.setConfig({ testTimeout: 15000 });

export let source: string, html: string, css: string;
export let dom: JSDOM;
beforeAll(async () => {
  source = (await build({ entryPoints: ['src/ui/app.ts'], bundle: true, format: 'iife', target: 'es2022', write: false })).outputFiles![0]!.text;
  [html, css] = await Promise.all([readFile('public/index.html', 'utf8'), readFile('public/style.css', 'utf8')]);
});
afterEach(() => dom?.window.close());
export const response = (data: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
export const date = '2026-10-21T10:00:00Z';
export const scope = JSON.stringify(['single-owner-local', 'local', 'owner']);
export const runId = 'run_00000000-0000-4000-8000-000000000001';
export const ownedBot = { id: 'bot_00000001', name: '阿研', mark: 'letter', color: '#176b45', background: '负责研究', role: '研究', autonomy: 'quiet' };
export function fixture(surface = 'entry') {
  return { ...(surface === 'bot' ? { agentId: ownedBot.id } : {}), id: 'conv_00000000-0000-4000-8000-000000000001', title: '项目讨论', revision: 1, focusTaskId: 'task_a' as string | undefined,
    tasks: [{ id: 'task_a', title: '发布方案', threadId: 'thread_a', status: 'discussion' }, { id: 'task_b', title: '周报', threadId: 'thread_b', status: 'succeeded', runId, latestRunId: runId }],
    messages: [] as any[], hasEarlierMessages: false };
}
export function runFixture() {
  return { id: runId, revision: 1, goal: '周报执行', status: 'succeeded', canEdit: true, workingMemoryEnabled: true, privacy: 'internal',
    plans: [{ version: 1, hash: 'plan-hash', summary: 'Plan', nodes: [{ id: 'node_report', title: '核对证据', dependsOn: [] }] }],
    steps: [{ taskId: 'node_report', status: 'succeeded' }], events: [], artifacts: [], calls: [], context: { sources: [] } };
}
export function harness(view = fixture(), options: { enabled?: boolean; model?: boolean; owned?: boolean; handler?: (url: string, options: any) => any } = {}) {
  const posts: Array<{ url: string; body: any; key: string; raw: string }> = [];
  const uiEvents: Array<{ name: string; roomId: string }> = [];
  const lives = new Map<string, any>();
  const conversationFor = (requestUrl: string) => {
    const match = String(requestUrl).match(/\/api\/conversations\/([^/?]+)/);
    if (!match) return undefined;
    const id = decodeURIComponent(match[1] ?? '');
    if (id === view.id) return view;
    return lives.get(id);
  };
  let principal = 'owner';
  const ownedBots: Array<Record<string, unknown>> = options.owned || view.agentId === ownedBot.id ? [{ ...ownedBot }] : [];
  const demoNames: Record<string, string> = { aeeis: 'AEEIS', 'demo.release': '发布', 'demo.research': '研究', 'demo.brief': '纪要' };
  const nameOf = (id: string) => demoNames[id] ?? String(ownedBots.find(bot => bot.id === id)?.name ?? id);
  const readHandler = async (path: string, init: Record<string, unknown>) => {
    const result = await options.handler?.(path, { headers: {}, ...init });
    return result === undefined ? undefined : JSON.parse(await result.text());
  };
  /** Stands in for the server's /board: the real projection over the events
   * and conversations this test's handler serves. */
  const mockBoard = async (roomId: string) => {
    const raw: Array<Record<string, any>> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const listed = await readHandler(`/api/rooms/${encodeURIComponent(roomId)}/session-events?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { method: 'GET' });
      const items = Array.isArray(listed) ? listed : listed?.items ?? [];
      for (const item of items) if (!raw.some(seen => seen.id === item.id)) raw.push(item);
      const next = Array.isArray(listed) ? undefined : listed?.nextCursor;
      if (!next || next === cursor) break;
      cursor = next;
    }
    const items = raw.map((event, index) => ({ sequence: index + 1, owner: principal, ...event }));
    const ids = new Set<string>();
    for (const event of items) for (const ref of event.evidenceRefs ?? []) if (String(ref).startsWith('conv_')) ids.add(String(ref));
    const conversations = new Map<string, BoardConversationView | undefined>();
    for (const id of ids) {
      const served = await readHandler(`/api/conversations/${id}`, { method: 'GET' }).catch(() => undefined);
      conversations.set(id, served && !served.error ? served : conversationFor(`/api/conversations/${id}`));
    }
    return projectChannelBoard(roomId, items, conversations, nameOf);
  };
  const fetch = vi.fn(async (url: string, request: any) => {
    // §18.2 counts change no state; `uiEvents` keeps them apart from the writes these tests guard.
    if (request.method === 'POST' && url === '/api/ui-events') uiEvents.push(JSON.parse(request.body));
    else if (request.method === 'POST') posts.push({ url, body: JSON.parse(request.body), raw: request.body, key: request.headers['Idempotency-Key'] });
    const boardRoom = String(url).match(/^\/api\/rooms\/([^/?]+)\/board$/)?.[1];
    if (boardRoom) return options.handler?.(url, request) ?? response(await mockBoard(decodeURIComponent(boardRoom)));
    const actionRoom = String(url).match(/^\/api\/rooms\/([^/?]+)\/task-actions$/)?.[1];
    if (actionRoom && request.method === 'POST') {
      const roomId = decodeURIComponent(actionRoom);
      const body = JSON.parse(request.body);
      const card = (await mockBoard(roomId)).cards.find(item => item.conversationId === body.conversationId && item.taskId === body.taskId);
      if (!card) return response({ error: '这件事不在这个频道的任务板上' }, 404);
      if (body.kind === 'claim' && card.decision.assigneeId) return response({ error: card.decision.assigneeId === body.agentId ? '已经领取这件事' : `${nameOf(card.decision.assigneeId)}已领取` }, 409);
      if (body.kind === 'accept' && card.status !== 'succeeded') return response({ error: '只有已成功的事可以验收' }, 409);
      const action = { schemaVersion: 'channel-task-action/1' as const, kind: body.kind, conversationId: body.conversationId, taskId: body.taskId, ...(body.kind === 'accept' && card.runId ? { acceptedRunId: card.runId } : {}), ...(body.agentId ? { agentId: body.agentId } : {}), ...(body.reason ? { reason: body.reason } : {}) };
      const event = await readHandler(`/api/rooms/${encodeURIComponent(roomId)}/session-events`, { method: 'POST', body: JSON.stringify({ goalId: body.goalId, type: 'task_update', content: taskActionLine(action, body.agentId ? nameOf(body.agentId) : undefined), contextManifestId: body.contextManifestId, idempotencyKey: body.idempotencyKey, evidenceRefs: [body.conversationId, body.taskId, ...(body.agentId ? [body.agentId] : [])], taskAction: action }) });
      return response({ event, board: await mockBoard(roomId) });
    }
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
    if (url.startsWith('/api/bots/') && url !== '/api/bots/background') {
      const id = decodeURIComponent(url.slice('/api/bots/'.length));
      if (request?.method === 'DELETE') {
        const type = request.headers?.['content-type'];
        if (typeof type === 'string' && type.includes('application/json') && (request.body === undefined || request.body === '')) return response({ error: 'Invalid HTTP request' }, 400);
        const index = ownedBots.findIndex(bot => bot.id === id);
        if (index >= 0) ownedBots.splice(index, 1);
        return response({ removed: true, id });
      }
      if (request?.method === 'PATCH') {
        const body = JSON.parse(request.body);
        const bot = ownedBots.find(item => item.id === id);
        if (!bot) return response({ error: '没有这位 Bot' }, 404);
        Object.assign(bot, body);
        return response(bot);
      }
    }
    if (url === '/api/bots' && request?.method === 'POST') {
      const body = JSON.parse(request.body);
      const existing = ownedBots.find(bot => bot.id === body.id);
      if (existing) return response(existing);
      const bot = { id: body.id ?? `bot_${String(ownedBots.length + 1).padStart(8, '0')}`, name: body.name, mark: body.mark ?? 'letter', color: body.color, background: body.background, ...(body.role ? { role: body.role } : {}) };
      ownedBots.push(bot);
      return response(bot);
    }
    if (url === '/api/bots') return response(ownedBots);
    if (url.includes('/page?')) return response({ items: [], goals: [] });
    return response([]);
  });
  return { view, fetch, posts, uiEvents, setPrincipal(value: string) { principal = value; } };
}
/** Interval callbacks the page registered; tests fire them by hand. */
export let intervals: Array<{ callback: () => void; ms: number }> = [];
export function start(fetch: any, saved: { local?: Record<string, string>; session?: Record<string, string>; setup?: (window: any) => void; path?: string } = {}) {
  dom = new JSDOM(html, { url: `http://localhost${saved.path ?? '/'}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const style = dom.window.document.createElement('style'); style.textContent = css; dom.window.document.head.append(style);
  if (!Object.prototype.hasOwnProperty.call(saved.local ?? {}, 'aeeis.demo-roster')) dom.window.localStorage.setItem('aeeis.demo-roster', '1');
  for (const [key, value] of Object.entries(saved.local ?? {})) {
    if (value === '') dom.window.localStorage.removeItem(key);
    else dom.window.localStorage.setItem(key, value);
  }
  for (const [key, value] of Object.entries(saved.session ?? {})) dom.window.sessionStorage.setItem(key, value);
  intervals = [];
  dom.window.fetch = fetch; dom.window.setInterval = ((callback: () => void, ms: number) => { intervals.push({ callback, ms }); return intervals.length; }) as any;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any;
  saved.setup?.(dom.window);
  dom.window.eval(source);
}
export const doc = () => dom.window.document;
export const el = <T extends HTMLElement = HTMLElement>(id: string) => doc().getElementById(id) as T;
export function fill(id: string, value: string) { const input = el<HTMLInputElement>(id); input.value = value; input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }
export function submit() { el('conversation-composer').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); }
export function clickText(text: string, root: ParentNode = doc()) { const control = [...root.querySelectorAll('button')].find(button => button.textContent === text); expect(control, text).toBeDefined(); control!.click(); }
export async function sendReady(label = '发送') { await vi.waitFor(() => { expect(el('conversation-send').textContent).toBe(label); expect(el<HTMLButtonElement>('conversation-send').disabled).toBe(false); }); }
export async function ready() { await vi.waitFor(() => expect(el('conversation-focus').textContent).toContain('发布方案')); }
export const messagePosts = (h: ReturnType<typeof harness>) => h.posts.filter(post => post.url.endsWith('/messages'));
