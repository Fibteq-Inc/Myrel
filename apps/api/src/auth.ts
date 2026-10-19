import { createDb, schema } from "@altair/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import { trustedOrigins } from "./origins";

export function createAuth(env: Env) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL || undefined,
    basePath: "/api/auth",
    trustedOrigins: trustedOrigins(env),
    database: drizzleAdapter(createDb(env.DB), { provider: "sqlite", schema }),
    emailAndPassword: { enabled: true, disableSignUp: !signUpEnabled(env) },
    // Bearer tokens let native clients (desktop, Expo) authenticate without cookies.
    plugins: [bearer()],
    telemetry: { enabled: false },
  });
}

/** New accounts are off unless SIGNUP_ENABLED is "true" (wrangler.jsonc). */
export function signUpEnabled(env: Env) {
  return env.SIGNUP_ENABLED === "true";
}

export type Auth = ReturnType<typeof createAuth>;
