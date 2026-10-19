import { createFileRoute } from "@tanstack/react-router";
import { ThreadPanel } from "../../../../../components/thread/thread-panel";

type Search = { artifact?: string; version?: number };

export const Route = createFileRoute("/_app/projects/$projectId/threads/$threadId")({
  // ?artifact= opens one of the thread's outputs in the workspace; ?version= pins an older one.
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.artifact === "string" && { artifact: s.artifact }),
    ...(Number.isInteger(Number(s.version)) && Number(s.version) > 0 && { version: Number(s.version) }),
  }),
  component: ThreadRoute,
});

/** An open thread: a panel beside the project chat, which the project layout draws. */
function ThreadRoute() {
  const { threadId } = Route.useParams();
  const { artifact, version } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { user } = Route.useRouteContext();
  return (
    <ThreadPanel
      key={threadId}
      threadId={threadId}
      me={user.id}
      artifact={artifact}
      version={version}
      onOpenArtifact={(id, v) => void navigate({ search: id ? { artifact: id, version: v } : {}, replace: true })}
    />
  );
}
