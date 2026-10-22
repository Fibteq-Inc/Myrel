// Secrets, set with `wrangler secret put` (see wrangler.jsonc). Only the model key of the
// provider in use is needed.
interface Env {
  /** Set per request by withD1Session (d1-session.ts): the primary, while DB is the request's session. */
  DB_PRIMARY?: D1Database;
  BETTER_AUTH_SECRET: string;
  /** Encrypts stored model keys. Falls back to BETTER_AUTH_SECRET; set it once and keep it. */
  KEY_ENCRYPTION_SECRET?: string;
  FIREWORKS_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AI_GATEWAY_TOKEN?: string;
  // GitHub App (see src/github/README.md). The integration is off unless all are set.
  GITHUB_APP_ID?: string;
  /** Optional: the app's slug, only used when GitHub cannot be asked for it. */
  GITHUB_APP_SLUG?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  /** Signs artifact links; the same value is set on the artifact Worker. */
  ARTIFACT_SIGNING_SECRET?: string;
  /** Web Push signing key, base64url P-256 scalar (with the VAPID_PUBLIC_KEY var). */
  VAPID_PRIVATE_KEY?: string;
  /** Only needed when Expo enhanced push security is enabled. */
  EXPO_ACCESS_TOKEN?: string;
  /**
   * Comma-separated addresses of the server's admins. They may sign up while sign-ups are closed and
   * are admins whatever their stored role. Unset = the first account becomes the admin. A secret, not
   * a var, so a deploy from wrangler.jsonc never wipes it and forks never inherit it.
   */
  ADMIN_EMAILS?: string;
  // Optional vars. TERMS_URL and PRIVACY_URL: when both are set, signing up requires accepting them.
  // LEGAL_VERSION: recorded with each acceptance, e.g. the documents' effective date (default "1").
  TERMS_URL?: string;
  PRIVACY_URL?: string;
  LEGAL_VERSION?: string;
  /**
   * Cloudflare Turnstile on sign-up, against bots creating accounts: the widget's site key (a var) and
   * its secret key (a secret). Off unless both are set (see captcha.ts).
   */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}
