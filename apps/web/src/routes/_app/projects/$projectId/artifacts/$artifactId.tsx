import { useT } from "@altair/i18n/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { ArtifactViewer } from "../../../../../components/artifacts";
import { NavToggle } from "../../../../../components/shell/shell";
import { useProjectContext } from "../../../../../lib/project-context";

type Search = { version?: number };

export const Route = createFileRoute("/_app/projects/$projectId/artifacts/$artifactId")({
  validateSearch: (s: Record<string, unknown>): Search => {
    const v = Number(s.version);
    return Number.isInteger(v) && v > 0 ? { version: v } : {};
  },
  component: ArtifactPage,
});

/** One artifact, full pane. Its address is stable; ?version= pins an older one. */
function ArtifactPage() {
  const t = useT();
  const { artifactId } = Route.useParams();
  const { version } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { project } = useProjectContext();
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-[#0b0b0d]">
      <ArtifactViewer
        key={artifactId}
        projectId={project.id}
        artifactId={artifactId}
        version={version}
        onVersionChange={(v) => navigate({ search: v ? { version: v } : {}, replace: true })}
        leading={
          <>
            <NavToggle />
            <Link
              to="/projects/$projectId/artifacts"
              params={{ projectId: project.id }}
              aria-label={t("artifacts.all")}
              title={t("artifacts.all")}
              className="-ml-1 flex size-9 flex-none items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
            >
              <ChevronLeft size={18} />
            </Link>
          </>
        }
      />
    </main>
  );
}
