import { describe, expect, it } from "vitest";
import { isLongReply } from "../src/agents/thread-worker";

describe("isLongReply", () => {
  it("lets short replies through", () => {
    expect(isLongReply("Done, the pull request is open.")).toBe(false);
    expect(isLongReply(Array.from({ length: 15 }, (_, i) => `- point ${i}`).join("\n"))).toBe(false);
  });

  it("flags replies past the length or line limit", () => {
    expect(isLongReply("a".repeat(1501))).toBe(true);
    expect(isLongReply(Array.from({ length: 16 }, (_, i) => `- point ${i}`).join("\n"))).toBe(true);
  });
});
