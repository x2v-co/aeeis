import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AeeisService } from "../src/application/aeeis-service.js";
import { JsonFileStore } from "../src/adapters/json-store.js";

describe("JsonFileStore", () => {
  it("restores goals, plans, memories, and receipts after a new store instance", () => {
    const directory = mkdtempSync(join(tmpdir(), "aeeis-"));
    const filePath = join(directory, "aeeis.json");
    const first = new JsonFileStore(filePath);
    return first.init().then(() => {
      const service = new AeeisService(first);
      return service.createGoal({ title: "Persist this" }).then(async goal => {
        await service.addMemory(goal.id, { kind: "decision", content: "Keep the receipt" });
        const plan = await service.createProjectPulsePlan(goal.id);
        await service.transitionTask({ planId: plan.id, taskId: "understand", transition: "start" });

        const second = new JsonFileStore(filePath);
        return second.init().then(async () => {
        const restored = await new AeeisService(second).getSnapshot(plan.id);
        expect(restored.goal.title).toBe("Persist this");
        expect(restored.memories).toHaveLength(1);
        expect(restored.receipts).toHaveLength(1);
        expect(readFileSync(filePath, "utf8")).toContain("understand");
        });
      });
    });
  });
});
