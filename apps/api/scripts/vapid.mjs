// Prints a fresh VAPID key pair for Web Push notifications.
// VAPID_PUBLIC_KEY goes in wrangler.jsonc vars; VAPID_PRIVATE_KEY is a secret:
//   pnpm --filter @myrel/api exec wrangler secret put VAPID_PRIVATE_KEY
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
const { d } = await crypto.subtle.exportKey("jwk", privateKey);
console.log(`VAPID_PUBLIC_KEY=${Buffer.from(raw).toString("base64url")}`);
console.log(`VAPID_PRIVATE_KEY=${d}`);
