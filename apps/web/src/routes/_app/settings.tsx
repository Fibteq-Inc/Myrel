import { useT } from "@myrel/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { BookMarked, ChevronLeft, CreditCard, Folder, KeyRound, Mail, Plug, Server, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { meQuery, myInvitesQuery, projectsQuery, serverInfoQuery } from "../../lib/api";
import { cn } from "../../lib/ui";

export const Route = createFileRoute("/_app/settings")({
  loader: ({ context }) => context.queryClient.ensureQueryData(meQuery),
  component: SettingsLayout,
});

function SettingsLayout() {
  const t = useT();
  const { data: me } = useQuery(meQuery);
  const { data: projects = [] } = useQuery(projectsQuery);
  const { data: invites = [] } = useQuery(myInvitesQuery);
  const { data: info } = useQuery(serverInfoQuery);
  // The connector catalog is a grid of cards; it gets more room than the forms.
  const wide = useRouterState({ select: (s) => s.location.pathname.startsWith("/settings/connectors") });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
      <nav
        aria-label={t("settings.title")}
        className="min-w-0 flex-none border-b border-line px-3 py-3 md:w-56 md:overflow-y-auto md:border-b-0 md:border-r md:py-5"
      >
        <Link to="/" className="mb-3 flex items-center gap-1.5 px-2 text-[13px] text-subtle hover:text-fg">
          <ChevronLeft size={14} /> {t("settings.back")}
        </Link>
        <h1 className="mb-2 px-2 text-base font-semibold">{t("settings.title")}</h1>
        <ul className="flex gap-1 overflow-x-auto md:block md:space-y-0.5">
          <NavItem to="/settings" icon={<UserRound size={15} />} exact>
            {t("settings.account")}
          </NavItem>
          {info?.billing && (
            <NavItem to="/settings/billing" icon={<CreditCard size={15} />}>
              {t("settings.billing")}
            </NavItem>
          )}
          <NavItem to="/settings/keys" icon={<KeyRound size={15} />}>
            {t("settings.keys")}
          </NavItem>
          <NavItem to="/settings/connectors" icon={<Plug size={15} />}>
            {t("settings.connectors")}
          </NavItem>
          <NavItem to="/settings/skills" icon={<BookMarked size={15} />}>
            {t("settings.skills")}
          </NavItem>
          <NavItem to="/settings/invites" icon={<Mail size={15} />}>
            {t("settings.invites")}
            {invites.length > 0 && (
              <span className="ml-auto rounded-full bg-accent px-1.5 text-[11px] font-semibold text-ground">
                {invites.length}
              </span>
            )}
          </NavItem>
          {me?.role === "admin" && (
            <NavItem to="/settings/server" icon={<Server size={15} />}>
              {t("settings.server")}
            </NavItem>
          )}
        </ul>
        {projects.length > 0 && (
          <>
            <div className="mb-1 mt-5 hidden px-2 text-xs text-subtle md:block">{t("settings.projects")}</div>
            <ul className="hidden space-y-0.5 md:block">
              {projects.map((p) => (
                <li key={p.id}>
                  <Link
                    to="/settings/projects/$projectId"
                    params={{ projectId: p.id }}
                    className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-muted hover:bg-hover hover:text-fg"
                    activeProps={{ className: "bg-hover text-fg" }}
                  >
                    <Folder size={14} className="flex-none" />
                    <span className="truncate">{p.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto w-full space-y-10 px-4 py-6 sm:px-8 sm:py-8", wide ? "max-w-5xl" : "max-w-2xl")}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}

function NavItem({
  to,
  icon,
  exact,
  children,
}: {
  to: "/settings" | "/settings/billing" | "/settings/keys" | "/settings/connectors" | "/settings/skills" | "/settings/invites" | "/settings/server";
  icon: ReactNode;
  exact?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="flex-none">
      <Link
        to={to}
        activeOptions={{ exact }}
        className="flex items-center gap-2.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[13px] text-muted hover:bg-hover hover:text-fg"
        activeProps={{ className: "bg-hover text-fg" }}
      >
        {icon}
        {children}
      </Link>
    </li>
  );
}
