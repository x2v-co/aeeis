import { describe, expect, it, vi } from 'vitest';
import { response, date, runId, ownedBot, harness, intervals, start, doc, el, ready, dom } from './support/conversations-ui.js';

describe('消息 list', () => {
  const at = (hour: number) => `2026-10-21T${String(hour).padStart(2, '0')}:00:00Z`;
  const team = { id: 'room_team', title: '发布协作', description: '群聊', chat: 'group', status: 'active', createdAt: date, updatedAt: date };
  const direct = { id: 'room_direct', title: '阿研私聊房', description: '私聊', chat: 'direct', status: 'active', createdAt: date, updatedAt: date };
  const side = { id: 'room_side', title: '阿研 ↔ AEEIS', description: '侧线程', status: 'active', createdAt: date, updatedAt: date };
  const ayan = () => ({ id: 'conv_ayan', title: '阿研', agentId: ownedBot.id, revision: 1, tasks: [{ id: 'task_r', title: '周报', threadId: 'thread_r', status: 'running', runId }], messages: [{ id: 'm1', role: 'notification', text: '简报到了：周报', createdAt: at(11), route }], hasEarlierMessages: false });
  const route = { status: 'general', reason: 'unassigned', taskIds: [], candidateTaskIds: [], focusEffect: 'keep' };
  const retired = { id: 'conv_retired', title: '老研', agentId: 'bot_retired01', revision: 3, tasks: [], messages: [{ id: 'r1', role: 'user', speaker: { role: 'agent', id: 'bot_retired01' }, text: '最后一句', createdAt: at(8), route }], hasEarlierMessages: false };
  /** Serves /api/chats from counts the test moves, and keeps what the page marked read. */
  function chatsHarness(status: Record<string, unknown> = {}) {
    const counts: Record<string, number> = { room_team: 150, conv_ayan: 3, conv_ayan_old: 1, conv_retired: 0 };
    const read: Record<string, number> = { room_team: 0, conv_ayan: 1, conv_ayan_old: 0, conv_retired: 0 };
    const chats = () => [
      { chatId: 'room_team', kind: 'group', backing: 'room', title: '发布协作', preview: '有人问进度', lastActivityAt: at(12) },
      { chatId: 'conv_ayan', kind: 'direct', backing: 'conversation', counterpart: ownedBot.id, title: '阿研', preview: '简报到了：周报', lastActivityAt: at(11) },
      { chatId: 'conv_ayan_old', kind: 'direct', backing: 'conversation', counterpart: ownedBot.id, title: '阿研', preview: '旧的', lastActivityAt: at(9) },
      { chatId: 'conv_retired', kind: 'direct', backing: 'conversation', counterpart: 'bot_retired01', title: '老研', preview: '最后一句', lastActivityAt: at(8) },
    ].map(item => ({ ...item, newCount: counts[item.chatId]!, unread: Math.max(0, counts[item.chatId]! - read[item.chatId]!) }));
    const member = (roomId: string, principalId: string) => ({ id: `m_${roomId}`, roomId, principalId, role: 'agent', status: 'active', invitedBy: 'owner', createdAt: date, updatedAt: date });
    const h = harness(undefined, { owned: true, handler: (url, request) => {
      if (url === '/api/status') return response({ modelConfigured: true, runner: 'fixture', mode: 'single-owner-local', principal: 'owner', tenantId: 'local', conversationRouting: true, ...status });
      if (url === '/api/chats') return response({ items: chats() });
      const readMatch = url.match(/^\/api\/chats\/([^/]+)\/read$/);
      if (readMatch) { const id = decodeURIComponent(readMatch[1]!); read[id] = Math.max(read[id] ?? 0, Math.min(JSON.parse(request.body).count, counts[id] ?? 0)); return response({ unread: (counts[id] ?? 0) - read[id]! }); }
      if (url === '/api/rooms') return response([team, direct, side]);
      if (url.startsWith('/api/rooms/room_direct/members')) return response([member('room_direct', ownedBot.id)]);
      if (url.startsWith('/api/rooms/room_team/members')) return response([member('room_team', ownedBot.id)]);
      if (url.startsWith('/api/rooms/room_side/members')) return response([member('room_side', ownedBot.id), member('room_side', 'aeeis')]);
      if (url.startsWith('/api/rooms/room_side/session-events')) return response({ items: [{ id: 'evt_side', sequence: 1, owner: 'owner', type: 'message', actorType: 'agent', actorId: ownedBot.id, content: '我先看数据再接。', evidenceRefs: [], createdAt: date }] });
      if (url.includes('/session-events')) return response({ items: [] });
      if (url === '/api/rooms/room_direct/dialogue') return response(ayan());
      if (url === `/api/bots/${ownedBot.id}/dialogue`) return response({ roomId: 'room_direct', conversationId: 'conv_ayan', revision: 1, bindingVersion: 2 });
      if (url === '/api/conversations' && request.method !== 'POST') return response([h.view, ayan(), retired]);
      if (url === '/api/conversations/conv_ayan') return response(ayan());
      if (url === '/api/conversations/conv_retired') return response(retired);
      if (url.startsWith('/api/routines')) return response({ routines: [{ id: 'routine_1', agentId: ownedBot.id, name: '早报', prompt: '汇总', executionReview: 'auto', status: 'active', revision: 1, trigger: { kind: 'schedule', calendar: { frequency: 'daily', timeZone: 'Asia/Shanghai', time: '09:00' } }, runOptions: { allowedTools: ['web-search@1'] }, webhookEnabled: false }] });
      return undefined;
    } });
    return { h, counts, read };
  }
  const rows = () => [...doc().querySelectorAll<HTMLButtonElement>('#chats .chat-row')];
  const names = () => rows().map(row => row.querySelector('strong')?.textContent);
  const row = (name: string) => rows().find(item => item.querySelector('strong')?.textContent === name)!;
  const badge = (name: string) => row(name)?.querySelector('.chat-unread')?.textContent ?? '';
  const noDemo = { local: { 'aeeis.demo-roster': '' } };

  it('is one list read from /api/chats, latest first, with unread counts, one row per Bot and no Bot rooms', async () => {
    const { h } = chatsHarness();
    start(h.fetch, noDemo);
    await ready();
    await vi.waitFor(() => expect(names()).toEqual(['发布协作', '阿研', '老研', 'AEEIS']));
    expect(el('bot-queue')).toBeNull();
    expect(el('group-queue')).toBeNull();
    expect(doc().querySelector('#chat-queue h2')?.textContent).toBe('消息');
    expect(badge('发布协作')).toBe('99+');
    expect(badge('阿研')).toBe('2');
    expect(badge('AEEIS')).toBe('');
    expect(row('阿研').textContent).toContain('简报到了：周报');
    expect(row('阿研').querySelector('.chat-tag')?.textContent).toBe('正在做 1 件');
    expect(doc().querySelectorAll(`#chats [data-bot-id="${ownedBot.id}"]`)).toHaveLength(1);
    // Bots carry the corner mark; a group chat does not.
    expect(row('阿研').querySelector('.chat-avatar[data-kind="bot"] .bot-corner')).not.toBeNull();
    expect(row('AEEIS').querySelector('.bot-corner')).not.toBeNull();
    expect(row('发布协作').querySelector('.bot-corner')).toBeNull();
    // The Bot's bound direct room and Bot-to-Bot side threads are neither in the list nor in 频道管理.
    expect(el('chats').textContent).not.toContain('阿研私聊房');
    expect(el('chats').textContent).not.toContain('阿研 ↔ AEEIS');
    await vi.waitFor(() => expect(el('channel-manager').textContent).toContain('发布协作'));
    expect(el('channel-manager').textContent).not.toContain('阿研私聊房');
    expect(el('chat-count').textContent).toBe('99+ 条未读');
    // Nothing is marked read for chats that are not open.
    expect(h.posts.filter(post => post.url.startsWith('/api/chats/'))).toEqual([]);
  });

  it('clears unread once a chat is open and read to the bottom, and it stays cleared after a refresh', async () => {
    const { h, counts } = chatsHarness();
    start(h.fetch, noDemo);
    await ready();
    await vi.waitFor(() => expect(badge('阿研')).toBe('2'));
    row('阿研').click();
    await vi.waitFor(() => expect(el('conversation-messages').textContent).toContain('简报到了：周报'));
    await vi.waitFor(() => expect(h.posts.find(post => post.url === '/api/chats/conv_ayan/read')?.body).toEqual({ count: 3 }));
    expect(badge('阿研')).toBe('');
    expect(badge('发布协作')).toBe('99+');
    intervals.find(item => item.ms === 2000)!.callback();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(badge('阿研')).toBe('');
    // A new line after the read counts again, and is read once the open chat shows it.
    counts.conv_ayan = 4;
    intervals.find(item => item.ms === 2000)!.callback();
    await vi.waitFor(() => expect(h.posts.filter(post => post.url === '/api/chats/conv_ayan/read').map(post => post.body.count)).toEqual([3, 4]));
    row('发布协作').click();
    await vi.waitFor(() => expect(h.posts.find(post => post.url === '/api/chats/room_team/read')?.body).toEqual({ count: 150 }));
    await vi.waitFor(() => expect(badge('发布协作')).toBe(''));
    // Read on another device: the next list shows it cleared here too.
    expect(badge('阿研')).toBe('');
  });

  it('waits for the bottom of the transcript before marking a chat read', async () => {
    const { h } = chatsHarness();
    start(h.fetch, { ...noDemo, setup: window => {
      // The transcript scrolls and is not at its end.
      Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.id === 'conversation-messages' ? 1000 : 0; } });
      Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.id === 'conversation-messages' ? 200 : 0; } });
    } });
    await ready();
    el('conversation-messages').style.overflowY = 'auto';
    await vi.waitFor(() => expect(badge('阿研')).toBe('2'));
    row('阿研').click();
    await vi.waitFor(() => expect(el('conversation-messages').textContent).toContain('简报到了：周报'));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(h.posts.some(post => post.url === '/api/chats/conv_ayan/read')).toBe(false);
    expect(badge('阿研')).toBe('2');
    el('conversation-messages').scrollTop = 800;
    el('conversation-messages').dispatchEvent(new dom.window.Event('scroll'));
    await vi.waitFor(() => expect(h.posts.find(post => post.url === '/api/chats/conv_ayan/read')?.body).toEqual({ count: 3 }));
  });

  it('keeps a retired Bot as read-only history, out of 新建', async () => {
    const { h } = chatsHarness();
    start(h.fetch, noDemo);
    await ready();
    await vi.waitFor(() => expect(names()).toContain('老研'));
    expect(row('老研').querySelector('.chat-tag')?.textContent).toBe('已撤下');
    expect(row('老研').dataset.retired).toBe('bot_retired01');
    el('gb-new-message').click();
    expect(el('new-chat-menu').hidden).toBe(false);
    const picks = [...doc().querySelectorAll<HTMLButtonElement>('#new-chat-bots [data-new-chat-bot]')].map(button => button.lastElementChild?.textContent);
    expect(picks).toEqual(['AEEIS', '阿研']);
    el('gb-new-message').click();
    row('老研').click();
    await vi.waitFor(() => expect(el('conversation-messages').textContent).toContain('最后一句'));
    expect(el('entry-title').textContent).toBe('老研');
    expect(el('entry-presence').textContent).toBe('已撤下 · 只读');
    expect(el('conversation-composer').hidden).toBe(true);
    expect(el('retired-note').hidden).toBe(false);
    expect(el<HTMLButtonElement>('conversation-send').disabled).toBe(true);
    expect(el('standing-instruction').hidden).toBe(true);
    expect(row('老研').getAttribute('aria-pressed')).toBe('true');
    expect(row('AEEIS').getAttribute('aria-pressed')).toBe('false');
    // Back to a live Bot, the composer returns.
    row('AEEIS').click();
    await vi.waitFor(() => expect(el('entry-title').textContent).toBe('AEEIS'));
    expect(el('conversation-composer').hidden).toBe(false);
    expect(el('retired-note').hidden).toBe(true);
  });

  it('picking a Bot under 新建 opens its conversation; picking people starts a group, never a direct room', async () => {
    const { h } = chatsHarness();
    start(h.fetch, noDemo);
    await ready();
    await vi.waitFor(() => expect(names()).toContain('阿研'));
    el('gb-new-message').click();
    doc().querySelector<HTMLButtonElement>(`#new-chat-bots [data-new-chat-bot="${ownedBot.id}"]`)!.click();
    expect(el('new-chat-menu').hidden).toBe(true);
    await vi.waitFor(() => expect(el('entry-title').textContent).toBe('阿研'));
    el('gb-new-message').click();
    el('gb-new-group').click();
    expect(el('new-chat-menu').hidden).toBe(true);
    expect(el('group-draft').hidden).toBe(false);
    expect(h.posts.some(post => post.url === '/api/rooms' && post.body.description === '私聊')).toBe(false);
  });

  it('opens an old link to a Bot\'s direct room as that Bot\'s conversation', async () => {
    const { h } = chatsHarness({ botDialogueRouting: true });
    start(h.fetch, { ...noDemo, path: '/#room=room_direct' });
    await vi.waitFor(() => expect(el('conversation-messages').textContent).toContain('简报到了：周报'));
    expect(el('entry-title').textContent).toBe('阿研');
    expect(el('group-panel').hidden).toBe(true);
    expect(row('阿研').getAttribute('aria-pressed')).toBe('true');
  });

  it('opens one profile page for a Bot and for you from an avatar', async () => {
    const { h } = chatsHarness({ botTeamConfigured: true, routinesConfigured: true });
    start(h.fetch, noDemo);
    await ready();
    await vi.waitFor(() => expect(names()).toContain('阿研'));
    const posts = h.posts.length;
    row('阿研').querySelector<HTMLElement>('.chat-avatar')!.click();
    expect(el('profile').hidden).toBe(false);
    expect(el('entry-title').textContent).not.toBe('阿研');
    expect(el('profile-name').textContent).toBe('阿研');
    expect(el('profile-kind').textContent).toBe(`Bot · ${ownedBot.id}`);
    expect(el('profile-avatar').querySelector('.bot-corner')).not.toBeNull();
    const sections = () => [...doc().querySelectorAll<HTMLElement>('#profile-sections [data-section]')];
    expect(sections().map(section => section.dataset.section)).toEqual(['role', 'autonomy', 'tools', 'routines', 'groups', 'side-threads']);
    expect(sections()[0]!.textContent).toContain('负责研究');
    expect(el<HTMLSelectElement>('profile-autonomy').value).toBe('quiet');
    await vi.waitFor(() => expect(sections()[3]!.textContent).toContain('早报 · 每天 09:00'));
    expect(sections()[2]!.textContent).toContain('web-search@1');
    await vi.waitFor(() => expect(sections()[4]!.textContent).toContain('发布协作'));
    const threads = sections()[5] as HTMLDetailsElement;
    expect(threads.tagName).toBe('DETAILS');
    expect(threads.open).toBe(false);
    threads.open = true;
    threads.dispatchEvent(new dom.window.Event('toggle'));
    await vi.waitFor(() => expect(threads.textContent).toContain('我先看数据再接。'));
    expect(h.posts.length).toBe(posts);
    // 发消息 opens its conversation.
    [...doc().querySelectorAll<HTMLButtonElement>('#profile-actions button')].find(button => button.textContent === '发消息')!.click();
    expect(el('profile').hidden).toBe(true);
    await vi.waitFor(() => expect(el('entry-title').textContent).toBe('阿研'));
    // The header avatar opens the same page.
    el('entry-avatar').click();
    expect(el('profile-name').textContent).toBe('阿研');
    doc().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(el('profile').hidden).toBe(true);
    // You: same page, your group chats.
    el('gb-me').click();
    expect(el('profile-name').textContent).toBe('你');
    expect(el('profile-kind').textContent).toBe('你 · owner');
    expect(el('profile-avatar').querySelector('.bot-corner')).toBeNull();
    expect(sections().map(section => section.dataset.section)).toEqual(['groups']);
    expect(sections()[0]!.textContent).toContain('发布协作');
    el('profile-close').click();
    // A retired Bot's profile has no way to message it, only its history.
    row('老研').querySelector<HTMLElement>('.chat-avatar')!.click();
    expect(el('profile-kind').textContent).toContain('已撤下');
    expect([...doc().querySelectorAll('#profile-actions button')].map(button => button.textContent)).toEqual(['看历史']);
  });
});
