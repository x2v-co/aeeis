interface RunSummary { id: string; goal: string; goalId?: string; domainPlanId?: string; status: string }
interface GoalSummary { id: string; title: string; status: string; createdAt: string }
interface EvolutionSummary { id: string; target: string; proposedVersion: string; risk: string; status: string; evaluations: Array<{ kind: string; passed: boolean }>; shadowObservations?: Array<{ id: string; passed: boolean; score: number }>; canaryObservations?: Array<{ id: string; passed: boolean; score: number }>; rolloutAttempts?: Array<{ id: string; phase: string; caseId: string; state: string; error?: string }> }
interface EvolutionView extends EvolutionSummary { baseVersion: string; change: string; reason: string; sourceReceiptRefs: string[]; approvalRef?: string; shadowStartedAt?: string; canaryStartedAt?: string; promotedAt?: string; rolledBackAt?: string }
interface RunView extends RunSummary {
  revision: number; goalId?: string; domainPlanId?: string;
  plans: Array<{ hash: string; version: number; summary: string; nodes: Array<{ id: string; title: string; dependsOn: string[] }> }>;
  steps: Array<{ taskId: string; status: string }>;
  artifacts: Array<{ id: string; title: string; content: string; evidenceRefs: string[] }>;
  events: Array<{ seq: number; type: string; at: string }>;
  calls: Array<{ phase: string; state: string; usage?: { inputTokens: number; outputTokens: number } }>;
  question?: { text: string }; error?: string;
  toolReceipts?: Array<{ receiptId: string; operation: string; provider: string; status: string; errorCode?: string }>;
  pendingTool?: { taskId: string; toolId: string; receiptId?: string };
  pendingDelegation?: { agentId: string; taskBrief: { taskId: string }; receiptRef?: string };
  delegationOutcomes?: Array<{ agentId?: string; status: string; receiptRef: string }>;
  review?: { verdict: string; summary: string; issues: string[] };
}
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
let currentId = localStorage.getItem('aeeis.run') ?? '';
let selectedCandidateId = localStorage.getItem('aeeis.candidate') ?? '';
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
  if (selectedCandidateId) await renderCandidateDetail().catch(e => message(String(e.message)));
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
    const item = button('', async () => { selectedCandidateId = candidate.id; localStorage.setItem('aeeis.candidate', candidate.id); await renderCandidateDetail(); });
    item.className = `fact-row candidate-${candidate.status}${candidate.id === selectedCandidateId ? ' selected' : ''}`;
    item.append(element('strong', `${candidate.target} · ${candidate.proposedVersion}`), element('small', `${candidate.status} · ${candidate.risk} · ${passed}/${candidate.evaluations.length} gates`)); list.append(item);
  }
}
async function candidateCommand(id: string, action: string, body: unknown = {}): Promise<void> {
  await api(`/evolution/candidates/${id}/${action}`, body); await refresh();
}
async function renderCandidateDetail(): Promise<void> {
  if (!selectedCandidateId) { $('candidate-detail').hidden = true; return; }
  const candidate = await api<EvolutionView>(`/evolution/candidates/${selectedCandidateId}`);
  $('candidate-detail').hidden = false;
  $('candidate-title').textContent = `${candidate.target} · ${candidate.proposedVersion}`;
  $('candidate-status').textContent = `${candidate.status} · ${candidate.risk}`;
  $('candidate-change').textContent = `${candidate.change}\n\n原因：${candidate.reason}\n基线：${candidate.baseVersion}`;
  const gates = $('candidate-gates'); gates.replaceChildren();
  for (const gate of candidate.evaluations) gates.append(element('li', `${gate.kind} · ${gate.passed ? '通过' : '未通过'}`));
  if (!candidate.evaluations.length) gates.append(element('li', '尚未运行评估门', 'muted'));
  const rollout = $('candidate-rollout'); rollout.replaceChildren();
  for (const observation of [...(candidate.shadowObservations ?? []).map(item => ({ ...item, phase: 'shadow' })), ...(candidate.canaryObservations ?? []).map(item => ({ ...item, phase: 'canary' }))]) {
    rollout.append(element('li', `${observation.phase} · ${observation.id} · ${observation.passed ? '通过' : '未通过'} · ${observation.score}`));
  }
  for (const attempt of candidate.rolloutAttempts ?? []) {
    const row = element('li', `${attempt.phase} · ${attempt.caseId} · ${attempt.state}${attempt.error ? ` · ${attempt.error}` : ''}`, attempt.state === 'failed' ? 'failure' : '');
    rollout.append(row);
    if (attempt.state === 'started') {
      const reconcile = button('Reconcile this attempt', async () => {
        const reason = window.prompt('核查原因（必填）')?.trim(); if (!reason) return;
        const passed = window.confirm('外部 evaluator 是否确认通过？');
        const scoreText = window.prompt('分数（0 到 1）', passed ? '1' : '0')?.trim();
        const score = Number(scoreText);
        const evidence = window.prompt('证据引用，逗号分隔', attempt.id)?.split(',').map(value => value.trim()).filter(Boolean);
        if (!Number.isFinite(score) || score < 0 || score > 1 || !evidence?.length) throw new Error('需要有效分数和至少一个证据引用');
        await candidateCommand(candidate.id, 'reconcile-rollout', { attemptId: attempt.id, outcome: 'completed', passed, score, evidenceRefs: evidence, reason });
      });
      rollout.append(reconcile);
    }
  }
  if (!rollout.children.length) rollout.append(element('li', '尚未有 rollout observation 或 attempt', 'muted'));
  const controls = $('candidate-controls'); controls.replaceChildren();
  const allRequiredPassed = ['replay', 'holdout', 'safety'].every(kind => candidate.evaluations.some(item => item.kind === kind && item.passed));
  if (['evaluating', 'held'].includes(candidate.status) && allRequiredPassed) controls.append(button('批准候选', async () => { const approvalRef = window.prompt('审批引用（必填）')?.trim(); if (approvalRef) await candidateCommand(candidate.id, 'approve', { approvalRef }); }));
  if (candidate.status === 'approved' && candidate.risk === 'low') controls.append(button('晋升低风险候选', () => candidateCommand(candidate.id, 'promote')));
  if (candidate.status === 'approved' && candidate.risk !== 'low') controls.append(button('开始 Shadow', () => candidateCommand(candidate.id, 'start-shadow')));
  const shadowReady = (candidate.shadowObservations?.length ?? 0) >= (candidate.risk === 'high' ? 5 : candidate.risk === 'medium' ? 3 : 1) && (candidate.shadowObservations ?? []).every(item => item.passed);
  if (candidate.status === 'shadowing' && shadowReady) controls.append(button('开始 Canary', () => candidateCommand(candidate.id, 'start-canary')));
  if (candidate.status === 'canarying' && (candidate.canaryObservations?.length ?? 0) > 0) controls.append(button('晋升 Canary 候选', () => candidateCommand(candidate.id, 'promote')));
  if (candidate.status === 'promoted' && ['profile', 'prompt'].includes(candidate.target)) controls.append(button('激活到新 Run', async () => { const activationRef = window.prompt('激活引用（必填）')?.trim(); if (activationRef) await candidateCommand(candidate.id, 'activate', { activationRef }); }));
  if (['approved', 'shadowing', 'canarying', 'held', 'promoted'].includes(candidate.status)) controls.append(button('回滚候选', async () => { const reason = window.prompt('回滚原因（必填）')?.trim(); if (reason) await candidateCommand(candidate.id, 'rollback', { reason }); }));
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
  const effects = $('external-effects'); effects.replaceChildren();
  for (const receipt of run.toolReceipts ?? []) effects.append(element('li', `Tool ${receipt.operation} · ${receipt.status} · ${receipt.receiptId}${receipt.errorCode ? ` · ${receipt.errorCode}` : ''}`));
  for (const outcome of run.delegationOutcomes ?? []) effects.append(element('li', `Agent ${outcome.agentId ?? 'external'} · ${outcome.status} · ${outcome.receiptRef}`));
  if (run.pendingTool) effects.append(element('li', `等待 Tool reconcile：${run.pendingTool.toolId} · ${run.pendingTool.receiptId ?? '尚未生成 receipt'}`, 'failure'));
  if (run.pendingDelegation) effects.append(element('li', `等待 Agent reconcile：${run.pendingDelegation.agentId} · ${run.pendingDelegation.receiptRef ?? '尚未生成 receipt'}`, 'failure'));
  if (!effects.children.length) effects.append(element('li', '本次运行没有外部 Tool 或 Agent 调用记录', 'muted'));
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
