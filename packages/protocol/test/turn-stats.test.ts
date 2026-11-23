import { describe, expect, it } from "vitest";
import { type MessageStats, threadWork, timeSplit, usageSpeed } from "../src";

const line = (id: string, st: Partial<MessageStats>) => ({
  id,
  stats: { model: "opus", durationMs: 10_000, calls: 0, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, costMicros: null, runtime: "local", harness: "claude", computer: "srv", ...st } as MessageStats,
});

describe("threadWork", () => {
  it("counts a turn's messages as measured with the one that carries its model time", () => {
    const { total, last, groups } = threadWork([
      line("a", { turn: "t1", model: "" }),
      line("b", { turn: "t1", modelMs: 4000, waitMs: 3000 }),
      line("c", { turn: "t2" }),
    ]);
    expect(total).toMatchObject({ turns: 2, outputTokens: 300, durationMs: 30_000, modelMs: 4000, modelOutputTokens: 200, measuredMs: 20_000, costMicros: 0 });
    expect(usageSpeed(total)).toEqual({ turn: 10, model: 50 });
    expect(timeSplit(total)).toEqual({ modelMs: 4000, waitMs: 3000, restMs: 13_000 });
    // The last turn was not measured, so it has only the speed over the whole turn.
    expect(last).toMatchObject({ turns: 1, outputTokens: 100 });
    expect(usageSpeed(last!)).toEqual({ turn: 10, model: null });
    expect(timeSplit(last!)).toBeNull();
    // The first message came before the CLI named its model; the turn is still one group's.
    expect(groups.map((g) => [g.model, g.turns, g.outputTokens])).toEqual([["opus", 2, 300]]);
  });

  it("groups by CLI and where it ran, and counts each older message as a turn", () => {
    const { total, groups } = threadWork([line("a", {}), line("b", { harness: "codex", model: "gpt" }), line("c", { runtime: "cloud", harness: "opencode", computer: undefined, costMicros: 500 })]);
    expect(total).toMatchObject({ turns: 3, costMicros: 500 });
    expect(groups.map((g) => [g.harness, g.runtime])).toEqual([["claude", "local"], ["codex", "local"], ["opencode", "cloud"]]);
  });

  it("leaves nothing over when model calls ran side by side", () => {
    const { total } = threadWork([line("a", { turn: "t", modelMs: 25_000 })]);
    expect(timeSplit(total)).toEqual({ modelMs: 25_000, waitMs: 0, restMs: 0 });
  });

  it("has nothing to say without stats", () => {
    expect(threadWork([{ id: "a" }]).last).toBeNull();
  });
});
