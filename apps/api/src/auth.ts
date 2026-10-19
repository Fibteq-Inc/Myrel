import { createDb, schema } from "@altair/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins/bearer";
import { admitNewUser } from "./instance";
import { trustedOrigins } from "./origins";

export function createAuth(env: Env) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL || undefined,
    basePath: "/api/auth",
    trustedOrigins: trustedOrigins(env),
    database: drizzleAdapter(createDb(env.DB), { provider: "sqlite", schema }),
    // Sign-up is open at this layer; databaseHooks below decide who may create an account, because
    // the switch is an admin setting in D1 and invited people may join while it is off.
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "user", input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (newUser) => {
            const admission = await admitNewUser(env, newUser.email);
            if (!admission.ok) {
              throw new APIError("FORBIDDEN", { message: "Sign-up is disabled on this server.", code: "SIGNUP_DISABLED" });
            }
            return { data: { ...newUser, role: admission.role } };
          },
        },
      },
    },
    // Bearer tokens let native clients (desktop, Expo) authenticate without cookies.
    plugins: [bearer()],
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
