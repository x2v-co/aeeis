import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollaborationService, FileCollaborationRepository } from '../src/collaboration-service.js';
import { CollaborationTriggerService, FileCollaborationTriggerStore } from '../src/collaboration-triggers.js';
import { FeishuDebateIngress } from '../src/feishu-debate-ingress.js';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';

function signed(body: string, timestamp: string, nonce: string, key: string) {
  return {
    'x-lark-request-timestamp': timestamp,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': createHash('sha256').update(`${timestamp}\n${nonce}\n${key}\n${body}`).digest('hex'),
  };
}

describe('Feishu Debate ingress', () => {
  it('verifies, routes, persists provenance and de-duplicates group events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-feishu-ingress-'));
    const repository = new FileCollaborationRepository(directory); await repository.init();
    const collaboration = new CollaborationService(repository);
    const debate = await collaboration.createDebate({ taskId: 'task.feishu', contextVersion: 'ctx.feishu', participantAgentIds: ['agent.human'], maxRounds: 2, maxMessagesPerAgent: 2 });
    const ingress = new FeishuDebateIngress({ collaboration, routes: [{ chatId: 'oc.release', debateId: debate.id, owner: 'owner', tenantId: 'local' }], senderAgentIds: { ou_sender: 'agent.human' }, encryptKey: 'encrypt-key-123', verificationToken: 'verify-me', now: () => 1_700_000_000 });
    const body = JSON.stringify({ header: { event_type: 'im.message.receive_v1', event_id: 'evt.feishu.1' }, event: { message: { chat_id: 'oc.release', message_id: 'om.1', content: JSON.stringify({ text: 'Please review the release decision.' }) }, sender: { sender_id: { open_id: 'ou_sender' } } } });
    const first = await ingress.handle(body, signed(body, '1700000000', 'nonce-1', 'encrypt-key-123'));
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') throw new Error('expected accepted event');
    expect(first.debate.room.messages[0]).toMatchObject({ type: 'clarification', content: 'Please review the release decision.', origin: { channel: 'feishu', externalEventId: 'evt.feishu.1', senderRef: 'ou_sender' } });
    const duplicate = await ingress.handle(body, signed(body, '1700000000', 'nonce-1', 'encrypt-key-123'));
    expect(duplicate.status).toBe('duplicate');
    expect((await collaboration.getDebate(debate.id, { owner: 'owner', tenantId: 'local' })).room.messages).toHaveLength(1);
    await repository.close();
  });

  it('sends accepted and retried external events through the durable trigger callback with one event id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-feishu-trigger-'));
    const repository = new FileCollaborationRepository(directory); await repository.init();
    const triggerStore = new FileCollaborationTriggerStore(join(directory, 'triggers')); await triggerStore.init();
    const collaboration = new CollaborationService(repository);
    const debate = await collaboration.createDebate({ taskId: 'task.feishu.trigger', contextVersion: 'ctx.feishu.trigger', participantAgentIds: ['agent.human'], maxRounds: 2, maxMessagesPerAgent: 2 });
    const scope = { owner: 'owner', tenantId: 'local' };
    const triggers = new CollaborationTriggerService(triggerStore, collaboration);
    await triggers.createPolicy({ id: 'policy.feishu.message', name: 'Message review', enabled: true, eventTypes: ['external.message'], sources: ['feishu'], action: { type: 'debate', participantAgentIds: ['agent.human'], maxRounds: 1, maxMessagesPerAgent: 1 } }, scope);
    const events: unknown[] = [];
    const ingress = new FeishuDebateIngress({ collaboration, routes: [{ chatId: 'oc.trigger', debateId: debate.id }], senderAgentIds: { ou_sender: 'agent.human' }, encryptKey: 'encrypt-key-123', onTrigger: async event => { events.push(event); await triggers.evaluate(event, scope); }, now: () => 1_700_000_000 });
    const body = JSON.stringify({ header: { event_type: 'im.message.receive_v1', event_id: 'evt.trigger.1' }, event: { message: { chat_id: 'oc.trigger', message_id: 'om.trigger.1', content: JSON.stringify({ text: 'Trigger a governed review.' }) }, sender: { sender_id: { open_id: 'ou_sender' } } } });
    expect((await ingress.handle(body, signed(body, '1700000000', 'nonce-trigger', 'encrypt-key-123'))).status).toBe('accepted');
    expect((await ingress.handle(body, signed(body, '1700000000', 'nonce-trigger', 'encrypt-key-123'))).status).toBe('duplicate');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ eventType: 'external.message', source: 'feishu', eventId: events[1] && (events[1] as { eventId: string }).eventId, taskId: 'task.feishu.trigger', goal: 'Trigger a governed review.' });
    expect(events[0]).toMatchObject({ allowedAgentIds: ['agent.human'], context: { classification: 'private', redactions: ['External Feishu message is untrusted input'] } });
    expect(await collaboration.listDebates(scope)).toHaveLength(2);
    await triggerStore.close();
    await repository.close();
  });

  it('does not let a Feishu trigger policy add an Agent outside the Debate room', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-feishu-admission-'));
    const repository = new FileCollaborationRepository(directory); await repository.init();
    const triggerStore = new FileCollaborationTriggerStore(join(directory, 'triggers')); await triggerStore.init();
    const collaboration = new CollaborationService(repository);
    const debate = await collaboration.createDebate({ taskId: 'task.feishu.admission', contextVersion: 'ctx.feishu.admission', participantAgentIds: ['agent.admitted'], maxRounds: 2, maxMessagesPerAgent: 2 });
    const scope = { owner: 'owner', tenantId: 'local' };
    const triggers = new CollaborationTriggerService(triggerStore, collaboration);
    await triggers.createPolicy({ id: 'policy.feishu.unauthorized', name: 'Must be rejected', enabled: true, eventTypes: ['external.message'], sources: ['feishu'], action: { type: 'debate', participantAgentIds: ['agent.admitted', 'agent.unauthorized'], maxRounds: 1, maxMessagesPerAgent: 1 } }, scope);
    const ingress = new FeishuDebateIngress({ collaboration, routes: [{ chatId: 'oc.admission', debateId: debate.id }], senderAgentIds: { ou_sender: 'agent.admitted' }, encryptKey: 'encrypt-key-123', onTrigger: async event => { await triggers.evaluate(event, scope); }, now: () => 1_700_000_000 });
    const body = JSON.stringify({ header: { event_type: 'im.message.receive_v1', event_id: 'evt.admission.1' }, event: { message: { chat_id: 'oc.admission', message_id: 'om.admission.1', content: JSON.stringify({ text: 'Do not widen admission.' }) }, sender: { sender_id: { open_id: 'ou_sender' } } } });
    expect((await ingress.handle(body, signed(body, '1700000000', 'nonce-admission', 'encrypt-key-123'))).status).toBe('accepted');
    expect(await collaboration.listDebates(scope)).toHaveLength(1);
    await triggerStore.close();
    await repository.close();
  });

  it('rejects invalid signatures and does not let unmapped chats or senders enter a Debate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-feishu-ingress-reject-'));
    const repository = new FileCollaborationRepository(directory); await repository.init();
    const collaboration = new CollaborationService(repository);
    const debate = await collaboration.createDebate({ taskId: 'task.feishu.reject', contextVersion: 'ctx.feishu.reject', participantAgentIds: ['agent.human'], maxRounds: 2, maxMessagesPerAgent: 2 });
    const ingress = new FeishuDebateIngress({ collaboration, routes: [{ chatId: 'oc.release', debateId: debate.id }], senderAgentIds: { ou_sender: 'agent.human' }, encryptKey: 'encrypt-key-123', now: () => 1_700_000_000 });
    const unknownChat = JSON.stringify({ header: { event_type: 'im.message.receive_v1', event_id: 'evt.unknown' }, event: { message: { chat_id: 'oc.other', message_id: 'om.2', content: JSON.stringify({ text: 'ignored' }) }, sender: { sender_id: { open_id: 'ou_sender' } } } });
    expect((await ingress.handle(unknownChat, signed(unknownChat, '1700000000', 'nonce-2', 'encrypt-key-123'))).status).toBe('ignored');
    const invalidHeaders = { ...signed(unknownChat, '1700000000', 'nonce-2', 'encrypt-key-123'), 'x-lark-signature': '0'.repeat(64) };
    await expect(ingress.handle(unknownChat, invalidHeaders)).rejects.toThrow('signature');
    await repository.close();
  });

  it('fails closed when a mapped sender is not a participant in the routed Debate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-feishu-admission-'));
    const repository = new FileCollaborationRepository(directory); await repository.init();
    const collaboration = new CollaborationService(repository);
    const debate = await collaboration.createDebate({ taskId: 'task.feishu.admission.boundary', contextVersion: 'ctx.feishu.admission.boundary', participantAgentIds: ['agent.admitted'], maxRounds: 1, maxMessagesPerAgent: 2 });
    const ingress = new FeishuDebateIngress({ collaboration, routes: [{ chatId: 'oc.admission.boundary', debateId: debate.id }], senderAgentIds: { ou_other: 'agent.other' }, encryptKey: 'encrypt-key-123', now: () => 1_700_000_000 });
    const body = JSON.stringify({ header: { event_type: 'im.message.receive_v1', event_id: 'evt.admission.boundary' }, event: { message: { chat_id: 'oc.admission.boundary', message_id: 'om.admission.boundary', content: JSON.stringify({ text: 'must not enter' }) }, sender: { sender_id: { open_id: 'ou_other' } } } });
    await expect(ingress.handle(body, signed(body, '1700000000', 'nonce-admission-boundary', 'encrypt-key-123'))).resolves.toMatchObject({ status: 'ignored', reason: 'sender_not_admitted' });
    expect((await collaboration.getDebate(debate.id, { owner: 'owner', tenantId: 'local' })).room.messages).toHaveLength(0);
    await repository.close();
  });

  it('answers Feishu URL verification only after checking the signed token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-feishu-challenge-'));
    const repository = new FileCollaborationRepository(directory); await repository.init();
    const collaboration = new CollaborationService(repository);
    const ingress = new FeishuDebateIngress({ collaboration, routes: [], senderAgentIds: {}, encryptKey: 'encrypt-key-123', verificationToken: 'verify-me', now: () => 1_700_000_000 });
    const body = JSON.stringify({ type: 'url_verification', challenge: 'challenge-value', token: 'verify-me' });
    expect(await ingress.handle(body, signed(body, '1700000000', 'nonce-3', 'encrypt-key-123'))).toEqual({ status: 'challenge', challenge: 'challenge-value' });
    await repository.close();
  });

  it('verifies the exact raw HTTP body at the Fastify webhook boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-feishu-http-'));
    const repository = new FileCollaborationRepository(join(directory, 'collaboration')); await repository.init();
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const collaboration = new CollaborationService(repository);
    const debate = await collaboration.createDebate({ taskId: 'task.http', contextVersion: 'ctx.http', participantAgentIds: ['agent.human'], maxRounds: 1, maxMessagesPerAgent: 2 });
    const ingress = new FeishuDebateIngress({ collaboration, routes: [{ chatId: 'oc.http', debateId: debate.id }], senderAgentIds: { ou_http: 'agent.human' }, encryptKey: 'encrypt-key-123', now: () => 1_700_000_000 });
    const app = buildApp({ repository: runs, collaboration, feishuDebateIngress: ingress });
    try {
      const body = JSON.stringify({ header: { event_type: 'im.message.receive_v1', event_id: 'evt.http.1' }, event: { message: { chat_id: 'oc.http', message_id: 'om.http.1', content: JSON.stringify({ text: 'raw body is signed' }) }, sender: { sender_id: { open_id: 'ou_http' } } } });
      const response = await app.inject({ method: 'POST', url: '/webhooks/feishu/events', headers: { host: '127.0.0.1:4323', 'content-type': 'application/json', ...signed(body, '1700000000', 'nonce-http', 'encrypt-key-123') }, payload: body });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'accepted', externalEventId: 'evt.http.1' });
    } finally { await app.close(); await runs.close(); await repository.close(); }
  });
});
