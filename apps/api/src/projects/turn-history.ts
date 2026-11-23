import { createDb, schema } from "@myrel/db";
import { getAgentByName } from "agents";
import { eq } from "drizzle-orm";
import type { TurnRow } from "../usage";

/** How many threads' turns are read in one go: each is a Durable Object to wake. */
export const TURN_HISTORY_BATCH = 25;
/** How many projects the hourly cron starts. */
const PROJECTS_PER_RUN = 10;
/** D1 allows 100 bound parameters a statement. */
const IN_CHUNK = 50;

/** Starts copying the past turns of projects that have not had it done, the ones in use first. */
export async function startTurnHistory(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM projects WHERE turn_history = 0 ORDER BY last_activity_at DESC LIMIT ?")
    .bind(PROJECTS_PER_RUN)
    .all<{ id: string }>();
  for (const { id } of results) {
    await (await getAgentByName(env.PROJECT_AGENT, id)).fillTurnHistory(null).catch((err: unknown) => console.error("turn history", id, err));
  }
}

/** The project's past turns are all in turn_stats. */
export async function markTurnHistory(d1: D1Database, projectId: string): Promise<void> {
  await createDb(d1).update(schema.projects).set({ turnHistory: true }).where(eq(schema.projects.id, projectId));
}

/**
 * Copies these threads' finished turns into turn_stats; a turn already there stays as it is. A turn on
 * a computer worked for its owner. A cloud turn's cost is the billing ledger's. Model time was not
 * measured then, so those turns have none.
 */
export async function fillTurnHistory(env: Env, projectId: string, threadIds: string[]): Promise<void> {
  if (threadIds.length === 0) return;
  const found = await Promise.all(
    threadIds.map(async (id) => {
      try {
        return await (await getAgentByName(env.THREAD_AGENT, id)).turnHistory();
      } catch (err) {
        console.error("turn history", projectId, id, err);
        return [];
      }
    }),
  );
  const turns = found.flat();
  if (turns.length === 0) return;
  const owners = new Map<string, string>();
  const runnerIds = [...new Set(turns.flatMap((t) => t.runnerId ?? []))];
  for (const ids of chunks(runnerIds, IN_CHUNK)) {
    const { results } = await env.DB.prepare(`SELECT id, user_id AS userId FROM runners WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<{ id: string; userId: string }>();
    for (const r of results) owners.set(r.id, r.userId);
  }
  const { results: costs } = await env.DB.prepare(
    `SELECT turn_id AS id, COALESCE(SUM(cost_micros), 0) AS costMicros, SUM(cost_micros IS NULL) AS unpricedCalls
     FROM usage_events WHERE project_id = ? AND thread_id IN (${threadIds.map(() => "?").join(",")}) GROUP BY turn_id`,
  )
    .bind(projectId, ...threadIds)
    .all<{ id: string; costMicros: number; unpricedCalls: number }>();
  const costOf = new Map(costs.map((c) => [c.id, { costMicros: c.costMicros, unpricedCalls: c.unpricedCalls }]));
  const db = createDb(env.DB);
  const rows: TurnRow[] = turns.map(({ row, runnerId }) => ({ ...row, userId: (runnerId && owners.get(runnerId)) || null, ...costOf.get(row.id) }));
  for (const part of chunks(rows, IN_CHUNK)) {
    const [first, ...more] = part.map((row) => db.insert(schema.turnStats).values(row).onConflictDoNothing());
    await db.batch([first!, ...more]);
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}
