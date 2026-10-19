import { createFileRoute, redirect } from "@tanstack/react-router";
import { viewSearch } from "../../../../../components/project-view";

// Artifacts are a tab of the project now; older links land on it.
export const Route = createFileRoute("/_app/projects/$projectId/artifacts/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/projects/$projectId", params, search: viewSearch("artifacts") });
  },
});
