import { describe, expect, it } from "vitest";
import { threadWaitsOnPerson } from "../src/models";

describe("threadWaitsOnPerson", () => {
  it("is true when a person has to act", () => {
    expect(threadWaitsOnPerson({ status: "review_ready", needs: "decision", resolved: false })).toBe(true);
    expect(threadWaitsOnPerson({ status: "review_ready", needs: "review", resolved: false })).toBe(true);
    expect(threadWaitsOnPerson({ status: "blocked", needs: null, resolved: false })).toBe(true);
    expect(threadWaitsOnPerson({ status: "failed", needs: null, resolved: false })).toBe(true);
  });

  it("is false for a thread at work, one that only delivered, and a finished one", () => {
    expect(threadWaitsOnPerson({ status: "working", needs: null, resolved: false })).toBe(false);
    expect(threadWaitsOnPerson({ status: "review_ready", needs: null, resolved: false })).toBe(false);
    expect(threadWaitsOnPerson({ status: "failed", needs: null, resolved: true })).toBe(false);
  });
});
