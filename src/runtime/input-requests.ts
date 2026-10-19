import type { AgentRun, Step } from './contracts.js';
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

/** Supplied observations may be summarized; this notice applies without a data source. */
export function unsupportedWeatherNotice(run: AgentRun): string | undefined {
  const { hasSources, hasCapabilities } = inputAvailability(run);
  if (hasSources || hasCapabilities || !/天气|气温|降雨|\bweather\b|\b(?:weather\s+)?forecast\b/i.test(run.goal)) return undefined;
  return '当前不支持实时天气或天气预报，且未提供天气数据来源，无法核验实时结果。可改为参考气候常年值，或查询当地气象部门的官方预报。 Real-time weather and forecasts are not supported without a weather data source. Consider climate norms or check the official meteorological forecast.';
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

/** The goal itself asks to be asked first ("缺什么就先问我"), so a clarification question is the deliverable. */
export function goalInvitesQuestions(goal: string): boolean {
  return /先问|问我|问一下我|向我确认|跟我确认|和我确认|与我确认|先确认|缺什么|需要哪些信息|\bask me\b|\bcheck with me\b|\bconfirm with me\b|\bask (?:first|before)\b/i.test(goal);
}

/** r79 chifeng: a general deliverable with no sources, tools or Agents (e.g. a travel guide) proceeds on labelled
 * assumptions instead of stopping at needs_input. Live-data goals, built-in skills, bound tasks and goals that ask to
 * be asked keep the question. At most two questions per task are deferred. */
export function shouldDeferQuestion(run: AgentRun, step: Step, question?: string, missing?: string[]): boolean {
  const { hasSources, hasCapabilities } = inputAvailability(run);
  if (hasSources || hasCapabilities || run.builtinSkill || run.taskExecution) return false;
  if (needsExternalLiveData(run.goal) || unsupportedWeatherNotice(run) || goalInvitesQuestions(run.goal)) return false;
  // Only a preference questionnaire for a goal that already names the deliverable and its constraints (chifeng: place,
  // length, month, travellers; 6 asked details). A vague goal ("写一段介绍") or a request for material keeps waiting.
  if (Array.from(run.goal.trim()).length < 20 || (missing?.length ?? 0) < 3) return false;
  if (question !== undefined && inputQuestion(run, step.taskId, question, false, missing).kind !== 'clarification') return false;
  return step.observations.filter(observation => observation.tool === 'question.deferred').length < 2;
}
