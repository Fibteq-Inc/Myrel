import { describe, expect, it } from "vitest";
import { checklistStep } from "../src/plan";

describe("checklistStep", () => {
  it("names the innermost active step and the plan's progress", () => {
    expect(checklistStep("Plan\n✓ One\n✱ Two\n  ✱ Run tests\n○ Three")).toEqual({ step: "Run tests", progress: "1/3" });
  });

  it("has no progress for a plan of one step and no step when none is active", () => {
    expect(checklistStep("Plan\n✱ Only")).toEqual({ step: "Only", progress: null });
    expect(checklistStep("Plan\n✓ One\n✓ Two")).toEqual({ step: null, progress: "2/2" });
  });
});
