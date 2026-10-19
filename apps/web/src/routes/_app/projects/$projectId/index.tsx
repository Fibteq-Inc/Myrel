import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/projects/$projectId/")({
  // Older links opened a thread with ?thread=.
  validateSearch: (search: Record<string, unknown>): { thread?: string } =>
    typeof search.thread === "string" ? { thread: search.thread } : {},
  beforeLoad: ({ params, search }) => {
    if (search.thread) {
      throw redirect({ to: "/projects/$projectId/threads/$threadId", params: { ...params, threadId: search.thread } });
    }
  },
  // The project layout draws the chat; no thread is open here.
  component: () => null,
});
