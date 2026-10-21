import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { PiModelAdapter } from '../src/adapters/pi/model.js';
import { AgentEngine, digest } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { ToolGateway } from '../src/integrations.js';
import { piModel, piPin, recordingFetch, responses } from '../tests/support/pi-fixture.js';

const dataRoot = fileURLToPath(new URL('../data/', import.meta.url));
await mkdir(dataRoot, { recursive: true });
const output = await mkdtemp(join(dataRoot, 'pi-demo-'));
const statusPath = join(output, 'service-status.json');
const input = z.object({ key: z.literal('status') }).strict();
const statusSchema = z.object({ service: z.string(), status: z.literal('green'), note: z.string() }).strict();
await writeFile(statusPath, JSON.stringify({ service: 'aeeis-local-demo', status: 'green', note: '仅为本地演示数据，不代表生产健康状态。' }, null, 2) + '\n', { flag: 'wx' });
const timeline: string[] = [];
function log(label: string, detail?: unknown) {
  const text = `[${new Date().toISOString()}] ${label}${detail === undefined ? '' : '\n' + JSON.stringify(detail, null, 2)}`;
  timeline.push(text);
  console.log(text);
}
async function step(label: string, detail?: unknown) { log(label, detail); await pause(700); }

let reads = 0;
let observed: z.infer<typeof statusSchema> | undefined;
const toolId = 'demo.read_status';
const evidenceRef = 'local-status-1';
const tools: ToolGateway = {
  async listTools() {
    return [{ id: toolId, version: '1', description: 'Read the demo service-status JSON file', capabilities: ['read'], inputSchema: z.toJSONSchema(input, { io: 'input' }), outputSchema: z.toJSONSchema(statusSchema) }];
  },
  async invoke(request) {
    assert.equal(request.toolId, toolId);
    assert.equal(request.toolVersion, '1');
    input.parse(request.input);
    const startedAt = new Date().toISOString();
    observed = statusSchema.parse(JSON.parse(await readFile(statusPath, 'utf8')));
    reads++;
    log('工具真实执行：读取本次演示目录里的 JSON 文件', { file: statusPath, input: request.input, result: observed, idempotencyKey: request.idempotencyKey, readCount: reads });
    return {
      status: 'completed', output: observed, outputRefs: [evidenceRef],
      receipt: {
        schemaVersion: 'receipt/1', receiptId: `receipt_${randomUUID()}`, provider: 'local-demo-file', operation: request.toolId,
        requestHash: digest(request), responseHash: digest(observed), inputRefs: [request.taskId], outputRefs: [evidenceRef],
        capabilitiesUsed: ['read'], startedAt, completedAt: new Date().toISOString(), status: 'completed',
      },
    };
  },
};
const plan = { summary: '读取本地演示服务状态，输出引用工具回执的报告。', nodes: [{ id: 'inspect', title: '读取并报告状态', instruction: '调用获批的 demo.read_status，并引用实际工具输出。', dependsOn: [] }] };
const transport = recordingFetch((request, index) => {
  const phase = ['计划', '原生工具调用', '报告', '独立审核'][index];
  log(`离线 HTTP fixture #${index + 1}：${phase ?? '意外调用'}`, {
    endpoint: request.url, model: request.body.model,
    nativeTools: (request.body.tools as Array<{ name?: string }> | undefined)?.map(tool => tool.name) ?? [],
  });
  switch (index) {
    case 0: return responses(plan);
    case 1: return responses(undefined, { calls: [{ name: 'read_status', arguments: { input: { key: 'status' }, purpose: '读取已批准的本地演示状态' } }] });
    case 2:
      assert.ok(observed, 'The report must wait for the actual file read');
      return responses({ type: 'finish', title: '本地服务状态报告', content: `本地演示服务 ${observed.service} 的状态为 ${observed.status}。\n证据来自已执行的 demo.read_status 工具，引用 ${evidenceRef}。\n${observed.note}`, evidenceRefs: [evidenceRef] });
    case 3: return responses({ verdict: 'accepted', summary: '演示审核结果：报告引用了本轮实际文件读取产生的工具证据。', issues: [] });
    default: throw new Error('Unexpected extra model request; offline fixture has no live fallback');
  }
});
const model = new PiModelAdapter({
  pin: piPin, model: piModel, apiKey: 'fixture-key', fetch: transport.fetch,
  tools: [{ name: 'read_status', toolId, toolVersion: '1', description: 'Read the local demo status', input }],
});
const repositoryPath = join(output, 'run-store');
const repo = new FileRunRepository(repositoryPath);
await repo.init();
let repoClosed = false;
try {
  log('离线演示开始', {
    real: ['pi/OpenAI SDK SSE 解析', 'AEEIS Engine 审批与执行', '本地文件读取', '持久化回执和运行状态'],
    simulated: ['模型的计划、原生工具提议、报告与审核回答均由 fixture 生成', '模型用量为合成数据'],
    approval: '脚本仅对本次新建的演示 Run 自动提交审批；不会批准其他任务。',
    liveModelRequests: 0, output,
  });
  const engine = new AgentEngine(repo, { model, tools });
  const run = await engine.create({ goal: '读取本地演示服务状态并生成带证据引用的报告', allowedTools: [`${toolId}@1`], modelBudget: { tokens: 1000 } });
  await step('1. 已创建 Run', { runId: run.id, status: run.status });
  assert.equal(await engine.advance(run.id), 'needs_approval');
  const planned = await repo.get(run.id);
  const proposed = planned.plans.at(-1)!;
  await step('2. 计划已持久化，等待审批；工具尚未执行', { status: planned.status, plan: proposed, fileReads: reads });
  assert.equal(reads, 0);
  await assert.rejects(engine.command(run.id, 'approve', { planHash: 'wrong-hash', planVersion: proposed.version }));
  assert.equal(await engine.advance(run.id), 'needs_approval');
  await step('3. 错误 planHash 被拒绝，继续 advance 也不能越过审批', { status: (await repo.get(run.id)).status, fileReads: reads, modelRequests: transport.requests.length });
  await engine.command(run.id, 'approve', { planHash: proposed.hash, planVersion: proposed.version });
  await step('4. 脚本批准本次演示的精确计划版本', { planHash: proposed.hash, planVersion: proposed.version });
  await engine.advance(run.id);
  const pending = await repo.get(run.id);
  assert.ok(pending.pendingTool);
  assert.equal(reads, 0);
  await step('5. 原生工具调用已变成持久化待执行操作；尚未读文件', { status: pending.status, pendingTool: pending.pendingTool, fileReads: reads });
  await engine.advance(run.id);
  const executed = await repo.get(run.id);
  assert.equal(reads, 1);
  assert.equal(executed.toolReceipts.length, 1);
  assert.equal(executed.toolReceipts[0]?.authorization?.decision, 'authorized');
  await step('6. 工具执行完毕，回执和授权决定已保存', { receipt: executed.toolReceipts[0], fileReads: reads });
  for (let tick = 0; tick < 10; tick++) {
    const state = await engine.advance(run.id);
    const current = await repo.get(run.id);
    log('后续推进', { status: state, phases: current.calls.map(call => `${call.phase}:${call.state}`), artifacts: current.artifacts.length });
    if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(state)) break;
    await pause(500);
  }
  const completed = await repo.get(run.id);
  assert.equal(completed.status, 'succeeded', completed.error);
  assert.equal(completed.review?.verdict, 'accepted');
  assert.equal(transport.requests.length, 4);
  assert.equal(reads, 1);
  await step('7. 报告与审核完成', { status: completed.status, artifacts: completed.artifacts, review: completed.review, syntheticUsage: completed.modelUsage });
  await repo.close();
  repoClosed = true;
  const reopened = new FileRunRepository(repositoryPath);
  await reopened.init();
  try {
    const restored = await reopened.get(run.id);
    assert.equal(restored.status, 'succeeded');
    assert.equal(restored.toolReceipts.length, 1);
    await step('8. 关闭并重新打开仓库，确认结果仍在；不重新执行工具', { status: restored.status, receipts: restored.toolReceipts.length, fileReads: reads });
  } finally { await reopened.close(); }
  await writeFile(join(output, 'run.json'), JSON.stringify(completed, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(output, 'events.json'), JSON.stringify(completed.events, null, 2) + '\n', { flag: 'wx' });
  const report = `# 本地 pi 接入演示\n\n- Run：\`${run.id}\`\n- 最终状态：**${completed.status}**\n- 离线模型响应：${transport.requests.length} 次；真实外部模型请求：0 次\n- 实际本地文件读取：${reads} 次\n- 工具回执：${completed.toolReceipts.length} 条；审核：${completed.review?.verdict}\n- token：${completed.modelUsage?.tokens}（合成 fixture 用量，不是账单）\n\n## 产物\n\n${completed.artifacts.map(artifact => `### ${artifact.title}\n\n${artifact.content}\n\n证据：${artifact.evidenceRefs.join(', ')}`).join('\n\n')}\n\n## 演示边界\n\n模型回答和审核为预设 fixture，不代表真实模型的推理质量。SDK 解析、审批拒绝/放行、工具读取、回执落盘和仓库重开均真实执行。\n\n完整过程见 timeline.log，运行状态见 run.json，事件见 events.json。\n`;
  await writeFile(join(output, 'report.md'), report, { flag: 'wx' });
  log('CASE PASSED：所有断言通过', { runId: run.id, status: completed.status, fixtureResponses: transport.requests.length, fileReads: reads, report: join(output, 'report.md') });
} finally {
  try { if (!repoClosed) await repo.close(); }
  finally { await writeFile(join(output, 'timeline.log'), timeline.join('\n\n') + '\n', { flag: 'wx' }); }
}
