import { type Message, parseConnectorSuggestion } from "@myrel/protocol";
import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setExtensions } from "../src/extensions";
import { agentProject, api, signUp, type Turn, until } from "./fake-agent";

/** A remote MCP server that wants a sign-in (OAuth with PKCE and client registration). */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== "suggest.example.com") return realFetch(input, init);
  const body = request.method === "POST" ? await request.text() : undefined;
  const rpc = body?.startsWith("{") ? (JSON.parse(body) as { id?: number; method: string }) : null;
  const answer = (result: unknown) => Response.json({ jsonrpc: "2.0", id: rpc?.id, result }, { headers: { "mcp-session-id": "s1" } });
  if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    return Response.json({ resource: "https://suggest.example.com/mcp", authorization_servers: ["https://suggest.example.com"] });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return Response.json({
      issuer: "https://suggest.example.com",
      authorization_endpoint: "https://suggest.example.com/authorize",
      token_endpoint: "https://suggest.example.com/token",
      registration_endpoint: "https://suggest.example.com/register",
    });
  }
  if (url.pathname === "/register") return Response.json({ client_id: "client-1" }, { status: 201 });
  if (url.pathname === "/token") return Response.json({ access_token: "cf-token", expires_in: 3600 });
  if (url.pathname === "/mcp") {
    if (request.headers.get("authorization") !== "Bearer cf-token") return new Response("no", { status: 401 });
    if (!rpc?.id) return new Response(null, { status: 202 });
    if (rpc.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: {} });
    if (rpc.method === "tools/list") return answer({ tools: [{ name: "dns_records_create" }] });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const CATALOG_ID = "com.suggest.example/mcp";

async function catalogEntry() {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO connector_catalog (id, title, description, website_url, icon_url, url, auth, header_name, header_placeholder, category, version, registry_updated_at, synced_at)
     VALUES (?, 'Cloudflare Example', 'Workers, DNS and R2 on Cloudflare.', NULL, NULL, 'https://suggest.example.com/mcp', 'oauth', NULL, NULL, 'developer', '1', '2026-01-01', ?)`,
  )
    .bind(CATALOG_ID, Date.now())
    .run();
}

/** A project worked by `play` on a computer that passes connectors on, with one thread started. */
async function setup(play: (turn: Turn, index: number) => Promise<string | void>) {
  await catalogEntry();
  const token = await signUp();
  const { project, turns, close } = await agentProject(token, play, { features: ["folders", "cancel", "agent", "connectors"] });
  const me = ((await (await api("/api/auth/get-session", { token })).json()) as { user: { id: string } }).user.id;
  const projectAgent = await getAgentByName(env.PROJECT_AGENT, project.id);
  const root = await projectAgent.sendMessage({ threadId: null, authorKind: "user", authorId: me, body: "Cloudflare'de bir DNS kaydı ekle" });
  const thread = await projectAgent.createThread(root.id, "DNS kaydı");
  const threadAgent = await getAgentByName(env.THREAD_AGENT, thread.id);
  await threadAgent.start({ projectId: project.id, threadId: thread.id, brief: "Add the DNS record." });
  const messages = async () => (await projectAgent.getMessagesAfter(0, 500)).messages.filter((m: Message) => m.threadId === thread.id);
  const card = async () => {
    const m = (await messages()).find((x) => parseConnectorSuggestion(x.body));
    return m ? { message: m, suggestion: parseConnectorSuggestion(m.body)! } : null;
  };
  const base = `/api/projects/${project.id}/threads/${thread.id}/connector-suggestions`;
  // Closes the computer once the agent's last turn is over.
  const done = async () => {
    await until(async () => (await projectAgent.getThread(thread.id))?.status !== "working", "the turn to end");
    close();
  };
  return { token, me, project, thread, turns, close: done, messages, card, base };
}

afterEach(() => setExtensions({}));

describe("connector suggestions", () => {
  it("offers a connector as a card, signs in from it and carries on with its tools", async () => {
    const results: string[] = [];
    const s = await setup(async (turn, index) => {
      if (index === 0) {
        results.push((await turn.call("search_connectors", { query: "cloudflare dns" })).text);
        results.push((await turn.call("suggest_connectors", { ids: [CATALOG_ID], reason: "DNS kaydını senin yerine eklemek için" })).text);
        results.push((await turn.call("suggest_connectors", { ids: [CATALOG_ID], reason: "Again" })).text);
        await turn.call("reply", { text: "Cloudflare'i bağlarsan kaydı ben eklerim." });
        return;
      }
      results.push((await turn.call("suggest_connectors", { ids: [CATALOG_ID], reason: "Again" })).text);
      await turn.call("reply", { text: "Kayıt eklendi." });
    });
    const { suggestion, message } = await until(s.card, "the card");
    await until(() => results.length >= 3, "the first turn's calls");
    expect(results[0]).toContain(CATALOG_ID);
    expect(results[1]).toContain("The card is in the thread");
    expect(results[2]).toContain("already waiting");
    expect(suggestion).toMatchObject({ state: "open", reason: "DNS kaydını senin yerine eklemek için", offers: [{ id: CATALOG_ID, name: "Cloudflare Example", auth: "oauth" }] });

    // Only what the card offers can be connected from it.
    const wrong = await api(`${s.base}/${suggestion.id}/connect`, { method: "POST", token: s.token, body: JSON.stringify({ offerId: "com.other/mcp" }) });
    expect(wrong.status).toBe(404);
    const stranger = await signUp("Başka");
    const outsider = await api(`${s.base}/${suggestion.id}/connect`, { method: "POST", token: stranger, body: JSON.stringify({ offerId: CATALOG_ID }) });
    expect(outsider.status).toBe(404);

    const connect = await api(`${s.base}/${suggestion.id}/connect`, { method: "POST", token: s.token, body: JSON.stringify({ offerId: CATALOG_ID }) });
    const started = (await connect.json()) as { connected: boolean; authorizeUrl: string };
    expect(started.connected).toBe(false);
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;
    const back = await api(`/api/connectors/oauth/callback?code=c1&state=${encodeURIComponent(state)}`, { token: s.token, redirect: "manual" });
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`http://myrel.test/projects/${s.project.id}/threads/${s.thread.id}?connector=ok`);

    // The card says so, a line from the person wakes the agent, and its new turn has the connector.
    expect((await s.card())?.suggestion).toMatchObject({ state: "connected", connected: CATALOG_ID });
    expect((await s.card())?.message.id).toBe(message.id);
    expect((await s.messages()).some((m) => m.authorKind === "user" && m.authorId === s.me && m.body.includes("Cloudflare Example bağlandı"))).toBe(true);
    const second = await until(() => s.turns[1], "the turn after connecting");
    expect(second.start.agent?.connectors?.map((c) => c.name)).toContain("cloudflare-example");
    await until(() => results.length === 4, "the second turn's call");
    expect(results[3]).toContain("already connected");
    const personal = (await (await api(`/api/projects/${s.project.id}/personal`, { token: s.token })).json()) as { connectors: { url: string; inProject: boolean; status: string }[] };
    expect(personal.connectors).toEqual([expect.objectContaining({ url: "https://suggest.example.com/mcp", inProject: true, status: "ok" })]);
    await s.close();
  }, 20_000);

  it("does not offer a connector again once the person says not now", async () => {
    const results: string[] = [];
    const s = await setup(async (turn, index) => {
      if (index === 0) {
        await turn.call("suggest_connectors", { ids: [CATALOG_ID], reason: "DNS için" });
        return;
      }
      results.push((await turn.call("search_connectors", { query: "cloudflare" })).text);
      results.push((await turn.call("suggest_connectors", { ids: [CATALOG_ID], reason: "DNS için" })).text);
    });
    const { suggestion } = await until(s.card, "the card");
    const dismissed = await api(`${s.base}/${suggestion.id}/dismiss`, { method: "POST", token: s.token, body: "{}" });
    expect(dismissed.status).toBe(204);
    expect((await s.card())?.suggestion.state).toBe("dismissed");
    // An answered card cannot be connected any more.
    const late = await api(`${s.base}/${suggestion.id}/connect`, { method: "POST", token: s.token, body: JSON.stringify({ offerId: CATALOG_ID }) });
    expect(late.status).toBe(404);
    await until(() => results.length === 2, "the turn after not now");
    expect(results[0]).toContain("turned it down");
    expect(results[1]).toContain("turned down");
    await s.close();
  }, 20_000);

  it("shows the plan's limit instead of adding one more connector", async () => {
    setExtensions({ canAddConnector: async () => ({ ok: false, reason: "The Free plan has 2 connectors." }) });
    const s = await setup(async (turn, index) => {
      if (index === 0) await turn.call("suggest_connectors", { ids: [CATALOG_ID], reason: "DNS için" });
    });
    const { suggestion } = await until(s.card, "the card");
    const res = await api(`${s.base}/${suggestion.id}/connect`, { method: "POST", token: s.token, body: JSON.stringify({ offerId: CATALOG_ID }) });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "limit_reached", message: "The Free plan has 2 connectors." });
    expect((await s.card())?.suggestion.state).toBe("open");
    await s.close();
  }, 20_000);
});
