import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/runtime/http.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { composeBotBackground, BotBackgroundError } from '../src/bot-background.js';
import { createGlobalBudgetSelector, InMemoryGlobalBudgetLedger } from '../src/global-budget.js';
import { ModelOutcomeUnknown, type ModelAdapter, type ModelRequest } from '../src/runtime/model.js';

const pin = { model: 'fixture', endpoint: 'local', promptVersion: 'bot-background/1', provider: 'fixture' };

function adapter(complete: ModelAdapter['complete']): ModelAdapter {
  return { pin, complete };
}

describe('bot background', () => {
  it('reads a background from the model JSON', async () => {
    let request: ModelRequest | undefined;
    const drafted = await composeBotBackground(adapter(async incoming => {
      request = incoming;
      return { value: { background: '  把讨论收成可以核对的纪要。自己不代替人做决定。  ' } };
    }), '把讨论收成纪要', 'bot-background-key-1');
    expect(drafted.background).toBe('把讨论收成可以核对的纪要。自己不代替人做决定。');
    expect(request?.input).toBe('把讨论收成纪要');
    expect(request?.idempotencyKey).toBe('bot-background-key-1');
    expect(String(request?.system)).toContain('不可信');
  });

  it('accepts a fenced JSON string and refuses an empty background', async () => {
    const drafted = await composeBotBackground(adapter(async () => ({ value: '```json\n{"background":"核对清单。"}\n```' })), '核对', 'bot-background-key-2');
    expect(drafted.background).toBe('核对清单。');
    await expect(composeBotBackground(adapter(async () => ({ value: { background: '   ' } })), '核对', 'bot-background-key-3')).rejects.toBeInstanceOf(BotBackgroundError);
    await expect(composeBotBackground(adapter(async () => { throw new ModelOutcomeUnknown('结果不明'); }), '核对', 'bot-background-key-4')).rejects.toBeInstanceOf(ModelOutcomeUnknown);
  });

  it('drafts through HTTP and leaves the Bot unsaved when the result is unknown', async () => {
    const repository = new InMemoryRunRepository();
    const engine = new AgentEngine(repository, adapter(async () => ({ value: { background: '核对清单上的每一项。' } })));
    const app = buildApp({ repository, engine });
    try {
      const drafted = await app.inject({ method: 'POST', url: '/api/bots/background', payload: { role: '核对发布清单' } });
      expect(drafted.statusCode).toBe(200);
      expect(drafted.json()).toEqual({ background: '核对清单上的每一项。' });
      const empty = await app.inject({ method: 'POST', url: '/api/bots/background', payload: { role: '   ' } });
      expect(empty.statusCode).toBe(400);
    } finally { await app.close(); }

    const unknown = new AgentEngine(repository, adapter(async () => { throw new ModelOutcomeUnknown('结果不明'); }));
    const unknownApp = buildApp({ repository, engine: unknown });
    try {
      const response = await unknownApp.inject({ method: 'POST', url: '/api/bots/background', payload: { role: '核对发布清单' } });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('结果不明，背景没有留下');
    } finally { await unknownApp.close(); }
  });

  it('reserves the global budget before drafting and settles the reported usage', async () => {
    const repository = new InMemoryRunRepository();
    const ledger = new InMemoryGlobalBudgetLedger();
    await ledger.init();
    const select = createGlobalBudgetSelector([{ owner: 'owner', tenantId: 'local', window: 'none', budget: { calls: 2, tokens: 100 } }]);
    let calls = 0;
    const engine = new AgentEngine(repository, {
      model: adapter(async () => {
        calls += 1;
        return { value: { background: '核对清单上的每一项。' }, usage: { inputTokens: 3, outputTokens: 2 } };
      }),
      globalBudget: { ledger, select },
    });
    const app = buildApp({ repository, engine });
    const accountKey = select({ owner: 'owner', tenantId: 'local' }, new Date().toISOString())!.accountKey;
    try {
      const drafted = await app.inject({ method: 'POST', url: '/api/bots/background', headers: { 'idempotency-key': 'bot-background-budget-1' }, payload: { role: '核对发布清单' } });
      expect(drafted.statusCode, drafted.body).toBe(200);
      expect(calls).toBe(1);
      expect(await ledger.get(accountKey)).toMatchObject({ usedCalls: 1, usedTokens: 5 });
      const replay = await app.inject({ method: 'POST', url: '/api/bots/background', headers: { 'idempotency-key': 'bot-background-budget-1' }, payload: { role: '核对发布清单' } });
      expect(replay.statusCode).toBe(409);
      expect(replay.json().error).toContain('已经记过账');
      expect(calls).toBe(1);
      const second = await app.inject({ method: 'POST', url: '/api/bots/background', headers: { 'idempotency-key': 'bot-background-budget-2' }, payload: { role: '核对发布清单' } });
      expect(second.statusCode, second.body).toBe(200);
      expect(calls).toBe(2);
      expect(await ledger.get(accountKey)).toMatchObject({ usedCalls: 2, usedTokens: 10 });
      const exhausted = await app.inject({ method: 'POST', url: '/api/bots/background', headers: { 'idempotency-key': 'bot-background-budget-3' }, payload: { role: '核对发布清单' } });
      expect(exhausted.statusCode).toBe(409);
      expect(exhausted.json().error).toContain('Global call budget exhausted');
      expect(calls).toBe(2);
      expect(await repository.list()).toEqual([]);
    } finally { await app.close(); }

    const unknownLedger = new InMemoryGlobalBudgetLedger();
    await unknownLedger.init();
    const unknownSelect = createGlobalBudgetSelector([{ owner: 'owner', tenantId: 'local', window: 'none', budget: { calls: 2, tokens: 100 } }]);
    const unknown = new AgentEngine(repository, {
      model: adapter(async () => { throw new ModelOutcomeUnknown('结果不明'); }),
      globalBudget: { ledger: unknownLedger, select: unknownSelect },
    });
    const unknownApp = buildApp({ repository, engine: unknown });
    const unknownKey = unknownSelect({ owner: 'owner', tenantId: 'local' }, new Date().toISOString())!.accountKey;
    try {
      const response = await unknownApp.inject({ method: 'POST', url: '/api/bots/background', headers: { 'idempotency-key': 'bot-background-unknown-1' }, payload: { role: '核对发布清单' } });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('结果不明，背景没有留下');
      expect(await unknownLedger.get(unknownKey)).toMatchObject({ usedCalls: 1, unreportedTokenCalls: 1 });
      expect((await unknownLedger.get(unknownKey))?.entries['aeeis:bot-background:bot-background-unknown-1']?.state).toBe('unknown');
      expect(await repository.list()).toEqual([]);
    } finally { await unknownApp.close(); }
  });
});
