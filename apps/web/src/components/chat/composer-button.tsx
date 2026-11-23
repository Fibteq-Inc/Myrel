import type { ReactNode } from "react";

/** What a small control in the composer's bar looks like: an icon and a figure beside the settings chip. */
export function ComposerButton({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted hover:bg-hover hover:text-fg [[aria-expanded=true]>&]:bg-hover [[aria-expanded=true]>&]:text-fg">
      {children}
    </span>
  );
}
