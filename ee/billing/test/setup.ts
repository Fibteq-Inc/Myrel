import type { D1Migration } from "@cloudflare/vitest-plugin";
import { applyD1Migrations, env } from "cloudflare:test";

const { TEST_MIGRATIONS } = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(env.DB, TEST_MIGRATIONS);
