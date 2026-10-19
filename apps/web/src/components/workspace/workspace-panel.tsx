import type { Thread } from "@altair/protocol";
import { FileText, GitCompareArrows, type LucideIcon, SquareTerminal } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cn } from "../../lib/ui";

export type WorkspaceTab = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** A small number beside the label, e.g. how many outputs. */
  count?: number;
  content: ReactNode;
};

/**
 * The thread's tabs as they stand today. The sandbox, runner and artifact
 * work replace each placeholder with the real view.
 */
export function defaultWorkspaceTabs(_thread: Thread): WorkspaceTab[] {
  return [
    {
      id: "changes",
      label: "Changes",
      icon: GitCompareArrows,
      content: (
        <EmptyTab icon={GitCompareArrows} title="No changes yet">
          When this thread edits code, the diff and its pull request show up here.
        </EmptyTab>
      ),
    },
    {
      id: "terminal",
      label: "Terminal",
      icon: SquareTerminal,
      content: (
        <EmptyTab icon={SquareTerminal} title="Nothing has run yet">
          Commands this thread runs in its sandbox or on your runner stream here, live.
        </EmptyTab>
      ),
    },
    {
      id: "outputs",
      label: "Outputs",
      icon: FileText,
      content: (
        <EmptyTab icon={FileText} title="No outputs yet">
          Files, artifacts and links this thread delivers collect here.
        </EmptyTab>
      ),
    },
  ];
}

/** The right half of a thread: tabs over what the agent changed, ran and produced. */
export function WorkspacePanel({
  tabs,
  initialTab,
  status,
  className = "",
}: {
  tabs: WorkspaceTab[];
  /** The tab shown first; remount (change `key`) to switch to it again. */
  initialTab?: string;
  /** Shown at the right of the tab bar, e.g. which runner does the work. */
  status?: ReactNode;
  className?: string;
}) {
  const [active, setActive] = useState(initialTab ?? tabs[0]?.id);
  const base = useId();
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <section aria-label="Workspace" className={cn("min-w-0 flex-col bg-[#0b0b0d]", className)}>
      <div className="flex h-[52px] flex-none items-center gap-1 overflow-x-auto border-b border-line px-3.5">
        <div role="tablist" aria-label="Workspace tabs" className="flex items-center gap-1">
          {tabs.map((tab) => {
            const selected = tab.id === current?.id;
            return (
              <button
                key={tab.id}
                id={`${base}-${tab.id}-tab`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${base}-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(tab.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  const i = tabs.indexOf(tab) + (e.key === "ArrowRight" ? 1 : -1);
                  const next = tabs[(i + tabs.length) % tabs.length]!;
                  setActive(next.id);
                  document.getElementById(`${base}-${next.id}-tab`)?.focus();
                }}
                className={cn(
                  "flex h-8 flex-none items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] transition-colors",
                  selected ? "bg-hover text-fg" : "text-muted hover:text-fg",
                )}
              >
                <tab.icon size={14} aria-hidden="true" />
                {tab.label}
                {tab.count ? <span className="text-[11px] text-subtle">{tab.count}</span> : null}
              </button>
            );
          })}
        </div>
        {status && <div className="ml-auto flex flex-none items-center gap-1.5 pl-3 text-xs text-subtle">{status}</div>}
      </div>
      {current && (
        <div
          id={`${base}-${current.id}`}
          role="tabpanel"
          aria-labelledby={`${base}-${current.id}-tab`}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {current.content}
        </div>
      )}
    </section>
  );
}

export function EmptyTab({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 p-8 text-center">
      <span className="mb-1 flex size-11 items-center justify-center rounded-xl border border-line bg-raised">
        <Icon size={20} className="text-subtle" aria-hidden="true" />
      </span>
      <p className="font-medium text-body">{title}</p>
      <p className="max-w-xs text-[13px] text-subtle">{children}</p>
    </div>
  );
}
