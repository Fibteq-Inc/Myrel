import { describe, expect, it } from "vitest";
import { computerTipDue, decisionTipDue, starterDraft, starterSteps } from "../src/onboarding";

describe("starterSteps", () => {
  it("starts with the project done and fills in from what exists", () => {
    expect(starterSteps({ asked: false, computers: 0, github: false }).map((s) => [s.id, s.done])).toEqual([
      ["project", true],
      ["task", false],
      ["computer", false],
      ["github", false],
    ]);
    expect(starterSteps({ asked: true, computers: 2, github: true }).every((s) => s.done)).toBe(true);
  });

  it("drops GitHub on a server without a GitHub App", () => {
    expect(starterSteps({ asked: false, computers: 0, github: null }).map((s) => s.id)).toEqual(["project", "task", "computer"]);
  });
});

describe("starterDraft", () => {
  it("selects the first placeholder, brackets included", () => {
    const { text, select } = starterDraft("Research [topic] and write it down.");
    expect(text.slice(...select)).toBe("[topic]");
  });

  it("puts the caret at the end when there is none", () => {
    expect(starterDraft("Hello").select).toEqual([5, 5]);
  });
});

describe("one-time tips", () => {
  const done = [{ status: "working" as const }, { status: "done" as const }];
  it("offers a computer after a finished thread, to someone without one, once", () => {
    expect(computerTipDue({ tips: [], computers: 0, threads: done })).toBe(true);
    expect(computerTipDue({ tips: [], computers: 0, threads: [{ status: "working" }] })).toBe(false);
    expect(computerTipDue({ tips: [], computers: 1, threads: done })).toBe(false);
    expect(computerTipDue({ tips: ["computer"], computers: 0, threads: done })).toBe(false);
    // Older servers send no tips: none are shown.
    expect(computerTipDue({ tips: undefined, computers: 0, threads: done })).toBe(false);
  });

  it("explains a decision card until the note is seen", () => {
    expect(decisionTipDue([])).toBe(true);
    expect(decisionTipDue(["decision"])).toBe(false);
    expect(decisionTipDue(undefined)).toBe(false);
  });
});
