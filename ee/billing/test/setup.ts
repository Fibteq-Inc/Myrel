import type { D1Migration } from "@cloudflare/vitest-plugin";
import { applyD1Migrations, env } from "cloudflare:test";

const { TEST_MIGRATIONS } = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(env.DB, TEST_MIGRATIONS);
// Test accounts count as verified, as if each had followed the link in its email.
await env.DB.prepare(
  "CREATE TRIGGER IF NOT EXISTS test_verify_new_users AFTER INSERT ON user BEGIN UPDATE user SET email_verified = 1 WHERE id = NEW.id; END",
).run();
