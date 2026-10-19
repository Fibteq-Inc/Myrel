import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useMatches } from "@tanstack/react-router";
import { ProjectChat } from "../../../components/chat/project-chat";
import { ProjectSettingsDialogProvider } from "../../../components/project-settings-dialog";
import { ProjectSidebar } from "../../../components/shell/project-sidebar";
import { ThreadPanelProvider, useThreadPanel } from "../../../components/thread/panel-state";
import { membersQuery, projectQuery } from "../../../lib/api";
import { ProjectProvider } from "../../../lib/project-context";

export const Route = createFileRoute("/_app/projects/$projectId")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(projectQuery(params.projectId)),
  component: ProjectLayout,
});

/** Child routes drawn beside the project chat; any other child (e.g. files) replaces it. */
const BESIDE_CHAT = new Set(["/_app/projects/$projectId/", "/_app/projects/$projectId/threads/$threadId"]);

/** A project: its sidebar, then the project chat with an open thread as a panel on its right. */
function ProjectLayout() {
  const { projectId } = Route.useParams();
  const { user } = Route.useRouteContext();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: members = [] } = useQuery(membersQuery(projectId));
  const childRoute = useMatches({ select: (matches) => matches.at(-1)?.routeId,
  });
  return (
    <ProjectProvider key={projectId} project={project} members={members}>
      <ProjectSettingsDialogProvider projectId={projectId}>
        <ThreadPanelProvider>
          <ProjectSidebar />
          <div className="flex min-w-0 flex-1">
            {childRoute && BESIDE_CHAT.has(childRoute) ? (
              <ChatWithPanel me={user.id} threadOpen={childRoute.endsWith("$threadId")} />
            ) : (
              <div className="flex min-w-0 flex-1 flex-col">
                <Outlet />
              </div>
            )}
          </div>
        </ThreadPanelProvider>
      </ProjectSettingsDialogProvider>
    </ProjectProvider>
  );
}

function ChatWithPanel({ me, threadOpen }: { me: string; threadOpen: boolean }) {
  const { maximized } = useThreadPanel();
  return (
    <>
      <ProjectChat me={me} className={threadOpen && maximized ? "lg:hidden" : ""} />
      <Outlet />
    </>
  );
}
