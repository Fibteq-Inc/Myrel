import { describe, expect, it } from "vitest";
import { loadHighlighter } from "../src/highlight";

describe("syntax highlighting", async () => {
  const hl = await loadHighlighter();

  it("finds the language from a code block tag or a file path", () => {
    expect(hl.language("sql")).toBe("sql");
    expect(hl.language("ts")).toBe("ts");
    expect(hl.language("yemvit/sorgu.SQL")).toBe("sql");
    expect(hl.language("apps/web/x.tsx")).toBe("tsx");
    expect(hl.language("Makefile")).toBe("makefile");
    expect(hl.language("decision")).toBeNull();
    expect(hl.language("notes/a.unknownext")).toBeNull();
    expect(hl.language(undefined)).toBeNull();
  });

  it("cuts code into colored runs that add up to the code", () => {
    const code = "SELECT name, 42 FROM users -- all\nWHERE id = 'x';";
    const tokens = hl.highlight(code, "sql")!;
    expect(tokens.map((t) => t.text).join("")).toBe(code);
    expect(tokens).toContainEqual({ text: "SELECT", kind: "keyword" });
    expect(tokens).toContainEqual({ text: "42", kind: "number" });
    expect(tokens).toContainEqual({ text: "-- all", kind: "comment" });
    expect(tokens).toContainEqual({ text: "'x'", kind: "string" });
  });

  it("leaves very long code plain", () => {
    expect(hl.highlight("a".repeat(100_001), "sql")).toBeNull();
  });
});
