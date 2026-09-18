import { describe, expect, it } from "vitest";
import { AeeisService } from "../src/application/aeeis-service.js";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";

describe("Brain context", () => {
  it("keeps private memories out of a project context manifest", () => {
    const service = new AeeisService(new InMemoryStore());
    const goal = service.createGoal({ title: "Launch" });
    service.addMemory(goal.id, { kind: "decision", content: "Use Temporal for long tasks" });
    const privateMemory = service.addMemory(goal.id, {
      kind: "note",
      scope: "private",
      content: "Do not share this private note",
    });

    const manifest = service.createContextManifest(goal.id, {
      purpose: "planning",
      query: "Temporal tasks",
    });

    expect(manifest.memoryRefs).not.toContain(privateMemory.id);
    expect(manifest.excluded).toHaveLength(1);
    expect(manifest.excluded[0]).not.toContain(privateMemory.id);
    expect(manifest.included[0]?.content).toContain("Temporal");
  });
});
