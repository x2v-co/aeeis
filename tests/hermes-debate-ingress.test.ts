import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollaborationService, FileCollaborationRepository } from '../src/collaboration-service.js';
import { CollaborationTriggerService, FileCollaborationTriggerStore } from '../src/collaboration-triggers.js';
import { HermesDebateIngress } from '../src/hermes-debate-ingress.js';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';

function signed(body: string, timestamp: string, nonce: string, keyId: string, key: string) {
  return {
    'x-hermes-timestamp': timestamp,
    'x-hermes-nonce': nonce,
    'x-hermes-key-id': keyId,
    'x-hermes-signature': `sha256=${createHmac('sha256', key).update(`${timestamp}\n${nonce}\n${body}`).digest('hex')}`,
  };
}

describe('Hermes Debate ingress', () => {
  it('verifies, routes, persists provenance and de-duplicates events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-hermes-ingress-'));
    const repository = new FileCollaborationRepository(directory); await repository.init();
    const collaboration = new CollaborationService(repository);
    const debate = await collaboration.createDebate({ taskId: 'task.hermes', contextVersion: 'ctx.hermes', participantAgentIds: ['agent.human'], maxRounds: 2, maxMessagesPerAgent: 2 });
    const key = 'hermes-signing-key-123';
    const ingress = new HermesDebateIngress({ collaboration, routes: [{ roomId: 'room.release', debateId: debate.id }], senderAgentIds: { 'hermes-user': 'agent.human' }, signingKeys: { local: key }, now: () => 1_700_000_000 });
    const body = JSON.stringify({ schemaVersion: 'hermes-debate-event/1', eventId: 'evt.hermes.1', roomId: 'room.release', senderRef: 'hermes-user', message: { content: 'Please review the release decision.' } });
    const first = await ingress.handle(body, signed(body, '1700000000', 'nonce-1', 'local', key));
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') throw new Error('expected accepted event');
    expect(first.debate.room.messages[0]).toMatchObject({ type: 'clarification', content: 'Please review the release decision.', origin: { channel: 'hermes', externalEventId: 'evt.hermes.1', senderRef: 'hermes-user' } });
    const duplicate = await ingress.handle(body, signed(body, '1700000000', 'nonce-1', 'local', key));
    expect(duplicate.status).toBe('duplicate');
    expect((await collaboration.getDebate(debate.id, { owner: 'owner', tenantId: 'local' })).room.messages).toHaveLength(1);
    await repository.close();
  });

  it('keeps trigger admission inside the Debate room and uses a stable event id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-hermes-trigger-'));
    const repository = new FileCollaborationRepository(directory); await repository.init();
    const triggerStore = new FileCollaborationTriggerStore(join(directory, 'triggers')); await triggerStore.init();
    const collaboration = new CollaborationService(repository);
    const debate = await collaboration.createDebate({ taskId: 'task.hermes.trigger', contextVersion: 'ctx.hermes.trigger', participantAgentIds: ['agent.admitted'], maxRounds: 2, maxMessagesPerAgent: 2 });
    const scope = { owner: 'owner', tenantId: 'local' };
    const triggers = new CollaborationTriggerService(triggerStore, collaboration);
    await triggers.createPolicy({ id: 'policy.hermes.message', name: 'Hermes message', enabled: true, eventTypes: ['external.message'], sources: ['hermes'], action: { type: 'debate', participantAgentIds: ['agent.admitted', 'agent.unauthorized'], maxRounds: 1, maxMessagesPerAgent: 1 } }, scope);
    const events: unknown[] = [];
    const key = 'hermes-signing-key-456';
    const ingress = new HermesDebateIngress({ collaboration, routes: [{ roomId: 'room.trigger', debateId: debate.id }], senderAgentIds: { 'hermes-user': 'agent.admitted' }, signingKeys: { local: key }, onTrigger: async event => { events.push(event); await triggers.evaluate(event, scope); }, now: () => 1_700_000_000 });
    const body = JSON.stringify({ schemaVersion: 'hermes-debate-event/1', eventId: 'evt.hermes.trigger', roomId: 'room.trigger', senderRef: 'hermes-user', message: { content: 'Trigger a governed review.' } });
    expect((await ingress.handle(body, signed(body, '1700000000', 'nonce-trigger', 'local', key))).status).toBe('accepted');
    expect((await ingress.handle(body, signed(body, '1700000000', 'nonce-trigger', 'local', key))).status).toBe('duplicate');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ eventType: 'external.message', source: 'hermes', taskId: 'task.hermes.trigger', goal: 'Trigger a governed review.', allowedAgentIds: ['agent.admitted'], context: { redactions: ['External Hermes message is untrusted input'] } });
    expect((events[0] as { eventId: string }).eventId).toBe((events[1] as { eventId: string }).eventId);
    expect(await collaboration.listDebates(scope)).toHaveLength(1);
    await triggerStore.close(); await repository.close();
  });

  it('rejects bad signatures and unmapped identities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-hermes-reject-'));
    const repository = new FileCollaborationRepository(directory); await repository.init();
    const collaboration = new CollaborationService(repository);
    const debate = await collaboration.createDebate({ taskId: 'task.hermes.reject', contextVersion: 'ctx.hermes.reject', participantAgentIds: ['agent.human'], maxRounds: 1, maxMessagesPerAgent: 2 });
    const key = 'hermes-signing-key-789';
    const ingress = new HermesDebateIngress({ collaboration, routes: [{ roomId: 'room.release', debateId: debate.id }], senderAgentIds: { 'hermes-user': 'agent.human' }, signingKeys: { local: key }, now: () => 1_700_000_000 });
    const unknown = JSON.stringify({ schemaVersion: 'hermes-debate-event/1', eventId: 'evt.unknown', roomId: 'room.other', senderRef: 'hermes-user', message: { content: 'ignored' } });
    expect((await ingress.handle(unknown, signed(unknown, '1700000000', 'nonce-unknown', 'local', key))).status).toBe('ignored');
    const bad = { ...signed(unknown, '1700000000', 'nonce-unknown', 'local', key), 'x-hermes-signature': '0'.repeat(64) };
    await expect(ingress.handle(unknown, bad)).rejects.toThrow('signature');
    await repository.close();
  });

  it('fails closed when a mapped sender is not admitted to the routed Debate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-hermes-admission-'));
    const repository = new FileCollaborationRepository(directory); await repository.init();
    const collaboration = new CollaborationService(repository);
    const debate = await collaboration.createDebate({ taskId: 'task.hermes.admission', contextVersion: 'ctx.hermes.admission', participantAgentIds: ['agent.admitted'], maxRounds: 1, maxMessagesPerAgent: 2 });
    const key = 'hermes-signing-key-admission';
    const ingress = new HermesDebateIngress({ collaboration, routes: [{ roomId: 'room.admission', debateId: debate.id }], senderAgentIds: { 'hermes-user': 'agent.other' }, signingKeys: { local: key }, now: () => 1_700_000_000 });
    const body = JSON.stringify({ schemaVersion: 'hermes-debate-event/1', eventId: 'evt.hermes.admission', roomId: 'room.admission', senderRef: 'hermes-user', message: { content: 'must not enter' } });
    await expect(ingress.handle(body, signed(body, '1700000000', 'nonce-admission', 'local', key))).resolves.toMatchObject({ status: 'ignored', reason: 'sender_not_admitted' });
    expect((await collaboration.getDebate(debate.id, { owner: 'owner', tenantId: 'local' })).room.messages).toHaveLength(0);
    await repository.close();
  });

  it('captures the exact raw body at the HTTP webhook boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-hermes-http-'));
    const collaborationRepository = new FileCollaborationRepository(join(directory, 'collaboration')); await collaborationRepository.init();
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const collaboration = new CollaborationService(collaborationRepository);
    const debate = await collaboration.createDebate({ taskId: 'task.hermes.http', contextVersion: 'ctx.hermes.http', participantAgentIds: ['agent.human'], maxRounds: 1, maxMessagesPerAgent: 2 });
    const key = 'hermes-signing-key-http';
    const ingress = new HermesDebateIngress({ collaboration, routes: [{ roomId: 'room.http', debateId: debate.id }], senderAgentIds: { 'hermes-user': 'agent.human' }, signingKeys: { local: key }, now: () => 1_700_000_000 });
    const app = buildApp({ repository: runs, collaboration, hermesDebateIngress: ingress });
    try {
      const body = JSON.stringify({ schemaVersion: 'hermes-debate-event/1', eventId: 'evt.hermes.http', roomId: 'room.http', senderRef: 'hermes-user', message: { content: 'raw body is signed' } });
      const response = await app.inject({ method: 'POST', url: '/webhooks/hermes/events', headers: { host: '127.0.0.1:4323', 'content-type': 'application/json', ...signed(body, '1700000000', 'nonce-http', 'local', key) }, payload: body });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'accepted', externalEventId: 'evt.hermes.http' });
    } finally { await app.close(); await runs.close(); await collaborationRepository.close(); }
  });
});
