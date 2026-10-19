import { artifactList } from "@altair/client";
import { createFileRoute } from "@tanstack/react-router";
import { Blocks } from "lucide-react";
import { ArtifactList, Empty } from "../../../../../components/artifacts";
import { BackToChat, NavToggle, PaneHeader } from "../../../../../components/shell/shell";
import { useProjectContext } from "../../../../../lib/project-context";

export const Route = createFileRoute("/_app/projects/$projectId/artifacts/")({
  component: ProjectArtifacts,
});

/** The project's Library: every artifact its threads published, newest first. */
function ProjectArtifacts() {
  const { project, state } = useProjectContext();
  const items = artifactList(state).map((a) => ({ ...a, origin: a.threadId ? state.threads[a.threadId]?.title : undefined }));
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PaneHeader>
        <NavToggle />
        <BackToChat projectId={project.id} />
        <Blocks size={17} className="flex-none text-muted" aria-hidden="true" />
        <h1 className="truncate text-[15px] font-semibold">Artifacts</h1>
        <span className="hidden truncate text-xs text-subtle sm:inline">{project.name}</span>
        {items.length > 0 && <span className="ml-auto font-mono text-xs text-subtle">{items.length}</span>}
      </PaneHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-3 py-5 sm:px-5">
          <ArtifactList
            items={items}
            empty={
              <Empty
                icon={<Blocks size={20} className="text-subtle" aria-hidden="true" />}
                title="Nothing here yet"
                body="Pages, reports and prototypes Altair publishes in this project's threads collect here."
              />
            }
          />
        </div>
      </div>
    </main>
  );
}
