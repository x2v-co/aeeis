import type { AgentRun } from './contracts.js';
import { threadHistorySources } from './thread-context.js';

export function inputAvailability(run: AgentRun): { hasSources: boolean; hasCapabilities: boolean } {
  return {
    hasSources: [...run.context.sources, ...threadHistorySources(run)].some(source => Boolean(source.content.trim())),
    hasCapabilities: run.capabilityCatalogVersion
      ? Boolean(run.approvedTools?.length || run.approvedAgents?.length)
      : Boolean(run.allowedTools.length || run.allowedAgents.length),
  };
}

export function inputQuestion(run: AgentRun, taskId: string, text: string, external = false, requestedFacts?: string[]): NonNullable<AgentRun['question']> {
  const { hasSources, hasCapabilities } = inputAvailability(run);
  const facts = requestedFacts?.filter(fact => !['source', 'capability'].includes(fact)) ?? [];
  const concreteFields: Array<[string, RegExp]> = [
    ['model', /型号|机型|\bmodel\b/i], ['quantity', /数量|采购量|订购量|\bquantity\b|\bhow many\b/i],
    ['delivery city', /(?:交付|配送|收货|送货|交货)(?:的)?(?:城市|市)|\b(?:delivery|shipping|destination)\s+city\b/i],
    ['target audience', /目标读者|受众|\btarget audience\b/i], ['budget', /预算|\bbudget\b/i],
    ['delivery date', /交付日期|交货日期|\bdelivery date\b/i], ['address', /地址|\baddress\b/i],
  ];
  for (const [field, pattern] of concreteFields) if (pattern.test(text)) facts.push(field);
  const missing = facts.length ? [...new Set(facts)] : [...(!hasSources ? ['source'] : []), ...(!hasCapabilities ? ['capability'] : [])];
  const kind = external ? 'external_clarification' : facts.length ? 'clarification' : !hasSources && /资料|数据|来源|证据|文件|source|data|evidence|document/i.test(text) ? 'missing_source'
    : !hasCapabilities && /工具|接口|能力|访问|tool|capabilit|access|api/i.test(text) ? 'missing_capability' : 'clarification';
  return { taskId, text, kind, missing };
}

/** Conservative live-data goals; ordinary writing/intent questions still wait. */
export function needsExternalLiveData(goal: string): boolean {
  return /天气|气温|降雨|weather|forecast|实时|最新(?:新闻|消息|数据|价格)|今日(?:新闻|股价|汇率)|股价|汇率|live\s+data|real[ -]?time|current\s+(?:weather|price|news|exchange\s+rate)|latest\s+(?:news|price|data)/i.test(goal);
}

export function runInputRequest(run: AgentRun): { taskId: string; question: string; kind: NonNullable<NonNullable<AgentRun['question']>['kind']>; missing: string[] } | undefined {
  if (run.status !== 'needs_input' || !run.question) return undefined;
  const fallback = inputQuestion(run, run.question.taskId, run.question.text);
  // Older Runs classified every absent toolkit as missing input, even when the
  // question explicitly requested case facts. Correct that projection too.
  if (fallback.kind === 'clarification' && fallback.missing?.some(field => !['source', 'capability'].includes(field)) && run.question.missing?.every(field => ['source', 'capability'].includes(field))) {
    return { taskId: run.question.taskId, question: run.question.text, kind: fallback.kind, missing: fallback.missing };
  }
  return { taskId: run.question.taskId, question: run.question.text, kind: run.question.kind ?? fallback.kind!, missing: run.question.missing ?? fallback.missing! };
}
