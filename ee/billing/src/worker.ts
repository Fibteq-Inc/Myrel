/**
 * The hosted service's Worker: the core Myrel Worker plus plans and billing. Deployed with
 * `pnpm --filter @myrel/api run deploy:hosted`; self-hosted servers deploy the core entry.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { setExtensions } from "../../../apps/api/src/extensions";
import { BOOKMARK_HEADER, withD1Session } from "../../../apps/api/src/d1-session";
import core from "../../../apps/api/src/index";
import { trustedOrigins } from "../../../apps/api/src/origins";
import { billingExtensions } from "./limits";
import { billingRoutes } from "./routes";

export { ProjectAgent, RunnerAgent, Sandbox, ThreadAgent } from "../../../apps/api/src/index";

setExtensions(billingExtensions);

const app = new Hono<{ Bindings: Env }>()
  .use("/api/billing/*", (c, next) =>
    cors({
      origin: trustedOrigins(c.env),
      credentials: true,
      allowHeaders: ["authorization", "content-type", BOOKMARK_HEADER],
      exposeHeaders: [BOOKMARK_HEADER],
    })(c, next),
  )
  .route("/api/billing", billingRoutes)
  .all("*", (c) => core.fetch(c.req.raw, c.env, c.executionCtx));

// One D1 session per request across billing and core routes (see d1-session.ts).
export default { fetch: withD1Session(app.fetch), scheduled: core.scheduled } satisfies ExportedHandler<Env>;
