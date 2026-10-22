import { captcha } from "better-auth/plugins/captcha";

/** The header a sign-up sends its Turnstile token in (Better Auth's captcha plugin reads it). */
export const CAPTCHA_HEADER = "x-captcha-response";

/** The Turnstile widget sign-up shows, or null when this server has none (TURNSTILE_SITE_KEY and _SECRET_KEY). */
export function captchaConfig(env: Env): { provider: "turnstile"; siteKey: string } | null {
  return env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? { provider: "turnstile", siteKey: env.TURNSTILE_SITE_KEY } : null;
}

/**
 * Better Auth plugins that ask for a solved Turnstile challenge before an account is created, so a
 * script cannot open accounts by the thousand (each gets the Free plan's allowance). Sign-in stays as
 * it is: it creates nothing, and auth-limit.ts already slows down password guessing.
 */
export function captchaPlugins(env: Env) {
  if (!captchaConfig(env)) return [];
  return [captcha({ provider: "cloudflare-turnstile", secretKey: env.TURNSTILE_SECRET_KEY!, endpoints: ["/sign-up/email"] })];
}
