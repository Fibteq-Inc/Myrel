/** The hosted service's plans (see ee/billing). Self-hosted servers have none. */
/** `admin`: one of the server's own admins, never limited or billed. */
export type BillingPlan = "free" | "pro" | "team" | "admin";

export type BillingSummary = {
  plan: BillingPlan;
  /** The subscription's status (Stripe's, or trialing/active/expired for a store one); null on Free. */
  status: string | null;
  interval: "month" | "year" | null;
  seats: number;
  /** Whether the caller owns the plan (false for a Team member, who cannot change it). */
  owner: boolean;
  trialEnd: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Who bills the plan: Stripe (bought on the web), or the App Store or Google Play (bought in the mobile app). */
  source: "stripe" | "app_store" | "play_store" | null;
  /** Whether the mobile app may sell Pro through the App Store and Google Play here. */
  storeSales: boolean;
  /** Whether a first checkout would start with a free trial. */
  trialAvailable: boolean;
  /** This calendar month (UTC). Projects: the caller's own. Sandbox and model spend on the service's keys: pooled across a Team. */
  limits: {
    projects: number | null;
    sandboxSeconds: number | null;
    modelMicros: number | null;
    connectors: number | null;
    /** Bytes each project's files may take. */
    storageBytes: number | null;
    /** Cloud turns that may run at once. */
    concurrentSandboxes: number | null;
  };
  usage: { projects: number; sandboxSeconds: number; modelMicros: number; connectors: number };
  /** A Team plan's members besides its owner, for its owner. */
  members: { userId: string; name: string; email: string }[];
};
