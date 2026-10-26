import type { BillingGift, GiftOffer } from "@myrel/protocol";
import { type StripeEnv, StripeError, stripe } from "./stripe";

/** How long an unused gift link works. */
export const GIFT_LINK_DAYS = 30;
export const GIFT_MONTHS = [1, 3, 6, 12, 24] as const;

type GiftRow = {
  id: string;
  note: string;
  months: number;
  created_at: number;
  expires_at: number;
  claimed_by: string | null;
  redeemed_at: number | null;
  revoked_at: number | null;
  name: string | null;
  email: string | null;
};

/** A new link's secret: 192 random bits, base64url. */
export function newGiftToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The row id for a link's token: only its hash is stored, so the table alone opens no gift. */
export async function giftId(token: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function statusOf(row: GiftRow, now: number): BillingGift["status"] {
  if (row.redeemed_at) return "redeemed";
  if (row.revoked_at) return "revoked";
  if (row.expires_at <= now) return "expired";
  return row.claimed_by ? "claimed" : "open";
}

export async function createGift(env: Env, input: { createdBy: string; note: string; months: number }) {
  const token = newGiftToken();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO billing_gifts (id, note, months, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await giftId(token), input.note, input.months, input.createdBy, now, now + GIFT_LINK_DAYS * 86400_000)
    .run();
  return token;
}

export async function listGifts(env: Env, now = Date.now()): Promise<BillingGift[]> {
  const { results } = await env.DB.prepare(
    `SELECT g.*, u.name, u.email FROM billing_gifts g LEFT JOIN user u ON u.id = g.claimed_by ORDER BY g.created_at DESC LIMIT 200`,
  ).all<GiftRow>();
  return results.map((row) => ({
    id: row.id,
    note: row.note,
    months: row.months,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    status: statusOf(row, now),
    person: row.email ? { name: row.name ?? "", email: row.email } : null,
  }));
}

/** Revokes a link nobody redeemed yet; a started subscription is ended from Stripe instead. */
export async function revokeGift(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare("UPDATE billing_gifts SET revoked_at = ? WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL")
    .bind(Date.now(), id)
    .run();
  return res.meta.changes > 0;
}

/** What the link offers this person: someone else's claim, expiry or revocation make it unavailable. */
export async function giftOffer(env: Env, token: string, userId: string, now = Date.now()): Promise<GiftOffer> {
  const row = await env.DB.prepare("SELECT * FROM billing_gifts WHERE id = ?").bind(await giftId(token)).first<GiftRow>();
  if (!row || (row.claimed_by && row.claimed_by !== userId)) return { status: "unavailable", months: null };
  if (row.redeemed_at) return { status: "redeemed", months: row.months };
  if (row.revoked_at || row.expires_at <= now) return { status: "unavailable", months: null };
  return { status: "open", months: row.months };
}

/**
 * Reserves the link for this person, so a link that was passed on works for one person only.
 * Returns its row, or null when it cannot be used (unknown, someone else's, used, expired, revoked).
 */
export async function claimGift(env: Env, token: string, userId: string, now = Date.now()) {
  const id = await giftId(token);
  const res = await env.DB.prepare(
    `UPDATE billing_gifts SET claimed_by = ?1 WHERE id = ?2 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?3
       AND (claimed_by IS NULL OR claimed_by = ?1)`,
  )
    .bind(userId, id, now)
    .run();
  if (res.meta.changes === 0) return null;
  return env.DB.prepare("SELECT id, months FROM billing_gifts WHERE id = ?").bind(id).first<{ id: string; months: number }>();
}

/** Marks the gift a subscription was bought with as used, once its plan started. */
export async function redeemGift(env: Env, giftId: string, userId: string, subscriptionId: string) {
  await env.DB.prepare(
    "UPDATE billing_gifts SET redeemed_at = ?, subscription_id = ?, claimed_by = COALESCE(claimed_by, ?) WHERE id = ? AND redeemed_at IS NULL",
  )
    .bind(Date.now(), subscriptionId, userId, giftId)
    .run();
}

/**
 * The 100% coupon for a gift of `months` on the Pro product, made in Stripe on first use. It is
 * never a promotion code, so it can only be applied by the server, never typed into a Checkout.
 */
export async function giftCoupon(env: StripeEnv, months: number, product: string): Promise<string> {
  const id = `myrel_gift_pro_${months}m`;
  try {
    return (await stripe<{ id: string }>(env, "GET", `/coupons/${id}`)).id;
  } catch (err) {
    if (!(err instanceof StripeError && err.status === 404)) throw err;
  }
  try {
    await stripe(env, "POST", "/coupons", {
      id,
      name: `Myrel Pro gift (${months} months)`,
      percent_off: 100,
      duration: "repeating",
      duration_in_months: months,
      applies_to: { products: [product] },
      metadata: { app: "myrel" },
    });
  } catch (err) {
    // Made at the same moment by another request.
    if (!(err instanceof StripeError && err.status === 400)) throw err;
    await stripe(env, "GET", `/coupons/${id}`);
  }
  return id;
}
