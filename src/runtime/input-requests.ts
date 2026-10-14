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

export function inputQuestion(run: AgentRun, taskId: string, text: string, external = false): NonNullable<AgentRun['question']> {
  const { hasSources, hasCapabilities } = inputAvailability(run);
  const missing = [...(!hasSources ? ['source'] : []), ...(!hasCapabilities ? ['capability'] : [])];
  const kind = external ? 'external_clarification' : !hasSources && /资料|数据|来源|证据|文件|source|data|evidence|document/i.test(text) ? 'missing_source'
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
  return { taskId: run.question.taskId, question: run.question.text, kind: run.question.kind ?? fallback.kind!, missing: run.question.missing ?? fallback.missing! };
}
