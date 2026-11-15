import type { LimitCheck } from "../../../apps/api/src/extensions";
import { ownTeam, saveSubscription, syncSeats } from "./routes";
import { type StripeEnv, StripeError, type StripeSubscription, stripe } from "./stripe";

/** Stripe statuses after which a subscription bills nothing more. */
const ENDED = new Set(["canceled", "incomplete_expired"]);

const NOT_CANCELLED =
  "Your subscription on the web could not be cancelled right now, so your account was not deleted. Try again in a few minutes.";

/**
 * Before an account is deleted (the beforeDeleteAccount hook): cancels at once every Stripe
 * subscription the person pays for, so a deleted account is never charged again, and takes them off
 * Teams. A subscription bought in the mobile app is left alone: only the App Store or Google Play can
 * cancel it, and the person is told to do so there. When Stripe cannot cancel one, the account is kept.
 */
export async function endBilling(env: Env & StripeEnv, userId: string): Promise<LimitCheck> {
  try {
    for (const id of await runningSubscriptions(env, userId)) {
      const ended = await stripe<StripeSubscription>(env, "DELETE", `/subscriptions/${id}`).catch((err: unknown) => {
        // Already gone from Stripe: nothing left to bill.
        if (err instanceof StripeError && err.status === 404) return null;
        throw err;
      });
      // Its webhook records the cancellation too; this only spares the wait.
      if (ended) await saveSubscription(env, ended).catch((err: unknown) => console.error("account delete: saving a cancelled subscription", id, err));
    }
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    console.error("account delete: cancelling the subscription", userId, err);
    return { ok: false, reason: NOT_CANCELLED };
  }

  const db = env.DB;
  // A Team the person owned covers nobody now: its members fall back to their own plan and may join another.
  await db.prepare("DELETE FROM billing_team_members WHERE owner_id = ?").bind(userId).run();
  // A seat they had on someone else's Team is no longer billed to its owner (fewer seats give no credit back).
  const seat = await db.prepare("SELECT owner_id FROM billing_team_members WHERE user_id = ?").bind(userId).first<{ owner_id: string }>();
  if (seat) {
    await db.prepare("DELETE FROM billing_team_members WHERE user_id = ?").bind(userId).run();
    const team = await ownTeam(env, seat.owner_id);
    if (team) await syncSeats(env, seat.owner_id, team.id).catch((err: unknown) => console.error("account delete: team seats", seat.owner_id, err));
  }
  return { ok: true };
}

/**
 * The person's Stripe subscriptions that still bill: those Myrel has a record of, and any on their
 * Stripe customer, so one whose webhook has not arrived yet is not missed. Store subscriptions
 * (`rc:` ids) never reach Stripe.
 */
async function runningSubscriptions(env: Env & StripeEnv, userId: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT id, status FROM billing_subscriptions WHERE user_id = ? AND source = 'stripe'")
    .bind(userId)
    .all<{ id: string; status: string }>();
  const ids = new Set(results.filter((s) => !ENDED.has(s.status)).map((s) => s.id));
  const customer = await env.DB.prepare("SELECT stripe_customer_id FROM billing_customers WHERE user_id = ?")
    .bind(userId)
    .first<{ stripe_customer_id: string }>();
  if (customer) {
    const listed = await stripe<{ data: StripeSubscription[] }>(env, "GET", "/subscriptions", {
      customer: customer.stripe_customer_id,
      status: "all",
      limit: 100,
    });
    for (const sub of listed.data) {
      if (ENDED.has(sub.status)) ids.delete(sub.id);
      else ids.add(sub.id);
    }
  }
  return ids;
}
