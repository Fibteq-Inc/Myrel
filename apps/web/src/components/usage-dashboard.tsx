import { chartSlot, type UsageFilter, type UsageMetric, usageQuery, usageSeries } from "@myrel/client";
import type { MessageKey } from "@myrel/i18n";
import { useI18n, useT } from "@myrel/i18n/react";
import { COORDINATOR_HARNESS, UNKNOWN_HARNESS, type UsageSummary, type UsageTotals, usageSpeed } from "@myrel/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Clock, Coins, Gauge, Info, MessagesSquare, Network, Repeat2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { api } from "../lib/api";
import { formatCost, useFormat } from "../lib/format";
import { CliMark, cn } from "../lib/ui";
import { duration, harnessName } from "./chat/message-stats";
import { seriesColor, UsageChart } from "./usage-chart";

/** Usage the filter covers, across the caller's projects or one of them. */
export function useUsage(filter: UsageFilter) {
  return useQuery({
    queryKey: ["usage", filter],
    queryFn: () => api.getUsage(usageQuery(filter)),
    placeholderData: keepPreviousData,
  });
}

/** A `byCli` name in words. */
export function useHarnessLabel() {
  const t = useT();
  return (harness: string) =>
    harness === COORDINATOR_HARNESS ? t("usage.coordinator") : harness === UNKNOWN_HARNESS ? t("usage.unknownCli") : harnessName(harness);
}

const METRIC_LABEL: Record<UsageMetric, MessageKey> = { tokens: "usage.tokens", turns: "usage.turns", time: "usage.time", cost: "usage.costShort" };

/** Totals, the daily chart and the breakdowns. Inside a project, the per-project breakdown is left out. */
export function UsageDashboard({ data, filter, inProject = false }: { data: UsageSummary; filter: UsageFilter; inProject?: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  const fmt = useFormat();
  const name = useHarnessLabel();
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const { totals } = data;
  const tokens = totals.inputTokens + totals.outputTokens;
  const turns = totals.turns ?? 0;
  const speed = usageSpeed(totals);
  const agent = (kind: "coordinator" | "thread") => data.byAgent.find((a) => a.agent === kind);
  // A person's own CLI shows no cost.
  const costless = filter.runtime === "local" || (data.byCli ?? []).every((c) => c.runtime === "local");
  const sandbox = data.sandbox.runs > 0 && filter.runtime !== "local" && !filter.cli && filter.scope === "all";
  const series = usageSeries(data, metric);
  const names = series.map((s) =>
    s.key === "cost" ? t("usage.costShort") : s.slot === null ? (s.harnesses.length === 1 ? name(s.harnesses[0]!) : t("usage.otherClis")) : name(s.key),
  );
  const empty = turns === 0 && totals.calls === 0;
  const time = (ms: number) => duration(ms, t, locale);

  return (
    <>
      <section aria-label={t("usage.totals")} className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat icon={<Network size={15} />} label={t("usage.tokens")} value={fmt.tokens(tokens)} className="max-lg:col-span-2">
          {t("usage.inOut", { input: fmt.tokens(totals.inputTokens), output: fmt.tokens(totals.outputTokens) })}
          {totals.cachedInputTokens > 0 && ` · ${t("usage.cachedShare", { percent: cachedPercent(totals) })}`}
        </Stat>
        <Stat icon={<Repeat2 size={15} />} label={t("usage.turns")} value={fmt.number(turns)}>
          {totals.failedTurns ? t("usage.failedTurns", { count: totals.failedTurns }) : turns ? t("usage.noFailedTurns") : t("usage.noneYet")}
        </Stat>
        <Stat icon={<Clock size={15} />} label={t("usage.time")} value={time(totals.durationMs ?? 0)}>
          {turns ? t("usage.perTurn", { time: time((totals.durationMs ?? 0) / turns) }) : t("usage.noneYet")}
        </Stat>
        <Stat
          icon={<Gauge size={15} />}
          label={t(speed.model === null ? "usage.turnSpeed" : "usage.modelSpeed")}
          value={speedText(speed.model ?? speed.turn, fmt, t)}
          title={t("usage.speedHint")}
        >
          {speed.model === null ? t("usage.modelSpeedNone") : `${t("usage.turnSpeed")} ${speedText(speed.turn, fmt, t)}`}
        </Stat>
        <Stat icon={<Coins size={15} />} label={t("usage.cost")} value={costless && !totals.costMicros ? "–" : fmt.cost(totals.costMicros)}>
          {totals.unpricedCalls > 0
            ? t("usage.unpriced", { count: totals.unpricedCalls })
            : sandbox
              ? t("usage.sandboxLine", { time: sandboxTime(t, data.sandbox.seconds), turns: t("usage.sandboxRuns", { count: data.sandbox.runs }) })
              : t("usage.costCloudOnly")}
        </Stat>
      </section>

      {totals.unpricedCalls > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-line bg-panel px-3 py-2.5 text-[13px] text-muted">
          <Info size={15} className="mt-0.5 flex-none text-subtle" aria-hidden="true" />
          <span>
            {t("usage.unpricedNoteBefore")} <code className="rounded bg-hover px-1 font-mono text-xs text-fg">LLM_PRICES</code>{" "}
            {t("usage.unpricedNoteAfter")}
          </span>
        </p>
      )}

      <Card
        title={t("usage.dailyByCli")}
        action={
          <Segmented
            label={t("usage.measure")}
            value={metric}
            options={(["tokens", "turns", "time", "cost"] as const).map((m) => ({ value: m, label: t(METRIC_LABEL[m]) }))}
            onChange={setMetric}
          />
        }
      >
        {empty ? (
          <Empty>{t("usage.emptyRange")}</Empty>
        ) : (
          <>
            {series.length > 1 ? (
              <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                {series.map((s, i) => (
                  <Legend key={s.key} color={seriesColor(s.slot)} label={names[i]!} />
                ))}
              </div>
            ) : (
              metric !== "cost" && names[0] && <p className="mb-2 text-xs text-subtle">{names[0]}</p>
            )}
            <UsageChart days={data.daily.map((d) => d.date)} series={series} metric={metric} names={names} />
          </>
        )}
      </Card>

      {data.byCli && (
        <Card title={t("usage.byCli")}>
          <WorkTable
            title={t("usage.cli")}
            rows={data.byCli.map((c) => ({
              key: `${c.harness}/${c.runtime}`,
              name: (
                <span className="flex min-w-0 items-center gap-2">
                  <span className="size-2.5 flex-none rounded-sm" style={{ background: seriesColor(chartSlot(c.harness)) }} aria-hidden="true" />
                  <CliMark cli={c.harness} size={14} />
                  <span className="truncate">{name(c.harness)}</span>
                </span>
              ),
              sub: c.harness === UNKNOWN_HARNESS ? undefined : t(c.runtime === "local" ? "usage.local" : "usage.cloud"),
              totals: c,
              costless: c.runtime === "local",
            }))}
          />
          <p className="mt-3 text-xs leading-relaxed text-subtle">{t("usage.speedHint")}</p>
        </Card>
      )}

      {!inProject && (
        <Card title={t("usage.byProject")}>
          <WorkTable title={t("usage.project")} rows={data.byProject.map((p) => ({ key: p.projectId, name: <span className="truncate">{p.name}</span>, totals: p, to: p.projectId }))} />
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={t("usage.byModel")}>
          <Breakdown
            rows={data.byModel.map((m) => ({
              key: `${m.provider}/${m.model}`,
              // "accounts/fireworks/models/kimi-k2p6" reads as "kimi-k2p6"; the provider is shown beside it.
              label: m.model.replace(/^accounts\/[^/]+\/models\//, "") || harnessName(m.provider),
              sub: m.model ? harnessName(m.provider) : undefined,
              totals: m,
            }))}
            total={totals}
          />
        </Card>
        <Card title={t("usage.whoSpent")}>
          <AgentSplit coordinator={agent("coordinator")} thread={agent("thread")} />
        </Card>
      </div>

      <Card title={t("usage.topThreads")}>
        {data.topThreads.length === 0 ? (
          <Empty>{t("usage.noThreadWork")}</Empty>
        ) : (
          <ul className="-mx-1 divide-y divide-line">
            {data.topThreads.map((th) => (
              <li key={th.threadId}>
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: th.projectId }}
                  search={{ thread: th.threadId }}
                  className="flex items-center gap-3 rounded-lg px-1 py-2 hover:bg-hover"
                >
                  <MessagesSquare size={15} className="flex-none text-subtle" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{th.title}</span>
                  <span className="text-xs tabular-nums text-subtle">{fmt.tokens(th.inputTokens + th.outputTokens)}</span>
                  <span className="w-16 text-right text-[13px] tabular-nums">{costOrDash(th, fmt.cost)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** Tokens per second in words; a dash when there is nothing to show. */
export function speedText(speed: number | null, fmt: ReturnType<typeof useFormat>, t: ReturnType<typeof useT>): string {
  return speed === null ? "–" : t("usage.speedValue", { value: fmt.speed(speed) });
}

function cachedPercent(u: UsageTotals) {
  return Math.min(100, Math.round((u.cachedInputTokens / Math.max(1, u.inputTokens)) * 100));
}

type WorkRow = { key: string; name: ReactNode; sub?: string; totals: UsageTotals; to?: string; costless?: boolean };

/** One row per CLI or project with everything measured about it. On a phone the less used columns are left out. */
function WorkTable({ title, rows }: { title: string; rows: WorkRow[] }) {
  const t = useT();
  const { locale } = useI18n();
  const fmt = useFormat();
  if (rows.length === 0) return <Empty>{t("usage.nothing")}</Empty>;
  const num = "whitespace-nowrap py-2.5 pl-3 text-right align-top tabular-nums";
  const th = "whitespace-nowrap pb-2 pl-3 text-right font-normal";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-xs text-subtle">
            <th className="pb-2 font-normal">{title}</th>
            <th className={th}>{t("usage.tokens")}</th>
            <th className={cn(th, "max-sm:hidden")}>{t("usage.turns")}</th>
            <th className={cn(th, "max-sm:hidden")}>{t("usage.time")}</th>
            <th className={cn(th, "max-sm:hidden")}>{t("usage.turnSpeed")}</th>
            <th className={th}>{t("usage.modelSpeed")}</th>
            <th className={cn(th, "max-sm:hidden")}>{t("usage.costShort")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => {
            const speed = usageSpeed(r.totals);
            return (
              <tr key={r.key}>
                <td className="w-1/2 max-w-0 py-2.5 align-top sm:w-[34%]">
                  {r.to ? (
                    <Link to="/projects/$projectId" params={{ projectId: r.to }} className="block truncate hover:underline">
                      {r.name}
                    </Link>
                  ) : (
                    r.name
                  )}
                  {r.sub && <span className="block truncate text-xs text-subtle">{r.sub}</span>}
                </td>
                <td className={num}>{fmt.tokens(r.totals.inputTokens + r.totals.outputTokens)}</td>
                <td className={cn(num, "max-sm:hidden")}>
                  {fmt.number(r.totals.turns ?? 0)}
                  {!!r.totals.failedTurns && <span className="block text-xs text-subtle">{t("usage.failedTurns", { count: r.totals.failedTurns })}</span>}
                </td>
                <td className={cn(num, "max-sm:hidden")}>{duration(r.totals.durationMs ?? 0, t, locale)}</td>
                <td className={cn(num, "max-sm:hidden text-muted")}>{speed.turn === null ? "–" : fmt.speed(speed.turn)}</td>
                <td className={num}>{speed.model === null ? "–" : fmt.speed(speed.model)}</td>
                <td className={cn(num, "max-sm:hidden")}>{r.costless ? "–" : costOrDash(r.totals, fmt.cost)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type BreakdownRow = { key: string; label: string; sub?: string; totals: UsageTotals; to?: string };

/** One row per item with its share of all tokens as a bar. */
function Breakdown({ rows, total }: { rows: BreakdownRow[]; total: UsageTotals }) {
  const t = useT();
  const fmt = useFormat();
  if (rows.length === 0) return <Empty>{t("usage.nothing")}</Empty>;
  const all = total.inputTokens + total.outputTokens;
  return (
    <table className="w-full table-fixed text-[13px]">
      <thead>
        <tr className="text-left text-xs text-subtle">
          <th className="pb-2 font-normal">{t("usage.name")}</th>
          <th className="w-20 pb-2 text-right font-normal">{t("usage.tokens")}</th>
          <th className="w-20 pb-2 text-right font-normal">{t("usage.costShort")}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map((r) => {
          const tokens = r.totals.inputTokens + r.totals.outputTokens;
          const share = all ? tokens / all : 0;
          const name = (
            <span className="block truncate" title={r.sub ? `${r.label} · ${r.sub}` : r.label}>
              {r.label}
              {r.sub && <span className="ml-1.5 text-xs text-subtle">{r.sub}</span>}
            </span>
          );
          return (
            <tr key={r.key}>
              <td className="py-2.5 pr-3">
                {r.to ? (
                  <Link to="/projects/$projectId" params={{ projectId: r.to }} className="hover:underline">
                    {name}
                  </Link>
                ) : (
                  name
                )}
                <div
                  className="mt-1.5 h-1 overflow-hidden rounded-full bg-hover"
                  role="meter"
                  aria-label={t("usage.share", { percent: Math.round(share * 100) })}
                  aria-valuenow={Math.round(share * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(share * 100, 1)}%` }} />
                </div>
              </td>
              <td className="py-2.5 pl-2 text-right align-top tabular-nums text-muted">
                {fmt.tokens(tokens)}
                <div className="text-[11px] text-subtle">{Math.round(share * 100)}%</div>
              </td>
              <td className="py-2.5 pl-3 text-right align-top tabular-nums">{costOrDash(r.totals, fmt.cost)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Coordinator (routing) versus thread agents (the work), as one split bar. */
function AgentSplit({ coordinator, thread }: { coordinator?: UsageTotals; thread?: UsageTotals }) {
  const t = useT();
  const fmt = useFormat();
  const tok = (u?: UsageTotals) => (u ? u.inputTokens + u.outputTokens : 0);
  const all = tok(coordinator) + tok(thread);
  if (!all) return <Empty>{t("usage.nothing")}</Empty>;
  const parts = [
    { label: t("usage.threadAgents"), hint: t("usage.threadAgentsHint"), color: seriesColor(1), totals: thread },
    { label: t("usage.coordinator"), hint: t("usage.coordinatorHint"), color: seriesColor(2), totals: coordinator },
  ];
  return (
    <div className="space-y-4">
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
        {parts.map((p) =>
          tok(p.totals) ? <div key={p.label} style={{ width: `${(tok(p.totals) / all) * 100}%`, background: p.color }} /> : null,
        )}
      </div>
      <ul className="space-y-2.5">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-2.5 text-[13px]">
            <span className="size-2.5 flex-none rounded-sm" style={{ background: p.color }} />
            <span>
              {p.label} <span className="text-xs text-subtle">{p.hint}</span>
            </span>
            <span className="ml-auto tabular-nums text-muted">{pct(tok(p.totals), all)}</span>
            <span className="w-16 text-right tabular-nums">{p.totals ? costOrDash(p.totals, fmt.cost) : "$0"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Cloud sandbox time: minutes under an hour, else hours to one decimal. */
function sandboxTime(t: ReturnType<typeof useT>, seconds: number) {
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? t("usage.minutes", { count: minutes }) : t("usage.hours", { count: Math.round(minutes / 6) / 10 });
}

export function Stat({ icon, label, value, title, className, children }: { icon: ReactNode; label: string; value: string; title?: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-xl border border-line bg-raised px-4 py-3.5", className)} title={title}>
      <div className="flex items-center gap-1.5 text-xs text-subtle">
        <span aria-hidden="true">{icon}</span>
        {label}
      </div>
      <div className="mt-2 whitespace-nowrap text-2xl font-semibold tracking-tight lg:text-[22px]">{value}</div>
      <div className="mt-0.5 truncate text-xs text-subtle">{children}</div>
    </div>
  );
}

export function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-raised p-4">
      <div className="mb-3 flex min-h-8 flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-medium">{title}</h2>
        <div className="ml-auto max-w-full">{action}</div>
      </div>
      {children}
    </section>
  );
}

export function Segmented<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={props.label} className="inline-flex h-8 max-w-full overflow-x-auto rounded-lg border border-edge bg-panel p-0.5">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          onClick={() => props.onChange(o.value)}
          className={`whitespace-nowrap rounded-md px-2.5 text-[13px] ${
            o.value === props.value ? "bg-hover text-fg shadow-sm" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-[13px] text-subtle">{children}</p>;
}

export function Skeleton() {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[98px] animate-pulse rounded-xl border border-line bg-raised" />
        ))}
      </div>
      <div className="h-[300px] animate-pulse rounded-xl border border-line bg-raised" />
    </div>
  );
}

function costOrDash(u: UsageTotals, cost: (micros: number) => string = formatCost) {
  // Work on a person's own CLI, or nothing but unpriced calls: a $0 would read as free.
  return u.costMicros === 0 ? "–" : cost(u.costMicros);
}

function pct(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 100)}%` : "0%";
}
