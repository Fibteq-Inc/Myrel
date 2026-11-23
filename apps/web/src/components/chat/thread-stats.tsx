import { useI18n, useT } from "@myrel/i18n/react";
import { type Message, threadWork, timeSplit, usageSpeed, type WorkStats } from "@myrel/protocol";
import { ChartColumn } from "lucide-react";
import { useMemo } from "react";
import { useFormat } from "../../lib/format";
import { CliMark } from "../../lib/ui";
import { useThreadStatsMessages } from "../thread/use-thread-stats";
import { Menu } from "../ui/menu";
import { seriesColor } from "../usage-chart";
import { speedText } from "../usage-dashboard";
import { ComposerButton } from "./composer-button";
import { duration, harnessName, modelName } from "./message-stats";

/**
 * Composer control in a thread: its statistics in short. The button shows the last turn's model speed
 * where that was measured and there is room. The Usage tab has the rest.
 */
export function ThreadStatsPicker({
  projectId,
  threadId,
  messages,
  complete,
  version,
  onDetails,
}: {
  projectId: string;
  threadId: string;
  /** The messages held, the newest ones at least. */
  messages: Message[];
  /** Every message of the thread is held. */
  complete: boolean;
  /** Changes when the thread's usage does. */
  version: string;
  onDetails: () => void;
}) {
  const t = useT();
  const fmt = useFormat();
  const last = useMemo(() => threadWork(messages).last, [messages]);
  const model = last && usageSpeed(last).model;
  return (
    <Menu
      label={t("threadStats.button")}
      kind="dialog"
      side="top"
      trigger={
        <ComposerButton>
          <ChartColumn size={14} className="flex-none" aria-hidden="true" />
          {model !== null && <span className="hidden whitespace-nowrap tabular-nums @md:inline">{speedText(model, fmt, t)}</span>}
        </ComposerButton>
      }
      className="flex-none rounded-lg"
      panelClassName="w-[22rem] max-w-[calc(100vw-1rem)] max-h-[min(36rem,75vh)] overflow-y-auto"
    >
      {(close) => (
        <ThreadStats
          projectId={projectId}
          threadId={threadId}
          messages={messages}
          complete={complete}
          version={version}
          onDetails={() => {
            close();
            onDetails();
          }}
        />
      )}
    </Menu>
  );
}

const SPLIT = [
  { key: "modelMs", label: "threadStats.splitModel", slot: 1 },
  { key: "restMs", label: "threadStats.splitRest", slot: 2 },
  { key: "waitMs", label: "threadStats.splitWait", slot: 4 },
] as const;

/** The window: the last turn, the thread so far, where the time went and who did the work. */
function ThreadStats(props: { projectId: string; threadId: string; messages: Message[]; complete: boolean; version: string; onDetails: () => void }) {
  const t = useT();
  const fmt = useFormat();
  const { locale } = useI18n();
  const all = useThreadStatsMessages(props);
  const { total, last, groups } = useMemo(() => threadWork(all ?? props.messages), [all, props.messages]);
  if (!last) return <p className="px-3 py-4 text-[13px] text-subtle">{t("threadStats.empty")}</p>;
  const split = timeSplit(total);
  const parts = split ? SPLIT.map((p) => ({ ...p, ms: split[p.key] })).filter((p) => p.ms > 0) : [];
  const whole = parts.reduce((sum, p) => sum + p.ms, 0);
  const time = (ms: number) => duration(ms, t, locale);
  const local = groups.some((g) => g.runtime === "local" && g.harness);
  return (
    <div className="px-3 pb-2.5 pt-2" aria-busy={!all}>
      <h2 className="text-[13px] font-medium text-fg">{t("threadStats.title")}</h2>
      <h3 className="mt-2.5 text-xs text-subtle">{t("threadStats.lastTurn")}</h3>
      <Figures work={last} />
      {total.turns > 1 && (
        <>
          <h3 className="mt-3 text-xs text-subtle">
            {t("threadStats.thread")}, {t("threadStats.turns", { count: total.turns })}
          </h3>
          <Figures work={total} />
        </>
      )}

      {split && (
        <>
          <h3 className="mt-3 text-xs text-subtle">{t("threadStats.split")}</h3>
          <div className="mt-1.5 flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
            {parts.map((p) => (
              <span key={p.key} style={{ width: `${(p.ms / whole) * 100}%`, background: seriesColor(p.slot) }} />
            ))}
          </div>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs tabular-nums">
            {parts.map((p) => (
              <div key={p.key} className="contents">
                <dt className="flex items-center gap-1.5 text-muted">
                  <span className="size-2 flex-none rounded-sm" style={{ background: seriesColor(p.slot) }} aria-hidden="true" />
                  {t(p.label)}
                </dt>
                <dd className="text-right text-body">{time(p.ms)}</dd>
              </div>
            ))}
          </dl>
          {total.measuredMs < total.durationMs && <p className="mt-1 text-xs text-subtle">{t("threadStats.splitPart")}</p>}
        </>
      )}

      <h3 className="mt-3 text-xs text-subtle">{t("threadStats.byCli")}</h3>
      <ul className="mt-1 divide-y divide-line text-[12.5px]">
        {groups.map((g) => {
          const speed = usageSpeed(g);
          const model = modelName(g.model);
          return (
            <li key={g.key} className="flex items-start gap-3 py-2">
              <div className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-body">
                  <CliMark cli={g.harness} size={13} />
                  <span className="truncate">{g.harness ? harnessName(g.harness) : model}</span>
                </span>
                <span className="block truncate text-xs text-subtle">
                  {[g.harness && model, g.computer ?? t(g.runtime === "local" ? "stats.local" : "stats.cloud")].filter(Boolean).join(" · ")}
                </span>
              </div>
              <div className="text-right tabular-nums">
                <span className="block text-body">{t("stats.tokens", { tokens: fmt.tokens(g.inputTokens + g.outputTokens) })}</span>
                {/* Each speed under its own name: they are not comparable. */}
                <span className="block text-xs text-subtle">
                  {t(speed.model === null ? "usage.turnSpeed" : "usage.modelSpeed")} {speedText(speed.model ?? speed.turn, fmt, t)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {local && <p className="mt-1 text-xs leading-relaxed text-subtle">{t("threadStats.localCost")}</p>}
      <button type="button" onClick={props.onDetails} className="mt-2 rounded text-[13px] text-link hover:underline">
        {t("threadStats.details")}
      </button>
    </div>
  );
}

function Figures({ work }: { work: WorkStats }) {
  const t = useT();
  const fmt = useFormat();
  const { locale } = useI18n();
  const speed = usageSpeed(work);
  const rows = [
    [t("usage.modelSpeed"), speedText(speed.model, fmt, t)],
    [t("usage.turnSpeed"), speedText(speed.turn, fmt, t)],
    [t("usage.time"), duration(work.durationMs, t, locale)],
    [t("threadStats.inOut"), `${fmt.tokens(work.inputTokens)} / ${fmt.tokens(work.outputTokens)}`],
    ...(work.cachedInputTokens > 0 && work.inputTokens > 0
      ? [[t("stats.cached"), fmt.percent(Math.min(1, work.cachedInputTokens / work.inputTokens))]]
      : []),
    ...(work.costMicros ? [[t("stats.cost"), fmt.cost(work.costMicros)]] : []),
  ] as [string, string][];
  return (
    <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1.5">
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="truncate text-xs text-muted">{label}</dt>
          <dd className="truncate text-sm font-medium text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
