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

import { afterAll, afterEach } from "vitest";
import { closeRunners } from "./fake-agent";
import { captureEmail } from "./fake-llm";
import "./fake-github";
import "./fake-npm";

captureEmail(env.EMAIL);

// A fake computer's connection does not outlive its test (see closeRunners).
afterEach(closeRunners);
// A turn a test's last step set off (its task.done, the thread's report and notification) still
// runs in the Durable Objects when the test returns; tearing the file down under it fails the run
// with an EnvironmentTeardownError though every test passed. A moment lets that work finish.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 1500)));
