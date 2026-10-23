import type { Message } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import { coordinatorPrompt, pickCli, renderCli } from "../src/agents/coordinator";

describe("picking a thread's CLI", () => {
  it("keeps the folder's CLI when the ask offers none, and the only one when it offers one", () => {
    expect(pickCli([], "codex", "why")).toBeNull();
    expect(pickCli(["codex"], undefined, undefined)).toEqual({ id: "codex", options: ["codex"], by: "person", reason: null });
  });

  it("needs the coordinator's pick among several, with a reason people can read", () => {
    expect(() => pickCli(["claude", "codex"], undefined, undefined)).toThrow(/Pass cli/);
    expect(() => pickCli(["claude", "codex"], "antigravity", "why")).toThrow(/Pass cli/);
    expect(() => pickCli(["claude", "codex"], "codex", "  ")).toThrow(/cli_reason/);
    expect(pickCli(["claude", "codex"], "codex", " Claude Code is at its limit. ")).toEqual({
      id: "codex",
      options: ["claude", "codex"],
      by: "coordinator",
      reason: "Claude Code is at its limit.",
    });
  });

  it("shows the coordinator the offered CLIs and the computer's limits", () => {
    const ask: Message = {
      id: "msg_01JTEST0000000000000000001",
      projectId: "proj_01JTEST0000000000000000001",
      threadId: null,
      authorKind: "user",
      authorId: "u1",
      body: "Fix the tests",
      clis: ["claude", "codex"],
      seq: 1,
      createdAt: new Date().toISOString(),
    };
    const prompt = coordinatorPrompt({
      projectName: "Myrel",
      names: { u1: "İsmail" },
      chat: [ask],
      threads: [],
      routines: [],
      inbox: [{ kind: "message", messageId: ask.id }],
      knowledge: { instructions: "", memoryIndex: "", memory: [], files: [], moreFiles: 0 },
      now: new Date(),
      defaultTimezone: "UTC",
      computerClis: [
        { id: "claude", version: "2.1.0", limits: { status: "limited", windows: [{ kind: "session", usedPercent: 100, resetsAt: null }], at: new Date().toISOString() } },
        { id: "codex", version: "0.50.0" },
      ],
    });
    expect(prompt).toContain("CLIs offered: Claude Code [claude], Codex CLI [codex]");
    expect(prompt).toContain("## The computer's CLIs");
    expect(prompt).toContain("Claude Code [claude] 2.1.0: LIMITED, refuses work until a reset; session 100% used");
    expect(renderCli({ id: "codex", version: null })).toBe("- Codex CLI [codex]: no limits reported");
  });
});
