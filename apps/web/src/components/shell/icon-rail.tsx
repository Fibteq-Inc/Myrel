import type { SessionUser } from "@myrel/client";
import { LOCALE_NAMES, LOCALES, type MessageKey } from "@myrel/i18n";
import { useI18n } from "@myrel/i18n/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { BarChart3, BookOpen, Blocks, Check, FolderOpen, Languages, LogOut, MessagesSquare, MonitorSmartphone, Server, Settings, type LucideIcon } from "lucide-react";
import { canChooseServer, platform, server } from "../../lib/api";
import { MyrelMark, cn, UserAvatar } from "../../lib/ui";
import { NotificationBell } from "../notifications";
import { viewSearch } from "../project-view";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../ui/menu";

/** The user guide (apps/docs). */
const DOCS_URL = "https://docs.myrel.fibteq.io";

type RailItem = {
  label: MessageKey;
  icon: LucideIcon;
  /** Where it goes. No `to` = not built yet; shown dimmed. */
  to?: "/" | "/usage" | "/devices" | "/artifacts";
  /** Path prefixes that light it up. */
  match?: string[];
};

/**
 * The rail's sections, top to bottom. Add an entry (and its route) to give a
 * new area of the app a place in the rail.
 */
export const RAIL_ITEMS: RailItem[] = [
  { label: "rail.projects", icon: MessagesSquare, to: "/", match: ["/", "/projects"] },
  { label: "rail.artifacts", icon: Blocks, to: "/artifacts", match: ["/artifacts"] },
  // Files belong to a project: the rail links to the open project's (below).
  { label: "rail.files", icon: FolderOpen },
  { label: "rail.devices", icon: MonitorSmartphone, to: "/devices", match: ["/devices"] },
  { label: "rail.usage", icon: BarChart3, to: "/usage", match: ["/usage"] },
];

const itemClass =
  "flex size-11 items-center justify-center rounded-[10px] text-subtle transition-colors hover:bg-hover hover:text-fg";

export function IconRail({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const view = useRouterState({ select: (s) => (s.location.search as { view?: string }).view });
  const isActive = (item: RailItem) =>
    item.match?.some((p) => (p === "/" ? pathname === "/" : pathname.startsWith(p))) ?? false;
  const projectId = /^\/projects\/([^/]+)/.exec(pathname)?.[1];

  return (
    <nav
      aria-label={t("rail.main")}
      className="flex h-full w-[60px] flex-none flex-col items-center gap-1.5 border-r border-line bg-rail py-3.5"
    >
      <Link to="/" aria-label={t("rail.home")} className="mb-3.5">
        <MyrelMark size={36} />
      </Link>

      {RAIL_ITEMS.map((item) =>
        item.label === "rail.files" && projectId ? (
          <Link
            key={item.label}
            to="/projects/$projectId"
            params={{ projectId }}
            search={viewSearch("files")}
            aria-label={t("rail.projectFiles")}
            title={t("rail.projectFiles")}
            aria-current={view === "files" ? "page" : undefined}
            className={cn(itemClass, view === "files" && "bg-hover text-fg")}
          >
            <item.icon size={20} strokeWidth={1.8} />
          </Link>
        ) : item.to ? (
          <Link
            key={item.label}
            to={item.to}
            aria-label={t(item.label)}
            title={t(item.label)}
            aria-current={isActive(item) ? "page" : undefined}
            className={cn(itemClass, isActive(item) && "bg-hover text-fg")}
          >
            <item.icon size={20} strokeWidth={1.8} />
          </Link>
        ) : (
          <button
            key={item.label}
            type="button"
            disabled
            aria-label={item.label === "rail.files" ? t("rail.filesNoProject") : t("common.comingSoon", { label: t(item.label) })}
            title={item.label === "rail.files" ? t("rail.filesNoProjectTitle") : t("common.comingSoonTitle", { label: t(item.label) })}
            className={cn(itemClass, "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-subtle")}
          >
            <item.icon size={20} strokeWidth={1.8} />
          </button>
        ),
      )}

      <div className="mt-auto flex flex-col items-center gap-2.5">
        <NotificationBell />
        <Link
          to="/settings"
          aria-label={t("rail.settings")}
          title={t("rail.settings")}
          aria-current={pathname.startsWith("/settings") ? "page" : undefined}
          className={cn(itemClass, pathname.startsWith("/settings") && "bg-hover text-fg")}
        >
          <Settings size={20} strokeWidth={1.8} />
        </Link>
        <Menu
          label={t("rail.account")}
          side="right"
          className="rounded-full outline-offset-2"
          trigger={<UserAvatar id={user.id} name={user.name} size={32} />}
        >
          {(close) => (
            <>
              <div className="flex items-center gap-2.5 px-2.5 py-2">
                <UserAvatar id={user.id} name={user.name} size={32} />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-fg">{user.name}</span>
                  <span className="block truncate text-xs text-subtle">{user.email}</span>
                </span>
              </div>
              {canChooseServer && server && (
                <>
                  <MenuSeparator />
                  <MenuLabel>
                    <span className="flex items-center gap-2">
                      <Server size={13} aria-hidden="true" />
                      {new URL(server).host}
                    </span>
                  </MenuLabel>
                </>
              )}
              <MenuSeparator />
              <MenuLabel>
                <span className="flex items-center gap-2">
                  <Languages size={13} aria-hidden="true" />
                  {t("common.language")}
                </span>
              </MenuLabel>
              {LOCALES.map((l) => (
                <MenuItem key={l} onSelect={() => setLocale(l)}>
                  <span lang={l} className="min-w-0 flex-1">
                    {LOCALE_NAMES[l]}
                  </span>
                  {l === locale && <Check size={14} className="flex-none text-accent" aria-label={t("sidebar.current")} />}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem
                icon={<BookOpen size={15} />}
                onSelect={() => {
                  close();
                  if (platform.name === "web") window.open(DOCS_URL, "_blank", "noopener");
                  else void platform.openExternal(DOCS_URL);
                }}
              >
                {t("rail.docs")}
              </MenuItem>
              <MenuItem
                icon={<LogOut size={15} />}
                onSelect={() => {
                  close();
                  onSignOut();
                }}
              >
                {t("rail.signOut")}
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </nav>
  );
}
