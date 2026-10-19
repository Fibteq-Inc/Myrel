import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ProjectSidebar } from "../../../components/shell/project-sidebar";
import { membersQuery, projectQuery } from "../../../lib/api";
import { ProjectProvider } from "../../../lib/project-context";

export const Route = createFileRoute("/_app/projects/$projectId")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(projectQuery(params.projectId)),
  component: ProjectLayout,
});

/** A project: its sidebar, then the project chat or an open thread. */
function ProjectLayout() {
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: members = [] } = useQuery(membersQuery(projectId));
  return (
    <ProjectProvider key={projectId} project={project} members={members}>
      <ProjectSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </ProjectProvider>
  );
}
