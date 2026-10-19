import { createFileRoute } from "@tanstack/react-router";
import { ProjectSettings } from "../../../../components/project-settings";
import { projectQuery, projectSettingsQuery } from "../../../../lib/api";

export const Route = createFileRoute("/_app/settings/projects/$projectId")({
  // `github` is the result of a GitHub connect round trip (see components/github-repos.tsx).
  validateSearch: (search: Record<string, unknown>): { github?: string } =>
    typeof search.github === "string" ? { github: search.github } : {},
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(projectQuery(params.projectId)),
      context.queryClient.ensureQueryData(projectSettingsQuery(params.projectId)),
    ]),
  component: ProjectSettingsPage,
});

function ProjectSettingsPage() {
  const { projectId } = Route.useParams();
  const { github } = Route.useSearch();
  return <ProjectSettings projectId={projectId} github={github} />;
}
