import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentEngine } from '../src/runtime/engine.js';
import { HttpModelAdapter } from '../src/runtime/model.js';
import { FileRunRepository } from '../src/runtime/repository.js';

afterEach(() => vi.unstubAllGlobals());
const plan = { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Summarize supplied evidence', dependsOn: [] }] };

it.each([
  { output: '```json\n' + JSON.stringify({ result: plan }) + '\n```', repair: false },
  { output: 'Here is the plan:\n' + JSON.stringify({ output: plan }) + '\nReview it.', repair: false },
  { output: '# Plan\n\n- Read sources\n- Write report', repair: true },
])('validates HTTP planner text after tolerant extraction (%j)', async ({ output, repair }) => {
  let requests = 0;
  const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: ++requests === 1 ? output : JSON.stringify(plan) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })));
  vi.stubGlobal('fetch', fetch);
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-http-plan-'));
  const repository = new FileRunRepository(directory); await repository.init();
  const engine = new AgentEngine(repository, new HttpModelAdapter('https://provider.example/v1', 'fixture', 'test-key'));
  try {
    const run = await engine.create({ goal: 'Report', materials: [{ title: 'Brief.md', source: 'upload', content: '# Brief\nEvidence supports the report.' }] });
    expect(await engine.advance(run.id)).toBe(repair ? 'planning' : 'needs_approval');
    if (repair) expect(await engine.advance(run.id)).toBe('needs_approval');
    const proposed = await repository.get(run.id);
    expect(proposed.plans[0]?.summary).toBe(plan.summary);
    expect(proposed.calls[0]?.rawOutput).toBe(output);
    expect(fetch).toHaveBeenCalledTimes(repair ? 2 : 1);
    if (repair) {
      expect(proposed.calls[0]?.validationErrors?.length).toBeGreaterThan(0);
      const body = JSON.parse(fetch.mock.calls[1]![1].body as string);
      const input = JSON.parse(body.messages[1].content);
      expect(input.plannerRepair).toMatchObject({ rawOutput: output, validationError: expect.stringContaining('invalid_type') });
      expect(proposed.modelUsage?.tokens).toBe(30);
    }
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

it('keeps non-planner HTTP JSON validation strict by default', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '# Not JSON' }, finish_reason: 'stop' }] }))));
  await expect(new HttpModelAdapter('https://provider.example/v1', 'fixture', 'test-key').complete({ system: 'test', input: {} })).rejects.toThrow('valid JSON');
});
