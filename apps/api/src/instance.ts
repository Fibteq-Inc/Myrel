import { createDb, schema } from "@myrel/db";
import { eq, sql } from "drizzle-orm";

const { instanceSettings, projectInvites, user } = schema;

/** Keys of `instance_settings`. Each overrides the wrangler var of the same meaning. */
const SIGNUP_ENABLED = "signup_enabled";

/** Whether new accounts can be created: the admin setting, else SIGNUP_ENABLED (wrangler.jsonc). */
export async function signUpEnabled(env: Env): Promise<boolean> {
  const [row] = await createDb(env.DB)
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, SIGNUP_ENABLED));
  return (row?.value ?? env.SIGNUP_ENABLED) === "true";
}

export async function setSignUpEnabled(env: Env, enabled: boolean) {
  const value = String(enabled);
  await createDb(env.DB)
    .insert(instanceSettings)
    .values({ key: SIGNUP_ENABLED, value })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: new Date() } });
}

/** The addresses in ADMIN_EMAILS, lowercased; empty when it is unset. */
export function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether ADMIN_EMAILS names `email`; such accounts are admins whatever their stored role. */
export function isListedAdmin(env: Env, email: string): boolean {
  return adminEmails(env).includes(email.toLowerCase());
}

/**
 * Decides whether an account may be created for `email`, and with which instance role.
 * With ADMIN_EMAILS set, exactly those addresses become admins and may sign up while sign-ups are
 * closed; without it, the first account on a server is its admin. Invited people may sign up while
 * sign-ups are closed.
 */
export async function admitNewUser(env: Env, email: string): Promise<{ ok: false } | { ok: true; role: "admin" | "user" }> {
  if (isListedAdmin(env, email)) return { ok: true, role: "admin" };
  const db = createDb(env.DB);
  const [{ users }] = (await db.select({ users: sql<number>`count(*)` }).from(user)) as [{ users: number }];
  const role = users === 0 && adminEmails(env).length === 0 ? "admin" : "user";
  if (await signUpEnabled(env)) return { ok: true, role };
  const [invite] = await db
    .select({ id: projectInvites.id })
    .from(projectInvites)
    .where(eq(projectInvites.email, email.toLowerCase()))
    .limit(1);
  return invite ? { ok: true, role } : { ok: false };
}
