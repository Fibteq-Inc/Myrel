import type { Locale } from "@myrel/i18n";
import { useI18n, useT } from "@myrel/i18n/react";
import { CLI_NAMES, type MessageStats, type Runtime } from "@myrel/protocol";
import { Cloud, Laptop } from "lucide-react";
import { useState } from "react";
import { useFormat } from "../../lib/format";
import { promptStatsValue } from "./context-gauge";

const HARNESS_NAMES: Record<string, string> = {
  ...CLI_NAMES,
  opencode: "OpenCode",
  "claude-code": "Claude Code",
  shell: "Shell",
};

export function harnessName(harness: string) {
  return HARNESS_NAMES[harness] ?? harness;
}

/** "accounts/fireworks/models/kimi-k2p6" reads as "kimi-k2p6". */
export function modelName(model: string) {
  return model.replace(/^accounts\/[^/]+\/models\//, "");
}

/**
 * The quiet line under an agent's reply: where it ran, the model, how long it
 * took, tokens and cost. Clicking it opens the breakdown.
 */
export function MessageStatsLine({ stats }: { stats: MessageStats }) {
  const t = useT();
  const fmt = useFormat();
  const { locale } = useI18n();
  const dur = (ms: number) => duration(ms, t, locale);
  const [open, setOpen] = useState(false);
  const { task } = stats;
  // A reply that reports a task is mostly that task's work.
  const durationMs = stats.durationMs + (task?.durationMs ?? 0);
  const tokens = stats.inputTokens + stats.outputTokens + (task ? task.inputTokens + task.outputTokens : 0);
  const cost = totalCost(stats);
  const RuntimeIcon = stats.runtime === "local" ? Laptop : Cloud;
  const where = (r: Runtime) => t(r === "local" ? "stats.local" : "stats.cloud");
  const model = modelName(task?.model ?? stats.model);
  const harness = task?.harness ?? stats.harness;

  return (
    <div className="text-xs text-subtle">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t("stats.label")}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1.5 flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md px-1.5 py-0.5 text-left tabular-nums hover:bg-hover hover:text-muted"
      >
        <span
          className="flex min-w-0 items-center gap-1"
          title={
            stats.computer ? t("stats.localOn", { computer: stats.computer }) : t(stats.runtime === "local" ? "stats.localHint" : "stats.cloudHint")
          }
        >
          <RuntimeIcon size={12} aria-hidden="true" className="flex-none" />
          <span className="max-w-[18ch] truncate">{stats.computer ?? where(stats.runtime)}</span>
        </span>
        {model && (
          <>
            <Dot />
            <span className="max-w-[18ch] truncate font-mono text-[11px]">{model}</span>
          </>
        )}
        {harness && (
          <>
            <Dot />
            <span>{harnessName(harness)}</span>
          </>
        )}
        <Dot />
        <span>{dur(durationMs)}</span>
        {tokens > 0 && (
          <>
            <Dot />
            <span>{t("stats.tokens", { tokens: fmt.tokens(tokens) })}</span>
          </>
        )}
        {cost !== null && cost > 0 && (
          <>
            <Dot />
            <span>{fmt.cost(cost)}</span>
          </>
        )}
      </button>

      {open && (
        <dl className="mt-1.5 grid max-w-[420px] grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-line bg-panel px-3 py-2.5 text-[12px]">
          {task && (
            <>
              <Row label={t("stats.task")} value={task.title} />
              <Row
                label=""
                value={t("stats.taskRan", { harness: harnessName(task.harness), where: where(task.runtime) })}
              />
              {task.model && <Row label={t("stats.model")} value={modelName(task.model)} mono />}
              <Row label={t("stats.time")} value={dur(task.durationMs)} />
              {task.inputTokens + task.outputTokens > 0 && (
                <Row
                  label={t("stats.input")}
                  value={`${fmt.tokens(task.inputTokens)} · ${t("stats.output")} ${fmt.tokens(task.outputTokens)}`}
                />
              )}
              <Row label={t("stats.cost")} value={task.costMicros === null ? t("stats.unpriced") : fmt.cost(task.costMicros)} />
              <hr className="col-span-2 my-1 border-line" />
            </>
          )}
          {stats.computer && <Row label={t("stats.computer")} value={stats.computer} />}
          {stats.harness && <Row label={t("stats.harness")} value={harnessName(stats.harness)} />}
          {stats.model && <Row label={t("stats.model")} value={modelName(stats.model)} mono />}
          <Row label={t("stats.time")} value={dur(stats.durationMs)} />
          {/* A harness reports tokens, not its model calls. */}
          {!stats.harness && <Row label={t("stats.calls")} value={String(stats.calls)} />}
          <Row label={t("stats.input")} value={fmt.tokens(stats.inputTokens)} />
          {stats.cachedInputTokens > 0 && <Row label={t("stats.cached")} value={fmt.tokens(stats.cachedInputTokens)} />}
          <Row label={t("stats.output")} value={fmt.tokens(stats.outputTokens)} />
          <Row label={t("stats.cost")} value={stats.costMicros === null ? t("stats.unpriced") : fmt.cost(stats.costMicros)} />
          {stats.prompt && <Row label={t("stats.prompt")} value={promptStatsValue(stats.prompt, t, fmt.tokens)} />}
        </dl>
      )}
    </div>
  );
}

/** The reply's cost with its task's, or null when any part has no known price. */
function totalCost(stats: MessageStats): number | null {
  if (stats.costMicros === null) return null;
  if (!stats.task) return stats.costMicros;
  return stats.task.costMicros === null ? null : stats.costMicros + stats.task.costMicros;
}

/** "6.1 s", "2 min 5 s", "1 h 3 min" in the viewer's language. */
export function duration(ms: number, t: ReturnType<typeof useT>, locale: Locale) {
  const s = ms / 1000;
  if (s < 60) {
    const value = new Intl.NumberFormat(locale, { maximumFractionDigits: s < 10 ? 1 : 0 }).format(s);
    return t("duration.seconds", { value });
  }
  const total = Math.round(s);
  if (total < 3600) return t("duration.minutes", { minutes: Math.floor(total / 60), seconds: total % 60 });
  return t("duration.hours", { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60) });
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-subtle">{label}</dt>
      <dd className={mono ? "truncate font-mono text-[11px] text-body" : "truncate text-body"}>{value}</dd>
    </>
  );
}

function Dot() {
  return (
    <span aria-hidden="true" className="text-edge-strong">
      ·
    </span>
  );
}

/** A thread's usage so far, for its header: tokens and, when known, cost; the time is in the tooltip. */
export function ThreadUsageLabel({ usage }: { usage: { tokens: number; durationMs: number; costMicros: number | null } }) {
  const t = useT();
  const fmt = useFormat();
  const { locale } = useI18n();
  const tokens = fmt.tokens(usage.tokens);
  return (
    <span className="flex-none tabular-nums text-subtle" title={t("stats.threadTotal", { tokens, time: duration(usage.durationMs, t, locale) })}>
      {t("stats.tokens", { tokens })}
      {usage.costMicros !== null && usage.costMicros > 0 && ` · ${fmt.cost(usage.costMicros)}`}
    </span>
  );
}
