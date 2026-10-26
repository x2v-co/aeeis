/** Frozen at Run creation. Missing means the planner still proposes the task graph. */
export type PlanningShape = 'direct' | 'dag';
export type PlanningReason =
  | 'read_only'
  | 'tools'
  | 'agents'
  | 'budget'
  | 'skill'
  | 'resources'
  | 'runtime'
  | 'length'
  | 'live_data'
  | 'external_effect'
  | 'domain_task';

export interface PlanningInput {
  goal: string;
  taskExecution?: unknown | undefined;
  builtinSkill?: string | undefined;
  allowedTools?: readonly string[] | undefined;
  allowedAgents?: readonly string[] | undefined;
  externalBudget?: unknown | undefined;
  resources?: unknown | undefined;
  skillRuntime?: string | undefined;
}

/** One instruction is the longest direct plan. Longer goals stay on the planner. */
export const DIRECT_INSTRUCTION_LIMIT = 4_000;
/** Policy text for an automatic clearance. It is not a model judgment. */
export const directApprovalReason = '这份计划只有一个只读步骤，不调用外部工具、代理，也不使用外部预算';

const externalEffect = /发送|发邮件|发消息|发短信|支付|付款|转账|下单|购买|部署|上线|send\s+(?:an?\s+)?(?:e-?mail|message|mail)|\b(?:pay|purchase|deploy)\b/i;

/** Conservative live-data goals. Ordinary writing and intent questions stay eligible for one step. */
export function needsExternalLiveData(goal: string): boolean {
  return /天气|气温|降雨|weather|forecast|实时|最新(?:新闻|消息|数据|价格)|今日(?:新闻|股价|汇率)|股价|汇率|live\s+data|real[ -]?time|current\s+(?:weather|price|news|exchange\s+rate)|latest\s+(?:news|price|data)/i.test(goal);
}

/** A model `needed: false` may clear only a frozen run that is still one read-only step. */
export function automaticReviewCanClear(input: PlanningInput & { planText?: string }): boolean {
  if (planningDecision(input).shape !== 'direct') return false;
  return !input.planText || !externalEffect.test(input.planText);
}

export function planningDecision(input: PlanningInput): { shape: PlanningShape; reason: PlanningReason } {
  if (input.taskExecution) return { shape: 'dag', reason: 'domain_task' };
  if (input.builtinSkill) return { shape: 'dag', reason: 'skill' };
  if (input.resources) return { shape: 'dag', reason: 'resources' };
  if (input.skillRuntime) return { shape: 'dag', reason: 'runtime' };
  if ((input.allowedTools?.length ?? 0) > 0) return { shape: 'dag', reason: 'tools' };
  if ((input.allowedAgents?.length ?? 0) > 0) return { shape: 'dag', reason: 'agents' };
  if (input.externalBudget) return { shape: 'dag', reason: 'budget' };
  const goal = input.goal.trim();
  if (goal.length > DIRECT_INSTRUCTION_LIMIT) return { shape: 'dag', reason: 'length' };
  if (needsExternalLiveData(goal)) return { shape: 'dag', reason: 'live_data' };
  if (externalEffect.test(goal)) return { shape: 'dag', reason: 'external_effect' };
  return { shape: 'direct', reason: 'read_only' };
}

export function planningRefusal(reason: PlanningReason): string {
  const text: Record<PlanningReason, string> = {
    read_only: '只有一个只读步骤',
    tools: '这次允许了外部工具',
    agents: '这次允许了外部代理',
    budget: '这次设置了外部预算',
    skill: '这次使用专用工作方式',
    resources: '这次绑定了资源版本',
    runtime: '这次指定了技能运行时',
    length: '目标超过单个步骤能容纳的长度',
    live_data: '目标需要实时数据',
    external_effect: '目标涉及发送、付款或部署',
    domain_task: '领域任务沿用已有计划',
  };
  return text[reason];
}

function clip(value: string, max: number): string {
  const sliced = value.slice(0, max);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xD800 && last <= 0xDBFF ? sliced.slice(0, -1) : sliced;
}

/** A one-node plan whose instruction is the goal. The caller hashes the validated draft. */
export function directPlanDraft(goal: string): { summary: string; nodes: Array<{ id: 'deliver'; title: string; instruction: string; dependsOn: [] }> } {
  const instruction = goal.trim();
  return {
    summary: clip(`直接执行：${instruction}`, DIRECT_INSTRUCTION_LIMIT),
    nodes: [{ id: 'deliver', title: clip(instruction, 80), instruction, dependsOn: [] }],
  };
}
