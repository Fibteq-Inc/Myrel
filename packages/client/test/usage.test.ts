import type { UsageSummary } from "@myrel/protocol";
import { describe, expect, it } from "vitest";
import { chartSlot, DEFAULT_USAGE_FILTER, usageQuery, usageSeries } from "../src";

const now = new Date(2026, 10, 23, 12);

describe("usageQuery", () => {
  it("turns the ranges into days or dates", () => {
    expect(usageQuery(DEFAULT_USAGE_FILTER, now)).toMatchObject({ days: 30, scope: "all", projectId: null });
    expect(usageQuery({ range: "1", scope: "mine" }, now)).toMatchObject({ days: 1, scope: "mine" });
    expect(usageQuery({ range: "month", scope: "all" }, now)).toMatchObject({ from: "2026-11-01", to: "2026-11-23" });
  });
  it("reads a half-filled or swapped custom range", () => {
    expect(usageQuery({ range: "custom", scope: "all", from: "2026-11-10", to: "2026-11-02" }, now)).toMatchObject({ from: "2026-11-02", to: "2026-11-10" });
    expect(usageQuery({ range: "custom", scope: "all", from: "2026-11-10" }, now)).toMatchObject({ from: "2026-11-10", to: "2026-11-10" });
    expect(usageQuery({ range: "custom", scope: "all" }, now)).toMatchObject({ from: "2026-11-23", to: "2026-11-23" });
  });
});

describe("usageSeries", () => {
  const day = (date: string, costMicros = 0) => ({ date, costMicros }) as UsageSummary["daily"][number];
  const data = {
    daily: [day("2026-11-22", 5), day("2026-11-23", 7)],
    dailyByCli: [
      { date: "2026-11-23", harness: "coordinator", tokens: 4, turns: 1, durationMs: 10 },
      { date: "2026-11-23", harness: "hermes", tokens: 6, turns: 1, durationMs: 10 },
      { date: "2026-11-23", harness: "codex", tokens: 20, turns: 2, durationMs: 30 },
      { date: "2026-11-22", harness: "claude", tokens: 50, turns: 3, durationMs: 40 },
    ],
  } as UsageSummary;

  it("keeps each CLI's color and puts the ones without one together, last", () => {
    expect(usageSeries(data, "tokens").map((s) => [s.key, s.slot, s.values])).toEqual([
      ["claude", 1, [50, 0]],
      ["codex", 2, [0, 20]],
      ["other", null, [0, 10]],
    ]);
    expect(usageSeries(data, "turns").at(-1)!.harnesses).toEqual(["coordinator", "hermes"]);
    expect(chartSlot("qwen")).toBe(8);
  });
  it("shows cost as one series", () => {
    expect(usageSeries(data, "cost")).toEqual([{ key: "cost", slot: 1, harnesses: [], values: [5, 7] }]);
  });
  it("has nothing to draw by CLI from an older server", () => {
    expect(usageSeries({ ...data, dailyByCli: undefined }, "tokens")).toEqual([]);
  });
});
