import { useT } from "@altair/i18n/react";
import { USAGE_RANGES, type UsageSummary, type UsageTotals } from "@altair/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BarChart3, Bot, Coins, Info, MessagesSquare, Network, Workflow } from "lucide-react";
import { type ReactNode, useState } from "react";
import { NavToggle } from "../../components/shell/shell";
import { type ChartMetric, SERIES, UsageChart } from "../../components/usage-chart";
import { api, projectsQuery } from "../../lib/api";
import { formatCost, useFormat } from "../../lib/format";
import { errorMessage } from "../../lib/ui";

type Search = { days?: number; project?: string };

export const Route = createFileRoute("/_app/usage")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(USAGE_RANGES.includes(Number(s.days) as never) && { days: Number(s.days) }),
    ...(typeof s.project === "string" && s.project && { project: s.project }),
  }),
  component: UsagePage,
});

function UsagePage() {
  const t = useT();
  const { days = 30, project } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [metric, setMetric] = useState<ChartMetric>("tokens");
  const { data: projects = [] } = useQuery(projectsQuery);
  const { data, error, isPending, isFetching } = useQuery({
    queryKey: ["usage", days, project ?? null],
    queryFn: () => api.getUsage({ days, projectId: project, tzOffset: new Date().getTimezoneOffset() }),
    placeholderData: keepPreviousData,
  });

  const setSearch = (next: Search) => navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 flex-none items-center gap-3 border-b border-line px-4 sm:px-5">
        <NavToggle />
        <BarChart3 size={17} className="text-muted" aria-hidden="true" />
        <h1 className="text-[15px] font-semibold">{t("usage.title")}</h1>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-5 px-4 py-6 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t("usage.project")}
              value={project ?? ""}
              onChange={(e) => setSearch({ project: e.target.value || undefined })}
              className="h-8 max-w-[240px] rounded-lg border border-edge bg-raised px-2.5 text-[13px] text-fg outline-none focus:border-accent"
            >
              <option value="">{t("usage.allProjects")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Segmented
              label={t("usage.range")}
              value={days}
              options={USAGE_RANGES.map((d) => ({ value: d, label: t("usage.rangeDays", { count: d }) }))}
              onChange={(d) => setSearch({ days: d })}
            />
            {isFetching && !isPending && <span className="text-xs text-subtle">{t("usage.updating")}</span>}
          </div>

          {error ? (
            <p className="text-sm text-bad">{errorMessage(error, t)}</p>
          ) : !data ? (
            <Skeleton />
          ) : (
            <Dashboard data={data} metric={metric} onMetric={setMetric} />
          )}
        </div>
      </main>
    </div>
  );
}

function Dashboard({ data, metric, onMetric }: { data: UsageSummary; metric: ChartMetric; onMetric: (m: ChartMetric) => void }) {
  const t = useT();
  const fmt = useFormat();
  const { totals } = data;
  const tokens = totals.inputTokens + totals.outputTokens;
  const agent = (kind: "coordinator" | "thread") => data.byAgent.find((a) => a.agent === kind);

  return (
    <>
      <section aria-label={t("usage.totals")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<Coins size={15} />} label={t("usage.cost")} value={fmt.cost(totals.costMicros)}>
          {totals.unpricedCalls > 0 ? t("usage.unpriced", { count: totals.unpricedCalls }) : t("usage.listPrices")}
        </Stat>
        <Stat icon={<Network size={15} />} label={t("usage.tokens")} value={fmt.tokens(tokens)}>
          {t("usage.inOut", { input: fmt.tokens(totals.inputTokens), output: fmt.tokens(totals.outputTokens) })}
        </Stat>
        <Stat icon={<Workflow size={15} />} label={t("usage.calls")} value={fmt.tokens(totals.calls)}>
          {totals.calls ? t("usage.perCall", { tokens: fmt.tokens(Math.round(tokens / totals.calls)) }) : t("usage.noneYet")}
        </Stat>
        <Stat icon={<Bot size={15} />} label={t("usage.cached")} value={pct(totals.cachedInputTokens, totals.inputTokens)}>
          {t("usage.fromCache", { tokens: fmt.tokens(totals.cachedInputTokens) })}
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
        title={t("usage.daily")}
        action={
          <Segmented
            label={t("usage.measure")}
            value={metric}
            options={[
              { value: "tokens", label: t("usage.tokens") },
              { value: "cost", label: t("usage.costShort") },
            ]}
            onChange={onMetric}
          />
        }
      >
        {metric === "tokens" && (
          <div className="mb-2 flex gap-4 text-xs text-muted">
            <Legend color={SERIES.input} label={t("usage.input")} />
            <Legend color={SERIES.output} label={t("usage.output")} />
          </div>
        )}
        {totals.calls === 0 ? (
          <Empty>{t("usage.emptyRange")}</Empty>
        ) : (
          <UsageChart days={data.daily} metric={metric} />
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={t("usage.byModel")}>
          <Breakdown
            rows={data.byModel.map((m) => ({
              key: `${m.provider}/${m.model}`,
              // "accounts/fireworks/models/kimi-k2p6" reads as "kimi-k2p6"; the provider is shown beside it.
              label: m.model.replace(/^accounts\/[^/]+\/models\//, ""),
              sub: m.provider,
              totals: m,
            }))}
            total={totals}
          />
        </Card>
        <Card title={t("usage.byProject")}>
          <Breakdown
            rows={data.byProject.map((p) => ({ key: p.projectId, label: p.name, totals: p, to: p.projectId }))}
            total={totals}
          />
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title={t("usage.whoSpent")}>
          <AgentSplit coordinator={agent("coordinator")} thread={agent("thread")} />
        </Card>
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
      </div>
    </>
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
    { label: t("usage.threadAgents"), hint: t("usage.threadAgentsHint"), color: SERIES.input, totals: thread },
    { label: t("usage.coordinator"), hint: t("usage.coordinatorHint"), color: SERIES.output, totals: coordinator },
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

function Stat({ icon, label, value, children }: { icon: ReactNode; label: string; value: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-raised px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-xs text-subtle">
        <span aria-hidden="true">{icon}</span>
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-0.5 truncate text-xs text-subtle">{children}</div>
    </div>
  );
}

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-raised p-4">
      <div className="mb-3 flex min-h-8 items-center gap-2">
        <h2 className="text-[13px] font-medium">{title}</h2>
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  );
}

function Segmented<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={props.label} className="inline-flex h-8 rounded-lg border border-edge bg-panel p-0.5">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          onClick={() => props.onChange(o.value)}
          className={`rounded-md px-2.5 text-[13px] ${
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

function Skeleton() {
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
  // Every call unpriced: a $0 would read as free.
  return u.calls > 0 && u.unpricedCalls === u.calls ? "—" : cost(u.costMicros);
}

function pct(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 100)}%` : "0%";
}
