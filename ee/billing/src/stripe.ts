/** A small Stripe REST client over fetch (the official SDK leans on Node), and webhook verification. */

export type StripeEnv = { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string };

type Params = Record<string, unknown>;

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Stripe's form encoding: nested objects as a[b][c], arrays as a[0]. */
export function encodeForm(params: Params, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) value.forEach((v, i) => (typeof v === "object" ? encodeForm(v as Params, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(v))));
    else if (typeof value === "object") encodeForm(value as Params, name, out);
    else out.append(name, String(value));
  }
  return out;
}

export async function stripe<T>(env: StripeEnv, method: "GET" | "POST" | "DELETE", path: string, params: Params = {}): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new StripeError("Billing is not configured on this server (STRIPE_SECRET_KEY).", 503);
  const form = encodeForm(params).toString();
  const url = `https://api.stripe.com/v1${path}${method === "GET" && form ? `?${form}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(method === "GET" ? {} : { "content-type": "application/x-www-form-urlencoded" }),
    },
    body: method === "GET" ? undefined : form,
  });
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new StripeError(body.error?.message ?? `Stripe answered ${res.status}`, res.status);
  return body;
}

/** Tolerance for the webhook timestamp, against replays. */
const TOLERANCE_SEC = 300;

/** Checks a `Stripe-Signature` header (t=…,v1=…) against the raw body. */
export async function verifyWebhook(payload: string, header: string | undefined, secret: string, now = Date.now()): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || signatures.length === 0 || Math.abs(now / 1000 - Number(t)) > TOLERANCE_SEC) return false;
  const expected = await hmacHex(secret, `${t}.${payload}`);
  return signatures.some((s) => timingSafeEqual(s, expected));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The parts of Stripe objects Myrel reads.

export type StripeSubscription = {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  trial_end: number | null;
  /** Older API versions; newer ones carry it on each item. */
  current_period_end?: number;
  metadata?: Record<string, string>;
  items: {
    data: {
      id: string;
      quantity?: number;
      current_period_end?: number;
      price: { id: string; lookup_key: string | null; recurring: { interval: string } | null };
    }[];
  };
};

export type StripeEvent = { id: string; type: string; data: { object: unknown } };
