# Hosted plans and billing

The plans, limits and Stripe billing of the hosted Myrel service (myrel.fibteq.io). Licensed
under the [Fibteq Myrel Enterprise License](../LICENSE). Self-hosted servers do not use this
directory and have no limits.

## How it plugs in

The core defines optional hooks in `apps/api/src/extensions.ts`: `canCreateProject`,
`canUseSandbox`, `canUseCoordinator`, `canAddConnector`, `legal` and `billing` (shown to clients in `/api/info`). This
package's `src/worker.ts` is the hosted Worker's entry: it sets the hooks, adds `/api/billing`,
and hands everything else to the core Worker. The core never imports this package.

| File | What it does |
| --- | --- |
| `src/plans.ts` | Plans and their limits, Stripe price lookup keys, trial length |
| `src/store.ts` | A person's plan (their own, or the Team they belong to) and this month's usage |
| `src/limits.ts` | The hooks: refuse a new project, a cloud turn or a coordinator turn over the plan |
| `src/routes.ts` | `GET /api/billing`, Checkout, billing portal, Team members, the Stripe webhook |
| `src/stripe.ts` | A small fetch-based Stripe client and webhook signature check |
| `src/revenuecat.ts` | Pro bought in the mobile app (App Store, Google Play), mirrored from RevenueCat |
| `scripts/setup-stripe.mjs` | Creates products, prices, the portal configuration and the webhook endpoint |

## Plans

| | Free | Pro | Team |
| --- | --- | --- | --- |
| Price | $0 | $15/month, $144/year (in the mobile app: $17.99/month, $179.99/year) | $25/person/month, $240/person/year, at least 2 |
| Projects owned | 3 | Unlimited | Unlimited |
| Cloud sandbox | 2 h/month | 100 h/month | 150 h/person/month, pooled |
| Included model usage | $1/month | $5/month | $5/person/month, pooled |
| Connectors (own + on owned projects) | 2 | Unlimited | Unlimited |

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
3. Nothing to change in the Stripe account's retry settings, which other products may share: a
   past_due subscription keeps its plan for 14 days, then counts as Free, and the next failed
   payment (`invoice.payment_failed`) cancels it. The billing portal uses the configuration with metadata
   `app=myrel`, so other products in the same Stripe account keep their default portal.
4. Stripe Tax: the head office address is set; add a registration for every place Fibteq must
   collect tax (ask the accountant about the EU and Turkey). Without registrations, Stripe Tax
   charges no tax.
5. Change the Workers Builds deploy command to `pnpm run deploy:hosted` and the preview command
   to `pnpm run deploy:hosted:preview`. Until then the core Worker deploys and nothing is limited.

## In-app purchases (mobile)

The mobile app sells Pro (monthly and yearly) through Apple In-App Purchase and Google Play
Billing, by way of RevenueCat. Team and Enterprise are sold on the web only. The store price is
higher than the web price because it includes tax and the store's 15% commission.

- The app logs in to RevenueCat with the person's Myrel user id, so a purchase belongs to the
  account that made it. After a purchase it calls `POST /api/billing/store/sync`.
- RevenueCat posts every event to `POST /api/billing/revenuecat`. Myrel then reads the person's
  subscriptions from RevenueCat's REST API and stores them in `billing_subscriptions` with
  `source` `app_store` or `play_store`, so plans and limits work as for Stripe. The store's own
  billing grace period applies, not Myrel's 14 days.
- Someone with a plan cannot buy another: Checkout refuses, the app hides its purchase buttons,
  and a store plan is managed in the store, not in the Stripe portal.
- Store products (`STORE_PRODUCTS` in `src/revenuecat.ts`): App Store
  `io.fibteq.myrel.pro.monthly` and `io.fibteq.myrel.pro.yearly` in one subscription group;
  Google Play subscription `pro` with base plans `monthly` and `yearly`. Both with a 7-day
  free trial. In RevenueCat: entitlement `pro`, default offering with the monthly and yearly
  packages.

Setting it up:

1. In RevenueCat, add the iOS and Android apps (App Store In-App Purchase key; Play service
   account), then a webhook to `https://myrel.fibteq.io/api/billing/revenuecat` with an
   Authorization header value of your choosing.
2. `wrangler secret put REVENUECAT_WEBHOOK_AUTH` (that value) and
   `wrangler secret put REVENUECAT_API_KEY` (a secret v1 API key of the RevenueCat project).
   Until both are set, the app shows no purchase buttons.
   Test purchases (TestFlight, App Review, Play license testers) are free, so they grant Pro only
   to accounts in `REVENUECAT_SANDBOX_EMAILS` (comma separated; put the App Review demo account
   there), or to everyone when `REVENUECAT_ALLOW_SANDBOX=1` (staging servers only).
3. Point App Store Server Notifications (V2) and Google RTDN at RevenueCat.
4. The app's public SDK keys go into the EAS environment as `EXPO_PUBLIC_REVENUECAT_IOS_KEY`
   and `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY`, then a new store build.

## Tests

`pnpm --filter @myrel/ee-billing test` runs the hosted Worker in workerd with a fake Stripe.
