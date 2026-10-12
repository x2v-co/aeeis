import { describe, expect, it } from "vitest";
import { createPlan, transitionTask } from "../src/domain/plan.js";
import { decisionSchema, normalizePlanOutput, requestSchema, validatePlan } from "../src/runtime/contracts.js";
import { digest } from "../src/runtime/engine.js";

describe("model plan parsing", () => {
  const draft = { summary: "Project Pulse", nodes: [{ id: "pulse", title: "Pulse", instruction: "Summarize evidence", dependsOn: [] }] };

  it("strips extra model fields before hashing without granting capabilities", () => {
    const parsed = validatePlan({ ...draft, finishDecision: { type: "finish" }, allowedTools: ["shell@1"], hash: "model-chosen", nodes: [{ ...draft.nodes[0], status: "succeeded", allowedTools: ["shell@1"], metadata: { reason: "synthesis" } }] });
    expect(parsed).toEqual(draft);
    expect(digest(parsed)).toBe(digest(draft));
    expect(requestSchema.safeParse({ goal: "Pulse", finishDecision: {} }).success).toBe(false);
    expect(decisionSchema.safeParse({ type: "tool", tool: "shell", argument: "execute" }).success).toBe(false);
  });

  it("unwraps fenced/stringified plans and defaults absent dependencies", () => {
    const { dependsOn: _unused, ...node } = draft.nodes[0]!;
    expect(validatePlan('```json\n' + JSON.stringify({ plan: JSON.stringify({ ...draft, nodes: [node] }) }) + '\n```')).toEqual(draft);
    expect(validatePlan({ plan: draft, metadata: 'legacy envelope' })).toEqual(draft);
    expect(() => validatePlan({ plan: { ...draft, nodes: [{ ...node, dependsOn: ['missing'] }] } })).toThrow('missing dependency');
  });

  it("still rejects malformed nodes, missing/duplicate dependencies and cycles", () => {
    expect(() => validatePlan({ ...draft, nodes: [{ ...draft.nodes[0], id: "Invalid" }] })).toThrow();
    expect(() => validatePlan({ ...draft, nodes: [{ ...draft.nodes[0], dependsOn: ["missing"] }] })).toThrow("missing dependency");
    expect(() => validatePlan({ ...draft, nodes: [{ ...draft.nodes[0], dependsOn: ["pulse", "pulse"] }] })).toThrow("Duplicate dependency");
    expect(() => validatePlan({ ...draft, nodes: [{ ...draft.nodes[0], dependsOn: ["pulse"] }] })).toThrow("cycle");
    expect(() => validatePlan({ ...draft, nodes: [draft.nodes[0], draft.nodes[0]] })).toThrow("Duplicate task ID");
  });

  it.each([undefined, null, '', '   '])('fills a missing or empty instruction (%s) from descriptive node fields', instruction => {
    expect(validatePlan({ ...draft, nodes: [{ ...draft.nodes[0], instruction, description: 'Read the CSV and report totals' }] }).nodes[0]?.instruction).toBe('Read the CSV and report totals');
    expect(validatePlan({ ...draft, nodes: [{ ...draft.nodes[0], instruction, goal: 'Summarize the project' }] }).nodes[0]?.instruction).toBe('Summarize the project');
    expect(validatePlan({ ...draft, nodes: [{ ...draft.nodes[0], instruction }] }).nodes[0]?.instruction).toBe('Pulse');
    expect(normalizePlanOutput({ nodes: [{ instruction, name: 'Read sources' }] })).toEqual({ nodes: [{ instruction: 'Read sources', name: 'Read sources' }] });
  });

  it('balances braces inside quoted/escaped JSON and preserves executable instructions', () => {
    const plan = { ...draft, summary: 'Literal { braces } and "quotes"', nodes: [{ ...draft.nodes[0], description: 'Do something else' }] };
    expect(validatePlan('## Plan\n' + JSON.stringify({ response: { data: plan } }) + '\nTrailing prose {ignored}')).toEqual({ ...draft, summary: plan.summary });
    expect(() => validatePlan('Prose {"summary":"unfinished"')).toThrow();
    expect(() => validatePlan({ result: draft, metadata: true })).toThrow();
    expect(() => validatePlan({ ...draft, nodes: [{ ...draft.nodes[0], instruction: 123 }] })).toThrow();
  });
});

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
