import { createFileRoute } from "@tanstack/react-router";
import { ProjectSettings, type ProjectSettingsTab } from "../../../../components/project-settings";
import { projectQuery, projectSettingsQuery } from "../../../../lib/api";

const TABS: ProjectSettingsTab[] = ["general", "model", "folders", "github", "connectors", "skills", "members"];

export const Route = createFileRoute("/_app/settings/projects/$projectId")({
  // `github` is the result of a GitHub connect round trip (see components/github-repos.tsx);
  // `connector` and `result` of a connector's OAuth sign-in (see components/connectors.tsx);
  // `tab` opens one tab, e.g. GitHub from the mobile app.
  validateSearch: (
    search: Record<string, unknown>,
  ): { github?: string; connector?: string; result?: string; tab?: ProjectSettingsTab } => ({
    ...(typeof search.github === "string" && { github: search.github }),
    ...(typeof search.connector === "string" && { connector: search.connector }),
    ...(typeof search.result === "string" && { result: search.result }),
    ...(typeof search.tab === "string" && TABS.includes(search.tab as ProjectSettingsTab) && { tab: search.tab as ProjectSettingsTab }),
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
  const { github, connector, result, tab } = Route.useSearch();
  return <ProjectSettings projectId={projectId} github={github} connectorId={connector} connectorResult={result} initialTab={tab} />;
}
