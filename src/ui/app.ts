interface RunSummary { id: string; goal: string; goalId?: string; domainPlanId?: string; status: string }
interface GoalSummary { id: string; title: string; status: string; createdAt: string }
interface EvolutionSummary { id: string; target: string; proposedVersion: string; risk: string; status: string; evaluations: Array<{ kind: string; passed: boolean }> }
interface RunView extends RunSummary {
  revision: number; goalId?: string; domainPlanId?: string;
  plans: Array<{ hash: string; version: number; summary: string; nodes: Array<{ id: string; title: string; dependsOn: string[] }> }>;
  steps: Array<{ taskId: string; status: string }>;
  artifacts: Array<{ id: string; title: string; content: string; evidenceRefs: string[] }>;
  events: Array<{ seq: number; type: string; at: string }>;
  calls: Array<{ phase: string; state: string; usage?: { inputTokens: number; outputTokens: number } }>;
  question?: { text: string }; error?: string;
  review?: { verdict: string; summary: string; issues: string[] };
}
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
let currentId = localStorage.getItem('aeeis.run') ?? '';
let current: RunView | undefined;
let polling = false;
async function api<T>(path: string, body?: unknown): Promise<T> {
  const token = sessionStorage.getItem('aeeis.token');
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}
function message(text: string): void { $('error').textContent = text; }
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
}
function button(label: string, action: () => Promise<void>): HTMLButtonElement {
  const b = element('button', label);
  b.onclick = () => { b.disabled = true; void action().catch(e => message(String(e.message))).finally(() => { b.disabled = false; }); }; return b;
}
async function refresh(): Promise<void> {
  const [runs, goals, candidates] = await Promise.all([
    api<RunSummary[]>('/runs'), api<GoalSummary[]>('/goals'), api<EvolutionSummary[]>('/evolution/candidates'),
  ]);
  renderGoals(goals); renderCandidates(candidates);
  const list = $('runs'); list.replaceChildren();
  for (const run of runs) {
    const item = button(`${run.goal.slice(0, 60)} · ${run.status}`, async () => { currentId = run.id; localStorage.setItem('aeeis.run', run.id); current = undefined; await refresh(); });
    item.className = run.id === currentId ? 'selected' : ''; list.append(item);
  }
  if (!currentId) return;
  const run = await api<RunView>(`/runs/${currentId}`);
  if (current?.id === run.id && current.revision === run.revision) return;
  current = run; render(run);
}
function renderGoals(goals: GoalSummary[]): void {
  const list = $('goals'); list.replaceChildren(); $('goals-empty').hidden = goals.length > 0;
  const selector = $<HTMLSelectElement>('goal-id');
  const selected = selector.value;
  selector.replaceChildren(element('option', '不绑定，创建独立运行'));
  selector.options[0]!.value = '';
  for (const goal of goals) {
    const option = element('option', `${goal.title} · ${goal.status}`);
    option.value = goal.id; selector.append(option);
  }
  if (goals.some(goal => goal.id === selected)) selector.value = selected;
  for (const goal of goals) {
    const item = element('div', '', 'fact-row');
    item.append(element('strong', goal.title), element('small', `${goal.status} · ${new Date(goal.createdAt).toLocaleDateString()}`)); list.append(item);
  }
}
($('new-goal') as HTMLFormElement).onsubmit = event => {
  event.preventDefault(); message('');
  const form = $('new-goal') as HTMLFormElement;
  const submit = form.querySelector('button') as HTMLButtonElement; submit.disabled = true;
  void api('/goals', { title: $<HTMLInputElement>('goal-title').value, description: $<HTMLTextAreaElement>('goal-description').value || undefined })
    .then(async () => { $<HTMLInputElement>('goal-title').value = ''; $<HTMLTextAreaElement>('goal-description').value = ''; await refresh(); })
    .catch(e => message(e.message)).finally(() => { submit.disabled = false; });
};
function renderCandidates(candidates: EvolutionSummary[]): void {
  const list = $('candidates'); list.replaceChildren(); $('candidates-empty').hidden = candidates.length > 0;
  for (const candidate of candidates) {
    const passed = candidate.evaluations.filter(item => item.passed).length;
    const item = element('div', '', `fact-row candidate-${candidate.status}`);
    item.append(element('strong', `${candidate.target} · ${candidate.proposedVersion}`), element('small', `${candidate.status} · ${candidate.risk} · ${passed}/${candidate.evaluations.length} gates`)); list.append(item);
  }
}
async function command(action: string, body: unknown = {}): Promise<void> {
  await api(`/runs/${currentId}/${action}`, body); await refresh();
}
function render(run: RunView): void {
  $('run-title').textContent = run.goal;
  $('run-status').textContent = run.status;
  $('run-status').className = `status ${run.status}`;
  $('empty').hidden = true; $('detail').hidden = false;
  $('run-error').textContent = run.error ?? '';
  const controls = $('controls'); controls.replaceChildren();
  if (run.status === 'needs_approval') {
    controls.append(button('批准计划并执行', () => command('approve', { planHash: run.plans.at(-1)!.hash })));
  }
  if (['queued', 'planning', 'running', 'reviewing'].includes(run.status)) controls.append(button('暂停', () => command('pause')));
  if (run.status === 'paused') controls.append(button('继续', () => command('resume')));
  if (run.status === 'failed') controls.append(button('重试失败步骤', () => command('retry')));
  if (run.status === 'failed') controls.append(button('重新规划', () => command('replan', { reason: '根据审核或失败信息生成新的计划版本' })));
  if (!['succeeded', 'cancelled'].includes(run.status)) controls.append(button('取消运行', () => command('cancel')));
  if (run.status === 'queued') controls.append(button('恢复调度', () => command('dispatch')));
  $('input-panel').hidden = !['needs_input', 'unknown'].includes(run.status);
  $('question').textContent = run.question?.text ?? '上次模型请求结果未知。核查后填写允许重新调用的理由；可能产生重复模型费用。';
  const plan = run.plans.at(-1);
  $('plan-summary').textContent = plan
    ? `计划 v${plan.version} · ${plan.summary}${run.plans.length > 1 ? ` · 历史版本：${run.plans.slice(0, -1).map(item => `v${item.version}`).join('、')}` : ''}`
    : '正在等待模型生成任务计划';
  const graph = $('graph'); graph.replaceChildren();
  if (plan) {
    const levels = new Map<string, number>();
    function level(id: string): number {
      if (levels.has(id)) return levels.get(id)!;
      const node = plan!.nodes.find(n => n.id === id)!;
      const value = node.dependsOn.length ? 1 + Math.max(...node.dependsOn.map(level)) : 0; levels.set(id, value); return value;
    }
    plan.nodes.forEach(n => level(n.id));
    const positions = new Map<string, { x: number; y: number }>();
    const rows = new Map<number, number>();
    for (const node of plan.nodes) {
      const l = levels.get(node.id)!, row = rows.get(l) ?? 0; rows.set(l, row + 1);
      positions.set(node.id, { x: l * 268 + 8, y: row * 128 + 8 });
    }
    const canvas = element('div', '', 'canvas');
    const width = (Math.max(...levels.values()) + 1) * 268, height = Math.max(...rows.values()) * 128;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
    for (const node of plan.nodes) for (const dependency of node.dependsOn) {
      const a = positions.get(dependency)!, b = positions.get(node.id)!;
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', `M${a.x+236} ${a.y+48} C${a.x+253} ${a.y+48} ${b.x-17} ${b.y+48} ${b.x} ${b.y+48}`);
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#5378a5'); path.setAttribute('stroke-width', '2'); svg.append(path);
    }
    canvas.append(svg);
    for (const node of plan.nodes) {
      const p = positions.get(node.id)!; const status = run.steps.find(s => s.taskId === node.id)?.status ?? 'pending';
      const card = element('article', '', `node ${status}`); card.style.left = `${p.x}px`; card.style.top = `${p.y}px`;
      card.append(element('small', status), element('strong', node.title), element('small', node.id)); canvas.append(card);
    }
    graph.append(canvas);
  }
  const artifacts = $('artifacts'); artifacts.replaceChildren();
  for (const artifact of run.artifacts) {
    const box = element('details'); box.open = true;
    box.append(element('summary', artifact.title), element('pre', artifact.content), element('small', `证据：${artifact.evidenceRefs.join(', ') || '无外部来源引用'}`)); artifacts.append(box);
  }
  if (!run.artifacts.length) artifacts.append(element('p', '实际执行后，报告和其他产物会出现在这里。', 'muted'));
  $('review').textContent = run.review ? `${run.review.verdict}: ${run.review.summary}\n${run.review.issues.join('\n')}` : '';
  const events = $('events'); events.replaceChildren();
  for (const e of run.events.slice(-60).reverse()) events.append(element('li', `${new Date(e.at).toLocaleTimeString()} · ${e.type}`));
  $('usage').textContent = `${run.calls.length} 次模型请求 · ${run.calls.reduce((sum,c) => sum+(c.usage?.inputTokens ?? 0)+(c.usage?.outputTokens ?? 0),0)} 已报告 tokens`;
}
$('new-run').onsubmit = event => {
  event.preventDefault(); const submit = $('submit') as HTMLButtonElement; submit.disabled = true; message('');
  const content = $<HTMLTextAreaElement>('materials').value.trim();
  const knowledgeQuery = $<HTMLInputElement>('knowledge-query').value.trim();
  const privacy = $<HTMLSelectElement>('privacy').value;
  const brainScope = $<HTMLInputElement>('brain-scope').value.trim();
  const goalId = $<HTMLSelectElement>('goal-id').value;
  void api<{ id: string }>('/runs', { goal: $<HTMLTextAreaElement>('goal').value, ...(goalId ? { goalId } : {}), materials: content ? [{ title: '用户提供的项目资料', source: 'user-input', content }] : [], ...(knowledgeQuery ? { knowledgeQuery } : {}), ...(brainScope ? { brainScope } : {}), privacy })
    .then(async result => { currentId = result.id; current = undefined; localStorage.setItem('aeeis.run', currentId); await refresh(); })
    .catch(e => message(e.message)).finally(() => { submit.disabled = false; });
};
$('answer-form').onsubmit = event => { event.preventDefault(); const answer = $<HTMLTextAreaElement>('answer').value; void command(current?.status === 'unknown' ? 'reconcile' : 'answer', current?.status === 'unknown' ? { reason: answer } : { answer }).then(() => { $<HTMLTextAreaElement>('answer').value = ''; }).catch(e => message(e.message)); };
$('connect').onclick = () => {
  const token = $<HTMLInputElement>('token').value;
  if (token) sessionStorage.setItem('aeeis.token', token); else sessionStorage.removeItem('aeeis.token');
  void initialize();
};
async function initialize(): Promise<void> {
  try {
    const status = await api<{ modelConfigured: boolean; model: { model: string; endpoint: string } | null; modelRouting: string; runner: string; knowledgeConfigured: boolean; evolutionConfigured: boolean; collaborationConfigured: boolean }>('/status');
    $('configuration').textContent = status.modelConfigured
      ? `${status.model ? `${status.model.model} · ${status.runner}` : `模型目录路由 · ${status.runner}`}。${status.knowledgeConfigured ? 'Knowledge 已启用；' : ''}${status.evolutionConfigured ? 'RSI 候选存储已启用；' : ''}${status.collaborationConfigured ? '协作平面已启用。' : ''}`
      : '尚未配置模型。请在服务端设置 AEEIS_MODEL_BASE_URL、AEEIS_MODEL，或配置 AEEIS_PLANPRICE_URL 后重启；Knowledge、RSI 和协作状态仍可查看，但不会生成模拟结果。';
    ($('submit') as HTMLButtonElement).disabled = !status.modelConfigured; await refresh(); message('');
  } catch (e) { message((e as Error).message); }
}
void initialize();
setInterval(() => { if (polling || document.hidden) return; polling = true; void refresh().catch(e => message(e.message)).finally(() => { polling = false; }); }, 2000);
