import { isPaid, type Interval, type Limits, limitsFor, monthStart, type PlanId } from "./plans";

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
};

export type Usage = { projects: number; sandboxSeconds: number; modelMicros: number };

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
  return results.find((s) => isPaid(s.status)) ?? null;
}

export async function standingOf(db: D1Database, userId: string): Promise<Standing> {
  const member = await db.prepare("SELECT owner_id FROM billing_team_members WHERE user_id = ?").bind(userId).first<{ owner_id: string }>();
  if (member) {
    const sub = await paidSubscription(db, member.owner_id);
    if (sub?.plan === "team") return standing("team", member.owner_id, sub);
  }
  const own = await paidSubscription(db, userId);
  return own ? standing(own.plan, userId, own) : standing("free", userId, null);
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

/** Projects that run on the service's keys: no key of their own (a server-wide key is the service's). */
const ON_SERVICE_KEY = `(p.llm_key_id IS NULL OR p.llm_key_id IN (SELECT id FROM api_keys WHERE owner_id IS NULL))`;

/** Everyone whose usage pools under a standing: the owner, plus their Team members on a Team plan. */
const GROUP = `SELECT ?1 UNION SELECT user_id FROM billing_team_members WHERE owner_id = ?1 AND ?2 = 'team'`;

/**
 * This month's usage under a standing, pooled across its group. Projects count only the
 * person's own (`userId`), since the project limit is per person.
 */
export async function usageOf(env: Env, standing: Standing, userId: string, now = new Date()): Promise<Usage> {
  const from = monthStart(now).getTime();
  const args = [standing.ownerId, standing.plan];
  const [projects, sandbox, model] = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE created_by = ?").bind(userId),
    env.DB.prepare(
      `SELECT COALESCE(SUM(r.seconds), 0) AS n FROM sandbox_runs r JOIN projects p ON p.id = r.project_id
       WHERE p.created_by IN (${GROUP}) AND r.ended_at >= ?3`,
    ).bind(...args, from),
    // Model spend on the service's keys, coordinator and cloud thread agent alike: a project with
    // its own key pays its own way.
    env.DB.prepare(
      `SELECT COALESCE(SUM(COALESCE(u.cost_micros, ?4)), 0) AS n FROM usage_events u JOIN projects p ON p.id = u.project_id
       WHERE ${ON_SERVICE_KEY} AND p.created_by IN (${GROUP}) AND u.created_at >= ?3`,
    ).bind(...args, from, unpricedCallMicros(env)),
  ]);
  return {
    projects: Number(projects!.results[0]?.n ?? 0),
    sandboxSeconds: Number(sandbox!.results[0]?.n ?? 0),
    modelMicros: Number(model!.results[0]?.n ?? 0),
  };
}

/** Rough cost of cloud sandbox time to the service: standard-1, memory-bound, about $0.05 an hour. */
export const SANDBOX_MICROS_PER_SECOND = 14;

/**
 * What everyone on the Free plan cost the service this month: model spend on its keys plus
 * sandbox time. Checked against BILLING_FREE_MONTHLY_BUDGET_USD so free use can never run away.
 */
export async function freeSpendMicros(env: Env, now = new Date()): Promise<number> {
  const from = monthStart(now).getTime();
  // People with a paid plan of their own, or on a paying owner's team.
  const paid = `SELECT user_id FROM billing_subscriptions WHERE status IN ('trialing', 'active', 'past_due')
    UNION SELECT m.user_id FROM billing_team_members m JOIN billing_subscriptions s ON s.user_id = m.owner_id
      WHERE s.plan = 'team' AND s.status IN ('trialing', 'active', 'past_due')`;
  const [model, sandbox] = await env.DB.batch<{ n: number }>([
    env.DB.prepare(
      `SELECT COALESCE(SUM(COALESCE(u.cost_micros, ?2)), 0) AS n FROM usage_events u JOIN projects p ON p.id = u.project_id
       WHERE ${ON_SERVICE_KEY} AND u.created_at >= ?1 AND p.created_by NOT IN (${paid})`,
    ).bind(from, unpricedCallMicros(env)),
    env.DB.prepare(
      `SELECT COALESCE(SUM(r.seconds), 0) AS n FROM sandbox_runs r JOIN projects p ON p.id = r.project_id
       WHERE r.ended_at >= ?1 AND p.created_by NOT IN (${paid})`,
    ).bind(from),
  ]);
  return Number(model!.results[0]?.n ?? 0) + Number(sandbox!.results[0]?.n ?? 0) * SANDBOX_MICROS_PER_SECOND;
}

const DEFAULT_FREE_BUDGET_USD = 200;

export function freeBudgetMicros(env: Env): number {
  const n = Number((env as BillingVars).BILLING_FREE_MONTHLY_BUDGET_USD);
  return Math.round((Number.isFinite(n) && n >= 0 ? n : DEFAULT_FREE_BUDGET_USD) * 1_000_000);
}
