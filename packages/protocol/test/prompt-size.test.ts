import { describe, expect, it } from "vitest";
import { lastPromptSize, type Message, type PromptSize, promptGauge } from "../src";

const size = (chars: number, extra: Partial<PromptSize> = {}): PromptSize => ({
  chars,
  limit: 99_000,
  parts: { instructions: 0, skills: 0, knowledge: 0, brief: 0, conversation: chars, notes: 0, other: 0 },
  droppedMessages: 0,
  droppedNotes: 0,
  cut: false,
  ...extra,
});

describe("promptGauge", () => {
  it("is quiet below the line, then near, then loud once something was left out", () => {
    expect(promptGauge(size(40_000))).toEqual({ share: 40_000 / 99_000, level: "ok" });
    expect(promptGauge(size(90_000)).level).toBe("near");
    expect(promptGauge(size(98_000, { droppedMessages: 3 })).level).toBe("dropped");
    expect(promptGauge(size(60_000, { droppedNotes: 1 })).level).toBe("dropped");
    expect(promptGauge(size(99_000, { cut: true })).level).toBe("dropped");
  });
});

describe("lastPromptSize", () => {
  it("takes the newest message that carries one", () => {
    const stats = (prompt?: PromptSize) => ({ stats: prompt ? { prompt } : {} }) as unknown as Message;
    expect(lastPromptSize([stats(size(1)), stats(size(2)), stats()])?.chars).toBe(2);
    expect(lastPromptSize([stats()])).toBeNull();
  });
});
