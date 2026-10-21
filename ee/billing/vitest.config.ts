import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * The core's wrangler.jsonc with this package's hosted entry as main, written next to it so
 * its relative paths hold. Without the Artifacts binding, which has no local emulator.
 */
function testConfig(): string {
  const path = "../../apps/api/.wrangler.ee-test.jsonc";
  const config = readFileSync("../../apps/api/wrangler.jsonc", "utf8")
    .replace(/^\s*"artifacts":.*$/m, "")
    .replace(/"main":\s*"src\/index\.ts"/, '"main": "../../ee/billing/src/worker.ts"');
  writeFileSync(path, config);
  return path;
}

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: testConfig() },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("../../packages/db/migrations"),
          BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
          FIREWORKS_API_KEY: "test-fireworks-key",
          SIGNUP_ENABLED: "true",
          ADMIN_EMAILS: "Admin@Example.com",
          STRIPE_SECRET_KEY: "sk_test_fake",
          STRIPE_WEBHOOK_SECRET: "whsec_test",
          REVENUECAT_API_KEY: "sk_rc_test",
          REVENUECAT_WEBHOOK_AUTH: "Bearer rc-hook-test",
          REVENUECAT_SANDBOX_EMAILS: "review@example.com",
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
}));
