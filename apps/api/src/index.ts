import { API_VERSION, type ServerInfo, ThreadId } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth";
import { signUpEnabled } from "./instance";
import type { AppEnv } from "./middleware";
import { trustedOrigins } from "./origins";
import { accountRoutes } from "./routes/account";
import { adminRoutes } from "./routes/admin";
import { fileLinkRoutes, knowledgeRoutes } from "./routes/knowledge";
import { githubRoutes } from "./routes/github";
import { artifactRoutes } from "./routes/artifacts";
import { projectRoutes } from "./routes/projects";
import { usageRoutes } from "./routes/usage";
import { runnerDeviceRoutes, runnerRoutes } from "./routes/runners";
import { notificationRoutes } from "./routes/notifications";
import { routineRoutes } from "./routes/routines";

export { ProjectAgent } from "./agents/project-agent";
export { RunnerAgent } from "./agents/runner-agent";
export { ThreadAgent } from "./agents/thread-agent";
export { Sandbox } from "./sandbox/sandbox";

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
  // Lets desktop and mobile apps check that an address is a Myrel server they can talk to.
  .get("/info", async (c) =>
    c.json({
      app: "myrel",
      apiVersion: API_VERSION,
      name: c.env.INSTANCE_NAME || "Myrel",
      auth: { emailPassword: true, signUp: await signUpEnabled(c.env) },
    } satisfies ServerInfo),
  )
  .on(["GET", "POST"], "/auth/*", (c) => createAuth(c.env).handler(c.req.raw))
  // MCP endpoint of a thread whose agent is the person's Claude Code (thread engine "harness"). No user
  // session: the bearer token is the one the thread gave that agent turn. Stateless JSON, so no SSE stream.
  .on(["GET", "DELETE"], "/agent-mcp/:threadId", (c) => c.body(null, 405))
  .post("/agent-mcp/:threadId", async (c) => {
    const token = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const threadId = ThreadId.safeParse(c.req.param("threadId"));
    if (!token || !threadId.success) return c.json({ error: "unauthorized" }, 401);
    const body: unknown = await c.req.json().catch(() => undefined);
    if (body === undefined) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    const thread = await getAgentByName(c.env.THREAD_AGENT, threadId.data);
    const result = await thread.agentMcp(token, body);
    if (!result.ok) return c.json({ error: "unauthorized" }, 401);
    return result.answer === null ? c.body(null, 202) : c.json(result.answer);
  })
  .route("/file-links", fileLinkRoutes)
  .route("/account", accountRoutes)
  .route("/admin", adminRoutes)
  .route("/projects/:id/artifacts", artifactRoutes)
  .route("/projects/:projectId/routines", routineRoutes)
  .route("/projects", projectRoutes)
  // Shares the /projects base, whose auth middleware (in projectRoutes) also covers these routes.
  .route("/projects", knowledgeRoutes)
  .route("/usage", usageRoutes)
  .route("/github", githubRoutes)
  .route("/runner", runnerDeviceRoutes)
  .route("/runners", runnerRoutes)
  .route("/notifications", notificationRoutes)
  .notFound((c) => c.json({ error: "not_found" }, 404));

export type AppType = typeof app;

export default app satisfies ExportedHandler<Env>;
