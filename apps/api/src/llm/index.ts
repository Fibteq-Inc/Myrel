import { anthropic } from "./anthropic";
import { openAiCompatible } from "./openai";
import type { ProviderId as ProtocolProviderId } from "@myrel/protocol";
import type { ModelProvider } from "./types";
import type { ModelConfig } from "@myrel/runner-core";

export * from "./loop";
export * from "./mcp";
export * from "./metering";
export * from "./pricing";
export * from "./proxy";
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
    // Nexus Auto (formerly FireRouter) picks a model per user turn: open models (GLM, Kimi) on
    // Fireworks, and Claude Opus only when the Fireworks account holds an Anthropic Provider Key.
    defaultModel: "auto",
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

type Resolved = { id: ProviderId; def: ProviderDef; apiKey: string; baseUrl: string; headers: Record<string, string>; model: string };

/** Reads the provider settings, or explains which one is missing. */
function resolveProvider(env: LlmEnv, override: ProviderOverride): { ok: true; value: Resolved } | { ok: false; reason: string } {
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
  return { ok: true, value: { id, def, apiKey, baseUrl, headers, model } };
}

/** Builds the configured provider, or explains which setting is missing. */
export function createProvider(env: LlmEnv, fetchImpl?: typeof fetch, override: ProviderOverride = {}): ProviderResult {
  const r = resolveProvider(env, override);
  if (!r.ok) return r;
  const { id, def, apiKey, baseUrl, headers, model } = r.value;
  const provider =
    def.kind === "anthropic"
      ? anthropic({ model, baseUrl, apiKey, headers, fetch: fetchImpl })
      : openAiCompatible({ id, model, baseUrl, apiKey, headers, fetch: fetchImpl });
  return { ok: true, provider };
}

/**
 * The model a coding harness should use for run_task: the same provider and
 * key as the agents, with RUNNER_MODEL overriding the model. The key goes to
 * the sandbox as a secret, never into the stored task.
 */
export function taskModel(
  env: LlmEnv & { RUNNER_MODEL?: string; RUNNER_IMAGES?: string },
  override: ProviderOverride = {},
): { ok: true; model: ModelConfig; apiKey: string } | { ok: false; reason: string } {
  const r = resolveProvider(env, override);
  if (!r.ok) return r;
  const { id, def, apiKey, baseUrl, model } = r.value;
  const modelId = env.RUNNER_MODEL || model;
  const images = env.RUNNER_IMAGES === "true" ? true : env.RUNNER_IMAGES === "false" ? false : readsImages(def.kind, modelId);
  return { ok: true, model: { kind: def.kind, provider: id, id: modelId, baseUrl, images }, apiKey };
}

/**
 * Whether a model takes images, guessed from its name (RUNNER_IMAGES overrides it). A wrong yes
 * fails the turn the agent opens an image, so routers, which may pick a text-only model, are no.
 */
export function readsImages(kind: ModelConfig["kind"], modelId: string): boolean {
  if (kind === "anthropic") return true;
  const name = modelId.toLowerCase();
  if (name === "auto" || /router/.test(name)) return false;
  return /claude|gpt-4o|gpt-4\.1|gpt-5|\bo[34]\b|gemini|gemma-?3|kimi-k2[p.][5-9]|qwen[\d.p]*-?vl|-vl\b|vision|llama-?v?4|llama4|pixtral|glm-?4[p.]\dv|minicpm-v|internvl/.test(name);
}
