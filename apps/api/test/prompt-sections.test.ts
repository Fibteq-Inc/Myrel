import { describe, expect, it } from "vitest";
import { agentPrompt, sectionHash, unchangedSections } from "../src/agents/harness-agent";

describe("unchangedSections", () => {
  const place = { kind: "local", cli: "codex", folder: "/work", computer: "laptop" } as const;

  it("leaves out what the session holds unchanged and records every section for the next turn", () => {
    const first = unchangedSections([]);
    const full = agentPrompt(place, `Thread\n\n${first.lasting("## Brief\nDo it.")}`, [], [], first.lasting);
    expect(full).toContain("You are Myrel");
    expect(first.left()).toBe(0);
    expect(first.hashes).toHaveLength(2);

    const next = unchangedSections(first.hashes);
    const thread = ["Thread", next.lasting("## Brief\nDo it."), next.lasting("## Memory\nnew note")].filter(Boolean).join("\n\n");
    const short = agentPrompt(place, thread, [], [], next.lasting);
    expect(short).toBe("Thread\n\n## Memory\nnew note");
    expect(next.left()).toBe(2);
    expect(next.hashes).toHaveLength(3);
  });

  it("tells sections apart", () => {
    expect(sectionHash("## Brief\nDo it.")).toBe(sectionHash("## Brief\nDo it."));
    expect(sectionHash("## Brief\nDo it.")).not.toBe(sectionHash("## Brief\nDo it!"));
  });
});
