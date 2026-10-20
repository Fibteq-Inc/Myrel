/** The hosted service's plans (see ee/billing). Self-hosted servers have none. */
/** `admin`: one of the server's own admins, never limited or billed. */
export type BillingPlan = "free" | "pro" | "team" | "admin";

export type BillingSummary = {
  plan: BillingPlan;
  /** Stripe's subscription status; null on Free. */
  status: string | null;
  interval: "month" | "year" | null;
  seats: number;
  /** Whether the caller owns the plan (false for a Team member, who cannot change it). */
  owner: boolean;
  trialEnd: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Whether a first checkout would start with a free trial. */
  trialAvailable: boolean;
  /** This calendar month (UTC). Projects: the caller's own. Sandbox and model spend on the service's keys: pooled across a Team. */
  limits: { projects: number | null; sandboxSeconds: number | null; modelMicros: number | null; connectors: number | null };
  usage: { projects: number; sandboxSeconds: number; modelMicros: number; connectors: number };
  /** A Team plan's members besides its owner, for its owner. */
  members: { userId: string; name: string; email: string }[];
};
