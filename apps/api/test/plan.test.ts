import { describe, expect, it } from "vitest";
import { composeStatus, renderPlan } from "../src/agents/plan";

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
