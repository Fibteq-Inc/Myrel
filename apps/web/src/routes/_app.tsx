import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { IconRail } from "../components/shell/icon-rail";
import { AppShell } from "../components/shell/shell";
import { api, canChooseServer, server, sessionQuery } from "../lib/api";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    if (canChooseServer && server === "") throw redirect({ to: "/login" });
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
    <AppShell rail={<IconRail user={user} onSignOut={signOut} />}>
      <Outlet />
    </AppShell>
  );
}
