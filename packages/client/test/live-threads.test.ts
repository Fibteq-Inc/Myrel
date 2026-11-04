import type { LiveThread, Notification, Project } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import { liveThreadGroups, recentThreads } from "../src/live-threads";

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

const news = (threadId: string | null, kind: Notification["kind"], projectId = "p"): Notification => ({
  id: `n_${threadId}_${kind}`,
  projectId,
  threadId,
  kind,
  title: `${threadId}`,
  body: "",
  url: "/",
  readAt: null,
  createdAt: "2026-11-04T10:00:00.000Z",
});
const titles = (notifications: Notification[], projects: Project[]) => recentThreads(notifications, projects).map((r) => r.notification.title);

describe("recentThreads", () => {
  it("lists each thread once, by its latest news", () => {
    expect(titles([news("a", "done"), news("a", "ready"), news("b", "ready")], [project("p")])).toEqual(["a", "b"]);
  });

  it("leaves out a thread whose latest news is not a result", () => {
    expect(titles([news("a", "decision"), news("a", "ready"), news("b", "failed")], [project("p")])).toEqual([]);
  });

  it("leaves out threads in progress, other projects and news with no thread", () => {
    const projects = [project("p", [thread("live", "working")])];
    expect(titles([news("live", "ready"), news("x", "done", "gone"), news(null, "done"), news("a", "done")], projects)).toEqual(["a"]);
  });

  it("stops at five", () => {
    expect(titles(["a", "b", "c", "d", "e", "f"].map((id) => news(id, "done")), [project("p")])).toHaveLength(5);
  });
});
