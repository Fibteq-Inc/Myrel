import { createDb, schema } from "@myrel/db";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../crypto";
import { blockedUrl } from "./client";
import type { ConnectorRow } from "./store";

const { connectors } = schema;

/**
 * Signing in to a remote MCP server the way MCP clients do (OAuth 2.1 with PKCE): find the server's
 * authorization server, register Myrel as a client there, send the person to sign in, and keep and
 * refresh the token. Everything lives sealed in the connector's `secret`; the agent never sees it.
 */
export type OAuthState = {
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** The MCP server's URL, sent as the RFC 8707 resource so the token is for it alone. */
  resource: string;
  scope?: string;
  redirectUri: string;
  /** A sign-in in progress, and who started it (sign-ins from before that was kept have none). */
  pending?: { state: string; verifier: string; by?: string; back?: SignInReturn };
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms; absent when the server did not say. */
  expiresAt?: number;
};

/** A sign-in started from a suggestion card in a thread: the person goes back there, and the card learns the result. */
export type SignInReturn = { projectId: string; threadId: string; suggestionId: string; offerId: string };

/** Where the authorization server sends the person back to. */
export const CALLBACK_PATH = "/api/connectors/oauth/callback";

const TIMEOUT_MS = 15_000;

export async function readOAuth(env: Env, row: Pick<ConnectorRow, "id" | "secret">): Promise<OAuthState | null> {
  if (!row.secret) return null;
  try {
    return JSON.parse(await decryptSecret(env, row.secret, row.id)) as OAuthState;
  } catch {
    return null;
  }
}

async function saveOAuth(env: Env, id: string, state: OAuthState, extra: Partial<ConnectorRow> = {}) {
  await createDb(env.DB)
    .update(connectors)
    .set({ secret: await encryptSecret(env, JSON.stringify(state), id), secretNames: [], updatedAt: new Date(), ...extra })
    .where(eq(connectors.id, id));
}

/**
 * Starts a sign-in: discovers and registers on first use, then returns the link that sends the
 * person to the server's sign-in page. `origin` is this server's public address; `by` is the person
 * signing in, whose account the answer must come back to (see pendingSignIn).
 */
export async function startAuthorization(
  env: Env,
  row: ConnectorRow,
  origin: string,
  by: string,
  fetcher: typeof fetch = fetch,
  back?: SignInReturn,
): Promise<string> {
  if (!row.url) throw new Error("This connector has no address.");
  const redirectUri = `${origin}${CALLBACK_PATH}`;
  let state = await readOAuth(env, row);
  if (!state || state.redirectUri !== redirectUri || state.resource !== row.url) {
    state = await register(row.url, redirectUri, fetcher);
  }
  const verifier = randomToken();
  const pending = { state: `${row.id}.${randomToken()}`, verifier, by, ...(back && { back }) };
  await saveOAuth(env, row.id, { ...state, pending });
  const url = new URL(state.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", state.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", await challenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pending.state);
  url.searchParams.set("resource", state.resource);
  if (state.scope) url.searchParams.set("scope", state.scope);
  return url.toString();
}

/**
 * The sign-in a callback's state names, while it is in progress: its connector and who started it.
 * The callback finishes it only for that person, so a link someone else started cannot put the
 * clicker's account into the starter's connector.
 */
export async function pendingSignIn(env: Env, stateParam: string | undefined): Promise<{ id: string; by: string | null } | null> {
  const id = stateParam?.split(".")[0] ?? "";
  const [row] = id ? await createDb(env.DB).select().from(connectors).where(eq(connectors.id, id)) : [];
  const state = row ? await readOAuth(env, row) : null;
  if (!state?.pending || state.pending.state !== stateParam) return null;
  return { id, by: state.pending.by ?? null };
}

/**
 * The person came back from signing in. Returns the connector it was for, or why it failed.
 * The state ties the answer to the sign-in Myrel started, so no session is needed here.
 */
export async function finishAuthorization(
  env: Env,
  params: { code?: string; state?: string; error?: string },
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; id: string; back?: SignInReturn } | { ok: false; id: string | null; error: string; back?: SignInReturn }> {
  const id = params.state?.split(".")[0] ?? "";
  const [row] = id ? await createDb(env.DB).select().from(connectors).where(eq(connectors.id, id)) : [];
  if (!row) return { ok: false, id: null, error: "unknown_sign_in" };
  const state = await readOAuth(env, row);
  if (!state?.pending || state.pending.state !== params.state) return { ok: false, id, error: "unknown_sign_in" };
  const { back } = state.pending;
  if (params.error || !params.code) {
    await saveOAuth(env, id, { ...state, pending: undefined }, { status: "needs_auth", lastError: params.error ?? "Sign-in was cancelled." });
    return { ok: false, id, error: params.error ?? "cancelled", back };
  }
  try {
    const tokens = await tokenRequest(state, {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: state.redirectUri,
      code_verifier: state.pending.verifier,
    }, fetcher);
    await saveOAuth(env, id, { ...withTokens(state, tokens), pending: undefined }, { status: "ok", lastError: null });
    return { ok: true, id, back };
  } catch (err) {
    const message = errorText(err);
    await saveOAuth(env, id, { ...state, pending: undefined }, { status: "needs_auth", lastError: message });
    return { ok: false, id, error: message, back };
  }
}

/**
 * A valid access token for the connector, refreshed when it is about to expire. Null when the
 * person has to sign in again (the connector is marked so).
 */
export async function accessToken(env: Env, row: ConnectorRow, fetcher: typeof fetch = fetch): Promise<string | null> {
  const state = await readOAuth(env, row);
  if (!state?.accessToken) return null;
  if (!state.expiresAt || state.expiresAt > Date.now() + 60_000) return state.accessToken;
  if (!state.refreshToken) {
    await createDb(env.DB).update(connectors).set({ status: "needs_auth", lastError: "The sign-in expired." }).where(eq(connectors.id, row.id));
    return null;
  }
  try {
    const tokens = await tokenRequest(state, { grant_type: "refresh_token", refresh_token: state.refreshToken }, fetcher);
    const next = withTokens(state, tokens);
    await saveOAuth(env, row.id, next);
    return next.accessToken!;
  } catch (err) {
    // Another call may have refreshed it first, and the server only honours a refresh token once.
    const [fresh] = await createDb(env.DB).select().from(connectors).where(eq(connectors.id, row.id));
    const now = fresh ? await readOAuth(env, fresh) : null;
    if (now?.accessToken && now.accessToken !== state.accessToken && (now.expiresAt ?? Infinity) > Date.now()) return now.accessToken;
    await createDb(env.DB)
      .update(connectors)
      .set({ status: "needs_auth", lastError: `The sign-in could not be renewed: ${errorText(err)}` })
      .where(eq(connectors.id, row.id));
    return null;
  }
}

type TokenAnswer = { access_token: string; refresh_token?: string; expires_in?: number };

function withTokens(state: OAuthState, t: TokenAnswer): OAuthState {
  return {
    ...state,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? state.refreshToken,
    expiresAt: typeof t.expires_in === "number" ? Date.now() + t.expires_in * 1000 : undefined,
  };
}

async function tokenRequest(state: OAuthState, params: Record<string, string>, fetcher: typeof fetch): Promise<TokenAnswer> {
  const body = new URLSearchParams({ ...params, client_id: state.clientId, resource: state.resource });
  if (state.clientSecret) body.set("client_secret", state.clientSecret);
  const res = await fetcher(state.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const answer = (await res.json().catch(() => ({}))) as Partial<TokenAnswer> & { error?: string; error_description?: string };
  if (!res.ok || typeof answer.access_token !== "string") {
    throw new Error(answer.error_description ?? answer.error ?? `The token endpoint answered HTTP ${res.status}.`);
  }
  return answer as TokenAnswer;
}

/** Finds the server's authorization server (RFC 9728, RFC 8414) and registers Myrel there (RFC 7591). */
async function register(resource: string, redirectUri: string, fetcher: typeof fetch): Promise<OAuthState> {
  const base = new URL(resource);
  const path = base.pathname.replace(/\/$/, "");
  const metadata =
    (await getJson(`${base.origin}/.well-known/oauth-protected-resource${path}`, fetcher)) ??
    (await getJson(`${base.origin}/.well-known/oauth-protected-resource`, fetcher)) ??
    (await getJson(await resourceMetadataFromChallenge(resource, fetcher), fetcher));
  const issuer = firstString(metadata?.authorization_servers) ?? base.origin;
  const server = await authorizationServer(issuer, fetcher);
  if (!server) {
    throw new Error(
      metadata
        ? "This server's sign-in settings could not be read. Check the address, or add it with a header (an API key) instead."
        : "This server does not say how to sign in to it, or could not be reached. Check the address, or add it with a header (an API key) instead.",
    );
  }
  const authorizationEndpoint = String(server.authorization_endpoint ?? "");
  const tokenEndpoint = String(server.token_endpoint ?? "");
  const registration = typeof server.registration_endpoint === "string" ? server.registration_endpoint : null;
  for (const url of [authorizationEndpoint, tokenEndpoint, registration]) {
    if (url && blockedUrl(url)) throw new Error("This server's sign-in is at an address Myrel cannot use.");
  }
  if (!authorizationEndpoint || !tokenEndpoint) throw new Error("This server's sign-in settings are incomplete.");
  if (!registration) throw new Error("This server does not let new apps register for sign-in. Add it with a header (an API key) instead.");
  const scopes = stringList(metadata?.scopes_supported) ?? stringList(server.scopes_supported);
  const scope = scopes?.join(" ") || undefined;
  const res = await fetcher(registration, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Myrel",
      client_uri: "https://myrel.fibteq.io",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scope && { scope }),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const client = (await res.json().catch(() => ({}))) as { client_id?: unknown; client_secret?: unknown; error_description?: unknown };
  if (!res.ok || typeof client.client_id !== "string") {
    throw new Error(`Registering for sign-in failed: ${typeof client.error_description === "string" ? client.error_description : `HTTP ${res.status}`}`);
  }
  return {
    clientId: client.client_id,
    ...(typeof client.client_secret === "string" && { clientSecret: client.client_secret }),
    authorizationEndpoint,
    tokenEndpoint,
    resource,
    scope,
    redirectUri,
  };
}

/** The resource metadata address from an unauthenticated call's WWW-Authenticate header. */
async function resourceMetadataFromChallenge(resource: string, fetcher: typeof fetch): Promise<string | null> {
  try {
    const res = await fetcher(resource, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    return /resource_metadata="([^"]+)"/.exec(res.headers.get("www-authenticate") ?? "")?.[1] ?? null;
  } catch {
    return null;
  }
}

async function authorizationServer(issuer: string, fetcher: typeof fetch): Promise<Record<string, unknown> | null> {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, "");
  const candidates = path
    ? [
        `${url.origin}/.well-known/oauth-authorization-server${path}`,
        `${url.origin}/.well-known/openid-configuration${path}`,
        `${url.origin}${path}/.well-known/openid-configuration`,
      ]
    : [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  for (const candidate of candidates) {
    const doc = await getJson(candidate, fetcher);
    if (doc?.authorization_endpoint) return doc;
  }
  return null;
}

async function getJson(url: string | null, fetcher: typeof fetch): Promise<Record<string, unknown> | null> {
  if (!url || blockedUrl(url)) return null;
  try {
    const res = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const doc = (await res.json()) as unknown;
    return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function firstString(v: unknown): string | null {
  return Array.isArray(v) && typeof v[0] === "string" ? v[0] : null;
}

function stringList(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : null;
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function challenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
