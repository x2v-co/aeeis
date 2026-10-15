import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { HttpModelAdapter, ModelOutcomeUnknown, type ModelAdapter, type ModelRequest } from '../src/runtime/model.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup(model: ModelAdapter) {
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { model });
  const run = await engine.create({ goal: 'Report the observed Singapore weather', materials: [{ title: 'Weather observation', source: 'weather-api', content: 'Singapore: temperature 29 C; humidity 80%.' }] });
  await engine.advance(run.id);
  await engine.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash, planVersion: 1 });
  return { repository, engine, id: run.id, async drain() {
    for (let i = 0; i < 10; i++) if (['succeeded', 'failed', 'unknown'].includes(await engine.advance(run.id))) return repository.get(run.id);
    throw new Error('Weather run did not finish');
  } };
}
const plan = { summary: 'Weather report', nodes: [{ id: 'weather', title: 'Weather', instruction: 'Report the observed temperature', dependsOn: [] }] };
const invalid = 'source_11111111-2222-4333-8444-555555555555';

describe('production weather repair regressions', () => {
  it('retains the previous deliverable when a revision needs a finish repair whose outcome becomes unknown', async () => {
    let originalId = '';
    const complete = vi.fn(async (request: ModelRequest) => {
      const input = request.input as any;
      if (request.system.includes('Plan a real deliverable')) return { value: plan };
      if (request.system.includes('Independently review')) {
        originalId = input.artifacts[0].id;
        return { value: { verdict: 'needs_revision', summary: 'Explain humidity', issues: ['Include the humidity observation'] } };
      }
      if (input.finishRepair) throw new ModelOutcomeUnknown('Artifact repair timed out');
      return { value: { type: 'finish', title: 'Weather', content: input.outputRecovery ? 'Weather [evidence]' : 'Singapore: temperature 29 C.', evidenceRefs: input.availableEvidenceRefs } };
    });
    const fixture = await setup({ pin: { model: 'weather', endpoint: 'http://localhost', promptVersion: 'test' }, complete });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.partial).toBe(true);
    expect(run.calls.at(-1)!.state).toBe('unknown');
    expect(run.artifacts).toHaveLength(1);
    expect(run.artifacts[0]).toMatchObject({ id: originalId, content: 'Singapore: temperature 29 C.' });
    expect(run.limitations!.join(' ')).toContain('Include the humidity observation');
    expect(run.limitations!.join(' ')).toContain('Independent review was not completed');
    expect(complete).toHaveBeenCalledTimes(5);
  });

  it.each(['inline', 'inline-and-refs', 'structured'] as const)('strips invalid %s IDs without a model repair, retaining weather results and valid evidence', async shape => {
    const complete = vi.fn(async (request: ModelRequest) => {
      if (request.system.includes('Plan a real deliverable')) return { value: plan };
      if (request.system.includes('Independently review')) {
        const input = request.input as any;
        expect(input.artifacts[0].content).toContain('29 C');
        expect(input.artifacts[0].content).not.toContain(invalid);
        return { value: { verdict: 'accepted', summary: 'Weather values match received evidence' } };
      }
      const ref = (request.input as any).availableEvidenceRefs[0];
      return { value: { type: 'finish', title: 'Weather', content: `Singapore: temperature 29 C; humidity 80%. [${ref}] [${invalid}]`, evidenceRefs: shape === 'inline' ? [ref] : [ref, invalid],
        ...(shape === 'structured' ? { artifactType: 'project-pulse/1', structured: { schemaVersion: 'project-pulse/1', progress: [{ text: 'Singapore: temperature 29 C; humidity 80%.', evidenceRefs: [ref, invalid] }], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] } } : {}) } };
    });
    const fixture = await setup({ pin: { model: 'weather', endpoint: 'http://localhost', promptVersion: 'test' }, complete });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.partial).toBe(true);
    expect(run.artifacts[0]!.content).toContain('29 C');
    expect(run.artifacts[0]!.evidenceRefs).toEqual([run.context.sources[0]!.id]);
    expect(run.events.some(event => event.type === 'artifact.repair_requested')).toBe(false);
    expect(run.limitations!.join(' ')).toContain('Unavailable evidence refs removed');
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])('falls back to the original evidence-backed artifact after an oversized HTTP repair (stream=%s)', async stream => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetch = vi.fn(async (_url: unknown, options: any) => {
      const body = JSON.parse(options.body), input = JSON.parse(body.messages[1].content);
      let value: unknown;
      if (body.messages[0].content.includes('Plan a real deliverable')) value = plan;
      else if (input.finishRepair) value = { content: 'x'.repeat(70_000) };
      else {
        const evidenceRefs = [input.availableEvidenceRefs[0]];
        value = { type: 'finish', title: 'Weather', content: 'Temperature 29 C [evidence]', evidenceRefs, artifactType: 'project-pulse/1',
          structured: { schemaVersion: 'project-pulse/1', progress: [{ text: 'Singapore: temperature 29 C; humidity 80%.', evidenceRefs }], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] } };
      }
      const content = JSON.stringify(value);
      if (stream) return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
    });
    vi.stubGlobal('fetch', fetch);
    const fixture = await setup(new HttpModelAdapter('http://localhost/v1', 'weather', '', undefined, 1000, undefined, false, undefined, { stream }));
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.partial).toBe(true);
    expect(run.calls.at(-1)!.state).toBe('failed');
    expect(run.calls.some(call => call.state === 'unknown')).toBe(false);
    expect(run.artifacts[0]!.structured).toMatchObject({ progress: [{ text: 'Singapore: temperature 29 C; humidity 80%.' }] });
    expect(run.limitations!.join(' ')).toContain('byte cap');
    expect(run.limitations!.join(' ')).toContain('Independent review was not completed');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
