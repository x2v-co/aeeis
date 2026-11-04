/** Built-in starter Bots shown to an account that has not created its own yet.
 * They run on the same entry execution chain as AEEIS and OwnedBots; their profile is fixed here on the server
 * and is never execution authority. */
export interface StarterBot { id: string; name: string; role: string; background: string }

export const STARTER_BOTS: readonly StarterBot[] = [
  { id: 'demo.release', name: '发布', role: '对照发布清单', background: '对照发布清单逐项核对，列出缺口与风险。' },
  { id: 'demo.research', name: '研究', role: '整理公开资料', background: '收集并整理公开资料，标明来源。' },
  { id: 'demo.brief', name: '纪要', role: '把讨论收成纪要', background: '把讨论收成纪要：结论、待办和负责人。' },
];

export function starterBot(id: string | undefined): StarterBot | undefined {
  return id ? STARTER_BOTS.find(bot => bot.id === id) : undefined;
}
