import type { SessionUser } from "@altair/client";
import { LOCALE_NAMES, LOCALES, type MessageKey } from "@altair/i18n";
import { useI18n } from "@altair/i18n/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Blocks, Check, FolderOpen, Languages, LogOut, MessagesSquare, MonitorSmartphone, Server, Settings, type LucideIcon } from "lucide-react";
import { canChooseServer, server } from "../../lib/api";
import { AltairMark, cn, UserAvatar } from "../../lib/ui";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../ui/menu";

type RailItem = {
  label: MessageKey;
  icon: LucideIcon;
  /** Where it goes. No `to` = not built yet; shown dimmed. */
  to?: "/";
  /** Path prefixes that light it up. */
  match?: string[];
};

/**
 * The rail's sections, top to bottom. Add an entry (and its route) to give a
 * new area of the app a place in the rail.
 */
export const RAIL_ITEMS: RailItem[] = [
  { label: "rail.projects", icon: MessagesSquare, to: "/", match: ["/", "/projects"] },
  { label: "rail.artifacts", icon: Blocks },
  { label: "rail.files", icon: FolderOpen },
  { label: "rail.devices", icon: MonitorSmartphone },
];

const itemClass =
  "flex size-11 items-center justify-center rounded-[10px] text-subtle transition-colors hover:bg-hover hover:text-fg";

export function IconRail({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (item: RailItem) =>
    item.match?.some((p) => (p === "/" ? pathname === "/" : pathname.startsWith(p))) ?? false;

  return (
    <nav
      aria-label={t("rail.main")}
      className="flex h-full w-[60px] flex-none flex-col items-center gap-1.5 border-r border-line bg-rail py-3.5"
    >
      <Link to="/" aria-label={t("rail.home")} className="mb-3.5">
        <AltairMark size={36} />
      </Link>

      {RAIL_ITEMS.map((item) =>
        item.to ? (
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
            aria-label={t("common.comingSoon", { label: t(item.label) })}
            title={t("common.comingSoonTitle", { label: t(item.label) })}
            className={cn(itemClass, "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-subtle")}
          >
            <item.icon size={20} strokeWidth={1.8} />
          </button>
        ),
      )}

      <div className="mt-auto flex flex-col items-center gap-2.5">
        <button
          type="button"
          disabled
          aria-label={t("common.comingSoon", { label: t("rail.settings") })}
          title={t("common.comingSoonTitle", { label: t("rail.settings") })}
          className={cn(itemClass, "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-subtle")}
        >
          <Settings size={20} strokeWidth={1.8} />
        </button>
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
