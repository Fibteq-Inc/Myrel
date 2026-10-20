import type { BillingSummary } from "@myrel/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, requireUser } from "../../../apps/api/src/middleware";
import { isPaid, PRICE_KEYS, planOfPrice, TEAM_MIN_SEATS, TRIAL_DAYS } from "./plans";
import { standingOf, usageOf } from "./store";
import { type StripeEnv, StripeError, type StripeEvent, type StripeSubscription, stripe, verifyWebhook } from "./stripe";

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
      if (event.type.startsWith("customer.subscription.")) await saveSubscription(c.env, event.data.object as StripeSubscription);
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
    const standing = await standingOf(db, user.id);
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
      trialAvailable: !customer?.trial_used,
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
    const standing = await standingOf(c.env.DB, user.id);
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
    const trial = !customer.trialUsed;
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
      return_url: `${new URL(c.req.url).origin}/settings/billing`,
    });
    return c.json({ url: session.url });
  })
  /** A Team owner adds someone with a Myrel account; the seat count follows. */
  .post("/team/members", async (c) => {
    const email = z.string().email().safeParse((await c.req.json().catch(() => null))?.email);
    if (!email.success) return c.json({ error: "invalid_input" }, 400);
    const owner = c.get("user");
    const sub = await ownTeam(c.env.DB, owner.id);
    if (!sub) return c.json({ error: "forbidden", message: "Only the owner of a Team plan can add people." }, 403);
    const person = await c.env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email.data.toLowerCase()).first<{ id: string }>();
    if (!person) return c.json({ error: "not_found", message: "No Myrel account uses that email. Ask them to sign up first." }, 404);
    if (person.id === owner.id) return c.json({ error: "invalid_input", message: "You are already on your plan." }, 400);
    const added = await c.env.DB.prepare("INSERT OR IGNORE INTO billing_team_members (owner_id, user_id, created_at) VALUES (?, ?, ?)")
      .bind(owner.id, person.id, Date.now())
      .run();
    if (added.meta.changes === 0) return c.json({ error: "conflict", message: "That person is already on a team." }, 409);
    await syncSeats(c.env, owner.id, sub.id);
    return c.body(null, 204);
  })
  .delete("/team/members/:userId", async (c) => {
    const owner = c.get("user");
    const sub = await ownTeam(c.env.DB, owner.id);
    if (!sub) return c.json({ error: "forbidden" }, 403);
    await c.env.DB.prepare("DELETE FROM billing_team_members WHERE owner_id = ? AND user_id = ?").bind(owner.id, c.req.param("userId")).run();
    await syncSeats(c.env, owner.id, sub.id);
    return c.body(null, 204);
  });

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

async function ownTeam(db: D1Database, userId: string) {
  const standing = await standingOf(db, userId);
  return standing.plan === "team" && standing.ownerId === userId ? standing.subscription : null;
}

/** Bills a Team for its owner plus members, never fewer than the minimum seats. */
async function syncSeats(env: Env & StripeEnv, ownerId: string, subscriptionId: string) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM billing_team_members WHERE owner_id = ?").bind(ownerId).first<{ n: number }>();
  const seats = Math.max(TEAM_MIN_SEATS, 1 + Number(row?.n ?? 0));
  const sub = await stripe<StripeSubscription>(env, "GET", `/subscriptions/${subscriptionId}`);
  const item = sub.items.data[0];
  if (!item || item.quantity === seats) return;
  const updated = await stripe<StripeSubscription>(env, "POST", `/subscriptions/${subscriptionId}`, {
    items: [{ id: item.id, quantity: seats }],
    proration_behavior: "create_prorations",
  });
  await saveSubscription(env, updated);
}

/** Records a subscription as Stripe describes it. Ignores prices that are not Myrel plans. */
export async function saveSubscription(env: Env, sub: StripeSubscription) {
  const item = sub.items.data[0];
  const plan = planOfPrice(item?.price.lookup_key);
  if (!item || !plan) {
    console.warn("billing: subscription with an unknown price", sub.id, item?.price.lookup_key);
    return;
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
      `INSERT INTO billing_subscriptions (id, user_id, plan, interval, status, seats, current_period_end, trial_end, cancel_at_period_end, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (id) DO UPDATE SET plan = ?3, interval = ?4, status = ?5, seats = ?6, current_period_end = ?7,
         trial_end = ?8, cancel_at_period_end = ?9, updated_at = ?10`,
    ).bind(sub.id, userId, plan.plan, plan.interval, sub.status, item.quantity ?? 1, ms(periodEnd), ms(sub.trial_end), sub.cancel_at_period_end ? 1 : 0, Date.now()),
    // One trial per person.
    env.DB.prepare("UPDATE billing_customers SET trial_used = 1 WHERE user_id = ? AND ?").bind(userId, sub.trial_end ? 1 : 0),
  ]);
  // A Team that lapses keeps its member list, so renewing restores it; members fall back to their own plan meanwhile.
  if (!isPaid(sub.status)) console.log("billing: subscription ended", sub.id, sub.status);
}
