import { anthropic } from "./anthropic";
import { openAiCompatible } from "./openai";
import type { ProviderId as ProtocolProviderId } from "@altair/protocol";
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
} satisfies Record<ProtocolProviderId, ProviderDef>;

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

/** Per-project choices that replace the server's LLM_* settings (see src/llm/project.ts). */
export type ProviderOverride = {
  provider?: ProviderId | null;
  model?: string | null;
  /** A key from the project's settings or an instance key; else the provider's secret. */
  apiKey?: string | null;
};

/** The provider the server uses when a project does not pick one. */
export function serverProviderId(env: LlmEnv): string {
  return env.LLM_PROVIDER || DEFAULT_PROVIDER;
}

/** Builds the configured provider, or explains which setting is missing. */
export function createProvider(env: LlmEnv, fetchImpl?: typeof fetch, override: ProviderOverride = {}): ProviderResult {
  const id = (override.provider || serverProviderId(env)) as ProviderId;
  const def: ProviderDef | undefined = PROVIDERS[id];
  if (!def) {
    return { ok: false, reason: `Unknown LLM_PROVIDER "${id}". Use one of: ${Object.keys(PROVIDERS).join(", ")}.` };
  }
  // LLM_MODEL and LLM_BASE_URL describe the server's provider, so they do not carry over to another one.
  const isServerProvider = id === serverProviderId(env);
  const apiKey = override.apiKey || env[def.keyVar];
  if (!apiKey) {
    return {
      ok: false,
      reason: isServerProvider
        ? `No model key configured. Add the ${def.keyVar} secret to the Worker, or a key in settings.`
        : `No ${id} key for this project. Add one in Settings, then pick it in the project's settings.`,
    };
  }

  const gateway = env.AI_GATEWAY_URL?.replace(/\/+$/, "");
  const baseUrl =
    (isServerProvider && env.LLM_BASE_URL) || (gateway && def.gatewaySlug ? `${gateway}/${def.gatewaySlug}` : def.baseUrl);
  const headers: Record<string, string> = env.AI_GATEWAY_TOKEN
    ? { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}` }
    : {};
  const model = override.model || (isServerProvider && env.LLM_MODEL) || def.defaultModel;

  const provider =
    def.kind === "anthropic"
      ? anthropic({ model, baseUrl, apiKey, headers, fetch: fetchImpl })
      : openAiCompatible({ id, model, baseUrl, apiKey, headers, fetch: fetchImpl });
  return { ok: true, provider };
}
