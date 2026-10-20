import type { Translate } from "@myrel/i18n";
import type { Thread } from "@myrel/protocol";
import { FileText, GitCompareArrows, type LucideIcon, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";

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
export function defaultWorkspaceTabs(_thread: Thread, t: Translate): WorkspaceTab[] {
  return [
    {
      id: "changes",
      label: t("workspace.changes"),
      icon: GitCompareArrows,
      content: (
        <EmptyTab icon={GitCompareArrows} title={t("workspace.changesEmpty")}>
          {t("workspace.changesEmptyBody")}
        </EmptyTab>
      ),
    },
    {
      id: "terminal",
      label: t("workspace.terminal"),
      icon: SquareTerminal,
      content: (
        <EmptyTab icon={SquareTerminal} title={t("workspace.terminalEmpty")}>
          {t("workspace.terminalEmptyBody")}
        </EmptyTab>
      ),
    },
    {
      id: "outputs",
      label: t("workspace.outputs"),
      icon: FileText,
      content: (
        <EmptyTab icon={FileText} title={t("workspace.outputsEmpty")}>
          {t("workspace.outputsEmptyBody")}
        </EmptyTab>
      ),
    },
  ];
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
