import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CollaborationService, FileCollaborationRepository } from '../src/collaboration-service.js';
import { FeishuDebateIngress } from '../src/feishu-debate-ingress.js';
import { HermesDebateIngress } from '../src/hermes-debate-ingress.js';
import { HttpChannelIdentityResolver, InMemoryChannelIdentityResolver, JsonChannelIdentityResolver, type ChannelIdentity } from '../src/security/channel-identity.js';

const verifiedAt = '2026-09-22T00:00:00.000Z';
function identity(channel: 'feishu' | 'hermes', externalSubjectId: string, stableSubjectId: string, tenantId = 'local'): ChannelIdentity {
  return {
    schemaVersion: 'channel-identity/1', channel, externalSubjectId, tenantId,
    stableSubjectId, subjectType: 'agent', status: 'active', verifiedAt,
    provenance: { source: 'manual', reference: `test:${channel}:${externalSubjectId}`, verifiedAt },
  };
}
function feishuSigned(body: string, timestamp = '1700000000', nonce = 'identity-nonce') {
  const key = 'encrypt-key-123';
  return { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': createHash('sha256').update(`${timestamp}\n${nonce}\n${key}\n${body}`).digest('hex') };
}
function hermesSigned(body: string, timestamp = '1700000000', nonce = 'identity-nonce') {
  const key = 'hermes-signing-key-123';
  return { 'x-hermes-timestamp': timestamp, 'x-hermes-nonce': nonce, 'x-hermes-key-id': 'local', 'x-hermes-signature': `sha256=${createHmac('sha256', key).update(`${timestamp}\n${nonce}\n${body}`).digest('hex')}` };
}

describe('Channel Identity', () => {
  it('resolves by channel, external subject and tenant, and supports revocation', async () => {
    const resolver = new InMemoryChannelIdentityResolver([identity('feishu', 'ou.alice', 'agent.alice')]);
    await expect(resolver.resolve({ channel: 'feishu', externalSubjectId: 'ou.alice', tenantId: 'local' })).resolves.toMatchObject({ stableSubjectId: 'agent.alice', status: 'active' });
    await expect(resolver.resolve({ channel: 'feishu', externalSubjectId: 'ou.alice', tenantId: 'other' })).resolves.toBeUndefined();
    resolver.revoke('feishu', 'ou.alice', 'local');
    await expect(resolver.resolve({ channel: 'feishu', externalSubjectId: 'ou.alice', tenantId: 'local' })).resolves.toMatchObject({ status: 'revoked' });
  });

  it('supports the JSON and HTTPS resolver contracts with tenant-bound responses', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-channel-identity-adapters-'));
    const jsonPath = join(directory, 'identities.json');
    await writeFile(jsonPath, JSON.stringify({ identities: [identity('feishu', 'ou.json', 'agent.json')] }));
    const json = new JsonChannelIdentityResolver(jsonPath);
    await expect(json.resolve({ channel: 'feishu', externalSubjectId: 'ou.json', tenantId: 'local' })).resolves.toMatchObject({ stableSubjectId: 'agent.json' });
    const served = identity('hermes', 'hermes.http', 'agent.http');
    const server = createServer((request, response) => {
      if (request.headers.authorization !== 'Bearer resolver-secret') { response.writeHead(401).end(); return; }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ identity: served }));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not expose a port');
      const http = new HttpChannelIdentityResolver(`http://127.0.0.1:${address.port}/lookup`, 'resolver-secret');
      await expect(http.resolve({ channel: 'hermes', externalSubjectId: 'hermes.http', tenantId: 'local' })).resolves.toMatchObject({ stableSubjectId: 'agent.http' });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('uses the resolver before static mappings and preserves the identity snapshot in history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-channel-identity-feishu-'));
    const repository = new FileCollaborationRepository(directory); await repository.init();
    const collaboration = new CollaborationService(repository);
    const debate = await collaboration.createDebate({ taskId: 'task.identity.feishu', contextVersion: 'ctx.identity.feishu', participantAgentIds: ['agent.alice', 'agent.bob'], maxRounds: 2, maxMessagesPerAgent: 3 });
    const resolver = new InMemoryChannelIdentityResolver([identity('feishu', 'ou.sender', 'agent.alice')]);
    const ingress = new FeishuDebateIngress({ collaboration, routes: [{ chatId: 'oc.identity', debateId: debate.id }], senderAgentIds: { 'ou.sender': 'agent.wrong' }, channelIdentityResolver: resolver, encryptKey: 'encrypt-key-123', now: () => 1_700_000_000 });
    const firstBody = JSON.stringify({ header: { event_type: 'im.message.receive_v1', event_id: 'evt.identity.1' }, event: { message: { chat_id: 'oc.identity', message_id: 'om.identity.1', content: JSON.stringify({ text: 'first' }) }, sender: { sender_id: { open_id: 'ou.sender' } } } });
    await expect(ingress.handle(firstBody, feishuSigned(firstBody, '1700000000', 'identity-1'))).resolves.toMatchObject({ status: 'accepted' });
    resolver.set(identity('feishu', 'ou.sender', 'agent.bob'));
    const secondBody = JSON.stringify({ header: { event_type: 'im.message.receive_v1', event_id: 'evt.identity.2' }, event: { message: { chat_id: 'oc.identity', message_id: 'om.identity.2', content: JSON.stringify({ text: 'second' }) }, sender: { sender_id: { open_id: 'ou.sender' } } } });
    await expect(ingress.handle(secondBody, feishuSigned(secondBody, '1700000000', 'identity-2'))).resolves.toMatchObject({ status: 'accepted' });
    const messages = (await collaboration.getDebate(debate.id, { owner: 'owner', tenantId: 'local' })).room.messages;
    expect(messages.map(message => message.speakerAgentId)).toEqual(['agent.alice', 'agent.bob']);
    expect(messages[0]?.origin?.identity).toMatchObject({ stableSubjectId: 'agent.alice', externalSubjectId: 'ou.sender' });
    await repository.close();
  });

  it('fails closed for revoked, cross-tenant, and non-agent identities on both bridges', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-channel-identity-reject-'));
    const repository = new FileCollaborationRepository(directory); await repository.init();
    const collaboration = new CollaborationService(repository);
    const feishuDebate = await collaboration.createDebate({ taskId: 'task.identity.reject.f', contextVersion: 'ctx.identity.reject.f', participantAgentIds: ['agent.alice'], maxRounds: 1, maxMessagesPerAgent: 2 });
    const hermesDebate = await collaboration.createDebate({ taskId: 'task.identity.reject.h', contextVersion: 'ctx.identity.reject.h', participantAgentIds: ['agent.alice'], maxRounds: 1, maxMessagesPerAgent: 2 });
    const resolver = new InMemoryChannelIdentityResolver([identity('feishu', 'ou.revoked', 'agent.alice'), identity('hermes', 'hermes.other-tenant', 'agent.alice', 'other')]);
    resolver.revoke('feishu', 'ou.revoked', 'local');
    const feishu = new FeishuDebateIngress({ collaboration, routes: [{ chatId: 'oc.reject', debateId: feishuDebate.id }], channelIdentityResolver: resolver, encryptKey: 'encrypt-key-123', now: () => 1_700_000_000 });
    const feishuBody = JSON.stringify({ header: { event_type: 'im.message.receive_v1', event_id: 'evt.reject.f' }, event: { message: { chat_id: 'oc.reject', message_id: 'om.reject.f', content: 'ignored' }, sender: { sender_id: { open_id: 'ou.revoked' } } } });
    await expect(feishu.handle(feishuBody, feishuSigned(feishuBody, '1700000000', 'reject-f'))).resolves.toMatchObject({ status: 'ignored', reason: 'unmapped_sender' });
    const hermes = new HermesDebateIngress({ collaboration, routes: [{ roomId: 'room.reject', debateId: hermesDebate.id }], channelIdentityResolver: resolver, signingKeys: { local: 'hermes-signing-key-123' }, now: () => 1_700_000_000 });
    const hermesBody = JSON.stringify({ schemaVersion: 'hermes-debate-event/1', eventId: 'evt.reject.h', roomId: 'room.reject', senderRef: 'hermes.other-tenant', message: { content: 'ignored' } });
    await expect(hermes.handle(hermesBody, hermesSigned(hermesBody, '1700000000', 'reject-h'))).resolves.toMatchObject({ status: 'ignored', reason: 'unmapped_sender' });
    expect((await collaboration.getDebate(feishuDebate.id, { owner: 'owner', tenantId: 'local' })).room.messages).toHaveLength(0);
    expect((await collaboration.getDebate(hermesDebate.id, { owner: 'owner', tenantId: 'local' })).room.messages).toHaveLength(0);
    await repository.close();
  });
});
