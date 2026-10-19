import { API_VERSION, type ServerInfo } from "@altair/protocol";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth, signUpEnabled } from "./auth";
import type { AppEnv } from "./middleware";
import { trustedOrigins } from "./origins";
import { projectRoutes } from "./routes/projects";

export { ProjectAgent } from "./agents/project-agent";
export { ThreadAgent } from "./agents/thread-agent";

const app = new Hono<AppEnv>()
  .basePath("/api")
  // Cross-origin clients (desktop app, a web UI on another domain) use bearer tokens.
  .use("*", (c, next) =>
    cors({
      origin: trustedOrigins(c.env),
      credentials: true,
      allowHeaders: ["authorization", "content-type"],
      exposeHeaders: ["set-auth-token"],
    })(c, next),
  )
  .get("/health", (c) => c.json({ ok: true }))
  // Lets desktop and mobile apps check that an address is an Altair server they can talk to.
  .get("/info", (c) =>
    c.json({
      app: "altair",
      apiVersion: API_VERSION,
      name: c.env.INSTANCE_NAME || "Altair",
      auth: { emailPassword: true, signUp: signUpEnabled(c.env) },
    } satisfies ServerInfo),
  )
  .on(["GET", "POST"], "/auth/*", (c) => createAuth(c.env).handler(c.req.raw))
  .route("/projects", projectRoutes)
  .notFound((c) => c.json({ error: "not_found" }, 404));

export type AppType = typeof app;

export default app satisfies ExportedHandler<Env>;
