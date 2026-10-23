import { describe, expect, it } from "vitest";
import { waitsForAgent } from "../src";

describe("waitsForAgent", () => {
  const thread = { id: "thr_1", status: "working" as const, resolved: false, seenSeq: 10 };
  const message = { threadId: "thr_1", authorKind: "user" as const, seq: 11 };

  it("is a person's message after what the working agent has seen", () => {
    expect(waitsForAgent(message, thread)).toBe(true);
    expect(waitsForAgent({ ...message, seq: 10 }, thread)).toBe(false);
  });

  it("is never the agent's own, another thread's, or one in a thread that is not working", () => {
    expect(waitsForAgent({ ...message, authorKind: "agent" }, thread)).toBe(false);
    expect(waitsForAgent({ ...message, threadId: "thr_2" }, thread)).toBe(false);
    expect(waitsForAgent(message, { ...thread, status: "review_ready" })).toBe(false);
    expect(waitsForAgent(message, { ...thread, resolved: true })).toBe(false);
  });

  it("is unknown, so false, when the server does not say what the agent has seen", () => {
    expect(waitsForAgent(message, { ...thread, seenSeq: null })).toBe(false);
  });
});
