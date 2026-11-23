import { CLI_NAMES, COORDINATOR_HARNESS, type UsageQuery, type UsageScope, type UsageSummary } from "@myrel/protocol";

/** The ranges the usage pages offer: today, the last days, this month, or two dates of one's own. */
export const USAGE_PRESETS = ["1", "7", "30", "90", "month", "custom"] as const;
export type UsagePreset = (typeof USAGE_PRESETS)[number];

export type UsageFilter = {
  range: UsagePreset;
  /** The custom range's first and last day, YYYY-MM-DD. */
  from?: string;
  to?: string;
  project?: string;
  cli?: string;
  runtime?: "local" | "cloud";
  scope: UsageScope;
};

export const DEFAULT_USAGE_FILTER: UsageFilter = { range: "30", scope: "all" };

/** The CLIs the usage filter lists: every CLI, then the coordinator on the server's model. */
export const USAGE_CLIS: string[] = [...Object.keys(CLI_NAMES), COORDINATOR_HARNESS];

/** A date as YYYY-MM-DD in the viewer's own time zone. */
export function localDay(d: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The query a filter stands for. A custom range missing a date, or with them swapped, still reads as a range. */
export function usageQuery(filter: UsageFilter, now = new Date()): UsageQuery {
  const rest: UsageQuery = {
    projectId: filter.project ?? null,
    cli: filter.cli ?? null,
    runtime: filter.runtime ?? null,
    scope: filter.scope,
    tzOffset: now.getTimezoneOffset(),
  };
  const today = localDay(now);
  if (filter.range === "month") return { ...rest, from: `${today.slice(0, 8)}01`, to: today };
  if (filter.range === "custom") {
    const [from, to] = [filter.from ?? filter.to ?? today, filter.to ?? filter.from ?? today].sort();
    return { ...rest, from, to };
  }
  return { ...rest, days: Number(filter.range) };
}

/** What the daily chart can show. */
export const USAGE_METRICS = ["tokens", "turns", "time", "cost"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

/**
 * The CLIs with a color of their own in charts, in the order of the --chart-1… tokens: a CLI keeps its
 * color whatever else is shown, and the order keeps neighbours apart for color-blind people. The rest
 * share the neutral "other".
 */
const CHART_ORDER = ["claude", "codex", "opencode", "antigravity", "cursor", "kimi", "muse", "qwen"];

/** A chart color token's number (1 to 8) for a CLI, or null for the neutral one. */
export function chartSlot(harness: string): number | null {
  const i = CHART_ORDER.indexOf(harness);
  return i < 0 ? null : i + 1;
}

export type UsageSeries = { key: string; slot: number | null; harnesses: string[]; values: number[] };

/** The daily chart's series, one per colored CLI and one for the others, over the summary's days. Cost is one series. */
export function usageSeries(data: UsageSummary, metric: UsageMetric): UsageSeries[] {
  if (metric === "cost") return [{ key: "cost", slot: 1, harnesses: [], values: data.daily.map((d) => d.costMicros) }];
  const at = new Map(data.daily.map((d, i) => [d.date, i]));
  const series = new Map<string, UsageSeries>();
  for (const d of data.dailyByCli ?? []) {
    const i = at.get(d.date);
    if (i === undefined) continue;
    const slot = chartSlot(d.harness);
    const key = slot === null ? "other" : d.harness;
    let s = series.get(key);
    if (!s) series.set(key, (s = { key, slot, harnesses: [], values: data.daily.map(() => 0) }));
    if (!s.harnesses.includes(d.harness)) s.harnesses.push(d.harness);
    s.values[i]! += metric === "tokens" ? d.tokens : metric === "turns" ? d.turns : d.durationMs;
  }
  return [...series.values()].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
}
