import { DEFAULT_USAGE_FILTER, USAGE_PRESETS, type UsageFilter, type UsagePreset } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BarChart3 } from "lucide-react";
import { NavToggle } from "../../components/shell/shell";
import { Skeleton, UsageDashboard, useUsage } from "../../components/usage-dashboard";
import { UsageFilters } from "../../components/usage-filters";
import { projectsQuery } from "../../lib/api";
import { errorMessage } from "../../lib/ui";

/** The filter in the address, so a view can be linked and survives a reload. `days` is what older links carry. */
type Search = { range?: UsagePreset; days?: number; from?: string; to?: string; project?: string; cli?: string; where?: "local" | "cloud"; mine?: boolean };

const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

export const Route = createFileRoute("/_app/usage")({
  validateSearch: (s: Record<string, unknown>): Search => {
    const asked = String(s.range ?? s.days ?? "");
    const search: Search = {
      range: (USAGE_PRESETS as readonly string[]).includes(asked) && asked !== DEFAULT_USAGE_FILTER.range ? (asked as UsagePreset) : undefined,
      from: day(s.from),
      to: day(s.to),
      project: text(s.project),
      cli: text(s.cli),
      where: s.where === "local" || s.where === "cloud" ? s.where : undefined,
      mine: s.mine === true || undefined,
    };
    return Object.fromEntries(Object.entries(search).filter(([, v]) => v !== undefined)) as Search;
  },
  component: UsagePage,
});

function UsagePage() {
  const t = useT();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: projects = [] } = useQuery(projectsQuery);
  const filter: UsageFilter = {
    range: search.range ?? DEFAULT_USAGE_FILTER.range,
    from: search.from,
    to: search.to,
    project: search.project,
    cli: search.cli,
    runtime: search.where,
    scope: search.mine ? "mine" : "all",
  };
  const { data, error, isPending, isFetching } = useUsage(filter);
  const change = (next: Partial<UsageFilter>) => {
    const f = { ...filter, ...next };
    void navigate({
      search: {
        range: f.range,
        ...(f.range === "custom" && { from: f.from, to: f.to }),
        project: f.project,
        cli: f.cli,
        where: f.runtime,
        mine: f.scope === "mine" || undefined,
      },
      replace: true,
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 flex-none items-center gap-3 border-b border-line px-4 sm:px-5">
        <NavToggle />
        <BarChart3 size={17} className="text-muted" aria-hidden="true" />
        <h1 className="text-[15px] font-semibold">{t("usage.title")}</h1>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-5 px-4 py-6 sm:px-6">
          <UsageFilters filter={filter} onChange={change} projects={projects} updating={isFetching && !isPending} />
          {error ? (
            <p className="text-sm text-bad">{errorMessage(error, t)}</p>
          ) : !data ? (
            <Skeleton />
          ) : (
            <UsageDashboard data={data} filter={filter} />
          )}
        </div>
      </main>
    </div>
  );
}
