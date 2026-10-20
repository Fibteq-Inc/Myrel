/** What each plan of the hosted service allows. Prices live in Stripe, found by lookup key. */

export type PlanId = "free" | "pro" | "team";
export type Interval = "month" | "year";

export type Limits = {
  /** Projects a person may own; null = no limit. */
  projects: number | null;
  /** Cloud sandbox time per calendar month (UTC). */
  sandboxSeconds: number;
  /**
   * Model spend on the service's keys per calendar month (coordinator and cloud thread agent, for
   * projects without their own key), in millionths of a dollar.
   */
  modelMicros: number;
};

const HOUR = 3600;
const DOLLAR = 1_000_000;

/** Per person; a Team plan multiplies sandbox time and model spend by its seats, pooled. */
export const PLANS: Record<PlanId, Limits> = {
  free: { projects: 3, sandboxSeconds: 2 * HOUR, modelMicros: 1 * DOLLAR },
  pro: { projects: null, sandboxSeconds: 100 * HOUR, modelMicros: 5 * DOLLAR },
  team: { projects: null, sandboxSeconds: 150 * HOUR, modelMicros: 5 * DOLLAR },
};

export function limitsFor(plan: PlanId, seats = 1): Limits {
  const base = PLANS[plan];
  const n = plan === "team" ? Math.max(seats, 1) : 1;
  return { projects: base.projects, sandboxSeconds: base.sandboxSeconds * n, modelMicros: base.modelMicros * n };
}

/** Stripe price lookup keys. The setup script creates prices with these keys. */
export const PRICE_KEYS: Record<Exclude<PlanId, "free">, Record<Interval, string>> = {
  pro: { month: "myrel_pro_monthly", year: "myrel_pro_yearly" },
  team: { month: "myrel_team_monthly", year: "myrel_team_yearly" },
};

/** The plan and interval a Stripe price stands for, by its lookup key. */
export function planOfPrice(lookupKey: string | null | undefined): { plan: "pro" | "team"; interval: Interval } | null {
  for (const plan of ["pro", "team"] as const) {
    for (const interval of ["month", "year"] as const) {
      if (PRICE_KEYS[plan][interval] === lookupKey) return { plan, interval };
    }
  }
  return null;
}

export const TRIAL_DAYS = 7;
export const TEAM_MIN_SEATS = 2;

/** Statuses that keep a paid plan. past_due covers Stripe's retries; when they end, Stripe cancels. */
export const PAID_STATUSES = ["trialing", "active", "past_due"] as const;
export function isPaid(status: string): boolean {
  return (PAID_STATUSES as readonly string[]).includes(status);
}

/** First moment of the current calendar month, UTC. Monthly allowances reset then. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
