import { describe, expect, it } from "vitest";
import { codeLanguage, fenceLanguage } from "../src/code-language";
import { HIGHLIGHT_LIMIT, highlightLines } from "../src/highlight";

describe("codeLanguage", () => {
  it("knows code by extension or file name", () => {
    expect(codeLanguage("migrations/0001_init.SQL")).toBe("sql");
    expect(codeLanguage("apps/web/src/main.tsx")).toBe("typescript");
    expect(codeLanguage("fix.patch")).toBe("diff");
    expect(codeLanguage("deploy/Dockerfile")).toBe("dockerfile");
  });
  it("leaves prose and unknown files alone", () => {
    expect(codeLanguage("notes/plan.md")).toBeUndefined();
    expect(codeLanguage("notes.txt")).toBeUndefined();
    expect(codeLanguage(".bashrc")).toBeUndefined();
    expect(codeLanguage("a.constructor")).toBeUndefined();
  });
});

describe("fenceLanguage", () => {
  it("takes grammar names, extensions and common aliases", () => {
    expect(fenceLanguage("SQL")).toBe("sql");
    expect(fenceLanguage("ts")).toBe("typescript");
    expect(fenceLanguage("typescript")).toBe("typescript");
    expect(fenceLanguage("shell")).toBe("bash");
    expect(fenceLanguage("html")).toBe("xml");
    expect(fenceLanguage("text")).toBeUndefined();
    expect(fenceLanguage("constructor")).toBeUndefined();
  });
});

describe("highlightLines", () => {
  it("colors SQL and keeps the lines", () => {
    const lines = highlightLines("-- users\nSELECT id, 'x' FROM users\nWHERE id = 1;\n", "sql");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual([{ text: "-- users", kind: "comment" }]);
    expect(lines[1]).toContainEqual({ text: "SELECT", kind: "keyword" });
    expect(lines[1]).toContainEqual({ text: "'x'", kind: "string" });
    expect(lines[2]).toContainEqual({ text: "1", kind: "number" });
    expect(lines.map((l) => l.map((t) => t.text).join("")).join("\n")).toBe("-- users\nSELECT id, 'x' FROM users\nWHERE id = 1;");
  });
  it("splits a comment that spans lines", () => {
    const lines = highlightLines("/* a\nb */\nconst x = 1", "typescript");
    expect(lines[0]).toEqual([{ text: "/* a", kind: "comment" }]);
    expect(lines[1]).toEqual([{ text: "b */", kind: "comment" }]);
  });
  it("marks diff lines", () => {
    const [, added, removed] = highlightLines("@@ -1 +1 @@\n+new\n-old", "diff");
    expect(added).toEqual([{ text: "+new", kind: "addition" }]);
    expect(removed).toEqual([{ text: "-old", kind: "deletion" }]);
  });
  it("gives plain lines for unknown grammars and huge files", () => {
    expect(highlightLines("a\n\nb", "cobol")).toEqual([[{ text: "a" }], [], [{ text: "b" }]]);
    const big = "select 1;\n".repeat(HIGHLIGHT_LIMIT / 10 + 1);
    expect(highlightLines(big, "sql")[0]).toEqual([{ text: "select 1;" }]);
  });
});
