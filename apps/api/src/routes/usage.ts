import { USAGE_RANGES, type UsageSummary, type UsageTotals } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { type AppEnv, requireUser } from "../middleware";

const DAY_MS = 86_400_000;
const TOP_THREADS = 8;

const TOTALS = `COUNT(*) AS calls,
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cost_micros), 0) AS costMicros,
  COALESCE(SUM(cost_micros IS NULL), 0) AS unpricedCalls`;

/**
 * Usage across every project the caller is a member of.
 * Query: days (7, 30 or 90), projectId (optional), tzOffset (minutes, as Date#getTimezoneOffset)
 * so days are bucketed in the viewer's time zone.
 */
export const usageRoutes = new Hono<AppEnv>().use(requireUser).get("/", async (c) => {
  const requested = Number(c.req.query("days"));
  const days = (USAGE_RANGES as readonly number[]).includes(requested) ? requested : 30;
  const offsetMs = Math.max(-840, Math.min(840, Math.trunc(Number(c.req.query("tzOffset")) || 0))) * 60_000;
  const projectId = c.req.query("projectId") || null;

  // Local midnight `days - 1` days ago, so the range is whole days ending today.
  const now = Date.now();
  const todayLocal = Math.floor((now - offsetMs) / DAY_MS) * DAY_MS;
  const from = todayLocal - (days - 1) * DAY_MS + offsetMs;

  const where = `u.created_at >= ?1
    AND u.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?2)
    AND (?3 IS NULL OR u.project_id = ?3)`;
  const args = [from, c.get("user").id, projectId];
  const db = c.env.DB;
  const q = (sql: string, ...extra: unknown[]) => db.prepare(sql).bind(...args, ...extra);

  const [totals, daily, byProject, byModel, byAgent, threads, sandbox] = await db.batch<Record<string, unknown>>([
    q(`SELECT ${TOTALS} FROM usage_events u WHERE ${where}`),
    q(
      `SELECT strftime('%Y-%m-%d', (u.created_at - ?4) / 1000, 'unixepoch') AS date, ${TOTALS}
       FROM usage_events u WHERE ${where} GROUP BY date`,
      offsetMs,
    ),
    q(
      `SELECT u.project_id AS projectId, COALESCE(p.name, 'Deleted project') AS name, ${TOTALS}
       FROM usage_events u LEFT JOIN projects p ON p.id = u.project_id
       WHERE ${where} GROUP BY u.project_id ORDER BY costMicros DESC, inputTokens + outputTokens DESC`,
    ),
    // A router's served model says more than the router's own name.
    q(
      `SELECT u.provider AS provider, COALESCE(u.served_model, u.model) AS model, ${TOTALS}
       FROM usage_events u WHERE ${where} GROUP BY 1, 2 ORDER BY costMicros DESC, inputTokens + outputTokens DESC`,
    ),
    q(`SELECT u.agent AS agent, ${TOTALS} FROM usage_events u WHERE ${where} GROUP BY u.agent`),
    q(
      `SELECT u.project_id AS projectId, u.thread_id AS threadId, ${TOTALS}
       FROM usage_events u WHERE ${where} AND u.thread_id IS NOT NULL
       GROUP BY 1, 2 ORDER BY costMicros DESC, inputTokens + outputTokens DESC LIMIT ${TOP_THREADS}`,
    ),
    // Same filter, on sandbox_runs (aliased u, keyed by when the run ended).
    q(
      `SELECT COUNT(*) AS runs, COALESCE(SUM(u.seconds), 0) AS seconds FROM sandbox_runs u
       WHERE ${where.replace("u.created_at", "u.ended_at")}`,
    ),
  ]);

  const byDate = new Map(daily!.results.map((r) => [r.date as string, totalsOf(r)]));
  const series = Array.from({ length: days }, (_, i) => {
    const date = new Date(todayLocal - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10);
    return { date, ...(byDate.get(date) ?? emptyTotals()) };
  });

  // Thread titles live in each project's Durable Object.
  const topThreads = await Promise.all(
    threads!.results.map(async (r) => {
      const agent = await getAgentByName(c.env.PROJECT_AGENT, r.projectId as string);
      const thread = await agent.getThread(r.threadId as string);
      return {
        projectId: r.projectId as string,
        threadId: r.threadId as string,
        title: thread?.title ?? "Untitled thread",
        ...totalsOf(r),
      };
    }),
  );

  return c.json({
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    days,
    totals: totalsOf(totals!.results[0] ?? {}),
    daily: series,
    byProject: byProject!.results.map((r) => ({ projectId: r.projectId as string, name: r.name as string, ...totalsOf(r) })),
    byModel: byModel!.results.map((r) => ({ provider: r.provider as string, model: r.model as string, ...totalsOf(r) })),
    byAgent: byAgent!.results.map((r) => ({ agent: r.agent as "coordinator" | "thread", ...totalsOf(r) })),
    topThreads,
    sandbox: { runs: Number(sandbox!.results[0]?.runs ?? 0), seconds: Number(sandbox!.results[0]?.seconds ?? 0) },
  } satisfies UsageSummary);
});

function totalsOf(r: Record<string, unknown>): UsageTotals {
  return {
    calls: Number(r.calls ?? 0),
    inputTokens: Number(r.inputTokens ?? 0),
    cachedInputTokens: Number(r.cachedInputTokens ?? 0),
    outputTokens: Number(r.outputTokens ?? 0),
    costMicros: Number(r.costMicros ?? 0),
    unpricedCalls: Number(r.unpricedCalls ?? 0),
  };
}

function emptyTotals(): UsageTotals {
  return totalsOf({});
}
