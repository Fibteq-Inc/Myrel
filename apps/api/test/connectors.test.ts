import type { Connector } from "@myrel/protocol";
import { env as testEnv } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { blockedUrl, probeConnector } from "../src/connectors/client";
import { proxyMcp } from "../src/connectors/gateway";
import { createDb, schema } from "@myrel/db";
import { eq } from "drizzle-orm";
import { refreshStaleTools, remoteTarget, TOOLS_FRESH_MS, turnConnectors } from "../src/connectors/store";

const BASE = "http://myrel.test";
const env = testEnv as unknown as Env;

/** A remote MCP server (mcp.example.com) that wants a key, and one (oauth.example.com) that wants a sign-in. */
const seen: { url: string; headers: Record<string, string>; body?: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!url.hostname.endsWith(".example.com")) return realFetch(input, init);
  const body = request.method === "POST" ? await request.text() : undefined;
  seen.push({ url: url.href, headers: Object.fromEntries(request.headers), body });
  const rpc = body?.startsWith("{") ? (JSON.parse(body) as { id?: number; method: string }) : null;
  const answer = (result: unknown, sse = false) => {
    const message = JSON.stringify({ jsonrpc: "2.0", id: rpc?.id, result });
    return sse
      ? new Response(`event: message\ndata: ${message}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "s1" } })
      : new Response(message, { headers: { "content-type": "application/json", "mcp-session-id": "s1" } });
  };
  const tools = { tools: [{ name: "create_issue", description: "Create an issue." }, { name: "list_issues" }] };

  if (url.hostname === "mcp.example.com") {
    if (request.headers.get("authorization") !== "Bearer good-key") return new Response("no", { status: 401 });
    if (!rpc?.id) return new Response(null, { status: 202 });
    if (rpc.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x", version: "1" } });
    if (rpc.method === "tools/list") return answer(tools, true);
  }
  if (url.hostname === "oauth.example.com") {
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return Response.json({ resource: "https://oauth.example.com/mcp", authorization_servers: ["https://oauth.example.com"], scopes_supported: ["read"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://oauth.example.com",
        authorization_endpoint: "https://oauth.example.com/authorize",
        token_endpoint: "https://oauth.example.com/token",
        registration_endpoint: "https://oauth.example.com/register",
      });
    }
    if (url.pathname === "/register") return Response.json({ client_id: "client-1" }, { status: 201 });
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body);
      const ok = form.get("code") === "good-code" && form.get("code_verifier") && form.get("resource") === "https://oauth.example.com/mcp";
      return ok ? Response.json({ access_token: "oauth-token", refresh_token: "r1", expires_in: 3600 }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url.pathname === "/mcp") {
      if (request.headers.get("authorization") !== "Bearer oauth-token") return new Response("no", { status: 401 });
      if (!rpc?.id) return new Response(null, { status: 202 });
      if (rpc.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: {} });
      if (rpc.method === "tools/list") return answer(tools);
    }
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

function api(path: string, init: Omit<RequestInit, "body"> & { token?: string; body?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers, body, redirect: "manual" }));
}

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return (text ? JSON.parse(text) : null) as T;
}

async function signUp(): Promise<{ token: string; id: string }> {
  const res = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { email: `u${crypto.randomUUID()}@example.org`, password: "correct-horse-battery", name: "Test" },
  });
  const { user } = (await res.json()) as { user: { id: string } };
  return { token: res.headers.get("set-auth-token")!, id: user.id };
}

describe("connector addresses", () => {
  it("only allows public https servers", () => {
    expect(blockedUrl("https://mcp.linear.app/mcp")).toBeNull();
    expect(blockedUrl("http://mcp.linear.app/mcp")).toMatch(/https/);
    expect(blockedUrl("https://localhost:3000/mcp")).not.toBeNull();
    expect(blockedUrl("https://10.0.0.4/mcp")).not.toBeNull();
    expect(blockedUrl("https://192.168.1.2/mcp")).not.toBeNull();
    expect(blockedUrl("https://[::1]/mcp")).not.toBeNull();
    expect(blockedUrl("https://user:pw@example.org/mcp")).not.toBeNull();
  });

  it("lists a server's tools over JSON and SSE answers", async () => {
    expect(await probeConnector("https://mcp.example.com/mcp", { Authorization: "Bearer good-key" })).toEqual({
      ok: true,
      tools: [{ name: "create_issue", description: "Create an issue." }, { name: "list_issues" }],
    });
    const refused = await probeConnector("https://mcp.example.com/mcp", { Authorization: "Bearer bad" });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("401") });
  });
});

describe("connector gateway", () => {
  it("adds the connector's credentials and passes the session through", async () => {
    seen.length = 0;
    const request = new Request("https://myrel.test/api/agent-mcp/thr_x/c/linear", {
      method: "POST",
      headers: { authorization: "Bearer turn-token", "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "s1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
    const res = await proxyMcp(request, { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer good-key" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe("s1");
    expect(await res.text()).toContain("create_issue");
    // The turn's token never reaches the connector; its own key does.
    expect(seen[0]!.headers.authorization).toBe("Bearer good-key");
    expect(seen[0]!.headers["mcp-session-id"]).toBe("s1");
  });
});

describe("connectors API", () => {
  it("adds a remote connector with headers, checks it and never shows the key again", async () => {
    const me = await signUp();
    const { connector } = await json<{ connector: Connector }>(
      api("/api/account/connectors", {
        method: "POST",
        token: me.token,
        body: { transport: "http", name: "Linear", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer good-key" } },
      }),
      201,
    );
    expect(connector).toMatchObject({ slug: "linear", scope: "user", auth: "headers", status: "ok", secretNames: ["Authorization"] });
    expect(connector.tools.map((t) => t.name)).toEqual(["create_issue", "list_issues"]);
    const listed = await json<{ connectors: Connector[] }>(api("/api/account/connectors", { token: me.token }));
    expect(JSON.stringify(listed)).not.toContain("good-key");

    // A second one with the same name gets its own server name.
    const second = await json<{ connector: Connector }>(
      api("/api/account/connectors", { method: "POST", token: me.token, body: { transport: "http", name: "Linear", url: "https://mcp.example.com/mcp" } }),
      201,
    );
    expect(second.connector).toMatchObject({ slug: "linear-2", status: "error" });

    const blocked = await api("/api/account/connectors", { method: "POST", token: me.token, body: { transport: "http", name: "Box", url: "https://127.0.0.1/mcp" } });
    expect(blocked.status).toBe(400);

    // Someone else cannot see or change it.
    const other = await signUp();
    expect((await json<{ connectors: Connector[] }>(api("/api/account/connectors", { token: other.token }))).connectors).toEqual([]);
    expect((await api(`/api/account/connectors/${connector.id}`, { method: "DELETE", token: other.token })).status).toBe(404);
  });

  it("lists a used connector's tools again once its list is old", async () => {
    const me = await signUp();
    const { connector } = await json<{ connector: Connector }>(
      api("/api/account/connectors", {
        method: "POST",
        token: me.token,
        body: { transport: "http", name: "Tracker", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer good-key" } },
      }),
      201,
    );
    const db = createDb(env.DB);
    const tools = async () => (await db.select().from(schema.connectors).where(eq(schema.connectors.id, connector.id)))[0]!.tools.map((t) => t.name);
    await db.update(schema.connectors).set({ tools: [] }).where(eq(schema.connectors.id, connector.id));

    await refreshStaleTools(env, [connector.id]);
    expect(await tools()).toEqual([]);
    await refreshStaleTools(env, [connector.id], Date.now() + TOOLS_FRESH_MS);
    expect(await tools()).toEqual(["create_issue", "list_issues"]);
  });

  it("gives a turn the project's and its requester's connectors, with their credentials kept on the server", async () => {
    const me = await signUp();
    const { project } = await json<{ project: { id: string } }>(api("/api/projects", { method: "POST", token: me.token, body: { name: "P" } }), 201);
    await json(
      api(`/api/projects/${project.id}/connectors`, {
        method: "POST",
        token: me.token,
        body: { transport: "stdio", name: "Database", command: "npx", args: ["-y", "pg-mcp"], env: { DATABASE_URL: "postgres://x" }, runsOn: "local" },
      }),
      201,
    );
    const { connector } = await json<{ connector: Connector }>(
      api("/api/account/connectors", {
        method: "POST",
        token: me.token,
        body: { transport: "http", name: "Linear", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer good-key" } },
      }),
      201,
    );

    const cloud = await turnConnectors(env, { projectId: project.id, userId: me.id, place: "cloud" });
    expect(cloud.map((c) => c.name)).toEqual(["linear"]);
    const local = await turnConnectors(env, { projectId: project.id, userId: me.id, place: "local" });
    expect(local.map((c) => [c.name, c.transport])).toEqual([
      ["database", "stdio"],
      ["linear", "http"],
    ]);
    // A thread that works for nobody in particular gets only the project's.
    expect((await turnConnectors(env, { projectId: project.id, userId: null, place: "local" })).map((c) => c.name)).toEqual(["database"]);

    expect(await remoteTarget(env, connector.id)).toEqual({ url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer good-key" } });
    await json(api(`/api/account/connectors/${connector.id}`, { method: "PATCH", token: me.token, body: { enabled: false } }));
    expect(await remoteTarget(env, connector.id)).toBeNull();
    expect((await turnConnectors(env, { projectId: project.id, userId: me.id, place: "cloud" })).length).toBe(0);
  });

  it("signs in to an OAuth server with PKCE and keeps the token on the server", async () => {
    const me = await signUp();
    const created = await json<{ connector: Connector; authorizeUrl: string }>(
      api("/api/account/connectors", { method: "POST", token: me.token, body: { transport: "http", name: "Flow", url: "https://oauth.example.com/mcp", auth: "oauth" } }),
      201,
    );
    expect(created.connector).toMatchObject({ auth: "oauth", status: "needs_auth" });
    const authorize = new URL(created.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe("https://oauth.example.com/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("client-1");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("resource")).toBe("https://oauth.example.com/mcp");
    expect(authorize.searchParams.get("scope")).toBe("read");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/api/connectors/oauth/callback`);
    // Not yet signed in: no turn gets it.
    expect(await turnConnectors(env, { projectId: "proj_none", userId: me.id, place: "cloud" })).toEqual([]);

    const state = authorize.searchParams.get("state")!;
    const forged = await api(`/api/connectors/oauth/callback?code=good-code&state=${created.connector.id}.forged`);
    expect(forged.headers.get("location")).toContain("result=error");

    const back = await api(`/api/connectors/oauth/callback?code=good-code&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`${BASE}/settings?section=connectors&connector=${created.connector.id}&result=ok`);
    const { connectors } = await json<{ connectors: Connector[] }>(api("/api/account/connectors", { token: me.token }));
    expect(connectors[0]).toMatchObject({ status: "ok", tools: [{ name: "create_issue" }, { name: "list_issues" }] });
    expect(JSON.stringify(connectors)).not.toContain("oauth-token");
    expect(await remoteTarget(env, created.connector.id)).toEqual({ url: "https://oauth.example.com/mcp", headers: { Authorization: "Bearer oauth-token" } });

    // The same sign-in cannot be used twice.
    const replay = await api(`/api/connectors/oauth/callback?code=good-code&state=${encodeURIComponent(state)}`);
    expect(replay.headers.get("location")).toContain("result=error");
  });
});
