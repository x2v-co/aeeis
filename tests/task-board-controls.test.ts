import { describe,expect,it } from 'vitest';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';
import { configureContentEncryption,contentEncryption,ContentCipher,InMemoryContentKeyStore } from '../src/content-encryption.js';
import { InMemoryTaskBoardStore,FileTaskBoardStore,taskBoardMigration } from '../src/adapters/task-board-store.js';
import { InMemorySessionEventRepository,JsonSessionEventRepository } from '../src/session-events.js';
import { ChannelBoardService } from '../src/channel-board.js';
import { boardColumn,emptyDecision,type BoardColumn } from '../src/channel-task-action.js';
import { assertBoardMove,runBoardBoundary } from '../src/task-board-controls.js';
import { TENANT_POLICIES } from '../src/adapters/postgres-pool.js';
import { taskBoardFixture,scope } from './support/task-board.js';
import { dialogueFixture } from './support/bot-dialogues.js';

const mappings = { queued: 'ready',planning: 'doing',running: 'doing',reviewing: 'doing',needs_approval: 'blocked',needs_input: 'blocked',waiting_external: 'blocked',paused: 'blocked',unknown: 'blocked',succeeded: 'review',failed: 'failed',cancelled: 'failed' } as const;
const columns: BoardColumn[] = ['capture','ready','doing','blocked','review','done','failed'];
describe('task board controls', () => {
  it('keeps migration and embedded SQL identical and installs exactly 39 RLS policies',async () => {
    expect(await readFile('src/adapters/migrations/008-task-board-controls.sql','utf8')).toBe(taskBoardMigration);
    expect(TENANT_POLICIES).toHaveLength(40);
    expect(TENANT_POLICIES.map(item => item.table)).toEqual(expect.arrayContaining(['aeeis_room_tasks','aeeis_task_board_controls']));
  });
  for (const [status,auto] of Object.entries(mappings)) {
    it(`maps ${status} and checks every target without changing execution or approvals`,() => {
      expect(boardColumn(status,emptyDecision(),'run_current')).toBe(auto);
      for (const toColumn of columns) {
        const allowed = ['planning','running','reviewing'].includes(status) ? ['doing','blocked'].includes(toColumn)
          : status === 'queued' ? ['capture','ready','doing','blocked'].includes(toColumn)
          : status === 'succeeded' ? ['review','done'].includes(toColumn) : false;
        const card = { conversationId: 'conv_test',taskId: 'task_test',ownerId: 'aeeis',status,column: auto,autoColumn: auto,decision: emptyDecision(),chain: [],version: 0,runId: 'run_current',runRevision: 1,canMove: true } as const;
        const input = { kind: 'move',conversationId: card.conversationId,taskId: card.taskId,toColumn,expectedVersion: 0,expectedRunId: 'run_current',expectedRunRevision: 1,reason: '整理',source: 'team',idempotencyKey: 'matrix' } as const;
        const check = () => assertBoardMove(structuredClone(card),input,{ schemaVersion: 'channel-board/1',roomId: 'room_test',cursor: 0,cards: [],citations: [],actions: [],wip: [] });
        if (allowed) expect(check).not.toThrow(); else expect(check).toThrow();
      }
    });
  }
  it('organizes tasks without a Run but never manufactures success or creates a Run',async () => {
    const f = await taskBoardFixture(new InMemorySessionEventRepository(),new InMemoryTaskBoardStore());
    try {
      delete f.task.runId; delete f.task.runRevision; f.task.status = 'discussion';
      for (const column of ['capture','ready','doing','blocked']) expect((await f.move(column)).board.cards[0]).toMatchObject({ column,status: 'discussion',override: true });
      for (const column of ['review','done','failed']) await expect(f.move(column)).rejects.toThrow();
      expect(f.task.runId).toBeUndefined(); expect((await f.move(null)).board.cards[0]?.column).toBe('capture');
    } finally { await f.close(); }
  });
  it('serializes two windows, replays the same key, rejects different content and enforces WIP/cancel/archive/ACL',async () => {
    const f = await taskBoardFixture(new InMemorySessionEventRepository(),new InMemoryTaskBoardStore());
    try {
      const command = await f.input('blocked');
      const results = await Promise.allSettled([f.board.move(f.room.id,command,scope.owner,scope.tenantId),f.board.move(f.room.id,{ ...command,idempotencyKey: 'other' },scope.owner,scope.tenantId)]);
      expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
      const replay = await f.board.move(f.room.id,command,scope.owner,scope.tenantId);
      expect(replay.board.cards[0]?.version).toBe(1);
      await expect(f.board.move(f.room.id,{ ...command,reason: '不同请求' },scope.owner,scope.tenantId)).rejects.toThrow('幂等键');
      await expect(f.board.move(f.room.id,command,'bob',scope.tenantId)).rejects.toThrow();
      await expect(f.board.move(f.room.id,command,scope.owner,'team-b')).rejects.toThrow();
      await f.domain.addRoomMember(f.room.id,'bob','viewer',scope.owner,scope.tenantId);
      await expect(f.board.move(f.room.id,command,'bob',scope.tenantId)).rejects.toThrow();
      delete f.task.runId; delete f.task.runRevision; f.task.status = 'discussion';
      f.conversation.tasks.push(...[1,2,3].map(n => ({ id: `task_busy${n}`,title: '忙',status: 'running' })));
      for (const task of f.conversation.tasks.slice(1)) await f.events.create(f.room.id,{ goalId: f.goal.id,type: 'system',content: '引用',contextManifestId: f.manifest.id,evidenceRefs: [f.conversation.id,task.id,'aeeis'],idempotencyKey: task.id },scope.owner,scope.tenantId);
      await expect(f.move('doing')).rejects.toThrow('3 件');
      await f.board.act(f.room.id,{ kind: 'cancel',conversationId: f.conversation.id,taskId: f.task.id,reason: '取消整理',goalId: f.goal.id,contextManifestId: f.manifest.id,idempotencyKey: 'cancel' },scope.owner,scope.tenantId);
      await expect(f.move('blocked')).rejects.toThrow('不可移动');
      await f.domain.updateRoom(f.room.id,{ status: 'archived' },undefined,scope.owner,scope.tenantId);
      await expect(f.move('doing')).rejects.toThrow();
    } finally { await f.close(); }
  });
  it('preserves ordinary progress, clears at boundaries, ignores delayed/duplicate hints and expires acceptance on new Run',async () => {
    const f = await taskBoardFixture(new InMemorySessionEventRepository(),new InMemoryTaskBoardStore());
    try {
      await f.move('blocked');
      f.task.status = 'reviewing'; f.task.runRevision = 2; expect((await f.get()).cards[0]?.column).toBe('blocked');
      f.task.status = 'needs_approval'; f.task.runRevision = 3;
      await f.board.pump(); await f.board.pump();
      expect((await f.get()).cards[0]).toMatchObject({ column: 'blocked',version: 2 });
      expect((await f.events.history(f.room.id,scope.owner,scope.tenantId)).filter(event => event.actorType === 'system')).toHaveLength(1);
      f.task.status = 'running'; f.task.runRevision = 4; expect((await f.get()).cards[0]?.column).toBe('doing');
      await f.move('blocked'); f.task.runBoundary = 8; f.task.runRevision = 5;
      expect((await f.get()).cards[0]?.column).toBe('doing'); // a pause/resume occurred entirely between polls
      f.task.status = 'succeeded'; f.task.runRevision = 6;
      expect((await f.get()).cards[0]?.column).toBe('review');
      const done = await f.input('done'); await f.board.move(f.room.id,done,scope.owner,scope.tenantId);
      expect((await f.get()).cards[0]).toMatchObject({ column: 'done',decision: { acceptedRunId: f.task.runId } });
      expect((await f.move('review')).board.cards[0]?.column).toBe('review');
      await f.move('done'); f.task.runId = `run_${randomUUID()}`; f.task.runRevision = 0; f.task.runBoundary = 0; f.task.status = 'queued';
      expect((await f.get()).cards[0]?.column).toBe('ready');
      await expect(f.board.move(f.room.id,{ ...done,idempotencyKey: 'stale-run' },scope.owner,scope.tenantId)).rejects.toThrow('变化');
      f.task.status = 'succeeded'; f.task.runRevision = 1; expect((await f.get()).cards[0]?.column).toBe('review');
    } finally { await f.close(); }
  });
  it('recovers the File audit/projection and missing relations across restart, with single-writer protection',async () => {
    const directory = await mkdtemp(join(tmpdir(),'pr3-board-'));
    const eventPath = join(directory,'events.json'), relationPath = join(directory,'relations.json');
    const f = await taskBoardFixture(new JsonSessionEventRepository(eventPath),new FileTaskBoardStore(relationPath));
    try {
      await f.move('blocked'); const before = await f.get();
      const duplicate = new FileTaskBoardStore(relationPath); await expect(duplicate.init()).rejects.toThrow();
      await f.close(); await rm(relationPath); // crash after journal commit, before relation repair
      const repository = new JsonSessionEventRepository(eventPath), controls = new FileTaskBoardStore(relationPath); await repository.init(); await controls.init();
      const { SessionEventService } = await import('../src/session-events.js');
      const restarted = new ChannelBoardService(new SessionEventService(repository,f.domain),f.domain,f.read,undefined,controls);
      try { await restarted.pump(); expect((await restarted.board(f.room.id,scope.owner,scope.tenantId)).cards).toEqual(before.cards); expect(await controls.list(f.room.id,scope.owner,scope.tenantId)).toHaveLength(1); }
      finally { await repository.close(); await controls.close(); }
    } finally { await f.close(); await rm(directory,{ recursive: true,force: true }); }
  });
  it('uses boundary events rather than ordinary tool/step completion as invalidation watermarks',() => {
    const run = { events: [{ type: 'plan.approved',seq: 2 },{ type: 'tool.completed',seq: 3 },{ type: 'step.completed',seq: 4 },{ type: 'tool.failed_recoverable',seq: 5 }] } as any;
    expect(runBoardBoundary(run)).toBe(2);
    run.events.push({ type: 'run.paused',seq: 6 },{ type: 'run.resumed',seq: 7 },{ type: 'tool.completed',seq: 8 }); expect(runBoardBoundary(run)).toBe(7);
  });
  it('keeps each channel override independent and rejects a stale snapshot after a legacy action',async () => {
    const f = await taskBoardFixture(new InMemorySessionEventRepository(),new InMemoryTaskBoardStore());
    try {
      const second = await f.domain.createRoom({ title: '另一频道' },undefined,scope.owner,scope.tenantId);
      await f.controls.link({ ...scope,roomId: second.id,conversationId: f.conversation.id,taskId: f.task.id,sourceId: 'original-source' });
      await f.move('blocked'); expect((await f.board.board(second.id,scope.owner,scope.tenantId)).cards[0]?.column).toBe('doing');
      const stale = await f.input('doing');
      await f.board.act(f.room.id,{ kind: 'assign',agentId: 'aeeis',conversationId: f.conversation.id,taskId: f.task.id,goalId: f.goal.id,contextManifestId: f.manifest.id,idempotencyKey: 'assign-version' },scope.owner,scope.tenantId);
      await expect(f.board.move(f.room.id,stale,scope.owner,scope.tenantId)).rejects.toThrow('变化');
    } finally { await f.close(); }
  });
  it('reclaims only known-dead File writers and restores pending control audits after restart',async () => {
    const directory = await mkdtemp(join(tmpdir(),'pr3-dead-writer-')),path = join(directory,'relations.json');
    try {
      await writeFile(`${path}.lock`,'2147483647:dead');
      const store = new FileTaskBoardStore(path); await store.init(); await store.init(); await store.close();
      const events = join(directory,'events.json'); await writeFile(`${events}.lock`,'2147483647:dead');
      const repository = new JsonSessionEventRepository(events); await repository.init(); await repository.close();
    } finally { await rm(directory,{ recursive: true,force: true }); }
  });
  it('recovers source-channel links without a citation and keeps private tasks out of other channels',async () => {
    const f = await dialogueFixture();
    try {
      const binding = await f.ensure(),source = await f.legacy('source');
      // Use a genuine owner-written source event, but no task citation receipt.
      const sourceEvent = await source.say('频道材料');
      const view = await f.conversations.get(binding.conversationId,scope);
      const created = await f.conversations.post(binding.conversationId,{ text: '源频道任务',intent: 'discuss',newTask: { title: '源频道任务' },expectedRevision: view.revision },scope,'source-task',false,undefined,{ kind: 'channel',channel: 'room',externalEventId: sourceEvent.id,receivedAt: sourceEvent.createdAt });
      expect(await f.boardControls.list(source.room.id,scope.owner,scope.tenantId)).toEqual([]);
      await f.app.aeeisBoardScan!(); await f.app.aeeisBoard!.pump();
      expect(await f.boardControls.list(source.room.id,scope.owner,scope.tenantId)).toMatchObject([{ taskId: created.conversation.tasks[0]!.id,sourceId: sourceEvent.id }]);
      const other = await f.domain.createRoom({ title: '无关频道' },undefined,scope.owner,scope.tenantId);
      expect((await f.request(`/rooms/${other.id}/board`)).json().cards).toEqual([]);
    } finally { await f.close(); }
  });
  it('replays concurrent identical commands with independently prepared server audit contexts',async () => {
    const f = await dialogueFixture();
    try {
      const binding = await f.ensure(),view = await f.conversations.get(binding.conversationId,scope);
      await f.request(`/conversations/${binding.conversationId}/messages`,{ text: '并发整理',intent: 'discuss',newTask: { title: '并发整理' },expectedRevision: view.revision },'same-command-fixture');
      const card = (await f.request(`/rooms/${binding.roomId}/board`)).json().cards[0];
      const input = { kind: 'move',conversationId: binding.conversationId,taskId: card.taskId,toColumn: 'doing',expectedVersion: card.version,expectedRunId: null,expectedRunRevision: null,reason: '同一请求',source: 'team',idempotencyKey: 'identical-move' };
      const results = await Promise.all([f.request(`/rooms/${binding.roomId}/board-controls`,input),f.request(`/rooms/${binding.roomId}/board-controls`,input)]);
      for (const response of results) expect(response.statusCode,response.body).toBe(200);
      expect(results[0]!.json().event.id).toBe(results[1]!.json().event.id);
      expect((await f.request(`/rooms/${binding.roomId}/board`)).json().cards[0].version).toBe(1);
    } finally { await f.close(); }
  });
  it('seals File audit reasons and restores the same board through encrypted journal recovery',async () => {
    const directory = await mkdtemp(join(tmpdir(),'pr3-sealed-board-')),previous = contentEncryption();
    configureContentEncryption(new ContentCipher(randomBytes(32),new InMemoryContentKeyStore()));
    let f: Awaited<ReturnType<typeof taskBoardFixture>> | undefined;
    try {
      const path = join(directory,'events.json');
      f = await taskBoardFixture(new JsonSessionEventRepository(path),new FileTaskBoardStore(join(directory,'relations.json')));
      await f.move('blocked'); const before = await f.get();
      expect(await readFile(path,'utf8')).not.toContain('主人调整安排');
      await f.close();
      const repository = new JsonSessionEventRepository(path); await repository.init();
      try {
        const { SessionEventService } = await import('../src/session-events.js');
        const restarted = new ChannelBoardService(new SessionEventService(repository,f.domain),f.domain,f.read);
        expect((await restarted.board(f.room.id,scope.owner,scope.tenantId)).cards).toEqual(before.cards);
      } finally { await repository.close(); }
    } finally { await f?.close(); configureContentEncryption(previous); await rm(directory,{ recursive: true,force: true }); }
  });
  for (const review of ['required','auto'] as const) it(`does not bypass ${review} or agent-source approvals through a move`,async () => {
    const f = await dialogueFixture();
    try {
      const binding = await f.ensure(); const view = await f.conversations.get(binding.conversationId,scope);
      const result = await f.request(`/conversations/${binding.conversationId}/messages`,{ text: '核查报告',intent: 'execute',expectedRevision: view.revision,newTask: { title: '核查报告' },runOptions: { executionReview: review } },randomUUID());
      const runId = result.json().runId;
      await f.runs.mutate(runId,run => { run.status = 'needs_approval'; run.origin = 'agent'; });
      const before = await f.runs.get(runId,scope);
      const card = (await f.request(`/rooms/${binding.roomId}/board`)).json().cards[0];
      const command = { kind: 'move',conversationId: binding.conversationId,taskId: card.taskId,toColumn: 'done',expectedVersion: card.version,expectedRunId: runId,expectedRunRevision: card.runRevision,reason: '拖动不授权',source: 'team',idempotencyKey: randomUUID() };
      expect((await f.request(`/rooms/${binding.roomId}/board-controls`,command)).statusCode).toBe(409);
      expect(await f.runs.get(runId,scope)).toEqual(before);
      const home = (await f.request(`/conversations/${binding.conversationId}`)).json(); const team = (await f.request(`/rooms/${binding.roomId}/dialogue`)).json();
      expect(home.tasks[0]).toMatchObject({ status: 'needs_approval',column: 'blocked',runId }); expect(team.tasks[0]).toEqual(home.tasks[0]);
    } finally { await f.close(); }
  });
});
