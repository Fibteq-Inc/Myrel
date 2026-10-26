import { env as testEnv } from "cloudflare:test";
import { createDb, schema } from "@myrel/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accessToken, type OAuthState, readOAuth, startAuthorization } from "../src/connectors/oauth";
import { encryptSecret } from "../src/crypto";

const env = testEnv as unknown as Env;
const db = createDb(env.DB);

/** An OAuth connector whose access token has just expired. */
async function expiredConnector() {
  const id = `con_${crypto.randomUUID()}`;
  const state: OAuthState = {
    clientId: "client-1",
    authorizationEndpoint: "https://as.example.com/authorize",
    tokenEndpoint: "https://as.example.com/token",
    resource: "https://as.example.com/mcp",
    redirectUri: "https://myrel.test/api/connectors/oauth/callback",
    accessToken: "old",
    refreshToken: "r1",
    expiresAt: Date.now() - 1000,
  };
  const now = new Date();
  await db.insert(schema.connectors).values({
    id,
    name: "Example",
    slug: `ex-${id.slice(-8)}`,
    transport: "http",
    url: state.resource,
    auth: "oauth",
    status: "ok",
    secret: await encryptSecret(env, JSON.stringify(state), id),
    createdAt: now,
    updatedAt: now,
  });
  return { id, state, row: () => db.select().from(schema.connectors).where(eq(schema.connectors.id, id)).then((r) => r[0]!) };
}

/** A token endpoint that honours each refresh token once and hands out the next. */
function rotatingServer(delayMs = 0) {
  let valid = "r1";
  let calls = 0;
  const fetcher = (async (_url: string, init: RequestInit) => {
    const n = ++calls;
    const ok = new URLSearchParams(String(init.body)).get("refresh_token") === valid;
    if (ok) valid = `r${n + 1}`;
    await new Promise((r) => setTimeout(r, ok ? delayMs : 0));
    return ok
      ? Response.json({ access_token: `token-${n}`, refresh_token: valid, expires_in: 3600 })
      : Response.json({ error: "invalid_grant" }, { status: 400 });
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
}

describe("OAuth connector renewal", () => {
  it("renews once for calls that come at the same time", async () => {
    const c = await expiredConnector();
    const server = rotatingServer(100);
    const row = await c.row();
    expect(await Promise.all([accessToken(env, row, server.fetcher), accessToken(env, row, server.fetcher)])).toEqual(["token-1", "token-1"]);
    expect(server.calls()).toBe(1);
    const after = await c.row();
    expect(after.status).toBe("ok");
    expect((await readOAuth(env, after))?.refreshToken).toBe("r2");
  });

  it("takes the token another thread renewed while its own renewal was refused", async () => {
    const c = await expiredConnector();
    const stale = await c.row();
    // Another thread renewed it first; its answer is saved a moment after ours is refused.
    const fetcher = (async () => {
      setTimeout(async () => {
        const state = { ...c.state, accessToken: "theirs", refreshToken: "r2", expiresAt: Date.now() + 3_600_000 };
        await db.update(schema.connectors).set({ secret: await encryptSecret(env, JSON.stringify(state), c.id) }).where(eq(schema.connectors.id, c.id));
      }, 200);
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }) as unknown as typeof fetch;
    expect(await accessToken(env, stale, fetcher)).toBe("theirs");
    expect((await c.row()).status).toBe("ok");
  });

  it("keeps the sign-in when the server cannot be reached", async () => {
    const c = await expiredConnector();
    const fetcher = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    expect(await accessToken(env, await c.row(), fetcher)).toBeNull();
    expect((await c.row()).status).toBe("ok");
    const offline = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect(await accessToken(env, await c.row(), offline)).toBeNull();
    expect((await c.row()).status).toBe("ok");
  });

  it("asks to sign in again when the server refuses the refresh token", async () => {
    const c = await expiredConnector();
    const fetcher = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as unknown as typeof fetch;
    expect(await accessToken(env, await c.row(), fetcher)).toBeNull();
    expect(await c.row()).toMatchObject({ status: "needs_auth", lastError: expect.stringContaining("invalid_grant") });
  });

  it("asks for offline_access when the authorization server offers it", async () => {
    const id = `con_${crypto.randomUUID()}`;
    const now = new Date();
    const row = {
      id, ownerId: null, projectId: null, name: "Example", slug: `ex-${id.slice(-8)}`, transport: "http" as const,
      url: "https://as.example.com/mcp", auth: "oauth" as const, command: null, args: [], runsOn: "both" as const,
      secret: null, secretNames: [], enabled: true, status: "needs_auth" as const, lastError: null, tools: [],
      createdBy: null, createdAt: now, updatedAt: now,
    };
    await db.insert(schema.connectors).values(row);
    const fetcher = (async (input: string) => {
      const url = new URL(input);
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({ authorization_servers: ["https://as.example.com"], scopes_supported: ["read"] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          authorization_endpoint: "https://as.example.com/authorize",
          token_endpoint: "https://as.example.com/token",
          registration_endpoint: "https://as.example.com/register",
          scopes_supported: ["read", "offline_access"],
        });
      }
      if (url.pathname === "/register") return Response.json({ client_id: "client-1" }, { status: 201 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const link = new URL(await startAuthorization(env, row, "https://myrel.test", "usr_1", fetcher));
    expect(link.searchParams.get("scope")).toBe("read offline_access");
  });
});
