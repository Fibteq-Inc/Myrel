import { createDb, schema } from "@myrel/db";
import type { ErrorSource } from "@myrel/protocol";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { emailEnabled, sendEmail } from "./notifications/channels";
import { sha256Hex } from "./runners";

const { errorGroups, user } = schema;

export type { ErrorSource };

/** The apps report their own errors; their groups are capped so a broken client cannot fill the table. */
const CLIENT_SOURCES: ErrorSource[] = ["web", "desktop", "mobile"];
const MAX_CLIENT_GROUPS = 500;
/** At most this many "new error" emails an hour; past it the list in Settings › Server still has them. */
const MAX_ALERTS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

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
 * Counts a failure in its group (see errorGroups), for admins to see in Settings › Server, and
 * emails them the first time a kind of failure shows up. Never throws: a failure to record one is
 * only logged.
 */
export async function recordError(env: Env, source: ErrorSource, where: string, err: unknown): Promise<void> {
  try {
    const error = err instanceof Error ? err : new Error(typeof err === "string" ? err : (JSON.stringify(err) ?? String(err)));
    const name = (error.name || "Error").slice(0, 100);
    const message = (error.message || name).slice(0, 500);
    const stack = error.stack?.slice(0, 4000) ?? null;
    where = where.slice(0, 200);
    const id = await sha256Hex([source, where, name, normalizeMessage(message)].join("\n"));
    const db = createDb(env.DB);
    const now = new Date();
    const counted = await db
      .update(errorGroups)
      .set({ message, stack, count: sql`${errorGroups.count} + 1`, lastSeenAt: now })
      .where(eq(errorGroups.id, id))
      .returning({ id: errorGroups.id });
    if (counted.length) return;
    if (CLIENT_SOURCES.includes(source)) {
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(errorGroups)
        .where(inArray(errorGroups.source, CLIENT_SOURCES));
      if ((row?.n ?? 0) >= MAX_CLIENT_GROUPS) return;
    }
    const added = await db
      .insert(errorGroups)
      .values({ id, source, where, name, message, stack, count: 1, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoUpdate({ target: errorGroups.id, set: { count: sql`${errorGroups.count} + 1`, lastSeenAt: now } })
      .returning({ count: errorGroups.count });
    if (added[0]?.count === 1) await alertAdmins(env, { source, where, name, message }, now);
  } catch (e) {
    console.error("recording an error failed", e);
  }
}

/** Emails the server's admins about a kind of failure seen for the first time. */
async function alertAdmins(env: Env, e: { source: ErrorSource; where: string; name: string; message: string }, now: Date) {
  if (!emailEnabled(env)) return;
  const db = createDb(env.DB);
  const [recent] = await db
    .select({ n: sql<number>`count(*)` })
    .from(errorGroups)
    .where(gte(errorGroups.firstSeenAt, new Date(now.getTime() - HOUR_MS)));
  if ((recent?.n ?? 0) > MAX_ALERTS_PER_HOUR) return;
  const admins = await db.select({ email: user.email }).from(user).where(and(eq(user.role, "admin"), eq(user.emailVerified, true)));
  if (!admins.length) return;
  let origin = env.BETTER_AUTH_URL ?? "";
  while (origin.endsWith("/")) origin = origin.slice(0, -1);
  const link = origin ? `${origin}/settings/server` : null;
  const text = [`A new kind of error (${e.source}) at ${e.where}:`, "", `${e.name}: ${e.message}`, "", link ? `See it: ${link}` : "See it in Settings › Server.", "", "— Myrel"].join("\n");
  const html = `<p>A new kind of error (${esc(e.source)}) at <b>${esc(e.where)}</b>:</p><pre style="white-space:pre-wrap">${esc(`${e.name}: ${e.message}`)}</pre><p>${link ? `<a href="${esc(link)}">See it in Settings › Server</a>` : "See it in Settings › Server."}</p>`;
  const subject = `[Myrel] New error: ${e.where}`.slice(0, 150);
  await Promise.all(
    admins.map((a) => sendEmail(env, { to: a.email, subject, text, html }).catch((err) => console.error("error alert email failed", err))),
  );
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

/** Logs a failure as before and counts it for admins. */
export function reportError(env: Env, source: ErrorSource, where: string, err: unknown): Promise<void> {
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
