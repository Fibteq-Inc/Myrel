/**
 * Encryption at rest for bring-your-own model keys (AES-256-GCM, Web Crypto).
 *
 * The AES key is derived with HKDF from KEY_ENCRYPTION_SECRET, or from BETTER_AUTH_SECRET when
 * that is not set. Rotating the source secret makes stored keys unreadable, so production servers
 * should set KEY_ENCRYPTION_SECRET once and keep it. Each ciphertext is bound to its row id
 * (additional authenticated data), so a value copied onto another row fails to decrypt.
 */

const VERSION = "v1";
const encoder = new TextEncoder();

type SecretEnv = { BETTER_AUTH_SECRET: string; KEY_ENCRYPTION_SECRET?: string };

async function aesKey(env: SecretEnv): Promise<CryptoKey> {
  const source = env.KEY_ENCRYPTION_SECRET || env.BETTER_AUTH_SECRET;
  if (!source) throw new Error("No KEY_ENCRYPTION_SECRET or BETTER_AUTH_SECRET to encrypt model keys with.");
  const material = await crypto.subtle.importKey("raw", encoder.encode(source), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("myrel"), info: encoder.encode("myrel-api-keys-v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Returns `v1:<iv>:<ciphertext>`, both base64. */
export async function encryptSecret(env: SecretEnv, plaintext: string, boundTo: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(boundTo) },
    await aesKey(env),
    encoder.encode(plaintext),
  );
  return `${VERSION}:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(env: SecretEnv, stored: string, boundTo: string): Promise<string> {
  const [version, iv, ciphertext] = stored.split(":");
  if (version !== VERSION || !iv || !ciphertext) throw new Error("Unrecognized encrypted key format.");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(boundTo) },
    await aesKey(env),
    fromBase64(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

/** The part of a key that may be shown again, e.g. "…a1b2". */
export function keyHint(key: string): string {
  return key.length > 8 ? `…${key.slice(-4)}` : "…";
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
