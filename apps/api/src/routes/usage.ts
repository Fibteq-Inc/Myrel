import { COORDINATOR_HARNESS, UNKNOWN_HARNESS, USAGE_MAX_DAYS, type UsageSummary, type UsageTotals } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { type AppEnv, requireUser } from "../middleware";

const DAY_MS = 86_400_000;
const TOP_THREADS = 8;

/**
 * Every turn in the range the caller may see, one row per model. turn_stats holds the turns of threads
 * and of the coordinator's CLI; usage_events adds what is not there: the coordinator on the server's
 * model, and cloud turns from before turn_stats. A turn in both is turn_stats' alone. `turn` is 1 on one
 * row of each turn, so turns add up however the rows are grouped.
 *
 * ?1 from, ?2 to (excluded), ?3 the caller, ?4 project, ?5 harness, ?6 runtime, ?7 1 = the caller's own.
 */
const TURNS = `WITH turns AS (
  SELECT 1 AS turn, t.project_id, t.thread_id, t.user_id, CASE WHEN t.thread_id IS NULL THEN 'coordinator' ELSE 'thread' END AS agent,
    t.runtime, t.harness, COALESCE(t.provider, t.harness) AS provider, t.model, t.ended_at AS at, 1 AS calls,
    t.input_tokens, COALESCE(t.cached_input_tokens, 0) AS cached_input_tokens, t.output_tokens, t.cost_micros, t.unpriced_calls,
    t.ended_at - t.started_at AS duration_ms, COALESCE(t.model_ms, 0) AS model_ms,
    CASE WHEN t.model_ms > 0 THEN t.output_tokens ELSE 0 END AS model_output_tokens, t.outcome = 'failed' AS failed
  FROM turn_stats t
  WHERE t.ended_at >= ?1 AND t.ended_at < ?2 AND (?4 IS NULL OR t.project_id = ?4)
    AND t.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?3)
  UNION ALL
  SELECT ROW_NUMBER() OVER (PARTITION BY u.turn_id ORDER BY MIN(u.created_at)) = 1, u.project_id, u.thread_id, u.user_id, u.agent,
    'cloud', CASE u.agent WHEN 'coordinator' THEN '${COORDINATOR_HARNESS}' ELSE '${UNKNOWN_HARNESS}' END,
    u.provider, COALESCE(u.served_model, u.model), MAX(u.created_at), COUNT(*),
    SUM(u.input_tokens), SUM(u.cached_input_tokens), SUM(u.output_tokens), COALESCE(SUM(u.cost_micros), 0), SUM(u.cost_micros IS NULL),
    SUM(u.latency_ms), CASE u.agent WHEN 'coordinator' THEN SUM(u.latency_ms) ELSE 0 END,
    CASE u.agent WHEN 'coordinator' THEN SUM(u.output_tokens) ELSE 0 END, 0
  FROM usage_events u
  WHERE u.created_at >= ?1 AND u.created_at < ?2 AND (?4 IS NULL OR u.project_id = ?4)
    AND u.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?3)
    AND NOT EXISTS (SELECT 1 FROM turn_stats t WHERE t.id = u.turn_id)
  GROUP BY u.turn_id, u.provider, COALESCE(u.served_model, u.model)
)`;

/** On the rows above, so both halves are filtered alike. */
const FILTER = `(?5 IS NULL OR harness = ?5) AND (?6 IS NULL OR runtime = ?6) AND (?7 = 0 OR user_id = ?3)`;

const TOTALS = `SUM(calls) AS calls,
  SUM(input_tokens) AS inputTokens,
  SUM(cached_input_tokens) AS cachedInputTokens,
  SUM(output_tokens) AS outputTokens,
  SUM(cost_micros) AS costMicros,
  SUM(unpriced_calls) AS unpricedCalls,
  SUM(turn) AS turns,
  SUM(failed) AS failedTurns,
  SUM(duration_ms) AS durationMs,
  SUM(model_ms) AS modelMs,
  SUM(model_output_tokens) AS modelOutputTokens`;

type Totals = Required<UsageTotals>;
type Slice = Totals & {
  date: string;
  projectId: string;
  name: string | null;
  agent: "coordinator" | "thread";
  runtime: "local" | "cloud";
  harness: string;
  provider: string;
  model: string;
};

/**
 * Usage across every project the caller is a member of.
 * Query: days (whole days ending today; 30 unless given) or from and to (YYYY-MM-DD, both included),
 * projectId, cli (a harness name), runtime (local or cloud), scope (all, or mine: the turns that worked
 * for the caller), tzOffset (minutes, as Date#getTimezoneOffset) so days are the viewer's.
 */
export const usageRoutes = new Hono<AppEnv>().use(requireUser).get("/", async (c) => {
  const offsetMs = Math.max(-840, Math.min(840, Math.trunc(Number(c.req.query("tzOffset")) || 0))) * 60_000;
  const now = Date.now();
  const today = Math.floor((now - offsetMs) / DAY_MS) * DAY_MS;

  // The first and the last day, as UTC midnights of the viewer's own dates.
  let first: number;
  let last = today;
  const fromDay = c.req.query("from");
  const toDay = c.req.query("to");
  if (fromDay || toDay) {
    const [a, b] = [parseDay(fromDay), parseDay(toDay)];
    if (a === null || b === null || a > b) return c.json({ error: "from and to must be dates (YYYY-MM-DD), from not after to" }, 400);
    last = Math.min(b, today);
    first = Math.min(a, last);
    if ((last - first) / DAY_MS >= USAGE_MAX_DAYS) return c.json({ error: `a range covers at most ${USAGE_MAX_DAYS} days` }, 400);
  } else {
    const requested = Number(c.req.query("days"));
    const days = Number.isInteger(requested) && requested >= 1 && requested <= USAGE_MAX_DAYS ? requested : 30;
    first = today - (days - 1) * DAY_MS;
  }
  const days = (last - first) / DAY_MS + 1;
  const from = first + offsetMs;
  const to = last + DAY_MS + offsetMs;

  const projectId = c.req.query("projectId") || null;
  const cli = c.req.query("cli") || null;
  const runtime = c.req.query("runtime");
  const userId = c.get("user").id;
  const args = [from, to, userId, projectId, cli, runtime === "local" || runtime === "cloud" ? runtime : null, c.req.query("scope") === "mine" ? 1 : 0];
  const db = c.env.DB;

  // One pass over the turns, as fine as any breakdown needs; the breakdowns are added up from it.
  const [slices, threads, sandbox] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `${TURNS}
         SELECT strftime('%Y-%m-%d', (at - ?8) / 1000, 'unixepoch') AS date, turns.project_id AS projectId, p.name AS name,
           agent, runtime, harness, provider, model, ${TOTALS}
         FROM turns LEFT JOIN projects p ON p.id = turns.project_id
         WHERE ${FILTER} GROUP BY 1, 2, 4, 5, 6, 7, 8`,
      )
      .bind(...args, offsetMs),
    db
      .prepare(
        `${TURNS}
         SELECT project_id AS projectId, thread_id AS threadId, ${TOTALS} FROM turns
         WHERE thread_id IS NOT NULL AND ${FILTER}
         GROUP BY 1, 2 ORDER BY costMicros DESC, inputTokens + outputTokens DESC LIMIT ${TOP_THREADS}`,
      )
      .bind(...args),
    db
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(seconds), 0) AS seconds FROM sandbox_runs
         WHERE ended_at >= ?1 AND ended_at < ?2 AND (?4 IS NULL OR project_id = ?4)
           AND project_id IN (SELECT project_id FROM project_members WHERE user_id = ?3)`,
      )
      .bind(...args.slice(0, 4)),
  ]);

  const rows = slices!.results.map((r) => ({ ...(r as unknown as Slice), ...totalsOf(r) }));
  const total = emptyTotals();
  for (const r of rows) add(total, r);
  const byDate = groupBy(rows, (r) => r.date);
  const series = Array.from({ length: days }, (_, i) => {
    const date = new Date(first + i * DAY_MS).toISOString().slice(0, 10);
    return { date, ...(byDate.get(date)?.totals ?? emptyTotals()) };
  });
  const biggest = (a: Totals, b: Totals) => b.costMicros - a.costMicros || tokensOf(b) - tokensOf(a);
  const breakdown = <T>(key: (r: Slice) => string, of: (r: Slice) => T) =>
    [...groupBy(rows, key).values()].map((g) => ({ ...of(g.first), ...g.totals })).sort(biggest);

  // Thread titles live in each project's Durable Object.
  const topThreads = await Promise.all(
    threads!.results.map(async (r) => {
      const agent = await getAgentByName(c.env.PROJECT_AGENT, r.projectId as string);
      const thread = await agent.getThread(r.threadId as string);
      return { projectId: r.projectId as string, threadId: r.threadId as string, title: thread?.title ?? "Untitled thread", ...totalsOf(r) };
    }),
  );

  return c.json({
    from: new Date(from).toISOString(),
    to: new Date(Math.min(to, now)).toISOString(),
    days,
    totals: total,
    daily: series,
    byProject: breakdown((r) => r.projectId, (r) => ({ projectId: r.projectId, name: r.name ?? "Deleted project" })),
    byModel: breakdown((r) => `${r.provider}\n${r.model}`, (r) => ({ provider: r.provider, model: r.model })),
    byAgent: breakdown((r) => r.agent, (r) => ({ agent: r.agent })),
    byCli: breakdown((r) => `${r.harness}\n${r.runtime}`, (r) => ({ harness: r.harness, runtime: r.runtime })).sort((a, b) => tokensOf(b) - tokensOf(a)),
    dailyByCli: [...groupBy(rows, (r) => `${r.date}\n${r.harness}`).values()].map((g) => ({
      date: g.first.date,
      harness: g.first.harness,
      tokens: tokensOf(g.totals),
      turns: g.totals.turns,
      durationMs: g.totals.durationMs,
    })),
    topThreads,
    sandbox: { runs: Number(sandbox!.results[0]?.runs ?? 0), seconds: Number(sandbox!.results[0]?.seconds ?? 0) },
  } satisfies UsageSummary);
});

/** A YYYY-MM-DD date as its UTC midnight; null when it is not one. */
function parseDay(day: string | undefined): number | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const at = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== day ? null : at;
}

function groupBy(rows: Slice[], key: (r: Slice) => string): Map<string, { first: Slice; totals: Totals }> {
  const groups = new Map<string, { first: Slice; totals: Totals }>();
  for (const r of rows) {
    let g = groups.get(key(r));
    if (!g) groups.set(key(r), (g = { first: r, totals: emptyTotals() }));
    add(g.totals, r);
  }
  return groups;
}

function add(sum: Totals, r: Totals): void {
  for (const key of Object.keys(sum) as (keyof Totals)[]) sum[key] += r[key];
}

const tokensOf = (u: UsageTotals) => u.inputTokens + u.outputTokens;

function totalsOf(r: Record<string, unknown>): Totals {
  const n = (key: keyof Totals) => Number(r[key] ?? 0);
  return {
    calls: n("calls"),
    inputTokens: n("inputTokens"),
    cachedInputTokens: n("cachedInputTokens"),
    outputTokens: n("outputTokens"),
    costMicros: n("costMicros"),
    unpricedCalls: n("unpricedCalls"),
    turns: n("turns"),
    failedTurns: n("failedTurns"),
    durationMs: n("durationMs"),
    modelMs: n("modelMs"),
    modelOutputTokens: n("modelOutputTokens"),
  };
}

function emptyTotals(): Totals {
  return totalsOf({});
}
