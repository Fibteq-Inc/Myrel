// Secrets, set with `wrangler secret put` (see wrangler.jsonc). Only the model key of the
// provider in use is needed.
interface Env {
  BETTER_AUTH_SECRET: string;
  /** Encrypts stored model keys. Falls back to BETTER_AUTH_SECRET; set it once and keep it. */
  KEY_ENCRYPTION_SECRET?: string;
  FIREWORKS_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AI_GATEWAY_TOKEN?: string;
  // GitHub App (see src/github/README.md). The integration is off unless all are set.
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}
