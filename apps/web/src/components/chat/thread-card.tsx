import { checkLabelStatus } from "@myrel/client";
import type { MessageKey } from "@myrel/i18n";
import { useT } from "@myrel/i18n/react";
import type { Thread } from "@myrel/protocol";
import { Link } from "@tanstack/react-router";
import { ChevronRight, ScanEye, SquareTerminal } from "lucide-react";
import { cn } from "../../lib/ui";
import { threadActivity, ThreadStatusIcon } from "./thread-status";

/**
 * The card under a project-chat message that opened a thread: title, reply
 * count, and a live line with what the thread is doing right now.
 */
export function ThreadCard({
  projectId,
  thread,
  replies,
  checks = [],
}: {
  projectId: string;
  thread: Thread;
  replies: number;
  /** Threads Myrel opened to check this one's work (visual checks), shown indented under it. */
  checks?: Thread[];
}) {
  const t = useT();
  const activity = threadActivity(thread, t);
  const live = thread.status === "working" && !thread.resolved;
  const card = (
    <Link
      to="/projects/$projectId/threads/$threadId"
      params={{ projectId, threadId: thread.id }}
      className="group flex flex-col overflow-hidden rounded-xl border border-card bg-raised text-fg transition-colors hover:border-edge"
      activeProps={{ className: "border-accent/60" }}
    >
      <span className="flex items-center gap-2.5 px-3.5 py-3">
        <ThreadStatusIcon thread={thread} />
        <span className="truncate font-semibold">{thread.title}</span>
        <span className="ml-auto flex-none text-xs text-subtle">
          {t("threadCard.replies", { count: replies })}
        </span>
        <ChevronRight
          size={15}
          className="flex-none text-subtle transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </span>
      <span
        className={cn(
          "flex items-center gap-2 border-t border-divider bg-panel px-3.5 py-2 text-xs",
          live ? "font-mono text-muted" : activity.tone,
        )}
      >
        {live && <SquareTerminal size={13} className="flex-none text-subtle" aria-hidden="true" />}
        <span className="truncate">{activity.label}</span>
        {live && activity.progress && <span className="ml-auto flex-none text-subtle">{activity.progress}</span>}
        {live && (
          <span
            aria-hidden="true"
            className={cn("size-1.5 flex-none animate-pulse rounded-full bg-accent", !activity.progress && "ml-auto")}
          />
        )}
      </span>
    </Link>
  );
  if (!checks.length) return card;
  return (
    <div className="flex flex-col">
      {card}
      <ChildThreads projectId={projectId} threads={checks} />
    </div>
  );
}

const CHECK_TONE: Record<string, string> = {
  running: "text-accent bg-accent-soft",
  passed: "text-ok bg-ok-soft",
  failed: "text-bad bg-bad-soft",
  partial: "text-warn bg-warn-soft",
  not_checked: "text-warn bg-warn-soft",
};

/** The visual check rounds of a thread, indented under its card and joined to it by a line. */
export function ChildThreads({ projectId, threads }: { projectId: string; threads: Thread[] }) {
  const t = useT();
  return (
    <div className="ml-5 mt-1.5 flex flex-col gap-1.5 border-l-2 border-line pl-3.5">
      {threads.map((c) => {
        const status = checkLabelStatus(c) ?? (c.resolved ? "not_checked" : "running");
        return (
          <Link
            key={c.id}
            to="/projects/$projectId/threads/$threadId"
            params={{ projectId, threadId: c.id }}
            className="flex items-center gap-2 rounded-lg border border-card bg-panel px-3 py-1.5 text-[13px] text-fg hover:border-edge"
            activeProps={{ className: "border-accent/60" }}
          >
            <ScanEye size={14} className="flex-none text-muted" aria-hidden="true" />
            <span className="truncate">{c.title}</span>
            <span className={cn("ml-auto flex-none rounded-full px-2 py-px text-[11.5px] font-medium", CHECK_TONE[status] ?? "text-muted")}>
              {t(`visualCheck.status.${status}` as MessageKey)}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
