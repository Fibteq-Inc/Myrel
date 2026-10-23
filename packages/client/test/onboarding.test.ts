import { describe, expect, it } from "vitest";
import { starterDraft, starterSteps } from "../src/onboarding";

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
