import { useT } from "@myrel/i18n/react";
import { USAGE_RANGES } from "@myrel/protocol";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BarChart3 } from "lucide-react";
import { useState } from "react";
import { NavToggle } from "../../components/shell/shell";
import { Select } from "../../components/ui/controls";
import type { ChartMetric } from "../../components/usage-chart";
import { Segmented, Skeleton, UsageDashboard, useUsage } from "../../components/usage-dashboard";
import { projectsQuery } from "../../lib/api";
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
  const { data, error, isPending, isFetching } = useUsage(days, project);

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
            <Select
              aria-label={t("usage.project")}
              value={project ?? ""}
              onChange={(e) => setSearch({ project: e.target.value || undefined })}
              className="h-8 w-auto max-w-[240px] text-[13px]"
            >
              <option value="">{t("usage.allProjects")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
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
            <UsageDashboard data={data} metric={metric} onMetric={setMetric} />
          )}
        </div>
      </main>
    </div>
  );
}

