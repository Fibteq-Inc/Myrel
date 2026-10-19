import type { SessionUser } from "@altair/client";
import { Link, useRouterState } from "@tanstack/react-router";
import { BarChart3, Blocks, FolderOpen, LogOut, MessagesSquare, MonitorSmartphone, Server, Settings, type LucideIcon } from "lucide-react";
import { canChooseServer, server } from "../../lib/api";
import { AltairMark, cn, UserAvatar } from "../../lib/ui";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../ui/menu";

type RailItem = {
  label: string;
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
  { label: "Projects", icon: MessagesSquare, to: "/", match: ["/", "/projects"] },
  { label: "Artifacts", icon: Blocks, to: "/artifacts", match: ["/artifacts"] },
  // Files belong to a project: the rail links to the open project's (below).
  { label: "Files", icon: FolderOpen },
  { label: "Devices", icon: MonitorSmartphone, to: "/devices", match: ["/devices"] },
  { label: "Usage", icon: BarChart3, to: "/usage", match: ["/usage"] },
];

const itemClass =
  "flex size-11 items-center justify-center rounded-[10px] text-subtle transition-colors hover:bg-hover hover:text-fg";

export function IconRail({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (item: RailItem) =>
    item.match?.some((p) => (p === "/" ? pathname === "/" : pathname.startsWith(p))) ?? false;
  const projectId = /^\/projects\/([^/]+)/.exec(pathname)?.[1];

  return (
    <nav
      aria-label="Main"
      className="flex h-full w-[60px] flex-none flex-col items-center gap-1.5 border-r border-line bg-rail py-3.5"
    >
      <Link to="/" aria-label="Altair home" className="mb-3.5">
        <AltairMark size={36} />
      </Link>

      {RAIL_ITEMS.map((item) =>
        item.label === "Files" && projectId ? (
          <Link
            key={item.label}
            to="/projects/$projectId/files"
            params={{ projectId }}
            aria-label="Project files"
            title="Project files"
            className={itemClass}
            activeProps={{ className: "bg-hover text-fg", "aria-current": "page" }}
          >
            <item.icon size={20} strokeWidth={1.8} />
          </Link>
        ) : item.to ? (
          <Link
            key={item.label}
            to={item.to}
            aria-label={item.label}
            title={item.label}
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
            aria-label={item.label === "Files" ? "Files (open a project first)" : `${item.label} (coming soon)`}
            title={item.label === "Files" ? "Open a project to see its files" : `${item.label} · coming soon`}
            className={cn(itemClass, "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-subtle")}
          >
            <item.icon size={20} strokeWidth={1.8} />
          </button>
        ),
      )}

      <div className="mt-auto flex flex-col items-center gap-2.5">
        <Link
          to="/settings"
          aria-label="Settings"
          title="Settings"
          aria-current={pathname.startsWith("/settings") ? "page" : undefined}
          className={cn(itemClass, pathname.startsWith("/settings") && "bg-hover text-fg")}
        >
          <Settings size={20} strokeWidth={1.8} />
        </Link>
        <Menu
          label="Account"
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
              <MenuItem
                icon={<LogOut size={15} />}
                onSelect={() => {
                  close();
                  onSignOut();
                }}
              >
                Sign out
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </nav>
  );
}
