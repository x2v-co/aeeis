import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { dialogueFixture, dialogueScope } from './support/bot-dialogues.js';

async function waitFor(check: () => boolean) {
  for (let i=0; i<100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  expect(check()).toBe(true);
}
async function browser(f: Awaited<ReturnType<typeof dialogueFixture>>, authenticated = true, savedPending?: string) {
  const html = await readFile('public/team/index.html', 'utf8'), source = await readFile('public/team/app.js', 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/team/', runScripts: 'outside-only', pretendToBeVisual: true });
  const requests: { path: string; body: string; key?: string }[] = [];
  let loseResponse = false;
  if (authenticated) dom.window.localStorage.setItem('aeeis.token', 'alice');
  if (savedPending) dom.window.sessionStorage.setItem('aeeis.team.pending', savedPending);
  dom.window.fetch = async (path, input: any) => {
    const url = String(path); requests.push({ path: url, body: input.body, key: input.headers['Idempotency-Key'] });
    const response = await f.app.inject({ method: input.method, url, headers: input.headers, ...(input.body === undefined ? {} : { payload: input.body }) });
    if (loseResponse && url.endsWith('/dialogue/messages')) { loseResponse = false; throw new Error('响应丢失'); }
    return { ok: response.statusCode < 400, status: response.statusCode, json: async () => response.json() } as Response;
  };
  dom.window.eval(source);
  return { dom, doc: dom.window.document, requests, loseNextResponse() { loseResponse = true; } };
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
      expect(b.doc.querySelector('[draggable="true"]')).toBeNull();
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
});
