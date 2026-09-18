import { describe, expect, it } from "vitest";
import { createPlan, transitionTask } from "../src/domain/plan.js";

describe("Plan Graph", () => {
  it("starts root tasks as ready and dependent tasks as planned", () => {
    const plan = createPlan("plan_1", "goal_1", 1, [
      { id: "research", title: "Research" },
      { id: "review", title: "Review", dependsOn: ["research"] },
    ]);

    expect(plan.nodes.map((node) => [node.id, node.status])).toEqual([
      ["research", "ready"],
      ["review", "planned"],
    ]);
  });

  it("rejects missing dependencies and cycles", () => {
    expect(() =>
      createPlan("plan_1", "goal_1", 1, [{ id: "a", title: "A", dependsOn: ["missing"] }]),
    ).toThrow("unknown task");
    expect(() =>
      createPlan("plan_1", "goal_1", 1, [
        { id: "a", title: "A", dependsOn: ["b"] },
        { id: "b", title: "B", dependsOn: ["a"] },
      ]),
    ).toThrow("cycle");
  });

  it("requires successful dependencies before starting a task", () => {
    const plan = createPlan("plan_1", "goal_1", 1, [
      { id: "a", title: "A" },
      { id: "b", title: "B", dependsOn: ["a"] },
    ]);
    expect(() => transitionTask(plan, "b", "start")).toThrow("not ready");
    const running = transitionTask(plan, "a", "start").plan;
    const succeeded = transitionTask(running, "a", "succeed").plan;
    expect(succeeded.nodes.find((node) => node.id === "b")?.status).toBe("planned");
  });

  it("supports retrying failed work with an incremented attempt", () => {
    const plan = createPlan("plan_1", "goal_1", 1, [{ id: "a", title: "A" }]);
    const running = transitionTask(plan, "a", "start").plan;
    const failed = transitionTask(running, "a", "fail", "provider timeout").plan;
    const retried = transitionTask(failed, "a", "retry");
    expect(retried.to).toBe("ready");
    expect(retried.attempt).toBe(1);
  });
});
