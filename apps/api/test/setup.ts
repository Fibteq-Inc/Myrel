import type { D1Migration } from "@cloudflare/vitest-plugin";
import { applyD1Migrations, env } from "cloudflare:test";

// TEST_MIGRATIONS is injected by vitest.config.ts (read from packages/db/migrations).
const { TEST_MIGRATIONS } = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(env.DB, TEST_MIGRATIONS);
// Test accounts count as verified, as if each had followed the link in its email; tests about
// verification set email_verified back to 0 (see verifyLater in api.test.ts).
await env.DB.prepare(
  "CREATE TRIGGER IF NOT EXISTS test_verify_new_users AFTER INSERT ON user BEGIN UPDATE user SET email_verified = 1 WHERE id = NEW.id; END",
).run();

// "u", the author tests give the messages they write straight to a project, is a verified account:
// a thread's cloud turn runs only for a verified requester.
await env.DB.prepare(
  "INSERT OR IGNORE INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('u', 'Test', 'u@example.com', 1, 'user', 0, 0)",
).run();

import { captureEmail } from "./fake-llm";
import "./fake-github";

captureEmail(env.EMAIL);
