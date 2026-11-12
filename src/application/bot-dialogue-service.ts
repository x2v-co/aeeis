import { z } from 'zod';
import { boardColumn } from '../channel-task-action.js';
import { followupHash, idempotencyKeySchema } from '../runtime/thread-followups.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Ownership, Principal } from '../security/principal.js';
import type { BotDialogue, BotDialogueStore } from '../bot-dialogues.js';
import type { ConversationStore, ConversationMessage } from '../conversations.js';
import { visibleConversationMessages } from '../conversations.js';
import type { OwnedBotStore } from '../owned-bots.js';
import type { SessionEvent, SessionEventService } from '../session-events.js';
import { BotReplyNotice, Conflict } from '../runtime/engine.js';
import { NotFound } from '../runtime/repository.js';
import type { AeeisService } from './aeeis-service.js';
import type { ConversationService } from './conversation-service.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const importedId = (room: string, event: string) => `message_${hash(`${room}:${event}`)}`;
export class BotDialogueService {
  constructor(readonly store: BotDialogueStore, private readonly conversations: ConversationService,
    private readonly aggregates: ConversationStore, private readonly domain: AeeisService,
    private readonly events: SessionEventService, private readonly bots?: OwnedBotStore) {}

  async inventory(scope: Ownership) {
    const bindings = await this.store.list(scope), operations = await this.store.operations(scope);
    return { items: bindings.map(binding => ({ botId: binding.botId, conversationId: binding.conversationId, roomId: binding.roomId,
      phase: binding.phase, version: binding.version, sourceRoomIds: binding.state.roomIds, conflict: binding.state.conflict,
      conflictRoomIds: binding.state.conflictRoomIds ?? [], pendingOperations: operations.filter(op => op.botId === binding.botId && op.status === 'pending').length })) };
  }
  async bot(botId: string, scope: Ownership) {
    if (botId === 'aeeis') return { id: botId, name: 'AEEIS', autonomy: 'reply' };
    const bot = await this.bots?.get(botId).catch(() => undefined);
    if (!bot || bot.owner !== scope.owner || bot.tenantId !== scope.tenantId || bot.retiredAt) throw new NotFound('Unknown Bot');
    return bot;
  }
  async binding(roomId: string, scope: Ownership): Promise<BotDialogue | undefined> {
    const alias = (await this.store.aliases(scope)).find(a => a.aliasRoomId === roomId);
    return (await this.store.list(scope)).find(b => b.roomId === (alias?.canonicalRoomId ?? roomId) || b.state.roomIds.includes(roomId));
  }
  private ready(binding: BotDialogue): void {
    if (binding.phase !== 'ready') throw new Conflict(binding.phase === 'conflict' ? '私聊历史存在身份或受众冲突，需要人工整理' : '此对话正在整理，请稍后重试');
  }
  /** Shared fence used by both frontends, background replies, and legacy Room writers. */
  async conversationWrite<T>(conversationId: string, scope: Ownership, work: () => Promise<T>): Promise<T> {
    return this.store.withOwner(scope, async () => {
      const binding = (await this.store.list(scope)).find(b => b.conversationId === conversationId);
      if (binding) { this.ready(binding); await this.bot(binding.botId, scope); await this.domain.assertRoomEventWriter(binding.roomId, scope.owner, scope.tenantId); }
      return work();
    });
  }
  async roomWrite<T>(roomId: string, actor: string, tenantId: string, work: () => Promise<T>): Promise<T> {
    const room = await this.domain.getRoomForPrincipal(roomId, actor, tenantId);
    const scope = { owner: room.owner ?? 'owner', tenantId };
    return this.store.withOwner(scope, async () => {
      if (await this.binding(roomId, scope)) throw new Conflict('此私聊已统一，请通过 /rooms/:id/dialogue/messages 发送；旧历史只读');
      return work();
    });
  }
  async ensure(botId: string, scope: Ownership, actor?: Principal): Promise<BotDialogue> {
    const bot = await this.bot(botId, scope);
    return this.store.withOwner(scope, async () => {
      let binding = (await this.store.list(scope)).find(b => b.botId === botId);
      if (binding?.phase === 'ready') {
        await this.store.operation({ ...scope, botId, operationKey: `ensure:${botId}`, kind: 'ensure', sourceId: botId, targetId: binding.roomId, status: 'completed', state: {} });
        return binding;
      }
      if (binding?.phase === 'conflict') { this.ready(binding); }
      if (!binding) {
        // Use the existing AEEIS claim rule, but never guess between multiple unclaimed histories.
        const all = await this.aggregates.list(scope);
        const unclaimed = all.filter(c => !c.agentId);
        if (botId === 'aeeis' && !all.some(c => c.agentId === botId) && unclaimed.length > 1) throw new Conflict('存在多条未认领对话，请先确认 AEEIS 生命线');
        const conversation = await this.conversations.create({ agentId: botId, title: bot.name,
          ...(botId === 'aeeis' && !all.some(c => c.agentId === botId) && unclaimed[0] ? { claimId: unclaimed[0].id } : {}) }, scope, actor);
        const candidates: string[] = [], conflictRoomIds: string[] = []; let conflict = false;
        // No UI list limit: scans every owned Room, including archived ones.
        const rooms = (await this.domain.listRooms(scope.owner, scope.tenantId)).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        for (const room of rooms) {
          if (room.chat !== 'direct' && (room.chat !== undefined || room.description !== '私聊')) continue;
          const members = await this.domain.listRoomMembers(room.id, scope.owner, scope.tenantId);
          if (!members.some(m => m.principalId === botId)) continue;
          const history = await this.events.migrationHistory(room.id, scope.owner, scope.tenantId);
          const safe = members.filter(m => m.status === 'active' && m.principalId !== scope.owner).length === 1
            && members.every(m => m.principalId === scope.owner || m.principalId === botId)
            && history.every(e => e.owner === scope.owner && e.tenantId === scope.tenantId
              && (e.actorId === scope.owner || e.actorId === botId || e.actorType === 'system')
              && e.audienceSnapshot.participants.length === 2
              && e.audienceSnapshot.participants.some(p => p.principalId === scope.owner) && e.audienceSnapshot.participants.some(p => p.principalId === botId)
              && e.audienceSnapshot.participants.every(p => p.tenantId === scope.tenantId && (p.principalId === scope.owner || p.principalId === botId)));
          if (safe) candidates.push(room.id); else { conflict = true; conflictRoomIds.push(room.id); }
        }
        const at = new Date().toISOString();
        binding = { ...scope, botId, conversationId: conversation.id, roomId: candidates[0] ?? `room_${randomUUID()}`,
          phase: conflict ? 'conflict' : 'preparing', version: 0, state: { roomIds: candidates, revision: conversation.revision, highWater: {}, ...(conflict ? { conflict: 'audience', conflictRoomIds } : {}) }, createdAt: at, updatedAt: at };
        await this.store.put(binding);
        await this.store.operation({ ...scope, botId, operationKey: `ensure:${botId}`, kind: 'ensure', sourceId: botId, targetId: binding.roomId, status: conflict ? 'conflict' : 'pending', state: {} });
        this.assertNoConflict(binding);
      }
      const canonical = await this.domain.ensureDialogueRoom(binding.roomId, bot.name, scope.owner, scope.tenantId);
      if (!(await this.domain.listRoomMembers(canonical.id, scope.owner, scope.tenantId)).some(m => m.principalId === botId && m.status === 'active')) await this.domain.ensureDialogueRoomMember(canonical.id, botId, scope);
      binding.phase = 'backfilling'; binding.version++; await this.store.put(binding);
      for (const roomId of binding.state.roomIds) {
        const events = await this.events.migrationHistory(roomId, scope.owner, scope.tenantId);
        for (const event of events) await this.importEvent(binding, event);
        binding.state.highWater[roomId] = events.at(-1)?.sequence ?? 0;
        await this.store.put(binding);
        if (roomId !== binding.roomId) await this.store.alias({ ...scope, aliasRoomId: roomId, canonicalRoomId: binding.roomId, botId });
      }
      // Same owner fence covers all legacy writes; still verify the captured high-water mark.
      for (const roomId of binding.state.roomIds) {
        if (((await this.events.migrationHistory(roomId, scope.owner, scope.tenantId)).at(-1)?.sequence ?? 0) !== binding.state.highWater[roomId]) throw new Conflict('私聊历史已变化，请重试整理');
      }
      binding.phase = 'ready'; binding.version++; binding.updatedAt = new Date().toISOString(); await this.store.put(binding);
      await this.store.operation({ ...scope, botId, operationKey: `ensure:${botId}`, kind: 'ensure', sourceId: botId, targetId: binding.roomId, status: 'completed', state: {} });
      return binding;
    });
  }
  private assertNoConflict(binding: BotDialogue): void { if (binding.phase === 'conflict') this.ready(binding); }
  private async importEvent(binding: BotDialogue, event: SessionEvent): Promise<void> {
    const { owner, tenantId, botId, conversationId } = binding;
    const scope = { owner, tenantId }, sourceId = `${event.roomId}:${event.id}`, operationKey = `import:${sourceId}`;
    const id = importedId(event.roomId, event.id);
    let mappedId = id;
    const mappings = await this.store.operations(scope);
    const operation = { ...scope, botId, operationKey, kind: 'import' as const, sourceId, targetId: id, state: { sequence: event.sequence, hash: event.contentHash } };
    await this.store.operation({ ...operation, status: 'pending' });
    // Pure aggregate import: never calls post(), the model, the dispatcher or approval commands.
    await this.aggregates.mutate(conversationId, scope, current => {
      if (current.messages.some(m => m.source?.kind === 'room' && m.source.roomId === event.roomId && m.source.eventId === event.id)) return;
      const existingDelivery = current.messages.find(m => m.source?.kind === 'channel' && m.source.channel === 'room' && m.source.externalEventId === event.id);
      if (existingDelivery && event.operation === 'publish') { mappedId = existingDelivery.id; return; }
      let targetMessageId: string | undefined;
      if (event.targetEventId) {
        const mapped = mappings.find(op => op.kind === 'import' && op.sourceId === `${event.roomId}:${event.targetEventId}`)?.targetId;
        const previous = current.messages.find(m => m.id === mapped || m.source?.kind === 'room' && m.source.eventId === event.targetEventId && m.source.roomId === event.roomId);
        if (!previous) throw new Conflict('Unknown imported revision target');
        targetMessageId = previous.source?.kind === 'room' ? previous.source.targetMessageId ?? previous.id : previous.id;
      }
      const reply = event.evidenceRefs.map(ref => importedId(event.roomId, ref)).find(ref => current.messages.some(m => m.id === ref));
      const referenceOnly = !['message', 'canonical_response'].includes(event.type) || event.actorType === 'system';
      const message: ConversationMessage = { id, keyHash: hash(operationKey), requestHash: event.contentHash,
        role: referenceOnly ? 'notification' : 'user', speaker: { role: event.actorId === owner ? 'user' : 'agent', id: event.actorId },
        text: event.operation === 'retract' ? '（已撤回）' : event.content, createdAt: event.createdAt,
        ...(reply && !targetMessageId ? { replyTo: reply } : {}),
        source: { kind: 'room', roomId: event.roomId, eventId: event.id, hash: event.contentHash, operation: event.operation, referenceOnly, eventType: event.type, revision: event.revision, evidenceRefs: event.evidenceRefs, actorType: event.actorType, ...(targetMessageId ? { targetMessageId } : {}) },
        route: { status: 'general', reason: 'unassigned', taskIds: [], candidateTaskIds: [], focusEffect: 'keep' } };
      current.messages.push(message);
    });
    await this.store.operation({ ...operation, targetId: mappedId, status: 'completed' });
  }
  async get(roomId: string, scope: Ownership, actor?: Principal, before?: string) {
    await this.domain.getRoom(roomId, scope.owner, scope.tenantId);
    const binding = await this.binding(roomId, scope);
    if (!binding) throw new NotFound('Room has no Bot dialogue');
    // Reads remain available during recovery; writes require ready.
    const view = await this.conversations.get(binding.conversationId, scope, actor, before);
    return { ...view, tasks: view.tasks.map(task => ({ ...task, column: boardColumn(task.status) })), roomId: binding.roomId, bindingVersion: binding.version, bindingPhase: binding.phase };
  }
  async post(roomId: string, input: unknown, scope: Ownership, key: unknown, canExecute: boolean, actor?: Principal) {
    await this.domain.assertRoomEventWriter(roomId, scope.owner, scope.tenantId);
    const binding = await this.binding(roomId, scope);
    if (!binding) throw new NotFound('Room has no Bot dialogue');
    this.ready(binding); await this.bot(binding.botId, scope);
    return this.conversations.post(binding.conversationId, input, scope, key, canExecute, actor);
  }
  async resolveRoom(roomId: string, scope: Ownership, actor?: Principal): Promise<BotDialogue> {
    const room = await this.domain.getRoom(roomId, scope.owner, scope.tenantId);
    const bound = await this.binding(roomId, scope);
    if (bound) return bound;
    if (room.chat !== 'direct' && (room.chat !== undefined || room.description !== '私聊')) throw new NotFound('Room has no Bot dialogue');
    const members = (await this.domain.listRoomMembers(roomId, scope.owner, scope.tenantId)).filter(m => m.status === 'active' && m.principalId !== scope.owner);
    if (members.length !== 1) throw new Conflict('私聊身份不明确');
    await this.bot(members[0]!.principalId, scope);
    return this.ensure(members[0]!.principalId, scope, actor);
  }
  async deliver(roomId: string, eventId: string, botId: string, kind: 'intake' | 'entry' | 'handoff', scope: Ownership, actor?: Principal) {
    const event = await this.events.get(eventId, scope.owner, scope.tenantId);
    if (event.roomId !== roomId || event.owner !== scope.owner || event.type !== 'message' || event.operation !== 'publish') throw new NotFound('Unknown channel message');
    // AEEIS is the entry of every group channel without being a listed member: it answers
    // unaddressed messages there, so it may also record them in its own conversation.
    const entry = botId === 'aeeis' && (await this.domain.getRoom(roomId, scope.owner, scope.tenantId)).chat === 'group';
    const members = entry ? [] : await this.domain.listRoomMembers(roomId, scope.owner, scope.tenantId);
    if (!entry && (!members.some(m => m.principalId === botId && m.status === 'active') || !event.audienceSnapshot.participants.some(p => p.principalId === botId))) throw new Conflict('Bot is not in the message audience');
    const binding = await this.ensure(botId, scope, actor);
    const sourceId = `${roomId}:${eventId}:${botId}:${kind}`, operationKey = `delivery:${sourceId}`;
    const operation = await this.store.withOwner(scope, async () => {
      const previous = (await this.store.operations(scope)).find(op => op.operationKey === operationKey);
      if (previous) return previous;
      const current = await this.aggregates.get(binding.conversationId, scope);
      const pending = { ...scope, botId, operationKey, kind: 'delivery' as const, sourceId, status: 'pending' as const, state: { revision: current.revision } };
      await this.store.operation(pending); return pending;
    });
    const result = await this.conversations.post(binding.conversationId, {
      text: event.content.slice(0, 7000), expectedRevision: operation.state.revision,
      ...(kind === 'intake' ? { unassigned: true } : { newTask: { title: event.content.slice(0, 80).padEnd(2, '。') } }),
      intent: 'discuss', focus: 'keep', ...(event.actorId !== scope.owner ? { speaker: { role: 'agent', id: event.actorId } } : {}),
    }, scope, followupHash(operationKey), false, actor, { kind: 'channel', channel: 'room', externalEventId: event.id, receivedAt: event.createdAt });
    await this.store.withOwner(scope, () => this.store.operation({ ...operation, status: 'completed', targetId: result.message.id }));
    return result;
  }
  async saveArtifact(roomId: string, input: unknown, keyInput: unknown, scope: Ownership, actor?: Principal) {
    const body = z.object({ expectedRevision: z.number().int().nonnegative(), artifactId: z.string().min(1).max(200).optional(), title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(30000) }).strict().parse(input);
    const key = idempotencyKeySchema.parse(keyInput), keyHash = followupHash(`artifact:${key}`), requestHash = followupHash(body);
    await this.domain.assertRoomEventWriter(roomId, scope.owner, scope.tenantId);
    const binding = await this.binding(roomId, scope);
    if (!binding) throw new NotFound('Unknown dialogue');
    await this.conversationWrite(binding.conversationId, scope, async () => {
      await this.aggregates.mutate(binding.conversationId, scope, current => {
        const previous = current.messages.find(m => m.keyHash === keyHash);
        if (previous) { if (previous.requestHash !== requestHash) throw new Conflict('Idempotency-Key already used'); return; }
        if (current.revision !== body.expectedRevision) throw new Conflict('产物已变化，请刷新后保存');
        if (body.artifactId && !current.messages.some(m => m.source?.kind === 'artifact' && m.source.artifactId === body.artifactId)) throw new NotFound('Unknown artifact draft');
        current.messages.push({ id: `message_${randomUUID()}`, keyHash, requestHash, role: 'notification', speaker: { role: 'user', id: scope.owner }, text: body.content, createdAt: new Date().toISOString(), source: { kind: 'artifact', artifactId: body.artifactId ?? `draft_${randomUUID()}`, title: body.title }, route: { status: 'general', reason: 'unassigned', taskIds: [], candidateTaskIds: [], focusEffect: 'keep' } });
      });
    });
    return this.artifacts(roomId, scope, actor);
  }
  async artifacts(roomId: string, scope: Ownership, _actor?: Principal) {
    await this.domain.getRoom(roomId, scope.owner, scope.tenantId);
    const binding = await this.binding(roomId, scope);
    if (!binding) throw new NotFound('Unknown dialogue');
    const current = await this.aggregates.get(binding.conversationId, scope);
    const latest = new Map<string, { id: string; title: string; content: string; messageId: string }>();
    for (const message of current.messages) if (message.source?.kind === 'artifact') latest.set(message.source.artifactId, { id: message.source.artifactId, title: message.source.title, content: message.text, messageId: message.id });
    return { revision: current.revision, items: [...latest.values()] };
  }
  async sweep(roomId: string, scope: Ownership, complete: (input: unknown, key: string) => Promise<unknown>): Promise<void> {
    const binding = await this.binding(roomId, scope);
    if (!binding || binding.roomId !== roomId || binding.phase !== 'ready') return;
    const current = await this.aggregates.get(binding.conversationId, scope);
    for (const message of current.messages.slice(-30)) {
      if (message.intent === 'discuss' && !message.source && !message.execution && message.speaker?.role !== 'agent') await this.respond(current.id, message.id, scope, complete);
    }
  }
  /** Background discussion only; deterministic key/replyTo, no implicit Run authorization. */
  async respond(conversationId: string, messageId: string, scope: Ownership, complete: (input: unknown, key: string) => Promise<unknown>): Promise<void> {
    return this.store.withOwner(scope, async () => {
      const binding = (await this.store.list(scope)).find(b => b.conversationId === conversationId);
      if (!binding || binding.phase !== 'ready') return;
      const bot = await this.bot(binding.botId, scope);
      if (bot.autonomy === 'quiet') return;
      const key = `dialogue-reply:${messageId}:${bot.id}`;
      const current = await this.aggregates.get(conversationId, scope);
      if (current.messages.some(m => m.keyHash === followupHash(key))) return;
      const trigger = current.messages.find(m => m.id === messageId);
      if (!trigger || trigger.execution || trigger.intent !== 'discuss' || trigger.source || trigger.speaker?.role === 'agent') return;
      let reply: string;
      try {
        const raw = await complete({ bot, standingInstruction: current.standingInstruction, transcript_untrusted: visibleConversationMessages(current.messages).slice(-30).map(m => ({ speaker: m.speaker, text: m.text })) }, key);
        if (!raw || typeof raw !== 'object' || !('reply' in raw) || typeof raw.reply !== 'string' || !raw.reply.trim()) throw new Conflict('Invalid Bot reply');
        reply = raw.reply;
      } catch (error) {
        // A reason the owner can act on (the model service refused the account) is said in the conversation, under the
        // same key, so a retry or sweep does not say it twice. Anything else stays in the log.
        if (!(error instanceof BotReplyNotice)) throw error;
        reply = error.message;
      }
      // Agent speech stays discussion. It cannot acquire the owner's execution authority.
      const latest = await this.aggregates.get(conversationId, scope);
      await this.conversations.post(conversationId, { text: reply.slice(0, 2000), expectedRevision: latest.revision, replyTo: messageId, intent: 'discuss', speaker: { role: 'agent', id: bot.id } }, scope, key, false);
    });
  }
}
