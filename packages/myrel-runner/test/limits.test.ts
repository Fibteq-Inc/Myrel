import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerCli } from "@myrel/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ADAPTERS, type ParseState } from "../src/clis";
import { claudeLimits, codexLimits, readCodexLimits } from "../src/limits";

describe("claudeLimits", () => {
  it("reads Claude Code's rate_limit_event, with every window when it carries them", () => {
    const state: ParseState = {};
    ADAPTERS.claude.line(
      JSON.stringify({
        type: "rate_limit_event",
        session_id: "s1",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.81,
          resetsAt: 1_793_000_000,
          unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1_792_500_000 } },
        },
      }),
      state,
    );
    expect(state.limits?.status).toBe("warning");
    expect(state.limits?.windows).toEqual([
      { kind: "weekly", usedPercent: 81, resetsAt: new Date(1_793_000_000_000).toISOString() },
      { kind: "session", usedPercent: 25, resetsAt: new Date(1_792_500_000_000).toISOString() },
    ]);
  });

  it("keeps what an earlier event said about other windows", () => {
    const first = claudeLimits({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1, resetsAt: 100 });
    const next = claudeLimits({ status: "rejected", rateLimitType: "seven_day", resetsAt: 200 }, first);
    expect(next?.status).toBe("limited");
    expect(next?.windows.map((w) => [w.kind, w.usedPercent])).toEqual([
      ["session", 10],
      ["weekly", null],
    ]);
  });

  it("ignores events with nothing in them", () => {
    expect(claudeLimits(null)).toBeUndefined();
    expect(claudeLimits({ rateLimitType: "overage" })).toBeUndefined();
  });
});

describe("codexLimits", () => {
  it("names Codex's 5-hour and weekly windows", () => {
    const limits = codexLimits(
      {
        primary: { used_percent: 42.5, window_minutes: 300, resets_at: 1_792_500_000 },
        secondary: { used_percent: 12, window_minutes: 10080, resets_in_seconds: 3600 },
      },
      "2026-10-22T08:00:00.000Z",
    );
    expect(limits).toEqual({
      status: "ok",
      at: "2026-10-22T08:00:00.000Z",
      windows: [
        { kind: "session", usedPercent: 42.5, resetsAt: new Date(1_792_500_000_000).toISOString() },
        { kind: "weekly", usedPercent: 12, resetsAt: "2026-10-22T09:00:00.000Z" },
      ],
    });
  });
});

describe("readCodexLimits", () => {
  const home = process.env.CODEX_HOME;
  afterEach(() => {
    if (home === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = home;
  });

  it("finds the last token_count of a session, or of the newest sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "myrel-codex-"));
    process.env.CODEX_HOME = root;
    const day = join(root, "sessions", "2026", "10", "22");
    await mkdir(day, { recursive: true });
    const line = (percent: number, timestamp: string) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: percent, window_minutes: 300 } } },
      });
    await writeFile(
      join(day, "rollout-2026-10-22T07-00-00-aaaa.jsonl"),
      [line(10, "2026-10-22T07:00:00Z"), line(20, "2026-10-22T07:05:00Z"), ""].join("\n"),
    );
    // A newer session with no model call yet.
    await writeFile(join(day, "rollout-2026-10-22T08-00-00-bbbb.jsonl"), '{"type":"session_meta"}\n');

    expect((await readCodexLimits("aaaa"))?.windows[0]?.usedPercent).toBe(20);
    expect((await readCodexLimits())?.at).toBe("2026-10-22T07:05:00.000Z");
    expect(await readCodexLimits("bbbb")).toBeUndefined();
    expect(await readCodexLimits("cccc")).toBeUndefined();
  });
});

describe("RunnerCli", () => {
  it("drops malformed limits instead of refusing the CLI", () => {
    const parsed = RunnerCli.parse({ id: "claude", version: "2.1.0", limits: { windows: "nope" } });
    expect(parsed).toEqual({ id: "claude", version: "2.1.0" });
  });
});
