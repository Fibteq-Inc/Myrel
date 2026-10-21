import type { BillingSummary } from "@myrel/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, requireUser } from "../../../apps/api/src/middleware";
import { UNVERIFIED_MESSAGE } from "../../../apps/api/src/verification";
import { isPaid, PRICE_KEYS, planOfPrice, TEAM_MIN_SEATS, TRIAL_DAYS } from "./plans";
import { standingOf, usageOf } from "./store";
import {
  hmacHex,
  type StripeEnv,
  StripeError,
  type StripeEvent,
  type StripeInvoice,
  type StripeSubscription,
  stripe,
  verifyWebhook,
} from "./stripe";

type BillingEnv = { Bindings: Env & StripeEnv; Variables: AppEnv["Variables"] };

const Checkout = z.object({
  plan: z.enum(["pro", "team"]),
  interval: z.enum(["month", "year"]).default("month"),
  seats: z.number().int().min(TEAM_MIN_SEATS).max(500).optional(),
});

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export const billingRoutes = new Hono<BillingEnv>()
  // Stripe calls this; it authenticates by signature, not by a session.
  .post("/webhook", async (c) => {
    const secret = c.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "not_configured" }, 503);
    const payload = await c.req.text();
    if (!(await verifyWebhook(payload, c.req.header("stripe-signature"), secret))) return c.json({ error: "bad_signature" }, 400);
    const event = JSON.parse(payload) as StripeEvent;
    const fresh = await c.env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, type, created_at) VALUES (?, ?, ?)")
      .bind(event.id, event.type, Date.now())
      .run();
    if (fresh.meta.changes === 0) return c.json({ received: true, duplicate: true });
    try {
      if (event.type.startsWith("customer.subscription.")) {
        const sub = event.data.object as StripeSubscription;
        const owner = await saveSubscription(c.env, sub);
        // A plan change in the billing portal keeps the old quantity: Pro is one seat, Team follows its members.
        if (owner && sub.status !== "past_due" && isPaid(sub.status) && event.type !== "customer.subscription.deleted") {
          await fitSeats(c.env, owner, sub);
        }
        if (sub.status === "past_due") await endAfterGrace(c.env, sub.id);
      } else if (event.type === "invoice.payment_failed") {
        // Each failed retry: end the subscription once Myrel's grace period is over.
        const invoice = event.data.object as StripeInvoice;
        const subscriptionId = invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
        if (typeof subscriptionId === "string") await endAfterGrace(c.env, subscriptionId);
      }
    } catch (err) {
      // Let Stripe retry: forget the event so the redelivery is handled.
      await c.env.DB.prepare("DELETE FROM stripe_events WHERE id = ?").bind(event.id).run();
      throw err;
    }
    return c.json({ received: true });
  })
  .use(requireUser)
  .onError((err, c) => {
    if (err instanceof StripeError) return c.json({ error: "stripe", message: err.message }, err.status === 503 ? 503 : 502);
    throw err;
  })
  .get("/", async (c) => {
    const user = c.get("user");
    const db = c.env.DB;
    const standing = await standingOf(c.env, user.id);
    const usage = await usageOf(c.env, standing, user.id);
    const sub = standing.subscription;
    const owner = standing.ownerId === user.id;
    const customer = await db.prepare("SELECT trial_used FROM billing_customers WHERE user_id = ?").bind(user.id).first<{ trial_used: number }>();
    const members =
      owner && standing.plan === "team"
        ? (
            await db
              .prepare(`SELECT u.id AS userId, u.name, u.email FROM billing_team_members m JOIN user u ON u.id = m.user_id
                WHERE m.owner_id = ? ORDER BY m.created_at`)
              .bind(user.id)
              .all<{ userId: string; name: string; email: string }>()
          ).results
        : [];
    return c.json({
      plan: standing.plan,
      status: sub?.status ?? null,
      interval: sub?.interval ?? null,
      seats: standing.seats,
      owner,
      trialEnd: iso(sub?.trial_end),
      periodEnd: iso(sub?.current_period_end),
      cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
      trialAvailable: !customer?.trial_used && !(await hadTrial(c.env, user.email)),
      limits: standing.limits,
      usage,
      members,
    } satisfies BillingSummary);
  })
  /** Starts a Stripe Checkout for Pro or Team and returns its URL. */
  .post("/checkout", async (c) => {
    const input = Checkout.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_input", issues: input.error.issues }, 400);
    const { plan, interval } = input.data;
    const user = c.get("user");
    // A trial asks for no card: one per address someone has shown is theirs.
    if (!user.verified) return c.json({ error: "email_not_verified", message: UNVERIFIED_MESSAGE }, 403);
    const standing = await standingOf(c.env, user.id);
    if (standing.plan !== "free") {
      return c.json({ error: "already_subscribed", message: "You already have a plan. Change it from the billing portal." }, 409);
    }
    const customer = await customerFor(c.env, user);
    const prices = await stripe<{ data: { id: string }[] }>(c.env, "GET", "/prices", {
      lookup_keys: [PRICE_KEYS[plan][interval]],
      active: true,
    });
    const price = prices.data[0];
    if (!price) return c.json({ error: "not_configured", message: "This plan is not on sale yet." }, 503);
    const origin = new URL(c.req.url).origin;
    const trial = !customer.trialUsed && !(await hadTrial(c.env, user.email));
    const session = await stripe<{ url: string }>(c.env, "POST", "/checkout/sessions", {
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: price.id, quantity: plan === "team" ? (input.data.seats ?? TEAM_MIN_SEATS) : 1 }],
      success_url: `${origin}/settings/billing`,
      cancel_url: `${origin}/settings/billing`,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
      tax_id_collection: { enabled: true },
      subscription_data: { metadata: { user_id: user.id }, ...(trial && { trial_period_days: TRIAL_DAYS }) },
      // A trial starts without a card; Stripe asks for one before the first charge.
      ...(trial && { payment_method_collection: "if_required" }),
    });
    return c.json({ url: session.url });
  })
  /** Stripe's billing portal: change plan or card, cancel, invoices. */
  .post("/portal", async (c) => {
    const user = c.get("user");
    const row = await c.env.DB.prepare("SELECT stripe_customer_id FROM billing_customers WHERE user_id = ?")
      .bind(user.id)
      .first<{ stripe_customer_id: string }>();
    if (!row) return c.json({ error: "no_customer", message: "You have no billing account yet." }, 404);
    const session = await stripe<{ url: string }>(c.env, "POST", "/billing_portal/sessions", {
      customer: row.stripe_customer_id,
      configuration: await portalConfiguration(c.env),
      return_url: `${new URL(c.req.url).origin}/settings/billing`,
    });
    return c.json({ url: session.url });
  })
  /** A Team owner adds someone with a Myrel account; the seat count follows. */
  .post("/team/members", async (c) => {
    const email = z.string().email().safeParse((await c.req.json().catch(() => null))?.email);
    if (!email.success) return c.json({ error: "invalid_input" }, 400);
    const owner = c.get("user");
    const sub = await ownTeam(c.env, owner.id);
    if (!sub) return c.json({ error: "forbidden", message: "Only the owner of a Team plan can add people." }, 403);
    const person = await c.env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email.data.toLowerCase()).first<{ id: string }>();
    if (!person) return c.json({ error: "not_found", message: "No Myrel account uses that email. Ask them to sign up first." }, 404);
    if (person.id === owner.id) return c.json({ error: "invalid_input", message: "You are already on your plan." }, 400);
    // Their own plan would still come first (see standingOf), so the seat would cover nobody.
    const theirs = await standingOf(c.env, person.id);
    if (theirs.plan !== "free" && theirs.ownerId === person.id) {
      return c.json({ error: "conflict", message: "That person pays for a plan of their own." }, 409);
    }
    const added = await c.env.DB.prepare("INSERT OR IGNORE INTO billing_team_members (owner_id, user_id, created_at) VALUES (?, ?, ?)")
      .bind(owner.id, person.id, Date.now())
      .run();
    if (added.meta.changes === 0) return c.json({ error: "conflict", message: "That person is already on a team." }, 409);
    await syncSeats(c.env, owner.id, sub.id);
    return c.body(null, 204);
  })
  /** A member leaves the Team they were added to; they go back to their own plan. */
  .delete("/team/membership", async (c) => {
    const me = c.get("user");
    const row = await c.env.DB.prepare("SELECT owner_id FROM billing_team_members WHERE user_id = ?").bind(me.id).first<{ owner_id: string }>();
    if (!row) return c.json({ error: "not_found" }, 404);
    await c.env.DB.prepare("DELETE FROM billing_team_members WHERE owner_id = ? AND user_id = ?").bind(row.owner_id, me.id).run();
    const team = await ownTeam(c.env, row.owner_id);
    if (team) await syncSeats(c.env, row.owner_id, team.id);
    return c.body(null, 204);
  })
  .delete("/team/members/:userId", async (c) => {
    const owner = c.get("user");
    const sub = await ownTeam(c.env, owner.id);
    if (!sub) return c.json({ error: "forbidden" }, 403);
    await c.env.DB.prepare("DELETE FROM billing_team_members WHERE owner_id = ? AND user_id = ?").bind(owner.id, c.req.param("userId")).run();
    await syncSeats(c.env, owner.id, sub.id);
    return c.body(null, 204);
  });

/**
 * A one-way key for an address, the same for its case and +tag variants (one mailbox), keyed with
 * the server's secret so the stored keys say nothing about addresses on their own.
 */
export async function trialKey(env: Env, email: string): Promise<string> {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  const local = (at < 0 ? address : address.slice(0, at)).split("+")[0];
  return hmacHex(env.BETTER_AUTH_SECRET, `trial:${local}${at < 0 ? "" : address.slice(at)}`);
}

/** Whether the address had a trial before, on this account or one deleted since. */
async function hadTrial(env: Env, email: string): Promise<boolean> {
  return Boolean(await env.DB.prepare("SELECT 1 AS y FROM billing_trials WHERE email_hash = ?").bind(await trialKey(env, email)).first());
}

/** The person's Stripe customer, created on first use. */
async function customerFor(env: Env & StripeEnv, user: { id: string; email: string; name: string }) {
  const row = await env.DB.prepare("SELECT stripe_customer_id, trial_used FROM billing_customers WHERE user_id = ?")
    .bind(user.id)
    .first<{ stripe_customer_id: string; trial_used: number }>();
  if (row) return { id: row.stripe_customer_id, trialUsed: Boolean(row.trial_used) };
  const created = await stripe<{ id: string }>(env, "POST", "/customers", {
    email: user.email,
    name: user.name,
    metadata: { user_id: user.id },
  });
  await env.DB.prepare("INSERT INTO billing_customers (user_id, stripe_customer_id, trial_used, created_at) VALUES (?, ?, 0, ?)")
    .bind(user.id, created.id, Date.now())
    .run();
  return { id: created.id, trialUsed: false };
}

async function ownTeam(env: Env, userId: string) {
  const standing = await standingOf(env, userId);
  return standing.plan === "team" && standing.ownerId === userId ? standing.subscription : null;
}

/** Bills a Team for its owner plus members, never fewer than the minimum seats. */
async function syncSeats(env: Env & StripeEnv, ownerId: string, subscriptionId: string) {
  await fitSeats(env, ownerId, await stripe<StripeSubscription>(env, "GET", `/subscriptions/${subscriptionId}`));
}

/** Sets the subscription's quantity to what its plan calls for: 1 for Pro, the Team's size (at least 2) for Team. */
async function fitSeats(env: Env & StripeEnv, ownerId: string, sub: StripeSubscription) {
  const item = sub.items.data[0];
  const plan = planOfPrice(item?.price.lookup_key);
  if (!item || !plan) return;
  let seats = 1;
  if (plan.plan === "team") {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM billing_team_members WHERE owner_id = ?").bind(ownerId).first<{ n: number }>();
    seats = Math.max(TEAM_MIN_SEATS, 1 + Number(row?.n ?? 0));
  }
  if (item.quantity === seats) return;
  const updated = await stripe<StripeSubscription>(env, "POST", `/subscriptions/${sub.id}`, {
    items: [{ id: item.id, quantity: seats }],
    proration_behavior: "create_prorations",
  });
  await saveSubscription(env, updated);
}

/**
 * Cancels a subscription that has been past_due longer than the grace period, whatever the Stripe
 * account's own retry settings say. Its plan already stopped counting when the grace period ran out.
 */
async function endAfterGrace(env: Env & StripeEnv, subscriptionId: string) {
  const row = await env.DB.prepare("SELECT status, past_due_since FROM billing_subscriptions WHERE id = ?")
    .bind(subscriptionId)
    .first<{ status: string; past_due_since: number | null }>();
  if (row?.status !== "past_due" || isPaid(row.status, row.past_due_since)) return;
  const ended = await stripe<StripeSubscription>(env, "DELETE", `/subscriptions/${subscriptionId}`);
  await saveSubscription(env, ended);
}

let portalConfigurationId: string | null | undefined;

/**
 * The billing portal configuration made for Myrel (metadata app=myrel), so other products in the same
 * Stripe account keep their own default. Without one, Stripe's default configuration is used.
 */
async function portalConfiguration(env: StripeEnv) {
  if (portalConfigurationId === undefined) {
    const list = await stripe<{ data: { id: string; metadata?: Record<string, string> }[] }>(env, "GET", "/billing_portal/configurations", {
      active: true,
      limit: 100,
    }).catch(() => ({ data: [] }));
    portalConfigurationId = list.data.find((config) => config.metadata?.app === "myrel")?.id ?? null;
  }
  return portalConfigurationId ?? undefined;
}

/** Stores a subscription and returns the person who owns it, or null for a price that is not Myrel's. */
export async function saveSubscription(env: Env, sub: StripeSubscription): Promise<string | null> {
  const item = sub.items.data[0];
  const plan = planOfPrice(item?.price.lookup_key);
  if (!item || !plan) {
    console.warn("billing: subscription with an unknown price", sub.id, item?.price.lookup_key);
    return null;
  }
  const userId =
    sub.metadata?.user_id ||
    (
      await env.DB.prepare("SELECT user_id FROM billing_customers WHERE stripe_customer_id = ?")
        .bind(sub.customer)
        .first<{ user_id: string }>()
    )?.user_id;
  if (!userId) throw new Error(`billing: no person for Stripe customer ${sub.customer}`);
  const periodEnd = item.current_period_end ?? sub.current_period_end;
  const ms = (s: number | null | undefined) => (s ? s * 1000 : null);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO billing_subscriptions (id, user_id, plan, interval, status, seats, current_period_end, trial_end, cancel_at_period_end, past_due_since, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CASE WHEN ?5 = 'past_due' THEN ?10 END, ?10)
       ON CONFLICT (id) DO UPDATE SET plan = ?3, interval = ?4, status = ?5, seats = ?6, current_period_end = ?7,
         trial_end = ?8, cancel_at_period_end = ?9, updated_at = ?10,
         past_due_since = CASE WHEN ?5 = 'past_due' THEN COALESCE(past_due_since, ?10) END`,
    ).bind(sub.id, userId, plan.plan, plan.interval, sub.status, item.quantity ?? 1, ms(periodEnd), ms(sub.trial_end), sub.cancel_at_period_end ? 1 : 0, Date.now()),
    // One trial per person.
    env.DB.prepare("UPDATE billing_customers SET trial_used = 1 WHERE user_id = ? AND ?").bind(userId, sub.trial_end ? 1 : 0),
  ]);
  // And per address: an account deleted and made again with it gets none.
  if (sub.trial_end) {
    const person = await env.DB.prepare("SELECT email FROM user WHERE id = ?").bind(userId).first<{ email: string }>();
    if (person) {
      await env.DB.prepare("INSERT OR IGNORE INTO billing_trials (email_hash, created_at) VALUES (?, ?)")
        .bind(await trialKey(env, person.email), Date.now())
        .run();
    }
  }
  // A Team that lapses keeps its member list, so renewing restores it; members fall back to their own plan meanwhile.
  if (!isPaid(sub.status)) console.log("billing: subscription ended", sub.id, sub.status);
  return userId;
}
