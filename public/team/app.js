/* Professional view over the same authenticated Conversation / Room / Run APIs as the homepage. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const button = (text, work) => { const node = element('button', text); node.type = 'button'; node.onclick = () => perform(work); return node; };
  let status, bots = [], rooms = [], selected, view, board, busy = false, pending, epoch = 0, refreshing = false;
  const tasks = new Map();
  const columns = { capture: '收下', ready: '待领取', doing: '进行中', blocked: '等你决定 / 阻塞', review: '待验收', done: '完成', failed: '失败 / 取消 / 不可读' };
  const pendingKey = 'aeeis.team.pending';
  function rememberPending() {
    if (pending && status && selected) sessionStorage.setItem(pendingKey, JSON.stringify({ principal: status.principal, tenantId: status.tenantId, room: selected, request: pending }));
    else sessionStorage.removeItem(pendingKey);
  }
  function token() {
    const raw = localStorage.getItem('aeeis.token') ?? sessionStorage.getItem('aeeis.token') ?? '';
    const clean = raw.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim().replace(/^bearer\s+/i, '').replace(/^(["'“‘「])(.*)(["'”’」])$/, '$2').trim();
    if (!/^[\x21-\x7E]*$/.test(clean)) throw new Error('登录令牌格式无效，请回主页重新连接。');
    return clean;
  }
  async function api(path, body, key) {
    const headers = { Accept: 'application/json' }, access = token();
    if (access) headers.Authorization = `Bearer ${access}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) { $('connection').textContent = '未连接或无权访问，请回主页确认登录与权限。'; }
      if (response.status === 401) { status = undefined; selected = undefined; view = undefined; pending = undefined; $('stream').replaceChildren(element('p', '登录已失效，请回主页重新连接。')); $('board').hidden = true; $('taskDetail').hidden = true; $('artifacts').hidden = true; }
      const error = new Error(data.error || `请求失败 (${response.status})`); error.status = response.status; throw error;
    }
    return data;
  }
  async function perform(work) {
    if (busy) return;
    busy = true; $('error').textContent = ''; controls();
    try { await work(); } catch (error) { $('error').textContent = error.message || String(error); }
    finally { busy = false; controls(); }
  }
  function controls() {
    const active = Boolean(status && selected && view && !selected.legacyReadOnly && selected.status !== 'archived');
    $('send').disabled = busy || !active || Boolean(pending);
    $('composerInput').disabled = busy || !active || Boolean(pending);
    $('intent').disabled = busy || !selected?.direct;
    $('intentLabel').hidden = !selected?.direct;
    $('retry').hidden = !pending;
    for (const id of ['openBoard', 'refresh', 'openArtifacts']) $(id).disabled = busy || !selected;
    $('openArtifacts').disabled = busy || !selected || Boolean(selected.legacyReadOnly);
  }
  function navigation() {
    $('bots').replaceChildren(...bots.map(bot => {
      const node = button(bot.name, () => openBot(bot.id)); node.dataset.bot = bot.id;
      if (selected?.botId === bot.id) node.setAttribute('aria-current', 'page'); return node;
    }));
    $('rooms').replaceChildren(...rooms.map(room => {
      const node = button(`${room.chat === 'direct' ? '私聊 · ' : '# '}${room.title}${room.status === 'archived' ? '（归档）' : ''}`, () => openRoom(room));
      node.dataset.room = room.id; if (selected?.id === room.id) node.setAttribute('aria-current', 'page'); return node;
    }));
    if (!rooms.length) $('rooms').append(element('p', '还没有频道。', 'muted'));
  }
  async function connect() {
    $('connection').textContent = '正在连接…';
    const current = await api('/status');
    const [roster, roomList] = await Promise.all([api('/bots'), api('/rooms')]);
    // A changed principal discards the previous view and unresolved local request.
    if (status && (status.principal !== current.principal || status.tenantId !== current.tenantId)) { selected = undefined; view = undefined; pending = undefined; $('stream').replaceChildren(); }
    status = current;
    bots = [{ id: 'aeeis', name: 'AEEIS' }, ...roster.filter(bot => !bot.retiredAt)]; rooms = roomList;
    $('connection').textContent = `已连接 · ${status.principal} · ${status.tenantId}${status.modelConfigured ? '' : ' · 模型未配置'}`;
    if (!selected && !pending) {
      let saved;
      try { saved = JSON.parse(sessionStorage.getItem(pendingKey) || 'null'); } catch { sessionStorage.removeItem(pendingKey); }
      if (saved?.principal === status.principal && saved?.tenantId === status.tenantId && saved.room?.id && typeof saved.request?.key === 'string' && saved.request.body
        && saved.request.path === `/rooms/${encodeURIComponent(saved.room.id)}/${saved.room.direct ? 'dialogue/messages' : 'session-events'}`) {
        const room = await api(`/rooms/${encodeURIComponent(saved.room.id)}`);
        select({ ...room, direct: saved.room.direct, botId: saved.room.botId }); pending = saved.request;
        $('composerInput').value = pending.body.text || pending.body.content || '';
      }
    }
    navigation(); controls();
    const linked = new URLSearchParams(location.search).get('room');
    if (!selected && linked) { const room = rooms.find(item => item.id === linked); if (room) await openRoom(room); }
    if (selected) await refresh();
  }
  function select(room) {
    epoch++; selected = room; view = undefined; board = undefined; tasks.clear();
    $('channelHead').replaceChildren(element('h1', room.title), element('small', room.direct ? '只有你与这位 Bot · 与主页共用对话' : '真实频道 · 服务端消息'));
    $('stream').replaceChildren(element('p', '正在读取…')); $('board').hidden = true; $('artifacts').hidden = true; $('taskDetail').hidden = true;
    $('content').hidden = false; $('composerInput').value = ''; navigation(); controls();
  }
  async function openBot(botId) {
    if (pending) throw new Error('上一条消息的结果尚未确认，请先用同一请求重试。');
    const binding = await api(`/bots/${encodeURIComponent(botId)}/dialogue`, {});
    const bot = bots.find(item => item.id === botId);
    const room = await api(`/rooms/${encodeURIComponent(binding.roomId)}`);
    select({ ...room, title: bot?.name || room.title, direct: true, botId });
    await refresh();
  }
  async function openRoom(room) {
    if (pending) throw new Error('上一条消息的结果尚未确认，请先用同一请求重试。');
    const direct = room.chat === 'direct' || !room.chat && room.description === '私聊';
    select({ ...room, direct }); await refresh();
  }
  async function refresh() {
    if (!selected) return;
    const current = selected, version = epoch;
    if (current.direct) {
      let loaded;
      try { loaded = await api(`/rooms/${encodeURIComponent(current.id)}/dialogue`); }
      catch (error) { if (error.status === 409) { await readLegacy(current, version); return; } throw error; }
      if (loaded.bindingPhase && loaded.bindingPhase !== 'ready') { await readLegacy(current, version); return; }
      if (epoch !== version) return;
      selected.legacyReadOnly = false; view = loaded; selected.botId = loaded.agentId; renderMessages(loaded.messages);
      tasks.clear(); for (const task of loaded.tasks) tasks.set(task.id, { ...task, conversationId: loaded.id });
    } else {
      const [events, loadedBoard] = await Promise.all([api(`/rooms/${encodeURIComponent(current.id)}/session-events?limit=100&latest=true`), api(`/rooms/${encodeURIComponent(current.id)}/board`)]);
      if (epoch !== version) return;
      view = events; board = loadedBoard; renderMessages(events.items);
      tasks.clear(); for (const task of loadedBoard.cards) tasks.set(`${task.conversationId}:${task.taskId}`, { ...task, id: task.taskId });
    }
    navigation();
    if (!$('board').hidden) renderBoard();
    if (!$('taskDetail').hidden && $('taskDetail').dataset.run) await showRun($('taskDetail').dataset.run);
    controls();
  }
  async function readLegacy(current, version) {
    const history = await api(`/rooms/${encodeURIComponent(current.id)}/session-events?limit=100&latest=true`);
    if (epoch !== version) return;
    selected.legacyReadOnly = true; view = history; tasks.clear(); renderMessages(history.items);
    $('composerRoute').textContent = '此私聊历史正在整理或存在身份冲突，当前显示原始审计记录，只读。';
    if (!$('board').hidden) renderBoard(); controls();
  }
  function renderMessages(messages) {
    const nodes = [];
    const earlier = selected.direct && !selected.legacyReadOnly ? view.hasEarlierMessages : view.previousCursor;
    if (earlier) nodes.push(button('读取更早消息', loadEarlier));
    for (const message of messages) {
      const row = element('article', undefined, 'message'); row.dataset.message = message.id;
      const actor = message.speaker?.id ?? message.actorId ?? status.principal;
      row.append(element('strong', bots.find(bot => bot.id === actor)?.name ?? actor), element('small', ` · ${message.createdAt || ''}`), element('p', message.text ?? message.content));
      if (message.source?.kind === 'room') row.append(element('small', `历史来源 ${message.source.roomId} / ${message.source.eventId}`));
      if (message.source?.kind === 'room') for (const ref of message.source.evidenceRefs || []) if (/^run_[a-f0-9-]{36}$/.test(ref)) row.append(button('查看历史 Run', async () => { $('taskDetail').hidden = false; $('taskDetail').dataset.run = ref; delete $('taskDetail').dataset.version; await showRun(ref); }));
      if (message.source?.kind === 'channel') row.append(element('small', `频道来源 ${message.source.externalEventId}`));
      if (message.reply?.text) row.append(element('p', message.reply.text));
      nodes.push(row);
    }
    if (!messages.length) nodes.push(element('p', '还没有消息。发送后会保存在服务端。', 'muted'));
    $('stream').replaceChildren(...nodes);
  }
  async function loadEarlier() {
    if (selected.direct && !selected.legacyReadOnly) {
      const page = await api(`/rooms/${encodeURIComponent(selected.id)}/dialogue?before=${encodeURIComponent(view.messages[0].id)}`);
      view = { ...view, messages: [...page.messages, ...view.messages], hasEarlierMessages: page.hasEarlierMessages };
    } else {
      const page = await api(`/rooms/${encodeURIComponent(selected.id)}/session-events?limit=100&before=${encodeURIComponent(view.previousCursor)}`);
      view = { ...view, items: [...page.items, ...view.items], previousCursor: page.previousCursor };
    }
    renderMessages(selected.direct && !selected.legacyReadOnly ? view.messages : view.items);
  }
  async function sendMessage() {
    const text = $('composerInput').value.trim(); if (!text || !selected) return;
    if (selected.direct) {
      const execute = $('intent').value === 'execute';
      pending = { path: `/rooms/${encodeURIComponent(selected.id)}/dialogue/messages`, key: crypto.randomUUID(),
        body: { text, expectedRevision: view.revision, intent: execute ? 'execute' : 'discuss', ...(execute ? { newTask: { title: text.slice(0, 80).padEnd(2, '。') }, runOptions: { executionReview: 'required' } } : { unassigned: true }) } };
    } else {
      const goals = await api(`/rooms/${encodeURIComponent(selected.id)}/goals`);
      const goal = goals.find(item => item.status === 'active') || goals[0] || await api('/goals', { title: selected.title, roomId: selected.id });
      const manifest = await api(`/goals/${encodeURIComponent(goal.id)}/context-manifests`, { purpose: '频道消息', audienceMode: 'room' });
      const key = crypto.randomUUID();
      pending = { path: `/rooms/${encodeURIComponent(selected.id)}/session-events`, key, body: { goalId: goal.id, type: 'message', content: text, contextManifestId: manifest.id, idempotencyKey: key } };
    }
    rememberPending(); await retryMessage();
  }
  async function retryMessage() {
    if (!pending) return;
    try {
      await api(pending.path, pending.body, pending.key);
      pending = undefined; rememberPending(); $('composerInput').value = ''; await refresh();
    } catch (error) {
      // Known rejections are safe to edit. Unknown outcomes retain the exact body and key.
      if (error.status && error.status < 500) { pending = undefined; rememberPending(); }
      throw error;
    }
  }
  function renderBoard() {
    const container = element('div', undefined, 'board-columns');
    for (const [column, label] of Object.entries(columns)) {
      const section = element('section', undefined, 'board-column'); section.append(element('h3', label));
      for (const task of tasks.values()) if (task.column === column) {
        const card = button(`${task.title} · ${task.status}`, () => openTask(task)); card.dataset.task = task.id; section.append(card);
      }
      container.append(section);
    }
    $('board').replaceChildren(element('h2', '任务看板'), element('p', '只读展示服务端自动列。拖动将在后续版本开放。', 'muted'), container);
  }
  async function openTask(task) {
    const panel = $('taskDetail'); panel.hidden = false;
    panel.replaceChildren(element('h2', task.title), element('p', `${task.status} · ${task.id}`));
    const runId = task.runId || task.latestRunId;
    panel.dataset.run = runId || ''; delete panel.dataset.version;
    if (runId) await showRun(runId);
    else panel.append(element('p', '这件事还没有 Run。'));
  }
  async function showRun(runId) {
    const run = await api(`/runs/${encodeURIComponent(runId)}`), panel = $('taskDetail');
    if (panel.dataset.run !== runId) return;
    const version = `${run.id}:${run.revision}`;
    if (panel.dataset.version === version) return;
    panel.dataset.version = version;
    panel.replaceChildren(element('h2', run.goal), element('p', `${run.status} · ${run.id}`));
    const plan = run.plans?.at(-1);
    if (plan) { panel.append(element('h3', '执行计划'), element('p', plan.summary)); for (const node of plan.nodes) panel.append(element('p', node.title)); }
    const command = async (action, body) => { await api(`/runs/${encodeURIComponent(run.id)}/${action}`, body); await refresh(); await showRun(run.id); };
    if (run.canEdit !== false && run.status === 'needs_approval') {
      if (run.actionApproval?.status === 'pending') {
        panel.append(element('p', run.actionApproval.reason || run.actionApproval.ref));
        for (const [label, decision] of [['批准一次', 'once'], ['拒绝动作', 'deny']]) panel.append(button(label, () => command('approve-action', { idempotencyKey: run.actionApproval.idempotencyKey, decision })));
      } else if (plan) {
        panel.append(button('批准并执行', () => command('approve', { planVersion: plan.version, planHash: plan.hash })), button('拒绝 / 取消', () => command('cancel', { reason: '主人在工作室拒绝计划' })));
        const feedback = element('textarea'); feedback.placeholder = '修改意见'; feedback.setAttribute('aria-label', '计划修改意见');
        panel.append(feedback, button('请求修改计划', () => command('revise-plan', { planVersion: plan.version, feedback: feedback.value })));
      }
    }
    if (run.canEdit !== false && run.status === 'needs_input') {
      panel.append(element('p', run.question?.text));
      const answer = element('textarea'); answer.setAttribute('aria-label', '回答问题');
      panel.append(answer, button('回答并继续', () => command('answer', { answer: answer.value })));
    }
    for (const artifact of run.artifacts || []) panel.append(artifactNode(artifact));
    const link = element('a', '在主页查看此 Run'); link.href = `/runs/${encodeURIComponent(run.id)}`; panel.append(link);
  }
  function artifactNode(artifact) {
    const card = element('article', undefined, 'artifact-card'); card.append(element('h3', artifact.title), element('pre', artifact.content)); return card;
  }
  async function showArtifacts() {
    const panel = $('artifacts'); panel.hidden = false; panel.replaceChildren(element('h2', '产物'));
    const runIds = [...new Set([...tasks.values()].map(task => task.runId || task.latestRunId).filter(Boolean))];
    for (const runId of runIds) {
      const run = await api(`/runs/${encodeURIComponent(runId)}`);
      for (const artifact of run.artifacts || []) panel.append(artifactNode(artifact));
    }
    if (!selected.direct) { panel.append(element('p', '频道产物通过各任务的 Run 读取；编辑稿请在对应 Bot 私聊保存。')); return; }
    const drafts = await api(`/rooms/${encodeURIComponent(selected.id)}/dialogue/artifacts`);
    const title = element('input'); title.placeholder = '产物标题'; title.setAttribute('aria-label', '产物标题'); title.maxLength = 200;
    const content = element('textarea'); content.setAttribute('aria-label', '产物正文'); content.rows = 6; content.maxLength = 30000;
    let artifactId;
    for (const draft of drafts.items) { const card = artifactNode(draft); card.append(button('编辑草稿', async () => { artifactId = draft.id; title.value = draft.title; content.value = draft.content; })); panel.append(card); }
    const saveKey = crypto.randomUUID(); let saveBody;
    panel.append(element('h3', '保存产物草稿'), title, content, button('保存到对话', async () => {
      saveBody ??= { title: title.value, content: content.value, expectedRevision: drafts.revision, ...(artifactId ? { artifactId } : {}) };
      try { await api(`/rooms/${encodeURIComponent(selected.id)}/dialogue/artifacts`, saveBody, saveKey); }
      catch (error) { if (error.status && error.status < 500) saveBody = undefined; throw error; }
      await refresh(); await showArtifacts();
    }));
  }
  $('composerForm').onsubmit = event => { event.preventDefault(); void perform(sendMessage); };
  $('retry').onclick = () => perform(retryMessage);
  $('reconnect').onclick = () => perform(connect);
  $('refresh').onclick = () => perform(refresh);
  $('openBoard').onclick = () => perform(async () => { $('board').hidden = false; renderBoard(); });
  $('openArtifacts').onclick = () => perform(showArtifacts);
  window.addEventListener('storage', event => { if (event.key === 'aeeis.token') void perform(connect); });
  window.addEventListener('online', () => { void perform(connect); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void perform(refresh); });
  const timer = setInterval(async () => {
    if (!status || !selected || busy || refreshing || document.hidden || pending) return;
    refreshing = true;
    try { await refresh(); } catch (error) { $('error').textContent = `连接中断：${error.message}。记录未在本地模拟更新。`; }
    finally { refreshing = false; }
  }, 2000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  void perform(connect);
})();
