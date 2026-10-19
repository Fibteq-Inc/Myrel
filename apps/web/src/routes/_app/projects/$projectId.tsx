import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, retainSearchParams, useMatches } from "@tanstack/react-router";
import { ProjectSettingsDialogProvider } from "../../../components/project-settings-dialog";
import { ProjectTabPanel } from "../../../components/project-tabs";
import { PROJECT_SEARCH_KEYS, validateProjectSearch } from "../../../components/project-view";
import { ProjectHeader } from "../../../components/shell/project-header";
import { ThreadPanelProvider, useThreadPanel } from "../../../components/thread/panel-state";
import { membersQuery, projectQuery } from "../../../lib/api";
import { ProjectProvider } from "../../../lib/project-context";

export const Route = createFileRoute("/_app/projects/$projectId")({
  // The open tab lives in the URL and survives opening and closing threads.
  validateSearch: validateProjectSearch,
  search: { middlewares: [retainSearchParams([...PROJECT_SEARCH_KEYS])] },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(projectQuery(params.projectId)),
  component: ProjectLayout,
});

/** A project: its header with the tabs, then the selected tab with an open thread as a panel on its right. */
function ProjectLayout() {
  const { projectId } = Route.useParams();
  const { user } = Route.useRouteContext();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: members = [] } = useQuery(membersQuery(projectId));
  const threadOpen = useMatches({ select: (matches) => matches.some((m) => m.routeId === "/_app/projects/$projectId/threads/$threadId") });
  return (
    <ProjectProvider key={projectId} project={project} members={members}>
      <ProjectSettingsDialogProvider projectId={projectId}>
        <ThreadPanelProvider>
          <div className="flex min-w-0 flex-1 flex-col">
            <ProjectHeader />
            <div className="flex min-h-0 flex-1">
              <TabWithPanel me={user.id} threadOpen={threadOpen} />
            </div>
          </div>
        </ThreadPanelProvider>
      </ProjectSettingsDialogProvider>
    </ProjectProvider>
  );
}

function TabWithPanel({ me, threadOpen }: { me: string; threadOpen: boolean }) {
  const { maximized } = useThreadPanel();
  return (
    <>
      <ProjectTabPanel me={me} className={threadOpen && maximized ? "lg:hidden" : ""} />
      <Outlet />
    </>
  );
}
