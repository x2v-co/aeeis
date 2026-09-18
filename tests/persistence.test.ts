import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AeeisService } from "../src/application/aeeis-service.js";
import { JsonFileStore } from "../src/adapters/json-store.js";
import { FileProjectionOutbox } from "../src/collaboration-projection.js";

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

        await first.close();
        const second = new JsonFileStore(filePath);
        return second.init().then(async () => {
        const restored = await new AeeisService(second).getSnapshot(plan.id);
        expect(restored.goal.title).toBe("Persist this");
        expect(restored.memories).toHaveLength(1);
        expect(restored.receipts).toHaveLength(1);
        expect(readFileSync(filePath, "utf8")).toContain("understand");
        await second.close();
        });
      });
    });
  });

  it('recovers durable projection intents after restart before marking them dispatched', async () => {
    const directory = mkdtempSync(join(tmpdir(), "aeeis-intents-"));
    const filePath = join(directory, "domain.json");
    const first = new JsonFileStore(filePath); await first.init();
    const service = new AeeisService(first, [{ channel: 'hermes', destination: 'room.1', aggregateTypes: ['task'] }]);
    const goal = await service.createGoal({ title: 'Recover projection intent' });
    const plan = await service.createPlan({ goalId: goal.id, nodes: [{ id: 'draft', title: 'Draft' }] });
    await service.transitionTask({ planId: plan.id, taskId: 'draft', transition: 'start' });
    expect(await first.listProjectionIntents()).toHaveLength(1);
    await first.close();

    const second = new JsonFileStore(filePath); await second.init();
    const outbox = new FileProjectionOutbox(join(directory, 'outbox')); await outbox.init();
    const restoredService = new AeeisService(second, [{ channel: 'hermes', destination: 'room.1', aggregateTypes: ['task'] }]);
    expect(await restoredService.drainProjectionIntents(outbox)).toEqual({ dispatched: 1, failed: 0 });
    expect(await second.listProjectionIntents()).toEqual([]);
    expect((await outbox.list())[0]).toMatchObject({ aggregateType: 'task', aggregateId: `${plan.id}.draft` });
    await outbox.close(); await second.close();
  });
});
