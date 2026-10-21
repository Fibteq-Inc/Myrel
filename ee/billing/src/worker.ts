/**
 * The hosted service's Worker: the core Myrel Worker plus plans and billing. Deployed with
 * `pnpm --filter @myrel/api run deploy:hosted`; self-hosted servers deploy the core entry.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { setExtensions } from "../../../apps/api/src/extensions";
import core from "../../../apps/api/src/index";
import { trustedOrigins } from "../../../apps/api/src/origins";
import { billingExtensions } from "./limits";
import { billingRoutes } from "./routes";

export { ProjectAgent, RunnerAgent, Sandbox, ThreadAgent } from "../../../apps/api/src/index";

setExtensions(billingExtensions);

const app = new Hono<{ Bindings: Env }>()
  .use("/api/billing/*", (c, next) =>
    cors({ origin: trustedOrigins(c.env), credentials: true, allowHeaders: ["authorization", "content-type"] })(c, next),
  )
  .route("/api/billing", billingRoutes)
  .all("*", (c) => core.fetch(c.req.raw, c.env, c.executionCtx));

export default { fetch: app.fetch, scheduled: core.scheduled } satisfies ExportedHandler<Env>;
