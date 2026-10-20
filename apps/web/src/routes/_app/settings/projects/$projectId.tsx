import { createFileRoute } from "@tanstack/react-router";
import { ProjectSettings } from "../../../../components/project-settings";
import { projectQuery, projectSettingsQuery } from "../../../../lib/api";

export const Route = createFileRoute("/_app/settings/projects/$projectId")({
  // `github` is the result of a GitHub connect round trip (see components/github-repos.tsx);
  // `connector` and `result` of a connector's OAuth sign-in (see components/connectors.tsx).
  validateSearch: (search: Record<string, unknown>): { github?: string; connector?: string; result?: string } => ({
    ...(typeof search.github === "string" && { github: search.github }),
    ...(typeof search.connector === "string" && { connector: search.connector }),
    ...(typeof search.result === "string" && { result: search.result }),
  }),
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(projectQuery(params.projectId)),
      context.queryClient.ensureQueryData(projectSettingsQuery(params.projectId)),
    ]),
  component: ProjectSettingsPage,
});

function ProjectSettingsPage() {
  const { projectId } = Route.useParams();
  const { github, connector, result } = Route.useSearch();
  return <ProjectSettings projectId={projectId} github={github} connectorId={connector} connectorResult={result} />;
}
