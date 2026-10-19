import { Hono } from "hono";
import { createAuth } from "./auth";
import type { AppEnv } from "./middleware";
import { projectRoutes } from "./routes/projects";

export { ProjectAgent } from "./agents/project-agent";
export { ThreadAgent } from "./agents/thread-agent";

const app = new Hono<AppEnv>()
  .basePath("/api")
  .get("/health", (c) => c.json({ ok: true }))
  .on(["GET", "POST"], "/auth/*", (c) => createAuth(c.env).handler(c.req.raw))
  .route("/projects", projectRoutes)
  .notFound((c) => c.json({ error: "not_found" }, 404));

export type AppType = typeof app;

export default app satisfies ExportedHandler<Env>;
