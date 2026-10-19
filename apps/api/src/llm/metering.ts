import type { ModelProvider, Usage } from "./types";

/** What one completed model call cost, as reported by the provider. */
export type CallRecord = { provider: string; model: string; servedModel: string | null; usage: Usage; latencyMs: number };

/**
 * Wraps a provider so every call that returns is reported to `onCall`. A failure to
 * record is logged and swallowed: metering must never fail an agent's turn.
 */
export function metered(provider: ModelProvider, onCall: (call: CallRecord) => Promise<void> | void): ModelProvider {
  return {
    id: provider.id,
    model: provider.model,
    async chat(req) {
      const started = Date.now();
      const res = await provider.chat(req);
      const usage = res.usage ?? { inputTokens: 0, outputTokens: 0 };
      try {
        await onCall({
          provider: provider.id,
          model: provider.model,
          servedModel: res.model && res.model !== provider.model ? res.model : null,
          usage,
          latencyMs: Date.now() - started,
        });
      } catch (err) {
        console.error("usage metering failed", err);
      }
      return res;
    },
  };
}
