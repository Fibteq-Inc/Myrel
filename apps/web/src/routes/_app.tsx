import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { api, sessionQuery } from "../lib/api";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (!session) throw redirect({ to: "/login" });
    return { user: session.user };
  },
  component: AppLayout,
});

function AppLayout() {
  const { user } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function signOut() {
    await api.signOut();
    queryClient.clear();
    await navigate({ to: "/login" });
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <Link to="/" className="font-semibold">
          Altair
        </Link>
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          <span>{user.email}</span>
          <button type="button" onClick={signOut} className="hover:underline">
            Sign out
          </button>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
