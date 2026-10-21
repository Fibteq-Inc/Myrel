/**
 * Pro bought in the mobile app, through Apple In-App Purchase or Google Play Billing. RevenueCat
 * checks the receipts and follows renewals (App Store Server Notifications, Google RTDN); Myrel only
 * mirrors what RevenueCat says into billing_subscriptions, so plans and limits work as for Stripe.
 *
 * The app logs in to RevenueCat with the person's Myrel user id, so every purchase names its owner.
 */
import type { Interval } from "./plans";

export type RevenueCatEnv = {
  REVENUECAT_API_KEY?: string;
  REVENUECAT_WEBHOOK_AUTH?: string;
  /** "1" to let test purchases grant Pro to anyone (a staging server). */
  REVENUECAT_ALLOW_SANDBOX?: string;
  /** Accounts whose test purchases grant Pro, comma separated: the App Review demo account. */
  REVENUECAT_SANDBOX_EMAILS?: string;
};

export type Store = "app_store" | "play_store";

/**
 * The store products that grant Pro: App Store product ids, and Google Play subscription:base plan.
 * They must match the products in App Store Connect and the Play Console.
 */
export const STORE_PRODUCTS: Record<string, Interval> = {
  "io.fibteq.myrel.pro.monthly": "month",
  "io.fibteq.myrel.pro.yearly": "year",
  "pro:monthly": "month",
  "pro:yearly": "year",
};

/** Whether the mobile app may sell Pro here: RevenueCat is set up on this server. */
export function sellsInStores(env: RevenueCatEnv): boolean {
  return Boolean(env.REVENUECAT_API_KEY && env.REVENUECAT_WEBHOOK_AUTH);
}

/** The parts of a RevenueCat (REST v1) subscription Myrel reads. Dates are ISO strings. */
export type RevenueCatSubscription = {
  store: string;
  expires_date: string | null;
  period_type: "trial" | "intro" | "normal" | "prepaid" | string;
  unsubscribe_detected_at?: string | null;
  grace_period_expires_date?: string | null;
  refunded_at?: string | null;
  /** A test purchase (TestFlight, App Review, Play license testers), which costs nothing. */
  is_sandbox?: boolean;
  /** Google Play's base plan, when the key is the subscription id alone. */
  product_plan_identifier?: string | null;
};

export type RevenueCatEvent = {
  id?: string;
  type: string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  transferred_from?: string[];
  transferred_to?: string[];
};

/** A store subscription as Myrel stores it. */
export type StoreSubscription = {
  id: string;
  source: Store;
  productId: string;
  interval: Interval;
  status: "trialing" | "active" | "expired";
  periodEnd: number | null;
  trialEnd: number | null;
  cancelAtPeriodEnd: boolean;
};

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);

/**
 * Reads RevenueCat's subscriptions of one person into the store subscriptions that grant Pro. Test
 * purchases count only when `sandbox` allows them for this person, since anyone with a test build
 * can make one for free.
 */
export function storeSubscriptions(
  userId: string,
  subs: Record<string, RevenueCatSubscription>,
  now = Date.now(),
  sandbox = false,
): StoreSubscription[] {
  const out: StoreSubscription[] = [];
  for (const [key, sub] of Object.entries(subs)) {
    if (sub.store !== "app_store" && sub.store !== "play_store") continue;
    if (sub.is_sandbox && !sandbox) continue;
    const productId = sub.product_plan_identifier && !key.includes(":") ? `${key}:${sub.product_plan_identifier}` : key;
    const interval = STORE_PRODUCTS[productId];
    if (!interval) continue;
    const expires = time(sub.expires_date);
    // The store's own billing grace period keeps the plan while it retries a payment.
    const until = Math.max(expires ?? 0, time(sub.grace_period_expires_date) ?? 0);
    const live = !sub.refunded_at && until > now;
    out.push({
      id: `rc:${sub.store}:${productId}:${userId}`,
      source: sub.store,
      productId,
      interval,
      status: live ? (sub.period_type === "trial" ? "trialing" : "active") : "expired",
      periodEnd: expires,
      trialEnd: sub.period_type === "trial" ? expires : null,
      cancelAtPeriodEnd: Boolean(sub.unsubscribe_detected_at),
    });
  }
  return out;
}

/** Everyone an event is about: its buyer and, for a transfer between accounts, both sides. */
export function eventUserIds(event: RevenueCatEvent): string[] {
  const ids = [event.app_user_id, event.original_app_user_id, ...(event.aliases ?? []), ...(event.transferred_from ?? []), ...(event.transferred_to ?? [])];
  // Anonymous RevenueCat ids are not Myrel people.
  return [...new Set(ids.filter((id): id is string => Boolean(id) && !id!.startsWith("$RCAnonymousID:")))];
}

export class RevenueCatError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A person's subscriptions as RevenueCat knows them now. */
export async function fetchSubscriptions(env: RevenueCatEnv, userId: string): Promise<Record<string, RevenueCatSubscription>> {
  if (!env.REVENUECAT_API_KEY) throw new RevenueCatError("In-app purchases are not configured on this server (REVENUECAT_API_KEY).", 503);
  const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`, {
    headers: { authorization: `Bearer ${env.REVENUECAT_API_KEY}`, accept: "application/json" },
  });
  if (!res.ok) throw new RevenueCatError(`RevenueCat answered ${res.status}`, res.status);
  const body = (await res.json()) as { subscriber?: { subscriptions?: Record<string, RevenueCatSubscription> } };
  return body.subscriber?.subscriptions ?? {};
}

/**
 * Mirrors a person's store subscriptions from RevenueCat. Reading the current state, rather than
 * trusting the event, makes this safe to repeat and indifferent to the order events arrive in. A
 * store subscription RevenueCat no longer lists for the person (moved to another account) ends.
 */
export async function syncStoreSubscriptions(env: Env & RevenueCatEnv, userId: string, now = Date.now()): Promise<void> {
  const person = await env.DB.prepare("SELECT email FROM user WHERE id = ?").bind(userId).first<{ email: string }>();
  if (!person) return;
  const subs = storeSubscriptions(userId, await fetchSubscriptions(env, userId), now, sandboxAllowed(env, person.email));
  const kept = JSON.stringify(subs.map((s) => s.id));
  await env.DB.batch([
    ...subs.map((s) =>
      env.DB.prepare(
        `INSERT INTO billing_subscriptions (id, user_id, plan, interval, status, seats, current_period_end, trial_end, cancel_at_period_end,
           source, store_product_id, updated_at)
         VALUES (?1, ?2, 'pro', ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (id) DO UPDATE SET interval = ?3, status = ?4, current_period_end = ?5, trial_end = ?6,
           cancel_at_period_end = ?7, updated_at = ?10`,
      ).bind(s.id, userId, s.interval, s.status, s.periodEnd, s.trialEnd, s.cancelAtPeriodEnd ? 1 : 0, s.source, s.productId, now),
    ),
    env.DB.prepare(
      `UPDATE billing_subscriptions SET status = 'expired', updated_at = ?2
       WHERE user_id = ?1 AND source != 'stripe' AND status != 'expired' AND id NOT IN (SELECT value FROM json_each(?3))`,
    ).bind(userId, now, kept),
  ]);
}

/** Whether a person's test purchases grant Pro: on a staging server, or for the listed review accounts. */
export function sandboxAllowed(env: RevenueCatEnv, email: string): boolean {
  if (env.REVENUECAT_ALLOW_SANDBOX === "1") return true;
  const listed = (env.REVENUECAT_SANDBOX_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase());
  return listed.includes(email.toLowerCase());
}

/** Checks the webhook's Authorization header against the value set in RevenueCat. */
export function verifyAuthorization(header: string | undefined, expected: string | undefined): boolean {
  if (!header || !expected) return false;
  const a = header.replace(/^Bearer\s+/i, "");
  const b = expected.replace(/^Bearer\s+/i, "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
