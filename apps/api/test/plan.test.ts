import { describe, expect, it } from "vitest";
import { composeStatus, mergePlanUpdates, planChanges, renderPlan } from "../src/agents/plan";

const plan = {
  title: "Hatayı düzelt",
  steps: [
    { text: "Kodu oku", state: "done" as const },
    { text: "Düzeltmeyi yap", state: "active" as const },
    { text: "Yayına al", state: "skipped" as const },
    { text: "Sonucu bildir", state: "todo" as const },
  ],
};

describe("plan", () => {
  it("renders as a checklist", () => {
    expect(renderPlan(plan)).toBe("Hatayı düzelt\n\n✓ Kodu oku\n✱ Düzeltmeyi yap\n– Yayına al\n○ Sonucu bildir");
  });

  it("nests a running task's steps under the active step", () => {
    const task = "Fix the bug\n\n✓ Sandbox ready\n✱ Agent working\n  ✓ edit a.ts";
    expect(composeStatus(plan, task)).toBe(
      "Hatayı düzelt\n\n✓ Kodu oku\n✱ Düzeltmeyi yap\n  ✓ Sandbox ready\n  ✱ Agent working\n    ✓ edit a.ts\n– Yayına al\n○ Sonucu bildir",
    );
  });

  it("falls back to whichever exists", () => {
    expect(composeStatus(null, "T\n\n✱ a")).toBe("T\n\n✱ a");
    expect(composeStatus(null, null)).toBeNull();
    expect(composeStatus(plan, null)).toBe(renderPlan(plan));
  });
});

describe("plan changes", () => {
  it("sees steps added, dropped and failed, not ticks or a task's nested steps", () => {
    const prev = "T\n\n✓ a\n✱ b\n  ✱ task step\n○ c";
    const next = "T\n\n✓ a\n✗ b\n  ✓ task step\n  ✱ other task step\n○ d";
    expect(planChanges(prev, next)).toEqual({ added: ["d"], removed: ["c"], failed: ["b"] });
    expect(planChanges(prev, "T\n\n✓ a\n✓ b\n✱ c")).toEqual({ added: [], removed: [], failed: [] });
  });

  it("merges changes in a row, cancelling a step added then dropped", () => {
    expect(
      mergePlanUpdates({ added: ["x", "y"], removed: ["z"], failed: [] }, { added: ["z", "w"], removed: ["x"], failed: ["y"] }),
    ).toEqual({ added: ["y", "w"], removed: [], failed: ["y"] });
  });
});
