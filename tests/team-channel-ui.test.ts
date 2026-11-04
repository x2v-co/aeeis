import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { dialogueFixture, dialogueScope } from './support/bot-dialogues.js';

async function waitFor(check: () => boolean) {
  for (let i=0; i<100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  expect(check()).toBe(true);
}
async function browser(f: Awaited<ReturnType<typeof dialogueFixture>>, authenticated: boolean | string = true, savedPending?: string) {
  const html = await readFile('public/team/index.html', 'utf8'), source = await readFile('public/team/app.js', 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/team/', runScripts: 'outside-only', pretendToBeVisual: true });
  const requests: { path: string; body: string; key?: string }[] = [];
  let loseResponse = false, loseBoard = false;
  if (authenticated) dom.window.localStorage.setItem('aeeis.token', typeof authenticated === 'string' ? authenticated : 'alice');
  if (savedPending) dom.window.sessionStorage.setItem('aeeis.team.pending', savedPending);
  dom.window.fetch = async (path, input: any) => {
    const url = String(path); requests.push({ path: url, body: input.body, key: input.headers['Idempotency-Key'] });
    const response = await f.app.inject({ method: input.method, url, headers: input.headers, ...(input.body === undefined ? {} : { payload: input.body }) });
    if (loseBoard && url.endsWith('/board-controls')) { loseBoard = false; throw new Error('移动响应丢失'); }
    if (loseResponse && url.endsWith('/dialogue/messages')) { loseResponse = false; throw new Error('响应丢失'); }
    return { ok: response.statusCode < 400, status: response.statusCode, json: async () => response.json() } as Response;
  };
  dom.window.eval(source);
  return { dom, doc: dom.window.document, requests, loseNextResponse() { loseResponse = true; }, loseNextBoardResponse() { loseBoard = true; } };
}

describe('multi-bot professional API view', () => {
  it('serves the real workspace shell beside the homepage; unauthenticated users see connection state', async () => {
    const f = await dialogueFixture(); const b = await browser(f, false);
    try {
      const page = await f.app.inject({ method: 'GET', url: '/team/' }); expect(page.statusCode).toBe(200); expect(page.body).toContain('多 Bot 工作室');
      expect(page.body).toContain('href="/"'); expect(page.body).not.toContain('刷新会重置');
      expect((await f.app.inject({ method: 'GET', url: '/team/app.js' })).statusCode).toBe(200);
      expect((await f.app.inject({ method: 'GET', url: '/team/styles.css' })).statusCode).toBe(200);
      await waitFor(() => b.doc.getElementById('connection')!.textContent!.includes('未连接或无权'));
      expect(b.doc.querySelectorAll('[data-bot]')).toHaveLength(0);
      expect(b.doc.body.textContent).not.toContain('客户反馈'); expect(b.doc.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(true);
      expect(b.requests.every(request => !request.path.includes('token='))).toBe(true);
    } finally { b.dom.window.close(); await f.close(); }
  });
  it('shows homepage messages, sends to the same Conversation, approves the same Run and saves real artifact drafts', async () => {
    const f = await dialogueFixture();
    const home = await f.conversations.create({ agentId: f.bot.id, title: f.bot.name }, dialogueScope);
    await f.conversations.post(home.id, { text: '主页的消息', expectedRevision: home.revision, unassigned: true }, dialogueScope, 'homepage', false);
    const b = await browser(f);
    try {
      await waitFor(() => Boolean(b.doc.querySelector(`[data-bot="${f.bot.id}"]`)));
      b.doc.querySelector<HTMLButtonElement>(`[data-bot="${f.bot.id}"]`)!.click();
      await waitFor(() => b.doc.querySelector('#stream')!.textContent!.includes('主页的消息'));
      const input = b.doc.querySelector<HTMLTextAreaElement>('#composerInput')!;
      input.value = '工作室发送的任务'; b.doc.querySelector<HTMLSelectElement>('#intent')!.value = 'execute';
      b.doc.querySelector<HTMLFormElement>('#composerForm')!.dispatchEvent(new b.dom.window.Event('submit', { cancelable: true }));
      await waitFor(() => b.doc.querySelector('#stream')!.textContent!.includes('工作室发送的任务'));
      const run = (await f.runs.list(dialogueScope))[0]!; await f.engine.advance(run.id);
      b.doc.querySelector<HTMLButtonElement>('#refresh')!.click();
      await waitFor(() => !b.doc.querySelector<HTMLButtonElement>('#openBoard')!.disabled);
      b.doc.querySelector<HTMLButtonElement>('#openBoard')!.click();
      await waitFor(() => Boolean(b.doc.querySelector('[data-task]')));
      b.doc.querySelector<HTMLButtonElement>('[data-task]')!.click();
      await waitFor(() => [...b.doc.querySelectorAll('button')].some(node => node.textContent === '批准并执行'));
      [...b.doc.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === '批准并执行')!.click();
      await waitFor(() => b.requests.some(request => request.path === `/api/runs/${run.id}/approve`));
      await waitFor(() => b.doc.querySelector('#taskDetail')!.textContent!.includes('running'));
      expect((await f.runs.get(run.id, dialogueScope)).approval?.approved).toBe(true);
      const canonical = await f.conversations.get(home.id, dialogueScope); expect(canonical.tasks[0]?.runId).toBe(run.id); expect(canonical.messages).toHaveLength(2);
      b.doc.querySelector<HTMLButtonElement>('#openArtifacts')!.click();
      await waitFor(() => Boolean(b.doc.querySelector('[aria-label="产物标题"]')));
      b.doc.querySelector<HTMLInputElement>('[aria-label="产物标题"]')!.value = '老板摘要'; b.doc.querySelector<HTMLTextAreaElement>('[aria-label="产物正文"]')!.value = '服务端持久草稿';
      [...b.doc.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === '保存到对话')!.click();
      await waitFor(() => b.doc.querySelector('#artifacts')!.textContent!.includes('服务端持久草稿'));
      expect((await f.aggregates.get(home.id, dialogueScope)).messages.some(message => message.source?.kind === 'artifact' && message.text === '服务端持久草稿')).toBe(true);
      expect(b.doc.querySelector('[draggable="true"]')).not.toBeNull();
    } finally { b.dom.window.close(); await f.close(); }
  });
  it('retries an unknown send outcome with the original request and opens only one Run', async () => {
    const f = await dialogueFixture(); let b = await browser(f);
    try {
      await waitFor(() => Boolean(b.doc.querySelector(`[data-bot="${f.bot.id}"]`))); b.doc.querySelector<HTMLButtonElement>(`[data-bot="${f.bot.id}"]`)!.click();
      await waitFor(() => !b.doc.querySelector<HTMLTextAreaElement>('#composerInput')!.disabled);
      b.doc.querySelector<HTMLTextAreaElement>('#composerInput')!.value = '只开一次执行'; b.doc.querySelector<HTMLSelectElement>('#intent')!.value = 'execute'; b.loseNextResponse();
      b.doc.querySelector<HTMLFormElement>('#composerForm')!.dispatchEvent(new b.dom.window.Event('submit', { cancelable: true }));
      await waitFor(() => !b.doc.querySelector<HTMLButtonElement>('#retry')!.hidden); await waitFor(() => b.doc.querySelector('#error')!.textContent!.includes('响应丢失'));
      const originalRequests = [...b.requests];
      const snapshot = b.dom.window.sessionStorage.getItem('aeeis.team.pending')!; expect(snapshot).toBeTruthy(); b.dom.window.close();
      b = await browser(f, true, snapshot);
      await waitFor(() => !b.doc.querySelector<HTMLButtonElement>('#retry')!.hidden && b.doc.querySelector('#connection')!.textContent!.includes('已连接'));
      await waitFor(() => !b.doc.querySelector<HTMLButtonElement>('#refresh')!.disabled);
      b.doc.querySelector<HTMLButtonElement>('#retry')!.click(); await waitFor(() => b.doc.querySelector<HTMLButtonElement>('#retry')!.hidden);
      const sends = [...originalRequests, ...b.requests].filter(request => request.path.endsWith('/dialogue/messages')); expect(sends).toHaveLength(2); expect(sends[0]).toEqual(sends[1]); expect(await f.runs.list(dialogueScope)).toHaveLength(1);
    } finally { b.dom.window.close(); await f.close(); }
  });
  it('moves with keyboard menu, mouse and touch against the real API, rolls back rejection and replays lost responses', async () => {
    const f = await dialogueFixture(); const binding = await f.ensure();
    const before = await f.conversations.get(binding.conversationId,dialogueScope);
    const created = await f.request(`/conversations/${binding.conversationId}/messages`,{ text: '整理待办',intent: 'discuss',newTask: { title: '待办报告' },expectedRevision: before.revision },'board-fixture');
    expect(created.statusCode,created.body).toBe(200);
    const b = await browser(f);
    const current = async () => (await f.request(`/rooms/${binding.roomId}/board`)).json().cards[0];
    try {
      await waitFor(() => Boolean(b.doc.querySelector(`[data-bot="${f.bot.id}"]`))); b.doc.querySelector<HTMLButtonElement>(`[data-bot="${f.bot.id}"]`)!.click();
      await waitFor(() => !b.doc.querySelector<HTMLButtonElement>('#openBoard')!.disabled); b.doc.querySelector<HTMLButtonElement>('#openBoard')!.click();
      await waitFor(() => Boolean(b.doc.querySelector('[data-move-task]')));
      const select = b.doc.querySelector<HTMLSelectElement>('[data-move-task]')!; select.focus(); select.value = 'doing';
      select.dispatchEvent(new b.dom.window.Event('change',{ bubbles: true }));
      await waitFor(() => Boolean(b.doc.querySelector('[data-column="doing"] [data-task]')));
      await waitFor(() => !b.doc.querySelector<HTMLButtonElement>('#refresh')!.disabled);
      expect(await current()).toMatchObject({ status: 'discussion',column: 'doing',version: 1 }); expect(await f.runs.list(dialogueScope)).toHaveLength(0);
      const card = b.doc.querySelector('[data-task]')!; card.dispatchEvent(new b.dom.window.Event('dragstart',{ bubbles: true }));
      b.doc.querySelector('[data-column="ready"]')!.dispatchEvent(new b.dom.window.Event('drop',{ bubbles: true,cancelable: true }));
      await waitFor(() => Boolean(b.doc.querySelector('[data-column="ready"] [data-task]'))); await waitFor(() => !b.doc.querySelector<HTMLButtonElement>('#refresh')!.disabled);
      const handle = b.doc.querySelector('[aria-label="拖动 待办报告"]')!;
      Object.defineProperty(b.doc,'elementFromPoint',{ configurable: true,value: () => b.doc.querySelector('[data-column="blocked"]') });
      const pointer = (type: string,x: number) => { const event = new b.dom.window.MouseEvent(type,{ clientX: x,clientY: 1,bubbles: true }); Object.defineProperty(event,'pointerType',{ value: 'touch' }); return event; };
      handle.dispatchEvent(pointer('pointerdown',1)); handle.dispatchEvent(pointer('pointerup',50));
      await waitFor(() => Boolean(b.doc.querySelector('[data-column="blocked"] [data-task]'))); await waitFor(() => !b.doc.querySelector<HTMLButtonElement>('#refresh')!.disabled);
      expect((await current()).column).toBe('blocked');
      const invalid = b.doc.querySelector<HTMLSelectElement>('[data-move-task]')!; invalid.value = 'done'; invalid.dispatchEvent(new b.dom.window.Event('change'));
      await waitFor(() => b.doc.querySelector('#error')!.textContent!.includes('只有当前 Run 成功'));
      expect(b.doc.querySelector('[data-column="blocked"] [data-task]')).not.toBeNull(); expect((await current()).column).toBe('blocked');
      await waitFor(() => !b.doc.querySelector<HTMLButtonElement>('#refresh')!.disabled);
      b.loseNextBoardResponse(); const lost = b.doc.querySelector<HTMLSelectElement>('[data-move-task]')!; lost.value = 'doing'; lost.dispatchEvent(new b.dom.window.Event('change'));
      await waitFor(() => b.doc.querySelector('#error')!.textContent!.includes('移动响应丢失')); await waitFor(() => !b.doc.querySelector<HTMLButtonElement>('#refresh')!.disabled);
      const retry = [...b.doc.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === '用原请求确认上次移动')!; expect(retry).toBeTruthy(); retry.click();
      await waitFor(() => !b.dom.window.sessionStorage.getItem('aeeis.team.board-pending'));
      const writes = b.requests.filter(request => request.path.endsWith('/board-controls'));
      expect(writes.at(-1)?.body).toBe(writes.at(-2)?.body); expect((await current()).version).toBe(4);
      b.doc.querySelector<HTMLButtonElement>('#refresh')!.click(); await waitFor(() => Boolean(b.doc.querySelector('[data-column="doing"] [data-task]')));
      const home = (await f.request(`/conversations/${binding.conversationId}`)).json(); expect(home.tasks[0]).toMatchObject({ column: 'doing',status: 'discussion' });
    } finally { b.dom.window.close(); await f.close(); }
  });

});

describe('professional channel management', () => {
  it('creates, detects stale edits, renames, archives and restores the exact Room shared with the homepage', async () => {
    const f = await dialogueFixture(), b = await browser(f);
    const clickText = (text: string) => [...b.doc.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!.click();
    const submit = () => b.doc.querySelector<HTMLFormElement>('#channelEditor')!.dispatchEvent(new b.dom.window.Event('submit', { cancelable: true }));
    try {
      await waitFor(() => !b.doc.querySelector<HTMLButtonElement>('#newChannel')!.disabled);
      expect(b.doc.querySelector('#rooms')!.textContent).toContain('还没有频道');
      b.doc.querySelector<HTMLButtonElement>('#newChannel')!.click();
      await waitFor(() => !b.doc.querySelector<HTMLFormElement>('#channelEditor')!.hidden);
      b.doc.querySelector<HTMLInputElement>('#channelTitle')!.value = '产品 A'; b.doc.querySelector<HTMLSelectElement>('#channelCategory')!.value = 'product';
      b.doc.querySelector<HTMLInputElement>('#channelTopic')!.value = '发布主题'; submit();
      await waitFor(() => Boolean(b.doc.querySelector('[data-room]')) && b.doc.querySelector<HTMLFormElement>('#channelEditor')!.hidden);
      const room = (await f.request('/rooms')).json()[0];
      expect(room).toMatchObject({ title: '产品 A', category: 'product', chat: 'group', topicRef: '发布主题', revision: 0 });
      clickText('改名 / 分类'); await waitFor(() => !b.doc.querySelector<HTMLFormElement>('#channelEditor')!.hidden);
      await f.domain.updateRoom(room.id, { title: '主页已改名', expectedRevision: 0 }, undefined, 'alice', 'team-a');
      b.doc.querySelector<HTMLInputElement>('#channelTitle')!.value = '过期覆盖'; submit();
      await waitFor(() => b.doc.querySelector('#error')!.textContent!.includes('版本冲突'));
      expect((await f.request(`/rooms/${room.id}`)).json().title).toBe('主页已改名');
      b.doc.querySelector<HTMLButtonElement>('#cancelChannelEdit')!.click(); clickText('改名 / 分类');
      await waitFor(() => !b.doc.querySelector<HTMLFormElement>('#channelEditor')!.hidden);
      b.doc.querySelector<HTMLInputElement>('#channelTitle')!.value = '主题 B'; b.doc.querySelector<HTMLSelectElement>('#channelCategory')!.value = 'topic'; submit();
      await waitFor(() => b.doc.querySelector<HTMLFormElement>('#channelEditor')!.hidden);
      expect((await f.request(`/rooms/${room.id}`)).json()).toMatchObject({ title: '主题 B', category: 'topic', revision: 2 });
      clickText('归档频道'); await waitFor(() => b.doc.querySelector('#rooms')!.textContent!.includes('还没有频道'));
      expect(b.doc.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(true);
      const filter = b.doc.querySelector<HTMLInputElement>('#showArchived')!; filter.checked = true; filter.dispatchEvent(new b.dom.window.Event('change'));
      expect(b.doc.querySelector(`[data-room="${room.id}"]`)!.textContent).toContain('归档');
      clickText('恢复频道'); await waitFor(() => b.doc.querySelector('#rooms')!.textContent!.includes('没有归档频道'));
      expect((await f.request(`/rooms/${room.id}`)).json()).toMatchObject({ id: room.id, status: 'active', title: '主题 B', revision: 4 });
      expect((await f.request('/rooms')).json()).toHaveLength(1);
    } finally { b.dom.window.close(); await f.close(); }
  });

  it('archives a newly created channel when adding a member fails and shows permission feedback to viewers', async () => {
    const f = await dialogueFixture(), b = await browser(f);
    try {
      await waitFor(() => !b.doc.querySelector<HTMLButtonElement>('#newChannel')!.disabled);
      b.doc.querySelector<HTMLButtonElement>('#newChannel')!.click(); await waitFor(() => !b.doc.querySelector<HTMLFormElement>('#channelEditor')!.hidden);
      b.doc.querySelector<HTMLInputElement>('#channelTitle')!.value = '成员失败补偿'; b.doc.querySelector<HTMLInputElement>('#channelMembers')!.value = 'alice';
      b.doc.querySelector<HTMLFormElement>('#channelEditor')!.dispatchEvent(new b.dom.window.Event('submit', { cancelable: true }));
      await waitFor(() => b.doc.querySelector('#error')!.textContent!.includes('成员添加失败'));
      const archived = (await f.request('/rooms')).json()[0]; expect(archived.status).toBe('archived');
      await f.domain.updateRoom(archived.id, { status: 'active', expectedRevision: 1 }, undefined, 'alice', 'team-a');
      await f.domain.addRoomMember(archived.id, 'bob', 'viewer', 'alice', 'team-a');
      const viewer = await browser(f, 'bob');
      try {
        await waitFor(() => Boolean(viewer.doc.querySelector('[data-room]')));
        viewer.doc.querySelector<HTMLButtonElement>('[data-room]')!.click();
        await waitFor(() => viewer.doc.querySelector('#channelManagement')!.textContent!.includes('viewer'));
        expect(viewer.doc.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(true);
        expect(viewer.doc.querySelector('#channelManagement')!.textContent).not.toContain('归档频道');
        expect(viewer.doc.querySelector('#channelManagement')!.textContent).not.toContain('改名 / 分类');
      } finally { viewer.dom.window.close(); }
    } finally { b.dom.window.close(); await f.close(); }
  });
});
