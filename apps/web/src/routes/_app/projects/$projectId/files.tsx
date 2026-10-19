import { useT } from "@altair/i18n/react";
import { createFileRoute } from "@tanstack/react-router";
import { FolderOpen } from "lucide-react";
import { type PanelTab, ProjectKnowledge } from "../../../../components/project-knowledge";
import { BackToChat, NavToggle, PaneHeader } from "../../../../components/shell/shell";
import { useProjectContext } from "../../../../lib/project-context";

type Search = { tab?: PanelTab; file?: string };

const TABS: PanelTab[] = ["files", "memory", "instructions"];

export const Route = createFileRoute("/_app/projects/$projectId/files")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ...(TABS.includes(search.tab as PanelTab) ? { tab: search.tab as PanelTab } : {}),
    ...(typeof search.file === "string" ? { file: search.file } : {}),
  }),
  component: FilesPage,
});

/** The project's files, memory and instructions. */
function FilesPage() {
  const t = useT();
  const { project } = useProjectContext();
  const { tab = "files", file } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PaneHeader>
        <NavToggle />
        <BackToChat projectId={project.id} />
        <FolderOpen size={17} className="flex-none text-muted" aria-hidden="true" />
        <h1 className="truncate text-[15px] font-semibold">{t("sidebar.files")}</h1>
        <span className="hidden truncate text-xs text-subtle sm:inline">{project.name}</span>
      </PaneHeader>
      <ProjectKnowledge
        projectId={project.id}
        tab={tab}
        file={file}
        onNavigate={(next) =>
          void navigate({ search: { ...(next.tab !== "files" ? { tab: next.tab } : {}), ...(next.file ? { file: next.file } : {}) } })
        }
      />
    </main>
  );
}
