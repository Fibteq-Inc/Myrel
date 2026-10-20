# Hosted plans and billing

The plans, limits and Stripe billing of the hosted Myrel service (myrel.fibteq.io). Licensed
under the [Fibteq Myrel Enterprise License](../LICENSE). Self-hosted servers do not use this
directory and have no limits.

## How it plugs in

The core defines optional hooks in `apps/api/src/extensions.ts`: `canCreateProject`,
`canUseSandbox`, `canUseCoordinator`, and `billing` (shown to clients in `/api/info`). This
package's `src/worker.ts` is the hosted Worker's entry: it sets the hooks, adds `/api/billing`,
and hands everything else to the core Worker. The core never imports this package.

| File | What it does |
| --- | --- |
| `src/plans.ts` | Plans and their limits, Stripe price lookup keys, trial length |
| `src/store.ts` | A person's plan (their own, or the Team they belong to) and this month's usage |
| `src/limits.ts` | The hooks: refuse a new project, a cloud turn or a coordinator turn over the plan |
| `src/routes.ts` | `GET /api/billing`, Checkout, billing portal, Team members, the Stripe webhook |
| `src/stripe.ts` | A small fetch-based Stripe client and webhook signature check |
| `scripts/setup-stripe.mjs` | Creates products, prices, the portal configuration and the webhook endpoint |

## Plans

| | Free | Pro | Team |
| --- | --- | --- | --- |
| Price | $0 | $15/month, $144/year | $25/person/month, $240/person/year, at least 2 |
| Projects owned | 3 | Unlimited | Unlimited |
| Cloud sandbox | 2 h/month | 100 h/month | 150 h/person/month, pooled |
| Included model usage | $1/month | $5/month | $5/person/month, pooled |

Monthly allowances reset on the 1st (UTC). Included model usage is what the coordinator and the
cloud thread agent spend on the service's model keys, for projects without a key of their own
(a server-wide key counts as the service's). Unpriced model calls count as
`BILLING_UNPRICED_CALL_MICROS` each (default 20000, $0.02). Work on a person's own computer is
never limited.

Free has a second, service-wide guard: once everyone on Free together has cost
`BILLING_FREE_MONTHLY_BUDGET_USD` this month (default 200; model spend plus sandbox time at
about $0.05 an hour), Free cloud turns and coordinator turns stop until the 1st.

When a paid plan ends, nothing is deleted. Projects keep working; only new projects, cloud turns
and coordinator turns over the Free limits are refused.

## Setting it up

1. Create a restricted Stripe key with write access to Customers, Checkout Sessions, Customer
   portal and Subscriptions, and read access to Prices and Products. Store it on the Worker:
   `wrangler secret put STRIPE_SECRET_KEY`.
2. Run the setup script once with a secret key that can create products and webhooks:
   `STRIPE_SECRET_KEY=sk_... node ee/billing/scripts/setup-stripe.mjs https://myrel.fibteq.io`.
   It prints the webhook signing secret: `wrangler secret put STRIPE_WEBHOOK_SECRET`.
   (The products, prices and webhook can also be created in the Stripe dashboard; the price
   lookup keys in `src/plans.ts` are what matter.)
3. In Stripe: Settings > Billing > Subscriptions and emails, retry failed payments for 14 days,
   then cancel the subscription. The billing portal uses the configuration with metadata
   `app=myrel`, so other products in the same Stripe account keep their default portal.
4. Stripe Tax: the head office address is set; add a registration for every place Fibteq must
   collect tax (ask the accountant about the EU and Turkey). Without registrations, Stripe Tax
   charges no tax.
5. Change the Workers Builds deploy command to `pnpm run deploy:hosted` and the preview command
   to `pnpm run deploy:hosted:preview`. Until then the core Worker deploys and nothing is limited.

## Tests

`pnpm --filter @myrel/ee-billing test` runs the hosted Worker in workerd with a fake Stripe.
