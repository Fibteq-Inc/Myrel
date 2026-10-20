import { API_VERSION, ServerInfo } from "@myrel/protocol";
import type { KeyValueStore, Platform } from "./platform";
import type { TokenStore } from "./token-store";

/**
 * Turns what a user types ("myrel.acme.com", "https://myrel.acme.com/")
 * into an origin. Plain http is only accepted for localhost and LAN-style
 * hosts typed with an explicit scheme.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a server address");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("That is not a valid address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Use an http(s) address");
  return url.origin;
}

export class ServerCheckError extends Error {}

/** Fetches `/api/info` and checks the server is a Myrel this app can talk to. */
export async function probeServer(origin: string, fetchImpl: typeof fetch = fetch): Promise<ServerInfo> {
  let res: Response;
  try {
    res = await fetchImpl(`${origin}/api/info`, { headers: { accept: "application/json" } });
  } catch {
    throw new ServerCheckError("Could not reach the server");
  }
  const parsed = ServerInfo.safeParse(res.ok ? await res.json().catch(() => null) : null);
  if (!parsed.success) throw new ServerCheckError("This address is not a Myrel server");
  if (parsed.data.apiVersion !== API_VERSION) {
    throw new ServerCheckError(
      parsed.data.apiVersion > API_VERSION
        ? "This server is newer than the app. Update the app to connect."
        : "This server runs an older Myrel version. Ask its admin to update it.",
    );
  }
  return parsed.data;
}

const SERVER_KEY = "server";

/** The server the app talks to: a saved choice, else the build default ("" = same origin). */
export async function currentServer(storage: KeyValueStore, fallback = ""): Promise<string> {
  return (await storage.get(SERVER_KEY)) ?? fallback;
}

export function saveServer(storage: KeyValueStore, origin: string | null) {
  return storage.set(SERVER_KEY, origin);
}

/**
 * Bearer token store for one server. Tokens are kept per server origin so
 * switching servers never sends one server's token to another. Same-origin
 * web returns undefined and keeps httpOnly session cookies.
 */
export function tokenStoreFor(platform: Platform, server: string): TokenStore | undefined {
  const sameOrigin = server === "" || server === globalThis.location?.origin;
  if (platform.name === "web" && sameOrigin) return undefined;
  const store = platform.secrets ?? platform.storage;
  const key = `token:${server || globalThis.location?.origin || ""}`;
  return { get: () => store.get(key), set: (token) => store.set(key, token) };
}
