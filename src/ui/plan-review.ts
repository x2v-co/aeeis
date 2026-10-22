export interface ReviewPlan {
  version: number; hash: string; summary: string;
  author?: { type: 'user' | 'model' | 'policy' };
  nodes: Array<{ id: string; title: string; instruction?: string; evidenceRequirements?: string; dependsOn: string[] }>;
}
export interface PlanReviewRun {
  id: string; plans: ReviewPlan[]; taskExecution?: unknown;
  modelBudget?: { tokens?: number; moneyUsd?: number };
  externalBudget?: { calls?: number; tokens?: number; moneyUsd?: number };
}
type Submit = (action: string, body: unknown) => Promise<void>;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.textContent = text; return node;
};
function action(text: string, task: () => Promise<void>, error: HTMLElement): HTMLButtonElement {
  const button = el('button', text); button.type = 'button';
  button.onclick = () => {
    button.disabled = true; error.textContent = '';
    void task().catch(reason => { error.textContent = reason instanceof Error ? (reason.message === 'Invalid request' ? '填写内容不符合要求，请检查任务与预算' : reason.message) : '操作失败，请重试'; })
      .finally(() => { button.disabled = false; });
  };
  return button;
}
function field(parent: HTMLElement, label: string, value: string, limit: number, update: (value: string) => void, multiline = false): HTMLInputElement | HTMLTextAreaElement {
  const wrapper = el('label', label), input = multiline ? el('textarea') : el('input');
  input.value = value; input.maxLength = limit; input.setAttribute('aria-label', label);
  input.oninput = () => update(input.value);
  wrapper.append(input); parent.append(wrapper); return input;
}
let cached: { key: string; root: HTMLElement; approve: () => Promise<void> } | undefined;
/** Reuse the draft DOM across changefeed refreshes of the same plan. */
export function planReview(run: PlanReviewRun, submit: Submit, writable: boolean): { root: HTMLElement; approve: () => Promise<void> } {
  const plan = run.plans.at(-1)!;
  const key = `${run.id}:${plan.version}:${plan.hash}:${writable}`;
  if (cached?.key === key) return cached;
  const root = el('div'); root.className = 'plan-review-editor';
  const error = el('p'); error.setAttribute('role', 'alert');
  const history = el('details'); history.append(el('summary', `计划版本历史 · ${run.plans.length} 个版本`));
  run.plans.forEach((version, index) => {
    const item = el('details'); item.append(el('summary', `v${version.version} · ${version.author?.type === 'user' ? '用户编辑' : version.author?.type === 'policy' ? '直接执行' : '模型规划'} · ${version.summary}`));
    const before = run.plans[index - 1];
    if (before) {
      if (before.summary !== version.summary) item.append(el('p', `计划摘要：${before.summary} → ${version.summary}`));
      for (const node of version.nodes) {
        const old = before.nodes.find(other => other.id === node.id);
        if (!old) item.append(el('p', `新增任务：${node.title}（${node.id}）`));
        else {
          const fields = [['title', '标题'], ['instruction', '目标'], ['evidenceRequirements', '证据要求'], ['dependsOn', '依赖']] as const;
          for (const [name, label] of fields) {
            if (JSON.stringify(old[name]) !== JSON.stringify(node[name])) item.append(el('p', `${node.id} · ${label}：${String(old[name] ?? '未设置')} → ${String(node[name] ?? '未设置')}`));
          }
        }
      }
      for (const node of before.nodes) if (!version.nodes.some(other => other.id === node.id)) item.append(el('p', `删除任务：${node.title}（${node.id}）`));
      if (JSON.stringify(before.nodes.map(node => node.id)) !== JSON.stringify(version.nodes.map(node => node.id))) item.append(el('p', `任务顺序：${before.nodes.map(node => node.id).join(' → ')} → ${version.nodes.map(node => node.id).join(' → ')}`));
    }
    for (const node of version.nodes) item.append(el('p', `${node.title} · ${node.instruction ?? ''} · 证据要求：${node.evidenceRequirements ?? '依据已有资料，引用实际收到的证据'}`));
    history.append(item);
  });
  root.append(history);
  let dirty = false;
  let approve = async (): Promise<void> => { throw new Error('当前页面为只读'); };
  if (writable) {
    const budgets = el('fieldset'); budgets.append(el('legend', '预算上限'), el('small', '预算按本次运行累计用量计入，包含已完成的规划；留空表示不设该项上限。'));
    const inputs: Record<string, HTMLInputElement> = {};
    const groups = [['model', '模型', run.modelBudget, ['tokens', 'moneyUsd']], ['external', '外部', run.externalBudget, ['calls', 'tokens', 'moneyUsd']]] as const;
    for (const [group, label, budget, names] of groups) for (const name of names) {
      const value = (budget as Record<string, number> | undefined)?.[name];
      const input = field(budgets, `${label}${({ tokens: ' Token 上限', calls: '调用次数上限', moneyUsd: '金额上限（美元）' })[name]}`, value === undefined ? '' : String(value), 30, () => {}) as HTMLInputElement;
      input.type = 'number'; input.min = name === 'moneyUsd' ? '0' : '1'; input.step = name === 'moneyUsd' ? 'any' : '1'; input.placeholder = '未设置';
      inputs[`${group}.${name}`] = input;
    }
    const budgetPayload = () => {
      const read = (group: string, names: readonly string[]) => {
        const values: Record<string, number> = {};
        for (const name of names) {
          const value = inputs[`${group}.${name}`]!.value.trim();
          if (!value) continue;
          const number = Number(value);
          if (!Number.isFinite(number) || number < 0 || (name !== 'moneyUsd' && (!Number.isSafeInteger(number) || number < 1))) throw new Error('预算必须为有效数值，次数和 Token 上限须为正整数');
          values[name] = number;
        }
        return Object.keys(values).length ? values : null;
      };
      return { planVersion: plan.version, modelBudget: read('model', ['tokens', 'moneyUsd']), externalBudget: read('external', ['calls', 'tokens', 'moneyUsd']) };
    };
    budgets.append(action('保存预算', () => submit('budgets', budgetPayload()), error));
    root.append(budgets);
    if (!run.taskExecution) {
      const editor = el('details'); editor.append(el('summary', '编辑任务'));
      const draft = { summary: plan.summary, nodes: plan.nodes.map(node => ({ id: node.id, title: node.title, instruction: node.instruction ?? '', dependsOn: [...node.dependsOn], ...(node.evidenceRequirements ? { evidenceRequirements: node.evidenceRequirements } : {}) })) };
      field(editor, '计划摘要', draft.summary, 4000, value => { draft.summary = value; dirty = true; }, true);
      const list = el('div'); editor.append(list);
      function draw(): void {
        list.replaceChildren();
        draft.nodes.forEach((node, index) => {
          const task = el('fieldset'); task.append(el('legend', `任务 ${index + 1} · ${node.id}`));
          field(task, `任务 ${index + 1} 标题`, node.title, 200, value => { node.title = value; dirty = true; });
          field(task, `任务 ${index + 1} 目标`, node.instruction, 4000, value => { node.instruction = value; dirty = true; }, true);
          field(task, `任务 ${index + 1} 证据要求`, node.evidenceRequirements ?? '', 4000, value => { if (value.trim()) node.evidenceRequirements = value; else delete node.evidenceRequirements; dirty = true; }, true);
          field(task, `任务 ${index + 1} 依赖 ID（逗号分隔）`, node.dependsOn.join(', '), 1400, value => { node.dependsOn = value.split(/[,，]/).map(id => id.trim()).filter(Boolean); dirty = true; });
          for (const [text, offset] of [['上移', -1], ['下移', 1]] as const) {
            const move = action(text, async () => { const target = index + offset; [draft.nodes[index], draft.nodes[target]] = [draft.nodes[target]!, node]; dirty = true; draw(); }, error);
            move.disabled = index + offset < 0 || index + offset >= draft.nodes.length; task.append(move);
          }
          const remove = action('删除任务', async () => { draft.nodes.splice(index, 1); for (const other of draft.nodes) other.dependsOn = other.dependsOn.filter(id => id !== node.id); dirty = true; draw(); }, error);
          remove.disabled = draft.nodes.length === 1; task.append(remove); list.append(task);
        });
      }
      draw();
      editor.append(action('添加任务', async () => {
        if (draft.nodes.length >= 12) throw new Error('最多可添加 12 个任务');
        let index = 1; while (draft.nodes.some(node => node.id === `task_${index}`)) index++;
        draft.nodes.push({ id: `task_${index}`, title: '', instruction: '', dependsOn: [] }); dirty = true; draw();
      }, error));
      editor.append(action('保存为新版本', async () => {
        if (!draft.summary.trim()) throw new Error('请填写计划摘要');
        if (draft.nodes.some(node => !node.title.trim() || !node.instruction.trim())) throw new Error('请填写每个任务的标题和目标');
        await submit('edit-plan', { planVersion: plan.version, plan: draft }); dirty = false;
      }, error));
      root.append(editor);
      const feedback = el('details'); feedback.append(el('summary', '补充要求并重新规划'));
      let text = '';
      field(feedback, '补充要求', '', 8000, value => { text = value; }, true);
      feedback.append(action('提交要求并重新规划', async () => {
        if (dirty) throw new Error('请先保存任务修改，再重新规划');
        if (!text.trim()) throw new Error('请填写补充要求');
        await submit('revise-plan', { planVersion: plan.version, feedback: text.trim() });
      }, error)); root.append(feedback);
    }
    approve = async () => {
      if (dirty) throw new Error('请先将任务修改保存为新版本，再批准执行');
      await submit('approve', { planHash: plan.hash, ...budgetPayload() });
    };
  }
  root.append(error);
  cached = { key, root, approve }; return cached;
}
