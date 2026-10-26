import { API_VERSION, type ServerInfo, ThreadId } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth";
import { BOOKMARK_HEADER, withD1Session } from "./d1-session";
import { authLimit } from "./auth-limit";
import { CAPTCHA_HEADER, captchaConfig } from "./captcha";
import { legalLinks, sellsPlans } from "./extensions";
import { signUpEnabled } from "./instance";
import { verificationRequired } from "./verification";
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
import { accountConnectorRoutes, connectorCatalogRoutes, connectorOAuthRoutes, projectConnectorRoutes } from "./routes/connectors";
import { syncCatalog } from "./connectors/catalog";
import { personalInProjectRoutes } from "./routes/personal-in-project";
import { connectorSuggestionRoutes } from "./routes/connector-suggestions";
import { accountSkillRoutes, projectSkillRoutes } from "./routes/skills";
import { proxyMcp } from "./connectors/gateway";
import { projectTaskModel } from "./keys";
import { DEFAULT_PRICES, messagesBaseUrl, modelCallAllowed, parsePrices, proxyModel } from "./llm";

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
      allowHeaders: ["authorization", "content-type", BOOKMARK_HEADER, CAPTCHA_HEADER],
      exposeHeaders: ["set-auth-token", BOOKMARK_HEADER],
    })(c, next),
  )
  .get("/health", (c) => c.json({ ok: true }))
  // Lets desktop and mobile apps check that an address is a Myrel server they can talk to.
  .get("/info", async (c) =>
    c.json({
      app: "myrel",
      apiVersion: API_VERSION,
      name: c.env.INSTANCE_NAME || "Myrel",
      auth: {
        emailPassword: true,
        signUp: await signUpEnabled(c.env),
        emailVerification: verificationRequired(c.env),
        captcha: captchaConfig(c.env),
        passwordReset: verificationRequired(c.env),
      },
      billing: sellsPlans(),
      legal: legalLinks(c.env, new URL(c.req.url).origin),
    } satisfies ServerInfo),
  )
  .use("/auth/*", authLimit)
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
  // A remote connector (MCP server) of the thread's agent, through Myrel: the turn's token in, the
  // connector's own credentials added here. Streams the server's answer (JSON or SSE) back as is.
  .on(["GET", "POST", "DELETE"], "/agent-mcp/:threadId/c/:name", async (c) => {
    const token = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const threadId = ThreadId.safeParse(c.req.param("threadId"));
    if (!token || !threadId.success) return c.json({ error: "unauthorized" }, 401);
    const thread = await getAgentByName(c.env.THREAD_AGENT, threadId.data);
    const target = await thread.connectorTarget(token, c.req.param("name"));
    if (!target.ok && target.error === "signed_out") {
      // A JSON-RPC error the agent can read, not a 401 its CLI would answer with a sign-in of its own.
      const message = `The sign-in to ${target.title} has ended. Myrel put a card in the thread asking the person to sign in again; carry on without it until they do.`;
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }, 502);
    }
    if (!target.ok) return c.json({ error: target.error }, target.error === "unauthorized" ? 401 : 404);
    return proxyMcp(c.req.raw, target);
  })
  // The model of a cloud turn's harness, through Myrel: the turn's token in, the project's key added
  // here, and each call's cost counted on the turn (see proxyModel).
  .all("/agent-mcp/:threadId/model/*", async (c) => {
    // OpenCode sends the turn's token where the provider expects its key: a bearer token, or Anthropic's x-api-key.
    const token = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? c.req.header("x-api-key");
    const threadId = ThreadId.safeParse(c.req.param("threadId"));
    if (!token || !threadId.success) return c.json({ error: "unauthorized" }, 401);
    const thread = await getAgentByName(c.env.THREAD_AGENT, threadId.data);
    const caller = await thread.modelCaller(token);
    if (!caller) return c.json({ error: "unauthorized" }, 401);
    const model = await projectTaskModel(c.env, caller.projectId);
    if (!model.ok || !model.model.baseUrl) return c.json({ error: { message: model.ok ? "The project's model has no address" : model.reason } }, 502);
    const rest = new URL(c.req.url).pathname.split("/model/").slice(1).join("/model/");
    // Claude Code speaks Anthropic's Messages API: an OpenAI-compatible provider that serves it too
    // (Fireworks) takes those calls at its own Messages address, with the same key and model.
    const messages = rest.startsWith("v1/messages") ? messagesBaseUrl(model.model) : null;
    const kind = messages ? "anthropic" : model.model.kind;
    if (!modelCallAllowed(kind, c.req.method, rest)) return c.json({ error: { message: "Only model calls go through here." } }, 403);
    // Fireworks has no token counting there; Claude Code estimates instead.
    if (messages && rest === "v1/messages/count_tokens") {
      return c.json({ type: "error", error: { type: "not_found_error", message: "Token counting is not available for this model." } }, 404);
    }
    const url = `${(messages ?? model.model.baseUrl).replace(/\/+$/, "")}/${rest}`;
    return proxyModel(
      c.req.raw,
      {
        url,
        apiKey: model.apiKey,
        kind,
        model: model.model.id,
        prices: { ...DEFAULT_PRICES, ...parsePrices(c.env.LLM_PRICES) },
        // Fireworks caches prompts per replica, Messages calls included (see ChatRequest.cacheKey).
        ...(model.model.kind === "openai" && { cacheKey: threadId.data }),
      },
      (usd) => thread.modelCost(caller.taskId, usd),
      (p) => c.executionCtx.waitUntil(p),
    );
  })
  // The skills of the running turn (see turnSkills), for the sandbox or the runner to put next to the agent.
  .get("/agent-mcp/:threadId/skills", async (c) => {
    const token = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const threadId = ThreadId.safeParse(c.req.param("threadId"));
    if (!token || !threadId.success) return c.json({ error: "unauthorized" }, 401);
    const thread = await getAgentByName(c.env.THREAD_AGENT, threadId.data);
    const bundle = await thread.skillBundle(token);
    return bundle ? c.json(bundle) : c.json({ error: "unauthorized" }, 401);
  })
  .route("/file-links", fileLinkRoutes)
  .route("/connectors/oauth", connectorOAuthRoutes)
  .route("/connectors/catalog", connectorCatalogRoutes)
  .route("/account/connectors", accountConnectorRoutes)
  .route("/account/skills", accountSkillRoutes)
  .route("/account", accountRoutes)
  .route("/admin", adminRoutes)
  .route("/projects/:id/artifacts", artifactRoutes)
  .route("/projects/:projectId/routines", routineRoutes)
  .route("/projects/:id/connectors", projectConnectorRoutes)
  .route("/projects/:id/skills", projectSkillRoutes)
  .route("/projects/:id/personal", personalInProjectRoutes)
  .route("/projects/:id/threads/:threadId/connector-suggestions", connectorSuggestionRoutes)
  .route("/projects", projectRoutes)
  // Shares the /projects base, whose auth middleware (in projectRoutes) also covers these routes.
  .route("/projects", knowledgeRoutes)
  .route("/usage", usageRoutes)
  .route("/github", githubRoutes)
  .use("/runner/pair", authLimit)
  .route("/runner", runnerDeviceRoutes)
  .route("/runners", runnerRoutes)
  .route("/notifications", notificationRoutes)
  .notFound((c) => c.json({ error: "not_found" }, 404));

export type AppType = typeof app;

async function serveBuiltAsset(request: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(request);
  if (!res.headers.get("content-type")?.startsWith("text/html")) return res;
  return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
}

// Built files are hashed; one missing from this deploy (a tab opened before it) gets a 404, not the
// app's index.html, so the browser fails the import and the page can reload itself.
const root = new Hono<AppEnv>().get("/assets/*", (c) => serveBuiltAsset(c.req.raw, c.env)).route("/", app);

/**
 * Cron triggers (wrangler.jsonc): every hour, copy what changed in the MCP Registry to the connector
 * catalog. Awaited rather than left to waitUntil, so the run gets the cron's full time; one that
 * still stops early continues from its saved page next hour.
 */
async function scheduled(_controller: ScheduledController, env: Env) {
  try {
    const r = await syncCatalog(env);
    console.log(`connector catalog: read ${r.read}, kept ${r.kept}`);
  } catch (err) {
    console.error("connector catalog sync failed", err);
  }
}

export default {
  fetch: withD1Session(root.fetch),
  scheduled,
} satisfies ExportedHandler<Env>;
