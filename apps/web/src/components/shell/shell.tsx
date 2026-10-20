import { useT } from "@myrel/i18n/react";
import { useRouterState } from "@tanstack/react-router";
import { Menu as MenuIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { cn, IconButton } from "../../lib/ui";

type Shell = {
  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
};

const ShellContext = createContext<Shell>({ navOpen: false, setNavOpen: () => {} });

export const useShell = () => useContext(ShellContext);

/**
 * App frame: the icon rail, then whatever the route puts beside it (usually a
 * sidebar and a main pane). On phones the rail and sidebar slide in as a drawer.
 */
export function AppShell({ rail, banner, children }: { rail: ReactNode; banner?: ReactNode; children: ReactNode }) {
  const t = useT();
  const [navOpen, setNavOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Navigating closes the drawer.
  useEffect(() => setNavOpen(false), [pathname]);

  return (
    <ShellContext.Provider value={{ navOpen, setNavOpen }}>
      <div className="flex h-full flex-col overflow-hidden">
        {banner}
        <div className="flex min-h-0 flex-1 overflow-hidden">
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
      </div>
    </ShellContext.Provider>
  );
}

/** Opens the drawer on phones. */
export function NavToggle() {
  const { setNavOpen } = useShell();
  const t = useT();
  return (
    <IconButton type="button" aria-label={t("shell.openMenu")} onClick={() => setNavOpen(true)} className="-ml-1.5 md:hidden">
      <MenuIcon size={18} />
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
