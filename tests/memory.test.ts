import { describe, expect, it } from "vitest";
import { AeeisService } from "../src/application/aeeis-service.js";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { InMemoryKnowledgeProvider, makeKnowledgeRecord } from "../src/knowledge.js";

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
});
