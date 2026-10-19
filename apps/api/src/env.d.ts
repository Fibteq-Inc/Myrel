// Secrets, set with `wrangler secret put` (see wrangler.jsonc). Only the model key of the
// provider in use is needed.
interface Env {
  BETTER_AUTH_SECRET: string;
  FIREWORKS_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AI_GATEWAY_TOKEN?: string;
}
