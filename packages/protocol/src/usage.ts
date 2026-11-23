/** Token and cost totals for a slice of work. Costs are millionths of a US dollar. */
export type UsageTotals = {
  /** Model calls, where Myrel sees each one; otherwise the turns. */
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costMicros: number;
  /** Calls whose model had no known price; their cost is not in costMicros. */
  unpricedCalls: number;
  /** Agent turns. Absent (with the fields below) from servers older than per-turn statistics. */
  turns?: number;
  failedTurns?: number;
  /** How long the turns took in all, tools and waiting included. */
  durationMs?: number;
  /** Time spent in model calls, over the turns where it was measured, and what those turns wrote. */
  modelMs?: number;
  modelOutputTokens?: number;
};

export type UsageDay = UsageTotals & { /** YYYY-MM-DD in the requested time zone. */ date: string };

/** Whose turns: every member's, or only those the caller asked for. */
export const USAGE_SCOPES = ["all", "mine"] as const;
export type UsageScope = (typeof USAGE_SCOPES)[number];

/** A UsageSummary's `byCli` name for the coordinator on the server's model, which runs no CLI. */
export const COORDINATOR_HARNESS = "coordinator";
/** And for older cloud turns whose CLI was not recorded. */
export const UNKNOWN_HARNESS = "unknown";

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
  /** Agent turns that ran in a cloud sandbox, and how long they ran in total. */
  sandbox: { runs: number; seconds: number };
  /** By the CLI that did the work and where; absent from older servers, like dailyByCli. */
  byCli?: (UsageTotals & { harness: string; runtime: "local" | "cloud" })[];
  /** Days with work only, per CLI (both runtimes together). */
  dailyByCli?: { date: string; harness: string; tokens: number; turns: number; durationMs: number }[];
};

/** What a usage query covers. Days are the caller's own (tzOffset as Date#getTimezoneOffset). */
export type UsageQuery = {
  /** Whole days ending today, or `from`/`to`. */
  days?: number;
  /** First and last day, YYYY-MM-DD, both included. */
  from?: string;
  to?: string;
  projectId?: string | null;
  /** A harness name, as in `byCli`. */
  cli?: string | null;
  runtime?: "local" | "cloud" | null;
  scope?: UsageScope;
  tzOffset?: number;
};

export const USAGE_RANGES = [7, 30, 90] as const;
/** The longest range a usage query covers, in days. */
export const USAGE_MAX_DAYS = 366;

/**
 * Output tokens per second, two ways. turn: over the whole turn, commands and waiting included.
 * model: over the time spent in model calls, only where that was measured. Null when there is
 * nothing to divide.
 */
export function usageSpeed(u: Pick<UsageTotals, "outputTokens" | "durationMs" | "modelMs" | "modelOutputTokens">): { turn: number | null; model: number | null } {
  return { turn: perSecond(u.outputTokens, u.durationMs), model: perSecond(u.modelOutputTokens, u.modelMs) };
}

function perSecond(tokens: number | undefined, ms: number | undefined): number | null {
  return tokens && ms ? (tokens * 1000) / ms : null;
}
