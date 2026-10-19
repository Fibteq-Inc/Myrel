import { createDb, schema } from "@altair/db";
import { createId } from "@altair/protocol";
import { type CallRecord, costMicros, DEFAULT_PRICES, type LlmEnv, metered, type ModelProvider, parsePrices, priceFor } from "./llm";

/** Who a turn's model calls are billed to. */
export type UsageContext = {
  projectId: string;
  threadId: string | null;
  userId: string | null;
  agent: "coordinator" | "thread";
};

/** The provider for one agent turn, writing a usage row for every model call it makes. */
export function meteredForTurn(provider: ModelProvider, env: LlmEnv & { DB: D1Database }, ctx: UsageContext) {
  const turnId = crypto.randomUUID();
  const prices = { ...DEFAULT_PRICES, ...parsePrices(env.LLM_PRICES) };
  return metered(provider, (call) => recordUsage(env.DB, { ...ctx, turnId }, call, prices));
}

async function recordUsage(
  d1: D1Database,
  ctx: UsageContext & { turnId: string },
  call: CallRecord,
  prices: Record<string, Parameters<typeof costMicros>[1]>,
) {
  // A router's served model is what was actually billed, so price that first.
  const price = (call.servedModel && priceFor(call.servedModel, prices)) || priceFor(call.model, prices);
  await createDb(d1)
    .insert(schema.usageEvents)
    .values({
      id: createId("usage"),
      createdAt: new Date(),
      ...ctx,
      provider: call.provider,
      model: call.model,
      servedModel: call.servedModel,
      inputTokens: call.usage.inputTokens,
      cachedInputTokens: call.usage.cachedInputTokens ?? 0,
      outputTokens: call.usage.outputTokens,
      costMicros: price ? costMicros(call.usage, price) : null,
      latencyMs: call.latencyMs,
    });
}
