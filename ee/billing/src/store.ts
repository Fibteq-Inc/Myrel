import { adminEmails, isListedAdmin } from "../../../apps/api/src/instance";
import { verificationRequired } from "../../../apps/api/src/verification";
import { isPaid, type Interval, type Limits, limitsFor, monthStart, type PlanId, payingSql } from "./plans";

/** The plan a person works under: their own, or the Team plan of the owner who added them. */
export type Standing = {
  plan: PlanId;
  /** Whose plan it is: the person, or the Team owner. Usage is pooled across the owner's team. */
  ownerId: string;
  seats: number;
  limits: Limits;
  subscription: SubscriptionRow | null;
};

export type SubscriptionRow = {
  id: string;
  user_id: string;
  plan: "pro" | "team";
  interval: Interval;
  status: string;
  seats: number;
  current_period_end: number | null;
  trial_end: number | null;
  cancel_at_period_end: number;
  past_due_since: number | null;
};

export type Usage = { projects: number; sandboxSeconds: number; modelMicros: number; connectors: number };

/** Optional vars that tune the hosted plans (set in the Workers dashboard). */
type BillingVars = Env & { BILLING_UNPRICED_CALL_MICROS?: string; BILLING_FREE_MONTHLY_BUDGET_USD?: string };

/** What an unpriced model call (a router whose served model has no known price) counts as. */
const DEFAULT_UNPRICED_CALL_MICROS = 20_000;

export function unpricedCallMicros(env: Env): number {
  const n = Number((env as BillingVars).BILLING_UNPRICED_CALL_MICROS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_UNPRICED_CALL_MICROS;
}

/** The person's latest subscription that still grants a paid plan, if any. */
async function paidSubscription(db: D1Database, userId: string): Promise<SubscriptionRow | null> {
  const { results } = await db
    .prepare("SELECT * FROM billing_subscriptions WHERE user_id = ? ORDER BY updated_at DESC")
    .bind(userId)
    .all<SubscriptionRow>();
  return results.find((s) => isPaid(s.status, s.past_due_since)) ?? null;
}

/** Whether the person is one of the server's admins: stored role admin, or named in ADMIN_EMAILS. */
async function isAdmin(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT role, email, email_verified FROM user WHERE id = ?")
    .bind(userId)
    .first<{ role: string | null; email: string; email_verified: number }>();
  return Boolean(row && (row.role === "admin" || isListedAdmin(env, row.email, Boolean(row.email_verified))));
}

/**
 * The plan a person works under. The server's admins are never limited. A plan the person pays for
 * themselves comes first: a Team owner adding them (which takes no yes from them) never puts their
 * own plan's use into someone else's pool.
 */
export async function standingOf(env: Env, userId: string): Promise<Standing> {
  if (await isAdmin(env, userId)) return standing("admin", userId, null);
  const db = env.DB;
  const own = await paidSubscription(db, userId);
  if (own) return standing(own.plan, userId, own);
  const member = await db.prepare("SELECT owner_id FROM billing_team_members WHERE user_id = ?").bind(userId).first<{ owner_id: string }>();
  if (member) {
    const sub = await paidSubscription(db, member.owner_id);
    if (sub?.plan === "team") return standing("team", member.owner_id, sub);
  }
  return standing("free", userId, null);
}

function standing(plan: PlanId, ownerId: string, sub: SubscriptionRow | null): Standing {
  const seats = sub?.seats ?? 1;
  return { plan, ownerId, seats, limits: limitsFor(plan, seats), subscription: sub };
}

/** The owner of a project, whose plan its usage counts against. */
export async function projectOwner(db: D1Database, projectId: string): Promise<{ owner: string; ownKey: boolean } | null> {
  const row = await db
    .prepare(`SELECT p.created_by, k.owner_id AS key_owner FROM projects p LEFT JOIN api_keys k ON k.id = p.llm_key_id WHERE p.id = ?`)
    .bind(projectId)
    .first<{ created_by: string; key_owner: string | null }>();
  return row ? { owner: row.created_by, ownKey: row.key_owner !== null } : null;
}

/** Everyone whose usage pools under a standing: the owner, plus their Team members on a Team plan. */
const GROUP = `SELECT ?1 UNION SELECT user_id FROM billing_team_members WHERE owner_id = ?1 AND ?2 = 'team'`;

/**
 * This month's usage under a standing, pooled across its group. Projects count only the
 * person's own (`userId`), since the project limit is per person.
 */
export async function usageOf(env: Env, standing: Standing, userId: string, now = new Date()): Promise<Usage> {
  const from = monthStart(now).getTime();
  const args = [standing.ownerId, standing.plan];
  const [projects, sandbox, model, connectors] = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE created_by = ?").bind(userId),
    // Usage counts against whoever owned the project when it was used (billed_to, written with the
    // row), so deleting a project or changing its key later does not take it off the month.
    env.DB.prepare(
      `SELECT COALESCE(SUM(r.seconds), 0) AS n FROM sandbox_runs r
       WHERE r.billed_to IN (${GROUP}) AND r.ended_at >= ?3`,
    ).bind(...args, from),
    // Model spend on the service's keys, coordinator and cloud thread agent alike: a project with
    // its own key pays its own way.
    env.DB.prepare(
      `SELECT COALESCE(SUM(COALESCE(u.cost_micros, ?4)), 0) AS n FROM usage_events u
       WHERE u.service_key = 1 AND u.billed_to IN (${GROUP}) AND u.created_at >= ?3`,
    ).bind(...args, from, unpricedCallMicros(env)),
    // A person's own connectors and those on the projects they own.
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM connectors WHERE owner_id = ?1 OR project_id IN (SELECT id FROM projects WHERE created_by = ?1)",
    ).bind(userId),
  ]);
  return {
    projects: Number(projects!.results[0]?.n ?? 0),
    sandboxSeconds: Number(sandbox!.results[0]?.n ?? 0),
    modelMicros: Number(model!.results[0]?.n ?? 0),
    connectors: Number(connectors!.results[0]?.n ?? 0),
  };
}

/** Rough cost of cloud sandbox time to the service: standard-1, memory-bound, about $0.05 an hour. */
export const SANDBOX_MICROS_PER_SECOND = 14;

/**
 * What everyone on the Free plan or a trial cost the service this month: model spend on its keys plus
 * sandbox time. Checked against BILLING_FREE_MONTHLY_BUDGET_USD so free use can never run away.
 */
export async function freeSpendMicros(env: Env, now = new Date()): Promise<number> {
  const from = monthStart(now).getTime();
  const admins = JSON.stringify(adminEmails(env));
  // People who pay for a plan of their own, or are on a paying owner's team, and the server's admins
  // (a listed address only once verified, see isListedAdmin).
  const verified = verificationRequired(env) ? " AND email_verified = 1" : "";
  const paid = (emails: string) => `SELECT b.user_id FROM billing_subscriptions b WHERE ${payingSql("b", now.getTime())}
    UNION SELECT m.user_id FROM billing_team_members m JOIN billing_subscriptions s ON s.user_id = m.owner_id
      WHERE s.plan = 'team' AND ${payingSql("s", now.getTime())}
    UNION SELECT id FROM user WHERE role = 'admin' OR (lower(email) IN (SELECT value FROM json_each(${emails}))${verified})`;
  const [model, sandbox] = await env.DB.batch<{ n: number }>([
    // Usage of a project that was already gone when it was recorded (billed to nobody) is free use too.
    env.DB.prepare(
      `SELECT COALESCE(SUM(COALESCE(u.cost_micros, ?2)), 0) AS n FROM usage_events u
       WHERE u.service_key = 1 AND u.created_at >= ?1 AND COALESCE(u.billed_to, '') NOT IN (${paid("?3")})`,
    ).bind(from, unpricedCallMicros(env), admins),
    env.DB.prepare(
      `SELECT COALESCE(SUM(r.seconds), 0) AS n FROM sandbox_runs r
       WHERE r.ended_at >= ?1 AND COALESCE(r.billed_to, '') NOT IN (${paid("?2")})`,
    ).bind(from, admins),
  ]);
  return Number(model!.results[0]?.n ?? 0) + Number(sandbox!.results[0]?.n ?? 0) * SANDBOX_MICROS_PER_SECOND;
}

const DEFAULT_FREE_BUDGET_USD = 200;

export function freeBudgetMicros(env: Env): number {
  const n = Number((env as BillingVars).BILLING_FREE_MONTHLY_BUDGET_USD);
  return Math.round((Number.isFinite(n) && n >= 0 ? n : DEFAULT_FREE_BUDGET_USD) * 1_000_000);
}
