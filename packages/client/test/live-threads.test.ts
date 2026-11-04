import type { LiveThread, Project } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import { liveThreadGroups } from "../src/live-threads";

const thread = (id: string, state: LiveThread["state"]): LiveThread => ({
  id,
  title: id,
  state,
  needs: null,
  step: null,
  progress: null,
  updatedAt: "2026-11-04T10:00:00.000Z",
});
const project = (id: string, live?: LiveThread[]): Project => ({ id, name: id, role: "owner", createdAt: "2026-11-01T10:00:00.000Z", live });

describe("liveThreadGroups", () => {
  it("splits by who is up and keeps the project list's order", () => {
    const { waiting, working } = liveThreadGroups([
      project("pinned", [thread("a", "working"), thread("b", "waiting")]),
      project("idle", []),
      project("older"),
      project("next", [thread("c", "queued"), thread("d", "failed")]),
    ]);
    expect(waiting.map((r) => r.thread.id)).toEqual(["b", "d"]);
    expect(working.map((r) => r.thread.id)).toEqual(["a", "c"]);
    expect(waiting[1]?.project.id).toBe("next");
  });
});
