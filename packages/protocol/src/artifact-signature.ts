// Server-only (Web Crypto). Not exported from the package index so React Native
// clients never pull it in; the API and the artifact Worker import this subpath.

/**
 * Artifact URLs are capability links: the API signs `(id, version, expiry)` with a
 * secret it shares with the artifact Worker, which serves nothing without a valid
 * signature. The artifact origin never sees the app's cookies, so this is its only auth.
 */
export async function signArtifact(secret: string, artifactId: string, version: number, expiresAt: number) {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, encode(`${artifactId}.${version}.${expiresAt}`));
  return base64url(new Uint8Array(mac));
}

export async function verifyArtifact(
  secret: string,
  artifactId: string,
  version: number,
  expiresAt: number,
  signature: string,
  now = Date.now(),
): Promise<boolean> {
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  let mac: Uint8Array<ArrayBuffer>;
  try {
    mac = fromBase64url(signature);
  } catch {
    return false;
  }
  const key = await hmacKey(secret);
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", key, mac, encode(`${artifactId}.${version}.${expiresAt}`));
}

function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function encode(s: string) {
  return new TextEncoder().encode(s);
}

function base64url(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
