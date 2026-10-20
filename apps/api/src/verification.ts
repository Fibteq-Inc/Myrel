import { createDb, schema } from "@myrel/db";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { emailEnabled, sendEmail } from "./notifications/channels";

/**
 * Email verification. A server that can send email (see emailEnabled) sends a link at sign-up, and
 * an address counts as the person's only once they followed it: invitations to it, the admin role
 * ADMIN_EMAILS gives it and the cloud sandbox wait until then. A server that cannot send email has
 * no way to check, so every address counts as verified there.
 */
export function verificationRequired(env: Env): boolean {
  return emailEnabled(env);
}

export function isVerified(env: Env, emailVerified: boolean | null | undefined): boolean {
  return Boolean(emailVerified) || !verificationRequired(env);
}

/** Whether the account's address is verified (see isVerified). False for an unknown account. */
export async function userVerified(env: Env, userId: string): Promise<boolean> {
  const [row] = await createDb(env.DB)
    .select({ emailVerified: schema.user.emailVerified })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  return row ? isVerified(env, row.emailVerified) : false;
}

export const UNVERIFIED_MESSAGE = "Verify your email address first: open the link Myrel sent you, or send a new one from the banner.";

/** The verification email, in English and Turkish (the person's language is not known yet at sign-up). */
export async function sendVerificationEmail(env: Env, to: string, url: string): Promise<void> {
  const text = [
    "Confirm your email address for Myrel:",
    url,
    "Myrel e-posta adresinizi doğrulamak için bu bağlantıyı açın.",
    "If you did not create an account, ignore this email.",
  ].join("\n\n");
  const href = esc(url);
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#18181b">
<h2 style="font-size:18px;margin:0 0 12px">Confirm your email address</h2>
<p style="line-height:1.5">Open this link to confirm the address for your Myrel account.<br>Myrel e-posta adresinizi doğrulamak için bu bağlantıyı açın.</p>
<p><a href="${href}" style="display:inline-block;background:#5b6cff;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none">Confirm email · E-postayı doğrula</a></p>
<p style="color:#71717a;font-size:13px">If you did not create an account, ignore this email.</p>
</div>`;
  try {
    await sendEmail(env, { to, subject: "Confirm your email for Myrel", text, html });
  } catch (err) {
    // Email Service throws errors with a string code (E_SENDER_NOT_VERIFIED and so on) that names the cause.
    const code = (err as { code?: unknown }).code;
    console.error("verification email failed", code, err);
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: `The verification email could not be sent${typeof code === "string" ? ` (${code})` : ""}.`,
      code: "VERIFICATION_EMAIL_FAILED",
    });
  }
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
