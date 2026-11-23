import type { Project, UsageSummary } from "@myrel/protocol";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, signUp } from "./fake-agent";

const DAY = 86_400_000;
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

type Turn = Partial<{ id: string; projectId: string; userId: string | null; threadId: string | null; runtime: string; harness: string; at: number; ms: number; output: number; modelMs: number | null; outcome: string; cost: number }>;

async function setup() {
  const token = await signUp();
  const { user } = (await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } };
  const { project } = (await (await api("/api/projects", { method: "POST", token, body: JSON.stringify({ name: "Stats" }) })).json()) as { project: Project };
  const turn = async (t: Turn) => {
    const at = t.at ?? Date.now();
    const id = t.id ?? `task_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO turn_stats (id, project_id, thread_id, user_id, runtime, harness, model, started_at, ended_at, outcome, input_tokens, output_tokens, model_ms, cost_micros)
       VALUES (?, ?, ?, ?, ?, ?, 'm', ?, ?, ?, 100, ?, ?, ?)`,
    )
      .bind(id, t.projectId ?? project.id, t.threadId === undefined ? "thr_x" : t.threadId, t.userId === undefined ? user.id : t.userId, t.runtime ?? "local", t.harness ?? "claude", at - (t.ms ?? 10_000), at, t.outcome ?? "done", t.output ?? 50, t.modelMs ?? null, t.cost ?? 0)
      .run();
    return id;
  };
  const ledger = (turnId: string, agent: "coordinator" | "thread", cost: number | null) =>
    env.DB.prepare(
      `INSERT INTO usage_events (id, created_at, project_id, thread_id, agent, turn_id, provider, model, input_tokens, output_tokens, cost_micros, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, 'fireworks', 'auto', 1000, 100, ?, 2000)`,
    )
      .bind(crypto.randomUUID(), Date.now(), project.id, agent === "thread" ? "thr_x" : null, agent, turnId, cost)
      .run();
  const usage = async (query: string, expected = 200) => {
    const res = await api(`/api/usage?tzOffset=0&${query}`, { token });
    expect(res.status).toBe(expected);
    return (await res.json()) as UsageSummary;
  };
  return { token, user, project, turn, ledger, usage };
}

describe("usage statistics", () => {
  it("counts turns on people's computers, with both speeds measurable and the rest left out of the model's", async () => {
    const { turn, usage } = await setup();
    await turn({ output: 600, ms: 60_000, modelMs: 10_000 });
    await turn({ output: 400, ms: 40_000 });
    await turn({ harness: "codex", output: 10, ms: 1000, outcome: "failed" });
    const s = await usage("days=7");
    expect(s.totals).toMatchObject({ turns: 3, failedTurns: 1, outputTokens: 1010, durationMs: 101_000, modelMs: 10_000, modelOutputTokens: 600, costMicros: 0, unpricedCalls: 0 });
    expect(s.byCli).toEqual([
      expect.objectContaining({ harness: "claude", runtime: "local", turns: 2, modelOutputTokens: 600 }),
      expect.objectContaining({ harness: "codex", runtime: "local", turns: 1, modelMs: 0 }),
    ]);
    expect(s.dailyByCli).toContainEqual({ date: day(Date.now()), harness: "claude", tokens: 1200, turns: 2, durationMs: 100_000 });
    expect(s.daily.at(-1)).toMatchObject({ turns: 3 });
  });

  it("takes a cloud turn once, and the server's coordinator from the ledger", async () => {
    const { turn, ledger, usage } = await setup();
    const cloud = await turn({ runtime: "cloud", harness: "opencode", cost: 300 });
    await ledger(cloud, "thread", 300);
    await ledger("old-cloud-turn", "thread", 200);
    await ledger("coord", "coordinator", 40);
    await ledger("coord", "coordinator", null);
    const s = await usage("days=7");
    expect(s.totals).toMatchObject({ turns: 3, costMicros: 540, unpricedCalls: 1 });
    expect(Object.fromEntries(s.byCli!.map((c) => [c.harness, [c.turns, c.costMicros]]))).toEqual({ opencode: [1, 300], unknown: [1, 200], coordinator: [1, 40] });
    // Each of the coordinator's calls is timed; an older cloud turn only as a whole.
    expect(s.byCli!.find((c) => c.harness === "coordinator")).toMatchObject({ calls: 2, modelMs: 4000, modelOutputTokens: 200 });
    expect(s.byCli!.find((c) => c.harness === "unknown")).toMatchObject({ durationMs: 2000, modelMs: 0 });
  });

  it("filters by CLI, where it ran, project and whose turn", async () => {
    const { turn, usage, project } = await setup();
    await turn({});
    await turn({ harness: "codex", userId: "someone-else" });
    await turn({ runtime: "cloud", harness: "codex", userId: null });
    const turns = async (query: string) => (await usage(`days=7&${query}`)).totals.turns;
    expect(await turns("cli=codex")).toBe(2);
    expect(await turns("cli=codex&runtime=local")).toBe(1);
    expect(await turns("scope=mine")).toBe(1);
    expect(await turns(`projectId=${project.id}`)).toBe(3);
    expect(await turns("projectId=proj_other")).toBe(0);
    expect((await usage("days=7&cli=codex")).dailyByCli!.every((d) => d.harness === "codex")).toBe(true);
  });

  it("covers the days asked for, both ends included", async () => {
    const { turn, usage } = await setup();
    const today = Math.floor(Date.now() / DAY) * DAY;
    await turn({ at: today - 3 * DAY });
    await turn({ at: today - 2 * DAY + DAY - 1 });
    await turn({ at: today - DAY });
    const s = await usage(`from=${day(today - 3 * DAY)}&to=${day(today - 2 * DAY)}`);
    expect(s.totals.turns).toBe(2);
    expect(s.daily.map((d) => [d.date, d.turns])).toEqual([
      [day(today - 3 * DAY), 1],
      [day(today - 2 * DAY), 1],
    ]);
    // Days that have not come yet are left off.
    expect((await usage(`from=${day(today - DAY)}&to=${day(today + 5 * DAY)}`)).days).toBe(2);
    expect((await usage("days=1")).daily).toHaveLength(1);
    for (const bad of ["from=2026-02-30&to=2026-03-01", "from=2026-03-01", `from=${day(today)}&to=${day(today - DAY)}`, `from=${day(today - 400 * DAY)}&to=${day(today)}`]) {
      await usage(bad, 400);
    }
  });

  it("shows no one a project they are not in, and goes with the project", async () => {
    const { turn, project, token, usage } = await setup();
    await turn({});
    const stranger = (await (await api("/api/usage?days=7", { token: await signUp() })).json()) as UsageSummary;
    expect(stranger.totals.turns).toBe(0);
    expect((await usage("days=7")).totals.turns).toBe(1);
    expect((await api(`/api/projects/${project.id}`, { method: "DELETE", token, body: JSON.stringify({ name: "Stats" }) })).ok).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM turn_stats WHERE project_id = ?").bind(project.id).first("n")).toBe(0);
  });
});
