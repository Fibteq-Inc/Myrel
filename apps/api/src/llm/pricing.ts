import type { Usage } from "./types";

/** US dollars per million tokens. `cachedInput` defaults to `input`. */
export type Price = { input: number; output: number; cachedInput?: number };

/**
 * Published list prices for the defaults each provider ships with, used when a
 * response does not carry its own cost. A model not listed here is recorded with no cost; operators add or override prices with the
 * LLM_PRICES var, e.g. {"firerouter/opus": {"input": 4, "output": 20}}.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cachedInput: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cachedInput: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cachedInput: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cachedInput: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cachedInput: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cachedInput: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1 },
};

/** Parses LLM_PRICES; a malformed value is ignored rather than breaking model calls. */
export function parsePrices(raw: string | undefined): Record<string, Price> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<Price>>;
    const out: Record<string, Price> = {};
    for (const [model, p] of Object.entries(parsed)) {
      if (typeof p?.input === "number" && typeof p.output === "number") {
        out[model] = { input: p.input, output: p.output, cachedInput: p.cachedInput };
      }
    }
    return out;
  } catch {
    console.warn("LLM_PRICES is not valid JSON; ignoring it");
    return {};
  }
}

/**
 * Finds a price by exact id, then without a provider path ("accounts/fireworks/models/x"
 * → "x"), then by the longest listed prefix (dated snapshots such as "claude-opus-4-8-2026…").
 */
export function priceFor(model: string, prices: Record<string, Price>): Price | null {
  const bare = model.split("/").at(-1)!;
  for (const id of [model, bare]) if (prices[id]) return prices[id];
  let best: string | null = null;
  for (const id of Object.keys(prices)) {
    if (bare.startsWith(id) && (!best || id.length > best.length)) best = id;
  }
  return best ? prices[best]! : null;
}

/** Price in $/1M tokens times tokens is micro-dollars, so no scaling is needed. */
export function costMicros(usage: Usage, price: Price): number {
  const cached = usage.cachedInputTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - cached);
  return Math.round(uncached * price.input + cached * (price.cachedInput ?? price.input) + usage.outputTokens * price.output);
}
