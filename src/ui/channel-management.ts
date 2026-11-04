/** Compact homepage controls over the same Room endpoints as /team/. */
export interface ManagedChannel {
  id: string; title: string; status: string; category?: string; topicRef?: string; revision?: number;
  memberRole?: string; canEdit?: boolean; canArchive?: boolean;
}
const labels: Record<string, string> = { general: '通用', product: '产品', topic: '主题' };
export function renderChannelManager(container: HTMLElement, rooms: ManagedChannel[], api: (path: string, body?: unknown, method?: 'POST' | 'GET' | 'DELETE' | 'PATCH' | 'PUT') => Promise<unknown>, refresh: () => Promise<void>, onError: (message: string) => void, canCreate = true, openRoom?: (id: string) => Promise<void>): void {
  // Keep an in-progress form intact during background refreshes.
  if (container.querySelector('form')) return;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
  const button = (text: string, work: () => Promise<void>) => { const node = element('button', text); node.type = 'button'; node.onclick = async () => { node.disabled = true; try { await work(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } finally { node.disabled = false; } }; return node; };
  const list = element('div');
  const archived = element('input'); archived.type = 'checkbox'; archived.checked = container.dataset.archived === 'true';
  const filter = element('label', ' 查看归档'); filter.prepend(archived);
  const edit = async (room?: ManagedChannel) => {
    const form = element('form'); const title = element('input'); title.required = true; title.maxLength = 500; title.value = room?.title ?? ''; title.setAttribute('aria-label', '频道名称');
    const category = element('select'); category.setAttribute('aria-label', '频道分类');
    for (const [value, label] of Object.entries(labels)) { const option = element('option', label); option.value = value; category.append(option); }
    category.value = room?.category ?? 'general';
    const topic = element('input'); topic.maxLength = 500; topic.value = room?.topicRef ?? ''; topic.setAttribute('aria-label', '频道主题说明'); topic.placeholder = '主题说明（可选）';
    const save = element('button', '保存频道'); save.type = 'submit'; let saving = false;
    form.append(title, category, topic, save, button('取消', async () => form.remove()));
    form.onsubmit = async event => {
      event.preventDefault(); if (saving) return; saving = true; save.disabled = true;
      try {
        const changes = { title: title.value.trim(), category: category.value, topicRef: topic.value.trim() };
        await api(room ? `/rooms/${encodeURIComponent(room.id)}` : '/rooms', room ? { ...changes, expectedRevision: room.revision ?? 0 } : { ...changes, chat: 'group' }, room ? 'PATCH' : 'POST');
        form.remove(); await refresh();
      } catch (error) { onError(`${error instanceof Error ? error.message : String(error)}；请取消编辑并核对最新频道后重试。`); }
      finally { saving = false; save.disabled = false; }
    };
    container.querySelector('form')?.remove(); container.append(form); title.focus();
  };
  const render = () => {
    container.dataset.archived = String(archived.checked); list.replaceChildren();
    for (const room of rooms.filter(room => (room.status === 'archived') === archived.checked)) {
      const row = element('div');
      const link = element('a', room.title); link.href = `/#room=${encodeURIComponent(room.id)}`;
      if (openRoom) link.onclick = event => { event.preventDefault(); void openRoom(room.id).catch(error => onError(error instanceof Error ? error.message : String(error))); };
      row.append(link, element('small', ` · ${labels[room.category ?? 'general']} · ${room.memberRole ?? '成员'}${room.status === 'archived' ? ' · 已归档，只读' : ''}`));
      if (room.canEdit) row.append(button('改名 / 分类', () => edit(room)));
      if (room.canArchive) row.append(button(archived.checked ? '恢复' : '归档', async () => { await api(`/rooms/${encodeURIComponent(room.id)}`, { status: room.status === 'archived' ? 'active' : 'archived', expectedRevision: room.revision ?? 0 }, 'PATCH'); await refresh(); }));
      list.append(row);
    }
    if (!list.children.length) list.append(element('p', archived.checked ? '没有归档频道。' : '还没有频道。'));
  };
  archived.onchange = render;
  const create = button('新建频道', () => edit()); create.disabled = !canCreate;
  container.replaceChildren(create, filter, element('small', '归档后只读，已有 Run 继续运行；恢复使用原链接。'), list);
  render();
}
