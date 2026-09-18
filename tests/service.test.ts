import { describe, expect, it } from "vitest";
import { AeeisService } from "../src/application/aeeis-service.js";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";

describe("AeeisService", () => {
  it("creates a goal, plan, transition, and durable receipt", async () => {
    const service = new AeeisService(new InMemoryStore());
    const goal = await service.createGoal({ title: "Ship the design" }, "2026-09-18T00:00:00.000Z");
    const plan = await service.createPlan(
      {
        goalId: goal.id,
        nodes: [{ id: "draft", title: "Draft" }],
      },
      "2026-09-18T00:00:01.000Z",
    );

    const receipt = await service.transitionTask(
      { planId: plan.id, taskId: "draft", transition: "start" },
      "2026-09-18T00:00:02.000Z",
    );
    const snapshot = await service.getSnapshot(plan.id);

    expect(receipt.to).toBe("running");
    expect(snapshot.plan.nodes[0]?.status).toBe("running");
    expect(snapshot.receipts).toHaveLength(1);
    expect(snapshot.receipts[0]?.id).toMatch(/^receipt_/);
  });

  it("creates a Project Pulse plan and completes its goal after all tasks succeed", async () => {
    const service = new AeeisService(new InMemoryStore());
    const goal = await service.createGoal({ title: "Ship MVP" });
    const plan = await service.createProjectPulsePlan(goal.id);
    for (const task of ["understand", "next_action", "review"]) {
      await service.transitionTask({ planId: plan.id, taskId: task, transition: "start" });
      await service.transitionTask({ planId: plan.id, taskId: task, transition: "succeed" });
    }
    expect((await service.getGoal(goal.id)).status).toBe("completed");
  });
});
