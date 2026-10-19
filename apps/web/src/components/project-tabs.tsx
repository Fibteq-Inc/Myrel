import { artifactList } from "@altair/client";
import { useT } from "@altair/i18n/react";
import { USAGE_RANGES } from "@altair/protocol";
import { Blocks } from "lucide-react";
import { useState } from "react";
import { useProjectContext } from "../lib/project-context";
import { errorMessage } from "../lib/ui";
import { cn } from "../lib/ui";
import { ArtifactList, ArtifactViewer, Empty, ViewerBack } from "./artifacts";
import { ProjectChat } from "./chat/project-chat";
import { ProjectKnowledge } from "./project-knowledge";
import { ProjectThreads } from "./project-threads";
import { Segmented, Skeleton, UsageDashboard, useUsage } from "./usage-dashboard";
import type { ChartMetric } from "./usage-chart";
import { useProjectView } from "./project-view";
import { PROJECT_TABPANEL } from "./shell/project-header";

/** What the selected project tab shows, left of an open thread. */
export function ProjectTabPanel({ me, className = "" }: { me: string; className?: string }) {
  const { view } = useProjectView();
  return (
    <main id={PROJECT_TABPANEL} role="tabpanel" className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      {view === "threads" ? (
        <ProjectThreads />
      ) : view === "artifacts" ? (
        <ArtifactsTab />
      ) : view === "files" ? (
        <FilesTab />
      ) : view === "usage" ? (
        <UsageTab />
      ) : (
        <ProjectChat me={me} />
      )}
    </main>
  );
}

/** The project's Library: every artifact its threads published, one opened in place. */
function ArtifactsTab() {
  const t = useT();
  const { project, state } = useProjectContext();
  const { search, go } = useProjectView();
  if (search.item) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[#0b0b0d]">
        <ArtifactViewer
          key={search.item}
          projectId={project.id}
          artifactId={search.item}
          version={search.v}
          onVersionChange={(v) => go("artifacts", { item: search.item, v })}
          leading={<ViewerBack label={t("artifacts.all")} onClick={() => go("artifacts")} />}
        />
      </div>
    );
  }
  const items = artifactList(state).map((a) => ({ ...a, origin: a.threadId ? state.threads[a.threadId]?.title : undefined }));
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-3 py-5 sm:px-5">
        <ArtifactList
          items={items}
          onSelect={(a) => go("artifacts", { item: a.id })}
          empty={
            <Empty
              icon={<Blocks size={20} className="text-subtle" aria-hidden="true" />}
              title={t("artifacts.projectEmpty")}
              body={t("artifacts.projectEmptyBody")}
            />
          }
        />
      </div>
    </div>
  );
}

/** The project's files, memory and instructions. */
function FilesTab() {
  const { project } = useProjectContext();
  const { search, go } = useProjectView();
  return (
    <ProjectKnowledge
      projectId={project.id}
      tab={search.section ?? "files"}
      file={search.item}
      onNavigate={(next) => go("files", { ...(next.tab !== "files" && { section: next.tab }), ...(next.file && { item: next.file }) })}
    />
  );
}

/** This project's model usage: the same dashboard as the usage page, scoped to the project. */
function UsageTab() {
  const t = useT();
  const { project } = useProjectContext();
  const [days, setDays] = useState<number>(30);
  const [metric, setMetric] = useState<ChartMetric>("tokens");
  const { data, error, isPending, isFetching } = useUsage(days, project.id);
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-5 px-3 py-5 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label={t("usage.range")}
            value={days}
            options={USAGE_RANGES.map((d) => ({ value: d, label: t("usage.rangeDays", { count: d }) }))}
            onChange={setDays}
          />
          {isFetching && !isPending && <span className="text-xs text-subtle">{t("usage.updating")}</span>}
        </div>
        {error ? (
          <p className="text-sm text-bad">{errorMessage(error, t)}</p>
        ) : !data ? (
          <Skeleton />
        ) : (
          <UsageDashboard data={data} metric={metric} onMetric={setMetric} inProject />
        )}
      </div>
    </div>
  );
}
