import type { ContextManifest } from './contracts.js';
import { digestProtocol } from './protocol.js';

/** Preserve the original Goal binding for persisted session-event/1 records. */
export function contextManifestBindingHash(manifest: ContextManifest): string {
  const binding = { id: manifest.id, goalId: manifest.goalId, owner: manifest.owner, tenantId: manifest.tenantId, purpose: manifest.purpose, audience: manifest.audience, audienceSnapshot: manifest.audienceSnapshot, memoryRefs: manifest.memoryRefs, knowledgeRefs: manifest.knowledgeRefs ?? [], createdAt: manifest.createdAt };
  return digestProtocol(manifest.roomId ? { ...binding, roomId: manifest.roomId, goalIds: manifest.goalIds, goalContextRefs: manifest.goalContextRefs, included: manifest.included, includedKnowledge: manifest.includedKnowledge ?? [] } : binding);
}

/** Source content is frozen as well as identity, including its classification. */
export function goalContextSourceHash(manifest: ContextManifest): string {
  return digestProtocol({ binding: contextManifestBindingHash(manifest), included: manifest.included, includedKnowledge: manifest.includedKnowledge ?? [] });
}
