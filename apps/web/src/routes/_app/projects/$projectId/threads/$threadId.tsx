import { createFileRoute } from "@tanstack/react-router";
import { ThreadPanel } from "../../../../../components/thread/thread-panel";

export const Route = createFileRoute("/_app/projects/$projectId/threads/$threadId")({
  component: ThreadRoute,
});

/** An open thread: a panel beside the project chat, which the project layout draws. */
function ThreadRoute() {
  const { threadId } = Route.useParams();
  const { user } = Route.useRouteContext();
  return <ThreadPanel key={threadId} threadId={threadId} me={user.id} />;
}
