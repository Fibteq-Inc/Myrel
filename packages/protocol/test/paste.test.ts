import { describe, expect, it } from "vitest";
import { isLongPaste, takeLongPaste } from "../src/paste";

const long = "x".repeat(4001);

describe("isLongPaste", () => {
  it("counts characters and lines", () => {
    expect(isLongPaste("hello")).toBe(false);
    expect(isLongPaste(long)).toBe(true);
    expect(isLongPaste("a\n".repeat(80))).toBe(true);
  });
});

describe("takeLongPaste", () => {
  it("leaves typing and short pastes alone", () => {
    expect(takeLongPaste("hel", "hell")).toBeNull();
    expect(takeLongPaste("note: ", "note: a short paste")).toBeNull();
    expect(takeLongPaste(long, long.slice(1))).toBeNull();
  });

  it("takes a long paste out of the text around it", () => {
    expect(takeLongPaste("", long)).toEqual({ pasted: long, rest: "" });
    expect(takeLongPaste("before  after", `before ${long} after`)).toEqual({ pasted: long, rest: "before  after" });
  });

  it("takes a paste that replaced a selection", () => {
    const result = takeLongPaste("keep OLD keep", `keep ${long} keep`);
    expect(result).toEqual({ pasted: long, rest: "keep  keep" });
  });
});
