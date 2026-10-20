#!/usr/bin/env node
/**
 * Creates Myrel's products, prices and billing portal settings in a Stripe account, once.
 * Safe to run again: it reuses products and prices found by their lookup keys.
 *
 *   STRIPE_SECRET_KEY=sk_test_... node ee/billing/scripts/setup-stripe.mjs https://myrel.fibteq.io
 *
 * Prints the webhook signing secret to store as STRIPE_WEBHOOK_SECRET. Use a test key first.
 */
const key = process.env.STRIPE_SECRET_KEY;
const origin = process.argv[2];
if (!key || !origin) {
  console.error("Usage: STRIPE_SECRET_KEY=sk_... node setup-stripe.mjs <server origin>");
  process.exit(1);
}

function form(params, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "object" ? form(x, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(x))));
    else if (typeof v === "object") form(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}

async function api(method, path, params = {}) {
  const body = form(params).toString();
  const res = await fetch(`https://api.stripe.com/v1${path}${method === "GET" ? `?${body}` : ""}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error?.message}`);
  return json;
}

// Amounts in cents (USD). Keep in step with ee/billing/src/plans.ts.
const PRODUCTS = [
  {
    name: "Myrel Pro",
    description: "Unlimited projects, 100 hours of cloud sandbox a month.",
    prices: [
      { lookup_key: "myrel_pro_monthly", unit_amount: 1500, interval: "month" },
      { lookup_key: "myrel_pro_yearly", unit_amount: 14400, interval: "year" },
    ],
  },
  {
    name: "Myrel Team",
    description: "Per person: shared plan, 150 hours of cloud sandbox a month each, pooled.",
    prices: [
      { lookup_key: "myrel_team_monthly", unit_amount: 2500, interval: "month" },
      { lookup_key: "myrel_team_yearly", unit_amount: 24000, interval: "year" },
    ],
  },
];

const portalProducts = [];
for (const product of PRODUCTS) {
  const keys = product.prices.map((p) => p.lookup_key);
  const existing = await api("GET", "/prices", { lookup_keys: keys, expand: ["data.product"] });
  let productId = existing.data[0]?.product?.id;
  if (!productId) {
    productId = (await api("POST", "/products", { name: product.name, description: product.description, tax_code: "txcd_10103001" })).id;
    console.log("created product", product.name, productId);
  }
  const priceIds = [];
  for (const price of product.prices) {
    const found = existing.data.find((p) => p.lookup_key === price.lookup_key);
    if (found) {
      priceIds.push(found.id);
      continue;
    }
    const created = await api("POST", "/prices", {
      product: productId,
      currency: "usd",
      unit_amount: price.unit_amount,
      recurring: { interval: price.interval },
      lookup_key: price.lookup_key,
      tax_behavior: "exclusive",
    });
    console.log("created price", price.lookup_key, created.id);
    priceIds.push(created.id);
  }
  portalProducts.push({ product: productId, prices: priceIds });
}

const portal = await api("POST", "/billing_portal/configurations", {
  business_profile: { headline: "Myrel plan and billing" },
  default_return_url: `${origin}/`,
  features: {
    customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id", "name"] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["price"],
      proration_behavior: "create_prorations",
      products: portalProducts,
    },
  },
});
console.log("billing portal configuration", portal.id, "(make it the default in the Stripe dashboard if it is not)");

const hook = await api("POST", "/webhook_endpoints", {
  url: `${origin}/api/billing/webhook`,
  enabled_events: ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"],
  description: "Myrel billing",
});
console.log("webhook endpoint", hook.id);
console.log("STRIPE_WEBHOOK_SECRET =", hook.secret);
