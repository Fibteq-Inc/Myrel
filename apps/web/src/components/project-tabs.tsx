import { artifactList } from "@altair/client";
import { useT } from "@altair/i18n/react";
import { Blocks } from "lucide-react";
import { useProjectContext } from "../lib/project-context";
import { cn } from "../lib/ui";
import { ArtifactList, ArtifactViewer, Empty, ViewerBack } from "./artifacts";
import { ProjectChat } from "./chat/project-chat";
import { ProjectKnowledge } from "./project-knowledge";
import { ProjectThreads } from "./project-threads";
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
