import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

/** How the thread panel sits beside the project chat. */
export type PanelLayout = {
  /** Width in px while docked beside the chat. */
  width: number;
  /** Fills the main area; the chat hides. */
  maximized: boolean;
  /** The open workspace tab (changes, terminal, outputs), or null. */
  tool: string | null;
};

export const PANEL_MIN = 380;
export const PANEL_DEFAULT = 520;
/** Wide enough to show the conversation and a workspace tab side by side. */
export const PANEL_SPLIT = 920;
/** The chat keeps at least this much room while the panel is docked. */
export const CHAT_MIN = 360;

const KEY = "altair.threadPanel";

function load(): PanelLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<PanelLayout> | null;
    return {
      width: typeof saved?.width === "number" ? Math.max(PANEL_MIN, saved.width) : PANEL_DEFAULT,
      maximized: saved?.maximized === true,
      tool: typeof saved?.tool === "string" ? saved.tool : null,
    };
  } catch {
    return { width: PANEL_DEFAULT, maximized: false, tool: null };
  }
}

type PanelState = PanelLayout & {
  update: (next: Partial<PanelLayout>) => void;
};

const PanelContext = createContext<PanelState | null>(null);

/** Remembers the thread panel's size, maximized state and open tool across threads and reloads. */
export function ThreadPanelProvider({ children }: { children: ReactNode }) {
  const [layout, setLayout] = useState(load);
  const update = useCallback((next: Partial<PanelLayout>) => {
    setLayout((prev) => {
      const merged = { ...prev, ...next };
      try {
        localStorage.setItem(KEY, JSON.stringify(merged));
      } catch {
        // Private mode: the layout lasts until reload.
      }
      return merged;
    });
  }, []);
  const value = useMemo(() => ({ ...layout, update }), [layout, update]);
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

export function useThreadPanel() {
  const value = useContext(PanelContext);
  if (!value) throw new Error("useThreadPanel must be used inside <ThreadPanelProvider>");
  return value;
}
