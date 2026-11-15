import type { Project } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import { withProjectPinned } from "../src/project-pins";

const project = (id: string, day: number, pinned = false): Project => ({
  id,
  name: id,
  role: "owner",
  createdAt: new Date(Date.UTC(2026, 9, day)).toISOString(),
  pinned,
});

const ids = (list: Project[]) => list.map((p) => p.id);

describe("withProjectPinned", () => {
  const list = [project("a", 5, true), project("b", 9), project("c", 7), project("d", 3)];

  it("puts a new pin last among the pinned ones", () => {
    expect(ids(withProjectPinned(list, "c", true))).toEqual(["a", "c", "b", "d"]);
  });

  it("returns an unpinned project to its place by creation date", () => {
    const pinned = withProjectPinned(list, "c", true);
    expect(ids(withProjectPinned(pinned, "a", false))).toEqual(["c", "b", "a", "d"]);
    expect(withProjectPinned(pinned, "a", false).find((p) => p.id === "a")?.pinned).toBe(false);
  });

  it("leaves the list alone for an unknown project", () => {
    expect(withProjectPinned(list, "x", true)).toBe(list);
  });

  it("puts an unpinned project where the server would: working first, then latest activity", () => {
    const rest = [
      { ...project("working", 1), activity: { working: 2, waiting: 0 }, lastActivityAt: new Date(Date.UTC(2026, 9, 2)).toISOString() },
      { ...project("recent", 2), lastActivityAt: new Date(Date.UTC(2026, 9, 20)).toISOString() },
      project("new", 10),
    ];
    const old = { ...project("pin", 3, true), lastActivityAt: new Date(Date.UTC(2026, 9, 15)).toISOString() };
    expect(ids(withProjectPinned([old, ...rest], "pin", false))).toEqual(["working", "recent", "pin", "new"]);
  });
});
