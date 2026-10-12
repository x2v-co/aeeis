import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { debugBundle } from '../src/runtime/run-debug.js';
import type { ModelAdapter } from '../src/runtime/model.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const plan = { summary: 'Summarize', nodes: [{ id: 'summarize', title: 'Summarize', instruction: 'Summarize the documents', dependsOn: [] }] };
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test/1' };
function adapter(verdict: 'accepted' | 'needs_revision'): ModelAdapter {
  return { pin, complete: async request => {
    if (request.system.includes('Independently review')) return { value: { verdict, summary: 'ok', issues: ['Says three documents but cites four'], confidence: 0.97 } };
    if (request.system.includes('Plan a real deliverable')) return { value: plan };
    return { value: { type: 'finish', title: 'Summary', content: 'Done', evidenceRefs: [] } };
  } };
}
async function drive(verdict: 'accepted' | 'needs_revision') {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-review-'));
  const repo = new FileRunRepository(directory); await repo.init();
  cleanup.push(async () => { await repo.close(); await rm(directory, { recursive: true, force: true }); });
  const engine = new AgentEngine(repo, adapter(verdict));
  const run = await engine.create({ goal: 'Summarize documents' }, 'alice', 'team-a');
  let status = await engine.advance(run.id);
  if (status === 'needs_approval') { await engine.command(run.id, 'approve', { planHash: (await repo.get(run.id)).plans[0]!.hash }); }
  for (let i = 0; i < 10 && !['succeeded', 'failed'].includes(status); i++) status = await engine.advance(run.id);
  return { status, run: await repo.get(run.id) };
}

describe('review verdict', () => {
  it('accepted review with minor issues succeeds and records them as warnings', async () => {
    const { status, run } = await drive('accepted');
    expect(status).toBe('succeeded');
    expect(run.error).toBeUndefined();
    expect(run.events.find(e => e.type === 'review.completed')?.data).toMatchObject({ verdict: 'accepted', warnings: ['Says three documents but cites four'] });
  });
  it('needs_revision still fails the run', async () => {
    const { status, run } = await drive('needs_revision');
    expect(status).toBe('failed');
    expect(run.error).toContain('requires revision');
  });
  it('debug bundle lists each lifecycle event exactly once', async () => {
    const { run } = await drive('accepted');
    const text = JSON.stringify(debugBundle(run));
    for (const type of ['run.created', 'review.completed']) expect(text.split(`"type":"${type}"`)).toHaveLength(2);
    expect(debugBundle(run).run).not.toHaveProperty('events');
  });
});
