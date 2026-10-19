import { createFileRoute, redirect } from "@tanstack/react-router";
import { viewSearch } from "../../../../components/project-view";

// Files are a tab of the project now; older links land on it.
export const Route = createFileRoute("/_app/projects/$projectId/files")({
  beforeLoad: ({ params, search }) => {
    const s = search as Record<string, unknown>;
    const section = s.tab === "memory" || s.tab === "instructions" ? s.tab : undefined;
    throw redirect({
      to: "/projects/$projectId",
      params,
      search: viewSearch("files", { section, item: typeof s.file === "string" ? s.file : undefined }),
    });
  },
});
