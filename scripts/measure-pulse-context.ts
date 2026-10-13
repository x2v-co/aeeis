/** Offline measurement through the real engine; no provider calls or credentials. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { materialContentHash } from '../src/runtime/materials.js';
import type { ModelAdapter } from '../src/runtime/model.js';

const baseline = process.argv.slice(2).find(argument => argument.startsWith('--baseline='))?.slice('--baseline='.length);
const fixturePath = process.argv.slice(2).find(argument => !argument.startsWith('--'));
const fixture = fixturePath ? (await readFile(resolve(fixturePath), 'utf8')).trimEnd() : undefined;
const temporaryModules: string[] = [];
try {
  let Engine = AgentEngine;
  if (baseline) {
    if (!/^[a-f0-9]{7,40}$/.test(baseline)) throw new Error('Baseline must be a local Git commit hash');
    const suffix = `.measure-${process.pid}`;
    const enginePath = resolve(`src/runtime/${suffix}-engine.ts`), materialsPath = resolve(`src/runtime/${suffix}-materials.ts`);
    temporaryModules.push(enginePath, materialsPath);
    await writeFile(materialsPath, execFileSync('git', ['show', `${baseline}:src/runtime/materials.ts`], { encoding: 'utf8' }));
    await writeFile(enginePath, execFileSync('git', ['show', `${baseline}:src/runtime/engine.ts`], { encoding: 'utf8' }).replace("'./materials.js'", `'./${suffix}-materials.js'`));
    Engine = (await import(pathToFileURL(enginePath).href)).AgentEngine;
  }
  for (const target of fixture ? [fixture.length] : [3_000, 10_000, 40_000]) {
    const short = target < 6_000;
    const header = short ? 'id,status,notes' : 'id,status,owner,deadline,progress,notes';
    const records = Array.from({ length: 200 }, (_, i) => short ? `${i},open,` : `${i},${i % 4 === 0 ? 'blocked' : 'open'},Owner ${i % 8},2026-10-${14 + i % 14},${i % 101},`);
    const padding = Math.max(0, target - [header, ...records].join('\n').length);
    const csv = fixture ?? [header, ...records.map((record, i) => record + 'migration evidence '.repeat(Math.ceil(padding / 200 / 19)).slice(0, Math.floor(padding / 200) + (i < padding % 200 ? 1 : 0)))].join('\n');
    const directory = await mkdtemp(join(process.cwd(), '.measure-pulse-'));
    const repository = new FileRunRepository(directory);
    await repository.init();
    const calls: unknown[] = [];
    const attempts = new Map<string, number>();
    const model: ModelAdapter = {
      pin: { model: 'offline-fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'measurement/1' },
      async complete(request) {
        const input = request.input as any;
        const phase = input.task ? 'executor' : request.system.includes('Independently review') ? 'reviewer' : 'planner';
        const promptChars = request.system.length + JSON.stringify(request.input).length;
        calls.push({ phase, task: input.task?.id, inputChars: JSON.stringify(request.input).length, promptChars, estimatedTokens: Math.ceil(promptChars / 4) });
        let value: unknown;
        if (phase === 'planner') value = { summary: 'Pulse', nodes: [{ id: 'inspect', title: 'Inspect CSV', instruction: 'Inspect project evidence', dependsOn: [] }, { id: 'pulse', title: 'Project Pulse', instruction: 'Summarize project evidence', dependsOn: ['inspect'] }] };
        else if (phase === 'reviewer') value = { verdict: 'accepted', summary: 'Verified', issues: [] };
        else {
          const count = attempts.get(input.task.id) ?? 0;
          attempts.set(input.task.id, count + 1);
          const ref = input.sourceCatalog[0].id;
          if (count < 2) value = { type: 'tool', tool: 'sources.read', argument: ref, offset: count * 20, limit: 20 };
          else {
            const structured = { schemaVersion: 'project-pulse/1', progress: [{ text: 'Migration work is open.', evidenceRefs: [ref] }], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] };
            value = { type: 'finish', title: 'Pulse', content: 'Migration work is open.\n' + 'Evidence checked. '.repeat(150), evidenceRefs: [ref], ...(input.expectedArtifactType ? { artifactType: 'project-pulse/1', structured } : {}) };
          }
        }
        return { value, usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    try {
      const engine = new Engine(repository, model);
      const run = await engine.create({ goal: 'Project Pulse', builtinSkill: 'project-pulse/1', materials: [{ title: 'tasks.csv', source: 'browser-file:tasks.csv', content: csv.length > 30_000 ? 'connector placeholder' : csv }] });
      // Uploads cap each material at 30k; larger source text can arrive from connectors.
      if (csv.length > 30_000) await repository.mutate(run.id, current => { const source = current.context.sources[0]!; source.content = csv; source.hash = source.contentHash = materialContentHash(csv); });
      await engine.advance(run.id);
      const proposed = await repository.get(run.id);
      await engine.command(run.id, 'approve', { planHash: proposed.plans[0]!.hash });
      for (let i = 0; i < 12; i++) {
        const status = await engine.advance(run.id);
        if (['succeeded', 'failed', 'unknown'].includes(status)) break;
      }
      const completed = await repository.get(run.id);
      console.log(JSON.stringify({ csvChars: csv.length, rows: 200, status: completed.status, error: completed.error, calls }));
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  }

} finally {
  for (const path of temporaryModules) await rm(path, { force: true });
}
