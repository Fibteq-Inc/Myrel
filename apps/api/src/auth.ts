import { createDb, schema } from "@myrel/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins/bearer";
import { eq } from "drizzle-orm";
import { captchaPlugins } from "./captcha";
import { legalLinks } from "./extensions";
import { admitNewUser } from "./instance";
import { trustedOrigins } from "./origins";
import { sendPasswordResetEmail, sendVerificationEmail, verificationRequired } from "./verification";

export function createAuth(env: Env) {
  // afterEmailVerification needs the instance it is part of.
  const self: { ctx?: Promise<AuthInternals> } = {};
  const auth = betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL || undefined,
    basePath: "/api/auth",
    trustedOrigins: trustedOrigins(env),
    database: drizzleAdapter(createDb(env.DB), { provider: "sqlite", schema }),
    // Sign-up is open at this layer; databaseHooks below decide who may create an account, because
    // the switch is an admin setting in D1 and invited people may join while it is off.
    emailAndPassword: {
      enabled: true,
      // A server that can send email lets people set a new password from a link sent to their address.
      ...(verificationRequired(env) && {
        sendResetPassword: async ({ user, url }) => sendPasswordResetEmail(env, user.email, url),
        resetPasswordTokenExpiresIn: RESET_LINK_SEC,
        revokeSessionsOnPasswordReset: true,
        // The link came to the address, so following it shows the address is theirs.
        onPasswordReset: async ({ user }) => {
          if (!user.emailVerified) await markVerified(env, user.id);
        },
      }),
    },
    // People can sign in before they verify; what an unverified address would let a stranger claim
    // (invitations, ADMIN_EMAILS, the cloud sandbox) waits for it (see verification.ts).
    ...(verificationRequired(env) && {
      emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        expiresIn: 24 * 60 * 60,
        sendVerificationEmail: async ({ user, url }) => sendVerificationEmail(env, user.email, firstPasswordLink(url)),
        // Runs once, when an address is first verified: see firstVerification.
        afterEmailVerification: async (user): Promise<void> => firstVerification(self.ctx!, user.id),
      },
    }),
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
    plugins: [bearer(), ...captchaPlugins(env)],
    telemetry: { enabled: false },
  });
  self.ctx = auth.$context;
  return auth;
}

/** The parts of Better Auth's context firstVerification uses. */
type AuthInternals = {
  internalAdapter: {
    deleteUserSessions(userId: string): Promise<unknown>;
    updatePassword(userId: string, hash: string): Promise<unknown>;
    createVerificationValue(data: { identifier: string; value: string; expiresAt: Date }): Promise<unknown>;
  };
  password: { hash(password: string): Promise<string> };
};

/** How long a link to set a new password works. */
const RESET_LINK_SEC = 60 * 60;

/** Where the verification link leads once followed: on to setting a password (see firstVerification). */
function firstPasswordLink(url: string): string {
  const link = new URL(url);
  link.searchParams.set("callbackURL", "/api/account/first-password");
  return link.href;
}

/**
 * An address verified for the first time. Anyone could have signed up with it before its owner did
 * and set the password, so whoever proved they own the address starts clean: every session from
 * before ends, the password set at sign-up stops working, and the verification link goes on to
 * setting a new one (GET /api/account/first-password).
 */
async function firstVerification(context: Promise<AuthInternals>, userId: string): Promise<void> {
  const ctx = await context;
  await ctx.internalAdapter.deleteUserSessions(userId);
  await ctx.internalAdapter.updatePassword(userId, await ctx.password.hash(randomToken()));
  const token = randomToken();
  const expiresAt = new Date(Date.now() + RESET_LINK_SEC * 1000);
  await ctx.internalAdapter.createVerificationValue({ identifier: `reset-password:${token}`, value: userId, expiresAt });
  await ctx.internalAdapter.createVerificationValue({ identifier: firstPasswordKey(userId), value: token, expiresAt });
}

/** Where the link to set a password after first verification waits for its person. */
export function firstPasswordKey(userId: string): string {
  return `first-password:${userId}`;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function markVerified(env: Env, userId: string) {
  await createDb(env.DB).update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, userId));
}

export type Auth = ReturnType<typeof createAuth>;
