import { base64url } from "./app";

/** What the GitHub round trip carries: who started it and where to send them back. */
export type ConnectState = { userId: string; returnTo: string };

const TTL_MS = 15 * 60_000;

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** `<payload>.<signature>`, signed with the server secret so the callback can trust it. */
export async function signState(secret: string, state: ConnectState): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ ...state, exp: Date.now() + TTL_MS })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(`github-state:${secret}`, "sign"), new TextEncoder().encode(payload));
  return `${payload}.${base64url(new Uint8Array(sig))}`;
}

export async function verifyState(secret: string, value: string): Promise<ConnectState | null> {
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(`github-state:${secret}`, "verify"),
    fromBase64url(sig),
    new TextEncoder().encode(payload),
  );
  if (!ok) return null;
  const data = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as ConnectState & { exp: number };
  if (data.exp < Date.now()) return null;
  return { userId: data.userId, returnTo: safeReturnTo(data.returnTo) };
}

/** Checks GitHub's `X-Hub-Signature-256` header (HMAC-SHA256 of the raw body). */
export async function verifyWebhook(secret: string, body: string, header: string | undefined): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const hex = header.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const sig = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), sig, new TextEncoder().encode(body));
}

/** Only same-site paths, so the callback cannot be used as an open redirect. */
export function safeReturnTo(value: string | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/";
}

function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}
