import { createDb, schema } from "@myrel/db";
import { sql } from "drizzle-orm";
import { sha256Hex } from "./runners";

const { errorGroups } = schema;

export type ErrorSource = "api" | "agent" | "cron";

/** Ids, hex, numbers and quoted bits vary between two cases of the same failure; they are left out of its group. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\b[a-z]{2,8}_[0-9A-Za-z]{10,}\b/g, "<id>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/"[^"]*"|'[^']*'/g, "<s>")
    .slice(0, 300);
}

/**
 * Counts a failure in its group (see errorGroups), for admins to see in Settings › Server. Never
 * throws: a failure to record one is only logged.
 */
export async function recordError(env: Pick<Env, "DB">, source: ErrorSource, where: string, err: unknown): Promise<void> {
  try {
    const error = err instanceof Error ? err : new Error(typeof err === "string" ? err : JSON.stringify(err) ?? String(err));
    const name = error.name || "Error";
    const message = (error.message || name).slice(0, 500);
    const stack = error.stack?.slice(0, 4000) ?? null;
    const id = await sha256Hex([source, where, name, normalizeMessage(message)].join("\n"));
    const now = new Date();
    await createDb(env.DB)
      .insert(errorGroups)
      .values({ id, source, where, name, message, stack, count: 1, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoUpdate({
        target: errorGroups.id,
        set: { message, stack, count: sql`${errorGroups.count} + 1`, lastSeenAt: now },
      });
  } catch (e) {
    console.error("recording an error failed", e);
  }
}

/** Logs a failure as before and counts it for admins. */
export function reportError(env: Pick<Env, "DB">, source: ErrorSource, where: string, err: unknown): Promise<void> {
  console.error(where, err);
  return recordError(env, source, where, err);
}

/** Groups not seen for this long are dropped by the hourly cron. */
export const ERROR_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export async function pruneErrors(env: Pick<Env, "DB">, now = Date.now()): Promise<void> {
  await createDb(env.DB)
    .delete(errorGroups)
    .where(sql`${errorGroups.lastSeenAt} < ${now - ERROR_RETENTION_MS}`);
}
