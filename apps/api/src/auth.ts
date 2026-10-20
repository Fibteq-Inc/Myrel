import { createDb, schema } from "@myrel/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins/bearer";
import { legalLinks } from "./extensions";
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
        termsAcceptedAt: { type: "date", required: false, input: false },
        termsVersion: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (newUser, ctx) => {
            const admission = await admitNewUser(env, newUser.email);
            if (!admission.ok) {
              throw new APIError("FORBIDDEN", { message: "Sign-up is disabled on this server.", code: "SIGNUP_DISABLED" });
            }
            // The server's terms, when it has any, are accepted at sign-up; the time is kept as the record.
            const accepted = (ctx?.body as { acceptTerms?: unknown } | undefined)?.acceptTerms === true;
            const legal = legalLinks(env, "http://localhost");
            if (legal && !accepted) {
              throw new APIError("BAD_REQUEST", {
                message: "Accept the terms of use and privacy policy to create an account.",
                code: "TERMS_NOT_ACCEPTED",
              });
            }
            // Which version was accepted, so a later version can ask again.
            const terms = legal && accepted ? { termsAcceptedAt: new Date(), termsVersion: legal.version } : {};
            return { data: { ...newUser, role: admission.role, ...terms } };
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
