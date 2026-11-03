import { createContextAudienceSnapshot } from '../../src/context-audience.js';
import { digestProtocol } from '../../src/protocol.js';
import type { SessionEventDraft } from '../../src/session-events.js';

export const noiseScope = { roomId: 'room.noise', owner: 'alice', tenantId: 'team-a' };
export const noiseAt = Date.parse('2026-11-03T12:00:00.000Z');
export function noiseDraft(key: string, extra: Partial<SessionEventDraft> = {}): SessionEventDraft {
  return { ...noiseScope, type: 'message', actorId: 'bot.writer', actorType: 'agent',
    contextManifestId: 'ctx.noise', contextManifestHash: 'a'.repeat(64),
    audienceSnapshot: createContextAudienceSnapshot({ schemaVersion: 'context-audience/1', capturedAt: new Date(noiseAt).toISOString(), participants: [{ principalId: 'alice', tenantId: 'team-a', audience: JSON.stringify(['team-a', 'alice']), authority: 'goal-owner', role: 'owner' }] }),
    content: key, contentHash: digestProtocol({ content: key }), evidenceRefs: [], idempotencyKey: key, createdAt: new Date(noiseAt).toISOString(), ...extra };
}
