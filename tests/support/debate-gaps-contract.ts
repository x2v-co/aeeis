import { expect } from 'vitest';
import { debateGaps } from '../../src/collaboration.js';
import { CollaborationService, type CollaborationRepository } from '../../src/collaboration-service.js';

const scope = { owner: 'alice', tenantId: 'team-a' };

/** Trust levels and the gap ledger survive storage: `writer` records the
 * debate, then `openReader` returns a fresh instance over the same store
 * (the File store allows one writer, so it may close `writer` first). */
export async function runDebateGapsContract(writer: CollaborationRepository, openReader: () => Promise<CollaborationRepository>) {
  const service = new CollaborationService(writer);
  const created = await service.createDebate({
    taskId: 'task.gaps', contextVersion: 'ctx.gaps', participantAgentIds: ['agent.one', 'agent.two'], maxRounds: 2,
    context: { classification: 'internal', claims: [{ id: 'claim.ci', text: 'CI run 412 passed', evidenceRefs: [] }], artifactRefs: [], redactions: [] },
  }, scope);
  const message = (messageId: string, speakerAgentId: string, fields: Record<string, unknown>) => ({
    schemaVersion: 'debate-message/1', messageId, debateId: created.id, round: 1, speakerAgentId, content: 'text', claimRefs: [], contextVersion: 'ctx.gaps', ...fields,
  });
  await service.appendMessage(created.id, message('message.gap', 'agent.one', { type: 'gap', gap: { question: 'Did CI pass?', impact: 'A failing CI blocks the release' } }), scope);
  await service.appendMessage(created.id, message('message.answer', 'agent.two', { type: 'observation', gapRef: { gapId: 'message.gap' }, claimRefs: ['claim.ci'] }), scope);
  await service.appendMessage(created.id, message('message.decision', 'agent.one', { type: 'decision', gapRef: { gapId: 'message.gap', resolution: 'closed' }, claimRefs: ['claim.ci', 'message.answer'] }), scope);
  // A request body cannot set a trust level.
  await expect(service.appendMessage(created.id, { ...message('message.forged', 'agent.two', { type: 'position' }), authority: 'context' }, scope)).rejects.toThrow();

  // An asserted reference is not evidence, even when the decision cites it.
  const adjudication = { status: 'decided', decision: 'Release', rationale: 'CI passed', selectedMessageId: 'message.decision', decidedAt: new Date().toISOString() };
  await expect(service.closeDebate(created.id, 'adjudicated', scope, { ...adjudication, evidenceRefs: ['message.answer'] })).rejects.toThrow('supported decision evidence');
  const closed = await service.closeDebate(created.id, 'adjudicated', scope, { ...adjudication, evidenceRefs: ['claim.ci'] });
  expect(closed.room.adjudication).toMatchObject({ status: 'decided', evidenceRefs: ['claim.ci'] });

  const reader = await openReader();
  const stored = await reader.getDebate(created.id, scope);
  expect(stored.room.moderation.map(item => [item.messageId, item.status, item.authority])).toEqual([
    ['message.gap', 'accepted', 'asserted'], ['message.answer', 'accepted', 'context'], ['message.decision', 'accepted', 'context'],
  ]);
  expect(debateGaps(stored.room)).toEqual([expect.objectContaining({ gapId: 'message.gap', state: 'closed', answeredBy: ['message.answer'], resolvedBy: 'message.decision' })]);

  expect(stored.room.adjudication).toMatchObject({ status: 'decided', evidenceRefs: ['claim.ci'] });
  await reader.close();
}
