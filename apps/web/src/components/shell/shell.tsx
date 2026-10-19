import { useT } from "@altair/i18n/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronLeft, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { cn, IconButton } from "../../lib/ui";

type Shell = {
  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
  /** A collapsible sidebar is folded away on wide screens. */
  sidebarHidden: boolean;
  setSidebarHidden: (hidden: boolean) => void;
};

const ShellContext = createContext<Shell>({
  navOpen: false,
  setNavOpen: () => {},
  sidebarHidden: false,
  setSidebarHidden: () => {},
});

const SIDEBAR_KEY = "altair.sidebarHidden";

export const useShell = () => useContext(ShellContext);

/**
 * App frame: the icon rail, then whatever the route puts beside it (usually a
 * sidebar and a main pane). On phones the rail and sidebar slide in as a drawer.
 */
export function AppShell({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  const t = useT();
  const [navOpen, setNavOpen] = useState(false);
  const [sidebarHidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setSidebarHidden = useCallback((hidden: boolean) => {
    setHidden(hidden);
    try {
      localStorage.setItem(SIDEBAR_KEY, hidden ? "1" : "0");
    } catch {
      // Private mode: the choice lasts until reload.
    }
  }, []);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Navigating closes the drawer.
  useEffect(() => setNavOpen(false), [pathname]);

  return (
    <ShellContext.Provider value={{ navOpen, setNavOpen, sidebarHidden, setSidebarHidden }}>
      <div className="flex h-full overflow-hidden">
        <div
          className={cn(
            "fixed inset-y-0 left-0 z-40 flex transition-transform duration-200 md:static md:z-50 md:translate-x-0",
            navOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          {rail}
        </div>
        {navOpen && (
          <button
            type="button"
            aria-label={t("shell.closeMenu")}
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-30 bg-black/60 md:hidden"
          />
        )}
        <div className="flex min-w-0 flex-1">{children}</div>
      </div>
    </ShellContext.Provider>
  );
}

/**
 * A sidebar next to the rail. On phones it rides in the drawer, just right of
 * the rail. A `collapsible` one can be folded away on wide screens.
 */
export function Sidebar({ label, collapsible, children }: { label: string; collapsible?: boolean; children: ReactNode }) {
  const { navOpen, sidebarHidden } = useShell();
  return (
    <aside
      aria-label={label}
      className={cn(
        "fixed inset-y-0 left-[60px] z-40 flex w-[276px] flex-none flex-col border-r border-line bg-panel transition-transform duration-200 md:static md:translate-x-0",
        navOpen ? "translate-x-0" : "-translate-x-[calc(100%+60px)]",
        collapsible && sidebarHidden && "md:hidden",
      )}
    >
      {children}
    </aside>
  );
}

/** Opens the drawer on phones; on wider screens, unfolds a collapsed sidebar. */
export function NavToggle() {
  const { setNavOpen, sidebarHidden, setSidebarHidden } = useShell();
  const t = useT();
  return (
    <>
      <IconButton type="button" aria-label={t("shell.openMenu")} onClick={() => setNavOpen(true)} className="-ml-1.5 md:hidden">
        <MenuIcon size={18} />
      </IconButton>
      {sidebarHidden && (
        <IconButton
          type="button"
          aria-label={t("shell.showSidebar")}
          title={t("shell.showSidebar")}
          onClick={() => setSidebarHidden(false)}
          className="-ml-1.5 max-md:hidden"
        >
          <PanelLeftOpen size={18} />
        </IconButton>
      )}
    </>
  );
}

/** Folds a collapsible sidebar away on wide screens; NavToggle brings it back. */
export function SidebarCollapse() {
  const { setSidebarHidden } = useShell();
  const t = useT();
  return (
    <IconButton
      type="button"
      aria-label={t("shell.hideSidebar")}
      title={t("shell.hideSidebar")}
      onClick={() => setSidebarHidden(true)}
      className="size-9 flex-none max-md:hidden"
    >
      <PanelLeftClose size={17} />
    </IconButton>
  );
}

/** The 56px bar on top of a pane. */
export function PaneHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <header className={cn("flex h-14 flex-none items-center gap-2.5 border-b border-line px-4 sm:px-5", className)}>
      {children}
    </header>
  );
}

/** Back to the project chat, from a page that replaces it (files, artifacts). */
export function BackToChat({ projectId }: { projectId: string }) {
  const t = useT();
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId }}
      aria-label={t("shell.backToChat")}
      title={t("shell.backToChat")}
      className="-ml-1 flex size-9 flex-none items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
    >
      <ChevronLeft size={18} />
    </Link>
  );
}
