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

/**
 * One row for a finished run_task: the coding harness's own model calls, summed.
 * The task id is the turn id. Billed as the thread's work.
 */
export async function recordTaskUsage(
  env: LlmEnv & { DB: D1Database },
  ctx: { projectId: string; threadId: string; taskId: string; provider: string; model: string },
  usage: { inputTokens: number; outputTokens: number; costUsd: number },
  latencyMs: number,
) {
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
  const prices = { ...DEFAULT_PRICES, ...parsePrices(env.LLM_PRICES) };
  const price = priceFor(ctx.model, prices);
  // The harness's own cost figure wins; otherwise estimate from the price table.
  const cost = usage.costUsd > 0 ? Math.round(usage.costUsd * 1_000_000) : price ? costMicros(usage, price) : null;
  await createDb(env.DB)
    .insert(schema.usageEvents)
    .values({
      id: createId("usage"),
      createdAt: new Date(),
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      userId: null,
      agent: "thread",
      turnId: ctx.taskId,
      provider: ctx.provider,
      model: ctx.model,
      servedModel: null,
      inputTokens: usage.inputTokens,
      cachedInputTokens: 0,
      outputTokens: usage.outputTokens,
      costMicros: cost,
      latencyMs,
    });
}
