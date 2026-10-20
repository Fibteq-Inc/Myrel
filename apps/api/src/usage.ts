import { createDb, schema } from "@myrel/db";
import { createId, type MessageStats, type Runtime, type TaskStats } from "@myrel/protocol";
import { type CallRecord, costMicros, DEFAULT_PRICES, type LlmEnv, metered, type ModelProvider, parsePrices, priceFor } from "./llm";

/** Who a turn's model calls are billed to. */
export type UsageContext = {
  projectId: string;
  threadId: string | null;
  userId: string | null;
  agent: "coordinator" | "thread";
};

/**
 * Sums a turn's model calls between the agent's messages, so each message can
 * say what it took: which model, how long, how many tokens, what it cost.
 */
export class TurnMeter {
  private since = Date.now();
  private model: string | null = null;
  private calls = 0;
  private inputTokens = 0;
  private cachedInputTokens = 0;
  private outputTokens = 0;
  private costMicros: number | null = 0;

  constructor(private readonly fallbackModel: string) {}

  add(call: CallRecord, cost: number | null) {
    this.model = call.servedModel ?? call.model;
    this.calls++;
    this.inputTokens += call.usage.inputTokens;
    this.cachedInputTokens += call.usage.cachedInputTokens ?? 0;
    this.outputTokens += call.usage.outputTokens;
    // One unpriced call makes the total unknown rather than quietly low.
    this.costMicros = cost === null || this.costMicros === null ? null : this.costMicros + cost;
  }

  /** Stats since the previous take, then starts counting afresh. Null when there is nothing to report. */
  take(task?: TaskStats): MessageStats | null {
    if (this.calls === 0 && !task) return null;
    const stats: MessageStats = {
      model: this.model ?? this.fallbackModel,
      durationMs: Date.now() - this.since,
      calls: this.calls,
      inputTokens: this.inputTokens,
      cachedInputTokens: this.cachedInputTokens,
      outputTokens: this.outputTokens,
      costMicros: this.costMicros,
      // The agent loop runs in the cloud; a task decides where the real work ran.
      runtime: task?.runtime ?? "cloud",
      ...(task && { task }),
    };
    this.since = Date.now();
    this.calls = this.inputTokens = this.cachedInputTokens = this.outputTokens = 0;
    this.costMicros = 0;
    return stats;
  }
}

/** The provider for one agent turn, writing a usage row for every model call it makes. */
export function meteredForTurn(
  provider: ModelProvider,
  env: LlmEnv & { DB: D1Database },
  ctx: UsageContext,
  meter?: TurnMeter,
) {
  const turnId = crypto.randomUUID();
  const prices = { ...DEFAULT_PRICES, ...parsePrices(env.LLM_PRICES) };
  return metered(provider, async (call) => {
    // A router's served model is what was actually billed, so price that first.
    const price = (call.servedModel && priceFor(call.servedModel, prices)) || priceFor(call.model, prices);
    const cost = price ? costMicros(call.usage, price) : null;
    meter?.add(call, cost);
    await recordUsage(env.DB, { ...ctx, turnId }, call, cost);
  });
}

async function recordUsage(d1: D1Database, ctx: UsageContext & { turnId: string }, call: CallRecord, cost: number | null) {
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
      costMicros: cost,
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
  const cost = taskCostMicros(env, ctx.model, usage);
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

/** A task's cost: the harness's own figure when it gives one, else an estimate from the price table. */
export function taskCostMicros(
  env: LlmEnv,
  model: string | null,
  usage: { inputTokens: number; outputTokens: number; costUsd: number },
): number | null {
  if (usage.costUsd > 0) return Math.round(usage.costUsd * 1_000_000);
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return null;
  const price = model ? priceFor(model, { ...DEFAULT_PRICES, ...parsePrices(env.LLM_PRICES) }) : null;
  return price ? costMicros(usage, price) : null;
}

/** Where a task's backend runs it. */
export function taskRuntime(backend: string): Runtime {
  return backend === "local" ? "local" : "cloud";
}
