import type { Task, TerminalLine } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import { newestFirst, taskHeadline, taskSubagents } from "../src/tasks";

const task = (id: string, createdAt: string, status: Task["status"] = "done"): Task => ({
  id: `task_${id}`,
  threadId: "thr_1",
  title: "Claude Code",
  harness: "claude",
  backend: "local",
  status,
  prUrl: null,
  summary: null,
  createdAt,
  finishedAt: null,
});

describe("newestFirst", () => {
  it("puts the running task first, then newest to oldest", () => {
    const tasks = [
      task("a", "2026-10-25T09:00:00Z"),
      task("b", "2026-10-26T10:00:00Z"),
      task("c", "2026-10-24T09:00:00Z", "running"),
      task("d", "2026-10-26T08:00:00Z"),
    ];
    expect(newestFirst(tasks).map((t) => t.id)).toEqual(["task_c", "task_b", "task_d", "task_a"]);
    expect(tasks[0]!.id).toBe("task_a");
  });
});

describe("taskHeadline", () => {
  it("takes the first non-empty line without Markdown marks", () => {
    expect(taskHeadline("\n## **PR #286** opened\nmore")).toBe("PR #286 opened");
    expect(taskHeadline("- `pnpm test` passed")).toBe("pnpm test passed");
    expect(taskHeadline("1. Fixed it")).toBe("Fixed it");
  });
  it("is null without a summary", () => {
    expect(taskHeadline(null)).toBeNull();
    expect(taskHeadline("  \n ")).toBeNull();
  });
});

describe("taskSubagents", () => {
  const explore = { id: "tu1", label: "Explore" };
  const lines: TerminalLine[] = [
    { stream: "system", text: "→ Read a.ts", tool: true, at: 1 },
    { stream: "system", text: "Find the auth flow", at: 2, agent: { ...explore, state: "started" } },
    { stream: "system", text: "→ Grep: session", tool: true, at: 3, agent: explore },
    { stream: "system", text: "→ Read auth.ts", tool: true, at: 4, agent: explore },
    { stream: "system", text: "→ $ pnpm test", tool: true, at: 5, agent: { id: "sub-2", label: "Agent 2" } },
    { stream: "system", text: "Auth lives in auth.ts", at: 6, ms: 4000, agent: { ...explore, state: "done", model: "haiku", tokens: 1200 } },
  ];

  it("gathers each subagent's purpose, steps, answer and usage in the order they started", () => {
    expect(taskSubagents(lines, true)).toEqual([
      {
        id: "tu1",
        label: "Explore",
        purpose: "Find the auth flow",
        status: "done",
        startedAt: 2,
        ms: 4000,
        steps: 2,
        lastStep: "Read auth.ts",
        answer: "Auth lives in auth.ts",
        model: "haiku",
        tokens: 1200,
      },
      // Its starting line fell out of the kept lines: it still shows, without a purpose.
      { id: "sub-2", label: "Agent 2", purpose: "", status: "running", startedAt: 5, steps: 1, lastStep: "$ pnpm test", answer: "" },
    ]);
  });

  it("counts a subagent that never ended as stopped once its task is over", () => {
    expect(taskSubagents(lines, false).map((a) => a.status)).toEqual(["done", "stopped"]);
    expect(taskSubagents([{ stream: "stdout", text: "hi" }], true)).toEqual([]);
  });
});
