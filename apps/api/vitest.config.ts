import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("../../packages/db/migrations");
  // GitHub hands out PKCS#1 keys, so the tests use one too (see src/github/app.ts).
  const privateKey = await testPkcs1Key();
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
            // Model calls are answered by test/fake-llm.ts.
            FIREWORKS_API_KEY: "test-fireworks-key",
            SIGNUP_ENABLED: "true",
            // GitHub calls are answered by test/fake-github.ts.
            GITHUB_APP_ID: "1234",
            GITHUB_APP_SLUG: "altair-test",
            GITHUB_CLIENT_ID: "Iv1.test",
            GITHUB_CLIENT_SECRET: "test-client-secret",
            GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
            GITHUB_APP_PRIVATE_KEY: privateKey,
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});

/** A fresh RSA key as PKCS#1 PEM: the PKCS#8 export minus its 26-byte envelope (2048-bit keys). */
async function testPkcs1Key(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...pkcs8.subarray(26)));
  return `-----BEGIN RSA PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END RSA PRIVATE KEY-----\n`;
}
