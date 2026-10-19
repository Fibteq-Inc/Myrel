import { anthropic } from "./anthropic";
import { openAiCompatible } from "./openai";
import type { ModelProvider } from "./types";

export * from "./loop";
export * from "./metering";
export * from "./pricing";
export * from "./types";

type ProviderDef = {
  kind: "openai" | "anthropic";
  baseUrl: string;
  defaultModel: string;
  keyVar: keyof LlmEnv;
  /** Path segment under an AI Gateway URL, or null when the gateway has no built-in route for it. */
  gatewaySlug: string | null;
};

/**
 * Supported providers. Adding an OpenAI-compatible one is a new row here.
 * Fireworks has no built-in AI Gateway route: to send it through the gateway,
 * add it there as a custom provider and put that URL in LLM_BASE_URL.
 */
export const PROVIDERS = {
  fireworks: {
    kind: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    // FireRouter sends routine turns to open models and harder ones to Claude Opus.
    defaultModel: "firerouter/opus",
    keyVar: "FIREWORKS_API_KEY",
    gatewaySlug: null,
  },
  anthropic: {
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-5-5",
    keyVar: "ANTHROPIC_API_KEY",
    gatewaySlug: "anthropic",
  },
  openai: {
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.1",
    keyVar: "OPENAI_API_KEY",
    gatewaySlug: "openai",
  },
} satisfies Record<string, ProviderDef>;

export type ProviderId = keyof typeof PROVIDERS;
export const DEFAULT_PROVIDER: ProviderId = "fireworks";

/** The env vars the model layer reads (vars in wrangler.jsonc, keys as secrets). */
export type LlmEnv = {
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  /** JSON price overrides in $/1M tokens, see ./pricing.ts. */
  LLM_PRICES?: string;
  AI_GATEWAY_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  FIREWORKS_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
};

export type ProviderResult = { ok: true; provider: ModelProvider } | { ok: false; reason: string };

/** Builds the configured provider, or explains which setting is missing. */
export function createProvider(env: LlmEnv, fetchImpl?: typeof fetch): ProviderResult {
  const id = (env.LLM_PROVIDER || DEFAULT_PROVIDER) as ProviderId;
  const def: ProviderDef | undefined = PROVIDERS[id];
  if (!def) {
    return { ok: false, reason: `Unknown LLM_PROVIDER "${id}". Use one of: ${Object.keys(PROVIDERS).join(", ")}.` };
  }
  const apiKey = env[def.keyVar];
  if (!apiKey) return { ok: false, reason: `No model key configured. Add the ${def.keyVar} secret to the Worker.` };

  const gateway = env.AI_GATEWAY_URL?.replace(/\/+$/, "");
  const baseUrl = env.LLM_BASE_URL || (gateway && def.gatewaySlug ? `${gateway}/${def.gatewaySlug}` : def.baseUrl);
  const headers: Record<string, string> = env.AI_GATEWAY_TOKEN
    ? { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}` }
    : {};
  const model = env.LLM_MODEL || def.defaultModel;

  const provider =
    def.kind === "anthropic"
      ? anthropic({ model, baseUrl, apiKey, headers, fetch: fetchImpl })
      : openAiCompatible({ id, model, baseUrl, apiKey, headers, fetch: fetchImpl });
  return { ok: true, provider };
}
