import { describe, expect, it } from "vitest";
import { accessAnswer, accessMessage, accessTargets, insideAny, normalizePath } from "../src/agents/folder-access";

describe("folder access", () => {
  it("resolves paths from macOS, Linux and Windows the same way", () => {
    expect(normalizePath("/Users/a/code/../notes/./x.md")).toBe("/Users/a/notes/x.md");
    expect(normalizePath("src/a.ts", "/Users/a/code")).toBe("/Users/a/code/src/a.ts");
    expect(normalizePath("src/a.ts")).toBeNull();
    expect(normalizePath("c:\\Users\\a\\code\\..\\x")).toBe("C:/Users/a/x");
    expect(insideAny("C:/USERS/A/CODE/x.ts", ["c:\\Users\\a\\code"])).toBe(true);
    expect(insideAny("/Users/a/code-other/x", ["/Users/a/code"])).toBe(false);
    expect(insideAny("/Users/a/code", ["/Users/a/code/"])).toBe(true);
    expect(insideAny("/etc/hosts", ["/"])).toBe(true);
  });

  it("asks about the folder a file is in, or the folder a search looks in", () => {
    expect(accessTargets({ file_path: "/Users/a/notes/todo.md" }, "/w")).toEqual([{ path: "/Users/a/notes/todo.md", folder: "/Users/a/notes" }]);
    expect(accessTargets({ pattern: "TODO", path: "/Users/a/notes" }, "/w")).toEqual([{ path: "/Users/a/notes", folder: "/Users/a/notes" }]);
    expect(accessTargets({ pattern: "/Users/a/site/**/*.md" }, "/w")).toEqual([{ path: "/Users/a/site", folder: "/Users/a/site" }]);
    expect(accessTargets({ command: "ls /etc" }, "/w")).toEqual([]);
  });

  it("reads a tap on the card in either language", () => {
    const card = accessMessage("/Users/a/notes", "Read /Users/a/notes/todo.md", "tr");
    expect(card).toContain("Bu sefer izin ver");
    expect(accessAnswer(" bu sefer izin ver ")).toBe("once");
    expect(accessAnswer("Add to project")).toBe("always");
    expect(accessAnswer("İzin verme")).toBe("deny");
    expect(accessAnswer("evet, oku")).toBeNull();
  });
});
