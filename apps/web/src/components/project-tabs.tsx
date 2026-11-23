import { artifactList } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import { DEFAULT_USAGE_FILTER, type UsageFilter } from "@myrel/client";
import { Blocks } from "lucide-react";
import { useState } from "react";
import { useProjectContext } from "../lib/project-context";
import { errorMessage } from "../lib/ui";
import { cn } from "../lib/ui";
import { ArtifactList, ArtifactViewer, Empty, ViewerBack } from "./artifacts";
import { ProjectChat } from "./chat/project-chat";
import { ProjectIssues } from "./project-issues";
import { ProjectFiles, ProjectKnowledge } from "./project-knowledge";
import { ProjectThreads } from "./project-threads";
import { Skeleton, UsageDashboard, useUsage } from "./usage-dashboard";
import { UsageFilters } from "./usage-filters";
import { useProjectView } from "./project-view";
import { PROJECT_TABPANEL } from "./shell/project-header";

/** What the selected project tab shows, left of an open thread. */
export function ProjectTabPanel({ me, className = "" }: { me: string; className?: string }) {
  const { view } = useProjectView();
  return (
    <main id={PROJECT_TABPANEL} role="tabpanel" className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      {view === "threads" ? (
        <ProjectThreads />
      ) : view === "issues" ? (
        <ProjectIssues />
      ) : view === "artifacts" ? (
        <ArtifactsTab />
      ) : view === "files" ? (
        <FilesTab />
      ) : view === "knowledge" ? (
        <KnowledgeTab />
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
      <div className="flex min-h-0 flex-1 flex-col bg-sunken">
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

/** The project's shared files, one previewed beside the list. */
function FilesTab() {
  const { project } = useProjectContext();
  const { search, go } = useProjectView();
  return <ProjectFiles projectId={project.id} file={search.item} onOpen={(file) => go("files", file ? { item: file } : {})} />;
}

/** The project's memory and instructions. */
function KnowledgeTab() {
  const { project } = useProjectContext();
  const { search, go } = useProjectView();
  return (
    <ProjectKnowledge
      projectId={project.id}
      section={search.section ?? "memory"}
      onSection={(section) => go("knowledge", section === "memory" ? {} : { section })}
    />
  );
}

/** This project's model usage: the same dashboard as the usage page, scoped to the project. */
function UsageTab() {
  const t = useT();
  const { project } = useProjectContext();
  const [filter, setFilter] = useState<UsageFilter>(DEFAULT_USAGE_FILTER);
  const scoped = { ...filter, project: project.id };
  const { data, error, isPending, isFetching } = useUsage(scoped);
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-5 px-3 py-5 sm:px-5">
        <UsageFilters filter={filter} onChange={(next) => setFilter((f) => ({ ...f, ...next }))} updating={isFetching && !isPending} />
        {error ? (
          <p className="text-sm text-bad">{errorMessage(error, t)}</p>
        ) : !data ? (
          <Skeleton />
        ) : (
          <UsageDashboard data={data} filter={scoped} inProject />
        )}
      </div>
    </div>
  );
}
