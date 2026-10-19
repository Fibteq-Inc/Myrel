import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { BarChart3, Folder, LogOut, Plus } from "lucide-react";
import { api, canChooseServer, projectsQuery, server, sessionQuery } from "../lib/api";
import { AltairMark, IconButton, initials } from "../lib/ui";

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
  const { data: projects = [] } = useQuery(projectsQuery);

  async function signOut() {
    await api.signOut();
    queryClient.clear();
    await navigate({ to: "/login" });
  }

  return (
    <div className="flex h-full">
      <nav
        aria-label="Projects"
        className="hidden w-60 flex-none flex-col border-r border-line bg-panel md:flex"
      >
        <Link to="/" className="flex items-center gap-2.5 px-4 py-4 font-semibold">
          <AltairMark size={28} />
          Altair
        </Link>
        <div className="flex items-center px-4 pb-1.5 pt-2 text-xs text-subtle">
          Projects
          <Link to="/" aria-label="New project" className="ml-auto rounded p-1 hover:bg-hover hover:text-fg">
            <Plus size={14} />
          </Link>
        </div>
        <ul className="flex-1 space-y-0.5 overflow-y-auto px-2">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to="/projects/$projectId"
                params={{ projectId: p.id }}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-muted hover:bg-hover hover:text-fg"
                activeProps={{ className: "bg-hover text-fg" }}
              >
                <Folder size={15} className="flex-none" />
                <span className="truncate">{p.name}</span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="px-2 pb-2">
          <Link
            to="/usage"
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-muted hover:bg-hover hover:text-fg"
            activeProps={{ className: "bg-hover text-fg" }}
          >
            <BarChart3 size={15} className="flex-none" />
            Usage
          </Link>
        </div>
        <div className="flex items-center gap-2.5 border-t border-line px-3 py-3">
          <span
            aria-hidden="true"
            className="flex size-8 flex-none items-center justify-center rounded-full bg-gradient-to-br from-[#5b6cff] to-[#9b5bff] text-xs font-semibold text-white"
          >
            {initials(user.name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{user.name}</span>
            <span className="block truncate text-xs text-subtle">{user.email}</span>
          </span>
          <IconButton type="button" onClick={signOut} aria-label="Sign out" title="Sign out">
            <LogOut size={16} />
          </IconButton>
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}
