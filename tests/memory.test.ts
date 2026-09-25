import { describe, expect, it } from "vitest";
import { AeeisService } from "../src/application/aeeis-service.js";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { InMemoryKnowledgeProvider, makeKnowledgeRecord } from "../src/knowledge.js";
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { principalAudience } from '../src/security/principal.js';

describe("Brain context", () => {
  it("keeps private memories out of a project context manifest", async () => {
    const service = new AeeisService(new InMemoryStore());
    const goal = await service.createGoal({ title: "Launch" });
    await service.addMemory(goal.id, { kind: "decision", content: "Use Temporal for long tasks" });
    const privateMemory = await service.addMemory(goal.id, {
      kind: "note",
      scope: "private",
      content: "Do not share this private note",
    });

    const manifest = await service.createContextManifest(goal.id, {
      purpose: "planning",
      query: "Temporal tasks",
    });

    expect(manifest.memoryRefs).not.toContain(privateMemory.id);
    expect(manifest.excluded).toHaveLength(1);
    expect(manifest.excluded[0]).not.toContain(privateMemory.id);
    expect(manifest.included[0]?.content).toContain("Temporal");
  });

  it("adds externally retrieved knowledge as bounded, classified context", async () => {
    const service = new AeeisService(new InMemoryStore());
    const goal = await service.createGoal({ title: "Research" });
    const knowledge = new InMemoryKnowledgeProvider([makeKnowledgeRecord({ id: "knowledge.temporal", title: "Temporal", content: "Durable execution", source: "owned-wiki", classification: "internal", tags: ["workflow"], updatedAt: "2026-09-18T00:00:00.000Z" })]);
    const manifest = await service.createContextManifestWithKnowledge(goal.id, { purpose: "research", query: "durable execution" }, knowledge);
    expect(manifest.knowledgeRefs).toEqual(["knowledge.temporal"]);
    expect(manifest.includedKnowledge?.[0]?.contentHash).toHaveLength(64);
  });

  it('keeps memory corrections and retractions auditable while excluding them from future context', async () => {
    const service = new AeeisService(new InMemoryStore());
    const goal = await service.createGoal({ title: 'Release' }, undefined, 'alice', 'team-a');
    const first = await service.addMemory(goal.id, {
      kind: 'decision', content: 'Use a local queue', source: 'receipt.release', evidenceRefs: ['artifact.release'],
    }, undefined, 'alice', 'team-a');
    const corrected = await service.correctMemory(goal.id, first.id, {
      kind: 'decision', content: 'Use Temporal for long tasks', source: 'correction.release', evidenceRefs: ['artifact.temporal'],
    }, '2026-09-20T00:00:01.000Z', 'alice', 'team-a');
    expect(corrected).toMatchObject({ version: 2, state: 'active', supersedesId: first.id, evidenceRefs: ['artifact.temporal'] });
    const retracted = await service.retractMemory(goal.id, corrected.id, 'Decision was superseded by an approved architecture', '2026-09-20T00:00:02.000Z', 'alice', 'team-a');
    expect(retracted).toMatchObject({ state: 'retracted', retractionReason: 'Decision was superseded by an approved architecture' });
    const history = await service.listMemories(goal.id, 'alice', 'team-a');
    expect(history.map(memory => memory.state)).toEqual(['superseded', 'retracted']);
    const manifest = await service.createContextManifest(goal.id, { purpose: 'run', query: 'Temporal' }, undefined, 'alice', 'team-a');
    expect(manifest.memoryRefs).toEqual([]);
    expect(manifest.excluded).toContain('superseded memory versions omitted');
    expect(manifest.excluded).toContain('retracted memories omitted');
  });

  it('freezes Room recipients and keeps knowledge visible only when every recipient is authorized', async () => {
    const memberships = new InMemoryRoomMembershipRepository();
    const service = new AeeisService(new InMemoryStore(), [], memberships);
    const room = await service.createRoom({ title: 'Shared context' }, undefined, 'alice', 'team-a');
    const goal = await service.createGoal({ title: 'Shared research', roomId: room.id }, undefined, 'alice', 'team-a');
    await service.addRoomMember(room.id, 'bob', 'viewer', 'alice', 'team-a');
    const alice = principalAudience({ id: 'alice', tenantId: 'team-a' });
    const bob = principalAudience({ id: 'bob', tenantId: 'team-a' });
    const knowledge = new InMemoryKnowledgeProvider([
      makeKnowledgeRecord({ id: 'knowledge.shared', title: 'Shared', content: 'Shared decision', source: 'wiki', classification: 'internal', tags: [], audiences: [alice, bob], tenantId: 'team-a', updatedAt: '2026-09-20T00:00:00.000Z' }),
      makeKnowledgeRecord({ id: 'knowledge.private-to-alice', title: 'Alice only', content: 'Private decision', source: 'wiki', classification: 'internal', tags: [], audiences: [alice], tenantId: 'team-a', updatedAt: '2026-09-20T00:00:00.000Z' }),
    ]);
    const manifest = await service.createContextManifestWithKnowledge(goal.id, { purpose: 'shared research', audienceMode: 'room', query: 'decision' }, knowledge, undefined, 'alice', 'team-a');
    expect(manifest.audienceSnapshot?.participants.map(participant => participant.principalId)).toEqual(['alice', 'bob']);
    expect(manifest.includedKnowledge?.map(item => item.id)).toEqual(['knowledge.shared']);
  });
});
