import { createFileRoute, redirect } from "@tanstack/react-router";
import { viewSearch } from "../../../../../components/project-view";

// An artifact opens in the project's artifacts tab now; its old address still works.
export const Route = createFileRoute("/_app/projects/$projectId/artifacts/$artifactId")({
  beforeLoad: ({ params, search }) => {
    const v = Number((search as Record<string, unknown>).version);
    throw redirect({
      to: "/projects/$projectId",
      params: { projectId: params.projectId },
      search: viewSearch("artifacts", { item: params.artifactId, v: Number.isInteger(v) && v > 0 ? v : undefined }),
    });
  },
});
