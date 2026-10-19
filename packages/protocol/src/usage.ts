/** Token and cost totals for a slice of model calls. Costs are millionths of a US dollar. */
export type UsageTotals = {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costMicros: number;
  /** Calls whose model had no known price; their cost is not in costMicros. */
  unpricedCalls: number;
};

export type UsageDay = UsageTotals & { /** YYYY-MM-DD in the requested time zone. */ date: string };

export type UsageSummary = {
  from: string;
  to: string;
  days: number;
  totals: UsageTotals;
  /** One entry per day in the range, oldest first, zero-filled. */
  daily: UsageDay[];
  byProject: (UsageTotals & { projectId: string; name: string })[];
  byModel: (UsageTotals & { provider: string; model: string })[];
  byAgent: (UsageTotals & { agent: "coordinator" | "thread" })[];
  topThreads: (UsageTotals & { projectId: string; threadId: string; title: string })[];
};

export const USAGE_RANGES = [7, 30, 90] as const;
