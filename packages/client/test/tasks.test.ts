import type { Task } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import { newestFirst, taskHeadline } from "../src/tasks";

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
